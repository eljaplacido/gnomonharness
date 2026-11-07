/**
 * `gnomon chaos` — runs the fixed task set against the fault-injecting
 * endpoint (chaos.ts) and scores, for every injected fault, whether the
 * operator was TOLD.
 *
 * The run is gnomon's scripted path exactly: `runTask` with `verbose` off, the
 * function `gnomon task --json` calls, its stderr captured instead of printed
 * and its exit status read off the bucket the way the command reads it. That
 * is where silence costs most -- a benchmark adapter, a CI job, a loop -- and
 * where nobody is watching a terminal.
 *
 * Scoring is DIFFERENTIAL. Every case is read against a clean run of the same
 * task: a channel announces a fault only if it differs from the clean run.
 * Without that, a task that always ends at the step wall would "announce"
 * every fault through its stop_reason. And a stderr line counts only if it is
 * new AND names the fault: "endpoint unreachable" for a 429 is a sentence with
 * a false premise, not an announcement (benchmarks/fault-disclosure's rule).
 *
 * Three things must hold before a number is read, or the run is void (exit 2):
 * the scoring's negative controls fire, the apparatus gives the same answers
 * serially and concurrently (report RS6: a serial-vs-concurrent diff before
 * reading any delta) and catches a lane that garbles, and every planned fault
 * actually fired -- a fault that never fired cannot be announced, and counting
 * it would overstate robustness (AgentChaos's span check).
 *
 * Nothing here is reachable from a session that does not run `gnomon chaos`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig, routeRole } from "./config.js";
import { runTask, taskExitCode, unstartedTaskRecord, type TaskRecord } from "./prompt_loop.js";
import { harnessBuild } from "./build.js";
import {
  BURST_LENGTH,
  CHAOS_FAULTS,
  CHAOS_SCHEMA,
  INTERMITTENT_P,
  ChaosEndpoint,
  caseSeed,
  chaosExpected,
  chaosFileValue,
  chaosTaskInput,
  chaosToken,
  mulberry32,
  type ChaosCaseLog,
  type ChaosChannel,
  type ChaosFault,
  type ChaosSchedule,
  type ChaosTaskId,
} from "./chaos.js";

/** The mode the suite measures gnomon in, stated on every scorecard. */
export const CHAOS_MODE = "gnomon task --json";

/** The suite's own surface. `<chaos-endpoint>` is replaced by the live URL. */
const CONFIG_TOML = `# gnomon chaos -- the fault-injection suite's own surface.
# Written by \`gnomon chaos\` into a scratch directory for one run and removed
# after it. It is never a benchmark surface, and no benchmark surface
# declares anything here. Its timeouts are the shipped defaults scaled down
# so a run takes seconds; every other value is the shipped default.

[defaults]
sandbox = "confined"
approval = "never"
max_context_tokens = 65536
max_tokens = 4096
compaction = "discard"

[resilience]
attempts = 3
backoff_ms = 20
request_timeout_ms = 1000
stream_idle_timeout_ms = 1000
stream_total_timeout_ms = 10000
transport_grace_ms = 2500

[turn]
max_steps = 8
legs = 1

[audit]
enabled = true

# steer_role = "system": the chaos endpoint listens on loopback, a local lane,
# whose undeclared steering channel is the user role (v0.4.6). It stands in
# for any endpoint, a remote one included, so it keeps the system channel and
# late_system_dropped keeps measuring what a template that drops it does.
[endpoints.chaos]
url = "<chaos-endpoint>"
kind = "openai"
stream = false
steer_role = "system"

[endpoints.chaos_stream]
url = "<chaos-endpoint>"
kind = "openai"
stream = true
steer_role = "system"
`;

const ROLES_TOML = `# gnomon chaos -- one role per transport.
[roles.chaos]
model = "chaos-model"
endpoint = "chaos"
temperature = 0
top_p = 1
tools = ["read", "write"]
description = "answers the chaos task set over one JSON body per reply"

[roles.chaos_stream]
model = "chaos-model"
endpoint = "chaos_stream"
temperature = 0
top_p = 1
tools = ["read", "write"]
description = "answers the chaos task set over a streamed reply"
`;

const TOOLS_TOML = `# gnomon chaos -- the tools the task set needs, declared (Rule 3).
[[tools]]
name = "read"
description = "Read a file as numbered lines, or list a directory. Text only."
enabled = true

[[tools]]
name = "write"
description = "Write a file, creating it or replacing its contents."
enabled = true

# Not offered to either role: the declared check runs through it.
[[tools]]
name = "bash"
description = "Execute a POSIX sh command."
enabled = true
timeout_seconds = 30
`;

const POLICY_TOML = `# gnomon chaos -- the declared check the \`fix\` task is held to.
[verify]
command = "node chaos/check.mjs"
after = "write"
max_rounds = 2
`;

const CHECK_MJS = `// gnomon chaos: the declared check for the fix task.
import { readFileSync } from "node:fs";
const read = (f) => { try { return readFileSync(f, "utf-8").trim(); } catch { return null; } };
const want = read("chaos/expected.txt");
const got = read("chaos/out.txt");
if (got !== null && got === want) {
  console.log("chaos check: chaos/out.txt holds the expected value");
  process.exit(0);
}
console.log("chaos check: chaos/out.txt holds " + JSON.stringify(got) + ", which is not the value the task asked for");
process.exit(1);
`;

/** The suite's surface and fixture files, relative to a project root. */
export function chaosSurfaceFiles(url: string): Record<string, string> {
  return {
    ".gnomon/config.toml": CONFIG_TOML.replaceAll("<chaos-endpoint>", url),
    ".gnomon/roles.toml": ROLES_TOML,
    ".gnomon/tools.toml": TOOLS_TOML,
    ".gnomon/policy.toml": POLICY_TOML,
    "chaos/check.mjs": CHECK_MJS,
  };
}

/**
 * The surface's identity with the endpoint's port left out. The live surface
 * hash moves with the port the endpoint got, so it is volatile; this does not.
 */
export const CHAOS_SURFACE_TEMPLATE_HASH = createHash("sha256")
  .update(JSON.stringify(chaosSurfaceFiles("<chaos-endpoint>")))
  .digest("hex");

function writeProject(root: string, url: string): void {
  for (const [rel, content] of Object.entries(chaosSurfaceFiles(url))) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
}

// ── The plan ─────────────────────────────────────────────────────────────────

export interface ChaosCase {
  id: string;
  fault: ChaosFault;
  schedule: ChaosSchedule;
  task: ChaosTaskId;
  stream: boolean;
}

/**
 * The cases a run injects: every declared fault under each of its declared
 * schedules, narrowed by `--faults` (an id, or a type selecting every target:
 * `empty` is `empty.content` and `empty.tool_calls`) and `--schedules`.
 */
export function chaosPlan(filter: { faults?: string[]; schedules?: ChaosSchedule[] } = {}): ChaosCase[] {
  const wanted = (f: ChaosFault) =>
    !filter.faults?.length || filter.faults.some((w) => w === f.id || w === f.id.split(".")[0]);
  const cases: ChaosCase[] = [];
  for (const f of CHAOS_FAULTS) {
    if (!wanted(f)) continue;
    for (const s of f.schedules) {
      if (filter.schedules?.length && !filter.schedules.includes(s)) continue;
      cases.push({ id: `${f.id}/${s}`, fault: f, schedule: s, task: f.task, stream: f.stream });
    }
  }
  return cases;
}

/** Faults named in a filter that select nothing. */
export function unknownChaosFaults(names: string[]): string[] {
  return names.filter((w) => !CHAOS_FAULTS.some((f) => w === f.id || w === f.id.split(".")[0]));
}

export function chaosPlanHash(seed: number, cases: ChaosCase[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: CHAOS_SCHEMA,
        seed,
        intermittent_p: INTERMITTENT_P,
        burst_length: BURST_LENGTH,
        surface: CHAOS_SURFACE_TEMPLATE_HASH,
        // The fault's declaration too, so a change to what a case injects or
        // what counts as naming it moves the hash with it.
        cases: cases.map((c) => [c.id, c.task, c.stream, c.fault.target, c.fault.injects, c.fault.names.source]),
      })
    )
    .digest("hex");
}

// ── One run, as `gnomon task --json` would have shown it ─────────────────────

/** Everything an operator of `gnomon task --json` could have seen, plus the endpoint's span. */
export interface ChaosObservation {
  exit: number;
  bucket: string;
  stop_reason: string;
  degradations: string[];
  /** stderr, line by line */
  trace: string[];
  output: string;
  /** The task's own check passed: the answer carries its token (and, for fix, the file holds it) */
  recovered: boolean;
  /** Tokens the record counted (volatile.tokens_in + tokens_out) */
  counted: number;
  /** The surface the run was stamped with */
  surface_hash: string;
  duration_ms: number;
  endpoint: ChaosCaseLog;
}

interface RunSpec {
  id: string;
  fault: ChaosFault | null;
  schedule: ChaosSchedule;
  task: ChaosTaskId;
  stream: boolean;
  seed: number;
  latencyMs?: number;
  garbleWhenConcurrent?: boolean;
}

function resetFixtures(root: string, token: string): void {
  mkdirSync(join(root, "chaos"), { recursive: true });
  writeFileSync(join(root, "chaos/input.txt"), `${chaosFileValue(token)}\n`);
  writeFileSync(join(root, "chaos/expected.txt"), `${token}\n`);
  rmSync(join(root, "chaos/out.txt"), { force: true });
}

async function observe(ep: ChaosEndpoint, root: string, spec: RunSpec, token: string, setCase = true): Promise<ChaosObservation> {
  if (setCase) {
    ep.setCase({
      id: spec.id,
      fault: spec.fault,
      schedule: spec.schedule,
      seed: spec.seed,
      latencyMs: spec.latencyMs,
      garbleWhenConcurrent: spec.garbleWhenConcurrent,
    });
  }
  resetFixtures(root, token);
  const input = chaosTaskInput(spec.task, token);
  const role = spec.stream ? "chaos_stream" : "chaos";
  let err = "";
  const sink = {
    write(text: string) {
      err += text;
      return true;
    },
  };
  const t0 = Date.now();
  let record: TaskRecord;
  try {
    record = await runTask(loadConfig(root), input, { role, yes: true, verbose: false, stderr: sink });
  } catch (e) {
    // What `gnomon task` does with a throw out of the run: an unstarted
    // record, apparatus_failure, exit 10 (index.ts cmdTask).
    const why = e instanceof Error ? e.message : String(e);
    record = unstartedTaskRecord(input, role, `gnomon task could not start: ${why}`);
  }
  // cmdTask prints non-fatal surface problems to stderr in both modes.
  for (const p of record.surface_problems ?? []) if (!p.fatal) err += `  ⚠ ${p.where}: ${p.problem}\n`;
  const duration_ms = Date.now() - t0;
  const endpoint = setCase ? await ep.takeLog() : emptyLog(spec.id);
  const exit = taskExitCode(record);
  const outFile = (() => {
    try {
      return readFileSync(join(root, "chaos/out.txt"), "utf-8").trim();
    } catch {
      return null;
    }
  })();
  const output = typeof record.output === "string" ? record.output : JSON.stringify(record.output);
  // The task got done: its own check, not the exit status. A run that finished
  // the work and exited 2 because one call along the way was refused did
  // recover; the exit is scored as an announcement, separately.
  const recovered = output.includes(chaosExpected(spec.task, token)) && (spec.task !== "fix" || outFile === token);
  return {
    exit,
    bucket: record.bucket,
    stop_reason: String(record.stop_reason),
    degradations: (record.degradations ?? []).map((d) => String(d.id)),
    trace: err.split(/\r?\n/).filter((l) => l.trim() !== ""),
    output,
    recovered,
    counted: (record.volatile?.tokens_in ?? 0) + (record.volatile?.tokens_out ?? 0),
    surface_hash: record.surface_hash,
    duration_ms,
    endpoint,
  };
}

function emptyLog(id: string): ChaosCaseLog {
  return { id, requests: [], fired: 0, leaked: 0, tokens: { prompt: 0, completion: 0, zombie: 0, billed: 0 } };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export interface ChaosVerdict {
  /** The endpoint's own span says the fault was injected */
  fired: boolean;
  announced: boolean;
  /** An announcement that says WHICH fault: a naming trace line, or a degradation id for it */
  named: boolean;
  channels: ChaosChannel[];
  recovered: boolean;
  /** fired and announced on no channel */
  silent: boolean;
  /** stderr lines the clean run did not print */
  new_trace: string[];
  new_degradations: string[];
}

/** Score one faulted run against the clean run of the same task. Pure. */
export function scoreChaosCase(fault: ChaosFault, base: ChaosObservation, obs: ChaosObservation): ChaosVerdict {
  const channels: ChaosChannel[] = [];
  if (obs.exit !== base.exit) channels.push("exit");
  if (obs.stop_reason !== base.stop_reason) channels.push("stop_reason");
  const new_degradations = [...new Set(obs.degradations.filter((d) => !base.degradations.includes(d)))];
  if (new_degradations.length > 0) channels.push("degradation");
  const seen = new Set(base.trace);
  const new_trace = obs.trace.filter((l) => !seen.has(l));
  const naming = new_trace.filter((l) => fault.names.test(l));
  if (naming.length > 0) channels.push("trace");
  const fired = obs.endpoint.fired > 0;
  return {
    fired,
    announced: channels.length > 0,
    named: naming.length > 0 || new_degradations.some((d) => fault.degradations?.includes(d) === true),
    channels,
    recovered: obs.recovered,
    silent: fired && channels.length === 0,
    new_trace,
    new_degradations,
  };
}

/**
 * The scoring's negative controls, run on a real clean observation before
 * anything is measured. A detector that has never been shown a non-announcement
 * cannot be trusted to notice one, and one that cannot fire at all scores
 * everything silent.
 */
export function chaosControls(base: ChaosObservation): { name: string; expected: boolean; scored: boolean; ok: boolean }[] {
  const fired = { ...base.endpoint, fired: 1 };
  const err = CHAOS_FAULTS.find((f) => f.id === "error")!;
  const rate = CHAOS_FAULTS.find((f) => f.id === "rate_limit")!;
  const rows = [
    {
      name: "a run identical to the clean run scores silent",
      expected: false,
      scored: scoreChaosCase(err, base, { ...base, endpoint: fired }).announced,
    },
    {
      name: "a trace line naming the wrong fault scores silent",
      expected: false,
      scored: scoreChaosCase(rate, base, {
        ...base,
        endpoint: fired,
        trace: [...base.trace, "  [retry] endpoint unreachable — attempt 1 of 3, waiting 20ms"],
      }).announced,
    },
    {
      name: "a changed exit status scores announced",
      expected: true,
      scored: scoreChaosCase(err, base, { ...base, endpoint: fired, exit: base.exit === 10 ? 0 : 10 }).announced,
    },
  ];
  return rows.map((r) => ({ ...r, ok: r.scored === r.expected }));
}

// ── The scorecard ────────────────────────────────────────────────────────────

export interface ChaosCaseRow {
  id: string;
  fault: string;
  schedule: ChaosSchedule;
  task: ChaosTaskId;
  stream: boolean;
  fired: boolean;
  /** Requests the fault fired on, of all the case sent */
  injected: number;
  requests: number;
  announced: boolean;
  named: boolean;
  channels: ChaosChannel[];
  recovered: boolean;
  silent: boolean;
  exit: number;
  stop_reason: string;
  degradations: string[];
  /** How many stderr lines the clean run did not print; the lines are in `volatile.trace` */
  new_lines: number;
  tokens: { billed: number; baseline: number; wasted: number; counted: number; zombie: number };
  /** Requests left open after the harness abandoned them (report RS4: must be 0) */
  leaked: number;
}

export interface ChaosFaultRow {
  id: string;
  family: string;
  injects: string;
  origin: string;
  cases: number;
  fired: number;
  announced: number;
  named: number;
  recovered: number;
  silent: number;
  verdict: "announced" | "silent" | "not_fired";
  tokens_wasted: number;
}

export interface ChaosScorecard {
  schema: string;
  harness: string;
  mode: string;
  seed: number;
  plan_hash: string;
  surface_template_hash: string;
  controls: ReturnType<typeof chaosControls>;
  apparatus: {
    ok: boolean;
    problems: string[];
    lane_check: { tasks: string[]; serial_equals_concurrent: boolean; garbling_caught: boolean };
    baselines: Array<{ task: ChaosTaskId; stream: boolean; recovered: boolean; exit: number; stop_reason: string; requests: number; billed: number }>;
  };
  faults: ChaosFaultRow[];
  cases: ChaosCaseRow[];
  summary: {
    faults: number;
    faults_announced: number;
    faults_silent: string[];
    cases: number;
    cases_fired: number;
    cases_announced: number;
    cases_named: number;
    cases_recovered: number;
    /** fired cases that did not recover */
    failed: number;
    /** of those, how many no channel announced (AgentChaos's silent-failure share) */
    silent_failures: number;
    silent_failure_share: number;
    tokens_wasted: number;
  };
  /** 0 every fired fault announced; 1 one or more silent; 2 the run is void */
  exit: 0 | 1 | 2;
  /**
   * What may differ between two runs with the same seed. Everything outside
   * this object is reproducible: same build, same seed, same card.
   */
  volatile: {
    duration_ms: number;
    surface_hash: string;
    endpoint: string;
    case_ms: Record<string, number>;
    /** Per case, the stderr lines the clean run did not print: the announcements, verbatim */
    trace: Record<string, string[]>;
  };
}

export interface ChaosOptions {
  seed?: number;
  faults?: string[];
  schedules?: ChaosSchedule[];
  /** Keep the scratch project (its audit trail has every case) and say where */
  keep?: boolean;
  /** Told each case as it finishes, for a live table */
  onCase?: (row: ChaosCaseRow) => void;
  /** Told about each phase */
  onPhase?: (line: string) => void;
}

/** Run the suite. Never throws for a fault; an apparatus problem is exit 2 on the card. */
export async function runChaosSuite(opts: ChaosOptions = {}): Promise<ChaosScorecard & { workdir?: string }> {
  const seed = Number.isFinite(opts.seed) ? Math.floor(opts.seed!) : 1;
  const cases = chaosPlan({ faults: opts.faults, schedules: opts.schedules });
  const started = Date.now();
  const problems: string[] = [];
  const work = mkdtempSync(join(tmpdir(), "gnomon-chaos-"));
  const ep = await ChaosEndpoint.start();
  const lanes = [join(work, "project"), join(work, "lane-a"), join(work, "lane-b")];
  for (const l of lanes) {
    mkdirSync(l, { recursive: true });
    writeProject(l, ep.url);
  }
  const root = lanes[0]!;
  const caseMs: Record<string, number> = {};
  const traces: Record<string, string[]> = {};
  const tokenFor = (id: string) => chaosToken(mulberry32(caseSeed(seed, `token:${id}`)));

  const card: ChaosScorecard = {
    schema: CHAOS_SCHEMA,
    harness: harnessBuild(),
    mode: CHAOS_MODE,
    seed,
    plan_hash: chaosPlanHash(seed, cases),
    surface_template_hash: CHAOS_SURFACE_TEMPLATE_HASH,
    controls: [],
    apparatus: { ok: true, problems, lane_check: { tasks: [], serial_equals_concurrent: false, garbling_caught: false }, baselines: [] },
    faults: [],
    cases: [],
    summary: {
      faults: 0, faults_announced: 0, faults_silent: [], cases: cases.length, cases_fired: 0, cases_announced: 0,
      cases_named: 0, cases_recovered: 0, failed: 0, silent_failures: 0, silent_failure_share: 0, tokens_wasted: 0,
    },
    exit: 2,
    volatile: { duration_ms: 0, surface_hash: "", endpoint: ep.url, case_ms: caseMs, trace: traces },
  };

  try {
    // A machine-scoped override would send every case somewhere else and score
    // that server instead. Refused, not worked around.
    const routed = routeRole(loadConfig(root), "chaos").target.url;
    if (routed !== ep.url) {
      problems.push(`every role is routed to ${routed}, not the chaos endpoint — GNOMON_MODEL_URL is set; unset it to run the suite`);
      return card;
    }
    if (cases.length === 0) {
      problems.push("the plan selects no case");
      return card;
    }

    // ── Clean runs, one per task and transport the plan uses ──
    opts.onPhase?.("clean runs");
    const baselines = new Map<string, ChaosObservation>();
    const keyOf = (task: ChaosTaskId, stream: boolean) => `${task}:${stream ? "stream" : "json"}`;
    const needed = new Map<string, { task: ChaosTaskId; stream: boolean }>();
    needed.set(keyOf("answer", false), { task: "answer", stream: false });
    for (const c of cases) needed.set(keyOf(c.task, c.stream), { task: c.task, stream: c.stream });
    for (const [key, { task, stream }] of needed) {
      const obs = await observe(ep, root, { id: `clean/${key}`, fault: null, schedule: "single", task, stream, seed: caseSeed(seed, key) }, tokenFor(key));
      baselines.set(key, obs);
      card.volatile.surface_hash ||= obs.surface_hash;
      card.apparatus.baselines.push({
        task, stream, recovered: obs.recovered, exit: obs.exit, stop_reason: obs.stop_reason,
        requests: obs.endpoint.requests.length, billed: obs.endpoint.tokens.billed,
      });
      if (!obs.recovered) {
        problems.push(`the clean ${key} run did not finish its task (exit ${obs.exit}, ${obs.stop_reason}): ${obs.output.slice(0, 160)}`);
      }
    }

    // ── The scoring's negative controls ──
    card.controls = chaosControls(baselines.get(keyOf("answer", false))!);
    for (const c of card.controls) if (!c.ok) problems.push(`negative control did not hold: ${c.name}`);

    // ── RS6: serial against concurrent, and a lane that garbles must be caught ──
    opts.onPhase?.("lane check");
    const laneTasks: ChaosTaskId[] = ["answer", "read"];
    card.apparatus.lane_check.tasks = laneTasks;
    let same = true;
    let caught = false;
    for (const task of laneTasks) {
      const key = keyOf(task, false);
      const token = tokenFor(`lane:${task}`);
      const spec: RunSpec = { id: `lane/${task}`, fault: null, schedule: "single", task, stream: false, seed: caseSeed(seed, `lane:${task}`) };
      const serial = await observe(ep, lanes[1]!, { ...spec, latencyMs: 120 }, token);
      const together = async (garble: boolean) => {
        ep.setCase({ id: `lane/${task}${garble ? "/garbled" : ""}`, fault: null, schedule: "single", seed: spec.seed, latencyMs: 120, garbleWhenConcurrent: garble });
        const pair = await Promise.all([
          observe(ep, lanes[1]!, spec, token, false),
          observe(ep, lanes[2]!, spec, token, false),
        ]);
        await ep.takeLog();
        return pair;
      };
      const clean = await together(false);
      if (!clean.every((o) => o.output === serial.output && o.exit === serial.exit)) {
        same = false;
        problems.push(`the ${key} task answered differently run concurrently than serially`);
      }
      const garbled = await together(true);
      if (garbled.some((o) => o.output !== serial.output)) caught = true;
    }
    card.apparatus.lane_check.serial_equals_concurrent = same;
    card.apparatus.lane_check.garbling_caught = caught;
    if (!caught) problems.push("the lane check did not catch a lane that garbles concurrent replies");

    // ── The cases ──
    opts.onPhase?.(`${cases.length} cases`);
    for (const c of cases) {
      const base = baselines.get(keyOf(c.task, c.stream))!;
      const obs = await observe(ep, root, { id: c.id, fault: c.fault, schedule: c.schedule, task: c.task, stream: c.stream, seed: caseSeed(seed, c.id) }, tokenFor(keyOf(c.task, c.stream)));
      caseMs[c.id] = obs.duration_ms;
      const v = scoreChaosCase(c.fault, base, obs);
      // The lines themselves carry timings and the endpoint's port, so they
      // are evidence, not part of the reproducible card.
      traces[c.id] = v.new_trace.map((l) => l.trimEnd()).slice(0, 12);
      const row: ChaosCaseRow = {
        id: c.id,
        fault: c.fault.id,
        schedule: c.schedule,
        task: c.task,
        stream: c.stream,
        fired: v.fired,
        injected: obs.endpoint.fired,
        requests: obs.endpoint.requests.length,
        announced: v.announced,
        named: v.named,
        channels: v.channels,
        recovered: v.recovered,
        silent: v.silent,
        exit: obs.exit,
        stop_reason: obs.stop_reason,
        degradations: v.new_degradations,
        new_lines: v.new_trace.length,
        tokens: {
          billed: obs.endpoint.tokens.billed,
          baseline: base.endpoint.tokens.billed,
          // Everything billed is wasted when the task did not finish; when it
          // did, whatever it cost beyond the clean run.
          wasted: v.recovered
            ? Math.max(0, obs.endpoint.tokens.billed - base.endpoint.tokens.billed)
            : obs.endpoint.tokens.billed,
          counted: obs.counted,
          zombie: obs.endpoint.tokens.zombie,
        },
        leaked: obs.endpoint.leaked,
      };
      if (!row.fired) problems.push(`${c.id} never fired: the endpoint injected nothing, so the case measures nothing`);
      card.cases.push(row);
      opts.onCase?.(row);
    }

    // ── Per fault ──
    const byFault = new Map<string, ChaosCaseRow[]>();
    for (const r of card.cases) byFault.set(r.fault, [...(byFault.get(r.fault) ?? []), r]);
    for (const [id, rows] of byFault) {
      const f = CHAOS_FAULTS.find((x) => x.id === id)!;
      const fired = rows.filter((r) => r.fired);
      const silent = fired.filter((r) => r.silent).length;
      card.faults.push({
        id,
        family: f.family,
        injects: f.injects,
        origin: f.origin,
        cases: rows.length,
        fired: fired.length,
        announced: fired.filter((r) => r.announced).length,
        named: fired.filter((r) => r.named).length,
        recovered: fired.filter((r) => r.recovered).length,
        silent,
        verdict: fired.length === 0 ? "not_fired" : silent > 0 ? "silent" : "announced",
        tokens_wasted: rows.reduce((a, r) => a + r.tokens.wasted, 0),
      });
    }
    const fired = card.cases.filter((r) => r.fired);
    const failed = fired.filter((r) => !r.recovered);
    card.summary = {
      faults: card.faults.length,
      faults_announced: card.faults.filter((f) => f.verdict === "announced").length,
      faults_silent: card.faults.filter((f) => f.verdict === "silent").map((f) => f.id),
      cases: card.cases.length,
      cases_fired: fired.length,
      cases_announced: fired.filter((r) => r.announced).length,
      cases_named: fired.filter((r) => r.named).length,
      cases_recovered: fired.filter((r) => r.recovered).length,
      failed: failed.length,
      silent_failures: failed.filter((r) => r.silent).length,
      silent_failure_share: failed.length ? round(failed.filter((r) => r.silent).length / failed.length) : 0,
      tokens_wasted: card.cases.reduce((a, r) => a + r.tokens.wasted, 0),
    };
    return card;
  } finally {
    card.apparatus.ok = problems.length === 0;
    card.exit = problems.length > 0 ? 2 : card.summary.faults_silent.length > 0 ? 1 : 0;
    card.volatile.duration_ms = Date.now() - started;
    await ep.close();
    if (opts.keep) (card as ChaosScorecard & { workdir?: string }).workdir = work;
    else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;

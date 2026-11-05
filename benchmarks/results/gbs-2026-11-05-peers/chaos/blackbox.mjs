#!/usr/bin/env node
/**
 * GBS-CHAOS 0.2 (draft): the black-box procedure of CHAOS.md §6, run on gnomon v0.4.2 AND opencode
 * v2.2.5. Derived from benchmarks/results/gbs-2026-11-04/chaos/blackbox.mjs (arm B of the 0.1 run);
 * the endpoint, the plan, the §4 scorer and the gnomon adapter are unchanged. Added for 0.2:
 *   --adapter gnomon|opencode  (the opencode adapter is new; see ADAPTERS.opencode)
 *   unsupported (transport): a case whose declared transport the adapter cannot request, and that
 *     the endpoint log confirms never fired, is reported unsupported, never silent (CHAOS-11)
 *   §5.2 per-harness lane check through serve; the endpoint-build lane check is cited, not re-run here
 *   a 300 s cap per harness run (the process is killed; exit becomes "killed")
 *
 * This is the runner a peer harness would be put through. The endpoint is
 * `gnomon chaos serve` (any harness can point at it); the plan and each
 * fault's naming pattern come from `gnomon chaos list --json` (the published
 * contract, §9); the scoring is CHAOS.md §4, re-implemented here from the spec
 * text, not imported from gnomon. Only ADAPTER below is harness-specific:
 *
 *   adapter.setup(projectDir, url)  write the harness's config pointing at url
 *   adapter.run(projectDir, input, {task, stream})
 *        -> { exit, stop_reason, degradations: string[], trace: string[], output }
 *
 * Usage: node blackbox.mjs --adapter opencode --seed 1 --out raw/opencode-seed1.json [--work <dir>]
 * Needs: gnomon on PATH (the build under test; it serves the endpoint), node >= 20.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, xs) => (x.startsWith("--") ? [...a, [x.slice(2), xs[i + 1]]] : a), []));
const seed = Number(args.seed ?? 1);
const out = args.out ?? `blackbox-seed${seed}.json`;
const work = args.work ?? mkdtempSync(join(tmpdir(), "gbs-chaos-bb-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The adapter: gnomon, run exactly as `gnomon task --json` is run by a CI job ──
const corePath = spawnSync("sh", ["-c", 'dirname "$(dirname "$(readlink -f "$(command -v gnomon)")")"'], { encoding: "utf-8" }).stdout.trim();
const GNOMON = {
  name: "gnomon",
  transports: ["json", "sse"],
  tasks: ["answer", "read", "fix"],
  async setup(dir, url) {
    // The reference surface of CHAOS.md §6 / chaos_suite.ts, pointed at the served endpoint.
    const core = await import(pathToFileURL(join(corePath, "..", "gnomon-core", "dist", "index.js")).href);
    for (const [rel, content] of Object.entries(core.chaosSurfaceFiles(url))) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    this.config_hash = createHash("sha256").update(JSON.stringify(core.chaosSurfaceFiles("<chaos-endpoint>"))).digest("hex");
  },
  run(dir, input, { stream }) {
    return new Promise((resolve) => {
      const p = spawn("gnomon", ["task", input, "--json", "--yes", "--trust", "--role", stream ? "chaos_stream" : "chaos"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      const cap = setTimeout(() => { p.killed_by_cap = true; p.kill("SIGKILL"); }, CAP_MS);
      let so = "", se = "";
      p.stdout.on("data", (d) => (so += d));
      p.stderr.on("data", (d) => (se += d));
      p.on("close", (code) => {
        clearTimeout(cap);
        let rec = {};
        try { rec = JSON.parse(so); } catch { rec = { stop_reason: "(no JSON record)" }; }
        resolve({
          exit: p.killed_by_cap ? "killed" : code,
          stop_reason: String(rec.stop_reason),
          degradations: (rec.degradations ?? []).map((d) => String(d.id ?? d)),
          trace: se.split(/\r?\n/).filter((l) => l.trim() !== ""),
          output: typeof rec.output === "string" ? rec.output : JSON.stringify(rec.output ?? ""),
        });
      });
    });
  },
};

// ── The opencode v2.2.5 adapter (new in this run) ──
// Config: opencode V2's own format (`providers.<id>.settings`), the endpoint as an
// OpenAI-compatible provider, the §6 timeouts mapped to its provider settings
// (headerTimeout 1 s = request deadline, chunkTimeout 1 s = stream idle, timeout 10 s total).
// Run: `opencode run --standalone --auto --format json <input>`, PWD = the project (V2 takes its
// directory from $PWD, G2b), a fresh HOME per run so no session carries over.
// Channel mapping (published, §6): exit = process exit status; stop_reason = the `reason` of the
// last `step_finish` event, "(none)" if there is none; degradations = [] (opencode declares none);
// trace = stderr lines plus one line per `error` event, rendered "error <type>: <message>";
// output = the concatenated `text` parts. opencode streams every request, so only SSE-transport
// cases can fire (transports: ["sse"]).
const OPENCODE = {
  name: "opencode",
  transports: ["sse"],
  tasks: ["answer", "read"], // no declared-check mechanism, so `fix` cannot be run (CHAOS-9, deferred in 0.2)
  setup(dir, url) {
    const base = url.replace(/\/chat\/completions$/, "");
    const cfg = {
      $schema: "https://opencode.ai/config.json",
      model: { providerID: "chaos", model: "chaos-model" },
      update: "disable", share: "disabled",
      providers: { chaos: { name: "chaos", package: "aisdk:@ai-sdk/openai-compatible",
        settings: { apiKey: "none", baseURL: base, timeout: 10000, headerTimeout: 1000, chunkTimeout: 1000 },
        models: { "chaos-model": { name: "chaos-model" } } } },
    };
    writeFileSync(join(dir, "opencode.json"), JSON.stringify(cfg, null, 2) + "\n");
    const tmpl = { ...cfg, providers: { chaos: { ...cfg.providers.chaos, settings: { ...cfg.providers.chaos.settings, baseURL: "<chaos-endpoint>" } } } };
    this.config_hash = createHash("sha256").update(JSON.stringify(tmpl) + "\u0000run --standalone --auto --format json").digest("hex");
    this.config_files = { "opencode.json": tmpl, flags: ["run", "--standalone", "--auto", "--format", "json"], env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } };
  },
  run(dir, input) {
    return new Promise((resolve) => {
      const home = mkdtempSync(join(tmpdir(), "oc-home-"));
      const env = { ...process.env, HOME: home, PWD: dir, OPENCODE_CONFIG: join(dir, "opencode.json"), OPENCODE_DISABLE_AUTOUPDATE: "1" };
      const p = spawn("opencode", ["run", "--standalone", "--auto", "--format", "json", input], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      const cap = setTimeout(() => { p.killed_by_cap = true; p.kill("SIGKILL"); }, CAP_MS);
      let so = "", se = "";
      p.stdout.on("data", (d) => (so += d));
      p.stderr.on("data", (d) => (se += d));
      p.on("close", (code) => {
        clearTimeout(cap);
        const ev = so.split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { type: "unparsed", line: l }; } });
        const finishes = ev.filter((e) => e.type === "step_finish");
        const errors = ev.filter((e) => e.type === "error").map((e) => `error ${e.error?.type ?? "?"}: ${e.error?.message ?? JSON.stringify(e.error)}`);
        const unparsed = ev.filter((e) => e.type === "unparsed").map((e) => e.line);
        rmSync(home, { recursive: true, force: true });
        resolve({
          exit: p.killed_by_cap ? "killed" : code,
          stop_reason: finishes.length ? String(finishes[finishes.length - 1].part?.reason) : "(none)",
          degradations: [],
          trace: [...se.split(/\r?\n/).filter((l) => l.trim() !== ""), ...errors, ...unparsed],
          output: ev.filter((e) => e.type === "text").map((e) => e.part?.text ?? "").join(""),
          events: ev.length,
        });
      });
    });
  },
};
const CAP_MS = 300_000;
const ADAPTERS = { gnomon: GNOMON, opencode: OPENCODE };
const ADAPTER = ADAPTERS[args.adapter ?? "gnomon"];
if (!ADAPTER) { console.error(`no adapter ${args.adapter}`); process.exit(2); }
// --trust: the reference surface grants approval = "never" and a [verify] command, which an
// untrusted surface runs CLAMPED to the defaults (stderr says so); the in-process suite never
// meets that clamp. Without --trust the fix task cannot finish (found in the seed-999 smoke run).
// Channel mapping published with the result (§6): stop reason = record.stop_reason
// ("answered" is normal completion); declared degradations = record.degradations[].id;
// trace = stderr, line by line.

// ── The endpoint ──
const list = JSON.parse(spawnSync("gnomon", ["chaos", "list", "--json"], { encoding: "utf-8" }).stdout);
const logFile = join(work, "serve.jsonl");
const srv = spawn("gnomon", ["chaos", "serve", "--port", "0", "--seed", String(seed), "--log", logFile], { stdio: ["ignore", "ignore", "pipe"] });
let banner = "";
srv.stderr.on("data", (d) => (banner += d));
for (let i = 0; i < 100 && !/fix needs/.test(banner); i++) await sleep(50);
const url = /(http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions)/.exec(banner)?.[1];
const token = /CHAOS-OK ([A-Z0-9]+)/.exec(banner)?.[1];
if (!url || !token) { console.error("serve did not start:\n" + banner); srv.kill(); process.exit(2); }
const base = url.replace(/\/v1\/chat\/completions$/, "");
const post = async (body) => (await fetch(`${base}/chaos/case`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const span = async () => { await sleep(300); return (await fetch(`${base}/chaos/log`)).json(); }; // 300 ms: the in-process suite's takeLog grace

const inputOf = (task) => ({
  answer: `Reply with exactly: CHAOS-OK ${token} [chaos-task answer ${token}]`,
  read: `Read chaos/input.txt and reply with CHAOS-READ and the value it holds. [chaos-task read ${token}]`,
  fix: `Write ${token} to chaos/out.txt; the declared check verifies it. [chaos-task fix ${token}]`,
})[task];
const fileValue = `CHAOSVAL-${token.split("").reverse().join("")}`;
const expected = (task) => ({ answer: `CHAOS-OK ${token}`, read: `CHAOS-READ ${fileValue}`, fix: `CHAOS-FIXED ${token}` })[task];

const projects = [join(work, "project"), join(work, "lane-a"), join(work, "lane-b")];
for (const p of projects) { mkdirSync(p, { recursive: true }); await ADAPTER.setup(p, url); }
function fixtures(dir) {
  mkdirSync(join(dir, "chaos"), { recursive: true });
  writeFileSync(join(dir, "chaos/input.txt"), `${fileValue}\n`);
  writeFileSync(join(dir, "chaos/expected.txt"), `${token}\n`);
  rmSync(join(dir, "chaos/out.txt"), { force: true });
}
async function observe(dir, task, stream, body) {
  if (body) await post(body);
  fixtures(dir);
  const t0 = Date.now();
  const o = await ADAPTER.run(dir, inputOf(task), { task, stream });
  const ms = Date.now() - t0;
  const endpoint = body ? await span() : null;
  let outFile = null;
  try { outFile = readFileSync(join(dir, "chaos/out.txt"), "utf-8").trim(); } catch {}
  o.recovered = o.output.includes(expected(task)) && (task !== "fix" || outFile === token);
  return { ...o, endpoint, ms };
}

// ── §4 scoring, from the spec text ──
const re = (src, flags) => new RegExp(src, flags);
function score(fault, b, o, flags = "i") {
  const channels = [];
  if (o.exit !== b.exit) channels.push("exit");
  if (o.stop_reason !== b.stop_reason) channels.push("stop_reason");
  const newDeg = [...new Set(o.degradations.filter((d) => !b.degradations.includes(d)))];
  if (newDeg.length) channels.push("degradation");
  const seen = new Set(b.trace);
  const newTrace = o.trace.filter((l) => !seen.has(l));
  const naming = newTrace.filter((l) => re(fault.names, flags).test(l));
  if (naming.length) channels.push("trace");
  const fired = (o.endpoint?.fired ?? 0) > 0;
  return {
    fired, announced: channels.length > 0, channels,
    named: naming.length > 0 || newDeg.some((d) => (fault.degradations ?? []).includes(d)),
    recovered: o.recovered, silent: fired && channels.length === 0, new_trace: newTrace, new_degradations: newDeg,
  };
}

const card = { schema: "gbs-chaos-blackbox/1", spec: "GBS-CHAOS 0.2 (draft)", arm: "B", adapter: ADAPTER.name, seed, token, endpoint: url,
  harness: spawnSync(ADAPTER.name, ["--version"], { encoding: "utf-8" }).stdout.trim(), endpoint_build: spawnSync("gnomon", ["--version"], { encoding: "utf-8" }).stdout.trim(),
  transports: ADAPTER.transports, cap_ms: CAP_MS, problems: [], baselines: [], controls: [], lane_check: {}, cases: [] };
try {
  const plan = [];
  for (const f of list.faults) for (const s of f.schedules) plan.push({ id: `${f.id}/${s}`, fault: f, schedule: s, task: f.task, stream: f.stream });
  card.plan_cases = plan.length;
  card.config_hash = ADAPTER.config_hash;
  card.config_files = ADAPTER.config_files ?? null;

  // Clean runs per (task, transport)
  const key = (t, s) => `${t}:${s ? "stream" : "json"}`;
  const need = new Map([[key("answer", false), ["answer", false]]]);
  const supported = (stream) => ADAPTER.transports.includes(stream ? "sse" : "json");
  for (const c of plan) need.set(key(c.task, c.stream), [c.task, c.stream]);
  const baselines = new Map();
  for (const [k, [t, s]] of need) {
    const o = await observe(projects[0], t, s, {});
    baselines.set(k, o);
    card.baselines.push({ key: k, exit: o.exit, stop_reason: o.stop_reason, recovered: o.recovered, requests: o.endpoint.requests.length, billed: o.endpoint.tokens.billed, trace_lines: o.trace.length,
      endpoint_requests: o.endpoint.requests.map((r) => ({ n: r.n, stream: r.stream, reply: r.reply, prompt_tokens: r.tokens?.prompt })) });
    // A clean run of a transport the adapter cannot request is still run (the harness picks its own
    // transport); it must finish its task all the same.
    if (!o.recovered && ADAPTER.tasks.includes(t)) card.problems.push(`clean ${k} did not finish (exit ${o.exit}, ${o.stop_reason})`);
  }

  // §5.1 negative controls, through this scorer, on the real clean answer/json run
  const b0 = baselines.get(key("answer", false));
  const err = list.faults.find((f) => f.id === "error"), rate = list.faults.find((f) => f.id === "rate_limit");
  const fired = { ...b0, endpoint: { ...b0.endpoint, fired: 1 } };
  card.controls = [
    ["a run identical to the clean run scores silent", false, score(err, b0, fired).announced],
    ["a trace line naming the wrong fault scores silent", false, score(rate, b0, { ...fired, trace: [...b0.trace, "  [retry] endpoint unreachable — attempt 1 of 3, waiting 20ms"] }).announced],
    ["a changed exit status scores announced", true, score(err, b0, { ...fired, exit: b0.exit === 10 ? 0 : 10 }).announced],
  ].map(([name, expected, scored]) => ({ name, expected, scored, ok: expected === scored }));
  for (const c of card.controls) if (!c.ok) card.problems.push(`control failed: ${c.name}`);

  // §5.2 lane check: serial vs concurrent is runnable black-box; the garbling control is not
  await post({});
  const serial = await observe(projects[1], "answer", false, null);
  const pair = await Promise.all([observe(projects[1], "answer", false, null), observe(projects[2], "answer", false, null)]);
  const lane = await span();
  const overlapped = lane.requests.length >= 3; // serial + two concurrent; overlap itself cannot be forced without the latency option
  card.lane_check = {
    per_harness: {
      serial_equals_concurrent: pair.every((o) => o.output === serial.output && o.exit === serial.exit),
      requests_seen: lane.requests.length,
      overlap_forced: false,
    },
    endpoint_build: "cited, not run here: see chaos/raw/endpoint-lane-check.json (in-process `gnomon chaos` on the same endpoint build)",
  };
  if (!card.lane_check.per_harness.serial_equals_concurrent) card.problems.push("§5.2(b) per-harness lane check: serial and concurrent clean runs differ");
  void overlapped;

  // The cases
  for (const c of plan) {
    const b = baselines.get(key(c.task, c.stream));
    const o = await observe(projects[0], c.task, c.stream, { fault: c.fault.id, schedule: c.schedule, seed });
    const v = score(c.fault, b, o);
    const vNoFlag = score(c.fault, b, o, "");
    const reqTransports = [...new Set((o.endpoint.requests ?? []).map((r) => (r.stream ? "sse" : "json")))];
    const unsupportedTransport = !supported(c.stream) && !v.fired && reqTransports.every((t) => ADAPTER.transports.includes(t));
    const unsupportedTask = !ADAPTER.tasks.includes(c.task) && !v.fired;
    const unsupported = unsupportedTransport || unsupportedTask;
    const unsupportedWhy = [unsupportedTransport && "transport", unsupportedTask && "task"].filter(Boolean).join(", ");
    const billed = o.endpoint.tokens.billed;
    card.cases.push({
      id: c.id, fault: c.fault.id, schedule: c.schedule, task: c.task, stream: c.stream,
      fired: v.fired, unsupported: unsupported, unsupported_why: unsupportedWhy || null, request_transports: reqTransports, injected: o.endpoint.fired, requests: o.endpoint.requests.length,
      announced: v.announced, named: v.named, channels: v.channels, recovered: v.recovered, silent: v.silent,
      named_if_pattern_compiled_without_i_flag: vNoFlag.named,
      exit: o.exit, stop_reason: o.stop_reason, degradations: v.new_degradations,
      tokens: { billed, baseline: b.endpoint.tokens.billed, wasted: v.recovered ? Math.max(0, billed - b.endpoint.tokens.billed) : billed },
      leaked: o.endpoint.leaked, ms: o.ms, new_trace: v.new_trace.slice(0, 12),
      // Per request: which one the fault hit, and its prompt size (opencode's session-title request
      // is the small one; it is sent first, so `single` schedules land on it).
      endpoint_requests: (o.endpoint.requests ?? []).map((r) => ({ n: r.n, stream: r.stream, reply: r.reply, injected: r.injected, status: r.status, outcome: r.outcome, client_closed: r.client_closed, prompt_tokens: r.tokens?.prompt })),
    });
    if (!v.fired && !unsupported) card.problems.push(`${c.id} never fired`);
    process.stderr.write(`${v.fired ? (v.silent ? "SILENT   " : "announced") : unsupported ? "UNSUPPORTED" : "NOT FIRED"} ${c.id} ${v.channels.join("+")} ${o.ms}ms\n`);
  }
  const f = card.cases.filter((r) => r.fired), failed = f.filter((r) => !r.recovered);
  const byFault = {};
  for (const r of card.cases) (byFault[r.fault] ??= []).push(r);
  card.faults = Object.entries(byFault).map(([id, rs]) => {
    const fr = rs.filter((r) => r.fired);
    const un = rs.filter((r) => r.unsupported).length;
    return { id, cases: rs.length, fired: fr.length, unsupported: un, announced: fr.filter((r) => r.announced).length, named: fr.filter((r) => r.named).length, recovered: fr.filter((r) => r.recovered).length,
      verdict: fr.length === 0 ? (un === rs.length ? `unsupported (${[...new Set(rs.map((r) => r.unsupported_why))].join("; ")})` : "not_fired") : fr.some((r) => r.silent) ? "silent" : "announced" };
  });
  card.summary = {
    faults: card.faults.length, faults_announced: card.faults.filter((x) => x.verdict === "announced").length,
    faults_unsupported: card.faults.filter((x) => x.verdict.startsWith("unsupported")).map((x) => `${x.id}: ${x.verdict}`),
    cases_unsupported: card.cases.filter((r) => r.unsupported).length,
    faults_silent: card.faults.filter((x) => x.verdict === "silent").map((x) => x.id),
    cases: card.cases.length, cases_fired: f.length, cases_announced: f.filter((r) => r.announced).length,
    cases_named: f.filter((r) => r.named).length, cases_named_without_i_flag: f.filter((r) => r.named_if_pattern_compiled_without_i_flag).length,
    cases_recovered: f.filter((r) => r.recovered).length, failed: failed.length, silent_failures: failed.filter((r) => r.silent).length,
    leaked: card.cases.reduce((a, r) => a + r.leaked, 0),
  };
} finally {
  srv.kill("SIGTERM");
  card.void = card.problems.length > 0;
  writeFileSync(out, JSON.stringify(card, null, 2) + "\n");
  appendFileSync(out.replace(/\.json$/, ".serve-log-path.txt"), logFile + "\n");
}
console.log(JSON.stringify(card.summary ?? card.problems));

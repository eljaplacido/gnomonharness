/**
 * `gnomon improve` the command (docs/CONTRACTS.md section 59): a dry run by
 * default, flags checked, the refusals, the schedule file, the text and JSON
 * output, and the dashboard's view of runs and evidence.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IMPROVE_SCHEMA, listProposals, loadConfig, loadLoops, type DraftModel } from "gnomon-core";
import { setDecisionContextProbe } from "../../gnomon-core/src/agent_context.js";
import { initSurface } from "./init.js";
import { IMPROVE_EXIT, formatImprove, runImproveCmd } from "./improve_cmd.js";
import { CLI_COMMANDS } from "./index.js";
import { proposalsView } from "./dashboard_data.js";
import { runProposals } from "./proposals_cmd.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const LAUNCHER = join(REPO, "gnomon");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
let marker: string | undefined;
beforeEach(() => {
  setDecisionContextProbe(() => ({ agent: null, interactive: true }));
  marker = process.env.GNOMON_AGENT_SESSION;
  delete process.env.GNOMON_AGENT_SESSION;
});
afterEach(() => {
  setDecisionContextProbe(null);
  if (marker === undefined) delete process.env.GNOMON_AGENT_SESSION;
  else process.env.GNOMON_AGENT_SESSION = marker;
});

async function project(): Promise<string> {
  const root = join(mkdtempSync(join(tmpdir(), "gnomon-improve-cli-")), "proj");
  made.push(join(root, ".."));
  mkdirSync(root);
  await initSurface({ dir: root });
  // Three sessions, each refused by the same rule: one skill candidate.
  mkdirSync(join(root, ".gnomon-audit"));
  for (let s = 1; s <= 3; s++) {
    writeFileSync(
      join(root, ".gnomon-audit", `s${s}.jsonl`),
      `${JSON.stringify({ seq: 1, ts: "2026-11-20T10:00:00.000Z", prev: null, kind: "tool_call", role: "implement", tool: "bash", target: "rm -rf", gated: false, code: 3, bucket: "refusal", summary: "bash — denied by bash_deny (rm -rf)", started_at: "x", duration_ms: 1 })}\n`
    );
  }
  return root;
}

async function run(root: string, flags: Record<string, string> = {}, json = false, bind: Parameters<typeof runImproveCmd>[2] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runImproveCmd(loadConfig(root), { flags, json }, bind, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("gnomon improve: the command", () => {
  it("is registered, dispatched and in --help", () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toContain("improve");
    const r = spawnSync(process.execPath, [LAUNCHER, "--help"], { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", GNOMON_NO_UPDATE_CHECK: "1" } });
    expect(r.stdout).toMatch(/^ {2}improve \[--dry-run\] \[--run\]/m);
  });

  it("is a dry run by default: it reads the record, prints the plan, and calls and writes nothing", async () => {
    const root = await project();
    let calls = 0;
    const model: DraftModel = async () => (calls++, { ok: true, text: "{}" });
    const r = await run(root, {}, false, { model, runCell: async () => (calls++, Promise.reject(new Error("no"))) });
    expect(r.code).toBe(IMPROVE_EXIT.ok);
    expect(calls).toBe(0);
    expect(r.out).toMatch(/dry run\): nothing is written and no model is called/);
    expect(r.out).toMatch(/1 candidate/);
    expect(r.out).toMatch(/skill\s+repeated_refusal\s+bash_deny boundary\s+3\s+would propose/);
    expect(r.out).toMatch(/Probe: .gnomon\/trials\/default.toml, k = 2, 1 task\(s\): 4 cells per candidate/);
    expect(r.out).toMatch(/no \[improve\] auto_accept is declared, so a person decides every proposal/);
    expect(existsSync(join(root, ".gnomon-proposals"))).toBe(false);
    // An explicit --dry-run is the same.
    expect((await run(root, { "dry-run": "true" })).out).toMatch(/dry run/);
  });

  it("--json is the report: schema, mode, candidates with their evidence", async () => {
    const root = await project();
    const r = await run(root, {}, true);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ schema: IMPROVE_SCHEMA, mode: "dry-run", mined: { candidates: 1 }, proposals: [], policy: { declared: false } });
    expect(j.candidates[0]).toMatchObject({ family: "skill", signal: "repeated_refusal", action: "propose" });
    expect(j.candidates[0].evidence[0]).toMatchObject({ trail: expect.stringMatching(/^s\d\.jsonl$/), seq: 1 });
  });

  it("--run drafts with the bound model and writes proposals, not .gnomon/", async () => {
    const root = await project();
    const files = readdirSync(join(root, ".gnomon")).sort();
    const model: DraftModel = async () => ({ ok: true, text: JSON.stringify({ name: "deletion boundary", description: "Applies when a delete is refused.", body: "Do not retry a refused delete because every retry is refused; ask for the file to be removed instead." }) });
    const r = await run(root, { run: "true" }, false, { model });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/gnomon improve \(run /);
    expect(r.out).toMatch(/skill\/skill\s+deletion boundary/);
    expect(r.out).toMatch(/unprobed: no model runner/);
    expect(r.out).toMatch(/lint clean/);
    expect(r.out).toMatch(/Wrote 1 proposal/);
    expect(readdirSync(join(root, ".gnomon")).sort()).toEqual(files);
    expect(listProposals(loadConfig(root)).proposals).toHaveLength(1);
  });

  it("checks its flags", async () => {
    const root = await project();
    expect((await run(root, { run: "true", "dry-run": "true" })).code).toBe(IMPROVE_EXIT.usage);
    expect((await run(root, { k: "0" })).code).toBe(IMPROVE_EXIT.usage);
    expect((await run(root, { k: "abc" })).code).toBe(IMPROVE_EXIT.usage);
    expect((await run(root, { "budget-usd": "-1" })).code).toBe(IMPROVE_EXIT.usage);
    expect((await run(root, { bogus: "x" })).err).toMatch(/unknown option --bogus/);
    expect((await run(root, { schedule: "hourly" })).code).toBe(IMPROVE_EXIT.usage);
    const j = JSON.parse((await run(root, { k: "99" }, true)).out);
    expect(j).toMatchObject({ schema: IMPROVE_SCHEMA, exit: 1 });
  });

  it("--run is refused inside an agent session, and writes nothing", async () => {
    const root = await project();
    process.env.GNOMON_AGENT_SESSION = "x";
    const r = await run(root, { run: "true" });
    expect(r.code).toBe(IMPROVE_EXIT.refused);
    expect(r.err).toMatch(/agent session/);
    expect(existsSync(join(root, ".gnomon-proposals"))).toBe(false);
    // A dry run is read-only and is not refused.
    expect((await run(root, {})).code).toBe(0);
  });

  it("--scheduled is a dry run unless policy.toml declares scheduled = run", async () => {
    const root = await project();
    const dry = await run(root, { scheduled: "true" });
    expect(dry.out).toMatch(/scheduled, dry/);
    expect(existsSync(join(root, ".gnomon-proposals"))).toBe(false);
    writeFileSync(join(root, ".gnomon", "policy.toml"), `${readFileSync(join(root, ".gnomon", "policy.toml"), "utf-8")}\n[improve]\nscheduled = "run"\n`);
    const wet = await run(root, { scheduled: "true" });
    expect(wet.out).toMatch(/gnomon improve \(run /);
    expect(listProposals(loadConfig(root)).proposals).toHaveLength(1);
  });

  it("--scheduled with scheduled = run is still refused inside an agent session: no model call, no write", async () => {
    const root = await project();
    writeFileSync(join(root, ".gnomon", "policy.toml"), `${readFileSync(join(root, ".gnomon", "policy.toml"), "utf-8")}\n[improve]\nscheduled = "run"\n`);
    process.env.GNOMON_AGENT_SESSION = "x";
    let calls = 0;
    const r = await run(root, { scheduled: "true" }, false, { model: async () => (calls++, { ok: true, text: "{}" }) });
    expect(r.code).toBe(IMPROVE_EXIT.refused);
    expect(r.err).toMatch(/agent session/);
    expect(calls).toBe(0);
    expect(existsSync(join(root, ".gnomon-proposals"))).toBe(false);
  });

  it("--run is refused without a confined sandbox unless --allow-host-probes, which the report records", async () => {
    const root = await project();
    const pol = join(root, ".gnomon", "policy.toml");
    writeFileSync(pol, readFileSync(pol, "utf-8").replace('level = "confined"', 'level = "off"'));
    const refused = await run(root, { run: "true" });
    expect(refused.code).toBe(IMPROVE_EXIT.refused);
    expect(refused.err).toMatch(/\[sandbox\] is not confined.*--allow-host-probes/s);
    expect(existsSync(join(root, ".gnomon-proposals"))).toBe(false);
    const allowed = await run(root, { run: "true", "allow-host-probes": "true" }, true);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.out).problems.join(" ")).toMatch(/allow-host-probes/);
    // A dry run needs no sandbox.
    expect((await run(root, {})).code).toBe(0);
  });

  it("--max-requests is a whole number", async () => {
    const root = await project();
    expect((await run(root, { run: "true", "max-requests": "0" })).code).toBe(IMPROVE_EXIT.usage);
    expect((await run(root, { run: "true", "max-requests": "x" })).code).toBe(IMPROVE_EXIT.usage);
  });

  it("--schedule writes a loop file for a person to review; it installs nothing, and refuses without a person", async () => {
    const root = await project();
    const r = await run(root, { schedule: "nightly" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Then `gnomon loop install improve` puts it in cron \(nothing is scheduled until you do\)/);
    expect(r.out).toMatch(/Each tick is a dry run unless policy.toml sets \[improve\] scheduled = "run"/);
    const loops = loadLoops(join(root, ".gnomon"));
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ name: "improve", every: "1d", act: { run: "gnomon improve --scheduled" }, limits: { max_runs_per_hour: 1 } });
    // Twice is refused, not overwritten.
    expect((await run(root, { schedule: "weekly" })).code).toBe(IMPROVE_EXIT.usage);
    expect(loadLoops(join(root, ".gnomon"))[0]!.every).toBe("1d");
    // No terminal: refused.
    const other = await project();
    setDecisionContextProbe(() => ({ agent: null, interactive: false }));
    const n = await run(other, { schedule: "nightly" });
    expect(n.code).toBe(IMPROVE_EXIT.refused);
    expect(existsSync(join(other, ".gnomon", "loops", "improve.toml"))).toBe(false);
    // Agent session: refused.
    setDecisionContextProbe(() => ({ agent: "claude", interactive: true }));
    process.env.GNOMON_AGENT_SESSION = "x";
    expect((await run(other, { schedule: "nightly" })).code).toBe(IMPROVE_EXIT.refused);
  });

  it("the dashboard's Proposals view carries the evidence and the recent runs; the page script parses", async () => {
    const root = await project();
    const model: DraftModel = async () => ({ ok: true, text: JSON.stringify({ name: "deletion boundary", description: "Applies when a delete is refused.", body: "Do not retry a refused delete because every retry is refused." }) });
    await run(root, { run: "true" }, false, { model });
    const view = proposalsView({ id: "p", root, name: "x", source: "here", exists: true, hasSurface: true } as never) as {
      proposals: Array<{ improve: { candidate: string; lint: { clean: boolean }; probe: { status: string } } }>;
      improve_runs: Array<{ mode: string; proposals: number; candidates: number }>;
    };
    expect(view.proposals[0]!.improve).toMatchObject({ candidate: "skill", lint: { clean: true }, probe: { status: "unprobed" } });
    expect(view.improve_runs).toHaveLength(1);
    expect(view.improve_runs[0]).toMatchObject({ mode: "run", proposals: 1, candidates: 1 });
    const js = join(REPO, "packages", "gnomon-cli", "dashboard", "inbox.js");
    expect(readFileSync(js, "utf-8")).toContain("Probe contrasts: the candidate surface against the base surface");
    // The page is an ES module: parse it without running it.
    const copy = join(mkdtempSync(join(tmpdir(), "gnomon-inbox-js-")), "inbox.mjs");
    made.push(join(copy, ".."));
    writeFileSync(copy, readFileSync(js));
    expect(spawnSync(process.execPath, ["--check", copy], { encoding: "utf-8" }).status).toBe(0);
  });

  it("gnomon proposals show prints the improve evidence above the diff", async () => {
    const root = await project();
    await run(root, { run: "true" });
    const id = listProposals(loadConfig(root)).proposals[0]!.id;
    const out: string[] = [];
    runProposals(loadConfig(root), { sub: "show", positional: [id], flags: {}, json: false }, (s) => out.push(s));
    expect(out.join("\n")).toMatch(/gnomon improve \(.+\): skill, drafted by template; lint clean[\s\S]*probe: unprobed[\s\S]*--- \.gnomon\/skills\//);
  });

  it("formatImprove shows the contrasts a probe measured", () => {
    const text = formatImprove({
      schema: IMPROVE_SCHEMA,
      mode: "run",
      run: "r",
      mined: { trails: 3, records: 9, candidates: 1, notes: [] },
      role: { name: "smol", local: true, why: "the first role on a local endpoint" },
      probe: { spec: "default", k: 3, tasks: 2, cells_per_candidate: 12 },
      candidates: [],
      proposals: [
        {
          id: "20261122T000000000Z-aaaa",
          kind: "skill",
          candidate: "skill",
          title: "t",
          paths: ["skills/t.md"],
          lint: { clean: true, problems: [] },
          drafted_by: "model:smol",
          probe: { status: "probed", pairs: { planned: 6, valid: 6 }, base: { passes: 2, n: 6, tokens_out: 100, requests: 10, refusals: 1, checks: { pass: 2, fail: 4, invalid: 0 } }, candidate: { passes: 5, n: 6, tokens_out: 90, requests: 9, refusals: 0, checks: { pass: 5, fail: 1, invalid: 0 } }, pass_delta: 0.5, token_delta: -0.1, request_delta: -0.1, regressed: false, improved: true },
          auto: { accepted: true },
        },
      ],
      policy: { declared: true, auto_accept: ["skill"], accepted: ["20261122T000000000Z-aaaa"], problems: [] },
      budget: { usd: 0, requests: 4, tokens_in: 0, tokens_out: 0 },
      problems: [],
    }).join("\n");
    expect(text).toMatch(/pass 2\/6 -> 5\/6 \(\+50\.0%\), output tokens -10\.0%, steps -10\.0%, refusals 1 -> 0, improved/);
    expect(text).toMatch(/ACCEPTED \(policy:improve\.auto_accept\)/);
  });
});

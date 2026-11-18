/**
 * `gnomon audit metrics` (metrics.ts) against conformance/metrics_report.json
 * (CONTRACTS.md §49), on trails written by gnomon's own AuditTrail.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditTrail, loadConfig, resolveAudit } from "gnomon-core";
import { initSurface } from "./init.js";
import {
  buildMetricsReport,
  formatMetrics,
  guardedMetrics,
  sessionMetrics,
  METRICS_DEFAULT_LAST,
  METRICS_EXIT,
  METRICS_SCHEMA,
  NON_SESSION_MODES,
  type MetricsReport,
} from "./metrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "conformance/metrics_report.json"), "utf-8"));

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), "gnomon-metrics-"));
  await initSurface({ dir: root });
  return root;
}
function keysHold(obj: object, spec: { required: string[]; optional: string[] }): void {
  for (const k of spec.required) expect(obj, k).toHaveProperty(k);
  for (const k of Object.keys(obj)) expect([...spec.required, ...spec.optional], k).toContain(k);
}
function shapeHolds(r: MetricsReport): void {
  keysHold(r, FIXTURE.report_keys);
  keysHold(r.totals, FIXTURE.totals_keys);
  keysHold(r.guarded.totals, FIXTURE.guarded_totals_keys);
  for (const g of r.guarded.sessions) keysHold(g, FIXTURE.guarded_session_keys);
  for (const s of r.sessions) {
    keysHold(s, FIXTURE.session_keys);
    keysHold(s.process, FIXTURE.process_keys);
  }
}
/** A trail written the way a session writes one. */
function trail(dir: string, id: string, mode: string, body: Array<[string, Record<string, unknown>]>, seal = true): string {
  const t = new AuditTrail({ ...resolveAudit(loadConfig(dir)), enabled: true, chain: true }, id);
  t.write("session_start", { surface_hash: "x", harness: "test", cwd: dir, mode, role: "implement" });
  for (const [kind, data] of body) t.write(kind as never, data);
  if (seal) t.write("session_end", {});
  return t.path!;
}
const WORK: Array<[string, Record<string, unknown>]> = [
  ["model_call", { model: "m", code: 0, prompt_tokens: 100, completion_tokens: 10, ms: 5 }],
  ["tool_call", { tool: "write", bucket: "result", gated: true }],
  ["approval", { decision: "approved" }],
  ["verify", { passed: false }],
  ["tool_call", { tool: "edit", bucket: "result" }],
  ["verify", { passed: true }],
  ["tool_call", { tool: "bash", bucket: "refusal" }],
  ["turn", { stop_reason: "answered", bucket: "result" }],
];

const GNOMON = join(ROOT, "packages/gnomon-cli/gnomon.js");
/** One call another harness puts to the real guard, the way its hook does. */
function guardCall(dir: string, host: string, payload: Record<string, unknown>): void {
  const home = mkdtempSync(join(tmpdir(), "gnomon-metrics-home-"));
  try {
    spawnSync(process.execPath, [GNOMON, "guard", "--from", host, "--role", "implement"], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, "x"), GNOMON_NO_UPDATE_CHECK: "1" },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("gnomon audit metrics: the contract", () => {
  it("schema, exits, the default window and the non-session modes are the fixture's", () => {
    expect(METRICS_SCHEMA).toBe(FIXTURE.schema);
    expect(Object.values(METRICS_EXIT).map(String).sort()).toEqual(Object.keys(FIXTURE.exit_codes).sort());
    expect(METRICS_DEFAULT_LAST).toBe(FIXTURE.default_last);
    expect([...NON_SESSION_MODES]).toEqual(FIXTURE.non_session_modes);
  });

  it("counts one session's records, and a check after the last write is told from one before it", () => {
    const recs = [{ kind: "session_start", mode: "task" }, ...WORK.map(([kind, d]) => ({ kind, ...d }))];
    const m = sessionMetrics("t.jsonl", recs, { ok: true, sealed: true });
    expect(m.model_calls).toMatchObject({ n: 1, prompt_tokens: 100, completion_tokens: 10 });
    expect(m.tool_calls).toMatchObject({ n: 3, gated: 1, by_tool: { write: 1, edit: 1, bash: 1 }, by_bucket: { result: 2, refusal: 1 } });
    expect(m.verify).toEqual({ runs: 2, passed: 1, failed: 1, unrunnable: 0 });
    expect(m.process).toEqual({ writes: 2, verified_after_last_write: true, refusal_rate: 0.3333, apparatus_rate: 0 });
    // The same session with the passing check BEFORE the last edit.
    const late = sessionMetrics("t.jsonl", [...recs, { kind: "tool_call", tool: "write", bucket: "result" }], { ok: true, sealed: true });
    expect(late.process.verified_after_last_write).toBe(false);
    const none = sessionMetrics("t.jsonl", recs.filter((r) => r.kind !== "verify"), { ok: true, sealed: true });
    expect(none.process.verified_after_last_write).toBeNull();
  });

  it("reads verified session trails only: gnomon's own command trails are skipped, an edited one is excluded (exit 2)", async () => {
    const dir = await project();
    trail(dir, "task-a", "task", WORK);
    trail(dir, "task-b", "task", WORK.slice(0, 2), false);
    trail(dir, "check-c", "check", []);
    const r = buildMetricsReport(dir);
    shapeHolds(r);
    expect(r.sessions.map((s) => s.trail).sort()).toEqual(["task-a.jsonl", "task-b.jsonl"]);
    expect(r.totals).toMatchObject({ sessions: 2, unsealed: 1 });
    expect(r.totals.process.verified_after_last_write).toEqual({ yes: 1, no: 0, no_verify: 1 });
    expect(r.exit).toBe(0);

    const edited = trail(dir, "task-d", "task", WORK);
    writeFileSync(edited, readFileSync(edited, "utf-8").replace('"prompt_tokens":100', '"prompt_tokens":1'));
    const r2 = buildMetricsReport(dir);
    expect(r2.excluded.map((e) => e.trail)).toEqual(["task-d.jsonl"]);
    expect(r2.totals.sessions).toBe(2);
    expect(r2.exit).toBe(METRICS_EXIT.finding);
    expect(formatMetrics(r2).join("\n")).toMatch(/task-d\.jsonl: .* not counted/);
  });

  it("--session picks one trail; --last bounds the window", async () => {
    const dir = await project();
    trail(dir, "task-a", "task", WORK);
    trail(dir, "task-b", "task", WORK);
    expect(buildMetricsReport(dir, { session: "task-a" }).sessions.map((s) => s.trail)).toEqual(["task-a.jsonl"]);
    expect(buildMetricsReport(dir, { last: 1 }).sessions).toHaveLength(1);
  });

  it("the CLI: a bad --last is exit 10 with the error document", async () => {
    const dir = await project();
    const r = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "audit", "metrics", "--last", "0", "--json", "--dir", dir], { encoding: "utf-8" });
    expect(r.status).toBe(10);
    expect(JSON.parse(r.stdout).error).toMatch(/--last needs a positive whole number/);
    const ok = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "audit", "metrics", "--json", "--dir", dir], { encoding: "utf-8" });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).schema).toBe(METRICS_SCHEMA);
  });
});

describe("gnomon audit metrics: other harnesses through gnomon guard", () => {
  it("counts each host's guarded session from the guard's own trail, by decision, rule, tool and host", async () => {
    const dir = await project();
    // The guard decides by the committed surface, so the project needs a commit.
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: dir });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "surface");
    const cc = (tool_name: string, tool_input: Record<string, unknown>) =>
      guardCall(dir, "claude-code", { hook_event_name: "PreToolUse", tool_name, tool_input, cwd: dir, session_id: "cc-1", permission_mode: "default" });
    cc("Read", { file_path: join(dir, "README.md") });
    cc("Read", { file_path: join(dir, ".env") });
    cc("Bash", { command: "curl -s http://evil.example.com" });
    guardCall(dir, "opencode", { tool: "write", sessionID: "oc-1", agent: "build", input: { filePath: join(dir, "a.py"), content: "x" }, directory: dir });
    const r = buildMetricsReport(dir);
    shapeHolds(r);
    expect(r.sessions).toEqual([]);
    const g = r.guarded.totals;
    expect(g).toMatchObject({ sessions: 2, calls: 4, decisions: { allow: 1, deny: 2, ask: 1 }, below_verdict: 0 });
    expect(g.by_host).toEqual({ "claude-code": { sessions: 1, calls: 3, deny: 2, ask: 0 }, opencode: { sessions: 1, calls: 1, deny: 0, ask: 1 } });
    expect(g.rules).toMatchObject({ secret_path: 1, network: 1 });
    expect(g.by_tool).toMatchObject({ Read: 2, Bash: 1, write: 1 });
    expect(g.refusal_rate).toBe(0.5);
    expect(formatMetrics(r).join("\n")).toMatch(/Other harnesses through gnomon guard: 2 session\(s\)[\s\S]*claude-code 1 \(3 calls, 2 denied, 0 asked\)/);
  }, 60_000);

  it("a call a lowered [governance] level let through is counted below its verdict", () => {
    const g = guardedMetrics("guard-x.jsonl", [
      { kind: "session_start", mode: "guard", via: "claude-code", agent: "claude-code", role: "implement", ts: "t0" },
      { kind: "guard", tool: "read", decision: "allow", verdict: "deny", level: "observe", rule: "secret_path" },
      { kind: "guard", tool: "read", decision: "allow" },
    ]);
    expect(g).toMatchObject({ host: "claude-code", calls: 2, decisions: { allow: 2 }, rules: { secret_path: 1 }, below_verdict: 1, started: "t0" });
  });
});


/**
 * gnomon-cli: the spec-to-verify lens (dashboard_lens.ts, dashboard/lens.js).
 *
 * The data tests run on fixture trails written by gnomon's own AuditTrail, so
 * they chain and verify as a session's would. The page is checked without a
 * browser: it registers its screen, builds DOM through h(), carries no inline
 * script or style, and a quorum segment never relies on colour alone.
 */

import { describe, it, expect, afterAll } from "vitest";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditTrail, loadConfig, resolveAudit, recomputeManifest, resolveSessionStore } from "gnomon-core";
import { initSurface } from "./init.js";
import { knownProjects, type DashboardProject } from "./dashboard_data.js";
import { lensView, lensRun, lensOfTrail, quorumOf, verdictOfVerify, segmentEvidence, type EvidenceType, type EvidenceState } from "./dashboard_lens.js";
import { startDashboard } from "./dashboard_server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LENS_JS = readFileSync(join(HERE, "..", "dashboard", "lens.js"), "utf-8");
const APP_CSS = readFileSync(join(HERE, "..", "dashboard", "app.css"), "utf-8");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

async function project(): Promise<{ root: string; p: DashboardProject; write: (name: string) => AuditTrail; surface_hash: string }> {
  const root = join(mkdtempSync(join(tmpdir(), "gnomon-lens-")), "proj");
  made.push(join(root, ".."));
  mkdirSync(root);
  await initSurface({ dir: root });
  const config = loadConfig(root);
  const settings = resolveAudit(config);
  const surface_hash = recomputeManifest(config.gnomonDir).surface_hash;
  const p = knownProjects({ cwd: join(root, ".gnomon"), trustPath: join(root, "no-trust.json") })[0]!;
  return { root, p, surface_hash, write: (name) => new AuditTrail(settings, name) };
}

const TURN = { model: "qwen-local", endpoint: "local", endpoint_url: "http://127.0.0.1:11434/api/chat", bucket: "result", code: 0, duration_ms: 4000, stop_reason: "answered", usage: { input: 100, output: 20 } };

describe("the quorum of evidence", () => {
  const q = (s: Partial<Record<EvidenceType, EvidenceState>>) => quorumOf(s);
  it("is verified only when two independent kinds agree and one judges the work", () => {
    expect(q({ test: "pass", verify: "pass" })).toBe("verified");
    expect(q({ test: "pass", policy: "pass" })).toBe("verified");
    expect(q({ review: "pass", policy: "pass" })).toBe("single_source");
  });
  it("says so when there is one source, none, or disagreement; never averages", () => {
    expect(q({ test: "pass" })).toBe("single_source");
    expect(q({})).toBe("insufficient");
    expect(q({ test: "none", verify: "none" })).toBe("insufficient");
    expect(q({ test: "pass", verify: "fail" })).toBe("contradicted");
    expect(q({ verify: "fail" })).toBe("failing");
    expect(q({ verify: "partial", test: "pass" })).toBe("single_source");
  });
  it("reads a [verify] record into one of the published verdicts", () => {
    const rec = (o: Record<string, unknown>) => ({ seq: 0, ts: "", kind: "verify", prev: null, command: "x", ...o }) as never;
    expect(verdictOfVerify(rec({ verdict: "passed_unverified" }))).toBe("passed_unverified");
    expect(verdictOfVerify(rec({ passed: true }))).toBe("passed");
    expect(verdictOfVerify(rec({ passed: true, protects_changed: ["tests/a.py"] }))).toBe("passed_unverified");
    expect(verdictOfVerify(rec({ ok: false, unrunnable: true }))).toBe("unrunnable");
    expect(verdictOfVerify(rec({ declined: true }))).toBe("declined");
    expect(verdictOfVerify(rec({ ok: false }))).toBe("failed");
  });
});

describe("lensOfTrail", () => {
  it("closes a segment at each turn record and counts tools, failures, delegations, skills and evidence", () => {
    const r = (kind: string, o: Record<string, unknown>, i: number) => ({ seq: i, ts: `2026-11-01T10:00:${String(i).padStart(2, "0")}Z`, kind, prev: null, ...o }) as never;
    const t = lensOfTrail("t.jsonl", [
      r("session_start", { harness: "gnomon/test", surface_hash: "s", cwd: "/x" }, 0),
      r("tool_call", { role: "implement", tool: "read", target: "a.ts", code: 0, bucket: "result", summary: "read a.ts" }, 1),
      r("tool_call", { role: "implement", tool: "bash", target: "npx vitest run", code: 0, bucket: "result", summary: "bash — exit 1", gated: true }, 2),
      r("tool_call", { role: "implement", tool: "task", target: "", code: 0, bucket: "result", summary: "task verifier — 3 tool call(s)" }, 3),
      r("skill_use", { turn: 1, role: "implement", fired: [{ name: "writing-tests", tokens: 10 }], read: { "writing-tests": 1 }, cited_in_reasoning: ["writing-tests"], proposed: [] }, 4),
      r("verify", { command: "npm test", ok: false, passed: false, exit: 1, verdict: "failed" }, 5),
      r("turn", { turn: 1, role: "implement", ...TURN }, 6),
      r("tool_call", { role: "implement", tool: "bash", target: "npx vitest run", code: 0, bucket: "result", summary: "bash — exit 0", gated: true }, 7),
      r("verify", { command: "npm test", ok: true, passed: true, exit: 0 }, 8),
      r("model_call", { model: "m", ms: 1200, code: 0, first_byte_ms: 300, prompt_tokens: 1000, cached_tokens: 900, completion_tokens: 50, window: 10000, est: 4000, trim: { why: "leg", dropped: 3 } }, 9),
      r("turn", { turn: 2, role: "implement", ...TURN }, 10),
    ]);
    expect(t.segments).toHaveLength(2);
    const [a, b] = t.segments;
    expect(a!.tools.bash).toEqual({ n: 1, fail: 1 });
    expect(a!.delegations).toEqual([{ role: "verifier", steps: 3, denied: false }]);
    expect(a!.skills.fired).toEqual(["writing-tests"]);
    expect(a!.skills.cited).toEqual(["writing-tests"]);
    expect(a!.tests[0]!.exit).toBe(1);
    expect(segmentEvidence(a!).test.state).toBe("fail");
    expect(segmentEvidence(a!).verify.state).toBe("fail");
    expect(segmentEvidence(b!).test.state).toBe("pass");
    expect(segmentEvidence(b!).verify.state).toBe("pass");
    expect(quorumOf(Object.fromEntries(Object.entries(segmentEvidence(b!)).map(([k, v]) => [k, v.state])))).toBe("verified");
    expect(t.m).toMatchObject({ calls: 1, prompt: 1000, cached: 900, trims: { leg: 1 }, dropped: 3 });
    expect(t.m.fill).toEqual([0.4]);
  });

  it("keeps work after the last turn record as an unfinished segment", () => {
    const t = lensOfTrail("t.jsonl", [
      { seq: 0, ts: "2026-11-01T10:00:00Z", kind: "tool_call", prev: null, role: "plan", tool: "read", target: "x", code: 0, bucket: "result", summary: "read x" } as never,
    ]);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]!.turn).toBeNull();
  });
});

describe("lensView on a fixture project", () => {
  it("reads specs, requests, runs, evidence, governance and measures from the records, and shows no record text", async () => {
    const { root, p, surface_hash, write } = await project();
    appendFileSync(join(root, ".gnomon", "policy.toml"), '\n[verify]\ncommand = "npm test"\nprotects = ["tests/**"]\ncontract = "pytest"\n');
    mkdirSync(join(root, ".gnomon", "trials"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "trials", "default.toml"), '[trial]\nrole = "implement"\n\n[[task]]\nid = "locate"\nprompt = "where is parse defined?"\ncheck = "test -f src/parse.ts"\n');

    const s = write("2026-11-01T10-00-00-000Z-1");
    s.write("session_start", { surface_hash, harness: "gnomon/test", cwd: root, roles: ["implement", "verifier"] });
    s.write("tool_call", { role: "implement", tool: "bash", target: "npm test", gated: true, code: 0, bucket: "result", summary: "bash — exit 0" });
    s.write("verify", { command: "npm test", ok: true, passed: true, exit: 0, round: 1 });
    s.write("approval", { tool: "bash", decision: "approved", by: "human", interactive: true });
    s.write("model_call", { model: "qwen-local", ms: 900, code: 0, first_byte_ms: 200, prompt_tokens: 500, cached_tokens: 400, completion_tokens: 30, window: 8000, est: 2000 });
    s.write("turn", { turn: 1, role: "implement", ...TURN, input: "SECRET PROMPT TEXT", output: "SECRET MODEL OUTPUT" });
    s.write("tool_call", { role: "implement", tool: "write", target: "../outside", gated: true, code: 2, bucket: "refusal", summary: "write — refused" });
    s.write("verify", { command: "npm test", ok: false, passed: false, exit: 1, verdict: "passed_unverified", protects_changed: ["tests/a.test.ts"] });
    s.write("turn", { turn: 2, role: "implement", ...TURN, model: "cloud-big", endpoint_url: "https://api.example.com/v1/chat/completions" });
    s.write("session_end", { turns: 2, surface_hash });
    const g = write("guard-2026-11-01");
    g.write("session_start", { surface_hash, harness: "gnomon/test", cwd: root, mode: "guard", agent: "claude-code" });
    g.write("guard", { tool: "bash", target: "git push --force", decision: "deny", rule: "bash_deny", pattern: "push", exit: 2 });
    g.write("session_end", {});
    const e = write("eval-2026-11-01");
    e.write("session_start", { surface_hash, harness: "gnomon/test", cwd: root, mode: "eval" });
    e.write("eval_run", { schema: "gnomon.eval/3", mode: "single", report: "r.json", report_sha256: "0".repeat(64), spec: { name: "default", path: ".gnomon/trials/default.toml", sha256: "1".repeat(64) }, role: "implement", arms: {}, pairs: {}, cells: {}, endpoints: {}, status: "complete", meets_thresholds: true });
    e.write("session_end", {});
    // The session snapshot holds the user's request; the lens shows it, clipped, locally.
    const store = resolveSessionStore(loadConfig(root));
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(join(store.dir, "2026-11-01T10-00-00-000Z-1.json"), JSON.stringify({ format: 1, id: "2026-11-01T10-00-00-000Z-1", started: "x", updated: "x", surface_hash, cwd: root, currentRole: "implement", exchanges: [{ turn: 1, role: "implement", input: "add a parse function", output: "ok", model: "m", code: 0, bucket: "result", duration_ms: 1 }] }));

    const v = lensView(p) as Record<string, any>;
    expect(v.coverage).toMatchObject({ sessions: 2, sessions_guarded: 1, sessions_gnomon: 1, turns: 2, turns_with_verify: 2, specs: 2, trails: 3, trails_intact: 3 });
    const [verify, trial] = v.intent.specs;
    expect(verify).toMatchObject({ kind: "verify", command: "npm test", contract: "pytest", protects: ["tests/**"] });
    expect(verify.coverage).toMatchObject({ runs: 1, turns: 2 });
    expect(verify.latest.verdict).toBe("passed_unverified");
    expect(verify.latest.protects_changed).toBe(1);
    expect(trial).toMatchObject({ kind: "trial", name: "default", quorum: "single_source" });
    expect(trial.tasks[0]).toMatchObject({ id: "locate" });
    const reqs = v.intent.request_groups.flatMap((g: any) => g.requests);
    expect(v.intent.request_groups[0]).toMatchObject({ harness: "gnomon", turns: 2, trail: "2026-11-01T10-00-00-000Z-1.jsonl" });
    expect(v.intent.request_groups[0].quorums.verified).toBe(1);
    const asks = reqs.map((r: any) => r.ask);
    expect(asks).toContain("add a parse function");
    expect(v.evidence.verify.verdicts).toEqual({ passed: 1, passed_unverified: 1 });
    expect(v.evidence.tests).toMatchObject({ total: 1, passed: 1 });
    expect(v.runs.harnesses).toMatchObject({ gnomon: { sessions: 1, turns: 2 }, "claude-code (guarded)": { sessions: 1 } });
    expect(v.runs.models["cloud-big"].locality).toBe("cloud");
    expect(v.governance.by_rule.bash_deny).toBe(1);
    expect(v.governance.approvals.approved).toBe(1);
    expect(v.measures.cache_share).toBeCloseTo(0.8);
    expect(v.measures.cost_usd).toBeNull();
    expect(JSON.stringify(v)).not.toContain("SECRET");
    // the first request has a test run and a verify verdict that agree
    const first = reqs.find((r: any) => r.turn === 1);
    expect(first.quorum).toBe("verified");
    const second = reqs.find((r: any) => r.turn === 2);
    expect(second.evidence.verify.state).toBe("partial");

    const run = lensRun(p, "2026-11-01T10-00-00-000Z-1.jsonl") as Record<string, any>;
    expect(run.segments[0].steps[0]).toMatchObject({ tool: "bash", ok: true });
    expect(run.segments[1].steps[0]).toMatchObject({ tool: "write", ok: false });
    expect(lensRun(p, "../../etc/passwd")).toBeNull();
    expect(lensRun(p, "nope.jsonl")).toBeNull();
  });

  it("says nothing was recorded when nothing was, and renders a trail of thousands of records inside a second", async () => {
    const { root, p, surface_hash, write } = await project();
    const empty = lensView(p) as Record<string, any>;
    expect(empty.coverage).toMatchObject({ sessions: 0, specs: 1, specs_passing: 0, trails: 0 });
    expect(empty.measures.cost_usd).toBeNull();
    expect(empty.measures.latency_ms.median).toBeNull();

    const s = write("2026-11-02T10-00-00-000Z-9");
    s.write("session_start", { surface_hash, harness: "gnomon/test", cwd: root });
    for (let i = 1; i <= 800; i++) {
      s.write("tool_call", { role: "implement", tool: "read", target: `f${i}.ts`, gated: false, code: 0, bucket: "result", summary: `read f${i}.ts` });
      s.write("model_call", { model: "m", ms: 100 + i, code: 0, first_byte_ms: 50, prompt_tokens: 100, cached_tokens: 50, completion_tokens: 5, window: 8000, est: 1000 + i });
      s.write("model_call", { model: "m", ms: 100, code: 0, prompt_tokens: 100, cached_tokens: 50, completion_tokens: 5, window: 8000, est: 1000 });
      s.write("tool_call", { role: "implement", tool: "bash", target: "npm test", gated: true, code: 0, bucket: "result", summary: "bash — exit 0" });
      s.write("turn", { turn: i, role: "implement", ...TURN });
    }
    s.write("session_end", {});
    const t0 = performance.now();
    const cold = lensView(p) as Record<string, any>;
    const coldMs = performance.now() - t0;
    expect(cold.coverage.turns).toBe(800);
    expect(coldMs).toBeLessThan(1000);
    const t1 = performance.now();
    lensView(p);
    expect(performance.now() - t1).toBeLessThan(200);
    expect(cold.intent.request_groups[0].requests.length).toBeLessThanOrEqual(150);
    const focused = lensView(p, { focus: "nope.jsonl" }) as Record<string, any>;
    expect(focused.intent.request_groups).toHaveLength(1);
  });
});

describe("GET /api/p/<id>/lens", () => {
  it("is read-only, needs the token, and answers a run by name", async () => {
    const { root, p, surface_hash, write } = await project();
    const s = write("2026-11-03T10-00-00-000Z-3");
    s.write("session_start", { surface_hash, harness: "gnomon/test", cwd: root });
    s.write("turn", { turn: 1, role: "implement", ...TURN });
    s.write("session_end", {});
    const dash = await startDashboard({ projects: [p], trustPath: join(root, "no-trust.json"), sourceRoot: null });
    try {
      const get = (path: string, token?: string) =>
        new Promise<{ status: number; body: string }>((ok, bad) => {
          const req = request({ host: "127.0.0.1", port: dash.port, path, headers: { Host: `127.0.0.1:${dash.port}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
          });
          req.on("error", bad);
          req.end();
        });
      const boot = /#k=([A-Za-z0-9_-]+)$/.exec(dash.signInUrl())![1]!;
      const auth = await new Promise<string>((ok, bad) => {
        const req = request({ host: "127.0.0.1", port: dash.port, path: "/auth", method: "POST", headers: { Host: `127.0.0.1:${dash.port}`, "Content-Type": "application/json" } }, (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => ok(JSON.parse(b).token));
        });
        req.on("error", bad);
        req.end(JSON.stringify({ bootstrap: boot }));
      });
      expect((await get(`/api/p/${p.id}/lens`)).status).toBe(401);
      const r = await get(`/api/p/${p.id}/lens`, auth);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).coverage.turns).toBe(1);
      expect((await get(`/api/p/${p.id}/lens/run?name=2026-11-03T10-00-00-000Z-3.jsonl`, auth)).status).toBe(200);
      expect((await get(`/api/p/${p.id}/lens/run?name=../x`, auth)).status).toBe(404);
      expect((await get("/lens.js", auth)).status).toBe(200);
    } finally {
      await dash.close();
    }
  }, 60_000);
});

describe("the lens page, checked without a browser", () => {
  it("registers the lens screen and builds DOM through h(), with no inline script, style or handler string", () => {
    expect(LENS_JS).toMatch(/registerScreen\("lens", "Lens"/);
    expect(LENS_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\("on|\.style\.cssText|<script|<style/);
  });
  it("groups requests by session, collapsing runs of unkept text, and points an empty spec panel at Setup with the [verify] snippet", () => {
    expect(LENS_JS).toMatch(/request_groups/);
    expect(LENS_JS).toMatch(/without kept request text/);
    expect(LENS_JS).toMatch(/gnomon doctor verify/);
    expect(LENS_JS).toMatch(/\[verify\]\\ncommand = /);
    expect(LENS_JS).toMatch(/#\/setup\//);
    expect(LENS_JS).toMatch(/#\/lens\/\$\{/);
  });
  it("a quorum segment is never colour alone: each carries a glyph and a text reading", () => {
    expect(LENS_JS).toMatch(/GLYPH = \{ pass: "✓", fail: "✕", partial: "~", none: "·" \}/);
    expect(LENS_JS).toMatch(/qm-l/);
    expect(LENS_JS).toMatch(/sr-only/);
    expect(LENS_JS).toMatch(/aria-label": "Evidence by kind"/);
  });
  it("every table has column headers with scope and every chart-like bar is a named image", () => {
    expect(LENS_JS).toMatch(/h\("th", \{ scope: "col"/);
    for (const m of LENS_JS.matchAll(/class: "(?:rb|fillbar)"[^}]*/g)) expect(m[0]).toMatch(/role: "img"/);
  });
  it("has no form control, so there is nothing unlabelled, and no pointer-only control", () => {
    expect(LENS_JS).not.toMatch(/h\("(?:input|select|textarea)"/);
    expect(LENS_JS).not.toMatch(/onClick: [^,]*,\s*role: "button"/);
    for (const m of LENS_JS.matchAll(/h\("div", \{[^}]*onClick/g)) throw new Error(`a div with a click handler: ${m[0]}`);
  });
  it("its css sits in one v2 section and only uses colour tokens the contrast test checks", () => {
    expect(APP_CSS).toContain("/* ── v2: lens ── */");
    const lens = APP_CSS.slice(APP_CSS.indexOf("/* ── v2: lens ── */"));
    const checked = new Set(["ink", "muted", "dim", "clay", "allowed", "refused", "ground", "local", "hybrid", "refused-bg", "allowed-bg"]);
    for (const m of lens.matchAll(/(?:^|[^-])color:\s*var\(--([a-z0-9-]+)\)/gm)) expect(checked.has(m[1]!), m[1]).toBe(true);
    expect(lens).toMatch(/prefers-reduced-motion|max-width: 720px/);
  });
});

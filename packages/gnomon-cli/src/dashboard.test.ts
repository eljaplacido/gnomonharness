/**
 * gnomon-cli: `gnomon dashboard` — the server's security, every read endpoint
 * against fixture projects, the action table against its contract, and the
 * real command started, signed into and stopped.
 *
 * The fixture trails are written by gnomon's own AuditTrail, so they chain
 * and verify exactly as a session's would. On master every test here fails:
 * the command, the server and the read model do not exist.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { request, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditTrail, loadConfig, resolveAudit, recomputeManifest } from "gnomon-core";
import { initSurface } from "./init.js";
import {
  knownProjects,
  readmeTestCounts,
  contractClauses,
  harnessSourceRoot,
  PROPERTY_SUITES,
  type DashboardProject,
} from "./dashboard_data.js";
import {
  startDashboard,
  DASHBOARD_ACTIONS,
  ACTION_STATES,
  DASHBOARD_ROUTES,
  DASHBOARD_SCHEMA,
  CSP,
  type DashboardServer,
} from "./dashboard_server.js";
import { parseDashboardArgs, openerFor, DASHBOARD_EXIT } from "./dashboard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CLI = join(HERE, "index.ts");
const made: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

/** A scaffolded project with three trails: a session, a check and a guard decision. */
async function fixtureProject(name: string): Promise<string> {
  const root = join(tmp("gnomon-dash-"), name);
  mkdirSync(root);
  await initSurface({ dir: root });
  const config = loadConfig(root);
  const settings = resolveAudit(config);
  expect(settings.enabled).toBe(true);
  const surface_hash = recomputeManifest(config.gnomonDir).surface_hash;

  const s = new AuditTrail(settings, "2026-11-01T10-00-00-000Z-1");
  s.write("session_start", { surface_hash, harness: "gnomon/test", cwd: root, roles: ["coordinator", "implementor"] });
  s.write("tool_call", { role: "coordinator", tool: "read", target: "README.md", gated: false, code: 0, bucket: "result", summary: "read README.md — 12 lines" });
  s.write("tool_call", { role: "coordinator", tool: "write", target: "src/app.ts", gated: true, code: 2, bucket: "refusal", summary: "write src/app.ts — not permitted for this role" });
  s.write("approval", { tool: "bash", summary: "bash: npm test", decision: "approved", by: "human", interactive: true });
  s.write("tool_call", { role: "implementor", tool: "bash", target: "npm test", gated: true, code: 0, bucket: "result", summary: "bash npm test — exit 0" });
  s.write("turn", {
    turn: 1, role: "implementor", model: "qwen-local", endpoint: "local", endpoint_url: "http://127.0.0.1:11434/api/chat",
    bucket: "result", code: 0, duration_ms: 4200, tool_steps: 3, stop_reason: "answered", usage: { input: 100, output: 20 },
    surface_hash, input: "SECRET PROMPT TEXT", output: "SECRET MODEL OUTPUT",
  });
  s.write("turn", {
    turn: 2, role: "coordinator", model: "cloud-big", endpoint: "cloud", endpoint_url: "https://api.example.com/v1/chat/completions",
    bucket: "refusal", code: 2, duration_ms: 9000, tool_steps: 0, stop_reason: "stall", surface_hash,
  });
  s.write("session_end", { turns: 2, surface_hash });

  const c = new AuditTrail(settings, "check-2026-11-01T11-00-00-000Z-2");
  c.write("session_start", { surface_hash, harness: "gnomon/test", cwd: root, mode: "check" });
  c.write("check", {
    schema: "gnomon.check/1", base: "a".repeat(40), head: "worktree", base_given: "HEAD~1", role: "implementor", surface_hash,
    checks: [{ id: "surface", status: "pass", inspected: 3 }, { id: "verify", status: "fail", inspected: 1 }], exit: 2,
  });
  c.write("session_end", {});

  const g = new AuditTrail(settings, "guard-2026-11-01");
  g.write("session_start", { surface_hash, harness: "gnomon/test", cwd: root, mode: "guard", role: "implementor" });
  g.write("guard", { tool: "bash", target: "git push --force origin master", decision: "deny", rule: "bash_deny", pattern: "push.*--force", role: "implementor", surface_hash, exit: 2 });
  g.write("session_end", {});
  return root;
}

function httpReq(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((ok, bad) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on("error", bad);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function signIn(dash: DashboardServer): Promise<string> {
  const boot = /#k=([A-Za-z0-9_-]+)$/.exec(dash.signInUrl())![1]!;
  const r = await httpReq(dash.port, "/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
  expect(r.status).toBe(200);
  return JSON.parse(r.body).token as string;
}

let rootA: string;
let rootB: string;
let trustPath: string;
let projects: DashboardProject[];
let dash: DashboardServer;
let token: string;
let fakeCli: string;
let marker: string;
const get = async (path: string) => {
  const r = await httpReq(dash.port, path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, json: JSON.parse(r.body) as Record<string, any> };
};
const act = async (name: string, body: unknown) => {
  const r = await httpReq(dash.port, `/api/actions/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: JSON.parse(r.body) as Record<string, any> };
};

beforeAll(async () => {
  rootA = await fixtureProject("alpha");
  rootB = await fixtureProject("beta");
  const store = tmp("gnomon-dash-trust-");
  trustPath = join(store, "trust.json");
  writeFileSync(trustPath, JSON.stringify({ v: 1, entries: [{ root: rootB, surface_hash: "0".repeat(64), grants: [], at: "2026-11-01T00:00:00Z", by: "command:trust" }] }));
  projects = knownProjects({ cwd: join(rootA, ".gnomon"), trustPath });

  // A stand-in CLI, so the spawned-action path runs for real: it lists
  // `doctor` in its --help, answers `doctor --json`, and leaves a marker for
  // anything else, which the 404 test asserts never appears.
  const dir = tmp("gnomon-dash-cli-");
  fakeCli = join(dir, "fake-gnomon.mjs");
  marker = join(dir, "spawned-something-else");
  writeFileSync(
    fakeCli,
    `import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "--help") console.log("gnomon/test\\n\\nCommands:\\n  doctor [--json]\\n    probe\\n\\n  dashboard [--port <n>]\\n");
else if (a[0] === "doctor" && a[1] === "--json") console.log(JSON.stringify({ os: "testos", cwd: process.cwd() }));
else writeFileSync(${JSON.stringify(marker)}, a.join(" "));
`
  );
  dash = await startDashboard({ projects, trustPath, cliEntry: fakeCli, sourceRoot: REPO });
  token = await signIn(dash);
}, 60_000);
afterAll(async () => {
  await dash?.close();
});

// ── security ────────────────────────────────────────────────────────────────

describe("the server's security", () => {
  it("binds 127.0.0.1 and nothing wider", () => {
    expect((dash.server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("refuses a Host that is not this server (DNS rebinding) with 403", async () => {
    for (const host of [`evil.example:${dash.port}`, "127.0.0.1", `127.0.0.1:${dash.port + 1}`, `localhost.evil.example:${dash.port}`]) {
      const r = await httpReq(dash.port, "/", { headers: { Host: host } });
      expect(r.status, host).toBe(403);
    }
    for (const host of [`127.0.0.1:${dash.port}`, `localhost:${dash.port}`]) {
      expect((await httpReq(dash.port, "/", { headers: { Host: host } })).status, host).toBe(200);
    }
  });

  it("requires the bearer token on every API route", async () => {
    for (const path of ["/api/meta", "/api/projects", "/api/setup", `/api/p/${projects[0]!.id}/surface`]) {
      expect((await httpReq(dash.port, path)).status, path).toBe(401);
      expect((await httpReq(dash.port, path, { headers: { Authorization: "Bearer not-the-token-not-the-token" } })).status, path).toBe(401);
    }
    expect((await get("/api/meta")).status).toBe(200);
  });

  it("refuses a foreign Origin and a cross-site fetch, even with the token", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    expect((await httpReq(dash.port, "/api/meta", { headers: { ...auth, Origin: "http://evil.example" } })).status).toBe(403);
    expect((await httpReq(dash.port, "/api/meta", { headers: { ...auth, Origin: `http://127.0.0.1:${dash.port + 1}` } })).status).toBe(403);
    // localhost:3000 is same-SITE as this server, so same-site is refused too.
    for (const site of ["cross-site", "same-site"]) {
      expect((await httpReq(dash.port, "/api/meta", { headers: { ...auth, "Sec-Fetch-Site": site } })).status, site).toBe(403);
    }
    expect((await httpReq(dash.port, "/api/meta", { headers: { ...auth, Origin: `http://127.0.0.1:${dash.port}`, "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
  });

  it("answers no preflight and sends no CORS header on any response", async () => {
    const pre = await httpReq(dash.port, "/api/meta", { method: "OPTIONS", headers: { Origin: `http://127.0.0.1:${dash.port}`, "Access-Control-Request-Method": "GET" } });
    expect(pre.status).toBe(405);
    const responses = [pre, await httpReq(dash.port, "/"), await httpReq(dash.port, "/api/meta", { headers: { Authorization: `Bearer ${token}` } })];
    for (const r of responses) {
      expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
  });

  it("serves a CSP with no inline script or style, and refuses framing", async () => {
    const r = await httpReq(dash.port, "/");
    expect(r.headers["content-security-policy"]).toBe(CSP);
    expect(CSP).not.toContain("unsafe-inline");
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    // and the page itself holds no inline script or style to need one
    expect(r.body).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(r.body).not.toMatch(/\sstyle=|<style/);
  });

  it("a sign-in link works once, and an expired one not at all", async () => {
    const boot = /#k=([A-Za-z0-9_-]+)$/.exec(dash.signInUrl())![1]!;
    const post = () => httpReq(dash.port, "/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(401);

    const brief = await startDashboard({ projects, trustPath, bootstrapTtlMs: 1, sourceRoot: null });
    try {
      const old = /#k=([A-Za-z0-9_-]+)$/.exec(brief.signInUrl())![1]!;
      await new Promise((r) => setTimeout(r, 20));
      const r = await httpReq(brief.port, "/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: old }) });
      expect(r.status).toBe(401);
    } finally {
      await brief.close();
    }
  });

  it("an unknown action is 404 and spawns nothing; a planned one is 409 and spawns nothing", async () => {
    expect((await act("rm.rf", { project: projects[0]!.id })).status).toBe(404);
    expect((await act("shell", { project: projects[0]!.id, argv: ["rm", "-rf", "/"] })).status).toBe(404);
    for (const a of DASHBOARD_ACTIONS.filter((x) => x.state === "planned")) {
      expect((await act(a.name, { project: projects[0]!.id })).status, a.name).toBe(409);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("names projects and trails only by what is on the list or on disk", async () => {
    expect((await get("/api/p/000000000000/surface")).status).toBe(404);
    const id = projects[0]!.id;
    for (const name of ["../../../etc/passwd", "..%2F..%2Fpackage.json", "nope.jsonl"]) {
      expect((await get(`/api/p/${id}/trail?name=${encodeURIComponent(name)}`)).status, name).toBe(404);
    }
    expect((await act("audit.verify", { project: id, trail: "../x.jsonl" })).status).toBe(404);
    for (const path of ["/../package.json", "/index.html", "/dashboard_server.ts", "/fonts/../app.js/x"]) {
      expect((await httpReq(dash.port, path)).status, path).toBe(404);
    }
  });
});

// ── endpoints against fixture projects ─────────────────────────────────────

describe("each endpoint, against fixture projects", () => {
  it("lists the project here and the trust store's roots, nothing else", async () => {
    expect(projects.map((p) => [p.name, p.source])).toEqual([["alpha", "here"], ["beta", "trust"]]);
    const m = await get("/api/meta");
    expect(m.json.schema).toBe(DASHBOARD_SCHEMA);
    expect(m.json.read_only).toBe(true);
    expect(m.json.projects.map((p: DashboardProject) => p.id)).toEqual(projects.map((p) => p.id));
    expect(m.json.actions).toEqual(DASHBOARD_ACTIONS);
  });

  it("/api/projects: counts as recorded, unmetered never folded into zero", async () => {
    const { json } = await get("/api/projects");
    const a = json.projects[0];
    expect(a.trails).toBe(3);
    expect(a.sessions).toBe(1);
    expect(a.tool_calls).toBe(3);
    expect(a.turns.total).toBe(2);
    expect(a.turns.buckets).toEqual({ result: 1, refusal: 1, apparatus_failure: 0 });
    expect(a.turns.stop_reasons).toEqual({ answered: 1, stall: 1 });
    expect(a.tokens.local).toEqual({ in: 100, out: 20, unmetered: 0, turns: 1 });
    expect(a.tokens.cloud).toEqual({ in: 0, out: 0, unmetered: 1, turns: 1 });
    expect(a.mode).toBe("hybrid");
    expect(a.refusals).toEqual({ named: 2, unnamed: 0 });
    expect(a.checks).toEqual({ held: 0, failed: 1, no_verdict: 0 });
    expect(a.trust.status).toBe("default");
    expect(a.surface_hash).toBe(recomputeManifest(join(rootA, ".gnomon")).surface_hash);
    expect(a.ticks).toEqual(["result", "refusal"]);
  });

  it("/surface: the manifest, the trust evaluation and its grants", async () => {
    const { json } = await get(`/api/p/${projects[0]!.id}/surface`);
    const m = recomputeManifest(join(rootA, ".gnomon"));
    expect(json.surface_hash).toBe(m.surface_hash);
    expect(json.sources).toEqual(m.manifest.map((s) => ({ path: s.path, sha256: s.sha256 })));
    expect(json.trust.status).toBe("default");
    expect(json.trust.grants).toEqual([]);
    expect(json.changed_since_commit).toBeNull(); // not a git repository
  });

  it("/sessions and /trail: the flight recorder, metadata only", async () => {
    const id = projects[0]!.id;
    const { json } = await get(`/api/p/${id}/sessions`);
    expect(json.trails.map((t: { mode: string }) => t.mode).sort()).toEqual(["check", "guard", "prompt"]);
    const session = json.trails.find((t: { mode: string }) => t.mode === "prompt");
    expect(session).toMatchObject({ turns: 2, tool_calls: 3, refusals: 1, sealed: true });

    const t = (await get(`/api/p/${id}/trail?name=${encodeURIComponent(session.name)}`)).json;
    expect(t.sealed).toBe(true);
    expect(t.lanes.map((l: { role: string; locality: string; from: string }) => [l.role, l.locality, l.from])).toEqual([
      ["coordinator", "cloud", "record"],
      ["implementor", "local", "record"],
    ]);
    const refused = t.events.find((e: { bucket: string }) => e.bucket === "refusal");
    expect(refused).toMatchObject({ tool: "write", rule: "write_allow", role: "coordinator" });
    // An approval names no role; it belongs to the call it gated.
    expect(t.events.find((e: { kind: string }) => e.kind === "approval")).toMatchObject({ role: "implementor", decision: "approved", by: "human" });
    expect(t.end).toEqual({ stop_reason: "stall", bucket: "refusal", code: 2, duration_ms: 9000 });
    // Recorded text is never served.
    expect(JSON.stringify(t)).not.toMatch(/SECRET/);
  });

  it("/governance: each published rule with what it refused, check verdicts, the chain", async () => {
    const { json } = await get(`/api/p/${projects[0]!.id}/governance`);
    const rule = (r: string) => json.rules.find((x: { rule: string }) => x.rule === r);
    expect(rule("write_allow").refused).toBe(1);
    expect(rule("bash_deny")).toMatchObject({ refused: 1 });
    expect(rule("bash_deny").examples[0]).toMatchObject({ source: "guard", target: "git push --force origin master" });
    expect(rule("network").refused).toBe(0);
    expect(json.rules.map((r: { rule: string }) => r.rule)).not.toContain("error");
    expect(json.approvals).toEqual({ approved: 1, declined: 0 });
    expect(json.checks).toHaveLength(1);
    expect(json.checks[0]).toMatchObject({ exit: 2, base_given: "HEAD~1", head: "worktree" });
    expect(json.audit).toMatchObject({ enabled: true, trails: 3, chain: true, attest_declared: false });
    expect(json.audit.newest.tail.at(-1).kind).toBe("session_end");
  });

  it("/measurements: by locality, by day, by model; spend not recorded", async () => {
    const { json } = await get(`/api/p/${projects[0]!.id}/measurements`);
    expect(json.turns).toBe(2);
    expect(json.by_locality.local).toMatchObject({ turns: 1, in: 100, out: 20, unmetered: 0, answered: 1, median_ms: 4200 });
    expect(json.by_locality.cloud).toMatchObject({ turns: 1, unmetered: 1, median_ms: 9000 });
    expect(json.by_model.map((m: { model: string; locality: string }) => [m.model, m.locality])).toEqual([
      ["qwen-local", "local"],
      ["cloud-big", "cloud"],
    ]);
    expect(json.by_day).toHaveLength(1);
    expect(json.spend.recorded).toBe(false);
    expect(json.recent[1].tokens_in).toBeNull();
  });

  it("/contracts: the recorded suites at their published figures, README's counts, CONTRACTS' clauses", async () => {
    const { json } = await get(`/api/p/${projects[0]!.id}/contracts`);
    expect(json.source.available).toBe(true);
    expect(json.suites.map((s: { id: string }) => s.id)).toEqual(PROPERTY_SUITES.map((s) => s.id));
    for (const s of json.suites) expect(s.matches_published, s.id).toBe(true);
    expect(json.tests.total).toBe(json.tests.typescript + json.tests.rust);
    const sections = json.clauses.map((c: { section: string }) => c.section);
    expect(sections).toContain("1");
    expect(sections).toContain("15");
    expect(json.clauses.find((c: { section: string }) => c.section === "1").fixtures).toEqual([{ path: "conformance/exit_codes.json", exists: true }]);
    expect(json.verify.declared).toBe(false);
  });

  it("/contracts from an install with no source checkout says so instead of guessing", async () => {
    const bare = await startDashboard({ projects, trustPath, sourceRoot: null });
    try {
      const t = await signIn(bare);
      const r = await httpReq(bare.port, `/api/p/${projects[0]!.id}/contracts`, { headers: { Authorization: `Bearer ${t}` } });
      const json = JSON.parse(r.body);
      expect(json.source.available).toBe(false);
      expect(json.suites).toBeUndefined();
    } finally {
      await bare.close();
    }
  });

  it("audit.verify runs the CLI's own check: intact, then broken after an edit", async () => {
    const id = projects[1]!.id;
    const ok = await act("audit.verify", { project: id });
    expect(ok.status).toBe(200);
    expect(ok.json.exit).toBe(0);
    expect(ok.json.trails).toHaveLength(3);
    expect(ok.json.trails.every((t: { ok: boolean; sealed: boolean }) => t.ok && t.sealed)).toBe(true);
    expect(ok.json.trails[0].attestation).toMatchObject({ status: "unsigned", declared: false });

    const dir = join(rootB, ".gnomon-audit");
    const name = readdirSync(dir).find((f) => f.startsWith("2026-"))!;
    const path = join(dir, name);
    writeFileSync(path, readFileSync(path, "utf-8").replace("npm test", "npm tset"));
    const bad = await act("audit.verify", { project: id, trail: name });
    expect(bad.json.exit).toBe(1);
    expect(bad.json.trails[0].ok).toBe(false);
    expect(bad.json.trails[0].broken.length).toBeGreaterThan(0);
  });

  it("setup: doctor.scan spawns `gnomon doctor --json` in the project when the CLI has it", async () => {
    const s = await get(`/api/setup?project=${projects[0]!.id}`);
    expect(s.json.commands).toEqual({ doctor: true, setup: false, proposal: false });
    expect(s.json.declared.roles.length).toBeGreaterThan(0);
    const r = await act("doctor.scan", { project: projects[0]!.id });
    expect(r.json).toMatchObject({ available: true, exit: 0, doctor: { os: "testos" } });
    expect(resolve(r.json.doctor.cwd)).toBe(resolve(projects[0]!.root));
    expect(existsSync(marker)).toBe(false);
  });

  it("setup: a CLI without doctor makes the step say it is not here yet, and runs nothing", async () => {
    const plain = await startDashboard({ projects, trustPath, cliEntry: join(HERE, "no-such-entry.mjs"), sourceRoot: null });
    try {
      const t = await signIn(plain);
      const r = await httpReq(plain.port, "/api/setup", { headers: { Authorization: `Bearer ${t}` } });
      expect(JSON.parse(r.body).commands.doctor).toBe(false);
      const d = await httpReq(plain.port, "/api/actions/doctor.scan", {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ project: projects[0]!.id }),
      });
      expect(JSON.parse(d.body)).toMatchObject({ available: false });
    } finally {
      await plain.close();
    }
  });
});

// ── the contract ────────────────────────────────────────────────────────────

describe("the dashboard contract (CONTRACTS §15, conformance/dashboard.json)", () => {
  const fixture = JSON.parse(readFileSync(join(REPO, "conformance", "dashboard.json"), "utf-8"));
  const contracts = readFileSync(join(REPO, "docs", "CONTRACTS.md"), "utf-8");
  const section = contracts.slice(contracts.indexOf("## 15."));

  it("the action table, its states, the routes and the exit codes are the fixture's", () => {
    expect(fixture.schema).toBe(DASHBOARD_SCHEMA);
    expect(fixture.actions).toEqual(DASHBOARD_ACTIONS.map((a) => ({ name: a.name, argv: [...a.argv], state: a.state })));
    expect(fixture.action_states).toEqual([...ACTION_STATES]);
    expect(fixture.routes).toEqual(JSON.parse(JSON.stringify(DASHBOARD_ROUTES)));
    expect(fixture.exit_codes).toEqual(DASHBOARD_EXIT);
    expect(fixture.csp).toBe(CSP);
  });

  it("CONTRACTS §15 names every action and every state", () => {
    expect(section.length).toBeGreaterThan(100);
    for (const a of DASHBOARD_ACTIONS) expect(section, a.name).toContain(`\`${a.name}\``);
    for (const s of ACTION_STATES) expect(section, s).toContain(`\`${s}\``);
  });

  it("every action's argv starts with a command this CLI dispatches, or one the setup wizard adds", () => {
    const index = readFileSync(join(HERE, "index.ts"), "utf-8");
    const dispatched = new Set([...index.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
    const wizard = new Set(["doctor", "setup"]); // #105 Part I; arriving on feat/setup-wizard
    for (const a of DASHBOARD_ACTIONS) {
      expect(dispatched.has(a.argv[0]) || wizard.has(a.argv[0]), a.name).toBe(true);
    }
  });

  it("the property suites' published figures are the ones scripts/property_suites.mjs holds", () => {
    const script = readFileSync(join(REPO, "scripts", "property_suites.mjs"), "utf-8");
    for (const s of PROPERTY_SUITES) expect(script, s.id).toContain(`${s.id} ${s.published}`);
  });

  it("README's test counts parse by ci.sh's reading, and CONTRACTS' clauses are found", () => {
    const counts = readmeTestCounts(readFileSync(join(REPO, "README.md"), "utf-8"));
    expect(counts).not.toBeNull();
    expect(counts!.total).toBe(counts!.typescript + counts!.rust);
    expect(counts!.typescript).toBe(counts!.core + counts!.cli + counts!.natives + counts!.tui);
    const clauses = contractClauses(contracts);
    expect(clauses.find((c) => c.section === "15")?.fixtures).toContain("conformance/dashboard.json");
    expect(harnessSourceRoot(join(HERE, "dashboard_data.ts"))).toBe(REPO);
  });
});

// ── the command ─────────────────────────────────────────────────────────────

describe("gnomon dashboard, the command", () => {
  it("parses its flags and refuses anything else", () => {
    expect(parseDashboardArgs([])).toEqual({ port: 0, open: true, help: false });
    expect(parseDashboardArgs(["--port", "4890", "--no-open", "--dir", "x"])).toEqual({ port: 4890, open: false, dir: "x", help: false });
    expect(typeof parseDashboardArgs(["--port", "99999"])).toBe("string");
    expect(typeof parseDashboardArgs(["--host", "0.0.0.0"])).toBe("string");
    expect(typeof parseDashboardArgs(["--port"])).toBe("string");
  });

  it("opens the browser with each OS's own opener, never through a shell", () => {
    const u = "http://127.0.0.1:1/#k=x";
    expect(openerFor("darwin", u)).toEqual({ cmd: "open", args: [u] });
    expect(openerFor("linux", u)).toEqual({ cmd: "xdg-open", args: [u] });
    expect(openerFor("win32", u)).toEqual({ cmd: "rundll32", args: ["url.dll,FileProtocolHandler", u] });
  });

  it("is loaded lazily: index.ts imports it only from its own case", () => {
    const index = readFileSync(join(HERE, "index.ts"), "utf-8");
    expect(index).not.toMatch(/^import[^;]*from "\.\/dashboard/m);
    expect(index).toMatch(/await import\("\.\/dashboard\.js"\)/);
  });

  // From the checkout, so `--import tsx` resolves; the project is --dir.
  const run = (args: string[], cwd: string) =>
    spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd,
      env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("smoke: starts, prints a one-use link, serves the page and the API, stops on a signal", async () => {
    const child = run(["dashboard", "--no-open", "--dir", rootA], REPO);
    let out = "";
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const url = await new Promise<string>((ok, bad) => {
      const t = setTimeout(() => bad(new Error(`no URL printed: ${out}${err}`)), 30_000);
      child.stdout.on("data", (d) => {
        out += d;
        const m = /http:\/\/127\.0\.0\.1:(\d+)\/#k=[A-Za-z0-9_-]+/.exec(out);
        if (m) {
          clearTimeout(t);
          ok(m[0]);
        }
      });
    });
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    try {
      const port = Number(/:(\d+)\//.exec(url)![1]);
      const page = await httpReq(port, "/");
      expect(page.status).toBe(200);
      expect(page.body).toContain('<script type="module" src="/app.js">');
      for (const path of DASHBOARD_ROUTES.static) expect((await httpReq(port, path)).status, path).toBe(200);
      const boot = /#k=(.+)$/.exec(url)![1]!;
      const auth = await httpReq(port, "/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
      const tok = JSON.parse(auth.body).token;
      const meta = JSON.parse((await httpReq(port, "/api/meta", { headers: { Authorization: `Bearer ${tok}` } })).body);
      expect(meta.projects[0].root).toBe(projects[0]!.root);
      expect(out).toContain("read-only");
    } finally {
      child.kill("SIGTERM");
    }
    const code = await exited;
    // Windows has no catchable SIGTERM: the child is killed, not stopped.
    if (process.platform !== "win32") expect(code).toBe(DASHBOARD_EXIT.stopped);
  }, 60_000);

  it("exits 4 when the port is taken", async () => {
    const blocker = createHttpServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const child = run(["dashboard", "--no-open", "--port", String(port), "--dir", rootA], REPO);
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      expect(code, err).toBe(DASHBOARD_EXIT.port_unavailable);
      expect(err).toMatch(/cannot listen/);
    } finally {
      blocker.close();
    }
  }, 60_000);

  it("exits 1 on a usage error, starting nothing", async () => {
    const child = run(["dashboard", "--host", "0.0.0.0"], REPO);
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    expect(code).toBe(DASHBOARD_EXIT.usage);
  }, 60_000);
});

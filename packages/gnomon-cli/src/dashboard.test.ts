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
import { spawn, spawnSync } from "node:child_process";
import { request, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditTrail, loadConfig, resolveAudit, recomputeManifest, listEndpoints, credentialsPath } from "gnomon-core";
import { initSurface } from "./init.js";
import {
  knownProjects,
  summarizeTrail,
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
  ACTION_CONFIRMS,
  DASHBOARD_ROUTES,
  DASHBOARD_SCHEMA,
  CSP,
  type DashboardServer,
} from "./dashboard_server.js";
import { CHOICE_KEYS } from "./dashboard_actions.js";
import { parseDashboardArgs, openerFor, cliEntryFor, DASHBOARD_EXIT } from "./dashboard.js";

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

/** The digest the stand-in setup proposes, and insists on under --yes. */
const FAKE_DIGEST = "d".repeat(64);

/**
 * A stand-in CLI, so every spawned action runs for real through the server:
 * it logs each invocation (argv, cwd, stdin, and whether the stdin value is
 * anywhere in its environment) to `log`, answers the commands the dashboard
 * runs the way their --json contracts say, and leaves a `marker` for anything
 * else, which the tests assert never appears.
 */
function writeFakeCli(dir: string, help = ["setup", "doctor", "key", "endpoint", "trust", "check", "dashboard"]) {
  const entry = join(dir, "fake-gnomon.mjs");
  const log = join(dir, "spawns.jsonl");
  const marker = join(dir, "spawned-something-else");
  writeFileSync(
    entry,
    `import { appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
const a = process.argv.slice(2);
const flag = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const out = (o) => process.stdout.write(JSON.stringify(o));
if (a[0] === "--help") {
  console.log("gnomon/test\\n\\nCommands:\\n" + ${JSON.stringify(help)}.map((c) => "  " + c + " [--json]\\n    what it does\\n").join("\\n"));
  process.exit(0);
}
let stdin = null;
if (a[0] === "key") { try { stdin = readFileSync(0, "utf-8"); } catch { stdin = ""; } }
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: a, cwd: process.cwd(), stdin, stdin_in_env: stdin ? Object.values(process.env).some((v) => v && v.includes(stdin.trim())) : false }) + "\\n");
if (a[0] === "doctor") { out({ schema: "gnomon.doctor/1", os: "testos", cwd: process.cwd(), exit: 0 }); process.exit(0); }
if (a[0] === "setup") {
  const tag = flag("--pull") || flag("--model");
  const r = { schema: "gnomon.setup/1", dir: flag("--dir"), catalog: { as_of: "2026-11", label: "test" }, local: tag ? { tag, runtime: "ollama", installed: true, small: tag } : null,
    pull: null, speed: null, cloud: null, mode: null, hybrid_control: null, steps: [], next: [], exit: 4,
    proposal: { fresh: false, files: [{ path: "roles.toml", action: "modify", diff: ['- model = "old"', '+ model = "new"'] }], facts_file: ".gnomon-setup.json", applied: false, digest: ${JSON.stringify(FAKE_DIGEST)} } };
  if (flag("--model") === "nothing:0") { r.proposal = null; r.why = "No model to set up."; out(r); process.exit(4); }
  if (flag("--pull")) {
    for (const s of ["pulling manifest", "pulling 4a1b 50%", "success"]) process.stderr.write("    " + s + "\\n");
    if (tag === "slow:1") await new Promise((ok) => setTimeout(ok, 1500));
    r.pull = { tag, command: "ollama pull " + tag, status: "pulled" };
  }
  if (a.includes("--speed-check")) r.speed = { model: tag, runtime: "ollama", genTps: 42.5, prefillTps: 900, loadS: 3.2, source: "server" };
  if (a.includes("--yes")) {
    // A file beside this script stands for a surface edited after the review.
    const now = existsSync(${JSON.stringify(join(dir, "moved"))}) ? "e".repeat(64) : ${JSON.stringify(FAKE_DIGEST)};
    if (flag("--expect-proposal") !== now) { r.exit = 3; r.why = "The change is not the one that was reviewed."; out(r); process.exit(3); }
    r.proposal.applied = true; r.exit = 0; out(r); process.exit(0);
  }
  out(r); process.exit(4);
}
if (a[0] === "key" && a[1] === "set") { console.log("Stored " + a[2] + " in /fake/credentials.json (mode 0600)."); process.exit(stdin && stdin.trim() ? 0 : 1); }
if (a[0] === "trust") { console.log(a[1] === "grant" ? "Trusted." : "Revoked 1 trusted surface."); process.exit(0); }
if (a[0] === "endpoint" && a[1] === "test") { console.log(a[2] + ": ok"); process.exit(0); }
if (a[0] === "check") { out({ schema: "gnomon.check/1", base: "b".repeat(40), head: "worktree", role: "implementor", surface_hash: "", checks: [{ id: "surface", status: "pass", inspected: 1 }], exit: 0 }); process.exit(0); }
writeFileSync(${JSON.stringify(marker)}, a.join(" "));
`
  );
  const spawns = (): Array<{ argv: string[]; cwd: string; stdin: string | null; stdin_in_env: boolean }> =>
    existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { entry, log, marker, spawns, moved: join(dir, "moved") };
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
/** A POST as the page sends it: the token, JSON, and this server's Origin. */
const postAction = async (d: DashboardServer, tok: string, name: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await httpReq(d.port, `/api/actions/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Origin: `http://127.0.0.1:${d.port}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: JSON.parse(r.body) as Record<string, any>, raw: r.body };
};
const act = (name: string, body: unknown) => postAction(dash, token, name, body);

beforeAll(async () => {
  rootA = await fixtureProject("alpha");
  rootB = await fixtureProject("beta");
  const store = tmp("gnomon-dash-trust-");
  trustPath = join(store, "trust.json");
  writeFileSync(trustPath, JSON.stringify({ v: 1, entries: [{ root: rootB, surface_hash: "0".repeat(64), grants: [], at: "2026-11-01T00:00:00Z", by: "command:trust" }] }));
  projects = knownProjects({ cwd: join(rootA, ".gnomon"), trustPath });

  const fake = writeFakeCli(tmp("gnomon-dash-cli-"));
  fakeCli = fake.entry;
  marker = fake.marker;
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
    const planned = DASHBOARD_ACTIONS.filter((x) => x.state === "planned");
    expect(planned.map((a) => a.name)).toEqual(["init", "guard.install"]);
    for (const a of planned) {
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
    expect(m.json.read_only).toBe(false);
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

  it("refusals land on the published rule the shared reader reads off them; only what no rule names is apart", () => {
    const at = (seq: number, tool: string, summary: string) => ({ kind: "tool_call", seq, ts: "2026-11-01T10:00:00Z", role: "plan", tool, target: "", bucket: "refusal", code: 2, summary });
    const t = summarizeTrail("t.jsonl", [
      at(1, "write", "write — not available to this role"),
      at(2, "read", "read — malformed arguments (Unexpected token)"),
      at(3, "webfetch", "webfetch — file: refused"),
      at(4, "webfetch", "webfetch https://example.com — refused (network disabled)"),
      at(5, "bash", "bash — denied"),
      at(6, "task", "task — refused (implement not in task_allow)"),
    ] as never, 0);
    expect(t.refusals.map((r) => r.rule)).toEqual(["tools", "malformed", "url", "network", null, null]);
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
    expect(sections).toContain("17");
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

  it("setup: doctor.scan spawns `gnomon doctor --json --dir ROOT` in the project when the CLI has it", async () => {
    const s = await get(`/api/setup?project=${projects[0]!.id}`);
    expect(s.json.commands).toEqual({ doctor: true, setup: true, key: true, endpoint: true, trust: true, check: true });
    expect(s.json.declared.roles.length).toBeGreaterThan(0);
    expect(s.json.has_surface).toBe(true);
    // What the cloud step offers comes from setup's own presets and catalog.
    expect(s.json.cloud_presets.map((p: { key: string }) => p.key).sort()).toEqual(["opencode-go", "opencode-zen", "openrouter"]);
    expect(s.json.catalog).toMatchObject({ as_of: expect.any(String) });
    const r = await act("doctor.scan", { project: projects[0]!.id });
    expect(r.json).toMatchObject({ available: true, exit: 0, doctor: { os: "testos" } });
    expect(resolve(r.json.doctor.cwd)).toBe(resolve(projects[0]!.root));
    expect(r.json.command).toBe(`gnomon doctor --json --dir ${projects[0]!.root}`);
    expect(existsSync(marker)).toBe(false);
  });

  it("setup: a CLI without doctor makes the step say it is not here yet, and runs nothing", async () => {
    const plain = await startDashboard({ projects, trustPath, cliEntry: join(HERE, "no-such-entry.mjs"), sourceRoot: null });
    try {
      const t = await signIn(plain);
      const r = await httpReq(plain.port, "/api/setup", { headers: { Authorization: `Bearer ${t}` } });
      expect(JSON.parse(r.body).commands.doctor).toBe(false);
      const d = await postAction(plain, t, "doctor.scan", { project: projects[0]!.id });
      expect(d.json).toMatchObject({ available: false });
      // Any other spawned action says the build lacks it, and runs nothing.
      const c = await postAction(plain, t, "check.run", { project: projects[0]!.id, rev: "HEAD" });
      expect(c.status).toBe(409);
      expect(c.json.error).toMatch(/no `gnomon check`/);
    } finally {
      await plain.close();
    }
  });
});

// ── actions ─────────────────────────────────────────────────────────────────

describe("actions: each one is a gnomon command, and one that changes anything asks first", () => {
  const P = "aaaaaaaaaaaa"; // a project with a .gnomon/
  const F = "bbbbbbbbbbbb"; // a project setup has not run in yet
  let d: DashboardServer;
  let tok: string;
  let fake: ReturnType<typeof writeFakeCli>;
  let root: string;
  let fresh: string;
  let endpoint: string;
  const post = (name: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => postAction(d, tok, name, body, headers);
  const count = () => fake.spawns().length;
  const last = () => fake.spawns().at(-1)!;
  /** First request, then the confirmation it asked for. */
  const confirmed = async (name: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const ask = await post(name, body);
    expect(ask.status, ask.raw).toBe(428);
    return post(name, { ...body, ...extra, confirm: ask.json.confirm.nonce });
  };

  beforeAll(async () => {
    root = await fixtureProject("gamma");
    fresh = join(tmp("gnomon-dash-fresh-"), "delta");
    mkdirSync(fresh);
    endpoint = listEndpoints(loadConfig(root))[0]!;
    fake = writeFakeCli(tmp("gnomon-dash-acts-"));
    const ps: DashboardProject[] = [
      { id: P, root, name: "gamma", source: "here", exists: true, hasSurface: true },
      { id: F, root: fresh, name: "delta", source: "trust", exists: true, hasSurface: false },
    ];
    d = await startDashboard({ projects: ps, trustPath, cliEntry: fake.entry, sourceRoot: null });
    tok = await signIn(d);
  }, 60_000);
  afterAll(async () => {
    await d?.close();
  });

  const spawning: Array<[string, Record<string, unknown>]> = [
    ["doctor.scan", {}],
    ["setup.plan", {}],
    ["setup.pull", { tag: "qwen3.6:35b" }],
    ["setup.speed_check", { tag: "qwen3:8b" }],
    ["key.set", { variable: "OPENROUTER_API_KEY" }],
    ["setup.apply", {}],
    ["check.run", { rev: "HEAD~1" }],
    ["trust.grant", {}],
    ["trust.revoke", {}],
  ];

  it("a POST needs this page's Origin, the token, this Host and JSON; anything else is refused before it runs", async () => {
    const before = count();
    for (const [name, params] of spawning) {
      const body = JSON.stringify({ project: P, ...params });
      const base = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Origin: `http://127.0.0.1:${d.port}` };
      const send = (headers: Record<string, string>) => httpReq(d.port, `/api/actions/${name}`, { method: "POST", headers, body });
      const { Origin: _o, ...noOrigin } = base;
      expect((await send(noOrigin)).status, `${name} without Origin`).toBe(403);
      expect((await send({ ...base, Origin: "http://evil.example" })).status, `${name} foreign Origin`).toBe(403);
      expect((await send({ ...base, Origin: `http://localhost:${d.port + 1}` })).status, `${name} other port`).toBe(403);
      expect((await send({ ...base, "Sec-Fetch-Site": "cross-site" })).status, `${name} cross-site`).toBe(403);
      expect((await send({ ...base, Host: `evil.example:${d.port}` })).status, `${name} Host`).toBe(403);
      const { Authorization: _a, ...noToken } = base;
      expect((await send(noToken)).status, `${name} no token`).toBe(401);
      expect((await send({ ...base, "Content-Type": "text/plain" })).status, `${name} not JSON`).toBe(415);
    }
    expect(count()).toBe(before);
    expect(existsSync(fake.marker)).toBe(false);
  });

  it("parameters are typed: a flag, a path, a shell string or a key the action does not take is refused, and nothing runs", async () => {
    const before = count();
    const bad: Array<[string, Record<string, unknown>]> = [
      ["check.run", { rev: "--output=/tmp/x" }],
      ["check.run", { rev: "HEAD; rm -rf /" }],
      ["check.run", {}],
      ["setup.pull", { tag: "-rf" }],
      ["setup.pull", { tag: "qwen3:8b", choices: { model: "qwen3:8b" } }],
      ["setup.plan", { choices: { cloud_endpoint: "file:///etc/passwd" } }],
      ["setup.plan", { choices: { cloud_endpoint: "https://x.example/v1 --yes" } }],
      ["setup.plan", { choices: { mode: "turbo" } }],
      ["setup.plan", { choices: { model: "--yes" } }],
      ["setup.plan", { choices: { argv: ["--yes"] } }],
      ["setup.plan", { argv: ["setup", "--yes"] }],
      ["setup.apply", { digest: "d".repeat(64) }],
      ["key.set", { variable: "lower_case" }],
      ["key.set", { variable: "OPENROUTER_API_KEY", value: "two\nlines" }],
      ["endpoint.test", { endpoint: "not-declared" }],
      ["trust.grant", { dir: "/etc" }],
      ["doctor.scan", { dir: "/" }],
    ];
    for (const [name, params] of bad) {
      const r = await post(name, { project: P, ...params });
      expect(r.status, `${name} ${JSON.stringify(params)}`).toBe(400);
    }
    expect(count()).toBe(before);
  });

  it("an action that asks first runs nothing on the first request: 428, with what it will do", async () => {
    const before = count();
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["setup.pull", { tag: "qwen3.6:35b" }, /Downloads qwen3\.6:35b through Ollama on this machine: ~\d+(\.\d+)? GB/],
      ["key.set", { variable: "OPENROUTER_API_KEY" }, /on stdin/],
      ["trust.grant", {}, /nothing beyond gnomon's defaults|Trusts /],
      ["trust.revoke", {}, /Removes every surface trusted/],
      ["endpoint.test", { endpoint }, /one completion of one token/],
    ];
    for (const [name, params, effect] of cases) {
      const r = await post(name, { project: P, ...params });
      expect(r.status, name).toBe(428);
      expect(r.json.confirm.nonce, name).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(r.json.confirm.command, name).toContain(`--dir ${root}`);
      expect(r.json.confirm.effect.join(" "), name).toMatch(effect);
    }
    // The download states its size from the catalog, the key where it goes.
    expect((await post("setup.pull", { project: P, tag: "qwen3.6:35b" })).json.download_gb).toBeGreaterThan(1);
    expect(count()).toBe(before);
  });

  it("a confirmation runs once, and only the action, project and parameters it was issued for", async () => {
    const before = count();
    const ask = await post("setup.pull", { project: P, tag: "qwen3:8b" });
    // Another tag, another action, another project: refused, and the nonce is spent.
    expect((await post("setup.pull", { project: P, tag: "qwen3:14b", confirm: ask.json.confirm.nonce })).status).toBe(409);
    expect((await post("setup.pull", { project: P, tag: "qwen3:8b", confirm: ask.json.confirm.nonce })).status).toBe(409);
    const ask2 = await post("key.set", { project: P, variable: "OPENROUTER_API_KEY" });
    expect((await post("trust.revoke", { project: P, confirm: ask2.json.confirm.nonce })).status).toBe(409);
    const ask3 = await post("key.set", { project: P, variable: "OPENROUTER_API_KEY" });
    expect((await post("key.set", { project: F, variable: "OPENROUTER_API_KEY", value: "k", confirm: ask3.json.confirm.nonce })).status).toBe(409);
    expect((await post("trust.revoke", { project: P, confirm: "made-up-nonce-made-up-nonce" })).status).toBe(409);
    expect(count()).toBe(before);

    // Expired.
    const brief = await startDashboard({ projects: [{ id: P, root, name: "gamma", source: "here", exists: true, hasSurface: true }], cliEntry: fake.entry, sourceRoot: null, confirmTtlMs: 1 });
    try {
      const t = await signIn(brief);
      const a = await postAction(brief, t, "trust.revoke", { project: P });
      await new Promise((r) => setTimeout(r, 20));
      expect((await postAction(brief, t, "trust.revoke", { project: P, confirm: a.json.confirm.nonce })).status).toBe(409);
    } finally {
      await brief.close();
    }
    expect(count()).toBe(before);
  });

  it("trust.grant states the surface and its grants; a surface that moves before the click is refused, nothing runs", async () => {
    const ask = await post("trust.grant", { project: P });
    expect(ask.json.surface_hash).toBe(recomputeManifest(join(root, ".gnomon")).surface_hash);
    expect(Array.isArray(ask.json.trust.grants)).toBe(true);
    const rolesPath = join(root, ".gnomon", "roles.toml");
    const original = readFileSync(rolesPath, "utf-8");
    writeFileSync(rolesPath, original + "\n# edited after the review\n");
    const before = count();
    const moved = await post("trust.grant", { project: P, confirm: ask.json.confirm.nonce });
    expect(moved.status).toBe(409);
    expect(moved.json.error).toMatch(/surface changed/);
    expect(count()).toBe(before);
    writeFileSync(rolesPath, original);

    const ran = await confirmed("trust.grant", { project: P });
    expect(ran.status).toBe(200);
    expect(last().argv).toEqual(["trust", "grant", "--dir", root]);
    const revoked = await confirmed("trust.revoke", { project: P });
    expect(revoked.json).toMatchObject({ exit: 0, command: `gnomon trust revoke --dir ${root}` });
    expect(last().argv).toEqual(["trust", "revoke", "--dir", root]);
  });

  it("key.set: the key travels once, with the confirmation, and only to the command's stdin", async () => {
    const KEY = "sk-test-DASHBOARD-0123456789";
    const before = count();
    expect((await post("key.set", { project: P, variable: "OPENROUTER_API_KEY", value: KEY })).status).toBe(400);
    const ask = await post("key.set", { project: P, variable: "OPENROUTER_API_KEY" });
    expect(ask.status).toBe(428);
    expect(ask.json.key_store).toBe(credentialsPath());
    // Confirming without the key is refused without spending the confirmation.
    expect((await post("key.set", { project: P, variable: "OPENROUTER_API_KEY", confirm: ask.json.confirm.nonce })).status).toBe(400);
    const ran = await post("key.set", { project: P, variable: "OPENROUTER_API_KEY", value: KEY, confirm: ask.json.confirm.nonce });
    expect(ran.status, ran.raw).toBe(200);
    expect(ran.json.exit).toBe(0);
    expect(ran.raw).not.toContain(KEY);
    const runs = fake.spawns().slice(before);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.argv).toEqual(["key", "set", "OPENROUTER_API_KEY", "--dir", root]);
    expect(runs[0]!.stdin).toBe(KEY);
    expect(runs[0]!.stdin_in_env).toBe(false);
    // Never in an argv, of this spawn or any other.
    for (const s of fake.spawns()) expect(s.argv.join(" ")).not.toContain(KEY);
  });

  it("setup.plan writes nothing and spends nothing: no --yes, no --pull, the choices as flags", async () => {
    const choices = { model: "qwen3:8b", cloud_endpoint: "opencode-go", cloud_model: "glm-5", mode: "hybrid", hybrid_control: "ask" };
    const r = await post("setup.plan", { project: P, choices });
    expect(r.status).toBe(200);
    expect(r.json.exit).toBe(4);
    expect(r.json.json.proposal.digest).toBe(FAKE_DIGEST);
    expect(last().argv).toEqual(["setup", "--json", "--dir", root, "--model", "qwen3:8b", "--cloud-endpoint", "opencode-go", "--cloud-model", "glm-5", "--mode", "hybrid", "--hybrid-control", "ask"]);
    // A custom cloud URL is taken as a URL; a project with no .gnomon/ may be set up.
    const f = await post("setup.plan", { project: F, choices: { cloud_endpoint: "https://llm.example.com/v1/chat/completions", cloud_model: "m-1", cloud_key_env: "EXAMPLE_API_KEY" } });
    expect(f.status).toBe(200);
    expect(last().argv).toEqual(["setup", "--json", "--dir", fresh, "--cloud-endpoint", "https://llm.example.com/v1/chat/completions", "--cloud-model", "m-1", "--cloud-key-env", "EXAMPLE_API_KEY"]);
    // But nothing that needs a surface runs where there is none.
    expect((await post("check.run", { project: F, rev: "HEAD" })).status).toBe(404);
    expect((await post("trust.grant", { project: F })).status).toBe(404);
  });

  it("setup.apply: the confirmation is the diff, and Accept writes exactly it (--yes --expect-proposal DIGEST)", async () => {
    const before = count();
    const ask = await post("setup.apply", { project: P, choices: { model: "qwen3:8b" } });
    expect(ask.status).toBe(428);
    expect(ask.json.report.proposal.files[0]).toMatchObject({ path: "roles.toml", diff: ['- model = "old"', '+ model = "new"'] });
    expect(ask.json.confirm.command).toBe(`gnomon setup --yes --expect-proposal ${FAKE_DIGEST} --json --dir ${root} --model qwen3:8b`);
    // Asking ran setup once, without --yes.
    expect(fake.spawns().slice(before).map((s) => s.argv)).toEqual([["setup", "--json", "--dir", root, "--model", "qwen3:8b"]]);
    const ran = await post("setup.apply", { project: P, choices: { model: "qwen3:8b" }, confirm: ask.json.confirm.nonce });
    expect(ran.json).toMatchObject({ exit: 0, json: { proposal: { applied: true } } });
    expect(last().argv).toEqual(["setup", "--yes", "--expect-proposal", FAKE_DIGEST, "--json", "--dir", root, "--model", "qwen3:8b"]);

    // The surface moved between the review and the click: setup refuses it
    // (exit 3), and the page gets that exit as setup gave it.
    const again = await post("setup.apply", { project: P, choices: { model: "qwen3:8b" } });
    writeFileSync(fake.moved, "");
    try {
      const refused = await post("setup.apply", { project: P, choices: { model: "qwen3:8b" }, confirm: again.json.confirm.nonce });
      expect(refused.json).toMatchObject({ exit: 3, json: { why: expect.stringMatching(/not the one that was reviewed/) } });
    } finally {
      rmSync(fake.moved);
    }

    // Nothing to write: no confirmation is issued at all.
    const none = await post("setup.apply", { project: P, choices: { model: "nothing:0" } });
    expect(none.status).toBe(422);
    expect(none.json.error).toBe("No model to set up.");
    expect(none.json.confirm).toBeUndefined();
  });

  it("setup.pull: the download is a job; its progress is setup's stderr and its result setup's report", async () => {
    const started = await confirmed("setup.pull", { project: P, tag: "qwen3.6:35b" });
    expect(started.status).toBe(202);
    expect(started.json.command).toBe(`gnomon setup --pull qwen3.6:35b --json --dir ${root}`);
    const id = started.json.job.id as string;
    expect((await httpReq(d.port, `/api/jobs/${id}`)).status).toBe(401);
    expect((await httpReq(d.port, `/api/jobs/zzzzzzzzzzzz`, { headers: { Authorization: `Bearer ${tok}` } })).status).toBe(404);
    let job: Record<string, any> = started.json.job;
    for (let i = 0; i < 100 && job.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = JSON.parse((await httpReq(d.port, `/api/jobs/${id}`, { headers: { Authorization: `Bearer ${tok}` } })).body).job;
    }
    expect(job).toMatchObject({ state: "done", exit: 4, result: { pull: { tag: "qwen3.6:35b", status: "pulled" } } });
    expect(job.progress).toContain("    pulling manifest");
    expect(last().argv).toEqual(["setup", "--pull", "qwen3.6:35b", "--json", "--dir", root]);
  });

  it("one action at a time per project: a second one waits for a running download", async () => {
    const started = await confirmed("setup.pull", { project: P, tag: "slow:1" });
    expect(started.status).toBe(202);
    const busy = await post("check.run", { project: P, rev: "HEAD" });
    expect(busy.status).toBe(409);
    expect(busy.json.error).toMatch(/another action is running/);
    for (let i = 0; i < 100; i++) {
      const j = JSON.parse((await httpReq(d.port, `/api/jobs/${started.json.job.id}`, { headers: { Authorization: `Bearer ${tok}` } })).body).job;
      if (j.state === "done") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await post("check.run", { project: P, rev: "HEAD" })).status).toBe(200);
  });

  it("speed check, endpoint test and check each run their one command and answer what it printed", async () => {
    const sp = await post("setup.speed_check", { project: P, tag: "qwen3:8b" });
    expect(sp.json).toMatchObject({ exit: 4, json: { speed: { genTps: 42.5 } } });
    expect(last().argv).toEqual(["setup", "--model", "qwen3:8b", "--speed-check", "--json", "--dir", root]);

    const ask = await post("endpoint.test", { project: P, endpoint });
    expect(ask.json).toMatchObject({ endpoint, url: expect.any(String), local: expect.any(Boolean) });
    expect(ask.json.confirm.effect.join(" ")).toMatch(ask.json.local ? /nothing is billed/ : /billed, a fraction of a cent/);
    const t = await post("endpoint.test", { project: P, endpoint, confirm: ask.json.confirm.nonce });
    expect(t.json).toMatchObject({ exit: 0, output: `${endpoint}: ok\n` });
    expect(last().argv).toEqual(["endpoint", "test", endpoint, "--dir", root]);

    const c = await post("check.run", { project: P, rev: "origin/master" });
    expect(c.json).toMatchObject({ exit: 0, json: { schema: "gnomon.check/1" } });
    expect(last().argv).toEqual(["check", "--base", "origin/master", "--json", "--dir", root]);
    expect(existsSync(fake.marker)).toBe(false);
  });

  it("key.set through the real CLI stores the key in the machine-local store and nowhere the dashboard keeps", async () => {
    const real = await startDashboard({
      projects: [{ id: P, root, name: "gamma", source: "here", exists: true, hasSurface: true }],
      cliEntry: cliEntryFor(CLI),
      sourceRoot: null,
    });
    try {
      const t = await signIn(real);
      const KEY = "sk-real-cli-test-9876543210";
      const ask = await postAction(real, t, "key.set", { project: P, variable: "DASHBOARD_TEST_API_KEY" });
      expect(ask.status).toBe(428);
      const ran = await postAction(real, t, "key.set", { project: P, variable: "DASHBOARD_TEST_API_KEY", value: KEY, confirm: ask.json.confirm.nonce });
      expect(ran.status, ran.raw).toBe(200);
      expect(ran.json.exit, ran.raw).toBe(0);
      expect(ran.raw).not.toContain(KEY);
      expect(ran.json.output).toContain(`Stored DASHBOARD_TEST_API_KEY in ${credentialsPath()}`);
      expect(readFileSync(credentialsPath(), "utf-8")).toContain(KEY);
      // Not in the project, not in its records.
      const files = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
      for (const f of files(root)) expect(readFileSync(f, "utf-8"), f).not.toContain(KEY);
    } finally {
      await real.close();
    }
  }, 120_000);
});

// ── the contract ────────────────────────────────────────────────────────────

describe("the dashboard contract (CONTRACTS §17, conformance/dashboard.json)", () => {
  const fixture = JSON.parse(readFileSync(join(REPO, "conformance", "dashboard.json"), "utf-8"));
  const contracts = readFileSync(join(REPO, "docs", "CONTRACTS.md"), "utf-8");
  // §17 alone: it ends at the next `## ` heading.
  const at17 = contracts.indexOf("## 17.");
  const end17 = contracts.indexOf("\n## ", at17 + 1);
  const section = at17 === -1 ? "" : contracts.slice(at17, end17 === -1 ? undefined : end17);

  it("the action table, its states and confirmations, the routes and the exit codes are the fixture's", () => {
    expect(fixture.schema).toBe(DASHBOARD_SCHEMA);
    expect(fixture.actions).toEqual(DASHBOARD_ACTIONS.map((a) => ({ name: a.name, argv: [...a.argv], state: a.state, confirm: a.confirm })));
    expect(fixture.action_states).toEqual([...ACTION_STATES]);
    expect(fixture.action_confirms).toEqual([...ACTION_CONFIRMS]);
    expect(fixture.choices).toEqual([...CHOICE_KEYS]);
    expect(fixture.routes).toEqual(JSON.parse(JSON.stringify(DASHBOARD_ROUTES)));
    expect(fixture.exit_codes).toEqual(DASHBOARD_EXIT);
    expect(fixture.csp).toBe(CSP);
  });

  it("CONTRACTS §17 names every action, state and confirmation value", () => {
    expect(section.length).toBeGreaterThan(100);
    for (const a of DASHBOARD_ACTIONS) expect(section, a.name).toContain(`\`${a.name}\``);
    for (const s of ACTION_STATES) expect(section, s).toContain(`\`${s}\``);
    for (const c of ACTION_CONFIRMS) expect(section, c).toContain(`\`${c}\``);
    for (const k of CHOICE_KEYS) expect(section, k).toContain(`\`${k}\``);
  });

  it("every action's argv starts with a command this CLI dispatches", () => {
    const index = readFileSync(join(HERE, "index.ts"), "utf-8");
    const dispatched = new Set([...index.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
    for (const a of DASHBOARD_ACTIONS) expect(dispatched.has(a.argv[0]), a.name).toBe(true);
  });

  it("an action that writes, downloads or may spend asks first; only reads and runs-with-no-effect do not", () => {
    const unconfirmed = DASHBOARD_ACTIONS.filter((a) => a.state === "enabled" && a.confirm === "none").map((a) => a.name);
    expect(unconfirmed).toEqual(["audit.verify", "doctor.scan", "setup.plan", "setup.speed_check", "check.run"]);
    // None of those carries --yes, a download, a key or a trust change.
    for (const a of DASHBOARD_ACTIONS.filter((x) => x.confirm === "none")) {
      expect(a.argv, a.name).not.toContain("--yes");
      expect(a.argv, a.name).not.toContain("--pull");
      expect(a.argv[0], a.name).not.toBe("key");
      expect(a.argv[0], a.name).not.toBe("trust");
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
    expect(clauses.find((c) => c.section === "17")?.fixtures).toContain("conformance/dashboard.json");
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

  it("runs actions through the checkout launcher when it was itself started under a TypeScript loader", () => {
    expect(cliEntryFor(CLI)).toBe(join(REPO, "packages", "gnomon-cli", "gnomon.js"));
    expect(cliEntryFor("/usr/lib/node_modules/gnomon-harness/bin/gnomon.mjs")).toBe("/usr/lib/node_modules/gnomon-harness/bin/gnomon.mjs");
  });

  it("smoke, fresh process: sign in, then grant trust and run check through the real CLI, each recorded as the CLI records it", async () => {
    // A project whose surface grants something (approval = "never"), in a
    // git repository so `gnomon check` has a base. The trust store is the
    // test's own XDG_DATA_HOME (vitest.setup.ts), inherited by every child.
    const root = join(tmp("gnomon-dash-smoke-"), "gamma");
    mkdirSync(root);
    await initSurface({ dir: root }); // audit on, as `gnomon init` leaves it
    writeFileSync(join(root, ".gnomon", "policy.toml"), `[approval]\ngate = "never"\n\n[sandbox]\nlevel = "confined"\nnetwork = false\n`);
    const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf-8" });
    git("init", "-q");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "surface");

    const child = run(["dashboard", "--no-open", "--dir", root], REPO);
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
      const boot = /#k=(.+)$/.exec(url)![1]!;
      const auth = await httpReq(port, "/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
      const tok = JSON.parse(auth.body).token as string;
      const meta = JSON.parse((await httpReq(port, "/api/meta", { headers: { Authorization: `Bearer ${tok}` } })).body);
      const id = meta.projects[0].id as string;
      const d = { port } as DashboardServer;

      const ask = await postAction(d, tok, "trust.grant", { project: id });
      expect(ask.status).toBe(428);
      const hash = recomputeManifest(join(root, ".gnomon")).surface_hash;
      expect(ask.json.surface_hash).toBe(hash);
      expect(ask.json.trust.grants.map((g: { key: string }) => g.key)).toContain("approval:never");
      expect(ask.json.confirm.command).toBe(`gnomon trust grant --dir ${root}`);
      const ran = await postAction(d, tok, "trust.grant", { project: id, confirm: ask.json.confirm.nonce });
      expect(ran.status, ran.raw).toBe(200);
      expect(ran.json).toMatchObject({ exit: 0, trusted: true });
      // Recorded the way `gnomon trust grant` records it: the store, and a
      // `trust` record in the project's trail, by the command.
      const trails = join(root, ".gnomon-audit");
      const records = readdirSync(trails).flatMap((f) => readFileSync(join(trails, f), "utf-8").trim().split("\n").map((l) => JSON.parse(l)));
      expect(records.find((r) => r.kind === "trust")).toMatchObject({ decision: "granted", by: "command:trust", surface_hash: hash });

      const check = await postAction(d, tok, "check.run", { project: id, rev: "HEAD" });
      expect(check.status, check.raw).toBe(200);
      expect(check.json.command).toBe(`gnomon check --base HEAD --json --dir ${root}`);
      expect(check.json.json.schema).toBe("gnomon.check/1");
      expect(check.json.exit).toBe(check.json.json.exit);
      expect(out).toContain("changes ask first");
    } finally {
      child.kill("SIGTERM");
    }
    const code = await exited;
    if (process.platform !== "win32") expect(code).toBe(DASHBOARD_EXIT.stopped);
  }, 180_000);

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
      expect(out).toContain("changes ask first");
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

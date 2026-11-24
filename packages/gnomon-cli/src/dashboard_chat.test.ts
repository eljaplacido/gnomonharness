/**
 * gnomon-cli: the dashboard's read-only chat (dashboard_chat.ts, dashboard/chat.js).
 *
 * The model is a fake OpenAI-compatible server on 127.0.0.1 that records every
 * request it gets. A "cloud" endpoint is a host that gnomon classes as remote
 * (`cloud.example.test`); the test redirects that one name to the same fake so
 * nothing real is reached.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { request, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditTrail, auditSurface, loadConfig, resolveAudit, recomputeManifest } from "gnomon-core";
import { initSurface } from "./init.js";
import { knownProjects, type DashboardProject } from "./dashboard_data.js";
import { startDashboard, DASHBOARD_ROUTES, type DashboardServer } from "./dashboard_server.js";
import { BRIEF_MAX_CHARS, CHAT_PANELS, buildBrief, citedPanels, citedRecords, planChat, shapeAnswer } from "./dashboard_chat.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const made: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

// ── a fake model ────────────────────────────────────────────────────────────
interface Seen {
  url: string;
  body: Record<string, any>;
}
let model: Server;
let modelPort: number;
const seen: Seen[] = [];
let reply: (n: number) => { content: string; delayMs?: number } = () => ({ content: "Nothing yet. [projects]" });
beforeAll(async () => {
  model = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(raw || "{}") });
      const r = reply(seen.length);
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: r.content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((ok) => model.listen(0, "127.0.0.1", ok));
  modelPort = (model.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((ok) => model.close(() => ok())));

// The remote name stands in for a cloud host; only it is redirected.
const realFetch = globalThis.fetch;
beforeAll(() => {
  vi.stubGlobal("fetch", (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return realFetch(url.replace("https://cloud.example.test", `http://127.0.0.1:${modelPort}`), init);
  });
});
afterAll(() => vi.unstubAllGlobals());

// ── projects ────────────────────────────────────────────────────────────────
async function project(name: string, edit: (root: string) => void = () => {}): Promise<{ root: string; p: DashboardProject }> {
  const root = join(tmp("gnomon-chat-"), name);
  mkdirSync(root);
  await initSurface({ dir: root });
  edit(root);
  const config = loadConfig(root);
  const settings = resolveAudit(config);
  const surface_hash = recomputeManifest(config.gnomonDir).surface_hash;
  const s = new AuditTrail(settings, "2026-11-01T10-00-00-000Z-1");
  s.write("session_start", { surface_hash, harness: "gnomon/test", cwd: root, roles: ["coordinator"] });
  s.write("tool_call", { role: "coordinator", tool: "write", target: "src/app.ts", gated: true, code: 2, bucket: "refusal", summary: "write src/app.ts: PRIVATE-REFUSAL-TEXT" });
  s.write("turn", { turn: 1, role: "coordinator", model: "m", endpoint: "local", endpoint_url: "http://127.0.0.1:1/api/chat", bucket: "result", code: 0, duration_ms: 100, stop_reason: "answered", usage: { input: 5, output: 2 }, surface_hash });
  s.write("session_end", {});
  const p = knownProjects({ cwd: join(root, ".gnomon"), trustPath: join(tmp("gnomon-chat-trust-"), "t.json") })[0]!;
  return { root, p };
}
const setConfig = (root: string, f: (s: string) => string) => {
  const file = join(root, ".gnomon", "config.toml");
  writeFileSync(file, f(readFileSync(file, "utf-8")));
};
const setRoles = (root: string, f: (s: string) => string) => {
  const file = join(root, ".gnomon", "roles.toml");
  writeFileSync(file, f(readFileSync(file, "utf-8")));
};
/** The default local endpoint, pointed at the fake model. */
const toFake = (root: string) =>
  setConfig(root, (s) => s.replace('url = "http://127.0.0.1:11434/api/chat"\nkind = "ollama"', `url = "http://127.0.0.1:${modelPort}/v1/chat/completions"\nkind = "openai"`));
/** A cloud endpoint the coordinator role uses. */
const withCloud = (root: string) => {
  setConfig(root, (s) => s.replace("[endpoints.zen]", '[endpoints.cloud]\nurl = "https://cloud.example.test/v1/chat/completions"\nkind = "openai"\nprovider = "test"\n\n[endpoints.zen]'));
  setRoles(root, (s) => {
    const at = s.indexOf("[roles.coordinator]");
    const end = s.indexOf("\n[", at + 1);
    const block = s.slice(at, end < 0 ? undefined : end).replace(/^endpoint\s*=.*$/m, "");
    return s.slice(0, at) + block.replace("[roles.coordinator]", '[roles.coordinator]\nendpoint = "cloud"') + (end < 0 ? "" : s.slice(end));
  });
};

// ── the server ──────────────────────────────────────────────────────────────
function http(d: DashboardServer, method: string, path: string, opts: { token?: string; body?: unknown; origin?: boolean } = {}): Promise<{ status: number; json: Record<string, any> }> {
  return new Promise((ok, bad) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: "127.0.0.1",
        port: d.port,
        path,
        method,
        headers: {
          Host: `127.0.0.1:${d.port}`,
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.origin === false ? {} : method === "POST" ? { Origin: `http://127.0.0.1:${d.port}` } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
      }
    );
    req.on("error", bad);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
async function serve(p: DashboardProject, opts: { chatTimeoutMs?: number } = {}) {
  const d = await startDashboard({ projects: [p], trustPath: join(tmp("gnomon-chat-trust-"), "t.json"), sourceRoot: null, ...opts });
  const boot = /#k=([A-Za-z0-9_-]+)$/.exec(d.signInUrl())![1]!;
  const auth = await new Promise<string>((ok, bad) => {
    const req = request({ host: "127.0.0.1", port: d.port, path: "/auth", method: "POST", headers: { Host: `127.0.0.1:${d.port}`, "Content-Type": "application/json" } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => ok(JSON.parse(t).token));
    });
    req.on("error", bad);
    req.end(JSON.stringify({ bootstrap: boot }));
  });
  const path = `/api/p/${p.id}/chat`;
  return {
    d,
    status: () => http(d, "GET", path, { token: auth }),
    ask: (body: unknown, o: { origin?: boolean; token?: string } = {}) => http(d, "POST", path, { token: o.token ?? auth, body, origin: o.origin }),
    close: () => d.close(),
  };
}
const audits = (root: string) => {
  const dir = join(root, ".gnomon-audit");
  return readdirSync(dir).filter((f) => f.startsWith("chat-"));
};

describe("what the chat is told", () => {
  it("the brief is at most 10,000 characters however many records there are, and marks every panel", async () => {
    const { root, p } = await project("big");
    const settings = resolveAudit(loadConfig(root));
    for (let i = 0; i < 40; i++) {
      const t = new AuditTrail(settings, `2026-11-02T10-00-${String(i).padStart(2, "0")}-000Z-${i}`);
      t.write("session_start", { surface_hash: "a".repeat(64), harness: "gnomon/test", cwd: root, roles: ["coordinator"] });
      for (let k = 0; k < 6; k++) t.write("tool_call", { role: "coordinator", tool: "write", target: `src/file${k}.ts`, gated: true, code: 2, bucket: "refusal", summary: "write refused: " + "x".repeat(300) });
      t.write("session_end", {});
    }
    const brief = await buildBrief(p, { text: true, sourceRoot: null });
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    for (const panel of ["projects", "session", "governance", "measurements", "contracts"]) expect(brief, panel).toContain(`## [${panel}]`);
    expect(CHAT_PANELS).toEqual(["projects", "session", "governance", "measurements", "contracts", "lens"]);
  });

  it("a cloud brief is metadata only: refusal text is in the local brief and not in the cloud one", async () => {
    const { p } = await project("text");
    const local = await buildBrief(p, { text: true, sourceRoot: null });
    const cloud = await buildBrief(p, { text: false, sourceRoot: null });
    expect(local).toContain("PRIVATE-REFUSAL-TEXT");
    expect(cloud).not.toContain("PRIVATE-REFUSAL-TEXT");
    expect(cloud).toContain("## [governance]");
  });
});

describe("answers cite the panel they came from", () => {
  it("reads [panel] and [a, b] tokens, and only panels that exist", () => {
    expect(citedPanels("Two refusals [governance]. Local ran most [measurements, session]. Bogus [secrets] and [x].")).toEqual(["governance", "measurements", "session"]);
  });
  it("an answer with no citation is withheld; 'not in the records' is accepted as grounded", () => {
    const bad = shapeAnswer("Probably the bash rule, I think.");
    expect(bad).toMatchObject({ withheld: true, grounded: false, cites: [] });
    expect(bad.answer).toMatch(/without citing a panel/);
    expect(bad.raw).toBe("Probably the bash rule, I think.");
    expect(shapeAnswer("That is not in the records.")).toMatchObject({ withheld: false, grounded: true, not_in_records: true });
    expect(shapeAnswer("<think>hmm</think>One refusal [governance].")).toMatchObject({ answer: "One refusal [governance].", cites: ["governance"] });
  });
});

describe("POST /api/p/<id>/chat against a local endpoint", () => {
  let root: string;
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    const made = await project("local", toFake);
    root = made.root;
    s = await serve(made.p);
  });
  afterAll(() => s.close());

  it("is a pinned route, behind the token and the page's own Origin", async () => {
    expect(DASHBOARD_ROUTES.api).toContain("POST /api/p/<id>/chat");
    expect(DASHBOARD_ROUTES.api).toContain("GET /api/p/<id>/chat");
    expect((await s.ask({ question: "hi" }, { token: "x".repeat(30) })).status).toBe(401);
    const before = seen.length;
    expect((await s.ask({ question: "hi" }, { origin: false })).status).toBe(403);
    expect((await s.ask({ question: "" })).status).toBe(400);
    expect((await s.ask({ question: "x".repeat(2001) })).status).toBe(400);
    expect((await s.ask({ question: "hi", cloud: "yes" })).status).toBe(400);
    expect(seen.length).toBe(before);
  });

  it("says where a question goes before one is asked: a local endpoint, with the model", async () => {
    const r = await s.status();
    expect(r.status).toBe(200);
    expect(r.json.local).toMatchObject({ local: true, endpoint: "local", source: "auto", model: expect.any(String) });
    expect(r.json.local.url).toContain(`127.0.0.1:${modelPort}`);
    expect(r.json.cloud).toBeNull();
    expect(r.json.brief_max_chars).toBe(10_000);
  });

  it("sends a strict extractive prompt and a brief of at most 10,000 characters, with no tools, to the local endpoint", async () => {
    reply = () => ({ content: "One refusal was recorded [governance]; local ran everything [measurements]." });
    const before = seen.length;
    const r = await s.ask({ question: "What was refused?", history: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi [projects]" }] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ local: true, grounded: true, withheld: false, cites: ["governance", "measurements"] });
    expect(r.json.brief_chars).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(seen.length).toBe(before + 1);
    const body = seen.at(-1)!.body;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.stream).toBeFalsy();
    const [system, ...rest] = body.messages as Array<{ role: string; content: string }>;
    expect(system!.role).toBe("system");
    expect(system!.content).toMatch(/Answer only from the BRIEF/);
    expect(system!.content).toMatch(/not in the records/);
    expect(system!.content).toMatch(/Never invent a number/);
    const brief = system!.content.slice(system!.content.indexOf("# BRIEF\n") + 8);
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(brief).toContain("## [governance]");
    expect(rest.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(rest.at(-1)!.content).toBe("What was refused?");
    // A local question leaves no record of its own and writes nothing.
    expect(audits(root)).toEqual([]);
  });

  it("hands the model record ids and keeps only the ids the brief really holds", async () => {
    const TRAIL = "2026-11-01T10-00-00-000Z-1.jsonl";
    reply = () => ({ content: `One session ran [session] {session:${TRAIL}}; also {session:made-up} and {rule:R99}.` });
    const before = seen.length;
    const r = await s.ask({ question: "Which session ran?" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ grounded: true, cites: ["session"], records: [`session:${TRAIL}`] });
    const body = seen.at(-1)!.body;
    expect(seen.length).toBe(before + 1);
    expect(body.tools).toBeUndefined();
    const system = (body.messages as Array<{ content: string }>)[0]!.content;
    expect(system).toContain(`{session:${TRAIL}}`);
    expect(system).toMatch(/Never write an id the BRIEF does not contain/);
    expect(audits(root)).toEqual([]);
  });

  it("citedRecords: ids outside the brief are dropped, in order of first mention", () => {
    const brief = "## [governance]\n{rule:R1} rule R1: 2 refused\n{rule:R2} rule R2: 1 refused";
    expect(citedRecords("R2 {rule:R2} then {rule:R1} {rule:R2} and {rule:R7}", brief)).toEqual(["rule:R2", "rule:R1"]);
    expect(shapeAnswer("Two [governance] {rule:R1}", brief)).toMatchObject({ records: ["rule:R1"] });
    expect(shapeAnswer("Two [governance] {rule:R1}")).not.toHaveProperty("records");
  });

  it("an answer that cites nothing is withheld, with what the model said kept behind a fold", async () => {
    reply = () => ({ content: "Probably the sandbox rule." });
    const r = await s.ask({ question: "Which rule?" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ withheld: true, grounded: false, cites: [], raw: "Probably the sandbox rule." });
    expect(r.json.answer).not.toContain("sandbox");
  });

  it("'not in the records' is a grounded answer", async () => {
    reply = () => ({ content: "The price of a run is not in the records." });
    const r = await s.ask({ question: "What did it cost?" });
    expect(r.json).toMatchObject({ withheld: false, grounded: true, not_in_records: true });
  });

  it("one question at a time per project", async () => {
    reply = () => ({ content: "Slow. [projects]", delayMs: 400 });
    const first = s.ask({ question: "first" });
    await new Promise((r) => setTimeout(r, 100));
    const second = await s.ask({ question: "second" });
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/still being answered/);
    expect((await first).status).toBe(200);
  });

  it("a reply that never comes is a 504 with the clock named, and the next question still works", async () => {
    const made = await project("slow", toFake);
    const slow = await serve(made.p, { chatTimeoutMs: 300 });
    try {
      reply = () => ({ content: "Late. [projects]", delayMs: 2500 });
      const t = Date.now();
      const r = await slow.ask({ question: "anyone there?" });
      expect(r.status).toBe(504);
      expect(r.json.error).toMatch(/did not answer within/);
      expect(Date.now() - t).toBeLessThan(2300);
      reply = () => ({ content: "Here. [projects]" });
      expect((await slow.ask({ question: "again" })).status).toBe(200);
    } finally {
      await slow.close();
    }
  });
});

describe("with no local endpoint", () => {
  it("the status and the question both say how to set one, and nothing is sent", async () => {
    const made = await project("nolocal", (root) => setConfig(root, (c) => c.replace('url = "http://127.0.0.1:11434/api/chat"', 'url = "https://cloud.example.test/v1/chat/completions"').replace('kind = "ollama"', 'kind = "openai"')));
    const s = await serve(made.p);
    try {
      const before = seen.length;
      const st = await s.status();
      expect(st.json.local).toBeNull();
      expect(st.json.why).toMatch(/gnomon setup/);
      expect(st.json.why).toMatch(/\[dashboard\] chat_role/);
      const r = await s.ask({ question: "anything?" });
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ no_endpoint: true, cloud: false });
      expect(r.json.error).toMatch(/gnomon setup/);
      expect(seen.length).toBe(before);
    } finally {
      await s.close();
    }
  });
});

describe("[dashboard] chat_role", () => {
  it("names the role the chat asks, and the surface audit checks the name", async () => {
    const made = await project("role", (root) => {
      toFake(root);
      setConfig(root, (c) => c + '\n[dashboard]\nchat_role = "critique"\n');
    });
    const plan = planChat(loadConfig(made.root));
    expect(plan.local).toMatchObject({ role: "critique", source: "declared", local: true });
    expect(auditSurface(loadConfig(made.root)).filter((x) => x.where.includes("[dashboard]"))).toEqual([]);

    const bad = await project("badrole", (root) => setConfig(root, (c) => c + '\n[dashboard]\nchat_role = "nobody"\n'));
    const problems = auditSurface(loadConfig(bad.root)).filter((x) => x.where.includes("[dashboard] chat_role"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ fatal: false });
    expect(problems[0]!.problem).toMatch(/not a declared role/);
    // A name no role carries falls back to the first local role: the drawer still works.
    expect(planChat(loadConfig(bad.root)).why).toMatch(/not a role this surface declares/);
    // And [dashboard] is a block the auditor knows, so it is not called inert.
    expect(auditSurface(loadConfig(made.root)).some((x) => /not a block this harness reads/.test(x.problem) && x.where.includes("dashboard"))).toBe(false);
  });

  it("a chat_role on a cloud endpoint is not a local endpoint: the drawer asks for the cloud box instead", async () => {
    const made = await project("cloudrole", (root) => {
      toFake(root);
      withCloud(root);
      setConfig(root, (c) => c + '\n[dashboard]\nchat_role = "coordinator"\n');
    });
    const plan = planChat(loadConfig(made.root));
    expect(plan.local).toBeNull();
    expect(plan.cloud).toMatchObject({ role: "coordinator", local: false });
    expect(plan.why).toMatch(/cloud endpoint/);
  });
});

describe("a cloud endpoint, only on an explicit per-question opt-in", () => {
  let root: string;
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    const made = await project("cloud", (r) => {
      toFake(r);
      withCloud(r);
    });
    root = made.root;
    s = await serve(made.p);
  });
  afterAll(() => s.close());

  it("without the box ticked nothing goes to the cloud endpoint", async () => {
    const st = await s.status();
    expect(st.json.cloud).toMatchObject({ local: false, endpoint: "cloud", role: "coordinator" });
    reply = () => ({ content: "Local. [projects]" });
    const r = await s.ask({ question: "local please" });
    expect(r.json).toMatchObject({ local: true, endpoint: "local" });
    expect(audits(root)).toEqual([]);
  });

  it("ticked: the first request sends nothing and answers sent:false with the exact text that would leave", async () => {
    reply = () => ({ content: "Cloud says one refusal [governance]." });
    const before = seen.length;
    const ask = await s.ask({ question: "What was refused?", cloud: true });
    expect(ask.status).toBe(200);
    expect(ask.json.sent).toBe(false);
    expect(seen.length).toBe(before);
    const c = ask.json.confirm;
    expect(ask.json).toMatchObject({ local: false, endpoint: "cloud" });
    expect(c.nonce).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(c.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
    expect(c.chars).toBe(c.messages.reduce((n: number, m: { content: string }) => n + m.content.length, 0));
    expect(c.effect.join(" ")).toMatch(/leaves this machine/);
    expect(c.messages[0].content).not.toContain("PRIVATE-REFUSAL-TEXT");

    // A different question, or a reused nonce, does not ride the confirmation.
    const other = await s.ask({ question: "Something else?", cloud: true, confirm: c.nonce });
    expect(other.status).toBe(409);
    expect(seen.length).toBe(before);

    const fresh = await s.ask({ question: "What was refused?", cloud: true });
    const go = await s.ask({ question: "What was refused?", cloud: true, confirm: fresh.json.confirm.nonce });
    expect(go.status).toBe(200);
    expect(go.json).toMatchObject({ local: false, cites: ["governance"], egress: { recorded: true, chars: fresh.json.confirm.chars } });
    expect(seen.length).toBe(before + 1);
    // What arrived is what was shown.
    expect(JSON.stringify((seen.at(-1)!.body.messages as Array<{ role: string; content: string }>).map((m) => m.content))).toBe(
      JSON.stringify(fresh.json.confirm.messages.map((m: { content: string }) => m.content))
    );
    expect((await s.ask({ question: "What was refused?", cloud: true, confirm: fresh.json.confirm.nonce })).status).toBe(409);
  });

  it("records the egress: the endpoint, the model and the characters sent, in a trail of its own, no text", async () => {
    const files = audits(root);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(root, ".gnomon-audit", files[0]!), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((r) => r.kind)).toEqual(["session_start", "model_call", "session_end"]);
    expect(lines[0]).toMatchObject({ mode: "dashboard_chat" });
    const call = lines[1];
    expect(call).toMatchObject({ endpoint: "cloud", role: "coordinator", code: 0 });
    expect(call.est_body).toBeGreaterThan(500);
    expect(JSON.stringify(lines)).not.toContain("What was refused?");
    expect(JSON.stringify(lines)).not.toContain("PRIVATE-REFUSAL-TEXT");
  });
});

describe("the chat can run nothing", () => {
  it("its server code spawns no process and offers the model no tools", () => {
    const src = readFileSync(join(HERE, "dashboard_chat.ts"), "utf-8");
    expect(src).not.toMatch(/child_process|spawn\(|runCli|execSync|execFile/);
    expect(src).toMatch(/callEndpoint\(target, messages, \[\]/);
  });
});

describe("the page: chat.js", () => {
  const JS = readFileSync(join(HERE, "..", "dashboard", "chat.js"), "utf-8");
  const CSS = readFileSync(join(HERE, "..", "dashboard", "app.css"), "utf-8");
  it("builds nodes with textContent only, sets no inline script or style, and labels its controls", () => {
    expect(JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(JS).not.toMatch(/setAttribute\(["']style|\bstyle=/);
    expect(JS).toMatch(/"aria-label": "Your question about this project's records"/);
    expect(JS).toMatch(/"aria-label": "Close chat"/);
    expect(JS).toMatch(/role: "log"/);
    expect(JS).toMatch(/Escape/);
    expect(JS).toMatch(/aria-expanded/);
    // The cloud box is unticked by default and for each new question.
    expect(JS).toMatch(/st\.cloud = false;/);
  });
  it("registers with app.js through onAfterRender, and its CSS is in its own marked block", () => {
    expect(JS).toMatch(/import \{[^}]*onAfterRender[^}]*\} from "\/app\.js"/);
    expect(JS).toMatch(/onAfterRender\(/);
    const i = CSS.indexOf("/* ── v2: chat ──");
    expect(i).toBeGreaterThan(0);
    expect(CSS.slice(i)).toContain(".chat-drawer");
    expect(CSS.slice(i)).not.toMatch(/(^|[^-])color:\s*var\(--(?!ink|muted|dim|clay|allowed|refused|ground)/m);
  });
});

/**
 * `[endpoints.<name>] max_context_tokens = "auto"`: the window read from the
 * endpoint.
 *
 * C3 (2026-11-04, the root cause of P2G's input-token gap): `[defaults]
 * max_context_tokens = 65536` also governed a hosted model with a 1,000,000
 * token window, and every leg checkpoint trimmed its working context to ~39k.
 * Every server here is a fake on 127.0.0.1; nothing reaches a network.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_WINDOW,
  CONTEXT_SOURCES,
  LISTING_SHAPES,
  WINDOW_PROBE_TIMEOUT_MS,
  windowFromModelList,
  windowFromLlamaProps,
  windowFromOllamaShow,
  windowProbes,
  rememberedWindow,
  forgetContextWindows,
  type WindowHit,
  type WindowMiss,
} from "./context_window.js";
import {
  runAgenticTurn,
  runTask,
  settleContextWindows,
  undeclaredWindowNotes,
  wireOf,
  type WindowHooks,
} from "./prompt_loop.js";
import { auditSurface, loadConfig, resolveContext, resolveUi, routeRole, type GnomonConfig } from "./config.js";
import { DEGRADATIONS } from "./degradation.js";

const REPO = join(__dirname, "..", "..", "..");
const FIXTURE = JSON.parse(readFileSync(join(REPO, "conformance", "endpoint_window.json"), "utf8"));

let servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  forgetContextWindows();
});

type Reply = { status?: number; body: unknown };

/**
 * A fake endpoint. `/models`, `/props` and `/api/show` answer what the test
 * gives them, or 404 like a metering relay; the chat routes answer the script.
 */
async function fake(f: { models?: Reply; props?: Reply; show?: Reply; chat?: Reply[] } = {}) {
  const hits: string[] = [];
  const auth: Array<string | undefined> = [];
  const shown: Array<Record<string, unknown>> = [];
  const chat: Array<Record<string, any>> = [];
  const notFound = { status: 404, body: { error: "not found" } };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").replace(/\?.*$/, "");
      hits.push(`${req.method} ${path}`);
      auth.push(req.headers.authorization);
      let r: Reply;
      if (path.endsWith("/chat/completions") || path === "/api/chat") {
        chat.push(JSON.parse(raw || "{}"));
        const script = f.chat ?? [answer("ok")];
        r = script[Math.min(chat.length - 1, script.length - 1)]!;
      } else if (path.endsWith("/models")) r = f.models ?? notFound;
      else if (path === "/props") r = f.props ?? notFound;
      else if (path === "/api/show") {
        shown.push(JSON.parse(raw || "{}"));
        r = f.show ?? notFound;
      } else r = notFound;
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, url: `${base}/v1/chat/completions`, hits, auth, shown, chat };
}

const answer = (content: string): Reply => ({
  body: { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] },
});
const readCall = (id: string, path: string): Reply => ({
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  },
});
const listing = (entry: Record<string, unknown>): Reply => ({ body: { object: "list", data: [entry] } });

/** A surface whose one role, smol, talks to `url` as model m1. */
function surface(
  url: string,
  o: { endpoint?: string; kind?: "openai" | "ollama"; defaults?: string; role?: string; maxSteps?: number; model?: string; audit?: boolean } = {}
): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-window-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  const kind = o.kind ?? "openai";
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    (o.defaults ? `[defaults]\n${o.defaults}\n\n` : "") +
      (o.audit ? `[audit]\nenabled = true\nrecord = "metadata"\n\n` : "") +
      `[endpoints.target]\nurl = "${url}"\nkind = "${kind}"\n` +
      (kind === "openai" ? "stream = false\n" : "") +
      `${o.endpoint ?? ""}\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "${o.model ?? "m1"}"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ["read"]\nmax_steps = ${o.maxSteps ?? 6}\n${o.role ?? ""}\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`
  );
  writeFileSync(join(root, "x.txt"), "hello\n");
  writeFileSync(join(root, "y.txt"), "world\n");
  return root;
}

const AUTO = `max_context_tokens = "${AUTO_WINDOW}"`;

/** Hooks that collect what settling says, prints and records. */
function hooks(config: GnomonConfig) {
  const said: string[] = [];
  const warned: string[] = [];
  const recs: Array<Record<string, unknown>> = [];
  const h: WindowHooks = {
    ui: { ...resolveUi(config), color: false },
    say: (l) => said.push(l),
    warn: (l) => warned.push(l),
    audit: { write: (kind, fields) => recs.push({ kind, ...fields }) },
  };
  return { h, said, warned, recs };
}

function parse(probe: string, body: unknown, model: string): WindowHit | WindowMiss {
  if (probe === "models") return windowFromModelList(body, model);
  if (probe === "props") return windowFromLlamaProps(body);
  if (probe === "show") return windowFromOllamaShow(body);
  throw new Error(`unknown probe ${probe}`);
}

describe("the listing shapes — conformance/endpoint_window.json", () => {
  it("reads each shape's body to the window it states, from the field it names", () => {
    expect(FIXTURE.shapes.length).toBeGreaterThanOrEqual(LISTING_SHAPES.length);
    for (const s of FIXTURE.shapes) {
      expect(parse(s.probe, s.body, s.model), `${s.shape} ${s.field}`).toEqual({
        tokens: s.tokens,
        shape: s.shape,
        field: s.field,
      });
    }
  });

  it("gives no window for a body that states none, rather than guessing one", () => {
    for (const m of FIXTURE.misses) {
      const r = parse(m.probe, m.body, m.model);
      expect("miss" in r, m._why).toBe(true);
    }
  });

  it("derives the probes from the chat URL, in the order they are tried", () => {
    for (const p of FIXTURE.probes) {
      const got = windowProbes({ url: p.chat, kind: p.kind, model: "m" }).map((q) => `${q.method} ${q.url}`);
      expect(got, p.chat).toEqual(p.requests);
    }
  });

  it("publishes the sources, shapes, timeout and degradation the fixture names, and CONTRACTS.md names them too", () => {
    expect([...CONTEXT_SOURCES]).toEqual(FIXTURE.sources);
    expect([...new Set(FIXTURE.shapes.map((s: { shape: string }) => s.shape))].sort()).toEqual([...LISTING_SHAPES].sort());
    expect(WINDOW_PROBE_TIMEOUT_MS).toBe(FIXTURE.probe_timeout_ms);
    expect(AUTO_WINDOW).toBe(FIXTURE.value);
    expect(Object.keys(DEGRADATIONS)).toContain(FIXTURE.degradation);

    const contracts = readFileSync(join(REPO, "docs", "CONTRACTS.md"), "utf8");
    const at = contracts.indexOf("## 24. Endpoint context window");
    expect(at).toBeGreaterThan(-1);
    const next = contracts.indexOf("\n## ", at + 1);
    const section = contracts.slice(at, next === -1 ? undefined : next);
    for (const source of FIXTURE.sources) expect(section).toContain(`\`${source}\``);
    for (const key of FIXTURE.wire_keys) expect(section).toContain(key);
    for (const s of FIXTURE.shapes) {
      const named = s.field.startsWith("model_info.")
        ? "model_info.<arch>.context_length"
        : s.field === "parameters num_ctx"
          ? "num_ctx"
          : s.field;
      expect(section, s.field).toContain(named);
    }
    expect(section).toContain("context_window_unresolved");
  });
});

describe('max_context_tokens = "auto" against a fake endpoint, one per shape', () => {
  it("opencode: limit.context from /models, and the turn record's wire says where it came from", async () => {
    const { url, hits } = await fake({ models: listing({ id: "m1", limit: { context: 1_000_000, output: 384_000 } }) });
    const config = loadConfig(surface(url, { endpoint: AUTO }));
    const before = routeRole(config, "smol");
    // Unsettled, "auto" trims exactly as an undeclared endpoint does.
    expect(before.target).toMatchObject({ contextTokens: 65536, contextSource: "default", contextAuto: true });

    const { h, said, warned, recs } = hooks(config);
    const route = await settleContextWindows(config, before, h);
    expect(route.target).toMatchObject({ contextTokens: 1_000_000, contextSource: "listing:opencode" });
    expect(resolveContext(config, route.target).max_context_tokens).toBe(1_000_000);
    expect(wireOf(route.target)).toMatchObject({
      max_context_tokens: 1_000_000,
      max_context_tokens_source: "listing:opencode",
    });
    expect(hits).toEqual(["GET /v1/models"]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("1000000");
    expect(said[0]).toContain("limit.context");
    expect(warned).toEqual([]);
    expect(recs).toEqual([]);
  });

  it.each([
    ["openrouter", { id: "m1", context_length: 262_144, top_provider: { context_length: 163_840 } }, 262_144],
    ["openrouter", { id: "m1", top_provider: { context_length: 163_840 } }, 163_840],
    ["vllm", { id: "m1", object: "model", max_model_len: 131_072 }, 131_072],
  ])("%s: %j", async (shape, entry, tokens) => {
    const { url, hits } = await fake({ models: listing(entry) });
    const config = loadConfig(surface(url, { endpoint: AUTO }));
    const route = await settleContextWindows(config, routeRole(config, "smol"), hooks(config).h);
    expect(route.target.contextTokens).toBe(tokens);
    expect(route.target.contextSource).toBe(`listing:${shape}`);
    expect(hits).toEqual(["GET /v1/models"]);
  });

  it("llamacpp: a /models entry with only n_ctx_train is passed over for /props", async () => {
    const { url, hits } = await fake({
      models: listing({ id: "m1", meta: { n_ctx_train: 262_144 } }),
      props: { body: { default_generation_settings: { n_ctx: 32_768 }, total_slots: 1 } },
    });
    const config = loadConfig(surface(url, { endpoint: AUTO }));
    const { h, said } = hooks(config);
    const route = await settleContextWindows(config, routeRole(config, "smol"), h);
    expect(route.target).toMatchObject({ contextTokens: 32_768, contextSource: "listing:llamacpp" });
    expect(hits).toEqual(["GET /v1/models", "GET /props"]);
    expect(said[0]).toContain("default_generation_settings.n_ctx");
  });

  it("ollama: /api/show, where a Modelfile's num_ctx wins over the model's own context_length", async () => {
    const withNumCtx = await fake({
      show: { body: { parameters: "num_ctx 16384\ntemperature 0.6", model_info: { "qwen3.context_length": 40_960 } } },
      chat: [{ body: { message: { role: "assistant", content: "ok" }, done: true } }],
    });
    let config = loadConfig(surface(`${withNumCtx.base}/api/chat`, { kind: "ollama", endpoint: AUTO }));
    let route = await settleContextWindows(config, routeRole(config, "smol"), hooks(config).h);
    expect(route.target).toMatchObject({ contextTokens: 16_384, contextSource: "listing:ollama" });
    expect(withNumCtx.hits).toEqual(["POST /api/show"]);
    expect(withNumCtx.shown[0]).toMatchObject({ model: "m1" });

    const infoOnly = await fake({ show: { body: { model_info: { "qwen3.context_length": 40_960 } } } });
    config = loadConfig(surface(`${infoOnly.base}/api/chat`, { kind: "ollama", endpoint: AUTO }));
    route = await settleContextWindows(config, routeRole(config, "smol"), hooks(config).h);
    expect(route.target).toMatchObject({ contextTokens: 40_960, contextSource: "listing:ollama" });
  });

  it("sends the endpoint's key to the listing, and prints it nowhere", async () => {
    const VAR = "GNOMON_WINDOW_TEST_KEY";
    process.env[VAR] = "sk-window-test-only";
    try {
      const { url, auth } = await fake({ models: { status: 401, body: { error: "unauthorized" } } });
      const config = loadConfig(surface(url, { endpoint: `${AUTO}\napi_key_env = "${VAR}"` }));
      const { h, said, warned, recs } = hooks(config);
      await settleContextWindows(config, routeRole(config, "smol"), h);
      expect(auth[0]).toBe("Bearer sk-window-test-only");
      expect(JSON.stringify({ said, warned, recs })).not.toContain("sk-window-test-only");
      expect(warned[0]).toContain("401");
    } finally {
      delete process.env[VAR];
    }
  });
});

describe("when the endpoint gives no window", () => {
  it("a 404 listing (a metering relay) falls back to [defaults], announced, recorded and marked `default`", async () => {
    const { url, hits } = await fake();
    const config = loadConfig(surface(url, { endpoint: AUTO, defaults: "max_context_tokens = 32768" }));
    const { h, said, warned, recs } = hooks(config);
    const route = await settleContextWindows(config, routeRole(config, "smol"), h);
    expect(route.target).toMatchObject({ contextTokens: 32_768, contextSource: "default" });
    expect(resolveContext(config, route.target).max_context_tokens).toBe(resolveContext(config).max_context_tokens);
    expect(wireOf(route.target)).toMatchObject({ max_context_tokens: 32_768, max_context_tokens_source: "default" });
    expect(hits).toEqual(["GET /v1/models", "GET /props"]);
    expect(said).toEqual([]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/max_context_tokens = "auto" found no window/);
    expect(warned[0]).toContain(`GET ${url.replace("/chat/completions", "/models")} → 404`);
    expect(warned[0]).toContain("[endpoints.target]");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      kind: "degradation",
      id: "context_window_unresolved",
      actual: "[defaults] max_context_tokens = 32768",
    });
    expect((recs[0]!.detail as { probes: string[] }).probes).toHaveLength(2);
  });

  it("an endpoint that does not answer at all falls back the same way", async () => {
    // A port nothing listens on: bound, then closed.
    const { url } = await fake();
    const dead = url;
    const s = servers.pop()!;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
    const config = loadConfig(surface(dead, { endpoint: AUTO }));
    const { h, warned, recs } = hooks(config);
    const route = await settleContextWindows(config, routeRole(config, "smol"), h);
    expect(route.target).toMatchObject({ contextTokens: 65536, contextSource: "default" });
    expect(warned).toHaveLength(1);
    expect(recs.map((r) => r.id)).toEqual(["context_window_unresolved"]);
    // Windows retries a refused localhost connect for about 2 s per probe.
  }, 30_000);

  it("under `gnomon task --json`: said on stderr, carried in the record's degradations and in the trail's wire", async () => {
    const { url, chat } = await fake({ chat: [answer("ok")] });
    const root = surface(url, { endpoint: AUTO, audit: true });
    const err: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let rec;
    try {
      // verbose off is what --json sets.
      rec = await runTask(loadConfig(root), "hi", { role: "smol", yes: true });
    } finally {
      process.stderr.write = write;
    }
    expect(rec.code).toBe(0);
    expect(chat).toHaveLength(1);
    expect(err.join("")).toMatch(/found no window/);
    expect(rec.degradations?.map((d) => d.id)).toEqual(["context_window_unresolved"]);
    const trail = readdirSync(join(root, ".gnomon-audit")).find((f) => f.endsWith(".jsonl"))!;
    const records = readFileSync(join(root, ".gnomon-audit", trail), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const turn = records.find((r) => r.kind === "turn");
    expect(turn.wire).toMatchObject({ max_context_tokens: 65536, max_context_tokens_source: "default" });
    // Announced once and recorded once, though the route was settled twice
    // (by runTask, then by the turn).
    expect(records.filter((r) => r.kind === "degradation")).toHaveLength(1);
    // After session_start, so the trail attributes it.
    const kinds = records.map((r) => r.kind);
    expect(kinds.indexOf("degradation")).toBeGreaterThan(kinds.indexOf("session_start"));
  });
});

describe("the cache", () => {
  it("asks once per endpoint URL and model; a route built afterwards carries the window without asking", async () => {
    const { url, hits } = await fake({ models: listing({ id: "m1", limit: { context: 1_000_000 } }) });
    const config = loadConfig(surface(url, { endpoint: AUTO }));
    const first = hooks(config);
    await settleContextWindows(config, routeRole(config, "smol"), first.h);
    const second = hooks(config);
    const again = await settleContextWindows(config, routeRole(config, "smol"), second.h);
    expect(again.target.contextTokens).toBe(1_000_000);
    expect(hits).toEqual(["GET /v1/models"]);
    expect(first.said).toHaveLength(1);
    expect(second.said).toEqual([]);
    expect(rememberedWindow({ url, kind: "openai", model: "m1" })).toMatchObject({
      tokens: 1_000_000,
      source: "listing:opencode",
    });
    // routeRole alone, no settling: the cached window is already on the target.
    expect(routeRole(config, "smol").target).toMatchObject({ contextTokens: 1_000_000, contextSource: "listing:opencode" });
  });

  it("settles running at once share one request and one note", async () => {
    const { url, hits } = await fake({ models: listing({ id: "m1", limit: { context: 1_000_000 } }) });
    const config = loadConfig(surface(url, { endpoint: AUTO }));
    const { h, said } = hooks(config);
    const routes = await Promise.all([1, 2, 3].map(() => settleContextWindows(config, routeRole(config, "smol"), h)));
    expect(routes.map((r) => r.target.contextTokens)).toEqual([1_000_000, 1_000_000, 1_000_000]);
    expect(hits).toEqual(["GET /v1/models"]);
    expect(said).toHaveLength(1);
  });

  it("remembers a miss too: one round of probes, one warning, one degradation", async () => {
    const { url, hits } = await fake();
    const config = loadConfig(surface(url, { endpoint: AUTO }));
    const { h, warned, recs } = hooks(config);
    await settleContextWindows(config, routeRole(config, "smol"), h);
    await settleContextWindows(config, routeRole(config, "smol"), h);
    expect(hits).toEqual(["GET /v1/models", "GET /props"]);
    expect(warned).toHaveLength(1);
    expect(recs).toHaveLength(1);
  });

  it("asks again for another model at the same endpoint", async () => {
    const { url, hits } = await fake({ models: { body: { data: [
      { id: "m1", limit: { context: 1_000_000 } },
      { id: "m2", context_length: 200_000 },
    ] } } });
    const a = loadConfig(surface(url, { endpoint: AUTO }));
    const b = loadConfig(surface(url, { endpoint: AUTO, model: "m2" }));
    expect((await settleContextWindows(a, routeRole(a, "smol"), hooks(a).h)).target.contextTokens).toBe(1_000_000);
    expect((await settleContextWindows(b, routeRole(b, "smol"), hooks(b).h)).target.contextTokens).toBe(200_000);
    expect(hits).toEqual(["GET /v1/models", "GET /v1/models"]);
  });
});

describe("what an existing surface gets: unchanged", () => {
  it("an endpoint that declares nothing records neither key, and nothing asks it for a listing", async () => {
    const { url, hits } = await fake({ chat: [answer("ok")] });
    const config = loadConfig(surface(url));
    const route = routeRole(config, "smol");
    expect(route.target.contextTokens).toBeUndefined();
    expect(route.target.contextSource).toBeUndefined();
    expect(route.target.contextAuto).toBeUndefined();
    // The wire of a surface that never mentions a window, exactly.
    expect(wireOf(route.target)).toStrictEqual({ stream: false, max_tokens: 0 });
    // Settling a route with no "auto" hands back the same object, unasked.
    expect(await settleContextWindows(config, route, hooks(config).h)).toBe(route);
    const rec = await runTask(config, "hi", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(rec.degradations).toBeUndefined();
    expect(hits).toEqual(["POST /v1/chat/completions"]);
  });

  it("a declared number trims as before and is recorded as `declared`", async () => {
    const { url, hits } = await fake();
    const config = loadConfig(surface(url, { endpoint: "max_context_tokens = 400000" }));
    const route = routeRole(config, "smol");
    expect(resolveContext(config, route.target).max_context_tokens).toBe(400_000);
    expect(wireOf(route.target)).toStrictEqual({
      stream: false,
      max_tokens: 0,
      max_context_tokens: 400_000,
      max_context_tokens_source: "declared",
    });
    expect(await settleContextWindows(config, route, hooks(config).h)).toBe(route);
    expect(hits).toEqual([]);
  });

  it('the surface audit accepts "auto" and still names any other string', async () => {
    const { url } = await fake();
    const ok = auditSurface(loadConfig(surface(url, { endpoint: AUTO })));
    expect(ok.filter((p) => p.problem.includes("max_context_tokens"))).toEqual([]);
    const bad = auditSurface(loadConfig(surface(url, { endpoint: 'max_context_tokens = "big"' })));
    const found = bad.find((p) => p.problem.includes("max_context_tokens"));
    expect(found?.fatal).toBe(false);
    expect(found?.fix).toContain('"auto"');
  });

  it("a remote endpoint on the undeclared default gets a startup note naming the key; local, declared and auto do not", async () => {
    const { url } = await fake();
    const remote = loadConfig(surface("https://relay.example.invalid/v1/chat/completions"));
    const notes = undeclaredWindowNotes(remote, ["smol"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('endpoint "target"');
    expect(notes[0]).toContain("[defaults] max_context_tokens = 65536");
    expect(notes[0]).toContain("[endpoints.target]");
    expect(notes[0]).toContain('"auto"');
    // A note only: the route is the one an undeclared endpoint always got.
    expect(routeRole(remote, "smol").target.contextTokens).toBeUndefined();

    expect(undeclaredWindowNotes(loadConfig(surface(url)), ["smol"])).toEqual([]);
    const declared = loadConfig(surface("https://relay.example.invalid/v1/chat/completions", { endpoint: "max_context_tokens = 1000000" }));
    expect(undeclaredWindowNotes(declared, ["smol"])).toEqual([]);
    const auto = loadConfig(surface("https://relay.example.invalid/v1/chat/completions", { endpoint: AUTO }));
    expect(undeclaredWindowNotes(auto, ["smol"])).toEqual([]);
  });
});

describe("the leg checkpoint, in the loop", () => {
  /** 30 messages of ~2,000 tokens each: a 60k-token working context. */
  const FILLER = 30;
  const opening = () => [
    { role: "system" as const, content: "be brief" },
    { role: "user" as const, content: "read x.txt, then y.txt" },
    ...Array.from({ length: FILLER }, (_, i) => ({
      role: "assistant" as const,
      content: `FILLER-${i} ${"x".repeat(8000)}`,
    })),
  ];
  const fillersIn = (body: Record<string, any>) =>
    (body.messages as Array<{ content?: unknown }>).filter(
      (m) => typeof m.content === "string" && m.content.startsWith("FILLER-")
    ).length;

  /** max_steps = 1, so the second reply lands on a leg checkpoint. */
  async function legTurn(endpoint: string, f: Parameters<typeof fake>[0] = {}) {
    const server = await fake({ ...f, chat: [readCall("c1", "x.txt"), readCall("c2", "y.txt"), answer("done")] });
    const root = surface(server.url, { endpoint, maxSteps: 1, role: "max_steps_total = 4" });
    const config = loadConfig(root);
    const said: string[] = [];
    const turn = await runAgenticTurn(
      { config, exchanges: [], currentRole: "smol" },
      "smol",
      routeRole(config, "smol"),
      opening(),
      {
        approve: async () => true,
        progress: { start() {}, update() {}, stop() {}, print() {} } as never,
        ui: { ...resolveUi(config), color: false, spinner: false },
        say: (l) => said.push(l),
      }
    );
    return { turn, said: said.join("\n"), chat: server.chat, root };
  }

  it("an auto-resolved 1,000,000 window keeps a 60k working context whole; the default trims it", async () => {
    const auto = await legTurn(AUTO, { models: listing({ id: "m1", limit: { context: 1_000_000, output: 384_000 } }) });
    const plain = await legTurn("");

    for (const run of [auto, plain]) {
      expect(run.turn.code).toBe(0);
      expect(run.chat).toHaveLength(3);
      expect(run.said).toContain("(leg 2)");
      // Everything before the checkpoint went out whole.
      expect(fillersIn(run.chat[1]!)).toBe(FILLER);
    }

    // Default: 0.6 x 65536 = 39321 tokens, and the working context is ~60k.
    expect(plain.said).toMatch(/turn grew past the window — dropped \d+/);
    expect(fillersIn(plain.chat[2]!)).toBeLessThan(FILLER);
    expect(fillersIn(plain.chat[2]!)).toBeGreaterThan(0);
    expect(plain.turn.wire?.max_context_tokens).toBeUndefined();

    // Auto: 0.6 x 1,000,000, so nothing is dropped.
    expect(auto.said).not.toMatch(/turn grew past the window/);
    expect(fillersIn(auto.chat[2]!)).toBe(FILLER);
    expect(auto.turn.wire).toMatchObject({ max_context_tokens: 1_000_000, max_context_tokens_source: "listing:opencode" });
  });

  it('an "auto" that found nothing sends the same requests, byte for byte, as an endpoint that declares nothing', async () => {
    const plain = await legTurn("");
    const missed = await legTurn(AUTO); // /models and /props both 404
    // The project root differs between the two runs; as written into JSON on
    // Windows its backslashes are escaped, so both spellings are replaced.
    const norm = (run: { chat: unknown[]; root: string }) =>
      JSON.stringify(run.chat)
        .split(JSON.stringify(run.root).slice(1, -1))
        .join("<root>")
        .split(run.root)
        .join("<root>");
    expect(fillersIn(missed.chat[2]!)).toBeLessThan(FILLER);
    expect(norm(missed)).toBe(norm(plain));
  });
});

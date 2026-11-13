/**
 * Anthropic prompt caching over chat/completions (prompt_cache.ts).
 *
 * A cloud-only Claude Haiku arm read cache_read 0 on every cell: gnomon sent
 * no `cache_control` breakpoint, so Anthropic cached nothing. For an
 * Anthropic-family target the request now carries up to three, in the
 * content-part form LiteLLM forwards; every other endpoint gets the bytes it
 * always got. Every server here is a fake on 127.0.0.1; no request leaves the
 * machine.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_MARKER,
  MAX_CACHE_BREAKPOINTS,
  countCacheBreakpoints,
  isAnthropicModel,
  isAnthropicTarget,
  promptCacheOn,
  promptCacheRefused,
  readCacheControlRefusal,
  refusePromptCache,
  resetPromptCacheRefusals,
  withCacheBreakpoints,
} from "./prompt_cache.js";
import { callEndpoint, callEndpointWithRetry, readUsage, runTask, wireOf, type ChatMessage } from "./prompt_loop.js";
import { readUsageDetail } from "./mediators.js";
import { auditSurface, loadConfig, promptCacheFieldsOf, routeRole, type RouteTarget } from "./config.js";

let servers: Server[] = [];
const roots: string[] = [];
beforeEach(() => resetPromptCacheRefusals());
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  resetPromptCacheRefusals();
});

type Reply = { status?: number; body: unknown };

async function serve(reply: (body: Record<string, any>, n: number) => Reply) {
  const bodies: Record<string, any>[] = [];
  const raws: string[] = [];
  const statuses: number[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      const body = JSON.parse(raw || "{}");
      bodies.push(body);
      const r = reply(body, bodies.length);
      statuses.push(r.status ?? 200);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
    bodies,
    raws,
    statuses,
  };
}

const answer = (content: string, usage?: Record<string, unknown>): Reply => ({
  body: {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  },
});

/** LiteLLM's wording when the provider behind it refuses the field. */
const CACHE_REFUSAL: Reply = {
  status: 400,
  body: {
    error: {
      message:
        "litellm.BadRequestError: OpenAIException - Extra inputs are not permitted, field: 'messages[0].content[0].cache_control'",
      type: "invalid_request_error",
      code: 400,
    },
  },
};

const target = (url: string, extra: Partial<RouteTarget> = {}): RouteTarget => ({
  url,
  model: "claude-haiku-4-5",
  kind: "openai",
  temperature: 0.2,
  top_p: 0.9,
  ...extra,
});

const TOOLS = [
  { type: "function", function: { name: "read", description: "Read a file.", parameters: { type: "object" } } },
  { type: "function", function: { name: "edit", description: "Edit a file.", parameters: { type: "object" } } },
];

const conversation = (): ChatMessage[] => [
  { role: "system", content: "be brief" },
  { role: "user", content: "fix the bug" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", content: "hello", tool_call_id: "c1" },
];

/** Every cache_control marker in a sent body. */
const markers = (b: Record<string, any>): number => countCacheBreakpoints(b.messages ?? [], b.tools ?? []);

describe("which targets are Anthropic-family", () => {
  it("names Claude by model id, with or without a gateway prefix", () => {
    for (const m of [
      "claude-haiku-4-5",
      "claude-sonnet-5-5",
      "anthropic/claude-3.5-sonnet",
      "openrouter/anthropic/claude-opus-4-8",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "bedrock/us.anthropic.claude-sonnet-4-6",
      "anthropic.claude-v2",
      "vertex_ai/claude-opus-5-5",
    ]) {
      expect(isAnthropicModel(m), m).toBe(true);
    }
    for (const m of ["gpt-5", "deepseek-chat", "qwen3.5:122b", "nemotron-3-super:120b", "my-claude-finetune", "glm-5"]) {
      expect(isAnthropicModel(m), m).toBe(false);
    }
  });

  it("takes api.anthropic.com whatever the model id, and never OpenAI, DeepSeek or Ollama's /api/chat", () => {
    expect(isAnthropicTarget({ url: "https://api.anthropic.com/v1/chat/completions", model: "x", kind: "openai" })).toBe(true);
    expect(isAnthropicTarget({ url: "http://127.0.0.1:4000/v1/chat/completions", model: "claude-haiku-4-5", kind: "openai" })).toBe(true);
    expect(isAnthropicTarget({ url: "https://api.openai.com/v1/chat/completions", model: "claude-haiku-4-5", kind: "openai" })).toBe(false);
    expect(isAnthropicTarget({ url: "https://api.deepseek.com/chat/completions", model: "claude-x", kind: "openai" })).toBe(false);
    expect(isAnthropicTarget({ url: "http://127.0.0.1:11434/api/chat", model: "claude-haiku-4-5", kind: "ollama" })).toBe(false);
    expect(isAnthropicTarget({ url: "http://127.0.0.1:8080/v1/chat/completions", model: "qwen3-coder", kind: "openai" })).toBe(false);
  });

  it("opts out with prompt_cache = false, in with true, never on Ollama, and not after a refusal", () => {
    const url = "http://127.0.0.1:4000/v1/chat/completions";
    expect(promptCacheOn(target(url))).toBe(true);
    expect(promptCacheOn(target(url, { promptCache: false }))).toBe(false);
    expect(promptCacheOn(target(url, { model: "my-gateway-alias" }))).toBe(false);
    expect(promptCacheOn(target(url, { model: "my-gateway-alias", promptCache: true }))).toBe(true);
    expect(promptCacheOn(target("http://127.0.0.1:11434/api/chat", { kind: "ollama", promptCache: true }))).toBe(false);
    refusePromptCache(target(url));
    expect(promptCacheRefused(target(url))).toBe(true);
    expect(promptCacheOn(target(url))).toBe(false);
    expect(promptCacheOn(target(url, { promptCache: true }))).toBe(false);
    // Another model behind the same URL is its own question.
    expect(promptCacheOn(target(url, { model: "claude-sonnet-5-5" }))).toBe(true);
  });

  it("reads a refusal only from a 400 that names cache_control", () => {
    expect(readCacheControlRefusal(400, "Extra inputs are not permitted, field: 'messages[0].content[0].cache_control'")).toBe(true);
    expect(readCacheControlRefusal(400, "cache_control: too many breakpoints")).toBe(true);
    expect(readCacheControlRefusal(500, "cache_control")).toBe(false);
    expect(readCacheControlRefusal(400, "max_tokens is too large")).toBe(false);
  });
});

describe("placing the breakpoints", () => {
  const wire = (msgs: ChatMessage[]) => msgs.map((m) => ({ ...m }) as Record<string, unknown>);

  it("marks the system prompt, the last tool and the last message, converting only the strings it marks", () => {
    const msgs = wire(conversation());
    const out = withCacheBreakpoints(msgs, TOOLS);
    expect(out.added).toBe(3);
    expect(out.existing).toBe(0);
    expect(out.messages[0]!.content).toEqual([{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }]);
    // Untouched in between: still strings, still the same objects.
    expect(out.messages[1]).toBe(msgs[1]);
    expect(out.messages[1]!.content).toBe("fix the bug");
    expect(out.messages[2]).toBe(msgs[2]);
    expect(out.messages[3]!.content).toEqual([{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
    expect(out.messages[3]!.tool_call_id).toBe("c1");
    expect(out.tools[0]).toBe(TOOLS[0]);
    expect(out.tools[1]).toEqual({ ...TOOLS[1], cache_control: { type: "ephemeral" } });
    // Nothing it was given was changed.
    expect(msgs[0]!.content).toBe("be brief");
    expect(TOOLS[1]).not.toHaveProperty("cache_control");
    expect(countCacheBreakpoints(out.messages, out.tools)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });

  it("marks the last part of an array, and skips a late system message and an empty reply for the rolling marker", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { role: "user", content: [{ type: "text", text: "q1" }, { type: "text", text: "q2" }] },
      { role: "assistant", content: "" },
      { role: "system", content: "[nudge]" },
    ];
    const out = withCacheBreakpoints(msgs, []);
    expect(out.added).toBe(2);
    expect(out.messages[0]!.content).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b", cache_control: CACHE_MARKER }]);
    expect(out.messages[1]!.content).toEqual([{ type: "text", text: "q1" }, { type: "text", text: "q2", cache_control: CACHE_MARKER }]);
    expect(out.messages[2]).toBe(msgs[2]);
    expect(out.messages[3]).toBe(msgs[3]);
  });

  it("never takes the request past four markers, counting the ones already there", () => {
    const pre = (n: number): Record<string, unknown>[] => [
      { role: "system", content: "sys" },
      ...Array.from({ length: n }, (_, i) => ({
        role: "user",
        content: [{ type: "text", text: `old ${i}`, cache_control: { type: "ephemeral" } }],
      })),
      { role: "user", content: "now" },
    ];
    for (let n = 0; n <= 5; n++) {
      const msgs = pre(n);
      const out = withCacheBreakpoints(msgs, TOOLS);
      expect(out.existing).toBe(n);
      expect(out.added).toBe(Math.max(0, Math.min(3, MAX_CACHE_BREAKPOINTS - n)));
      expect(countCacheBreakpoints(out.messages, out.tools)).toBe(n + out.added);
      if (n <= MAX_CACHE_BREAKPOINTS) expect(countCacheBreakpoints(out.messages, out.tools)).toBeLessThanOrEqual(4);
    }
    // With room for one, the rolling marker on the last message is the one placed.
    const one = withCacheBreakpoints(pre(3), TOOLS);
    expect(one.added).toBe(1);
    expect(one.messages.at(-1)!.content).toEqual([{ type: "text", text: "now", cache_control: CACHE_MARKER }]);
    expect(one.messages[0]!.content).toBe("sys");
  });

  it("adds nothing to a request with nothing to mark", () => {
    const out = withCacheBreakpoints([{ role: "user", content: "" }], []);
    expect(out.added).toBe(0);
    expect(withCacheBreakpoints([], []).added).toBe(0);
  });
});

describe("the request on the wire", () => {
  it("an Anthropic-family target gets three markers in the content-part form", async () => {
    const { url, bodies } = await serve(() => answer("ok"));
    const r = await callEndpoint(target(url), conversation(), TOOLS, 5000);
    expect(r.code).toBe(0);
    const b = bodies[0]!;
    expect(markers(b)).toBe(3);
    expect(b.messages[0].content).toEqual([{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }]);
    expect(b.messages[1].content).toBe("fix the bug");
    expect(b.messages[3].content).toEqual([{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
    expect(b.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(b.tools[0]).not.toHaveProperty("cache_control");
    expect(r.promptCacheRefused).toBeUndefined();
  });

  it("any other target, and an opted-out one, is sent exactly the bytes it was before", async () => {
    const { url, raws, bodies } = await serve(() => answer("ok"));
    await callEndpoint(target(url, { model: "qwen3-coder" }), conversation(), TOOLS, 5000);
    await callEndpoint(target(url, { promptCache: false }), conversation(), TOOLS, 5000);
    for (const raw of raws) expect(raw).not.toContain("cache_control");
    expect(bodies[0]!.messages.map((m: { content: unknown }) => m.content)).toEqual(["be brief", "fix the bug", "", "hello"]);
    // The opted-out Claude request differs from the other only in its model.
    expect(raws[1]!.replace('"claude-haiku-4-5"', '"qwen3-coder"')).toBe(raws[0]);
  });

  it("a 400 naming cache_control is resent once without markers, and none go there again", async () => {
    const { url, bodies, statuses } = await serve((b) => (markers(b) > 0 ? CACHE_REFUSAL : answer("ok")));
    const seen: number[] = [];
    const r = await callEndpoint(target(url), conversation(), TOOLS, 5000, undefined, undefined, (o) => seen.push(o.code));
    expect(r.code).toBe(0);
    expect(r.content).toBe("ok");
    expect(r.promptCacheRefused).toBe(true);
    expect(r.promptCacheRejected).toBeUndefined();
    expect(statuses).toEqual([400, 200]);
    expect(markers(bodies[0]!)).toBe(3);
    expect(markers(bodies[1]!)).toBe(0);
    // Both requests went out, so both were told to the observer.
    expect(seen).toEqual([10, 0]);
    // The rest of the session: no markers, no refused call.
    const again = await callEndpoint(target(url), conversation(), TOOLS, 5000);
    expect(again.promptCacheRefused).toBeUndefined();
    expect(statuses).toEqual([400, 200, 200]);
    expect(markers(bodies[2]!)).toBe(0);
    expect(wireOf(target(url)).prompt_cache).toBeUndefined();
  });

  it("the retry wrapper carries the refusal to the loop and does not resend the refused request itself", async () => {
    const { url, statuses } = await serve((b) => (markers(b) > 0 ? CACHE_REFUSAL : answer("ok")));
    const r = await callEndpointWithRetry(target(url), conversation(), TOOLS, 5000, { attempts: 3, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(r.promptCacheRefused).toBe(true);
    expect(statuses).toEqual([400, 200]);
  });

  it("a 400 that does not name cache_control is not taken for a refusal of the markers", async () => {
    const { url, statuses } = await serve(() => ({ status: 400, body: { error: "prompt is too long" } }));
    const r = await callEndpoint(target(url), conversation(), TOOLS, 5000);
    expect(r.code).not.toBe(0);
    expect(r.promptCacheRefused).toBeUndefined();
    expect(statuses).toEqual([400]);
    expect(promptCacheRefused(target(url))).toBe(false);
  });

  it("the turn record's wire says prompt_cache only for a target that sends the markers", () => {
    expect(wireOf(target("http://127.0.0.1:4000/v1/chat/completions")).prompt_cache).toBe(true);
    expect(wireOf(target("http://127.0.0.1:4000/v1/chat/completions", { promptCache: false }))).not.toHaveProperty("prompt_cache");
    expect(wireOf(target("http://127.0.0.1:4000/v1/chat/completions", { model: "gpt-5" }))).not.toHaveProperty("prompt_cache");
  });
});

describe("cached tokens in the usage report", () => {
  it("reads every spelling of a cache read, and never sums two of them", () => {
    // OpenAI
    expect(readUsageDetail({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } } })).toEqual({ cached: 40 });
    // DeepSeek
    expect(readUsageDetail({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 30 } })).toEqual({ cached: 30 });
    // Anthropic's own fields, as a gateway passes them through
    expect(
      readUsageDetail({ usage: { prompt_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 15 } })
    ).toEqual({ cached: 80, cacheWrite: 15 });
    // LiteLLM: both spellings of the same 80 tokens, counted once
    expect(
      readUsageDetail({
        usage: {
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: 80, cache_creation_tokens: 15 },
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 15,
        },
      })
    ).toEqual({ cached: 80, cacheWrite: 15 });
    // A zero placeholder does not hide a real read
    expect(
      readUsageDetail({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, cache_read_input_tokens: 64 } })
    ).toEqual({ cached: 64 });
    // A cache write alone is not a cache hit
    expect(readUsageDetail({ usage: { prompt_tokens: 100, cache_creation_input_tokens: 90 } })).toEqual({ cacheWrite: 90 });
    expect(readUsageDetail({ usage: { prompt_tokens: 100 } })).toBeUndefined();
  });

  it("reads Anthropic's own input_tokens as the whole prompt, cache included, only without prompt_tokens", () => {
    expect(
      readUsage({ usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 7 } })
    ).toEqual({ input: 95, output: 7, ms: undefined });
    expect(readUsage({ usage: { prompt_tokens: 95, input_tokens: 10, completion_tokens: 7 } })).toEqual({ input: 95, output: 7, ms: undefined });
  });

  it("lands in the turn's cached_tokens, with the writes beside them", async () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 900 },
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 60,
    };
    const { url, bodies } = await serve(() => answer("done", usage));
    const root = surface(url);
    const rec = await runTask(loadConfig(root), "say done", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(markers(bodies[0]!)).toBeGreaterThanOrEqual(2);
    const measured = (rec as unknown as { volatile: { model_calls: Record<string, any> } }).volatile.model_calls;
    expect(measured.cached_tokens).toBe(900);
    expect(measured.cache_write_tokens).toBe(60);
    expect(measured.calls[0].cached_tokens).toBe(900);
    const [turn] = turnRecords(root);
    expect(turn!.wire.prompt_cache).toBe(true);
  });
});

describe("the surface", () => {
  it("prompt_cache is a key an endpoint may carry; a value other than true or false is reported, not fatal", () => {
    const s = (endpoint: Record<string, unknown>) =>
      ({
        gnomonDir: "/nowhere",
        config: { endpoints: { e: { url: "https://x/v1/chat/completions", kind: "openai", ...endpoint } } },
        roles: { r: { model: "m", endpoint: "e" } },
        policy: {},
        profiles: {},
        tools: {},
        system: { content: "", version: "0.1" },
      }) as never;
    expect(auditSurface(s({ prompt_cache: false }))).toEqual([]);
    expect(auditSurface(s({ prompt_cache: true }))).toEqual([]);
    const bad = auditSurface(s({ prompt_cache: "off" }));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.fatal).toBe(false);
    expect(bad[0]!.problem).toMatch(/prompt_cache = "off" is not true or false/);
    expect(promptCacheFieldsOf({ prompt_cache: "off" })).toEqual({});
    expect(promptCacheFieldsOf(undefined)).toEqual({});
  });

  it("routes the declared value onto the target, and nothing when undeclared", () => {
    const url = "http://127.0.0.1:4000/v1/chat/completions";
    expect(routeRole(loadConfig(surface(url)), "smol").target).not.toHaveProperty("promptCache");
    const off = routeRole(loadConfig(surface(url, "prompt_cache = false")), "smol").target;
    expect(off.promptCache).toBe(false);
    expect(promptCacheOn(off)).toBe(false);
  });

  it("an opted-out Claude endpoint runs a whole task without one marker", async () => {
    const { url, raws } = await serve(() => answer("done"));
    const rec = await runTask(loadConfig(surface(url, "prompt_cache = false")), "say done", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(raws.length).toBeGreaterThan(0);
    for (const raw of raws) expect(raw).not.toContain("cache_control");
  });

  it("a refusing gateway costs one refused request, counted on the turn record", async () => {
    const { url, statuses } = await serve((b) => (markers(b) > 0 ? CACHE_REFUSAL : answer("done")));
    const root = surface(url);
    const rec = await runTask(loadConfig(root), "say done", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(statuses).toEqual([400, 200]);
    expect(rec.counters.prompt_cache_refused).toBe(1);
    const [turn] = turnRecords(root);
    expect(turn!.counters.prompt_cache_refused).toBe(1);
  });
});

/** A surface whose one role talks to a Claude model through `url`. */
function surface(url: string, endpoint = "") {
  const root = mkdtempSync(join(tmpdir(), "gnomon-cache-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 4096\n\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n${endpoint}\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "claude-haiku-4-5"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ["read"]\nmax_steps = 4\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`);
  return root;
}

function turnRecords(root: string): Array<Record<string, any>> {
  const dir = join(root, ".gnomon-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .flatMap((e) => readFileSync(join(dir, e.name), "utf-8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === "turn");
}

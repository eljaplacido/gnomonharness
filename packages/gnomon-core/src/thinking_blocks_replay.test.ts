/**
 * A provider's own reasoning objects go back to it in its own shape.
 *
 * OpenRouter asks for `reasoning_details` back unmodified and in order
 * (Anthropic signatures, Gemini's encrypted reasoning); Mistral's reasoning
 * guide says "always replay the full assistant message (including
 * ThinkChunk)"; Gemini 3's thought signature rides on a tool call's
 * `extra_content`; Ollama's /api/chat takes reasoning as `thinking` (all read
 * 2026-11-21). gnomon flattened or dropped each. Every server here is a fake.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callEndpoint, runTask, type ChatMessage } from "./prompt_loop.js";
import { loadConfig } from "./config.js";

const realFetch = globalThis.fetch;
/** A hosted-looking URL for a fake on 127.0.0.1, so the hosted defaults apply. */
function asHosted(localUrl: string): string {
  const local = new URL(localUrl);
  const origin = `https://hosted-${local.port}.example.com`;
  const prev = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    const u: string = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return u.startsWith(origin) ? prev(local.origin + u.slice(origin.length), init) : prev(input, init);
  }) as typeof fetch;
  return origin + local.pathname;
}

let servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Each request gets the next reply: an object is sent as JSON, an array as SSE events. */
async function serve(replies: Array<Record<string, unknown> | Array<Record<string, unknown>>>) {
  const bodies: Record<string, any>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      const reply = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
      if (Array.isArray(reply)) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const e of reply) res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, bodies };
}

function surface(url: string, endpointExtra: string, kind = "openai") {
  const root = mkdtempSync(join(tmpdir(), "gnomon-provider-reasoning-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(join(root, ".gnomon", "config.toml"), `[endpoints.target]\nurl = "${url}"\nkind = "${kind}"\n${endpointExtra}\n`);
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["read"]\nmax_steps = 4\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, "x.txt"), "hello\n");
  return root;
}

const readCall = { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } };
const done = { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] };
const assistant = (b: Record<string, any>) =>
  (b.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant")!;

const sig = "CAQSnDEKEAgUGAI4AUIIdGhpbmtpbmc=";
const blocks = [
  { type: "thinking", thinking: "", signature: sig },
  { type: "redacted_thinking", data: "opaque==" },
];
const delta = (d: Record<string, unknown>) => ({ choices: [{ index: 0, delta: d }] });
const toolStream = (extra: Record<string, unknown> = {}) => [
  delta({ role: "assistant", content: "", ...extra }),
  delta({ tool_calls: [{ index: 0, ...readCall }] }),
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];

describe("LiteLLM thinking_blocks (Claude behind an OpenAI-compatible proxy) go back verbatim", () => {
  it("streamed: blocks with signature replay unmodified, content is null, reasoning_content is not doubled", async () => {
    const { url, bodies } = await serve([toolStream({ reasoning_content: "", thinking_blocks: blocks }), done]);
    await runTask(loadConfig(surface(asHosted(url), "stream = true\nreplay_reasoning = true")), "read x.txt", { role: "smol", yes: true });
    const a = assistant(bodies[1]!);
    expect(a.thinking_blocks).toEqual(blocks);
    expect(a.content).toBeNull();
    expect(a.reasoning_content).toBeUndefined();
    expect(a.origin).toBeUndefined();
  });

  it("streamed: text pieces then a signature piece merge into one block", async () => {
    const { url, bodies } = await serve([
      [
        delta({ thinking_blocks: [{ type: "thinking", thinking: "I should ", signature: null }] }),
        delta({ thinking_blocks: [{ type: "thinking", thinking: "read it." }] }),
        delta({ thinking_blocks: [{ type: "thinking", thinking: "", signature: sig }] }),
        delta({ thinking_blocks: [{ type: "redacted_thinking", data: "opaque==" }] }),
        ...toolStream(),
      ],
      done,
    ]);
    await runTask(loadConfig(surface(asHosted(url), "stream = true\nreplay_reasoning = true")), "read x.txt", { role: "smol", yes: true });
    expect(assistant(bodies[1]!).thinking_blocks).toEqual([
      { type: "thinking", thinking: "I should read it.", signature: sig },
      { type: "redacted_thinking", data: "opaque==" },
    ]);
  });

  it("unstreamed message.thinking_blocks replay too", async () => {
    const { url, bodies } = await serve([
      { choices: [{ message: { role: "assistant", content: null, thinking_blocks: blocks, tool_calls: [readCall] }, finish_reason: "tool_calls" }] },
      done,
    ]);
    await runTask(loadConfig(surface(asHosted(url), "stream = false\nreplay_reasoning = true")), "read x.txt", { role: "smol", yes: true });
    expect(assistant(bodies[1]!).thinking_blocks).toEqual(blocks);
  });

  it("replay_reasoning = false: nothing is replayed, and the request is what it always was (content \"\")", async () => {
    const { url, bodies } = await serve([toolStream({ thinking_blocks: blocks }), done]);
    await runTask(loadConfig(surface(asHosted(url), "stream = true\nreplay_reasoning = false")), "read x.txt", { role: "smol", yes: true });
    const a = assistant(bodies[1]!);
    expect(a.thinking_blocks).toBeUndefined();
    expect(a.reasoning_content).toBeUndefined();
    expect(a.content).toBe("");
  });

  const hist = (): ChatMessage[] => [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      thinking_blocks: blocks,
      origin: "https://proxy.example/v1/chat/completions|claude-sonnet-5-5",
      tool_calls: [readCall],
    },
    { role: "tool", content: "hello", tool_call_id: "c1", tool_name: "read" },
  ];
  async function sent(target: Record<string, unknown>) {
    let body: Record<string, any> = {};
    globalThis.fetch = (async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify(done), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await callEndpoint({ temperature: 0, top_p: 1, kind: "openai", stream: false, replayReasoning: true, ...target } as any, hist(), [], 10_000);
    return (body.messages as any[]).find((m) => m.role === "assistant");
  }

  it("same url and model: replayed; another model or url: not", async () => {
    const same = await sent({ url: "https://proxy.example/v1/chat/completions", model: "claude-sonnet-5-5" });
    expect(same.thinking_blocks).toEqual(blocks);
    const other = await sent({ url: "https://proxy.example/v1/chat/completions", model: "claude-haiku-5" });
    expect(other.thinking_blocks).toBeUndefined();
    expect(other.content).toBe("");
    const elsewhere = await sent({ url: "https://other.example/v1/chat/completions", model: "claude-sonnet-5-5" });
    expect(elsewhere.thinking_blocks).toBeUndefined();
  });

  it("Ollama keeps its shape: content stays \"\" and no thinking_blocks", async () => {
    let body: Record<string, any> = {};
    globalThis.fetch = (async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ message: { content: "done" }, done: true }), { status: 200 });
    }) as typeof fetch;
    await callEndpoint(
      { url: "http://127.0.0.1:11434/api/chat", model: "claude-sonnet-5-5", kind: "ollama", temperature: 0, top_p: 1, stream: false, replayReasoning: true } as any,
      hist(),
      [],
      10_000
    );
    const a = (body.messages as any[]).find((m) => m.role === "assistant");
    expect(a.content).toBe("");
    expect(a.thinking_blocks).toBeUndefined();
  });

  it("a stream with no reasoning, replay not on: the assistant message is byte-identical to before", async () => {
    const { url, bodies } = await serve([toolStream(), done]);
    await runTask(loadConfig(surface(asHosted(url), "stream = true")), "read x.txt", { role: "smol", yes: true });
    const a = assistant(bodies[1]!);
    expect(Object.keys(a).sort()).toEqual(["content", "role", "tool_calls"]);
    expect(a.content).toBe("");
  });

  it("a text reply that also calls a tool keeps its text", async () => {
    const { url, bodies } = await serve([
      [delta({ content: "Reading." }), delta({ tool_calls: [{ index: 0, ...readCall }] }), { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }],
      done,
    ]);
    await runTask(loadConfig(surface(asHosted(url), "stream = true")), "read x.txt", { role: "smol", yes: true });
    expect(assistant(bodies[1]!).content).toBe("Reading.");
  });
});

describe("the pre-call estimate counts replayed thinking_blocks", () => {
  it("only where replay is on", async () => {
    const { messageTokens } = await import("./message_tokens.js");
    const m = { content: "", thinking_blocks: [{ type: "thinking", thinking: "", signature: "s".repeat(400) }] };
    expect(messageTokens(m, { reasoning: true })).toBeGreaterThan(100);
    expect(messageTokens(m)).toBe(0);
  });
});

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

describe("OpenRouter: reasoning_details go back verbatim", () => {
  const details = [
    { type: "reasoning.text", text: "I should read x.txt.", signature: "sig-abc", format: "anthropic-claude-v1", index: 0 },
    { type: "reasoning.encrypted", data: "opaque==", format: "anthropic-claude-v1", index: 1 },
  ];

  it("unstreamed: the details, unchanged and in order, and not the string beside them", async () => {
    const { url, bodies } = await serve([
      {
        choices: [
          {
            message: { role: "assistant", content: "", reasoning: "I should read x.txt.", reasoning_details: details, tool_calls: [readCall] },
            finish_reason: "tool_calls",
          },
        ],
      },
      done,
    ]);
    const rec = await runTask(loadConfig(surface(asHosted(url), "stream = false")), "read x.txt", { role: "smol", yes: true });
    expect(rec.output).toContain("done");
    const a = assistant(bodies[1]!);
    expect(a.reasoning_details).toEqual(details);
    expect(a.reasoning_content, "OpenRouter takes the string or the details, not both").toBeUndefined();
  });

  it("streamed: the pieces merged by index, signature kept", async () => {
    const delta = (d: Record<string, unknown>) => ({ choices: [{ index: 0, delta: d }] });
    const { url, bodies } = await serve([
      [
        delta({ reasoning: "I should ", reasoning_details: [{ type: "reasoning.text", text: "I should ", index: 0, format: "f" }] }),
        delta({ reasoning: "read x.txt.", reasoning_details: [{ type: "reasoning.text", text: "read x.txt.", index: 0 }] }),
        delta({ reasoning_details: [{ type: "reasoning.text", signature: "sig-abc", index: 0 }] }),
        delta({ tool_calls: [{ index: 0, ...readCall }] }),
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ],
      done,
    ]);
    await runTask(loadConfig(surface(asHosted(url), "stream = true")), "read x.txt", { role: "smol", yes: true });
    expect(assistant(bodies[1]!).reasoning_details).toEqual([
      { type: "reasoning.text", text: "I should read x.txt.", index: 0, format: "f", signature: "sig-abc" },
    ]);
  });
});

describe("Mistral: the ThinkChunk goes back inside content", () => {
  it("unstreamed: the assistant message is replayed with its content parts", async () => {
    const parts = [{ type: "thinking", thinking: [{ type: "text", text: "I should read x.txt." }] }];
    const { url, bodies } = await serve([
      { choices: [{ message: { role: "assistant", content: parts, tool_calls: [readCall] }, finish_reason: "tool_calls" }] },
      done,
    ]);
    const rec = await runTask(loadConfig(surface(asHosted(url), "stream = false")), "read x.txt", { role: "smol", yes: true });
    expect(rec.output).toContain("done");
    const a = assistant(bodies[1]!);
    expect(a.content).toEqual(parts);
    expect(a.reasoning_content, "parts never turn on reasoning_content replay").toBeUndefined();
  });

  it("streamed: thinking pieces and the answer text are rebuilt into parts", async () => {
    const delta = (d: Record<string, unknown>) => ({ choices: [{ index: 0, delta: d }] });
    const { url, bodies } = await serve([
      [
        delta({ content: [{ type: "thinking", thinking: [{ type: "text", text: "I should " }] }] }),
        delta({ content: [{ type: "thinking", thinking: [{ type: "text", text: "read x.txt." }] }, { type: "text", text: "Reading" }] }),
        delta({ content: " it." }),
        delta({ tool_calls: [{ index: 0, ...readCall }] }),
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ],
      done,
    ]);
    await runTask(loadConfig(surface(asHosted(url), "stream = true")), "read x.txt", { role: "smol", yes: true });
    expect(assistant(bodies[1]!).content).toEqual([
      { type: "thinking", thinking: [{ type: "text", text: "I should read x.txt." }] },
      { type: "text", text: "Reading it." },
    ]);
  });
});

describe("the wire: provider objects go to the endpoint that made them, and nowhere else", () => {
  const origin = "https://openrouter.example/v1/chat/completions|m1";
  const history = (): ChatMessage[] => [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "Reading",
      reasoning_content: "why",
      reasoning_details: [{ type: "reasoning.text", text: "why", index: 0 }],
      content_parts: [{ type: "thinking", thinking: [{ type: "text", text: "why" }] }, { type: "text", text: "Reading" }],
      origin,
      tool_calls: [readCall],
    },
    { role: "tool", content: "hello", tool_call_id: "c1", tool_name: "read" },
  ];
  async function sentBy(target: Record<string, unknown>, reply: Record<string, unknown> = done) {
    let body: Record<string, any> = {};
    globalThis.fetch = (async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const r = await callEndpoint({ temperature: 0, top_p: 1, kind: "openai", stream: false, ...target } as any, history(), [], 10_000);
    return { body, r, a: (body.messages as any[]).find((m) => m.role === "assistant") };
  }

  it("the same endpoint and model get the details and the parts", async () => {
    const { a } = await sentBy({ url: "https://openrouter.example/v1/chat/completions", model: "m1" });
    expect(a.reasoning_details).toEqual([{ type: "reasoning.text", text: "why", index: 0 }]);
    expect(Array.isArray(a.content)).toBe(true);
    expect(a.origin, "origin is gnomon's bookkeeping, never sent").toBeUndefined();
    expect(a.content_parts).toBeUndefined();
  });

  it("a fallback or escalation target gets plain text", async () => {
    const { a } = await sentBy({ url: "https://api.deepseek.example/v1/chat/completions", model: "m1" });
    expect(a.reasoning_details).toBeUndefined();
    expect(a.content).toBe("Reading");
  });

  it("replay_reasoning = false (or refused) sends none of it", async () => {
    const { a } = await sentBy({ url: "https://openrouter.example/v1/chat/completions", model: "m1", replayReasoningDeclined: true });
    expect(a.reasoning_details).toBeUndefined();
    expect(a.content).toBe("Reading");
  });

  it("Ollama's /api/chat gets declared replay as `thinking`, and only when declared", async () => {
    const ollama = { url: "http://127.0.0.1:11434/api/chat", model: "m1", kind: "ollama" };
    const on = await sentBy({ ...ollama, replayReasoning: true, replayReasoningSource: "declared" }, { message: { content: "done" }, done: true });
    expect(on.a.thinking).toBe("why");
    expect(on.a.reasoning_content).toBeUndefined();
    expect(on.a.reasoning_details, "provider objects never go to Ollama").toBeUndefined();
    const off = await sentBy(ollama, { message: { content: "done" }, done: true });
    expect(off.a.thinking).toBeUndefined();
  });

  it("a parsed reply carries the details, the parts and where they came from", async () => {
    const { r } = await sentBy(
      { url: "https://openrouter.example/v1/chat/completions", model: "m1" },
      {
        choices: [
          {
            message: {
              content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "ok" }],
              reasoning_details: [{ type: "reasoning.encrypted", data: "x" }],
            },
          },
        ],
      }
    );
    expect(r.content).toBe("ok");
    expect(r.reasoningDetails).toEqual([{ type: "reasoning.encrypted", data: "x" }]);
    expect(r.rawContent).toEqual([{ type: "thinking", thinking: "t" }, { type: "text", text: "ok" }]);
    expect(r.origin).toBe("https://openrouter.example/v1/chat/completions|m1");
  });
});

describe("Gemini: a streamed tool call keeps its thought signature", () => {
  it("extra_content is echoed back on the replayed tool call", async () => {
    const extra = { google: { thought_signature: "sig-gemini" } };
    const delta = (d: Record<string, unknown>) => ({ choices: [{ index: 0, delta: d }] });
    const { url, bodies } = await serve([
      [delta({ tool_calls: [{ index: 0, ...readCall, extra_content: extra }] }), { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }],
      done,
    ]);
    await runTask(loadConfig(surface(asHosted(url), "stream = true")), "read x.txt", { role: "smol", yes: true });
    expect((assistant(bodies[1]!).tool_calls as any[])[0].extra_content).toEqual(extra);
  });
});

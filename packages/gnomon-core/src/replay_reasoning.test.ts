/**
 * Opt-in replay of `reasoning_content` on assistant messages.
 *
 * DeepSeek's thinking mode documents that, when tools are sent, the reasoning
 * of every earlier assistant message must be passed back or the API answers
 * 400 (api-docs.deepseek.com/guides/thinking_mode, read 2026-11-03). gnomon
 * dropped it from every replayed message; goose replays it. Strict
 * OpenAI-compatible servers refuse unknown message fields, so it stays off
 * unless the endpoint declares it or is DeepSeek's own API. Every server here
 * is a fake on 127.0.0.1.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, wireOf } from "./prompt_loop.js";
import { auditSurface, loadConfig, resolveReplayReasoning, routeRole } from "./config.js";

let servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A fake endpoint: the first request gets a tool call with reasoning, the rest "done". */
async function serve(streamed: boolean) {
  const bodies: Record<string, any>[] = [];
  const server = createServer((req, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      const first = bodies.length === 1;
      if (!streamed) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            first
              ? {
                  choices: [
                    {
                      message: {
                        role: "assistant",
                        content: "",
                        reasoning_content: "I should read x.txt first.",
                        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } }],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                }
              : { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }
          )
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
      if (first) {
        send({ choices: [{ index: 0, delta: { reasoning_content: "I should " } }] });
        send({ choices: [{ index: 0, delta: { reasoning_content: "read x.txt first." } }] });
        send({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        });
      } else {
        send({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, bodies };
}

function surface(url: string, endpointExtra: string) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-replay-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[endpoints.target]\nurl = "${url}"\nkind = "openai"\n${endpointExtra}\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["read"]\nmax_steps = 4\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, "x.txt"), "hello\n");
  return root;
}

const assistants = (b: Record<string, any>) =>
  (b.messages as Array<Record<string, unknown>>).filter((m) => m.role === "assistant");

describe("replaying reasoning_content", () => {
  it("sends the reasoning back on the assistant message when the endpoint declares it", async () => {
    const { url, bodies } = await serve(false);
    const rec = await runTask(loadConfig(surface(url, "stream = false\nreplay_reasoning = true")), "read x.txt", {
      role: "smol",
      yes: true,
    });
    expect(rec.output).toContain("done");
    expect(bodies.length).toBe(2);
    const a = assistants(bodies[1]!);
    expect(a).toHaveLength(1);
    expect(a[0]!.reasoning_content).toBe("I should read x.txt first.");
    expect(a[0]!.tool_calls).toBeDefined();
  });

  it("does the same for a streamed reply, with the reasoning reassembled from its deltas", async () => {
    const { url, bodies } = await serve(true);
    await runTask(loadConfig(surface(url, "replay_reasoning = true")), "read x.txt", { role: "smol", yes: true });
    expect(bodies[0]!.stream).toBe(true);
    expect(assistants(bodies[1]!)[0]!.reasoning_content).toBe("I should read x.txt first.");
  });

  it("sends no reasoning_content to an endpoint that does not declare it", async () => {
    const { url, bodies } = await serve(false);
    await runTask(loadConfig(surface(url, "stream = false")), "read x.txt", { role: "smol", yes: true });
    expect(bodies.length).toBe(2);
    expect(JSON.stringify(bodies)).not.toContain("reasoning_content");
  });
});

describe("which endpoints replay it", () => {
  it("off by default, on for DeepSeek's own API, and a declaration wins either way", () => {
    expect(resolveReplayReasoning({ url: "https://openrouter.ai/api/v1/chat/completions" })).toBe(false);
    expect(resolveReplayReasoning({ url: "https://api.deepseek.com/chat/completions" })).toBe(true);
    expect(resolveReplayReasoning({ url: "https://api.deepseek.com/v1/chat/completions", replay_reasoning: false })).toBe(false);
    expect(resolveReplayReasoning({ url: "http://127.0.0.1:18000/v1/chat/completions", replay_reasoning: true })).toBe(true);
    expect(resolveReplayReasoning({ url: "http://127.0.0.1:11434/api/chat", replay_reasoning: true })).toBe(false);
  });

  it("the route and the turn record say so", async () => {
    const { url } = await serve(false);
    const t = routeRole(loadConfig(surface(url, "replay_reasoning = true")), "smol").target;
    expect(t.replayReasoning).toBe(true);
    expect(wireOf(t).replay_reasoning).toBe(true);
  });

  it("the surface audit accepts the key, and says when it can do nothing", () => {
    const s = (endpoints: unknown) =>
      ({ gnomonDir: "/x", config: { endpoints }, roles: {}, policy: {}, profiles: {}, tools: {}, system: { content: "", version: "0.1" } }) as never;
    expect(auditSurface(s({ e: { url: "https://x/v1/chat/completions", kind: "openai", replay_reasoning: true } }))).toEqual([]);
    const inert = auditSurface(s({ e: { url: "http://127.0.0.1:11434/api/chat", kind: "ollama", replay_reasoning: true } }));
    expect(inert.some((p) => !p.fatal && /replay_reasoning/.test(p.problem))).toBe(true);
  });
});

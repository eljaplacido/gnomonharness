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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { adaptReplayReasoning, callEndpoint, runSessionTurn, runTask, wireOf } from "./prompt_loop.js";
import { auditSurface, loadConfig, replayFieldsOf, resolveReplayReasoning, resolveUi, routeRole } from "./config.js";
import { Progress } from "./render.js";

/**
 * A hosted-looking URL for a fake server on 127.0.0.1. Since v0.4.6 the
 * replay default no longer depends on where the endpoint is, but a remote
 * host keeps the steering channel at `system` (resolveSteerRole), so these
 * tests of the hosted wire use one. `fetch` is wrapped to send
 * that host's requests to the local server; restored after each test.
 */
const realFetch = globalThis.fetch;
function asHosted(localUrl: string): string {
  const local = new URL(localUrl);
  const origin = `https://hosted-${local.port}.example.com`;
  const prev = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    const u: string = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return u.startsWith(origin) ? prev(local.origin + u.slice(origin.length), init) : prev(input, init);
  }) as typeof fetch;
  return origin + local.pathname + local.search;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

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
              : {
                  choices: [
                    { message: { role: "assistant", content: "done", reasoning_content: "Done reasoning." }, finish_reason: "stop" },
                  ],
                }
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
    await runTask(loadConfig(surface(url, "stream = true\nreplay_reasoning = true")), "read x.txt", { role: "smol", yes: true });
    expect(bodies[0]!.stream).toBe(true);
    expect(assistants(bodies[1]!)[0]!.reasoning_content).toBe("I should read x.txt first.");
  });

  it("sends no reasoning_content to an endpoint that declares replay_reasoning = false", async () => {
    const { url, bodies } = await serve(false);
    await runTask(loadConfig(surface(url, "stream = false\nreplay_reasoning = false")), "read x.txt", { role: "smol", yes: true });
    expect(bodies.length).toBe(2);
    expect(JSON.stringify(bodies)).not.toContain("reasoning_content");
  });
});

describe("on by default when the endpoint reasons (v0.4.3)", () => {
  /** A surface with the trail on, so the turn record's `wire` can be read. */
  function audited(url: string, endpointExtra: string) {
    const root = surface(url, endpointExtra);
    writeFileSync(
      join(root, ".gnomon", "config.toml"),
      `[audit]\nenabled = true\n\n[endpoints.target]\nurl = "${url}"\nkind = "openai"\n${endpointExtra}\n`
    );
    return root;
  }
  const turnRecord = (root: string): Record<string, any> => {
    const dir = join(root, ".gnomon-audit");
    const lines = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean))
      .map((l) => JSON.parse(l));
    return lines.find((r) => r.kind === "turn");
  };

  it("an undeclared hosted endpoint that answers a tool call with reasoning gets it back, and the wire says default", async () => {
    const { url, bodies } = await serve(false);
    const root = audited(asHosted(url), "stream = false");
    const rec = await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true });
    expect(rec.output).toContain("done");
    // The first request had nothing to replay; the second carries it.
    expect(assistants(bodies[1]!)[0]!.reasoning_content).toBe("I should read x.txt first.");
    const wire = turnRecord(root).wire;
    expect(wire.replay_reasoning).toBe(true);
    expect(wire.replay_reasoning_source).toBe("default");
  });

  it("the same for a streamed reply", async () => {
    const { url, bodies } = await serve(true);
    await runTask(loadConfig(surface(asHosted(url), "stream = true")), "read x.txt", { role: "smol", yes: true });
    expect(assistants(bodies[1]!)[0]!.reasoning_content).toBe("I should read x.txt first.");
  });

  it("a local lane (llama.cpp-style, 127.0.0.1) that returns reasoning_content is replayed by default (v0.4.6); declared false, it is not", async () => {
    // One rule wherever the endpoint is: it returned reasoning, so it gets it
    // back (CONTRACTS §39). Untested on local lanes by any study; recorded.
    const on = await serve(false);
    const root = audited(on.url, "stream = false");
    const rec = await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true });
    expect(rec.output).toContain("done");
    expect(on.bodies).toHaveLength(2);
    expect(assistants(on.bodies[1]!)[0]!.reasoning_content).toBe("I should read x.txt first.");
    expect(turnRecord(root).wire).toMatchObject({ replay_reasoning: true, replay_reasoning_source: "default" });

    const off = await serve(false);
    const declared = audited(off.url, "stream = false\nreplay_reasoning = false");
    await runTask(loadConfig(declared), "read x.txt", { role: "smol", yes: true });
    expect(JSON.stringify(off.bodies[1])).not.toContain("reasoning_content");
    expect(turnRecord(declared).wire.replay_reasoning).toBeUndefined();
  });

  it("an endpoint that never sends reasoning is sent none: the same bytes as replay_reasoning = false", async () => {
    // A server that answers a tool call with no reasoning, then "done".
    const plain = async () => {
      const raws: string[] = [];
      const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          raws.push(raw);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              raws.length === 1
                ? { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } }] }, finish_reason: "tool_calls" }] }
                : { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }
            )
          );
        });
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, raws };
    };
    const a = await plain();
    await runTask(loadConfig(surface(a.url, "stream = false")), "read x.txt", { role: "smol", yes: true });
    const b = await plain();
    await runTask(loadConfig(surface(b.url, "stream = false\nreplay_reasoning = false")), "read x.txt", { role: "smol", yes: true });
    expect(a.raws.length).toBe(2);
    expect(a.raws).toEqual(b.raws);
  });

  it("a declared value is reported as declared, DeepSeek's own API as default, and false stays off", () => {
    const declared = routeRole(loadConfig(surface("http://127.0.0.1:1/v1/chat/completions", "replay_reasoning = true")), "smol").target;
    expect(wireOf(declared)).toMatchObject({ replay_reasoning: true, replay_reasoning_source: "declared" });
    expect(replayFieldsOf({ url: "https://api.deepseek.com/chat/completions" })).toEqual({
      replayReasoning: true,
      replayReasoningSource: "default",
    });
    expect(replayFieldsOf({ url: "https://x.example/v1/chat/completions", kind: "openai", replay_reasoning: false })).toEqual({ replayReasoning: false });
    expect(replayFieldsOf({ url: "https://x.example/v1/chat/completions", kind: "openai" })).toEqual({
      replayReasoning: false,
      replayReasoningAuto: true,
    });
    // Ollama's /api/chat is never sent it, declared or not.
    expect(replayFieldsOf({ url: "http://127.0.0.1:11434/api/chat" })).toEqual({ replayReasoning: false });
    // Learned for the session: on, as a default; refused: off again.
    const auto = routeRole(loadConfig(surface("https://hosted.example.com/v1/chat/completions", "")), "smol").target;
    const state: any = { replayReasoningLearned: new Set([`${auto.url}|${auto.model}`]) };
    expect(wireOf(adaptReplayReasoning(state, auto))).toMatchObject({ replay_reasoning: true, replay_reasoning_source: "default" });
    state.replayReasoningRefused = new Set([`${auto.url}|${auto.model}`]);
    expect(wireOf(adaptReplayReasoning(state, auto)).replay_reasoning).toBeUndefined();
  });

  it("a 400 naming reasoning_content is resent once without it, and replay stays off for the session", async () => {
    const bodies: Record<string, any>[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        bodies.push(body);
        const carries = raw.includes("reasoning_content");
        res.writeHead(carries ? 400 : 200, { "content-type": "application/json" });
        if (carries) {
          res.end(JSON.stringify({ error: { message: "Extra inputs are not permitted, field: 'messages[2].reasoning_content'" } }));
          return;
        }
        const n = bodies.filter((b) => !JSON.stringify(b).includes("reasoning_content")).length;
        res.end(
          JSON.stringify(
            n <= 2
              ? { choices: [{ message: { role: "assistant", content: "", reasoning_content: `step ${n}`, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } }] }, finish_reason: "tool_calls" }] }
              : { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }
          )
        );
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = asHosted(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`);
    const errs: string[] = [];
    const rec = await runTask(loadConfig(surface(url, "stream = false")), "read x.txt", {
      role: "smol",
      yes: true,
      stderr: { write: (t: string) => errs.push(t) },
    });
    expect(rec.output).toContain("done");
    // The refusal did not end the turn: it went on and answered.
    expect(rec.stop_reason).toBe("answered");
    // Exactly one refused request; every later one goes without.
    expect(bodies.filter((b) => JSON.stringify(b).includes("reasoning_content"))).toHaveLength(1);
    expect(rec.counters.replay_reasoning_refused).toBe(1);
    expect(errs.join("")).toMatch(/refused the reasoning_content gnomon sends back by default/);
  });
});

describe("review findings (2026-11-03)", () => {
  it("the next user turn sends back the reasoning of the turn before (a session's second turn)", async () => {
    const { url, bodies } = await serve(false);
    const config = loadConfig(surface(url, "stream = false\nreplay_reasoning = true"));
    const state: any = { config, exchanges: [], currentRole: "smol" };
    const records: Array<[string, Record<string, unknown>]> = [];
    const deps = {
      approve: async () => true,
      standingApproval: () => true,
      signal: new AbortController().signal,
      audit: { write: (k: string, f: Record<string, unknown>) => void records.push([k, f]), text: () => undefined, action: (v: string) => v },
      surfaceHash: "test",
      persist: () => undefined,
      log: () => undefined,
      print: () => undefined,
      progress: new Progress(resolveUi(config), new PassThrough() as never),
    } as never;
    // Turn 1: a tool call with reasoning, then the answer "done" -- whose
    // reasoning is what turn 2 must send back.
    await runSessionTurn(state, "smol", "read x.txt", false, deps);
    expect(state.exchanges).toHaveLength(1);
    await runSessionTurn(state, "smol", "and again", false, deps);
    const turn2 = bodies[bodies.length - 1]!;
    const prior = (turn2.messages as Array<Record<string, unknown>>).filter((m) => m.role === "assistant");
    expect(prior[0]!.content).toBe("done");
    expect(prior[0]!.reasoning_content).toBe("Done reasoning.");
  });

  it("a non-streamed content: null beside tool calls does not turn the reasoning into content", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  reasoning_content: "thinking about it",
                  tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          })
        );
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
    const r = await callEndpoint({ url, model: "m", kind: "openai", temperature: 0, top_p: 1 }, [{ role: "user", content: "hi" }], [], 5000);
    expect(r.content).toBe("");
    expect(r.reasoning).toBe("thinking about it");
    expect(r.toolCalls).toHaveLength(1);
  });
});

describe("re-review findings (2026-11-03): turns that end another way", () => {
  /** A JSON fake endpoint scripted per request number. */
  async function scripted(reply: (n: number) => { status?: number; body: unknown }) {
    const bodies: Record<string, any>[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw || "{}"));
        const r = reply(bodies.length);
        res.writeHead(r.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, bodies };
  }
  const say = (content: string, reasoning?: string, tool = false) => ({
    body: {
      choices: [
        {
          message: {
            role: "assistant",
            content: tool ? "" : content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(tool
              ? { tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } }] }
              : {}),
          },
          finish_reason: tool ? "tool_calls" : "stop",
        },
      ],
    },
  });
  const session = (config: unknown) => {
    const state: any = { config, exchanges: [], currentRole: "smol" };
    const deps = {
      approve: async () => true,
      standingApproval: () => true,
      signal: new AbortController().signal,
      audit: { write: () => undefined, text: () => undefined, action: (v: string) => v },
      surfaceHash: "test",
      persist: () => undefined,
      log: () => undefined,
      print: () => undefined,
      progress: new Progress(resolveUi(config as never), new PassThrough() as never),
    } as never;
    return { state, turn: (input: string) => runSessionTurn(state, "smol", input, false, deps) };
  };
  const priorAssistant = (b: Record<string, any>) =>
    (b.messages as Array<Record<string, unknown>>).filter((m) => m.role === "assistant")[0]!;

  it("a turn that ends through the tool-less wrap-up keeps the wrap-up's reasoning for the next turn", async () => {
    // Calls 1 and 2 ask for a tool; the step wall (max_steps_total = 1) then
    // sends the tool-less wrap-up, call 3, whose reasoning the next turn needs.
    const { url, bodies } = await scripted((n) =>
      n <= 2 ? say("", "Read it first.", true) : n === 3 ? say("wrapped up", "Wrap reasoning.") : say("done")
    );
    const root = surface(url, "stream = false\nreplay_reasoning = true");
    writeFileSync(
      join(root, ".gnomon", "roles.toml"),
      `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read"]\nmax_steps = 1\nmax_steps_total = 1\n`
    );
    writeFileSync(
      join(root, ".gnomon", "tools.toml"),
      `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`
    );
    const s = session(loadConfig(root));
    const first = await s.turn("read x.txt");
    expect(first.turn.stop_reason).toBe("step_wall");
    await s.turn("and again");
    expect(priorAssistant(bodies[bodies.length - 1]!).reasoning_content).toBe("Wrap reasoning.");
  });

  it("a turn the fallback answered keeps its reasoning, because the next turn starts on the primary", async () => {
    const primary = await scripted((n) =>
      n === 1 ? { status: 500, body: { error: "upstream down" } } : say("done", "Primary reasoning.")
    );
    const fallback = await scripted(() => say("answered by the fallback", "Fallback reasoning."));
    const root = surface(primary.url, "stream = false\nreplay_reasoning = true");
    writeFileSync(
      join(root, ".gnomon", "config.toml"),
      `[resilience]\nattempts = 1\ntransport_grace_ms = 0\n\n` +
        `[endpoints.target]\nurl = "${primary.url}"\nkind = "openai"\nstream = false\nreplay_reasoning = true\n\n` +
        `[endpoints.fb]\nurl = "${fallback.url}"\nkind = "openai"\nstream = false\n`
    );
    writeFileSync(
      join(root, ".gnomon", "roles.toml"),
      `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = []\n\n[roles.smol.fallback]\nmodel = "m2"\nendpoint = "fb"\n`
    );
    const s = session(loadConfig(root));
    const first = await s.turn("hi");
    expect(first.turn.content).toContain("answered by the fallback");
    await s.turn("and again");
    const last = primary.bodies[primary.bodies.length - 1]!;
    expect(priorAssistant(last).reasoning_content).toBe("Fallback reasoning.");
  });
});

describe("which endpoints replay it", () => {
  it("off at the start by default (it turns on at run time), on for DeepSeek's own API, and a declaration wins either way", () => {
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
    expect(wireOf(t).replay_reasoning_source).toBe("declared");
  });

  it("the surface audit accepts the key, and says when it can do nothing", () => {
    const s = (endpoints: unknown) =>
      ({ gnomonDir: "/x", config: { endpoints }, roles: {}, policy: {}, profiles: {}, tools: {}, system: { content: "", version: "0.1" } }) as never;
    expect(auditSurface(s({ e: { url: "https://x/v1/chat/completions", kind: "openai", replay_reasoning: true } }))).toEqual([]);
    const inert = auditSurface(s({ e: { url: "http://127.0.0.1:11434/api/chat", kind: "ollama", replay_reasoning: true } }));
    expect(inert.some((p) => !p.fatal && /replay_reasoning/.test(p.problem))).toBe(true);
  });
});

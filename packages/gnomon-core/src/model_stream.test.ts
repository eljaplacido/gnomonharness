/**
 * Streamed model calls: the reply arrives as server-sent events, timed by the
 * gap between chunks rather than by one deadline on the whole reply.
 *
 * P2G (2026-11, Terminal-Bench on hosted DeepSeek V4.1 Flash, gnomon v0.3.1):
 * every call went out `stream: false`, so nothing arrived until a generation
 * was finished, and a long one was cut off at 300 s and sent again from the
 * start -- 11 of 18 cells hit the 30-minute cap, and the relay billed the
 * abandoned generations (163k output tokens billed against 82k counted on one
 * cell). Every server here is a fake on 127.0.0.1; nothing reaches a network.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callEndpoint, callEndpointWithRetry, readChatStream, runTask, wireOf } from "./prompt_loop.js";
import { auditSurface, loadConfig, resolveStream, routeRole } from "./config.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: Record<string, any>) => void;

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
});

/** A fake chat-completions server. Records each request body and each close. */
async function serve(handler: Handler) {
  const seen: { bodies: Record<string, any>[]; closed: number[] } = { bodies: [], closed: [] };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.bodies.push(body);
      res.on("close", () => seen.closed.push(Date.now()));
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  return { url, seen, server };
}

const sse = (res: ServerResponse) =>
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
const chunk = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

const target = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  model: "m",
  kind: "openai" as const,
  temperature: 0,
  top_p: 1,
  stream: true,
  ...extra,
});
const hi = [{ role: "user" as const, content: "hi" }];

describe("a streamed model call", () => {
  it("asks for usage, and reads the reply and its token counts exactly", async () => {
    const { url, seen } = await serve((_req, res) => {
      sse(res);
      res.write(": keep-alive\n\n");
      chunk(res, delta({ role: "assistant", content: "" }));
      chunk(res, delta({ content: "Hel" }));
      chunk(res, delta({ content: "lo" }, "stop"));
      chunk(res, { choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56 } });
      res.end("data: [DONE]\n\n");
    });
    const r = await callEndpoint(target(url), hi, [], 5000);
    expect(seen.bodies[0]!.stream).toBe(true);
    expect(seen.bodies[0]!.stream_options).toEqual({ include_usage: true });
    expect(r.code).toBe(0);
    expect(r.content).toBe("Hello");
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ input: 1234, output: 56, ms: undefined });
  });

  it("is not cut off by request_timeout_ms while chunks keep arriving", async () => {
    // 12 chunks 100 ms apart: 1.2 s of reply against a 400 ms request deadline.
    const { url } = await serve((_req, res) => {
      sse(res);
      let n = 0;
      const tick = setInterval(() => {
        n++;
        if (n < 12) return void chunk(res, delta({ content: "x" }));
        clearInterval(tick);
        chunk(res, delta({ content: "x" }, "stop"));
        res.end("data: [DONE]\n\n");
      }, 100);
      res.on("close", () => clearInterval(tick));
    });
    const r = await callEndpoint(target(url), hi, [], 400);
    expect(r.code).toBe(0);
    expect(r.content).toBe("x".repeat(12));
  });

  it("is aborted when it goes silent, as a timeout (11), and the server sees the socket close", async () => {
    const { url, seen } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ content: "thinking…" }));
      // …and then nothing, ever.
    });
    const started = Date.now();
    const r = await callEndpoint(target(url, { streamIdleMs: 300 }), hi, [], 5000);
    expect(r.code).toBe(11);
    expect(r.timedOut).toBe("idle");
    expect(r.content).toMatch(/stream_idle_timeout_ms/);
    expect(Date.now() - started).toBeLessThan(2500);
    // The abandoned generation is closed, not left running to be billed.
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.closed.length).toBe(1);
  });

  it("is aborted at its overall cap however steadily it arrives", async () => {
    const { url, seen } = await serve((_req, res) => {
      sse(res);
      const tick = setInterval(() => chunk(res, delta({ content: "." })), 30);
      res.on("close", () => clearInterval(tick));
    });
    const r = await callEndpoint(target(url, { streamTotalMs: 400 }), hi, [], 5000);
    expect(r.code).toBe(11);
    expect(r.timedOut).toBe("total");
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.closed.length).toBe(1);
  });

  it("closes the upstream request when the user cancels", async () => {
    const { url, seen } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ content: "a" }));
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await callEndpoint(target(url), hi, [], 5000, ac.signal);
    expect(r.code).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.closed.length).toBe(1);
  });

  it("assembles tool calls streamed in pieces, and echoes them back in the unstreamed shape", async () => {
    const { url } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ reasoning_content: "need the file" }));
      chunk(res, delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: "" } }] }));
      chunk(res, delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }));
      chunk(res, delta({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }));
      chunk(res, delta({ tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] }));
      chunk(res, delta({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
    });
    const r = await callEndpoint(target(url), hi, [{ type: "function" }], 5000);
    expect(r.code).toBe(0);
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toEqual([
      { id: "c1", name: "read", args: { path: "a.ts" } },
      { id: "c2", name: "bash", args: { command: "ls" } },
    ]);
    expect(r.rawToolCalls?.[0]).toEqual({
      id: "c1",
      type: "function",
      function: { name: "read", arguments: '{"path":"a.ts"}' },
    });
    // Reasoning is not promoted to content when the reply called a tool.
    expect(r.content).toBe("");
  });

  it("reads a reply given only in the reasoning channel, as an unstreamed one is read", async () => {
    const { url } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ reasoning_content: "The answer is 4." }, "stop"));
      res.end("data: [DONE]\n\n");
    });
    const r = await callEndpoint(target(url), hi, [], 5000);
    expect(r.content).toBe("The answer is 4.");
  });

  it("reports an error sent in place of a chunk, classified like the same error in a body", async () => {
    const { url } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ content: "par" }));
      chunk(res, { error: { message: "Provider overloaded", code: 529 } });
    });
    const r = await callEndpoint(target(url), hi, [], 5000);
    expect(r.code).toBe(12);
    expect(r.content).toMatch(/overloaded/);
  });

  it("calls a stream that breaks off mid-reply 12, and marks it as having answered", async () => {
    const { url } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ content: "par" }));
      setTimeout(() => res.socket?.destroy(), 50);
    });
    const r = await callEndpoint(target(url), hi, [], 5000);
    expect(r.code).toBe(12);
    expect(r.streamBroken).toBe(true);
  });

  it("reads a server that ignores stream: true and answers with one JSON body", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "whole" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        })
      );
    });
    const r = await callEndpoint(target(url), hi, [], 5000);
    expect(r.code).toBe(0);
    expect(r.content).toBe("whole");
    expect(r.usage?.input).toBe(3);
  });

  it("is not streamed when the endpoint says stream = false", async () => {
    const { url, seen } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    const r = await callEndpoint(target(url, { stream: false }), hi, [], 5000);
    expect(r.code).toBe(0);
    expect(seen.bodies[0]!.stream).toBe(false);
    expect(seen.bodies[0]!.stream_options).toBeUndefined();
  });
});

describe("review findings (2026-11-03)", () => {
  it("a mid-stream server_error with no numeric code is 12, retryable; an invalid request stays 10", async () => {
    const { url } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ content: "par" }));
      chunk(res, {
        error: { message: "The server had an error while processing your request.", type: "server_error", param: null, code: null },
      });
      res.end();
    });
    expect((await callEndpoint(target(url), hi, [], 5000)).code).toBe(12);
    const bad = await serve((_req, res) => {
      sse(res);
      chunk(res, { error: { message: "Invalid value for 'tool_choice'.", type: "invalid_request_error", code: null } });
      res.end();
    });
    expect((await callEndpoint(target(bad.url), hi, [], 5000)).code).toBe(10);
  });

  it("parallel calls each sent whole at index 0 stay two calls", async () => {
    const { url } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] }));
      chunk(res, delta({ tool_calls: [{ index: 0, id: "c2", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] }));
      chunk(res, delta({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
    });
    const r = await callEndpoint(target(url), hi, [{ type: "function" }], 5000);
    expect(r.toolCalls).toEqual([
      { id: "c1", name: "read", args: { path: "a" } },
      { id: "c2", name: "bash", args: { command: "ls" } },
    ]);
  });

  it("a reply with no usage report is counted as unmetered, never silently summed as zero", async () => {
    const { url } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ content: "hi" }, "stop"));
      res.end("data: [DONE]\n\n");
    });
    const r = await callEndpoint(target(url), hi, [], 5000);
    expect(r.usage).toBeUndefined();
    expect(r.unmeteredCalls).toBe(1);
  });

  it("the turn record counts unmetered calls, so a benchmark can tell a floor from a total", async () => {
    const { url, seen } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ content: "hi" }, "stop"));
      res.end("data: [DONE]\n\n");
    });
    const root = mkdtempSync(join(tmpdir(), "gnomon-stream-"));
    try {
      mkdirSync(join(root, ".gnomon"));
      writeFileSync(
        join(root, ".gnomon", "config.toml"),
        `[defaults]\nstream = true\n\n[endpoints.target]\nurl = "${url}"\nkind = "openai"\n`
      );
      writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = []\n`);
      writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
      const rec = await runTask(loadConfig(root), "hi", { role: "smol" });
      expect(seen.bodies[0]!.stream).toBe(true);
      expect(rec.counters.unmetered_calls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a refused request (429) is not a generation: a metered retry after it is exact, not a floor", async () => {
    let n = 0;
    const { url } = await serve((_req, res) => {
      if (++n === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
      }
      sse(res);
      chunk(res, delta({ content: "ok" }, "stop"));
      chunk(res, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } });
      res.end("data: [DONE]\n\n");
    });
    const r = await callEndpointWithRetry(target(url), hi, [], 5000, { attempts: 2, backoff_ms: 1, transport_grace_ms: 0 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(r.usage?.output).toBe(1);
    expect(r.unmeteredCalls).toBeUndefined();
  });

  it("an aborted attempt is counted as unmetered too, across retries", async () => {
    let n = 0;
    const { url } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ content: "a" }));
      if (++n === 1) return; // stalls, is aborted: billed, never reported
      chunk(res, delta({ content: "b" }, "stop"));
      chunk(res, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
    const r = await callEndpointWithRetry(target(url, { streamIdleMs: 150 }), hi, [], 5000, { attempts: 2, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(r.usage?.output).toBe(2);
    expect(r.unmeteredCalls).toBe(1);
  });

  it("a stall after a stream longer than the retry budget is still asked again", async () => {
    let n = 0;
    const { url, seen } = await serve((_req, res) => {
      sse(res);
      if (++n >= 2) {
        chunk(res, delta({ content: "ok" }, "stop"));
        return void res.end("data: [DONE]\n\n");
      }
      let k = 0;
      const t = setInterval(() => {
        if (++k > 16) return clearInterval(t);
        chunk(res, delta({ content: "." }));
      }, 50);
      res.on("close", () => clearInterval(t));
    });
    // Budget: 200 ms x 3. The first stream runs ~800 ms, then stalls.
    const r = await callEndpointWithRetry(target(url, { streamIdleMs: 150 }), hi, [], 200, { attempts: 3, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(r.content).toBe("ok");
    expect(seen.bodies.length).toBe(2);
  });

  it("a refused socket right after a long stream broke still gets transport_grace_ms", async () => {
    const first = await serve((_req, res) => {
      sse(res);
      let k = 0;
      const t = setInterval(() => {
        if (++k <= 16) return void chunk(res, delta({ content: "." }));
        clearInterval(t);
        // The relay restarts: the stream drops and nothing listens for 300 ms.
        const port = (first.server.address() as AddressInfo).port;
        first.server.close();
        res.socket?.destroy();
        setTimeout(() => {
          const again = createServer((_q, r2) => {
            _q.resume();
            _q.on("end", () => {
              sse(r2);
              chunk(r2, delta({ content: "ok" }, "stop"));
              r2.end("data: [DONE]\n\n");
            });
          });
          servers.push(again);
          again.listen(port, "127.0.0.1");
        }, 300);
      }, 50);
    });
    const r = await callEndpointWithRetry(
      target(first.url, { streamIdleMs: 5000 }),
      hi,
      [],
      200,
      { attempts: 3, backoff_ms: 50, transport_grace_ms: 5000, transport_grace_declared: true },
      undefined,
      undefined
    );
    expect(r.code).toBe(0);
    expect(r.content).toBe("ok");
  });
});

describe("retrying a streamed call", () => {
  const retry = (
    t: ReturnType<typeof target>,
    m: typeof hi,
    tools: unknown[],
    timeoutMs: number,
    r: { attempts: number; backoff_ms: number }
  ) => callEndpointWithRetry(t, m, tools, timeoutMs, r, undefined, undefined);

  it("does not resend a reply that ran past its overall cap: the same prompt would run as long", async () => {
    const { url, seen } = await serve((_req, res) => {
      sse(res);
      const tick = setInterval(() => chunk(res, delta({ content: "." })), 30);
      res.on("close", () => clearInterval(tick));
    });
    const r = await retry(target(url, { streamTotalMs: 300 }), hi, [], 5000, { attempts: 3, backoff_ms: 1 });
    expect(r.code).toBe(11);
    expect(r.timedOut).toBe("total");
    expect(seen.bodies.length).toBe(1);
  });

  it("asks again after a stall, and the second reply stands", async () => {
    let n = 0;
    const { url, seen } = await serve((_req, res) => {
      sse(res);
      chunk(res, delta({ content: "a" }));
      if (++n === 1) return; // the first stalls
      chunk(res, delta({ content: "b" }, "stop"));
      res.end("data: [DONE]\n\n");
    });
    const r = await retry(target(url, { streamIdleMs: 200 }), hi, [], 5000, { attempts: 2, backoff_ms: 1 });
    expect(r.code).toBe(0);
    expect(r.content).toBe("ab");
    expect(seen.bodies.length).toBe(2);
  });
});

describe("readChatStream", () => {
  const body = (...parts: string[]) =>
    (async function* () {
      for (const p of parts) yield new TextEncoder().encode(p);
    })();

  it("survives events split across reads, CRLF line ends and multi-line data", async () => {
    const s = await readChatStream(
      body(
        'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\nda',
        'ta: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n"
      )
    );
    expect(s.content).toBe("ab");
    expect(s.complete).toBe(true);
  });

  it("calls onData for keep-alive comments too", async () => {
    let n = 0;
    await readChatStream(body(": keep-alive\n\n", ": keep-alive\n\n", "data: [DONE]\n\n"), () => n++);
    expect(n).toBe(3);
  });

  it("is incomplete when the body ends with neither finish_reason nor [DONE]", async () => {
    const s = await readChatStream(body('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
    expect(s.complete).toBe(false);
  });
});

describe("which endpoints stream, as the surface declares it", () => {
  const surface = (endpoints: unknown, roles: unknown, resilience?: unknown) =>
    ({
      gnomonDir: "/nowhere",
      config: { endpoints, defaults: { stream: true }, ...(resilience ? { resilience } : {}) },
      roles,
      policy: {},
      profiles: {},
      tools: {},
      system: { content: "", version: "0.1" },
    }) as never;

  it("streams only where the surface says so: the endpoint's line, else [defaults]; Ollama's /api/chat never", () => {
    // Absent everywhere is the behaviour before streaming existed (Rule 1).
    expect(resolveStream({ url: "https://x/v1/chat/completions" })).toBe(false);
    expect(resolveStream({ url: "https://x/v1/chat/completions" }, "ollama", true)).toBe(true);
    expect(resolveStream({ url: "https://x/v1/chat/completions", stream: false }, "ollama", true)).toBe(false);
    expect(resolveStream({ url: "https://x/v1/chat/completions", stream: true })).toBe(true);
    expect(resolveStream({ url: "http://127.0.0.1:11434/api/chat" }, "ollama", true)).toBe(false);
    expect(resolveStream({ url: "http://127.0.0.1:11434/api/chat", stream: true })).toBe(false);
  });

  it("the route carries the stream setting and [resilience]'s stream clocks, and the record says so", () => {
    const c = surface(
      { cloud: { url: "https://x/v1/chat/completions", kind: "openai" } },
      { r: { model: "m", endpoint: "cloud" } },
      { stream_idle_timeout_ms: 90_000, stream_total_timeout_ms: 600_000 }
    );
    const t = routeRole(c, "r").target;
    expect(t.stream).toBe(true);
    expect(t.streamIdleMs).toBe(90_000);
    expect(t.streamTotalMs).toBe(600_000);
    expect(wireOf(t)).toMatchObject({ stream: true, stream_idle_timeout_ms: 90_000, stream_total_timeout_ms: 600_000 });
  });

  it("the surface audit accepts stream, and says when it can do nothing", () => {
    const ok = auditSurface(surface({ x: { url: "https://x/v1/chat/completions", kind: "openai", stream: false } }, {}));
    expect(ok).toEqual([]);
    const inert = auditSurface(surface({ x: { url: "http://127.0.0.1:11434/api/chat", kind: "ollama", stream: true } }, {}));
    expect(inert.some((p) => !p.fatal && /always called unstreamed/.test(p.problem))).toBe(true);
  });
});

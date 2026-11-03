/**
 * The output budget: every call carries a limit, declared in the surface, and
 * a reply that reaches it is handled rather than mistaken for an answer.
 *
 * P2G (2026-11, Terminal-Bench on hosted DeepSeek V4.1 Flash, gnomon v0.3.1):
 * gnomon sent no max_tokens and wrote about twice the output per step that
 * opencode and goose did, up to nine times on some tasks, most of it
 * reasoning. Every server here is a fake on 127.0.0.1.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callEndpoint, runTask, wireOf, adaptOutputLimit, readLimitRefusal } from "./prompt_loop.js";
import {
  auditSurface,
  loadConfig,
  resolveContext,
  resolveMaxTokens,
  routeRole,
  DEFAULT_MAX_TOKENS,
} from "./config.js";

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

type Reply = { status?: number; body: unknown };

/** A fake endpoint answering each request with the next scripted reply. */
async function serve(replies: Array<Reply | ((body: Record<string, any>) => Reply)>) {
  const bodies: Record<string, any>[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      bodies.push(body);
      const next = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
      const r = typeof next === "function" ? next(body) : next;
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, bodies };
}

const answer = (content: string, finish = "stop") => ({
  body: { choices: [{ message: { role: "assistant", content }, finish_reason: finish }] },
});
const toolCall = () => ({
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  },
});

/** A minimal surface whose one role talks to `url`. */
function surface(url: string, extra = { endpoint: "", role: "", defaults: "max_tokens = 32768" }) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-budget-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    (extra.defaults ? `[defaults]\n${extra.defaults}\n` : "") +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n${extra.endpoint}\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ["read"]\nmax_steps = 6\n${extra.role}\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`
  );
  writeFileSync(join(root, "x.txt"), "hello\n");
  return root;
}

const hi = [{ role: "user" as const, content: "hi" }];

describe("the output limit", () => {
  it("goes out with every call when [defaults] declares it, and not at all when nothing does (Rule 1)", async () => {
    const { url, bodies } = await serve([answer("ok")]);
    const t = routeRole(loadConfig(surface(url)), "smol").target;
    expect(t.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    await callEndpoint(t, hi, [], 5000);
    expect(bodies[0]!.max_tokens).toBe(32768);
    const bare = routeRole(loadConfig(surface(url, { endpoint: "", role: "", defaults: "" })), "smol").target;
    expect(bare.maxTokens).toBe(0);
    await callEndpoint(bare, hi, [], 5000);
    expect(bodies[1]!.max_tokens).toBeUndefined();
  });

  it("goes to Ollama's /api/chat as options.num_predict", async () => {
    const { url, bodies } = await serve([{ body: { message: { content: "ok" } } }]);
    await callEndpoint(
      { url: url.replace("/v1/chat/completions", "/api/chat"), model: "m", kind: "ollama", temperature: 0, top_p: 1, maxTokens: 2048 },
      hi,
      [],
      5000
    );
    expect(bodies[0]!.options).toEqual({ temperature: 0, top_p: 1, num_predict: 2048 });
    expect(bodies[0]!.max_tokens).toBeUndefined();
  });

  it("is the role's, else the endpoint's, else [defaults]'s; 0 sends none", () => {
    const config = { config: { defaults: { max_tokens: 8000 } } } as never;
    expect(resolveMaxTokens(config, { max_tokens: 1000 }, { max_tokens: 2000 })).toBe(1000);
    expect(resolveMaxTokens(config, {}, { max_tokens: 2000 })).toBe(2000);
    expect(resolveMaxTokens(config, {}, {})).toBe(8000);
    expect(resolveMaxTokens({ config: {} } as never, {}, undefined)).toBe(0);
    expect(resolveMaxTokens(config, { max_tokens: 0 }, { max_tokens: 2000 })).toBe(0);
  });

  it("is resent as max_completion_tokens when the endpoint asks for that name", async () => {
    const { url, bodies } = await serve([
      {
        status: 400,
        body: { error: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." },
      },
      answer("done"),
    ]);
    const rec = await runTask(loadConfig(surface(url)), "hi", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(rec.output).toContain("done");
    expect(bodies[1]!.max_completion_tokens).toBe(32768);
    expect(bodies[1]!.max_tokens).toBeUndefined();
  });

  it("is clamped to a maximum the provider states, and that is remembered", async () => {
    const { url, bodies } = await serve([
      { status: 400, body: { error: { message: "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]", type: "invalid_request_error" } } },
      toolCall(),
      answer("done"),
    ]);
    const config = loadConfig(surface(url));
    const rec = await runTask(config, "read x.txt", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(bodies.map((b) => b.max_tokens)).toEqual([32768, 8192, 8192]);
    expect(rec.counters.output_limit_adapted).toBe(1);
    const state = { config, exchanges: [], outputLimitAdapted: new Map([[`${url}|m1`, { max: 8192 }]]) };
    expect(wireOf(adaptOutputLimit(state as never, routeRole(config, "smol").target)).max_tokens).toBe(8192);
  });

  it("depends on the prompt when vLLM says so: clamped for that call only, never dropped for the session", async () => {
    const { url, bodies } = await serve([
      {
        status: 400,
        body: {
          object: "error",
          message:
            "'max_tokens' or 'max_completion_tokens' is too large: 32768. This model's maximum context length is " +
            "40960 tokens and your request has 20000 input tokens (32768 > 40960 - 20000).",
          type: "BadRequestError",
          code: 400,
        },
      },
      toolCall(),
      answer("done"),
    ]);
    const rec = await runTask(loadConfig(surface(url)), "read x.txt", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(bodies.map((b) => b.max_tokens)).toEqual([32768, 20960, 32768]);
  });

  it("reads a refusal into the shape to resend", () => {
    expect(readLimitRefusal("Use 'max_completion_tokens' instead.", 100, "max_tokens")).toEqual({ how: "rename" });
    expect(readLimitRefusal("the valid range of max_tokens is [1, 8192]", 32768, "max_tokens")).toEqual({
      how: "clamp",
      max: 8192,
      remember: true,
    });
    expect(readLimitRefusal("max_tokens: must be less than or equal to 4096", 32768, "max_tokens")).toEqual({
      how: "clamp",
      max: 4096,
      remember: true,
    });
    expect(readLimitRefusal("max_tokens is not allowed here", 32768, "max_tokens")).toEqual({ how: "drop" });
    expect(readLimitRefusal("some other 400", 32768, "max_tokens")).toBeUndefined();
    expect(readLimitRefusal("max_tokens bad", 0, "max_tokens")).toBeUndefined();
  });

  it("a role may declare it without the surface audit refusing the key", () => {
    const problems = auditSurface({
      gnomonDir: "/nowhere",
      config: { endpoints: { e: { url: "https://x/v1/chat/completions", kind: "openai", max_tokens: 8192, max_context_tokens: 200000 } } },
      roles: { r: { model: "m", endpoint: "e", max_tokens: 4096 } },
      policy: {},
      profiles: {},
      tools: {},
      system: { content: "", version: "0.1" },
    } as never);
    expect(problems).toEqual([]);
  });
});

describe("a reply cut off at the limit", () => {
  it("that spent it all on thinking is asked for a shorter one, and the latch re-opens after progress", async () => {
    const { url, bodies } = await serve([
      answer("", "length"),
      toolCall(),
      answer("", "length"),
      answer("done"),
    ]);
    const rec = await runTask(loadConfig(surface(url)), "read x.txt", { role: "smol", yes: true });
    const lastUser = (b: Record<string, any>) =>
      [...b.messages].reverse().find((m: { role: string }) => m.role === "user")?.content ?? "";
    expect(lastUser(bodies[1]!)).toMatch(/Think less/);
    // The second cut-off, after a tool call, is asked again too -- not left
    // standing as the turn's answer.
    expect(lastUser(bodies[3]!)).toMatch(/Think less/);
    expect(rec.output).toContain("done");
    expect(rec.stop_reason).toBe("answered");
  });
});

describe("review findings (2026-11-03)", () => {
  /** A streamed fake endpoint scripted per request number. */
  async function stream(script: (res: ServerResponse, n: number) => void) {
    const bodies: Record<string, any>[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw || "{}"));
        res.writeHead(200, { "content-type": "text/event-stream" });
        script(res, bodies.length);
        res.end("data: [DONE]\n\n");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, bodies };
  }
  const send = (res: ServerResponse, d: Record<string, unknown>, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`);
  const lastUser = (b: Record<string, any>) =>
    [...b.messages].reverse().find((m: { role: string }) => m.role === "user")?.content ?? "";
  const streamed = (url: string) =>
    surface(url, { endpoint: "", role: "", defaults: "max_tokens = 32768\nstream = true" }).replace(/$/, "");

  it("a streamed reply that thought until the limit is asked for a shorter one, and its thinking is not echoed back", async () => {
    const { url, bodies } = await stream((res, n) => {
      if (n === 1) {
        send(res, { reasoning_content: "Let me think about this at great length..." });
        send(res, {}, "length");
      } else send(res, { content: "done" }, "stop");
    });
    const root = streamed(url);
    // stream = false in the endpoint block would win; take it out.
    const cfg = join(root, ".gnomon", "config.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("stream = false\n", ""));
    const rec = await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true });
    expect(bodies[0]!.stream).toBe(true);
    expect(lastUser(bodies[1]!)).toMatch(/Think less/);
    expect(JSON.stringify(bodies[1]!.messages)).not.toContain("great length");
    expect(rec.output).toContain("done");
  });

  it("a tool call cut off at the limit is asked for in parts, not counted malformed, and the write then lands", async () => {
    const { url, bodies } = await stream((res, n) => {
      if (n <= 2) {
        send(res, { tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "read", arguments: '{"path":"x.t' } }] });
        send(res, {}, "length");
      } else if (n === 3) {
        send(res, { tool_calls: [{ index: 0, id: "c3", type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } }] }, "tool_calls");
      } else send(res, { content: "done" }, "stop");
    });
    const root = streamed(url);
    const cfg = join(root, ".gnomon", "config.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("stream = false\n", ""));
    const rec = await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true });
    expect(lastUser(bodies[1]!)).toMatch(/output limit \(max_tokens = 32768\) in the middle of a read call/);
    expect(lastUser(bodies[1]!)).toMatch(/smaller parts/);
    expect(JSON.stringify(bodies[1]!.messages)).not.toContain("transport truncation");
    expect(rec.counters.malformed_tool_calls ?? 0).toBe(0);
    expect(rec.stop_reason).toBe("answered");
    expect(rec.code).toBe(0);
  });

  it("cut-offs in a row end the turn as truncated, never a loop", async () => {
    const { url, bodies } = await stream((res, n) => {
      send(res, { tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "read", arguments: '{"path":"x.t' } }] });
      send(res, {}, "length");
    });
    const root = streamed(url);
    const cfg = join(root, ".gnomon", "config.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("stream = false\n", ""));
    const rec = await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true });
    expect(rec.stop_reason).toBe("truncated");
    // Three cut-offs (two asked again), then the tool-less wrap-up call.
    expect(bodies.length).toBe(4);
  });
});

describe("the context window", () => {
  it("is the endpoint's own when it declares one, and [defaults]'s otherwise", async () => {
    const { url } = await serve([answer("ok")]);
    const config = loadConfig(surface(url, { endpoint: "max_context_tokens = 400000", role: "", defaults: "" }));
    const t = routeRole(config, "smol").target;
    expect(t.contextTokens).toBe(400000);
    expect(resolveContext(config, t).max_context_tokens).toBe(400000);
    expect(resolveContext(config).max_context_tokens).toBe(65536);
    expect(wireOf(t).max_context_tokens).toBe(400000);
  });
});

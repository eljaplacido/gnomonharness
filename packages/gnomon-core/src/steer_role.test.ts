/**
 * The role gnomon's own mid-turn messages go out in.
 *
 * gnomon steers a turn with `role: "system"` messages appended after the
 * conversation has started: the idle nudge, the convergence push, a failed
 * verification, the tool-less wrap-up, and the context notices. M1 (2026-11)
 * found two local stacks that do not take that. vLLM serving Qwen3.x refuses
 * the request with 400 "System message must be at the beginning.", which
 * ended 4 of 16 cells at their first nudge. Unsloth's qwen3.6 template under
 * llama.cpp, the incumbent lane, drops the message without a word, so the
 * steering never reached the model.
 *
 * `[endpoints.<name>] steer_role = "user"` sends them as user messages marked
 * `[gnomon] `. A refusal of the system form is answered once, in that form,
 * and remembered for the session. The default request is unchanged, byte for
 * byte. Every server here is a fake on 127.0.0.1.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adaptTarget,
  callEndpoint,
  callEndpointWithRetry,
  hasLateSystem,
  readSteerRoleRefusal,
  runTask,
  steerAsUser,
  wireOf,
  STEER_CLOSE,
  STEER_PREFIX,
  type ChatMessage,
} from "./prompt_loop.js";
import { auditSurface, loadConfig, resolveSteerRole, routeRole, type RouteTarget } from "./config.js";

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

/** A fake endpoint answering each request through `reply`. Keeps the raw bodies. */
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

/** vLLM's refusal, as M1's q38 lane (vLLM, Qwen3.8) sent it. */
const VLLM_REFUSAL: Reply = {
  status: 400,
  body: {
    error: {
      message: "System message must be at the beginning.",
      type: "BadRequestError",
      param: null,
      code: 400,
    },
  },
};
const answer = (content: string): Reply => ({
  body: { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] },
});
const readCall = (n: number): Reply => ({
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `f${n}.txt` }) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  },
});
/** Whether a request carried a system message anywhere but first. */
const late = (b: Record<string, any>) => hasLateSystem(b.messages as ChatMessage[]);

/**
 * A surface whose one role reads files through `url`, with the idle nudge set
 * to fire after every call so a system message lands mid-turn at step one.
 */
function surface(url: string, opts: { endpoint?: string; turn?: string; role?: string; defaults?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-steer-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\n${opts.defaults ?? "max_tokens = 32768"}\n\n` +
      `[turn]\n${opts.turn ?? "nudge_after_idle = 1"}\n\n` +
      `[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n${opts.endpoint ?? ""}\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ["read"]\nmax_steps = 8\n${opts.role ?? ""}\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`
  );
  for (let i = 1; i <= 6; i++) writeFileSync(join(root, `f${i}.txt`), `hello ${i}\n`);
  return root;
}

/** The turn records this surface's audit trail holds. */
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

const target = (url: string, extra: Partial<RouteTarget> = {}): RouteTarget => ({
  url,
  model: "m1",
  kind: "openai",
  temperature: 0.2,
  top_p: 0.9,
  ...extra,
});

/** A conversation the way the loop builds one: steering after tool traffic. */
const midTurn = (): ChatMessage[] => [
  { role: "system", content: "be brief" },
  { role: "user", content: "fix the bug" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", content: "hello", tool_call_id: "c1", tool_name: "read" },
  { role: "system", content: "You have run 12 tool calls without changing a file." },
];

describe("steer_role in the surface", () => {
  it("absent or \"system\" leaves the target the object it was; \"user\" is carried, on the fallback too", async () => {
    const { url } = await serve(() => answer("ok"));
    const bare = routeRole(loadConfig(surface(url)), "smol").target;
    expect("steerRole" in bare).toBe(false);
    expect(wireOf(bare)).not.toHaveProperty("steer_role");
    const sys = routeRole(loadConfig(surface(url, { endpoint: 'steer_role = "system"' })), "smol").target;
    expect(sys).toEqual(bare);

    const user = routeRole(loadConfig(surface(url, { endpoint: 'steer_role = "user"' })), "smol").target;
    expect(user.steerRole).toBe("user");
    expect(wireOf(user).steer_role).toBe("user");

    const root = surface(url);
    writeFileSync(
      join(root, ".gnomon", "config.toml"),
      readFileSync(join(root, ".gnomon", "config.toml"), "utf-8") +
        `\n[endpoints.backup]\nurl = "${url}"\nkind = "openai"\nsteer_role = "user"\n`
    );
    writeFileSync(
      join(root, ".gnomon", "roles.toml"),
      readFileSync(join(root, ".gnomon", "roles.toml"), "utf-8") + `\n[roles.smol.fallback]\nmodel = "m2"\nendpoint = "backup"\n`
    );
    const route = routeRole(loadConfig(root), "smol");
    expect("steerRole" in route.target).toBe(false);
    expect(route.fallback?.steerRole).toBe("user");
  });

  it("reads only the two declared values; anything else is system", () => {
    expect(resolveSteerRole(undefined)).toBe("system");
    expect(resolveSteerRole({})).toBe("system");
    expect(resolveSteerRole({ steer_role: "user" })).toBe("user");
    expect(resolveSteerRole({ steer_role: "system" })).toBe("system");
    expect(resolveSteerRole({ steer_role: "assistant" })).toBe("system");
    expect(resolveSteerRole({ steer_role: true })).toBe("system");
  });

  it("is a key an endpoint may carry, and a value outside the two is reported, not fatal", () => {
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
    expect(auditSurface(s({ steer_role: "user" }))).toEqual([]);
    expect(auditSurface(s({ steer_role: "system" }))).toEqual([]);
    const bad = auditSurface(s({ steer_role: "assistant" }));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.fatal).toBe(false);
    expect(bad[0]!.problem).toMatch(/steer_role = "assistant" is not one of "system", "user"/);
  });
});

describe("steerAsUser", () => {
  it("keeps the first system message, and sends a later one as a user message marked [gnomon]", () => {
    const msgs = midTurn();
    const out = steerAsUser(msgs);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(out[4]!.content).toBe(`${STEER_PREFIX}You have run 12 tool calls without changing a file.`);
    expect(out[4]!.content.startsWith("[gnomon] ")).toBe(true);
    // Everything else is passed through as the same objects, and the caller's
    // list is not touched: the loop keeps its own messages as system messages.
    for (const i of [0, 1, 2, 3]) expect(out[i]).toBe(msgs[i]);
    expect(msgs[4]!.role).toBe("system");
  });

  it("sends the leading run of system messages as one", () => {
    const out = steerAsUser([
      { role: "system", content: "be brief" },
      { role: "system", content: "[gnomon context] Summary of earlier turns" },
      { role: "user", content: "go on" },
    ]);
    expect(out).toEqual([
      { role: "system", content: "be brief\n\n[gnomon context] Summary of earlier turns" },
      { role: "user", content: "go on" },
    ]);
    expect(hasLateSystem(out)).toBe(false);
  });

  it("merges user messages next to each other, closing a note that someone else's text follows", () => {
    const out = steerAsUser([
      { role: "system", content: "be brief" },
      { role: "user", content: "rename the widget" },
      { role: "system", content: "[gnomon context] 3 earlier step(s) were dropped" },
      { role: "user", content: "delete the obsolete migration" },
      { role: "assistant", content: "on it" },
      { role: "system", content: "nudge" },
      { role: "system", content: "converge" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(out[1]!.content).toBe(
      `rename the widget\n\n${STEER_PREFIX}[gnomon context] 3 earlier step(s) were dropped\n${STEER_CLOSE}\n\n` +
        `delete the obsolete migration`
    );
    // Two notes in a row need no closer between them: the next prefix is one.
    expect(out[3]!.content).toBe(`${STEER_PREFIX}nudge\n\n${STEER_PREFIX}converge`);
  });

  it("changes nothing when no system message comes after the first", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const out = steerAsUser(msgs);
    expect(out).toEqual(msgs);
    out.forEach((m, i) => expect(m).toBe(msgs[i]));
  });
});

describe("readSteerRoleRefusal", () => {
  it("knows the template's words however the server wraps them", () => {
    for (const detail of [
      "System message must be at the beginning.",
      JSON.stringify(VLLM_REFUSAL.body),
      '{"object":"error","message":"System message must be at the beginning.","type":"BadRequestError","param":null,"code":400}',
      // llama.cpp prefixes whatever a template raises.
      '{"error":{"code":500,"message":"Jinja Exception: System message must be at the beginning.","type":"server_error"}}',
      "Template error: system messages are only allowed at the beginning of the conversation",
      "The system prompt must be the first message",
      "Only the first message may be a system message.",
      "After the optional system message, conversation roles must alternate user/assistant/user/assistant/...",
    ]) {
      expect(readSteerRoleRefusal(detail), detail).toBe(true);
    }
  });

  it("does not mistake other refusals for it", () => {
    for (const detail of [
      "System role not supported",
      "The system is overloaded, please retry",
      "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]",
      "Extra inputs are not permitted, field: 'messages[3].tool_name'",
      "registry.ollama.ai/library/x does not support tools",
      "the system message is too long",
    ]) {
      expect(readSteerRoleRefusal(detail), detail).toBe(false);
    }
  });
});

describe("one call", () => {
  it("is byte-identical by default: an undeclared and a declared \"system\" send the same body", async () => {
    const { url, raws, bodies } = await serve(() => answer("ok"));
    await callEndpoint(target(url), midTurn(), [], 5000);
    await callEndpoint(target(url, { steerRole: "system" }), midTurn(), [], 5000);
    expect(raws[1]).toBe(raws[0]);
    // The steering went as the loop wrote it: a system message, no prefix.
    expect(bodies[0]!.messages[4]).toEqual({ role: "system", content: "You have run 12 tool calls without changing a file." });
    expect(raws[0]).not.toContain(STEER_PREFIX);
  });

  it("with steer_role = \"user\" sends the steering as a marked user message", async () => {
    const { url, bodies } = await serve(() => answer("ok"));
    await callEndpoint(target(url, { steerRole: "user" }), midTurn(), [], 5000);
    expect(late(bodies[0]!)).toBe(false);
    expect(bodies[0]!.messages.at(-1)).toEqual({ role: "user", content: `${STEER_PREFIX}You have run 12 tool calls without changing a file.` });
  });

  it("names vLLM's refusal, and llama.cpp's 500 for it is not retried as an outage", async () => {
    const vllm = await serve(() => VLLM_REFUSAL);
    const r = await callEndpoint(target(vllm.url), midTurn(), [], 5000);
    expect(r.steerRoleRejected).toBe(true);
    expect(r.code).toBe(10);

    const llama = await serve(() => ({
      status: 500,
      body: { error: { code: 500, message: "Jinja Exception: System message must be at the beginning.", type: "server_error" } },
    }));
    const resilience = { attempts: 3, backoff_ms: 1, transport_grace_ms: 0, transport_grace_declared: true };
    const rr = await callEndpointWithRetry(target(llama.url), midTurn(), [], 5000, resilience, undefined, undefined);
    expect(rr.steerRoleRejected).toBe(true);
    expect(rr.code).toBe(10);
    expect(llama.bodies).toHaveLength(1);
  });

  it("is not flagged where a resend could not differ, or where nothing was refused for it", async () => {
    const { url } = await serve(() => VLLM_REFUSAL);
    // Already user: the same request again would fail the same way.
    expect((await callEndpoint(target(url, { steerRole: "user" }), midTurn(), [], 5000)).steerRoleRejected).toBeUndefined();
    // No system message after the first: there is nothing to move.
    const opening: ChatMessage[] = [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }];
    const first = await callEndpoint(target(url), opening, [], 5000);
    expect(first.steerRoleRejected).toBeUndefined();
    expect(first.code).toBe(10);
    // Ollama's /api/chat renders its own templates.
    const ollama = await callEndpoint(
      target(url.replace("/v1/chat/completions", "/api/chat"), { kind: "ollama" }),
      midTurn(),
      [],
      5000
    );
    expect(ollama.steerRoleRejected).toBeUndefined();
    // Some other 400.
    const other = await serve(() => ({ status: 400, body: { error: "model not found" } }));
    expect((await callEndpoint(target(other.url), midTurn(), [], 5000)).steerRoleRejected).toBeUndefined();
  });
});

describe("a turn against a template that refuses a late system message", () => {
  /** vLLM with a Qwen3.x template: 400 for any system message after the first. */
  const strict = (calls: number) => (body: Record<string, any>, n: number) => {
    if (late(body)) return VLLM_REFUSAL;
    const reads = body.messages.filter((m: { role: string }) => m.role === "tool").length;
    return reads < calls ? readCall(n) : answer("done");
  };

  it("resends once with the steering as user messages, counts it, and the record's wire says so", async () => {
    const { url, bodies, statuses } = await serve(strict(1));
    const root = surface(url);
    const rec = await runTask(loadConfig(root), "read f1.txt", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(rec.output).toContain("done");
    expect(statuses).toEqual([200, 400, 200]);
    // The refused request carried the nudge as the loop wrote it...
    expect(bodies[1]!.messages.at(-1)!.role).toBe("system");
    // ...and the resend carried it as gnomon's own, marked, user message.
    const sent = bodies[2]!.messages.at(-1)!;
    expect(sent.role).toBe("user");
    expect(sent.content).toMatch(/^\[gnomon\] You have run 1 tool calls without changing a file/);
    expect(rec.counters.steer_role_adapted).toBe(1);
    expect(rec.counters.output_limit_adapted).toBeUndefined();
    const [turn] = turnRecords(root);
    expect(turn!.wire.steer_role).toBe("user");
    expect(turn!.counters.steer_role_adapted).toBe(1);
  });

  it("stays adapted for the endpoint: one refusal, then every later call goes in the user role", async () => {
    const { url, bodies, statuses } = await serve(strict(4));
    const rec = await runTask(loadConfig(surface(url)), "read the files", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(statuses.filter((s) => s === 400)).toHaveLength(1);
    expect(bodies.length).toBe(6);
    for (const b of bodies.slice(2)) expect(late(b)).toBe(false);
    expect(rec.counters.nudges).toBeGreaterThanOrEqual(3);
    expect(rec.counters.steer_role_adapted).toBe(1);
  });

  it("is remembered across turns of a session, per endpoint and model", () => {
    const config = { config: {}, roles: {} } as never;
    const t = target("http://127.0.0.1:1/v1/chat/completions");
    const state = { config, exchanges: [], steerRoleAdapted: new Set([`${t.url}|m1`]) };
    expect(adaptTarget(state as never, t).steerRole).toBe("user");
    expect(wireOf(adaptTarget(state as never, t)).steer_role).toBe("user");
    // Another model behind the same URL has a template of its own.
    const other = { ...t, model: "m2" };
    expect(adaptTarget(state as never, other)).toBe(other);
    expect("steerRole" in adaptTarget({ config, exchanges: [] } as never, t)).toBe(false);
  });

  it("is never refused when the endpoint declares steer_role = \"user\"", async () => {
    const { url, bodies, statuses } = await serve(strict(2));
    const root = surface(url, { endpoint: 'steer_role = "user"' });
    const rec = await runTask(loadConfig(root), "read the files", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(bodies.some((b) => b.messages.some((m: { content: string }) => m.content?.startsWith(STEER_PREFIX)))).toBe(true);
    expect(rec.counters.steer_role_adapted).toBeUndefined();
    expect(turnRecords(root)[0]!.wire.steer_role).toBe("user");
  });

  it("answers the refusal on the tool-less wrap-up too, the one call that always carries a late system message", async () => {
    // No nudge and no convergence push (a read-only role gets one by default):
    // the wrap-up instruction is the only steering in the turn.
    const { url, bodies, statuses } = await serve((body, n) =>
      late(body) ? VLLM_REFUSAL : body.tools ? readCall(n) : answer("wrapped up")
    );
    const root = surface(url, { turn: "nudge_after_idle = 100\nread_only_converge_after = 0\nlegs = 1" });
    writeFileSync(
      join(root, ".gnomon", "roles.toml"),
      readFileSync(join(root, ".gnomon", "roles.toml"), "utf-8").replace("max_steps = 8", "max_steps = 2")
    );
    const rec = await runTask(loadConfig(root), "read the files", { role: "smol", yes: true });
    expect(rec.stop_reason).toBe("step_wall");
    expect(rec.output).toContain("wrapped up");
    expect(statuses.filter((s) => s === 400)).toHaveLength(1);
    // The refused call is the wrap-up: no tools, and nothing late before it.
    const refused = statuses.indexOf(400);
    for (const b of bodies.slice(0, refused)) {
      expect(b.tools).toBeDefined();
      expect(late(b)).toBe(false);
    }
    expect(bodies[refused]!.tools).toBeUndefined();
    expect(bodies[refused + 1]!.messages.at(-1)!.content).toMatch(/^\[gnomon\] No tools are attached to this final call/);
    expect(bodies).toHaveLength(refused + 2);
    expect(rec.counters.steer_role_adapted).toBe(1);
  });

  it.each([
    ["the steering role first", true],
    ["the output limit first", false],
  ])("answers a refused output limit in the same call, whichever is named first (%s), each once", async (_, steerFirst) => {
    const limitRefusal: Reply = {
      status: 400,
      body: { error: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." },
    };
    // Both refusals land on the same call, the first one carrying a nudge.
    const marked = (b: Record<string, any>) =>
      b.messages.some((m: { content?: string }) => m.content?.startsWith(STEER_PREFIX));
    const { url, bodies, statuses } = await serve((body, n) => {
      const limited = body.max_tokens !== undefined;
      if (steerFirst) {
        if (late(body)) return VLLM_REFUSAL;
        if (limited && marked(body)) return limitRefusal;
      } else {
        if (late(body) && limited) return limitRefusal;
        if (late(body)) return VLLM_REFUSAL;
      }
      const reads = body.messages.filter((m: { role: string }) => m.role === "tool").length;
      return reads < 2 ? readCall(n) : answer("done");
    });
    const rec = await runTask(loadConfig(surface(url)), "read the files", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(rec.counters.output_limit_adapted).toBe(1);
    expect(rec.counters.steer_role_adapted).toBe(1);
    // One call: the request, a resend for the first refusal, one for the second.
    const first = statuses.indexOf(400);
    expect(statuses.slice(first, first + 3)).toEqual([400, 400, 200]);
    expect(statuses.filter((s) => s === 400)).toHaveLength(2);
    const last = bodies.at(-1)!;
    expect(last.max_completion_tokens).toBe(32768);
    expect(late(last)).toBe(false);
  });
});

describe("a turn with no refusal and nothing declared", () => {
  it("sends its steering as system messages, records no steer_role, and counts nothing", async () => {
    const { url, bodies } = await serve((body, n) =>
      body.messages.filter((m: { role: string }) => m.role === "tool").length < 1 ? readCall(n) : answer("done")
    );
    const root = surface(url);
    const rec = await runTask(loadConfig(root), "read f1.txt", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(bodies[1]!.messages.at(-1)).toMatchObject({ role: "system" });
    expect(bodies[1]!.messages.at(-1)!.content).toMatch(/^You have run 1 tool calls/);
    expect(rec.counters).not.toHaveProperty("steer_role_adapted");
    expect(turnRecords(root)[0]!.wire).not.toHaveProperty("steer_role");
  });
});

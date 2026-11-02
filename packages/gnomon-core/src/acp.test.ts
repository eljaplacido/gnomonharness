/**
 * gnomon-core: the ACP mappings and the JSON-RPC framing, as units.
 *
 * The end-to-end proof — a scripted client driving the real `gnomon acp`
 * against a fake model — is packages/gnomon-cli/src/acp.test.ts. This file pins
 * the pieces whose every branch that test cannot reach cheaply: what an
 * unrecognised permission answer means (refusal, always), which stop reason a
 * turn maps to, how an editor's attachments become input, and that a bad line
 * on the wire gets a JSON-RPC error rather than a dead server.
 */

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ACP_PROTOCOL_VERSION,
  JsonRpcPeer,
  PERMISSION_OPTIONS,
  RPC_ERROR,
  RpcFailure,
  acpStopReason,
  acpToolKind,
  acpToolStatus,
  promptText,
  readPermission,
} from "./acp.js";
import { CANCELLED } from "./prompt_loop.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

// The contract, read from the artefacts rather than restated: the methods and
// update kinds are pulled out of acp.ts's own source, so a handler added or
// renamed without the fixture fails here.
describe("conformance/acp_mapping.json", () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, "conformance/acp_mapping.json"), "utf-8"));
  const source = readFileSync(join(here, "acp.ts"), "utf-8");
  const contracts = readFileSync(join(repoRoot, "docs/CONTRACTS.md"), "utf-8");
  const grab = (re: RegExp) => [...new Set([...source.matchAll(re)].map((m) => m[1]!))].sort();

  it("the protocol version", () => {
    expect(ACP_PROTOCOL_VERSION).toBe(fixture.protocol_version);
  });

  it("the methods served and called are the ones acp.ts registers and sends", () => {
    const served = grab(/peer\.onRequest\("([^"]+)"/g);
    const heard = grab(/peer\.onNotification\("([^"]+)"/g);
    const called = grab(/peer\.request\("([^"]+)"/g);
    const told = grab(/peer\.notify\("([^"]+)"/g);
    expect(served.length, "no handlers found — the source moved").toBeGreaterThan(2);
    expect(served).toEqual([...fixture.agent_requests].sort());
    expect(heard).toEqual([...fixture.agent_notifications].sort());
    expect(called).toEqual([...fixture.client_requests].sort());
    expect(told).toEqual([...fixture.client_notifications].sort());
  });

  it("the session updates it can send", () => {
    const kinds = grab(/sessionUpdate: "([a-z_]+)"/g);
    const via = grab(/"(agent_(?:message|thought)_chunk)"/g);
    expect([...new Set([...kinds, ...via])].sort()).toEqual([...fixture.session_updates].sort());
  });

  it("the permission options, and how each answer reads", () => {
    expect(PERMISSION_OPTIONS.map((o) => ({ optionId: o.optionId, kind: o.kind }))).toEqual(
      fixture.permission_options.map((o: { optionId: string; kind: string }) => ({ optionId: o.optionId, kind: o.kind }))
    );
  });

  it("the stop-reason and tool-kind maps", () => {
    for (const [from, to] of Object.entries(fixture.stop_reason as Record<string, string>)) {
      const sr = (from === "*" ? "answered" : from) as Parameters<typeof acpStopReason>[0]["stop_reason"];
      expect(acpStopReason({ content: "x", stop_reason: sr }, false), from).toBe(to);
    }
    for (const [from, to] of Object.entries(fixture.tool_kind as Record<string, string>)) {
      expect(acpToolKind(from === "*" ? "mcp__any__tool" : from), from).toBe(to);
    }
  });

  it("CONTRACTS.md §9 names every method and option", () => {
    const section = contracts.slice(contracts.indexOf("## 9. `gnomon acp`"));
    expect(section.length, "CONTRACTS.md has no §9").toBeGreaterThan(100);
    for (const name of [
      ...fixture.agent_requests,
      ...fixture.agent_notifications,
      ...fixture.client_requests,
      ...fixture.session_updates,
      ...fixture.permission_options.map((o: { optionId: string }) => o.optionId),
    ]) {
      expect(section, `§9 does not name ${name}`).toContain(`\`${name}\``);
    }
  });
});

describe("permission answers", () => {
  it("offers the terminal's ladder: once, turn, session, no", () => {
    expect(PERMISSION_OPTIONS.map((o) => o.optionId)).toEqual(["once", "turn", "session", "no"]);
    // The spec asks an allow_always option to name its scope.
    for (const o of PERMISSION_OPTIONS.filter((o) => o.kind === "allow_always")) {
      expect(o.name).toMatch(/turn|session/);
    }
  });

  it("reads a selection", () => {
    for (const id of ["once", "turn", "session", "no"]) {
      expect(readPermission({ outcome: { outcome: "selected", optionId: id } })).toBe(id);
    }
  });

  it("anything else is a refusal — cancelled, unknown ids, junk, nothing", () => {
    expect(readPermission({ outcome: { outcome: "cancelled" } })).toBe("no");
    expect(readPermission({ outcome: { outcome: "selected", optionId: "allow" } })).toBe("no");
    expect(readPermission({ outcome: "selected" })).toBe("no");
    expect(readPermission(null)).toBe("no");
    expect(readPermission(undefined)).toBe("no");
  });
});

describe("stop reasons", () => {
  it("maps gnomon's stop_reason to ACP's nearest word", () => {
    expect(acpStopReason({ content: "x", stop_reason: "answered" }, false)).toBe("end_turn");
    expect(acpStopReason({ content: "x", stop_reason: "step_wall" }, false)).toBe("max_turn_requests");
    expect(acpStopReason({ content: "x", stop_reason: "truncated" }, false)).toBe("max_tokens");
    expect(acpStopReason({ content: "x", stop_reason: "stall" }, false)).toBe("end_turn");
  });

  it("a cancelled turn is cancelled however it was noticed", () => {
    expect(acpStopReason({ content: "x", stop_reason: "answered" }, true)).toBe("cancelled");
    expect(acpStopReason({ content: CANCELLED, stop_reason: "answered" }, false)).toBe("cancelled");
    expect(acpStopReason({ content: "x", stop_reason: "cancelled" }, false)).toBe("cancelled");
  });
});

describe("tool calls", () => {
  it("kinds", () => {
    expect(acpToolKind("read")).toBe("read");
    expect(acpToolKind("write")).toBe("edit");
    expect(acpToolKind("edit")).toBe("edit");
    expect(acpToolKind("grep")).toBe("search");
    expect(acpToolKind("bash")).toBe("execute");
    expect(acpToolKind("webfetch")).toBe("fetch");
    expect(acpToolKind("mcp__x__y")).toBe("other");
  });

  it("a refusal and a failing command are failures; a clean result completes", () => {
    expect(acpToolStatus({ code: 0, content: "", summary: "" })).toBe("completed");
    expect(acpToolStatus({ code: 2, content: "", summary: "" })).toBe("failed");
    expect(acpToolStatus({ code: 11, content: "", summary: "" })).toBe("failed");
    expect(acpToolStatus({ code: 0, content: "", summary: "", shell_exit: 1 })).toBe("failed");
    expect(acpToolStatus({ code: 0, content: "", summary: "", shell_exit: 0 })).toBe("completed");
  });
});

describe("prompt content", () => {
  it("joins text and names attached files", () => {
    // Absolute on this platform: an editor on Windows sends file:///C:/…, and a
    // drive-less file:///tmp/… is not a path there.
    const a = resolve("/tmp/a.ts"), b = resolve("/tmp/b.ts");
    const { text, skipped } = promptText([
      { type: "text", text: "explain" },
      { type: "resource_link", uri: pathToFileURL(a).href, name: "a.ts" },
      { type: "resource", resource: { uri: pathToFileURL(b).href, text: "const b = 1;" } },
      { type: "image", data: "", mimeType: "image/png" },
    ]);
    expect(text).toBe(`explain @${a}\n<file path="${b}">\nconst b = 1;\n</file>`);
    expect(skipped).toEqual(["image"]);
  });

  it("tolerates a prompt that is not an array", () => {
    expect(promptText(undefined)).toEqual({ text: "", skipped: [] });
  });
});

// ---------------------------------------------------------------------------
// The server, in process
// ---------------------------------------------------------------------------
//
// The same server the CLI test drives as a child process, here with streams
// and a stubbed fetch, so the branches a scripted editor rarely takes — a
// standing approval, a `suggest` routing prompt, a terminal-only slash
// command, a refused cwd — are pinned too. Nothing reaches a network.

/** One ACP conversation against runAcpServer, with a scripted model. */
async function converse(
  script: (body: any, n: number) => { text?: string; tool?: { name: string; args: Record<string, unknown> } },
  answer: (req: any) => unknown,
  drive: (c: {
    request: (method: string, params: unknown) => Promise<any>;
    notify: (method: string, params: unknown) => void;
    updates: any[];
    asked: any[];
  }) => Promise<void>
): Promise<void> {
  const input = new PassThrough();
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  const updates: any[] = [];
  const asked: any[] = [];
  let next = 1;
  const send = (m: unknown) => input.write(JSON.stringify(m) + "\n");
  const write = (line: string) => {
    const msg = JSON.parse(line);
    if (msg.method && msg.id !== undefined) {
      asked.push(msg);
      setImmediate(() => send({ jsonrpc: "2.0", id: msg.id, result: answer(msg) }));
    } else if (msg.method === "session/update") {
      updates.push(msg.params.update);
    } else if (pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      msg.error ? p.fail(new Error(`${msg.error.code} ${msg.error.message}`)) : p.ok(msg.result);
    }
  };

  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const step = script(body, calls++);
    const message = step.tool
      ? {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: `c${calls}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } },
          ],
        }
      : { role: "assistant", content: step.text ?? "OK." };
    const json = { choices: [{ index: 0, message, finish_reason: step.tool ? "tool_calls" : "stop" }] };
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
  }) as unknown as typeof fetch;

  const { runAcpServer } = await import("./acp.js");
  const server = runAcpServer({ input, write, log: () => {} });
  try {
    await drive({
      request: (method, params) =>
        new Promise((ok, fail) => {
          const id = next++;
          pending.set(id, { ok, fail });
          send({ jsonrpc: "2.0", id, method, params });
        }),
      notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
      updates,
      asked,
    });
  } finally {
    input.end();
    await server;
    globalThis.fetch = realFetch;
  }
}

/** A surface with two roles and full auditing, optionally in `suggest` routing. */
function acpSurface(opts: { suggest?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-acp-core-"));
  const g = join(root, ".gnomon");
  mkdirSync(g, { recursive: true });
  writeFileSync(
    join(g, "config.toml"),
    [
      "[defaults]",
      'approval = "on_write"',
      "",
      "[endpoints.local]",
      'url = "http://127.0.0.1:9/v1/chat/completions"',
      'kind = "openai"',
      "",
      "[audit]",
      "enabled = true",
      'record = "full"',
      "",
      ...(opts.suggest
        ? ["[routing]", 'mode = "suggest"', 'default = "implement"', "", "[[routing.rules]]", 'role = "plan"', 'match = "^plan"', 'why = "planning words"', ""]
        : []),
    ].join("\n")
  );
  writeFileSync(
    join(g, "roles.toml"),
    '[roles.implement]\nmodel = "m"\nendpoint = "local"\ntools = ["read", "write"]\n\n' +
      '[roles.plan]\nmodel = "m"\nendpoint = "local"\ntools = ["read"]\n'
  );
  writeFileSync(
    join(g, "tools.toml"),
    '[[tools]]\nname = "read"\ndescription = "r"\nenabled = true\n\n[[tools]]\nname = "write"\ndescription = "w"\nenabled = true\n'
  );
  writeFileSync(join(g, "system.md"), "stub\n");
  return root;
}

const trail = (root: string): any[] => {
  const dir = join(root, ".gnomon-audit");
  return readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

describe("runAcpServer", () => {
  it("a standing 'turn' answer covers the rest of the turn without asking again", async () => {
    const root = acpSurface();
    try {
      await converse(
        (body) => {
          const results = body.messages.filter((m: any) => m.role === "tool").length;
          if (results === 0) return { tool: { name: "write", args: { path: "a.txt", content: "a\n" } } };
          if (results === 1) return { tool: { name: "write", args: { path: "b.txt", content: "b\n" } } };
          return { text: "<think>done thinking</think>Both written." };
        },
        (req) => ({ outcome: { outcome: "selected", optionId: "turn" } }),
        async (c) => {
          await c.request("initialize", { protocolVersion: 1 });
          const s = await c.request("session/new", { cwd: join(root, ".gnomon"), mcpServers: [{ name: "x" }] });
          const r = await c.request("session/prompt", {
            sessionId: s.sessionId,
            prompt: [
              { type: "text", text: "write both" },
              { type: "resource", resource: { uri: "file:///tmp/ctx.md", text: "context" } },
            ],
          });
          expect(r.stopReason).toBe("end_turn");
          expect(c.asked.filter((m) => m.method === "session/request_permission")).toHaveLength(1);
          const texts = c.updates.filter((u) => u.content?.type === "text").map((u) => `${u.sessionUpdate}:${u.content.text}`);
          expect(texts).toContain("agent_message_chunk:Both written.");
          expect(texts).toContain("agent_thought_chunk:done thinking");
          // The editor's MCP servers are named as not connected, never dropped silently.
          expect(texts.some((t) => /does not connect them/.test(t))).toBe(true);
        }
      );
      expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("a\n");
      expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("b\n");
      const approvals = trail(root).filter((r) => r.kind === "approval");
      expect(approvals.map((a) => a.by)).toEqual(["human", "human:standing-turn"]);
      expect(trail(root).at(-1).kind).toBe("session_end");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("a suggest-mode proposal is asked as a mode switch; 'always' switches the session", async () => {
    const root = acpSurface({ suggest: true });
    try {
      await converse(
        () => ({ text: "A plan." }),
        (req) => {
          expect(req.params.toolCall.kind).toBe("switch_mode");
          return { outcome: { outcome: "selected", optionId: "always" } };
        },
        async (c) => {
          await c.request("initialize", { protocolVersion: 1 });
          const s = await c.request("session/new", { cwd: root, mcpServers: [] });
          await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "plan the work" }] });
          expect(c.updates.find((u) => u.sessionUpdate === "current_mode_update")).toMatchObject({ currentModeId: "plan" });
        }
      );
      expect(trail(root).find((r) => r.kind === "turn")).toMatchObject({ role: "plan" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("slash commands, bad sessions, bad cwds and a stray cancel are answered, not crashed on", async () => {
    const root = acpSurface();
    try {
      await converse(
        () => ({ text: "hi" }),
        () => ({}),
        async (c) => {
          await c.request("authenticate", { methodId: "none" });
          await expect(c.request("session/new", { cwd: "relative", mcpServers: [] })).rejects.toThrow(/-32602/);
          await expect(c.request("session/prompt", { sessionId: "nope", prompt: [] })).rejects.toThrow(/-32002/);
          const s = await c.request("session/new", { cwd: root, mcpServers: [] });
          const say = async (text: string) => {
            const before = c.updates.length;
            await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text }] });
            return c.updates.slice(before).filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");
          };
          expect(await say("/help")).toMatch(/terminal command/);
          expect(await say("/plan")).toMatch(/Say what to do after \/plan/);
          expect((await c.request("session/prompt", { sessionId: s.sessionId, prompt: [] })).stopReason).toBe("end_turn");
          c.notify("session/cancel", { sessionId: s.sessionId });
          expect(await say("/plan look around")).toBe("hi");
        }
      );
      expect(trail(root).find((r) => r.kind === "turn")).toMatchObject({ role: "plan" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("JsonRpcPeer", () => {
  const pair = () => {
    const input = new PassThrough();
    const out: any[] = [];
    const peer = new JsonRpcPeer(input, (line) => {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n");
      out.push(JSON.parse(line));
    });
    const tick = () => new Promise((r) => setTimeout(r, 10));
    return { input, out, peer, tick };
  };

  it("answers a request, an unknown method, a handler's error and a bad line", async () => {
    const { input, out, peer, tick } = pair();
    peer.onRequest("echo", async (p) => p);
    peer.onRequest("boom", async () => {
      throw new RpcFailure(RPC_ERROR.INVALID_PARAMS, "bad");
    });
    input.write('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"a":1}}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"nope"}\n');
    input.write('{"jsonrpc":"2.0","id":"x","method":"boom"}\n');
    input.write("not json\n");
    await tick();
    expect(out).toContainEqual({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
    expect(out.find((m) => m.id === 2).error.code).toBe(RPC_ERROR.METHOD_NOT_FOUND);
    expect(out.find((m) => m.id === "x").error).toEqual({ code: RPC_ERROR.INVALID_PARAMS, message: "bad" });
    expect(out.find((m) => m.id === null).error.code).toBe(RPC_ERROR.PARSE);
  });

  it("handles a notification while a request is still open, and resolves its own requests", async () => {
    const { input, out, peer, tick } = pair();
    let release!: () => void;
    let cancelled = false;
    peer.onRequest("slow", () => new Promise((r) => (release = () => r("done"))));
    peer.onNotification("cancel", () => (cancelled = true));
    input.write('{"jsonrpc":"2.0","id":1,"method":"slow"}\n');
    input.write('{"jsonrpc":"2.0","method":"cancel"}\n');
    await tick();
    expect(cancelled).toBe(true);

    const asked = peer.request("ask", { q: 1 });
    await tick();
    const sent = out.find((m) => m.method === "ask");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { a: 2 } }) + "\n");
    await expect(asked).resolves.toEqual({ a: 2 });

    release();
    await tick();
    expect(out).toContainEqual({ jsonrpc: "2.0", id: 1, result: "done" });
  });

  it("fails what is still pending when the input closes", async () => {
    const { input, peer } = pair();
    const asked = peer.request("ask", {});
    input.end();
    await expect(asked).rejects.toThrow(/closed/);
    await peer.closed;
  });
});

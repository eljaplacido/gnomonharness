import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { connectMcp, mcpToolName } from "./mcp.js";
import { loadConfig } from "./config.js";

// A minimal MCP stdio server: reads newline-delimited JSON-RPC, answers
// initialize / tools/list / tools/call. Runs via `node -e`, so the test
// exercises the real spawn + protocol path, not a stub.
const MOCK_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ] } });
  } else if (m.method === 'tools/call') {
    const text = (m.params && m.params.arguments && m.params.arguments.text) || '';
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo: ' + text }], isError: false } });
  }
});
`;

// Reports whether two env vars reached the child, so the test can prove the
// declared-only forwarding contract instead of trusting it.
const ENV_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const has = (k) => process.env[k] === undefined ? 'ABSENT' : 'PRESENT';
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'env', version: '1' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [ { name: 'report', description: 'report env', inputSchema: { type: 'object' } } ] } });
  } else if (m.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'DECLARED=' + has('GNOMON_MCP_DECLARED') + ' SECRET=' + has('GNOMON_MCP_SECRET') }], isError: false } });
  }
});
`;

// Same mock, with the initialize result's protocolVersion under the test's
// control: pass null to omit the field entirely, the way a server that does not
// send it would answer. The three cases below are the three the client has to
// tell apart -- an answer it knows, one it does not, and no answer at all.
const versionServer = (version: string | null) => `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { ${
      version === null ? "" : `protocolVersion: ${JSON.stringify(version)},`
    } capabilities: {}, serverInfo: { name: 'v', version: '1' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [ { name: 'ping', inputSchema: { type: 'object' } } ] } });
  }
});
`;

// Refuses the handshake with a JSON-RPC error and then says nothing more --
// what a server that will not accept the version we asked for looks like.
const REFUSING_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unsupported protocol version' } });
  }
});
`;

describe("mcp", () => {
  it("connects a stdio server, discovers its tools, and routes a call", async () => {
    const reg = await connectMcp({
      mock: { transport: "stdio", command: "node", args: ["-e", MOCK_SERVER] },
    });
    try {
      expect(reg.tools().map((t) => t.name)).toContain(mcpToolName("mock", "echo"));
      const r = await reg.call(mcpToolName("mock", "echo"), { text: "hi" });
      expect(r.isError).toBe(false);
      expect(r.content).toBe("echo: hi");
    } finally {
      reg.close();
    }
  });

  it("skips — does not throw on — a server that will not start", async () => {
    const reports: string[] = [];
    const reg = await connectMcp(
      { bad: { transport: "stdio", command: "gnomon-no-such-command-xyz" } },
      (l) => reports.push(l)
    );
    expect(reg.tools()).toHaveLength(0);
    expect(reports.some((r) => /bad.*unavailable/.test(r))).toBe(true);
    reg.close();
  });

  it("declines a transport this build does not wire", async () => {
    const reports: string[] = [];
    const reg = await connectMcp(
      { remote: { transport: "http", command: "x" } },
      (l) => reports.push(l)
    );
    expect(reg.tools()).toHaveLength(0);
    expect(reports.some((r) => /stdio only|unavailable/.test(r))).toBe(true);
    reg.close();
  });

  it("returns a clean error for an unconnected tool rather than throwing", async () => {
    const reg = await connectMcp(undefined);
    const r = await reg.call(mcpToolName("nope", "x"), {});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not connected/i);
    reg.close();
  });

  it("forwards only the declared env vars, not the whole environment", async () => {
    // A stored provider key would sit in process.env; the surface declares
    // which names a server may see. The child must get the declared name and
    // NOT the undeclared secret — the `env` list is a filter, not an add-on.
    process.env.GNOMON_MCP_DECLARED = "yes";
    process.env.GNOMON_MCP_SECRET = "do-not-leak";
    try {
      const reg = await connectMcp({
        env: {
          transport: "stdio",
          command: "node",
          args: ["-e", ENV_SERVER],
          env: ["GNOMON_MCP_DECLARED"],
        },
      });
      try {
        const r = await reg.call(mcpToolName("env", "report"), {});
        expect(r.isError).toBe(false);
        expect(r.content).toContain("DECLARED=PRESENT");
        expect(r.content).toContain("SECRET=ABSENT");
      } finally {
        reg.close();
      }
    } finally {
      delete process.env.GNOMON_MCP_DECLARED;
      delete process.env.GNOMON_MCP_SECRET;
    }
  });
});

// ---------------------------------------------------------------------------
// The canary: a declared server's tool has to reach the model from BOTH entry
// points.
//
// What this replaced, and why: these two entry points used to be covered by
// `expect(String(runTask)).toContain("connectMcp")` and
// `.toContain("state.mcp?.close()")`. A grep over a function's source cannot
// see whether the call is REACHED, whether the registry is passed to
// buildToolSet, or whether the tool survives role gating -- and it says nothing
// at all about the other entry point. Measured against the real prompt_loop.ts:
// deleting the `if (config.tools.mcp_servers …) state.mcp = await connectMcp(…)`
// block from runPromptLoop left the whole suite green, which is exactly how
// the original defect (MCP wired into the interactive loop only) shipped.
//
// So each entry point now gets one behavioural canary: a surface declares a
// real stdio server, the model is offered its tool, calls it, and the server's
// answer comes back. A string no model would invent is the evidence.
// ---------------------------------------------------------------------------

/**
 * A stdio MCP server on disk, named from tools.toml the way a real one is:
 * `command = "node"`, `args = ["<path>"]`. Its one tool echoes a marker.
 */
const CANARY_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'canary', version: '1' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'stamp', description: 'stamp a marker', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ] } });
  } else if (m.method === 'tools/call') {
    const text = (m.params && m.params.arguments && m.params.arguments.text) || '';
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'MCP-CANARY-STAMPED:' + text }], isError: false } });
  }
});
`;

/** Surfaces built by mcpSurface(), removed after each canary test. */
const surfaces: string[] = [];

/**
 * A minimal surface that declares the canary server.
 *
 * `approval = "never"`: an MCP call is gated like a mutating built-in under
 * on_write, and a prompt is not what these tests are about.
 */
function mcpSurface(): string {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-mcp-canary-"));
  surfaces.push(dir);
  mkdirSync(join(dir, ".gnomon"), { recursive: true });
  const server = join(dir, "canary-server.cjs");
  writeFileSync(server, CANARY_SERVER);
  const put = (name: string, body: string) => writeFileSync(join(dir, ".gnomon", name), body);

  put(
    "config.toml",
    `[defaults]
approval = "never"
sandbox = "off"
compaction = "discard"

[routing]
mode = "manual"
default = "implement"

[endpoints.local]
url = "http://127.0.0.1:9/api/chat"
kind = "ollama"
`
  );
  // No \`tools\` key on the role: an MCP tool is gated per role like any other,
  // and a role that narrows its list would be testing the gate rather than the
  // wiring.
  put("roles.toml", '[roles.implement]\nmodel = "MODEL-implement"\n');
  put(
    "tools.toml",
    `[[tools]]
name = "read"
description = "Read a file as numbered lines, or list a directory."
enabled = true

[mcp_servers.canary]
transport = "stdio"
command = "node"
args = ["${server}"]
`
  );
  put("policy.toml", "");
  put("system.md", "You are under test.\n");
  return dir;
}

/**
 * Replace fetch for the duration of `run`, recording every request body.
 *
 * `run` is handed the live array so a test can wait on what the loop has
 * already asked before it does the next thing.
 */
async function withFetch(
  impl: (body: Record<string, unknown>, call: number) => unknown,
  run: (bodies: Record<string, unknown>[]) => Promise<void>
): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    return impl(body, bodies.length);
  }) as unknown as typeof fetch;
  try {
    await run(bodies);
  } finally {
    globalThis.fetch = original;
  }
  return bodies;
}

/** Poll until `ready`, or fail loudly rather than hanging out the clock. */
async function waitFor(ready: () => boolean, what: string, ms = 10000): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Call the canary on the first request, then conclude. */
const callsTheCanary = (_body: Record<string, unknown>, call: number) =>
  ({
    ok: true,
    json: async () => ({
      message: {
        content: call === 1 ? "" : "done",
        tool_calls:
          call === 1
            ? [{ function: { name: "mcp__canary__stamp", arguments: { text: "hello" } } }]
            : undefined,
      },
    }),
  }) as unknown as Response;

/** The tool names offered in one request. */
const offered = (body: Record<string, unknown>): string[] =>
  ((body.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);

describe("a declared MCP server reaches the model from every entry point", () => {
  afterEach(() => {
    for (const dir of surfaces.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it(
    "`gnomon task` offers the tool, routes the call, and returns the server's answer",
    async () => {
      // The measured defect: connectMcp was called only from runPromptLoop, so
      // a surface declaring [mcp_servers] handed its tools to `gnomon prompt`
      // and NOT to `gnomon task` -- same surface, same hash, two tool sets
      // depending on the entry point. The model answered "no tool named
      // mcp__canary__stamp available" on a surface that declared it.
      const dir = mcpSurface();
      const { runTask } = await import("./prompt_loop.js");
      let record!: Awaited<ReturnType<typeof runTask>>;

      const bodies = await withFetch(callsTheCanary, async () => {
        record = await runTask(loadConfig(dir), "stamp it", { role: "implement", yes: true });
      });


      // 1. The tool was in the set the model was shown.
      expect(offered(bodies[0])).toContain(mcpToolName("canary", "stamp"));
      // 2. The call reached the spawned server and its answer came back: the
      //    marker is in the tool result the next request carries.
      expect(bodies.length).toBeGreaterThan(1);
      expect(JSON.stringify(bodies[1].messages)).toContain("MCP-CANARY-STAMPED:hello");
      // 3. And the record says the call happened, rather than being refused.
      expect(record.tool_log.join(" ")).toContain("mcp__canary__stamp");
      expect(record.tool_log.join(" ")).not.toContain("no MCP server is connected");
    },
    20000
  );

  it(
    "`gnomon prompt` does the same, over the interactive loop",
    async () => {
      // Driven through the io seam the way loop_chain.test.ts drives it: EOF
      // rather than /quit, because /quit calls process.exit and a test cannot
      // let that happen. console is captured so the loop's own output does not
      // land in the runner's.
      const dir = mcpSurface();
      const { runPromptLoop } = await import("./prompt_loop.js");
      const realLog = console.log;
      const realError = console.error;
      const realExit = process.exit;
      const printed: string[] = [];
      console.log = (...a: unknown[]) => printed.push(a.map(String).join(" "));
      console.error = (...a: unknown[]) => printed.push(a.map(String).join(" "));
      process.exit = ((code?: number) => {
        throw new Error(`runPromptLoop exited(${code}):\n${printed.join("\n")}`);
      }) as typeof process.exit;

      try {
        const bodies = await withFetch(callsTheCanary, async (seen) => {
          const input = new PassThrough();
          const output = new Writable({ write(_c, _e, cb) { cb(); } });
          const done = runPromptLoop(loadConfig(dir), "implement", { io: { input, output } });
          // Two pieces of timing, both measured rather than guessed:
          //
          // 1. The loop registers its readline "line" and "close" handlers
          //    AFTER awaiting connectMcp. A line written in the same tick as
          //    the call is emitted into a readline with no listener, is lost,
          //    and the session then waits forever for input that already came
          //    and went -- measured as a 20s test timeout with the startup
          //    banner printed and no request made. Waiting for the banner puts
          //    the write after the handlers exist.
          await waitFor(
            () => printed.some((l) => l.includes("MCP:")),
            "the loop's startup banner"
          );
          input.write("stamp it\n");
          // 2. readline's "close" handler calls state.mcp?.close(). Ending the
          //    stream before the turn has made its MCP call races the server's
          //    shutdown against the call, so end it once the turn has come back
          //    to the model -- which is what an operator pressing Ctrl-D after
          //    an answer does anyway.
          await waitFor(() => seen.length >= 2, "the turn's second request");
          input.end();
          await done;
        });

        expect(offered(bodies[0])).toContain(mcpToolName("canary", "stamp"));
        expect(bodies.length).toBeGreaterThan(1);
        expect(JSON.stringify(bodies[1].messages)).toContain("MCP-CANARY-STAMPED:hello");
      } finally {
        console.log = realLog;
        console.error = realError;
        process.exit = realExit;
      }
    },
    20000
  );
});

describe("mcp protocol version", () => {
  // The finding: the client sent protocolVersion "2024-11-05" and never read
  // what the server answered, so every one of these four servers produced the
  // same connection line and a mismatch could only surface later, as some other
  // call's timeout.

  it("reports the version when the server agrees with what we asked for", async () => {
    const reports: string[] = [];
    const reg = await connectMcp(
      { v: { transport: "stdio", command: "node", args: ["-e", versionServer("2024-11-05")] } },
      (l) => reports.push(l)
    );
    try {
      const line = reports.find((r) => /^\s*mcp: v connected/.test(r)) ?? "";
      expect(line).toContain("protocol 2024-11-05");
      // Quiet when there is nothing to say: no "asked", no UNKNOWN.
      expect(line).not.toContain("asked");
      expect(line).not.toContain("UNKNOWN");
      expect(reg.protocols()).toEqual([{ server: "v", version: "2024-11-05", known: true }]);
      expect(reg.tools()).toHaveLength(1);
    } finally {
      reg.close();
    }
  });

  it("reports a newer known version, and names the one it asked for", async () => {
    const reports: string[] = [];
    const reg = await connectMcp(
      { v: { transport: "stdio", command: "node", args: ["-e", versionServer("2025-06-18")] } },
      (l) => reports.push(l)
    );
    try {
      const line = reports.find((r) => /^\s*mcp: v connected/.test(r)) ?? "";
      expect(line).toContain("protocol 2025-06-18 (asked 2024-11-05)");
      expect(line).not.toContain("UNKNOWN");
      expect(reg.protocols()).toEqual([{ server: "v", version: "2025-06-18", known: true }]);
      // A known revision is a working server: its tools still reach the model.
      expect(reg.tools().map((t) => t.name)).toContain(mcpToolName("v", "ping"));
    } finally {
      reg.close();
    }
  });

  it("says UNKNOWN — and still connects — when the version is outside the known range", async () => {
    // The recorded decision is to proceed, not to skip, because the accepted
    // list goes stale by design. This test pins BOTH halves of that: the
    // diagnostic is printed, and the server is not thrown away over a string.
    const reports: string[] = [];
    const reg = await connectMcp(
      { v: { transport: "stdio", command: "node", args: ["-e", versionServer("2099-01-01")] } },
      (l) => reports.push(l)
    );
    try {
      const line = reports.find((r) => /^\s*mcp: v connected/.test(r)) ?? "";
      expect(line).toContain("2099-01-01");
      expect(line).toContain("UNKNOWN to this build");
      expect(line).toContain("asked 2024-11-05");
      expect(line).toContain("proceeding");
      expect(reg.protocols()).toEqual([{ server: "v", version: "2099-01-01", known: false }]);
      expect(reg.tools()).toHaveLength(1);
    } finally {
      reg.close();
    }
  });

  it("says UNREPORTED when the server omits protocolVersion entirely", async () => {
    // The field is required by the protocol, so its absence is a finding in its
    // own right -- recorded as null rather than defaulted to what we asked for,
    // which would have made a silent server indistinguishable from an agreeing
    // one, the same conflation the pinned version caused.
    const reports: string[] = [];
    const reg = await connectMcp(
      { v: { transport: "stdio", command: "node", args: ["-e", versionServer(null)] } },
      (l) => reports.push(l)
    );
    try {
      const line = reports.find((r) => /^\s*mcp: v connected/.test(r)) ?? "";
      expect(line).toContain("protocol UNREPORTED by the server");
      expect(line).toContain("asked 2024-11-05");
      expect(reg.protocols()).toEqual([{ server: "v", version: null, known: false }]);
      expect(reg.tools()).toHaveLength(1);
    } finally {
      reg.close();
    }
  });

  it("blames initialize, not tools/list, when the server refuses the handshake", async () => {
    // Before: the JSON-RPC error on initialize was never inspected, the client
    // sent tools/list into a server that had already refused it, and the
    // operator was told "tools/list timed out after 8000ms" -- wrong call
    // named, version never mentioned. The 8s wait is also why this test would
    // now blow vitest's default 5s timeout if the check regressed.
    const reports: string[] = [];
    const reg = await connectMcp(
      { v: { transport: "stdio", command: "node", args: ["-e", REFUSING_SERVER] } },
      (l) => reports.push(l)
    );
    try {
      const line = reports.find((r) => /^\s*mcp: v unavailable/.test(r)) ?? "";
      expect(line).toContain("initialize refused");
      expect(line).toContain("asked for protocol 2024-11-05");
      expect(line).toContain("Unsupported protocol version");
      expect(line).not.toContain("tools/list");
      // The surrounding design is preserved: named and skipped, never fatal.
      expect(reg.tools()).toHaveLength(0);
      expect(reg.protocols()).toEqual([]);
    } finally {
      reg.close();
    }
  });
});

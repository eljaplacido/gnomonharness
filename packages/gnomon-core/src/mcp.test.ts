import { describe, it, expect } from "vitest";
import { connectMcp, mcpToolName } from "./mcp.js";

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

describe("MCP reaches the non-interactive entry point too", () => {
  it("connects declared servers in `gnomon task`, not only in `gnomon prompt`", async () => {
    // connectMcp was called only from runPromptLoop, so a surface declaring
    // [mcp_servers] gave its tools to the interactive loop and NOT to
    // `gnomon task` -- same surface, same hash, two tool sets depending on the
    // entry point. Measured against a real server: the model answered "no tool
    // named mcp__canary__stamp available" on a surface that declared it.
    const { runTask } = await import("./prompt_loop.js");
    const src = String(runTask);
    expect(src).toContain("connectMcp");
    // ...and lets it go again: `gnomon task` is run in loops by scripts.
    expect(src).toContain("state.mcp?.close()");
  });
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

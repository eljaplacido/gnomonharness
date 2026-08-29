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
});

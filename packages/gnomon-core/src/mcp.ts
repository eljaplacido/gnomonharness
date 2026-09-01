/**
 * gnomon-core: a minimal MCP (Model Context Protocol) client.
 *
 * MCP lets a pinned external server hand the model tools gnomon does not
 * implement itself. This build speaks the **stdio** transport only: it spawns
 * the server, exchanges newline-delimited JSON-RPC, discovers its tools with
 * `tools/list`, and forwards the model's calls with `tools/call`.
 *
 * The tension with gnomon's determinism is deliberate and bounded: the surface
 * pins the server's *invocation* (command/args), not its behaviour. So the
 * client's job is to be loud — report which servers connected, which protocol
 * revision each one answered with, and what tools they offered — and never to
 * crash the loop when a server is missing or slow. A server that will not
 * connect is skipped and named, not fatal.
 *
 * No dependencies: the protocol is a few JSON-RPC messages over a pipe.
 */

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerDef } from "./config.js";

/**
 * The revision this client ASKS for. Left pinned at the one these message
 * shapes were written against: every later revision only adds things this
 * client does not use over stdio (batching removal, elicitation, an HTTP
 * header), so asking for a newer one would be a wire change with nothing here
 * able to test it. Not verified against any real server -- the only servers
 * exercised for this change are the mocks in mcp.test.ts.
 *
 * What changed is the other half of the handshake: the server's answer is now
 * read instead of discarded.
 */
const PROTOCOL_VERSION = "2024-11-05";

/**
 * The revisions this build recognises in an `initialize` result.
 *
 * The failure that produced this list: the client sent `protocolVersion` and
 * never looked at what came back, so a server answering a revision we had never
 * heard of produced a connection line identical to one answering ours. Measured
 * against the mock servers in mcp.test.ts: before this change, servers replying
 * 2024-11-05, 2099-01-01, and no version at all were indistinguishable in the
 * report -- a mismatch could only surface later, as some other call failing.
 *
 * This list is what the build knew when it shipped and WILL go stale. That is
 * exactly why an unrecognised version is printed rather than treated as fatal;
 * see the decision recorded in connect() below.
 */
const KNOWN_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

const CONNECT_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 60_000;

/** A discovered tool, named for the model as `mcp__<server>__<tool>`. */
export interface McpToolInfo {
  /** The offered name: `mcp__<server>__<tool>`. */
  name: string;
  /** The server it came from. */
  server: string;
  /** The bare tool name on the server. */
  tool: string;
  description?: string;
  /** JSON Schema for the arguments, straight from the server. */
  inputSchema: Record<string, unknown>;
}

/** What the loop holds: the discovered tools, a call router, and a shutdown. */
export interface McpRegistry {
  tools(): McpToolInfo[];
  /** Route an `mcp__…` call to its server. */
  call(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  /**
   * What each connected server answered with in `initialize`. Recorded on the
   * registry so the negotiated revision can be reported after connect time too
   * -- the connection line scrolls away, a stale session does not.
   */
  protocols(): Array<{ server: string; version: string | null; known: boolean }>;
  close(): void;
}

/** The `mcp__server__tool` name for a discovered tool. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** One line of JSON-RPC. */
interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A single spawned stdio server, mid-protocol. */
class McpConnection {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buf = "";
  tools: McpToolInfo[] = [];
  /**
   * What the server answered with in `initialize`, or null when it omitted the
   * field. The spec requires the field, so null is itself worth printing rather
   * than smoothing over.
   */
  protocolVersion: string | null = null;
  /** Whether that answer is one of KNOWN_PROTOCOL_VERSIONS. */
  protocolKnown = false;

  constructor(
    public readonly name: string,
    private readonly def: McpServerDef
  ) {}

  /** Spawn, initialize, and list tools. Throws on any failure; caller skips. */
  async connect(): Promise<void> {
    if ((this.def.transport ?? "stdio") !== "stdio") {
      throw new Error(`transport "${this.def.transport}" is not wired by this build (stdio only)`);
    }
    if (!this.def.command) throw new Error("no command to spawn");

    // Do NOT hand a third-party server the full process environment: it would
    // inherit every provider key and every secret applyCredentials() loaded
    // into process.env. The `env` list is a filter, not an add-on — forward
    // only the names the surface declared, over a minimal base the child needs
    // to find its own runtime (spawn defaults to the full env when unset, so
    // this object must be passed explicitly below to take effect).
    const env: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
                     "SystemRoot", "PATHEXT", "APPDATA", "LOCALAPPDATA"]) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    for (const varName of this.def.env ?? []) {
      const v = process.env[varName];
      if (v !== undefined) env[varName] = v;
    }

    const proc = spawn(this.def.command, this.def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;
    proc.on("error", (err) => this.failAll(err));
    proc.on("exit", () => this.failAll(new Error(`${this.name} exited`)));
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    // The server's own logging goes to stderr; keep it out of the protocol.
    proc.stderr.resume();

    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "gnomon", version: "0.1.0" },
    });
    // A JSON-RPC error on initialize was not checked at all. Measured against a
    // mock that refuses initialize and then goes quiet: the client went on to
    // send tools/list and hung there past the test's 5s cap, on its way to the
    // 8s CONNECT_TIMEOUT_MS -- so the operator waited 8s to be told the wrong
    // call had timed out, with the refused handshake never mentioned. Name the
    // refusal and the version we asked for; a rejected version is the likeliest
    // cause, though the server's message is the only evidence of which it was.
    if (init.error) {
      throw new Error(
        `initialize refused (asked for protocol ${PROTOCOL_VERSION}): ${init.error.message}`
      );
    }
    const initResult = init.result as { protocolVersion?: unknown } | undefined;
    this.protocolVersion =
      typeof initResult?.protocolVersion === "string" ? initResult.protocolVersion : null;
    this.protocolKnown =
      this.protocolVersion !== null && KNOWN_PROTOCOL_VERSIONS.has(this.protocolVersion);

    // DECISION: an unrecognised (or missing) version is reported, not skipped.
    // Reasoning, not measurement -- no server answering an unknown version was
    // available to test against. Skipping would cost the whole server on a
    // string comparison against a list that goes stale by design, and the three
    // messages this client actually sends (initialize, tools/list, tools/call)
    // have kept their shapes across every published revision. Proceeding fails
    // visibly if the guess is wrong -- tools/list returns nothing, or a call
    // comes back isError -- whereas skipping fails silently and permanently.
    // The report line below is what makes the guess auditable; without it this
    // would be exactly the silent degradation the pinned version already was.
    this.notify("notifications/initialized", {});

    const listed = (await this.request("tools/list", {})).result as
      | { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }
      | undefined;
    this.tools = (listed?.tools ?? []).map((t) => ({
      name: mcpToolName(this.name, t.name),
      server: this.name,
      tool: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  /**
   * The protocol phrase for the connection line. Loud in exactly the two cases
   * an operator needs to see -- an answer this build does not know, and no
   * answer at all -- and quiet when the server agreed with what we asked for.
   */
  protocolNote(): string {
    if (this.protocolVersion === null) {
      return `protocol UNREPORTED by the server (asked ${PROTOCOL_VERSION}), proceeding`;
    }
    if (!this.protocolKnown) {
      return `protocol ${this.protocolVersion} UNKNOWN to this build (asked ${PROTOCOL_VERSION}), proceeding`;
    }
    if (this.protocolVersion !== PROTOCOL_VERSION) {
      return `protocol ${this.protocolVersion} (asked ${PROTOCOL_VERSION})`;
    }
    return `protocol ${this.protocolVersion}`;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const m = await this.request("tools/call", { name: tool, arguments: args }, CALL_TIMEOUT_MS);
    if (m.error) return { content: `MCP error: ${m.error.message}`, isError: true };
    const res = m.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
    const text = (res?.content ?? [])
      .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
      .join("\n");
    return { content: text || "(no content)", isError: Boolean(res?.isError) };
  }

  close(): void {
    this.failAll(new Error("closed"));
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      // Killing the child is not enough to let node exit. Its three pipes are
      // live libuv handles and the stdout listener holds a reference, so the
      // event loop stays alive with nothing to run. Measured: `gnomon prompt`
      // on a surface declaring one MCP server never returned from /quit -- the
      // loop had exited, the terminal was simply hung -- while the same
      // surface without the server exited immediately.
      //
      // This is the same shape as the bash tool's releasePipes(): end stdin so
      // a well-behaved server can leave on EOF, drop the listeners, destroy
      // the streams, then signal and unref whatever is left.
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.stdin?.end();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.stdin?.destroy();
      proc.kill();
      proc.unref();
    } catch {
      /* already gone */
    }
  }

  private request(method: string, params: unknown, timeoutMs = CONNECT_TIMEOUT_MS): Promise<RpcMessage> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc?.stdin.write(line);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      /* the exit handler will fail the pending requests */
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const raw = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!raw) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(raw) as RpcMessage;
      } catch {
        continue; // not a JSON-RPC line (stray server output on stdout)
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
      // Server-initiated requests/notifications are ignored: this client
      // declares no capabilities, so there is nothing for it to answer.
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Connect every declared MCP server, skipping (and reporting) any that fail.
 * Returns a registry the loop routes calls through. `report` is called once per
 * server with the outcome, so a missing server is visible, never silent.
 */
export async function connectMcp(
  defs: Record<string, McpServerDef> | undefined,
  report: (line: string) => void = () => {}
): Promise<McpRegistry> {
  const conns: McpConnection[] = [];
  const byTool = new Map<string, McpConnection>();

  for (const [name, def] of Object.entries(defs ?? {})) {
    const conn = new McpConnection(name, def);
    try {
      await conn.connect();
      conns.push(conn);
      for (const t of conn.tools) byTool.set(t.name, conn);
      report(
        `  mcp: ${name} connected — ${conn.protocolNote()} — ${conn.tools.length} tool(s): ` +
          `${conn.tools.map((t) => t.tool).join(", ") || "(none)"}`
      );
    } catch (err) {
      conn.close();
      report(`  mcp: ${name} unavailable — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    tools: () => conns.flatMap((c) => c.tools),
    protocols: () =>
      conns.map((c) => ({ server: c.name, version: c.protocolVersion, known: c.protocolKnown })),
    async call(name, args) {
      const conn = byTool.get(name);
      if (!conn) return { content: `MCP tool "${name}" is not connected.`, isError: true };
      const bare = conn.tools.find((t) => t.name === name)?.tool ?? name;
      try {
        return await conn.callTool(bare, args);
      } catch (err) {
        return { content: `MCP call failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
    close() {
      for (const c of conns) c.close();
    },
  };
}

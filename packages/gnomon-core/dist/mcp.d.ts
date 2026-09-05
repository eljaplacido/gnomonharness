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
import type { McpServerDef } from "./config.js";
import { type DegradationSink } from "./degradation.js";
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
    call(name: string, args: Record<string, unknown>): Promise<{
        content: string;
        isError: boolean;
    }>;
    /**
     * What each connected server answered with in `initialize`. Recorded on the
     * registry so the negotiated revision can be reported after connect time too
     * -- the connection line scrolls away, a stale session does not.
     */
    protocols(): Array<{
        server: string;
        version: string | null;
        known: boolean;
    }>;
    close(): void;
}
/** The `mcp__server__tool` name for a discovered tool. */
export declare function mcpToolName(server: string, tool: string): string;
/**
 * Connect every declared MCP server, skipping (and reporting) any that fail.
 * Returns a registry the loop routes calls through. `report` is called once per
 * server with the outcome, so a missing server is visible, never silent.
 */
export declare function connectMcp(defs: Record<string, McpServerDef> | undefined, report?: (line: string) => void, audit?: DegradationSink): Promise<McpRegistry>;
//# sourceMappingURL=mcp.d.ts.map
/**
 * gnomon-core: the tool definitions a model was offered, hashed (GV10).
 *
 * DESIGN.md's claim is "if behaviour changed, the hash changed", and the
 * surface hash carries it for everything in `.gnomon/`. Two inputs to what the
 * model sees were outside it:
 *
 *   - built-in parameter schemas live in this build's code. `harness` names
 *     the build, but a record could not say WHICH definitions a turn sent;
 *   - an MCP server's `tools/list` is whatever the server answers when the
 *     session opens. The surface pins the server's command, not its tools, so
 *     a server whose descriptions changed between two sessions -- an upgrade,
 *     or a "rug pull" (tool poisoning after approval) -- moved nothing any
 *     record carried.
 *
 * So a turn record's `wire` now carries `tools_hash`, over the definitions the
 * turn offered, and each MCP server's definitions are hashed at connect and
 * compared with what this machine pinned for that server (trust.ts). Hashing
 * reads the definitions; it never changes what is sent.
 *
 * The hash is sha256 over the canonical JSON (keys sorted, no whitespace,
 * audit.ts canonicalJson -- the one canonicaliser the chain and attestation
 * already use) of the definitions sorted by name. Sorted because the same set
 * offered in another order is the same set: an MCP server may list its tools
 * in any order between two runs. Arrays INSIDE a definition (`required`, an
 * enum) keep their order -- that is part of what was sent.
 */

import { createHash } from "node:crypto";
import { canonicalJson, type AuditKind } from "./audit.js";
import type { GnomonConfig, McpServerDef } from "./config.js";
import type { ToolSchema } from "./tools.js";
import type { McpRegistry, McpToolInfo } from "./mcp.js";
import { checkToolPins, clampForChangedTools, mcpGrantKey, type ToolPinCheck } from "./trust.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const byName = <T>(name: (x: T) => string) => (a: T, b: T): number =>
  name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0;

/** The definitions a turn offered the model, hashed. `[]` hashes too: no tools is a fact. */
export function toolsHash(schemas: readonly ToolSchema[]): string {
  return sha256(canonicalJson([...schemas].sort(byName((s) => s.function.name))));
}

/**
 * One MCP server's `tools/list`, hashed as the server gave it: bare names,
 * descriptions, input schemas. Not the `mcp__<server>__` names gnomon offers,
 * so renaming a server in the surface does not read as its tools changing --
 * that is a surface change, and the surface hash already says so.
 */
export function mcpToolsHash(tools: readonly McpToolInfo[]): string {
  return sha256(
    canonicalJson(
      [...tools]
        .map((t) => ({ name: t.tool, description: t.description, inputSchema: t.inputSchema }))
        .sort(byName((t) => t.name))
    )
  );
}

/** Each connected server's identity and the hash of what it offered. */
export function mcpServerHashes(
  defs: Record<string, McpServerDef> | undefined,
  registry: McpRegistry
): Array<{ server: string; key: string; tools: number; tools_hash: string }> {
  const tools = registry.tools();
  // protocols() lists every server that connected, including one that offered
  // no tools -- an empty list is a list, and pinning it catches tools appearing.
  return registry.protocols().map(({ server }) => {
    const mine = tools.filter((t) => t.server === server);
    return { server, key: mcpGrantKey(server, defs?.[server]), tools: mine.length, tools_hash: mcpToolsHash(mine) };
  });
}

/**
 * At session start, after MCP servers connect: hash what each offered, compare
 * with this machine's pins (first contact pins it), record the outcome as an
 * `mcp_tools` audit record, and -- when a server offers something other than
 * its pin -- close the servers and hand back the clamp the caller applies.
 * Nothing is recorded, and nothing changes, for a session with no servers.
 */
export function settleMcpTools(
  config: GnomonConfig,
  registry: McpRegistry | undefined,
  audit: { write: (kind: AuditKind, fields: Record<string, unknown>) => void } | undefined,
  path?: string
): { checks: ToolPinCheck[]; clamp?: ReturnType<typeof clampForChangedTools> } {
  if (!registry) return { checks: [] };
  const servers = mcpServerHashes(config.tools.mcp_servers, registry);
  const checks = path === undefined ? checkToolPins(config, servers) : checkToolPins(config, servers, path);
  if (checks.length > 0) audit?.write("mcp_tools", { servers: checks });
  const changed = checks.filter((c) => c.pin === "changed");
  if (changed.length === 0) return { checks };
  registry.close();
  return { checks, clamp: clampForChangedTools(config, changed) };
}

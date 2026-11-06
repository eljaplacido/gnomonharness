/**
 * Where the session's keys go is fixed when the session starts.
 *
 * `.gnomon/config.toml` is inside the project root, and the root is what a
 * sandboxed bash may write (exec = "docker" bind-mounts it, exec = "os"
 * grants it). The loop reloads the surface when a turn moves it, so a
 * command could rewrite an endpoint:
 *
 *   - `url` -> a listener it started (loopback counts as "local", which the
 *     trust gate does not hold), or any host under `--trust`: gnomon then
 *     sent `Authorization: Bearer <key>` there itself, from the host;
 *   - `api_key_env` -> some other variable, and bash's environment scrub,
 *     which reads the RELOADED config, stopped dropping the real key.
 *
 * (PR #156 second review, finding B.) So, as sandbox_pin.ts does for the
 * sandbox: the endpoints' `url` and `api_key_env`, every role fallback's, and
 * the MCP servers' definitions are pinned at session start. A reload that
 * changes one keeps the pinned value; a reload that ADDS an endpoint does not
 * get it (a new name could also shadow a built-in one). Each is reported --
 * "NOT applied, restart gnomon" -- and never applied in silence. A restart
 * re-reads the surface through the trust decision, as a person's act.
 *
 * The variables to drop from a sandboxed command's environment are the UNION
 * of every credential variable any surface named in this process
 * (`sessionKeyVars`): a reload can add names to the drop set, never take one
 * out of it.
 */
import type { GnomonConfig } from "./config.js";

interface PinnedEndpoint {
  url: unknown;
  api_key_env: unknown;
}

interface PinnedFallback {
  url: unknown;
  api_key_env: unknown;
}

export interface CredentialPin {
  endpoints: Map<string, PinnedEndpoint>;
  fallbacks: Map<string, PinnedFallback | null>;
  mcp: string;
  mcpServers: unknown;
}

/** Every credential variable a surface has named in this process. Only grows. */
const seenKeyVars = new Set<string>();

/** The credential variable names `config` declares: endpoints, fallbacks, MCP env. */
export function credentialVarsOf(config: GnomonConfig): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.add(v.trim());
  };
  for (const ep of Object.values(config.config?.endpoints ?? {})) add((ep as { api_key_env?: unknown } | undefined)?.api_key_env);
  for (const def of Object.values(config.roles ?? {})) add((def as { fallback?: { api_key_env?: unknown } } | undefined)?.fallback?.api_key_env);
  for (const def of Object.values(config.tools?.mcp_servers ?? {})) {
    const env = (def as { env?: unknown }).env;
    if (Array.isArray(env)) env.forEach(add);
    else if (env && typeof env === "object") Object.keys(env).forEach(add);
  }
  return [...out];
}

/** Remember the names `config` declares, for the drop set. */
export function noteKeyVars(config: GnomonConfig | undefined): void {
  if (!config) return;
  try {
    for (const v of credentialVarsOf(config)) seenKeyVars.add(v);
  } catch {
    // a config without endpoints declares none
  }
}

/** The union: every credential variable named in this process so far. */
export function sessionKeyVars(): string[] {
  return [...seenKeyVars].sort();
}

/** Tests only. */
export function _resetSessionKeyVars(): void {
  seenKeyVars.clear();
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x
  ) ?? "null";
}

/** Pin `config`'s key routing: call once, when the session starts. */
export function pinCredentials(config: GnomonConfig): CredentialPin {
  noteKeyVars(config);
  const endpoints = new Map<string, PinnedEndpoint>();
  for (const [name, ep] of Object.entries(config.config?.endpoints ?? {})) {
    const e = ep as { url?: unknown; api_key_env?: unknown };
    endpoints.set(name, { url: e?.url, api_key_env: e?.api_key_env });
  }
  const fallbacks = new Map<string, PinnedFallback | null>();
  for (const [role, def] of Object.entries(config.roles ?? {})) {
    const fb = (def as { fallback?: { url?: unknown; api_key_env?: unknown } } | undefined)?.fallback;
    fallbacks.set(role, fb ? { url: fb.url, api_key_env: fb.api_key_env } : null);
  }
  const mcpServers = config.tools?.mcp_servers;
  return {
    endpoints,
    fallbacks,
    mcp: stable(mcpServers ?? {}),
    mcpServers: mcpServers === undefined ? undefined : JSON.parse(JSON.stringify(mcpServers)),
  };
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/**
 * `fresh` with its key routing held to `pin`, and what was held, for the
 * operator. `fresh` is not modified.
 */
export function holdCredentials(pin: CredentialPin, fresh: GnomonConfig): { config: GnomonConfig; held: string[] } {
  noteKeyVars(fresh);
  const held: string[] = [];
  // Copies of exactly the parts this may change; everything else is shared.
  const config: GnomonConfig = {
    ...fresh,
    config: {
      ...fresh.config,
      ...(fresh.config.endpoints
        ? { endpoints: Object.fromEntries(Object.entries(fresh.config.endpoints).map(([k, v]) => [k, { ...v }])) }
        : {}),
    },
    roles: Object.fromEntries(
      Object.entries(fresh.roles ?? {}).map(([k, v]) => [k, v && v.fallback ? { ...v, fallback: { ...v.fallback } } : v])
    ) as GnomonConfig["roles"],
    tools: { ...fresh.tools },
  };

  const eps = (config.config.endpoints ?? {}) as Record<string, { url?: unknown; api_key_env?: unknown }>;
  for (const name of Object.keys(eps)) {
    const ep = eps[name]!;
    const was = pin.endpoints.get(name);
    if (!was) {
      delete eps[name];
      held.push(`a new endpoint "${name}"`);
      continue;
    }
    if (!same(ep.url, was.url)) {
      held.push(`endpoints.${name}.url = ${JSON.stringify(ep.url)} (pinned: ${JSON.stringify(was.url)})`);
      if (was.url === undefined) delete ep.url;
      else ep.url = was.url;
    }
    if (!same(ep.api_key_env, was.api_key_env)) {
      held.push(`endpoints.${name}.api_key_env = ${JSON.stringify(ep.api_key_env)} (pinned: ${JSON.stringify(was.api_key_env)})`);
      if (was.api_key_env === undefined) delete ep.api_key_env;
      else ep.api_key_env = was.api_key_env;
    }
  }

  for (const [role, def] of Object.entries(config.roles ?? {})) {
    const d = def as { fallback?: { url?: unknown; api_key_env?: unknown } } | undefined;
    const fb = d?.fallback;
    const was = pin.fallbacks.get(role) ?? null;
    if (!fb) continue;
    for (const field of ["url", "api_key_env"] as const) {
      const pinned = was ? was[field] : undefined;
      if (!same(fb[field], pinned)) {
        held.push(`roles.${role}.fallback.${field} = ${JSON.stringify(fb[field])} (pinned: ${JSON.stringify(pinned)})`);
        if (pinned === undefined) delete fb[field];
        else fb[field] = pinned;
      }
    }
  }

  const mcpNow = config.tools?.mcp_servers;
  if (stable(mcpNow ?? {}) !== pin.mcp) {
    held.push("[mcp_servers] (a server's command, args or env changed, or one was added)");
    if (config.tools) {
      if (pin.mcpServers === undefined) delete (config.tools as { mcp_servers?: unknown }).mcp_servers;
      else (config.tools as { mcp_servers?: unknown }).mcp_servers = JSON.parse(JSON.stringify(pin.mcpServers));
    }
  }
  return { config, held };
}

/** The operator's line for a held reload, or null when nothing was held. */
export function heldNotice(held: readonly string[]): string | null {
  if (held.length === 0) return null;
  return (
    `key routing NOT applied: the surface now asks for ${held.join("; ")}. ` +
    `This session keeps the endpoints and MCP servers it started with; restart gnomon to apply the change.`
  );
}

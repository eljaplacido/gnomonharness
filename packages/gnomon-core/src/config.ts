/**
 * gnomon-core: Config resolution
 *
 * Resolves .gnomon/ tree and provides typed access to all config files.
 * No TUI deps — pure config + validation.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative, basename } from "node:path";
import { createHash } from "node:crypto";
import { SourceEntry } from "./session.js";

// ---------------------------------------------------------------------------
// Types — mirror Rust structs from gnomon-surface
// ---------------------------------------------------------------------------

/** Config.toml: tool and process configuration */
export interface Config {
  process?: Record<string, ProcessConfig>;
  tools?: ToolConfig[];
  defaults?: Defaults;
  context?: ContextConfig;
  ui?: UiConfig;
  endpoints?: Record<string, EndpointConfig>;
  routing?: RoutingConfig;
  audit?: import("./audit.js").AuditConfig;
  session?: import("./session_store.js").SessionConfig;
}

/**
 * config.toml [routing] — who answers, and whether the harness decides.
 *
 * The rules live in the surface and are hashed with it, so "auto" stays
 * deterministic: the same input picks the same role on every machine. A model
 * asked to choose its own role would not be.
 */
export interface RoutingConfig {
  /**
   * manual  — the current role answers; you switch.
   * suggest — rules propose a role and you confirm, per turn.
   * auto    — rules pick, and the switch is announced after the fact.
   *
   * A trust dial: run `suggest` until the rules stop surprising you, then
   * `auto`. `suggest` needs someone to ask, so a non-interactive run treats
   * it as `manual` rather than deciding on your behalf.
   */
  mode?: RoutingMode;
  /** Role used when no rule matches */
  default?: string;
  rules?: RoutingRule[];
}

export interface RoutingRule {
  role: string;
  /** Case-insensitive regular expression matched against the input */
  match: string;
  /** Shown when this rule fires, so a switch is never unexplained */
  why?: string;
}

export type RoutingMode = "manual" | "suggest" | "auto";

/**
 * config.toml [endpoints.<name>] — where inference goes.
 *
 * The URL lives in the surface and is hashed, so routing is part of what a
 * checkout declares rather than something the machine decides. Only the
 * credential is machine-scoped, and only by NAME: api_key_env names an
 * environment variable, never the secret itself.
 */
export interface EndpointConfig {
  url: string;
  /** ollama | openai — selects the request/response shape */
  kind?: EndpointKind;
  api_key_env?: string;
}

export type EndpointKind = "ollama" | "openai";

/** config.toml [ui] — what the terminal shows, declared in the surface */
export interface UiConfig {
  meta?: string[];
  meta_style?: MetaStyle;
  think?: ThinkMode;
  spinner?: boolean;
  color?: boolean;
}

/** Meta fields available for the line printed with each answer */
export type MetaField =
  | "turn"
  | "role"
  | "model"
  | "bucket"
  | "duration"
  | "context"
  | "tokens"
  | "think"
  | "tools";

export type MetaStyle = "line" | "compact";
export type ThinkMode = "hide" | "collapse" | "show";

/** config.toml [defaults] */
export interface Defaults {
  edit_format?: string;
  sandbox?: string;
  approval?: string;
  role_profile?: string;
  max_context_tokens?: number;
  compaction?: Compaction;
}

/** config.toml [context] */
export interface ContextConfig {
  policy?: ContextPolicy;
  retain_after?: number;
  /** Role used to fold evicted turns into a summary. Default "smol". */
  summary_role?: string;
}

export type ContextPolicy = "full" | "sliding_window" | "summary";
export type Compaction = "discard" | "summary" | "truncate";

export interface ProcessConfig {
  timeout_ms?: number;
  retries?: number;
  env?: Record<string, string>;
}

export interface ToolConfig {
  name: string;
  binary?: string;
  args?: string[];
  enabled?: boolean;
}

/** Policy.toml: sandbox and approval policy */
export interface Policy {
  sandbox?: {
    network?: boolean;
    filesystem?: string;
    env_whitelist?: string[];
  };
  approval?: {
    modes: string[];
    default: string;
  };
  exit_codes?: Record<string, string>;
}

/** Roles.toml: role definitions */
export interface Roles {
  [role: string]: RoleDef;
}

/** Secondary endpoint tried when the primary model fails or times out */
export interface FallbackDef {
  model: string;
  /** Named endpoint from config.toml [endpoints] */
  endpoint?: string;
  /** Full chat-completions URL. Overrides `endpoint` when both are given. */
  url?: string;
  /** Env var holding the bearer token */
  api_key_env?: string;
}

export interface RoleDef {
  model?: string;
  temperature?: number;
  top_p?: number;
  description?: string;
  /** Named endpoint from config.toml [endpoints]; defaults to "local" */
  endpoint?: string;
  /**
   * Tools this role may call. Absent means every declared tool.
   * An empty list means none — which is how a read-only verifier is
   * expressed: it can run the suite but cannot write.
   */
  tools?: string[];
  /**
   * Hard ceiling on tool calls for one turn.
   *
   * `max_steps` is a checkpoint, not a wall: on reaching it the harness
   * compacts the turn's working context and continues. This is where it
   * actually stops. Defaults to eight times `max_steps`.
   *
   * Set it to `max_steps` to get the old behaviour — stop at the first
   * checkpoint — or to 0 to refuse to continue at all.
   */
  max_steps_total?: number;
  /**
   * Shell commands this role may run, as regular expressions.
   *
   * Absent means any command. That matters more than it looks: `bash` can
   * write anything, so a role holding it is NOT read-only however its `tools`
   * list reads. A verifier that must run the suite without being able to
   * alter it needs this list, not just the absence of `write`.
   */
  bash_allow?: string[];
  fallback?: FallbackDef;
  // Legacy field (kept for compat with older role files)
  profile?: string;
  allowed_edit_formats?: string[];
  max_steps?: number;
}

/** Profiles: per-profile tuning */
export interface Profiles {
  [name: string]: ProfileDef;
}

export interface ProfileDef {
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: string[];
}

/** Tools.toml: declared tools and MCP servers */
export interface ToolsDef {
  tools?: ToolDef[];
  mcp_servers?: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description?: string;
  enabled?: boolean;
  timeout_seconds?: number;
}

/** System prompt template */
export interface SystemPrompt {
  content: string;
  version: string;
}

// ---------------------------------------------------------------------------
// TOML parser (simple, handles .gnomon config format)
// ---------------------------------------------------------------------------

/**
 * Parse a simple TOML file. Supports:
 * - Key-value pairs: key = "value"
 * - Tables: [table]
 * - Nested tables: [table.sub]
 * - Arrays: items = ["a", "b"]
 */
export function parseToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentTable: string | null = null;
  let currentObj: Record<string, unknown> = result;

  const lines = content.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    let trimmed = lines[lineNo].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // An array may span lines. Joining them here rather than parsing line by
    // line matters: an unjoined `key = [` parsed as the string "[", which
    // silently emptied every multi-line list in the surface.
    if (/=\s*\[[^\]]*$/.test(stripComment(trimmed))) {
      const parts: string[] = [stripComment(trimmed)];
      let depth =
        (parts[0].match(/\[/g) ?? []).length - (parts[0].match(/\]/g) ?? []).length;
      while (depth > 0 && lineNo + 1 < lines.length) {
        lineNo++;
        const next = stripComment(lines[lineNo].trim());
        if (!next) continue;
        parts.push(next);
        depth +=
          (next.match(/\[/g) ?? []).length - (next.match(/\]/g) ?? []).length;
      }
      trimmed = parts.join(" ");
    }

    // Array-of-tables header: [[tools]]. Must be tested before [table],
    // whose pattern also matches "[[tools]]" (capturing "[tools]") and would
    // otherwise fold every entry into one key named "[tools]".
    const arrayMatch = trimmed.match(/^\[\[(.+)\]\]$/);
    if (arrayMatch) {
      const parts = arrayMatch[1].split(".").map((x) => x.trim());
      let parent: Record<string, unknown> = result;
      for (let k = 0; k < parts.length - 1; k++) {
        if (!(parts[k] in parent)) parent[parts[k]] = {};
        parent = parent[parts[k]] as Record<string, unknown>;
      }
      const leaf = parts[parts.length - 1];
      if (!Array.isArray(parent[leaf])) parent[leaf] = [];
      const entry: Record<string, unknown> = {};
      (parent[leaf] as unknown[]).push(entry);
      currentTable = arrayMatch[1];
      currentObj = entry;
      continue;
    }

    // Table header
    const tableMatch = trimmed.match(/^\[(.+)\]$/);
    if (tableMatch) {
      currentTable = tableMatch[1];
      const parts = currentTable.split(".");
      currentObj = result;
      for (const part of parts) {
        const key = part.trim();
        if (!(key in currentObj)) {
          (currentObj as Record<string, unknown>)[key] = {};
        }
        currentObj = currentObj[key] as Record<string, unknown>;
      }
      continue;
    }

    // Key = value
    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = stripComment(kvMatch[2]);
      currentObj[key] = parseValue(value);
      continue;
    }
  }

  return result;
}

/**
 * Strip a trailing `# ...` comment from a value, honouring quoted strings.
 *
 * Every documented value in config.toml carries an inline comment listing its
 * legal values. Without this, `approval = "on_write"  # never | on_write | ...`
 * parses to the whole line, so no enum value ever matches.
 */
function stripComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      // Literal strings have no escapes, so only a basic string honours \".
      if (ch === quote && !(quote === '"' && value[i - 1] === "\\")) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function parseValue(value: string): unknown {
  // Literal string: 'no escapes here'. This is the TOML idiom for regular
  // expressions — in a basic string a pattern would have to double every
  // backslash, and this parser does not process escapes, so "\\s" would
  // reach RegExp as a literal backslash followed by s and match nothing.
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  // Basic string
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  // Array. Split on top-level commas only: a pattern like '^(a|b),\\s' would
  // otherwise be torn in half, and a trailing comma would yield an empty item.
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    const items: string[] = [];
    let buf = "";
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (quote) {
        if (ch === quote && !(quote === '"' && inner[i - 1] === "\\")) quote = null;
        buf += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        buf += ch;
      } else if (ch === ",") {
        items.push(buf);
        buf = "";
      } else {
        buf += ch;
      }
    }
    items.push(buf);
    return items.map((v) => v.trim()).filter(Boolean).map(parseValue);
  }
  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;
  // Number
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  // Fallback: string
  return value;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Resolve the .gnomon/ directory for a given root.
 * @param root Path to project root (default: process.cwd())
 * @returns Resolved path to .gnomon/ directory
 */
export function resolveGnomonDir(root?: string): string {
  // An explicit --dir means exactly that directory: no searching.
  if (root) {
    const gnomonDir = join(resolve(root), ".gnomon");
    if (!existsSync(gnomonDir)) {
      throw new Error(`.gnomon/ not found at ${gnomonDir}`);
    }
    return gnomonDir;
  }

  // Otherwise walk up from the cwd, the way git finds .git. Working from a
  // subdirectory of a project is normal, and requiring the exact project root
  // made it easy to run in the wrong place and get a confusing miss.
  const start = process.cwd();
  let dir = start;
  for (;;) {
    const candidate = join(dir, ".gnomon");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `No .gnomon/ surface found in ${start} or any parent directory.\n` +
      `Run \`gnomon init\` in your project root to create one.`
  );
}

/**
 * Load a TOML config file from .gnomon/.
 * @param gnomonDir Path to .gnomon/ directory
 * @param filename TOML filename (or directory for profile subdirectory)
 * @returns Parsed config object
 */
function loadToml<T = Record<string, unknown>>(
  gnomonDir: string,
  filename: string
): T {
  const filePath = join(gnomonDir, filename);

  // Handle profile subdirectory: glob all .toml files
  if (filename === "profiles") {
    const profilesDir = filePath;
    if (!existsSync(profilesDir)) {
      return {} as T;
    }

    const files = readdirSync(profilesDir)
      .filter((f: string) => f.endsWith(".toml"))
      .sort();

    const result: Record<string, unknown> = {};
    for (const file of files) {
      const name = file.replace(/\.toml$/, "");
      const content = readFileSync(join(profilesDir, file), "utf-8");
      result[name] = parseToml(content);
    }
    return result as T;
  }

  if (!existsSync(filePath)) {
    return {} as T;
  }

  const content = readFileSync(filePath, "utf-8");
  return parseToml(content) as T;
}

/**
 * Load the full .gnomon/ configuration.
 * @param root Project root path
 * @returns Typed configuration object
 */
export function loadConfig(root?: string): GnomonConfig {
  const gnomonDir = resolveGnomonDir(root);

  return {
    gnomonDir,
    config: loadToml<Config>(gnomonDir, "config.toml"),
    policy: loadToml<Policy>(gnomonDir, "policy.toml"),
    // roles.toml has [roles.X] headers → parseToml wraps in {roles: {...}}
    roles: ((loadToml<Record<string, unknown>>(gnomonDir, "roles.toml") as Record<string, unknown>).roles ?? {}) as Roles,
    profiles: loadToml<Profiles>(gnomonDir, "profiles") as unknown as Profiles,
    tools: loadToml<ToolsDef>(gnomonDir, "tools.toml"),
    // system.md is plain text, not TOML — read directly
    system: (() => {
      const filePath = join(gnomonDir, "system.md");
      const content = existsSync(filePath)
        ? readFileSync(filePath, "utf-8")
        : "";
      return { content, version: "0.1" } as SystemPrompt;
    })(),
  };
}

/** Complete gnomon configuration */
export interface GnomonConfig {
  gnomonDir: string;
  config: Config;
  policy: Policy;
  roles: Roles;
  profiles: Profiles;
  tools: ToolsDef;
  system: SystemPrompt;
}

/**
 * Get the role definition for a given role name.
 */
export function getRole(config: GnomonConfig, role: string): RoleDef {
  const def = config.roles[role];
  if (!def) {
    throw new Error(`Role not found: "${role}". Available: ${Object.keys(config.roles).join(", ")}`);
  }
  return def;
}

/**
 * Get the profile definition for a given profile name.
 */
export function getProfile(config: GnomonConfig, name: string): ProfileDef {
  const profiles = config.profiles;
  if (!profiles[name]) {
    throw new Error(`Profile not found: "${name}". Available: ${Object.keys(profiles).join(", ")}`);
  }
  return profiles[name];
}

/**
 * Check if a tool is enabled.
 */
export function isToolEnabled(config: GnomonConfig, toolName: string): boolean {
  const declared = config.tools.tools?.find((t) => t.name === toolName);
  if (!declared) return false;
  if (declared.enabled === false) return false;

  // config.toml may disable a declared tool without removing the declaration.
  const override = config.config.tools?.find((t) => t.name === toolName);
  return override?.enabled !== false;
}

/** Every tool the surface declares, in declaration order. */
export function declaredTools(config: GnomonConfig): ToolDef[] {
  return config.tools.tools ?? [];
}

/** The context-window policy, fully resolved with declared defaults. */
export interface ResolvedContext {
  policy: ContextPolicy;
  retain_after: number;
  max_context_tokens: number;
  compaction: Compaction;
  summary_role: string;
}

const CONTEXT_POLICIES: ContextPolicy[] = ["full", "sliding_window", "summary"];
const COMPACTIONS: Compaction[] = ["discard", "summary", "truncate"];

function pickEnum<T extends string>(value: unknown, legal: T[], fallback: T): T {
  return typeof value === "string" && (legal as string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

/**
 * Resolve the context-window policy from config.toml.
 *
 * `[context]` and `[defaults].max_context_tokens` / `.compaction` are already
 * declared in the surface and already part of the surface hash — this reads
 * what is there rather than introducing new configuration.
 */
export function resolveContext(config: GnomonConfig): ResolvedContext {
  const ctx = config.config.context ?? {};
  const defaults = config.config.defaults ?? {};
  return {
    policy: pickEnum(ctx.policy, CONTEXT_POLICIES, "sliding_window"),
    retain_after: pickInt(ctx.retain_after, 2048),
    max_context_tokens: pickInt(defaults.max_context_tokens, 65536),
    compaction: pickEnum(defaults.compaction, COMPACTIONS, "discard"),
    summary_role:
      typeof ctx.summary_role === "string" ? ctx.summary_role : "smol",
  };
}

/** The `[ui]` block, fully resolved with defaults. */
export interface ResolvedUi {
  meta: MetaField[];
  meta_style: MetaStyle;
  think: ThinkMode;
  spinner: boolean;
  color: boolean;
}

export const META_FIELDS: MetaField[] = [
  "turn",
  "role",
  "model",
  "bucket",
  "duration",
  "context",
  "tokens",
  "think",
  "tools",
];

const META_STYLES: MetaStyle[] = ["line", "compact"];
const THINK_MODES: ThinkMode[] = ["hide", "collapse", "show"];

/**
 * Parse a meta field list, dropping names that are not fields.
 *
 * Unknown names are returned so the caller can name them rather than silently
 * showing a shorter line than the surface asked for.
 */
export function parseMetaFields(names: string[]): {
  fields: MetaField[];
  unknown: string[];
} {
  const fields: MetaField[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name) continue;
    if ((META_FIELDS as string[]).includes(name)) {
      if (!fields.includes(name as MetaField)) fields.push(name as MetaField);
    } else {
      unknown.push(name);
    }
  }
  return { fields, unknown };
}

/**
 * Resolve the `[ui]` block from config.toml.
 *
 * Presentation is declared in the surface like everything else, so two
 * checkouts of a repo show the same thing. Runtime `/meta` and `/think` edit
 * only the in-memory copy — persisting them would be machine-scoped state,
 * which Rule 1 forbids.
 */
export function resolveUi(config: GnomonConfig): ResolvedUi {
  const ui = config.config.ui ?? {};
  const declared = Array.isArray(ui.meta) ? parseMetaFields(ui.meta).fields : null;
  return {
    meta:
      declared ?? ["turn", "role", "model", "bucket", "duration", "context", "tools"],
    meta_style: pickEnum(ui.meta_style, META_STYLES, "line"),
    think: pickEnum(ui.think, THINK_MODES, "collapse"),
    spinner: typeof ui.spinner === "boolean" ? ui.spinner : true,
    color: typeof ui.color === "boolean" ? ui.color : true,
  };
}

/** A resolved inference target: where and how to call a model */
export interface RouteTarget {
  model: string;
  temperature: number;
  top_p: number;
  /** Full chat-completions endpoint URL */
  url: string;
  apiKeyEnv?: string;
  /** Which named endpoint this came from, for display */
  endpoint?: string;
  kind?: EndpointKind;
}

/** The routing policy, resolved with defaults. */
export interface ResolvedRouting {
  mode: RoutingMode;
  default: string;
  rules: RoutingRule[];
}

const ROUTING_MODES: RoutingMode[] = ["manual", "suggest", "auto"];

export function resolveRouting(config: GnomonConfig): ResolvedRouting {
  const r = config.config.routing ?? {};
  return {
    mode: pickEnum(r.mode, ROUTING_MODES, "manual"),
    default: typeof r.default === "string" ? r.default : "implement",
    rules: Array.isArray(r.rules) ? r.rules : [],
  };
}

/** What auto-routing decided, and on what grounds. */
export interface RoutingDecision {
  role: string;
  /** The rule that fired, or null when the default was used */
  rule: RoutingRule | null;
  /** Set when a rule names a role the surface does not define */
  problem?: string;
}

/**
 * Pick the role for one input.
 *
 * First matching rule wins, so order in the surface is the priority order.
 * A rule naming an undefined role is reported rather than silently skipped —
 * a routing table with a typo would otherwise fail open onto the default and
 * look like the rule simply did not match.
 */
export function routeInput(
  config: GnomonConfig,
  input: string,
  routing?: ResolvedRouting
): RoutingDecision {
  const r = routing ?? resolveRouting(config);
  const known = listRoles(config);

  for (const rule of r.rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.match, "i");
    } catch {
      return {
        role: r.default,
        rule: null,
        problem: `rule for "${rule.role}" has an invalid pattern: ${rule.match}`,
      };
    }
    if (!re.test(input)) continue;
    if (!known.includes(rule.role)) {
      return {
        role: r.default,
        rule: null,
        problem: `rule matched but role "${rule.role}" is not defined in roles.toml`,
      };
    }
    return { role: rule.role, rule };
  }

  return { role: r.default, rule: null };
}

/** The endpoint every role falls back to when none is named. */
export const DEFAULT_ENDPOINT = "local";

const BUILTIN_ENDPOINTS: Record<string, EndpointConfig> = {
  local: { url: "http://127.0.0.1:11434/api/chat", kind: "ollama" },
};

/**
 * Resolve a named endpoint from the surface.
 *
 * `local` has a built-in default so a surface that never mentions endpoints
 * still works. Anything else must be declared: a role pointing at an endpoint
 * that does not exist is a configuration error worth naming, not something to
 * silently paper over with a guessed URL.
 */
export function resolveEndpoint(
  config: GnomonConfig,
  name: string = DEFAULT_ENDPOINT
): EndpointConfig {
  const declared = config.config.endpoints?.[name];
  if (declared?.url) return declared;
  const builtin = BUILTIN_ENDPOINTS[name];
  if (builtin) return builtin;

  const known = [
    ...Object.keys(config.config.endpoints ?? {}),
    ...Object.keys(BUILTIN_ENDPOINTS),
  ];
  throw new Error(
    `Unknown endpoint "${name}". Declared: ${known.join(", ") || "(none)"}.\n` +
      "Add it under [endpoints." + name + "] in .gnomon/config.toml."
  );
}

/** Every endpoint the surface offers, built-ins included. */
export function listEndpoints(config: GnomonConfig): string[] {
  return [
    ...new Set([
      ...Object.keys(BUILTIN_ENDPOINTS),
      ...Object.keys(config.config.endpoints ?? {}),
    ]),
  ].sort();
}

/**
 * Route a role to its model config.
 * Returns the model string and sampling params from roles.toml,
 * falling back to profile-level settings if role-level isn't set.
 */
export function routeRole(
  config: GnomonConfig,
  role: string
): { model: string; temperature: number; top_p: number; description?: string; target: RouteTarget; fallback?: RouteTarget } {
  const roleDef = getRole(config, role);

  // Role-level overrides take precedence
  const model = roleDef.model ?? roleDef.profile ?? "local:default";
  const temperature = roleDef.temperature ?? 0.2;
  const top_p = roleDef.top_p ?? 0.9;
  const description = roleDef.description ?? "";

  // Where inference goes is declared in the surface and hashed with it.
  // GNOMON_MODEL_URL remains only as an explicit override, and the prompt
  // loop announces it when set — a machine-scoped route that changed
  // behaviour silently is exactly what Rule 1 exists to prevent.
  const endpointName = roleDef.endpoint ?? DEFAULT_ENDPOINT;
  const endpoint = resolveEndpoint(config, endpointName);
  const target: RouteTarget = {
    model,
    temperature,
    top_p,
    url: process.env.GNOMON_MODEL_URL ?? endpoint.url,
    apiKeyEnv: endpoint.api_key_env,
    endpoint: endpointName,
    kind: endpoint.kind ?? "ollama",
  };

  let fallback: RouteTarget | undefined;
  if (roleDef.fallback?.model) {
    const fb = roleDef.fallback;
    // An explicit url wins over a named endpoint, so existing surfaces that
    // spelled the URL out keep working unchanged.
    const fbEndpointName = fb.endpoint ?? (fb.url ? undefined : DEFAULT_ENDPOINT);
    const fbEndpoint = fbEndpointName
      ? resolveEndpoint(config, fbEndpointName)
      : undefined;
    fallback = {
      model: fb.model,
      temperature,
      top_p,
      url: fb.url ?? fbEndpoint?.url ?? "",
      apiKeyEnv: fb.api_key_env ?? fbEndpoint?.api_key_env,
      endpoint: fbEndpointName,
      kind: fbEndpoint?.kind ?? "openai",
    };
  }

  return { model, temperature, top_p, description, target, fallback };
}

/**
 * List available roles.
 */
export function listRoles(config: GnomonConfig): string[] {
  return Object.keys(config.roles);
}

/**
 * List available profiles.
 */
export function listProfiles(config: GnomonConfig): string[] {
  return Object.keys(config.profiles);
}

/**
 * Infer role from user input pattern (simple heuristic).
 * "Plan:" → plan, "Implement:" → implement, "Critique:" → critique, otherwise → implement.
 */
export function inferRole(input: string): string {
  const lower = input.toLowerCase().trim();
  if (lower.startsWith("plan:") || lower.startsWith("plan ") || lower.startsWith("/plan")) {
    return "plan";
  }
  if (lower.startsWith("critique:") || lower.startsWith("critique ") || lower.startsWith("/critique")) {
    return "critique";
  }
  if (lower.startsWith("smol:") || lower.startsWith("smol ") || lower.startsWith("/smol")) {
    return "smol";
  }
  return "implement";
}

/**
 * Canonical .gnomon/ surface paths — the minimum set every manifest lists.
 * Mirrors gnomon-surface's SURFACE_PATHS.
 */
/**
 * Canonical surface paths, `.gnomon/`-prefixed to match gnomon-surface and
 * conformance/manifest_golden.json.
 *
 * These strings go into the hash, so a different prefix is a different hash.
 * Unprefixed, this implementation and the Rust one returned different values
 * for the same directory — two things both called "the surface hash".
 */
const SURFACE_PATHS = [
  ".gnomon/config.toml",
  ".gnomon/system.md",
  ".gnomon/roles.toml",
  ".gnomon/tools.toml",
  ".gnomon/policy.toml",
] as const;

/**
 * Compute SHA256 of file contents.
 */
function fileSha256(filePath: string): string | null {
  try {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Walk .gnomon/ directory, collect files with their hashes.
 * Only hashes — never contents.
 */
/**
 * Resolve either a project root or a `.gnomon/` directory to the surface dir.
 *
 * Both call styles exist in this codebase — the tests pass a project root, and
 * every runtime caller passes `config.gnomonDir`. Accepting only the former
 * meant the runtime looked for `.gnomon/.gnomon`, found nothing, and hashed
 * "every file absent": a constant that was identical in every repository and
 * never changed when the surface did.
 */
function surfaceDirOf(dir: string): string {
  return basename(resolve(dir)) === ".gnomon" ? resolve(dir) : join(dir, ".gnomon");
}

function collectSurface(baseDir: string): SourceEntry[] {
  const sources: SourceEntry[] = [];
  const gnomonDir = surfaceDirOf(baseDir);

  if (!existsSync(gnomonDir)) return sources;

  function walk(dir: string) {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      // Prefixed to match the Rust implementation and the golden fixture.
      const relPath = join(".gnomon", relative(gnomonDir, fullPath));
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        walk(fullPath);
      } else {
        const hash = fileSha256(fullPath);
        sources.push({ path: relPath, sha256: hash });
      }
    }
  }

  walk(gnomonDir);
  return sources;
}

/**
 * Recompute the manifest from the .gnomon/ tree on disk.
 * Used for drift detection: compare against the cached manifest.
 * Returns a fresh Manifest suitable for comparison.
 */
export function recomputeManifest(baseDir: string, build: string = "0.1.0"): {
  manifest: SourceEntry[];
  surface_hash: string;
} {
  const existing = collectSurface(baseDir);
  const existingMap = new Map<string, SourceEntry>();
  for (const s of existing) {
    existingMap.set(s.path, s);
  }

  const sources: SourceEntry[] = [];

  // 1. All canonical surface paths (present or absent)
  for (const path of SURFACE_PATHS) {
    const existing = existingMap.get(path);
    sources.push(existing ?? { path, sha256: null });
  }

  // 2. Additional files not in SURFACE_PATHS (profiles/, skills/, etc.)
  for (const s of existing) {
    const isCanonical = (SURFACE_PATHS as readonly string[]).includes(s.path);
    if (!isCanonical) {
      if (!sources.some((ss) => ss.path === s.path)) {
        sources.push(s);
      }
    }
  }

  // Sort by path, byte-wise — NOT localeCompare.
  //
  // localeCompare is locale-sensitive: it orders punctuation differently under
  // different collations, so the same surface could hash differently on two
  // machines. That is the machine-scoped behaviour Rule 1 forbids, inside the
  // hash meant to prove behaviour is not machine-scoped. It also disagreed
  // with gnomon-surface's byte-wise sort, so the two implementations of the
  // same hash returned different values for the same directory.
  sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Compute surface hash
  const hash = createHash("sha256");
  for (const source of sources) {
    hash.update(source.path);
    hash.update(":");
    if (source.sha256) {
      hash.update(source.sha256);
    } else {
      hash.update("null");
    }
    hash.update("\n");
  }
  const surface_hash = hash.digest("hex");

  return { manifest: sources, surface_hash };
}

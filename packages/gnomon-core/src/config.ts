/**
 * gnomon-core: Config resolution
 *
 * Resolves .gnomon/ tree and provides typed access to all config files.
 * No TUI deps — pure config + validation.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
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
}

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
  | "status"
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
  /** Full chat-completions URL (defaults to OpenCode Zen) */
  url?: string;
  /** Env var holding the bearer token */
  api_key_env?: string;
}

export interface RoleDef {
  model?: string;
  temperature?: number;
  top_p?: number;
  description?: string;
  /** Full chat-completions URL for the primary target.
   *
   * Declared here so that the endpoint is part of the hashed surface. When it is
   * absent the resolver falls back to GNOMON_MODEL_URL, which is machine scope by
   * another door: two runs at the same surface hash can then reach different
   * models. That override is recorded on every session record rather than assumed
   * away — see `environmentOverrides`. */
  url?: string;
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
 * - Arrays of tables: [[table]]
 * - Arrays: items = ["a", "b"]
 *
 * `[[table]]` is not a nicety. `.gnomon/tools.toml` is written entirely in it, and
 * without it every `[[tools]]` block collapsed onto one stray key — so the declared
 * tool surface, the thing rule 3 exists to make into data, did not parse at all.
 */
export function parseToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentTable: string | null = null;
  let currentObj: Record<string, unknown> = result;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

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
  let inString = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== "\\") {
      inString = !inString;
    } else if (ch === "#" && !inString) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function parseValue(value: string): unknown {
  // String
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  // Array
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((v) => parseValue(v.trim()));
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
  const target = root ? resolve(root) : process.cwd();
  const gnomonDir = join(target, ".gnomon");

  if (!existsSync(gnomonDir)) {
    throw new Error(`.gnomon/ directory not found at: ${gnomonDir}`);
  }

  return gnomonDir;
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
 * Declared against effective.
 *
 * `declared` is what `.gnomon/tools.toml` states and the surface hash covers.
 * `effective` is what a loop actually offered a provider — passed in, because the
 * set is built where the tools live and this module must not depend on them.
 *
 * `enforced` is false when nothing was offered. That case is not hypothetical: a
 * hash covering a tool list no model ever saw describes an agent that does not
 * exist, and a consumer reading only the hash cannot tell the two apart.
 */
export function toolSurface(
  config: GnomonConfig,
  offered: string[] = []
): { declared: string[]; effective: string[]; enforced: boolean } {
  const declared = declaredTools(config)
    .filter((t) => t.enabled !== false)
    .map((t) => t.name)
    .sort((a, b) => a.localeCompare(b));
  const effective = [...offered].sort((a, b) => a.localeCompare(b));
  return { declared, effective, enforced: effective.length > 0 };
}

/**
 * What `.gnomon/policy.toml` selects, and whether this run acted on it.
 *
 * `enforced` is passed in rather than assumed: the selects are published and hashed
 * either way, and a record that asserts enforcement the run did not perform is worse
 * than one that admits the gap.
 */
export function policySummary(
  config: GnomonConfig,
  enforced = false
): {
  sandbox: string | null;
  approval: string | null;
  edit_format: string | null;
  enforced: boolean;
} {
  const policy = config.policy as unknown as Record<string, Record<string, unknown>>;
  const defaults = (config.config.defaults ?? {}) as Record<string, unknown>;
  const read = (table: string, key: string, fallback: string): string | null => {
    const value = policy?.[table]?.[key];
    if (typeof value === "string") return value;
    const declared = defaults[fallback];
    return typeof declared === "string" ? declared : null;
  };
  return {
    sandbox: read("sandbox", "level", "sandbox"),
    approval: read("approval", "gate", "approval"),
    edit_format: read("edit", "format", "edit_format"),
    enforced,
  };
}

/** Machine-scoped variables that change what the agent does. */
export const ENVIRONMENT_VARIABLES: readonly string[] = [
  "GNOMON_MODEL_URL",
  "GNOMON_MODEL_TIMEOUT_MS",
  "GNOMON_BIN_OVERRIDE",
];

export interface EnvironmentOverride {
  name: string;
  set: boolean;
  /** A safe rendering: the origin of a URL, the raw value otherwise, null when unset.
   * A model URL can carry a token in its userinfo, so only its origin is kept. */
  value: string | null;
}

/**
 * The environment this run actually read, recorded rather than assumed away.
 *
 * Rule 1 removes machine-scoped *files*; these variables are the same thing through
 * another door — they select an endpoint, a timeout that decides whether an outcome
 * is apparatus failure, and even which binary computes the surface hash. None of
 * them is in the hash, so two runs at one hash can differ. Recording them is what
 * makes that visible to a consumer; it does not make it go away.
 */
export function environmentOverrides(
  env: NodeJS.ProcessEnv = process.env
): EnvironmentOverride[] {
  return ENVIRONMENT_VARIABLES.map((name) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return { name, set: false, value: null };
    if (name.endsWith("_URL")) {
      try {
        return { name, set: true, value: new URL(raw).origin };
      } catch {
        return { name, set: true, value: "unparseable" };
      }
    }
    return { name, set: true, value: raw };
  });
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
  "status",
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

  // Surface first, environment second. A URL declared in roles.toml is hashed and
  // reviewable; GNOMON_MODEL_URL is neither, so it may fill a gap the surface left
  // and may never override what the surface states.
  const target: RouteTarget = {
    model,
    temperature,
    top_p,
    url:
      roleDef.url ??
      process.env.GNOMON_MODEL_URL ??
      "http://localhost:11434/api/chat",
  };

  let fallback: RouteTarget | undefined;
  if (roleDef.fallback?.model) {
    fallback = {
      model: roleDef.fallback.model,
      temperature,
      top_p,
      url: roleDef.fallback.url ?? "https://opencode.ai/zen/v1/chat/completions",
      apiKeyEnv: roleDef.fallback.api_key_env,
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
const SURFACE_PATHS = [
  "config.toml",
  "system.md",
  "roles.toml",
  "policy.toml",
  "tools.toml",
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
function collectSurface(baseDir: string): SourceEntry[] {
  const sources: SourceEntry[] = [];
  const gnomonDir = join(baseDir, ".gnomon");

  if (!existsSync(gnomonDir)) return sources;

  function walk(dir: string) {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(join(baseDir, ".gnomon"), fullPath);
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        walk(fullPath);
      } else {
        const hash = fileSha256(fullPath);
        // Posix separators always. The surface hash has to be byte-identical for
        // the same tree, and `relative()` yields backslashes on Windows — which
        // would give one repository two hashes depending on who checked it out.
        sources.push({ path: relPath.split(sep).join("/"), sha256: hash });
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

  // Sort by path for determinism
  sources.sort((a, b) => a.path.localeCompare(b.path));

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

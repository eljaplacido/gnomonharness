/**
 * gnomon-core: Config resolution
 *
 * Resolves .gnomon/ tree and provides typed access to all config files.
 * No TUI deps — pure config + validation.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { SourceEntry } from "./session.js";

// ---------------------------------------------------------------------------
// Types — mirror Rust structs from gnomon-surface
// ---------------------------------------------------------------------------

/** Config.toml: tool and process configuration */
export interface Config {
  process?: Record<string, ProcessConfig>;
  tools?: ToolConfig[];
}

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

/** Tools.toml: tool definitions */
export interface ToolsDef {
  [name: string]: ToolDef;
}

export interface ToolDef {
  description: string;
  parameters?: Record<string, unknown>;
  returns: string;
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

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

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
      const value = kvMatch[2].trim();
      currentObj[key] = parseValue(value);
      continue;
    }
  }

  return result;
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
 * Check if a tool is enabled.
 */
export function isToolEnabled(config: GnomonConfig, toolName: string): boolean {
  const tool = config.tools[toolName];
  if (!tool) return false;

  const configEntry = config.config.tools?.find((t) => t.name === toolName);
  return configEntry?.enabled !== false;
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

  const target: RouteTarget = {
    model,
    temperature,
    top_p,
    url: process.env.GNOMON_MODEL_URL ?? "http://localhost:11434/api/chat",
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

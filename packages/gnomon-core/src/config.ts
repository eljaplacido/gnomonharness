/**
 * gnomon-core: Config resolution
 *
 * Resolves .gnomon/ tree and provides typed access to all config files.
 * No TUI deps — pure config + validation.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative, basename, sep, isAbsolute } from "node:path";
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
  /**
   * Display label for listings — `openrouter`, `copilot`, `azure`, … Inferred
   * from the URL when omitted, and never affects routing (the URL and key do
   * that). Set it to name a custom or gateway endpoint the host can't guess.
   */
  provider?: string;
}

export type EndpointKind = "ollama" | "openai";

/** config.toml [ui] — what the terminal shows, declared in the surface */
export interface UiConfig {
  theme?: string;
  meta?: string[];
  meta_style?: MetaStyle;
  think?: ThinkMode;
  cot?: CotMode;
  spinner?: boolean;
  color?: boolean;
  markdown?: boolean;
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

/**
 * How much of the live "while it works" trace to show, set by /cot:
 *   full  — reasoning (at /think's verbosity) + prose + each tool call/result
 *   think — reasoning + prose only, no tool lines
 *   tools — tool calls and results only, no reasoning
 *   brief — one line per step: the call and its result summary
 *   off   — nothing until the final answer
 */
export type CotMode = "off" | "brief" | "tools" | "think" | "full";

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
  /**
   * Tokens held back from the window for the model's reply.
   *
   * The window used to fill `max_context_tokens` completely, leaving nothing
   * for the answer — and the estimate is ~4 characters per token, which
   * under-counts code. Both errors point the same way, so the reserve covers
   * both. Defaults to 15% of the budget, at least 1024.
   */
  reserve_output?: number;
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
  /**
   * A check the harness runs after a turn that changed files.
   *
   * Declared data, hashed with the rest of the surface, and absent by default:
   * a repository that declares nothing pays nothing, not a token and not a
   * process. There is deliberately no default command. Executing whatever the
   * agent just wrote would be a destructive default in a real repository --
   * `deploy.sh` is a shell script too -- so the gate only ever runs a command
   * the repository named itself.
   *
   * It exists because a benchmark run showed the gap concretely: a turn wrote a
   * hundred-line setup script, ran `bash -n` on it, reported "syntax check
   * passed" and stopped. Nothing had been installed. `bash -n` parses; it does
   * not run. The harness had no way to know the difference, and neither did the
   * transcript.
   */
  verify?: {
    /** Shell command to run. Absent means no gate. */
    command?: string;
    /**
     * When to run it. "write" runs it only when the turn used write or edit,
     * which is the case the evidence supports; "always" runs it on every turn
     * that made any tool call.
     */
    after?: string;
    /**
     * How many times a failed check may hand the turn back to the model.
     * Bounded, and every re-entry still counts against max_steps_total, so a
     * check that can never pass cannot spend the budget in a circle.
     */
    max_rounds?: number;
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
   * Roles this role may delegate to with the `task` tool.
   *
   * Without it, `task` is an unconditional capability upgrade: a sub-turn gets
   * the TARGET role's tools, so any role holding `task` can borrow any other
   * role's list, and its own `tools` line stops being the answer to what it can
   * do. `plan` declares no `write` and no `edit`, and could delegate to
   * `implement` and have files written anyway.
   *
   * Omitted means every role, which is the behaviour that shipped — but the
   * surface audit says so, and the starter surface states it explicitly. That
   * is the same course the `tools` list took after an omitted list quietly
   * handed the coordinator `skill`.
   */
  task_allow?: string[];
  /** Per-role override of [sandbox] exec. See resolveExec. */
  exec?: string;
  /** Per-role override of [sandbox] image. */
  image?: string;
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
   * Fraction of `max_steps_total` (0–1) after which the harness pushes the
   * model to converge — stop exploring, apply and submit what already works,
   * or say plainly it cannot. Escalates as the remaining budget shrinks.
   *
   * The benchmark data behind this: gnomon's answers match the field's leaders
   * (identical wrong-answer counts) but on weak models it spends its whole
   * step budget exploring and the *external* clock kills the process with
   * nothing submitted — recorded as apparatus_failure. Converging before the
   * wall turns "grind until killed" into "submit a partial or conclude", which
   * is how lean harnesses beat it on weak models.
   *
   * Deliberately a STEP fraction, never a wall-clock deadline: a fast box and a
   * slow box must behave identically on the same surface, and steps are in the
   * hashed surface. Absent means off — exploration runs to `max_steps_total`,
   * which is what wins on capable models, so capable-model role profiles omit
   * it or set it high. This is opt-in on purpose: it is a measured behaviour,
   * not a default, per the harness-research finding that added structure can
   * hurt as well as help.
   */
  converge_after?: number;
  /**
   * Shell commands this role may run, as regular expressions.
   *
   * Absent means any command. That matters more than it looks: `bash` can
   * write anything, so a role holding it is NOT read-only however its `tools`
   * list reads. A verifier that must run the suite without being able to
   * alter it needs this list, not just the absence of `write`.
   */
  bash_allow?: string[];
  /**
   * Commands this role may never run, whatever `bash_allow` permits.
   *
   * An allow-list cannot express "everything except three catastrophes", and
   * that is the shape the implementing role needs: unrestricted bash for
   * builds and test suites it cannot enumerate in advance, minus the handful
   * of operations whose damage is neither local nor undoable — force-pushing
   * a release branch, deleting it on the remote.
   *
   * Case-insensitive regular expressions, matched against the whole command
   * and each top-level segment. Deny wins over allow, and a pattern that will
   * not compile refuses rather than permits.
   */
  bash_deny?: string[];
  /**
   * Paths this role may create or modify, as globs — `docs/**`, `**\/*.md`.
   *
   * Absent means anywhere inside the sandbox. Withholding `edit` stops a role
   * from revising an existing file; it does not stop `write` from creating
   * one. A coordinator described as writing specs and never source is only
   * described that way until this list exists.
   *
   * Globs rather than the regexes `bash_allow` takes: an unanchored `docs/`
   * as a regex also permits `src/docs/anything`, and a scope that quietly
   * grants more than it reads is the failure worth designing out.
   *
   * Applies to both `write` and `edit`. Matched against the resolved path
   * relative to the root, so `docs/../src/main.rs` is judged as `src/main.rs`.
   */
  write_allow?: string[];
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

/**
 * A pinned MCP server, referenced by name in tools.toml. Its tools are
 * discovered at startup and offered as `mcp__<server>__<tool>`, gated per role
 * like any other tool. Pin the version in `args` for reproducibility — an
 * unpinned server can change its tool set with no surface-hash move.
 */
export interface McpServerDef {
  /** Only "stdio" is wired by this build; others are declared-not-connected. */
  transport?: string;
  /** The executable to spawn, e.g. "npx". */
  command?: string;
  args?: string[];
  /**
   * Env var NAMES to forward from the process to the server (for API keys and
   * the like). Values are never written in the surface, only the names.
   */
  env?: string[];
}

/** Tools.toml: declared tools and MCP servers */
export interface ToolsDef {
  tools?: ToolDef[];
  mcp_servers?: Record<string, McpServerDef>;
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
/**
 * parseToml, with the filename in the message.
 *
 * "line 12: cannot parse ..." is only actionable if the reader knows which of
 * the four surface files it came from.
 */
function parseTomlNamed(content: string, filename: string): Record<string, unknown> {
  try {
    return parseToml(content);
  } catch (e) {
    throw new Error(`.gnomon/${filename} ${(e as Error).message}`);
  }
}

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

    // Anything reaching here matched none of the three shapes this parser
    // understands, and used to fall silently off the bottom of the loop.
    //
    // That silence is the dangerous part. `[roles.verifier` with the closing
    // bracket missing dropped the header and HOISTED its keys to the top level,
    // so the role vanished and its bash_allow became a root key read by nothing
    // — a role that appears to exist and is not there. `this is not toml`
    // vanished too. For a harness whose entire proposition is explicit
    // configuration, a line the parser cannot read must not be a line it
    // pretends it read.
    //
    // Thrown with the line number, because "somewhere in roles.toml" is not
    // materially better than silence.
    throw new Error(
      `line ${lineNo + 1}: cannot parse ${JSON.stringify(
        trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed
      )}. Expected a [table] header, a [[array]] header, or key = value.`
    );
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

/** TOML basic-string escapes. Unknown escapes are left alone rather than
 * throwing: this parser is lenient by design, and a surface that fails to load
 * over an unrecognised escape helps nobody. */
function unescapeBasic(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (whole, esc: string) => {
    switch (esc) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case '"': return '"';
      case "\\": return "\\";
      default:
        if (esc[0] === "u" || esc[0] === "U") {
          return String.fromCodePoint(parseInt(esc.slice(1), 16));
        }
        return whole;
    }
  });
}

function parseValue(value: string): unknown {
  // Literal string: 'no escapes here'. This is the TOML idiom for regular
  // expressions, and it needs no unescaping by definition.
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  // Basic string: escapes ARE processed, per the TOML spec.
  //
  // They were not, and the old comment here recorded that as a quirk without
  // drawing the consequence. Writing a pattern the ordinary, spec-correct way —
  // bash_deny = ["rm\\s+-rf"] — produced the string `rm\\s+-rf`, a regex
  // containing a literal backslash, which matches nothing. So a deny written
  // that way protected NOTHING while the surface read as though it did, and the
  // failure was silent in the dangerous direction.
  //
  // gnomon's own surface never hit it only because it happens to use literal
  // strings throughout. Measured: "rm\\s+-rf" failed to match `rm -rf x`;
  // 'rm\\s+-rf' matched. Two spellings of the same intent, one of them inert.
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeBasic(value.slice(1, -1));
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
      result[name] = parseTomlNamed(content, `profiles/${file}`);
    }
    return result as T;
  }

  if (!existsSync(filePath)) {
    return {} as T;
  }

  const content = readFileSync(filePath, "utf-8");
  return parseTomlNamed(content, filename) as T;
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
  // Sorted, because Rule 3 says "resolved from .gnomon/tools.toml, sorted,
  // hashed" and this returned file order. Two surfaces with identical tools
  // written in a different order presented the model a differently-ordered
  // schema list, and MCP tools are appended in CONNECTION order on top of
  // that — so the same surface could differ between runs whenever a server
  // was slow. Consistent field order is also the cheapest of the three levers
  // the current top-of-leaderboard harness attributes its tool-call
  // reliability to, and a stable prefix is what makes prompt caching hit.
  // Byte-wise, NOT localeCompare — the same rule this file already applies to
  // manifest paths, and for the same reason. localeCompare goes through ICU,
  // whose collation tables differ between Node builds (a small-icu binary
  // collates differently from a full-icu one) and between ICU versions. Rule 3
  // says tool schemas are "sorted, hashed"; a sort whose result depends on which
  // Node compiled the harness is not a sort that can be hashed and compared
  // across machines. Demonstrated divergence on realistic names: localeCompare
  // orders ["Read", "mcp__fs__read", "read"] differently from byte order, and
  // MCP tools carry exactly that shape of name.
  return [...(config.tools.tools ?? [])].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
}

/** The context-window policy, fully resolved with declared defaults. */
export interface ResolvedContext {
  policy: ContextPolicy;
  retain_after: number;
  max_context_tokens: number;
  compaction: Compaction;
  summary_role: string;
  reserve_output: number;
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
    reserve_output: (() => {
      const budget = pickInt(defaults.max_context_tokens, 65536);
      // 15% of the window, at least 1024 — but never more than 40% of it.
      // Without the cap a small max_context_tokens was consumed entirely by
      // the floor, leaving no room for history at all.
      const wanted = Math.max(1024, Math.floor(budget * 0.15));
      return pickInt(ctx.reserve_output, Math.min(wanted, Math.floor(budget * 0.4)));
    })(),
  };
}

/** The `[ui]` block, fully resolved with defaults. */
export interface ResolvedUi {
  theme: string;
  meta: MetaField[];
  meta_style: MetaStyle;
  think: ThinkMode;
  cot: CotMode;
  spinner: boolean;
  color: boolean;
  /**
   * Render the answer's markdown, rather than printing the source.
   *
   * A model answers in markdown whether or not anything reads it, so a
   * comparison table arrived as a wall of pipes and `**bold**` kept its
   * asterisks. Off prints exactly what the model returned, which is what you
   * want when the answer *is* the markdown you are about to paste elsewhere.
   */
  markdown: boolean;
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
export const COT_MODES: CotMode[] = ["off", "brief", "tools", "think", "full"];

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
    theme: typeof ui.theme === "string" && ui.theme ? ui.theme : "dark",
    meta:
      declared ?? ["turn", "role", "model", "bucket", "duration", "context", "tools"],
    meta_style: pickEnum(ui.meta_style, META_STYLES, "line"),
    think: pickEnum(ui.think, THINK_MODES, "collapse"),
    cot: pickEnum(ui.cot, COT_MODES, "full"),
    spinner: typeof ui.spinner === "boolean" ? ui.spinner : true,
    color: typeof ui.color === "boolean" ? ui.color : true,
    markdown: typeof ui.markdown === "boolean" ? ui.markdown : true,
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

/** The only keys an [endpoints.<name>] block may carry. */
const ENDPOINT_KEYS = new Set(["url", "kind", "api_key_env", "provider"]);

/**
 * Every key a [roles.*] block may carry.
 *
 * Unknown keys here are FATAL, unlike an unknown endpoint field, because the
 * failure direction is toward MORE capability. `buildToolSet` reads
 * `config.roles[role]?.tools` and treats undefined as "everything declared", so
 * writing `tool = [...]` instead of `tools = [...]` hands the role every tool in
 * the surface. `bash_alow` deletes an allow-list the same way -- the enforcement
 * is `if (ctx.bashAllow && ctx.bashAllow.length > 0)`. A verifier that a dropped
 * character has silently converted into unrestricted bash still prints its own
 * description, "Runs the suite. Cannot alter what it judges."
 *
 * A role block has a small closed key set and no legitimate reason to carry an
 * unread key, so this refuses to start rather than warn.
 */
/**
 * Argument forms that turn a read-only-looking program into an arbitrary write.
 *
 * An allow-list of PROGRAM NAMES cannot confine a program that takes a command
 * as an argument. The shipped verifier allowed `find`, described itself as
 * "Runs the suite and reports. Cannot write.", and was measured executing
 * `find . -exec sh -c 'echo PWNED > /tmp/x' \;` and `find target.txt -delete`
 * successfully -- the redirection lives inside a quoted argument, so the
 * command scanner correctly sees no redirection at all.
 *
 * gnomon does not silently override the operator's declaration here; that would
 * be the harness deciding policy. It says the declaration is weaker than it
 * looks, which is the thing the operator cannot see for themselves.
 */
const EXECUTING_ARGS: Array<[RegExp, string, RegExp]> = [
  // [what the allow-list admits, why it executes, what a deny must mention to
  //  actually neutralise THAT admission]
  //
  // The third column exists because the guard used to be one loose test
  // applied to the whole deny-list -- /exec|delete|fprint|-c\b/ against any
  // entry -- and the starter surface's own rule for `git push --delete`
  // contains the substring "delete". So every surface scaffolded by
  // `gnomon init` silently satisfied the guard and this warning never fired
  // again, on any role, however its bash_allow read. A check that the shipped
  // default disables is worse than no check: it reports safety it never
  // verified. Each admission is now guarded on its own terms.
  [/\bfind\b/, "find (-exec, -execdir, -delete, -fprintf all write or run)",
   /-exec|-execdir|-ok\b|-okdir|-delete|-fprint/],
  [/\bxargs\b/, "xargs (runs whatever it is piped)", /\bxargs\b/],
  [/\benv\b/, "env (runs its argument)", /\benv\b/],
  [/\b(sh|bash|zsh|ksh|dash)\b/, "a shell (runs anything)",
   /\b(sh|bash|zsh|ksh|dash)\b|-c\b/],
  [/\b(awk|gawk|perl|python3?|ruby|node)\b/, "an interpreter (runs anything)",
   /\b(awk|gawk|perl|python3?|ruby|node)\b/],
  [/\bgit\b(?!\s*\()/, "git (-c core.pager / alias.* run commands)",
   /core\.pager|alias\.|-c\b/],
];

/**
 * Which file each top-level block is READ from.
 *
 * A block in the wrong file is legal TOML, hashes into the surface, and is read
 * by nothing. That is not hypothetical: a [verify] block sat in config.toml
 * instead of policy.toml for days, silently disabling the declared check, and
 * the campaign that missed it is the reason this audit exists. The two files sit
 * side by side, both are TOML, both are hashed, and the block is valid in both —
 * there is no way for an operator to see the difference unaided.
 *
 * Fatal, because a control that is declared and not read is worse than one that
 * was never declared: the surface says the check runs.
 */
/**
 * Every top-level block either surface file may declare.
 *
 * A misspelled block name — [resilence], [aproval], [sandobx] — is legal TOML,
 * hashes into the surface, and is read by nothing, so the setting it contains
 * silently reverts to the default. That is the same failure as the misplaced
 * [verify] block, one letter earlier.
 */
const KNOWN_BLOCKS = new Set([
  "endpoints", "defaults", "context", "ui", "routing", "resilience", "audit",
  "session", "process", "tools", "verify", "approval", "sandbox", "exit_codes",
]);

/** Keys whose VALUE is a closed set, and what silently happens to a typo. */
const ENUM_KEYS: Record<string, { values: string[]; falls_back_to: string }> = {
  approval: { values: ["never", "on_write", "always"], falls_back_to: "on_write" },
  sandbox: { values: ["off", "confined", "strict"], falls_back_to: "confined" },
};

/**
 * Keys that are read from a different block than the one an operator reaches
 * for first.
 *
 * `compaction` and `max_context_tokens` are read from [defaults], while the
 * block named [context] sits directly above them — so putting them under
 * [context], which is what the names invite, silently does nothing and the
 * window keeps its 65536-token default. Found the hard way: this exact mistake
 * cost a benchmark run today, in a session whose whole subject was misplaced
 * configuration.
 */
const KEY_OWNER: Record<string, string> = {
  compaction: "defaults",
  max_context_tokens: "defaults",
  edit_format: "defaults",
  role_profile: "defaults",
  policy: "context",
  retain_after: "context",
  summary_role: "context",
  reserve_output: "context",
};

const BLOCK_OWNER: Record<string, string> = {
  verify: "policy.toml",
  approval: "policy.toml",
  sandbox: "policy.toml",
  endpoints: "config.toml",
  defaults: "config.toml",
  context: "config.toml",
  ui: "config.toml",
  routing: "config.toml",
  resilience: "config.toml",
  audit: "config.toml",
  roles: "roles.toml",
  tools: "tools.toml",
};

const ROLE_KEYS = new Set(["allowed_edit_formats", "bash_allow", "bash_deny", "converge_after", "description", "endpoint", "fallback", "max_steps", "max_steps_total", "model", "exec", "image", "profile", "task_allow", "temperature", "tools", "top_p", "write_allow"]);

/**
 * Spellings people reach for when they mean to supply a secret directly.
 *
 * Every one of them is silently ignored today: the block is read into
 * EndpointConfig, which has no field for them, so no Authorization header is
 * ever built. The endpoint then fails with the provider's own 401 and nothing
 * points at the cause — while the secret sits in a content-hashed directory
 * that is meant to be committable. Two failures wearing one typo.
 */
const SECRET_KEYS = new Set([
  "api_key",
  "apikey",
  "apiKey",
  "key",
  "token",
  "secret",
  "password",
  "authorization",
  "bearer",
]);

export interface SurfaceProblem {
  /** File and block, as a reader would look for it */
  where: string;
  problem: string;
  fix: string;
  /**
   * Fatal problems stop the session. Reserved for a surface that cannot do
   * what it says: a secret that is both exposed and inert, an endpoint with
   * no URL, a role pointing at an endpoint nobody declared.
   */
  fatal: boolean;
}

/**
 * Read the surface for things that are wrong but silent.
 *
 * Every check here exists because the failure it catches surfaced somewhere
 * far away from its cause — a 401 in the middle of a task, an endpoint that
 * was never reachable, a model tag no backend has. Offline and cheap on
 * purpose: it runs before the first turn, so it may not make a network call.
 * Whether a *key* works is a different question, and only the endpoint can
 * answer it — see probeEndpointAuth.
 */
/** Levenshtein, for "did you mean" on a misspelled surface key. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return d[a.length]![b.length]!;
}

export function auditSurface(config: GnomonConfig): SurfaceProblem[] {
  const problems: SurfaceProblem[] = [];
  const declared = config.config.endpoints ?? {};

  // A block name nothing recognises, and an enum value nothing accepts. Both
  // revert to a default without saying so, and both are one keystroke away from
  // a control the operator believes is in force.
  for (const [file, parsed] of [
    ["config.toml", config.config],
    ["policy.toml", config.policy],
  ] as const) {
    for (const [block, body] of Object.entries((parsed ?? {}) as Record<string, unknown>)) {
      if (!KNOWN_BLOCKS.has(block)) {
        const near = [...KNOWN_BLOCKS]
          .map((k) => [k, editDistance(block, k)] as const)
          .filter(([, d]) => d <= 2)
          .sort((a, b) => a[1] - b[1])[0]?.[0];
        problems.push({
          where: `.gnomon/${file} [${block}]`,
          problem:
            `[${block}] is not a block this harness reads` +
            (near ? `. Did you mean "${near}"?` : "; it does nothing."),
          fix: `Known blocks: ${[...KNOWN_BLOCKS].sort().join(", ")}.`,
          fatal: false,
        });
        continue;
      }
      const spec = ENUM_KEYS[block];
      const value = (body as Record<string, unknown> | undefined)?.[block === "approval" ? "gate" : "level"];
      if (spec && typeof value === "string" && !spec.values.includes(value)) {
        problems.push({
          where: `.gnomon/${file} [${block}]`,
          problem:
            `"${value}" is not one of ${spec.values.join(" | ")}, so this silently ` +
            `falls back to "${spec.falls_back_to}".`,
          fix: `Use one of: ${spec.values.join(", ")}. \`gnomon enumerations\` lists them.`,
          fatal: false,
        });
      }
    }
  }

  // Every pattern the surface declares must actually compile.
  //
  // bash_allow / bash_deny / write_allow are compiled inside the tool at CALL
  // time, so an uncompilable pattern is discovered mid-run or not at all. The
  // two failure directions are opposite and both bad: a broken DENY makes every
  // command refused (the role is dead), while a broken ALLOW silently
  // contributes nothing (the role is wider than it reads). audit.redact is
  // already validated at startup and warned about loudly; these were not.
  for (const [role, rawRole] of Object.entries(config.roles ?? {})) {
    const where = `.gnomon/roles.toml [roles.${role}]`;
    for (const key of ["bash_allow", "bash_deny"] as const) {
      const list = (rawRole as RoleDef)?.[key];
      if (!Array.isArray(list)) continue;
      for (const pattern of list) {
        if (typeof pattern !== "string") continue;
        try {
          new RegExp(pattern);
        } catch (e) {
          problems.push({
            where,
            problem: `${key} pattern ${JSON.stringify(pattern)} is not a valid regular expression: ${(e as Error).message}`,
            fix:
              key === "bash_deny"
                ? `While it cannot be compiled, bash is refused outright — this role can run nothing. Fix or remove the pattern.`
                : `An allow-list entry that cannot compile contributes nothing, so this role is wider than it reads. Fix or remove it.`,
            // A dead deny is a dead role; a dead allow is a quiet widening.
            fatal: key === "bash_deny",
          });
        }
      }
    }
  }

  // routing.rules written with single brackets is a table, not an array of
  // tables — legal TOML, silently yielding zero rules while mode = "auto".
  {
    const routing = (config.config as { routing?: { rules?: unknown; mode?: unknown } } | undefined)?.routing;
    if (routing && "rules" in routing && routing.rules !== undefined && !Array.isArray(routing.rules)) {
      problems.push({
        where: `.gnomon/config.toml [routing]`,
        problem:
          `routing.rules is a ${typeof routing.rules === "object" ? "table" : typeof routing.rules}, not an array of tables — ` +
          `so no routing rules are loaded at all.`,
        fix: `Write each rule as [[routing.rules]] with double brackets.`,
        fatal: false,
      });
    }
  }

  // A key in the neighbouring block is read by nothing either.
  for (const [file, parsed] of [
    ["config.toml", config.config],
    ["policy.toml", config.policy],
  ] as const) {
    for (const [block, body] of Object.entries((parsed ?? {}) as Record<string, unknown>)) {
      if (!body || typeof body !== "object") continue;
      for (const key of Object.keys(body as Record<string, unknown>)) {
        const owner = KEY_OWNER[key];
        if (!owner || owner === block) continue;
        problems.push({
          where: `.gnomon/${file} [${block}]`,
          problem: `"${key}" is read from [${owner}], not [${block}] — here it does nothing.`,
          fix: `Move ${key} into the [${owner}] block.`,
          fatal: false,
        });
      }
    }
  }

  // A declared block that lives in the wrong file is read by nothing.
  for (const [file, parsed] of [
    ["config.toml", config.config],
    ["policy.toml", config.policy],
  ] as const) {
    for (const block of Object.keys((parsed ?? {}) as Record<string, unknown>)) {
      const owner = BLOCK_OWNER[block];
      if (!owner || owner === file) continue;
      problems.push({
        where: `.gnomon/${file} [${block}]`,
        problem:
          `[${block}] is declared here but read from ${owner} — so this block ` +
          `does nothing, while the surface reads as though it does.`,
        fix: `Move the [${block}] block to .gnomon/${owner}.`,
        fatal: true,
      });
    }
  }

  for (const [role, rawRole] of Object.entries(config.roles ?? {})) {
    const where = `.gnomon/roles.toml [roles.${role}]`;
    // An allow-list that admits a program which takes a command as an argument
    // does not constrain that role, however read-only its description claims to
    // be. Warn rather than refuse: the operator may want exactly this, and it is
    // their surface. What they cannot do is notice it unaided.
    const allow = (rawRole as RoleDef)?.bash_allow;
    if (Array.isArray(allow) && allow.length > 0) {
      const deny = (rawRole as RoleDef)?.bash_deny ?? [];
      // Guarded per admission: a deny for `git push --delete` says nothing
      // about whether `python` can still run arbitrary code.
      const admits = EXECUTING_ARGS.filter(
        ([re, , guard]) =>
          allow.some((pat) => re.test(pat)) && !deny.some((d) => guard.test(d))
      ).map(([, why]) => why);
      if (admits.length > 0) {
        problems.push({
          where,
          problem:
            `bash_allow admits ${admits.join("; ")} — so this role can run and write ` +
            `arbitrarily, whatever its tools list or description says.`,
          fix:
            `Either drop those from bash_allow (\`glob\`/\`grep\` are gated read-only tools ` +
            `that already exist), or add a bash_deny for the executing forms, e.g. ` +
            `bash_deny = ['-exec', '-execdir', '-delete', '-fprint', '\\bxargs\\b'].`,
          fatal: false,
        });
      }
    }

  // A chain stage naming a role that does not exist fails partway through a
  // turn, after the earlier stages have already spent their budget and their
  // tokens. Fatal, because the surface cannot do what it says it does.
  {
    const stages = resolveChain(config);
    for (const st of stages) {
      if (!config.roles?.[st]) {
        problems.push({
          where: ".gnomon/config.toml [chain]",
          problem: `stage "${st}" is not a role in this surface.`,
          fix: `Declared roles: ${Object.keys(config.roles ?? {}).sort().join(", ")}.`,
          fatal: true,
        });
      }
    }
    if (stages.length === 1) {
      problems.push({
        where: ".gnomon/config.toml [chain]",
        problem: `a chain of one stage ("${stages[0]}") is the same as no chain.`,
        fix: "Remove [chain], or add the stages that make it a chain.",
        fatal: false,
      });
    }
  }

  // A role holding `task` with no task_allow can delegate to any role, and a
  // sub-turn runs with the TARGET role's tools -- so its own `tools` line is
  // not the answer to what it can cause. Worth saying out loud, in the same
  // spirit as the bash_allow warning: the operator can decide this is fine,
  // what they cannot do is notice it unaided.
  for (const [roleName, rawRole] of Object.entries(config.roles ?? {})) {
    const def = rawRole as RoleDef;
    const holdsTask = !def?.tools || def.tools.includes("task");
    if (!holdsTask || def?.task_allow !== undefined) continue;
    const reachable = Object.keys(config.roles ?? {}).filter((r) => r !== roleName);
    const writers = reachable.filter((r) => {
      const t = (config.roles[r] as RoleDef)?.tools;
      return !t || t.includes("write") || t.includes("edit") || t.includes("bash");
    });
    if (writers.length === 0) continue;
    problems.push({
      where: `.gnomon/roles.toml [roles.${roleName}]`,
      problem:
        `holds \`task\` with no task_allow, so it may delegate to any role — ` +
        `including ${writers.slice(0, 3).join(", ")}${writers.length > 3 ? ", …" : ""}, ` +
        `which can write. A sub-turn runs with the TARGET role's tools, so this ` +
        `role's own tools list is not the limit of what it can cause.`,
      fix:
        `Name the roles it may delegate to, e.g. task_allow = ["${writers[0]}"]. ` +
        `An empty list forbids delegation entirely.`,
      fatal: false,
    });
  }

  // A granted extra root that is absolute, or that is not there, is worth
  // saying out loud. Neither is fatal -- a grant that resolves nowhere simply
  // grants nothing, which is the safe direction -- but both mean the surface
  // does not say what its author thought it said.
  {
    const raw = (config.policy?.sandbox as { extra_roots?: unknown } | undefined)?.extra_roots;
    if (raw !== undefined && !Array.isArray(raw)) {
      problems.push({
        where: ".gnomon/policy.toml [sandbox]",
        problem: "extra_roots is not an array.",
        fix: 'Write it as a list, e.g. extra_roots = ["../sibling-checkout"].',
        fatal: true,
      });
    } else if (Array.isArray(raw)) {
      const root = resolve(config.gnomonDir, "..");
      for (const entry of raw) {
        if (typeof entry !== "string") continue;
        if (isAbsolute(entry)) {
          problems.push({
            where: ".gnomon/policy.toml [sandbox]",
            problem:
              `extra_roots contains an absolute path (${entry}) — that is ` +
              `machine-scoped configuration, and it grants nothing on any other clone.`,
            fix: "Name it relative to the repository root instead, e.g. \"../sibling-checkout\".",
            fatal: false,
          });
        }
        const abs = isAbsolute(entry) ? resolve(entry) : resolve(root, entry);
        if (!existsSync(abs)) {
          problems.push({
            where: ".gnomon/policy.toml [sandbox]",
            problem: `extra_roots names ${entry}, which does not exist here — it grants nothing.`,
            fix: "Remove it, or check the path relative to the repository root.",
            fatal: false,
          });
        }
      }
    }
  }

    for (const field of Object.keys((rawRole ?? {}) as Record<string, unknown>)) {
      if (ROLE_KEYS.has(field)) continue;
      const near = [...ROLE_KEYS]
        .map((k) => [k, editDistance(field, k)] as const)
        .filter(([, d]) => d <= 2)
        .sort((a, b) => a[1] - b[1])[0]?.[0];
      problems.push({
        where,
        problem:
          `unknown field "${field}" — it is read by nothing` +
          (near ? `. Did you mean "${near}"?` : "."),
        fix:
          (near === "tools"
            ? `A role with no readable \`tools\` list gets EVERY declared tool, so this ` +
              `typo widens the role instead of narrowing it. `
            : near && near.endsWith("_allow")
              ? `An unreadable allow-list is not an empty one — it removes the restriction ` +
                `entirely. `
              : "") + `Roles take: ${[...ROLE_KEYS].join(", ")}.`,
        fatal: true,
      });
    }
  }

  for (const [name, raw] of Object.entries(declared)) {
    const where = `.gnomon/config.toml [endpoints.${name}]`;
    // Read as raw TOML: the point is to see the fields EndpointConfig has no
    // home for, which is exactly what the typed view hides.
    const block = (raw ?? {}) as unknown as Record<string, unknown>;

    for (const field of Object.keys(block)) {
      if (SECRET_KEYS.has(field)) {
        problems.push({
          where,
          problem:
            `${field} holds a secret in the surface — and the harness never reads it, ` +
            `so this endpoint sends no Authorization header at all.`,
          fix:
            `Delete the ${field} line, then:  gnomon key set ${name}\n` +
            `      and declare  api_key_env = "<VARIABLE_NAME>"  in its place. ` +
            `Rotate the exposed key: .gnomon/ is hashed and meant to be committed.`,
          fatal: true,
        });
        continue;
      }
      if (!ENDPOINT_KEYS.has(field)) {
        problems.push({
          where,
          problem: `unknown field "${field}" — it is read by nothing.`,
          fix: `Endpoints take: ${[...ENDPOINT_KEYS].join(", ")}. Check the spelling.`,
          fatal: false,
        });
      }
    }

    if (!block.url) {
      problems.push({
        where,
        problem: "no url — nothing can be sent here.",
        fix: `Add url = "https://…/chat/completions" (or an Ollama /api/chat).`,
        fatal: true,
      });
    }

    const kind = block.kind;
    if (kind !== undefined && kind !== "openai" && kind !== "ollama") {
      problems.push({
        where,
        problem: `kind = "${String(kind)}" is not a request shape the harness knows.`,
        fix: 'kind is "openai" or "ollama".',
        fatal: true,
      });
    }
  }

  const known = new Set(listEndpoints(config));
  for (const [role, def] of Object.entries(config.roles ?? {})) {
    const targets: Array<[string, string | undefined, string | undefined]> = [
      [`[roles.${role}]`, def?.endpoint, def?.model],
      [`[roles.${role}.fallback]`, def?.fallback?.endpoint, def?.fallback?.model],
    ];

    for (const [block, endpoint, model] of targets) {
      if (endpoint === undefined && model === undefined) continue;
      const where = `.gnomon/roles.toml ${block}`;

      if (endpoint !== undefined && !known.has(endpoint)) {
        problems.push({
          where,
          problem: `endpoint = "${endpoint}" is not declared.`,
          fix: `Declared: ${[...known].sort().join(", ")}. Add [endpoints.${endpoint}] or point this at one of those.`,
          fatal: true,
        });
        continue;
      }

      // An Ollama tag on a cloud endpoint, or the reverse. Not conclusive —
      // only the endpoint's own model list is — but it is the mistake that
      // gets made, and it costs nothing to say so before the turn that fails.
      if (!model || endpoint === undefined) continue;
      const url = declared[endpoint]?.url ?? BUILTIN_ENDPOINTS[endpoint]?.url;
      if (!url) continue;
      const local = isLocalEndpoint(url);
      const looksLocal = /:\d|:[a-z0-9._-]*(b|q\d)/i.test(model) && model.includes(":");
      if (!local && looksLocal) {
        problems.push({
          where,
          problem: `model = "${model}" is an Ollama-style tag, but "${endpoint}" is a cloud endpoint.`,
          fix: `Run /models to see what "${endpoint}" actually serves.`,
          fatal: false,
        });
      }
    }
  }

  return problems;
}

/**
 * Ask an endpoint whether a key is accepted for *inference*.
 *
 * A model list is not the test. opencode.ai serves /v1/models to an unset
 * key, a wrong key and no key at all — 200 every time — so a listing that
 * worked was read as a key that worked, and the first honest signal was a 401
 * several turns into a session. The smallest possible completion is the only
 * thing that answers the question actually being asked.
 */
export async function probeEndpointAuth(
  endpoint: EndpointConfig,
  model: string,
  timeoutMs = 20000
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const key = endpoint.api_key_env ? process.env[endpoint.api_key_env] : undefined;
  if (endpoint.api_key_env && !key) {
    return { ok: false, detail: `$${endpoint.api_key_env} is not set` };
  }

  const ollama = (endpoint.kind ?? "ollama") === "ollama";
  const body = ollama
    ? { model, messages: [{ role: "user", content: "hi" }], stream: false }
    : { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, status: res.status };
    const text = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: res.status, detail: text || res.statusText };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
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
 * Whether an endpoint URL is the operator's own hardware rather than a cloud.
 *
 * The distinction is the one a reader keeps confusing — a role on a cloud
 * endpoint must name a model that endpoint hosts, never a local Ollama tag —
 * so the listings mark each endpoint local or cloud from this. localhost, the
 * LAN (RFC1918), and Tailscale's CGNAT range (100.64.0.0/10) are all local.
 */
export function isLocalEndpoint(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host)) return true;
  if (host.endsWith(".local")) return true;
  return (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
  );
}

const KNOWN_PROVIDERS: Array<[RegExp, string]> = [
  [/(^|\.)openrouter\.ai$/, "openrouter"],
  [/(^|\.)opencode\.ai$/, "opencode"],
  [/(^|\.)githubcopilot\.com$/, "copilot"],
  [/\.openai\.azure\.com$/, "azure"],
  [/(^|\.)azure\.com$/, "azure"],
  [/(^|\.)amazonaws\.com$/, "aws"],
  [/(^|\.)googleapis\.com$/, "google"],
  [/(^|\.)anthropic\.com$/, "anthropic"],
  [/(^|\.)openai\.com$/, "openai"],
  [/(^|\.)mistral\.ai$/, "mistral"],
  [/(^|\.)together\.(ai|xyz)$/, "together"],
  [/(^|\.)groq\.com$/, "groq"],
];

/**
 * Classify an endpoint for a listing: is it the operator's own hardware or a
 * cloud, and which provider. `provider` (if the surface set it) wins; otherwise
 * it is inferred from the host. Display only — routing never consults this.
 */
export function endpointClass(
  url: string,
  kind?: EndpointKind,
  provider?: string
): { where: "local" | "cloud"; provider: string } {
  const where = isLocalEndpoint(url) ? "local" : "cloud";
  if (provider) return { where, provider };
  if (where === "local") {
    return { where, provider: kind === "ollama" ? "ollama" : "self-hosted" };
  }
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  for (const [re, name] of KNOWN_PROVIDERS) {
    if (re.test(host)) return { where, provider: name };
  }
  return { where, provider: host || "custom" };
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
      // POSIX separators always. The path string is hashed, so `join()` on
      // Windows puts backslashes into the manifest and the same tree gets two
      // hashes. Worse: recomputeManifest looks the canonical SURFACE_PATHS up by
      // exact string, so every one of them misses and is recorded absent while
      // the real files are listed again as extras. No-op where sep is "/".
      const relPath = join(".gnomon", relative(gnomonDir, fullPath))
        .split(sep)
        .join("/");
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        // skills/proposed/ is staging, not surface. DESIGN.md gives the reason
        // the `skill` tool writes there at all: "An agent rewriting its own
        // skills mid-session would change the hash underneath the run that
        // changed it -- so the skill tool writes to skills/proposed/, which is
        // not loaded". Half of that was true. The proposal is genuinely not
        // loaded and cannot change behaviour -- but it sits inside .gnomon/,
        // so it was hashed, and the hash moved anyway. Measured: a coordinator
        // turn that proposed one skill left the surface hash at aa71d075c48e
        // where its own audit record had stamped d715443b4af3.
        //
        // README names that exact harm as the thing the surface block prevents:
        // an agent must not "move the surface hash, which is the one identifier
        // a session is traced by". So excluding staging is not a narrowing of
        // what the hash covers, it is the hash finally meaning what it is
        // documented to mean -- everything that decides how the agent behaves,
        // and identical hashes for identical rules in BOTH directions.
        //
        // Nothing becomes invisible. `gnomon skill list` shows proposals, and
        // accepting one moves the file into skills/, which is hashed -- so the
        // moment a proposal can affect behaviour is exactly the moment it
        // starts counting.
        if (relPath !== ".gnomon/skills/proposed") walk(fullPath);
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
 * Absolute extra roots granted by `[sandbox] extra_roots`, resolved against the
 * repository root so a surface can name a sibling checkout as `"../other"` and
 * stay portable.
 *
 * Relative entries are the point: an absolute path in the surface would be
 * machine-scoped configuration, which Rule 1 forbids. `../other` means the same
 * thing on every clone that has the same two repositories side by side, and
 * means nothing -- resolving to a path that simply does not exist, and so
 * granting nothing -- on one that does not.
 */
export function resolveExtraRoots(config: GnomonConfig): string[] {
  const raw = (config.policy?.sandbox as { extra_roots?: unknown } | undefined)?.extra_roots;
  if (!Array.isArray(raw)) return [];
  const root = resolve(config.gnomonDir, "..");
  return raw
    .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    .map((r) => (isAbsolute(r) ? resolve(r) : resolve(root, r)));
}

/** Where `bash` actually runs. See resolveExec. */
export interface ResolvedExec {
  mode: "off" | "docker";
  image: string;
  /** Whether the sandbox gets a network. Follows [sandbox] network. */
  network: boolean;
}

/**
 * Resolve `[sandbox] exec`, with a per-role override in roles.toml.
 *
 * The sandbox LEVEL governs tool paths and has never governed `bash` -- a role
 * that runs builds and installers cannot have its shell enumerated in advance,
 * so `strict` still runs `cat /etc/passwd`. This is the other half: not what
 * paths a tool may name, but where the shell itself executes.
 *
 * "off" is the default and changes nothing, so no existing surface moves. It is
 * opt-in per surface and per role, which is the point -- one role can run its
 * calculations in a container while the rest of the harness runs on the host.
 *
 * Only "docker" is wired. bwrap was tested first and cannot work on stock
 * Ubuntu without relaxing the AppArmor restriction on unprivileged user
 * namespaces: `bwrap: setting up uid map: Permission denied`, with
 * /proc/sys/kernel/unprivileged_userns_clone already 1. A backend that cannot
 * start must refuse rather than silently run unsandboxed, so it is not offered
 * rather than offered-and-broken.
 */
export function resolveExec(config: GnomonConfig, role?: string): ResolvedExec {
  const sandbox = (config.policy?.sandbox ?? {}) as {
    exec?: unknown;
    image?: unknown;
    network?: unknown;
  };
  const roleDef = role ? (config.roles?.[role] as RoleDef | undefined) : undefined;
  const raw = (roleDef?.exec ?? sandbox.exec) as unknown;
  const mode = raw === "docker" ? "docker" : "off";
  const image =
    (typeof roleDef?.image === "string" && roleDef.image) ||
    (typeof sandbox.image === "string" && sandbox.image) ||
    "debian:stable-slim";
  return { mode, image, network: sandbox.network === true };
}

/**
 * A declared role chain: the stages one turn passes through, in order.
 *
 * The separation this buys is the one the harness was built around, and until
 * now it existed only across turns a person drove by hand. `task` lets a model
 * reach for it mid-turn; this makes it the shape of the turn itself.
 *
 * Declared in the surface rather than typed at a keyboard, because a chain a
 * human types is machine-scoped behaviour of the worst kind: it lives in their
 * habits, it is not hashed, it is not in the manifest, and it does not
 * reproduce on another machine. Declared, it is data — hashed, diffable, and
 * identical everywhere.
 *
 * Absent means the current behaviour: one role answers. Nothing existing moves.
 *
 * Rule 4 is the constraint that shapes the rest: every stage keeps its OWN
 * bucket and its own record. The chain never collapses three outcomes into a
 * composite verdict, because that is precisely the thing this harness refuses
 * to do.
 */
export function resolveChain(config: GnomonConfig): string[] {
  const raw = (config.config as { chain?: { stages?: unknown } } | undefined)?.chain?.stages;
  if (!Array.isArray(raw)) return [];
  const stages = raw.filter((r): r is string => typeof r === "string" && r.trim().length > 0);
  // A stage naming a role that does not exist would fail mid-turn, after the
  // earlier stages had already spent their budget. auditSurface reports it.
  return stages;
}

/** Resolved [resilience]: what the harness does when the endpoint misbehaves. */
export interface ResolvedResilience {
  attempts: number;
  backoff_ms: number;
  request_timeout_ms: number;
  /**
   * How long to keep waiting out an endpoint that will not answer the socket
   * at all, in milliseconds. 0 restores the old behaviour (give up after
   * `attempts`). See callEndpointWithRetry for why this is separate from
   * `attempts`.
   */
  transport_grace_ms: number;
}

/**
 * Read [resilience] from config.toml.
 *
 * In the surface, not the environment, because a harness that retried three
 * times here and once there would not be the same harness — and the timeout in
 * particular decides what counts as apparatus failure, which is a behaviour.
 * GNOMON_MODEL_TIMEOUT_MS used to set it from the shell, which is exactly the
 * machine-scoped configuration Rule 1 forbids.
 *
 * Retrying is not a behaviour in the sense determinism cares about: it does not
 * change what the harness decides, only how many times it asks before giving
 * up on a socket. What would break determinism is retrying a *different* number
 * of times per machine, which is why the count is hashed with everything else.
 */
export function resolveResilience(config: GnomonConfig): ResolvedResilience {
  const r = (config.config as { resilience?: Record<string, unknown> } | undefined)
    ?.resilience;
  const num = (v: unknown, d: number) =>
    typeof v === "number" && isFinite(v) && v >= 0 ? v : d;
  return {
    // 1 attempt means "try once, do not retry" — the behaviour before this
    // existed, and still the value a surface can choose.
    attempts: Math.max(1, Math.floor(num(r?.attempts, 3))),
    backoff_ms: Math.floor(num(r?.backoff_ms, 500)),
    request_timeout_ms: Math.max(1000, Math.floor(num(r?.request_timeout_ms, 300_000))),
    // 60s rides out the transient provider blips that are actually observed —
    // the one that prompted this lasted 54 — while staying far inside a
    // 900s harness wall. It is spent at most once per turn, because an
    // endpoint that is still unreachable afterwards ends the turn.
    transport_grace_ms: Math.floor(num(r?.transport_grace_ms, 60_000)),
  };
}

/** A resolved [verify] block, or null when the surface declares none. */
export interface ResolvedVerify {
  command: string;
  after: "write" | "always";
  max_rounds: number;
  /**
   * Reject a test that would have passed before the turn wrote it.
   *
   * A test is only worth having if it FAILS on the code as it was and PASSES on
   * the code as it is. Measured on this harness: a model wrote a test meeting
   * that bar 1 time in 9, and three of the nine asserted the BUG as the
   * contract -- tests that pass today and block the correct fix tomorrow.
   *
   * Telling the model to write good tests is instruction. Running the new test
   * against the pre-turn code and refusing it if it passes is capability, which
   * is the side of that line this harness is supposed to be on.
   *
   * Off by default: it re-runs the check once more per turn, and a surface that
   * has not asked for it should not pay that.
   */
  test_must_fail_first: boolean;
  /** Which paths count as tests. Globs, matched against the repo-relative path. */
  test_paths: string[];
}

/**
 * Read [verify] from policy.toml.
 *
 * Returns null unless a command is declared, so every call site can treat "no
 * gate" as the ordinary case rather than a special one.
 */
export function resolveVerify(config: GnomonConfig): ResolvedVerify | null {
  const v = (config.policy as { verify?: Record<string, unknown> } | undefined)?.verify;
  const command = typeof v?.command === "string" ? v.command.trim() : "";
  if (!command) return null;
  const after = v?.after === "always" ? "always" : "write";
  const rounds = typeof v?.max_rounds === "number" ? v.max_rounds : 1;
  return {
    command,
    after,
    // Zero is a legitimate setting: run the check, report it, never hand the
    // turn back. Negative is not.
    max_rounds: Math.max(0, Math.floor(rounds)),
    test_must_fail_first: v?.test_must_fail_first === true,
    test_paths:
      Array.isArray(v?.test_paths) && v.test_paths.length > 0
        ? (v.test_paths as string[])
        : ["**/test_*.py", "**/*_test.py", "**/*.test.ts", "**/*.test.js", "**/tests/**"],
  };
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

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
// Deliberate cycle: skills.ts imports parseToml from here. Both directions are
// used only inside function bodies, never at module scope, so the partially
// initialised namespace an ESM cycle hands the second module to load is never
// touched. The alternative -- a second directory reader inside auditSurface --
// is worse: the audit would then be checking files the runtime does not
// necessarily load. loadSkills is the reader the turn uses, so the audit sees
// exactly what the turn will see.
import { loadSkills } from "./skills.js";
import { harnessBuild } from "./build.js";
import { AUTO_WINDOW, rememberedWindow, type ContextSource } from "./context_window.js";
import { COMPLETION_GATE_MODES, auditCompletionGate } from "./completion_gate.js";
import {
  ENV_SNAPSHOT_ID,
  ENV_SNAPSHOT_LIMITS,
  auditSweepKnobs,
  envSnapshotCommand,
  resolveEnvSnapshot,
  resolveReasoningEffort,
  samplingOmitted,
  type ReasoningEffort,
  type SamplingParam,
} from "./sweep_knobs.js";

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
  shadow?: ShadowConfig;
}

/**
 * config.toml [shadow] — what a decision model WOULD have decided, logged.
 *
 * At three points -- abort after a tool call, role for a prompt, approval for
 * a call -- a typed decision model is asked the decisionbench question, and its
 * answer is written beside what gnomon actually did. Nothing reads the answer
 * back. The block exists so decision models can be ranked on real runs without
 * any of them deciding anything.
 *
 * Declared here rather than switched on by the machine, because of Rule 1: a
 * run that called a model after every tool call is a different run, and the
 * hash has to say so even when the calls changed nothing.
 */
export interface ShadowConfig {
  enabled?: boolean;
  /** A `/v1/systemone` endpoint: state + typed questions in, probabilities out */
  url?: string;
  /** Models asked the abort question at each scored tool call */
  abort?: string[];
  /** Models asked which role should handle each prompt */
  role?: string[];
  /** Models asked whether each tool call should have been put to the operator */
  approval?: string[];
  /** Option orders asked: "fwd" as the bench wrote them, "rev" reversed */
  orders?: string[];
  timeout_ms?: number;
  abort_timeout_ms?: number;
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
  /**
   * Stream the reply as server-sent events. Absent means `[defaults] stream`.
   * Ollama's own /api/chat is called unstreamed whatever this says. See
   * resolveStream.
   *
   * Declare `false` for an OpenAI-compatible server that cannot stream, or that
   * streams without reporting usage: a streamed call asks for usage with
   * `stream_options.include_usage`, and a server that ignores it leaves the
   * token counts blank.
   */
  stream?: boolean;
  /**
   * The output limit sent with every call here (`max_tokens`, or Ollama's
   * `num_predict`). A role's own `max_tokens` wins; absent from both, it is
   * `[defaults] max_tokens`, and absent from that, none. 0 sends none. See
   * resolveMaxTokens.
   */
  max_tokens?: number;
  /**
   * The context window of the model behind this endpoint, in tokens. Replaces
   * `[defaults] max_context_tokens` for a turn routed here, so a cloud model
   * with a large window is not trimmed to a budget sized for a local one.
   *
   * `"auto"` reads it from the endpoint's listing once per process, for the
   * model the role names, and falls back to `[defaults] max_context_tokens`
   * with a note when the listing says nothing (context_window.ts).
   */
  max_context_tokens?: number | typeof AUTO_WINDOW;
  /**
   * Send each assistant message's reasoning back as `reasoning_content`. See
   * resolveReplayReasoning for the default and why it is off almost everywhere.
   */
  replay_reasoning?: boolean;
  /**
   * The role gnomon's own mid-conversation messages (nudges, the convergence
   * push, a failed verification, the wrap-up, context notices) are sent in.
   * `system`, the default, is how they have always gone. `user` sends each as
   * a user message marked `[gnomon] `. See resolveSteerRole.
   */
  steer_role?: SteerRole;
  /**
   * The reasoning effort sent with every call here, as `reasoning_effort`
   * (low | medium | high | max), unless the role declares its own. Absent
   * sends none. Not sent to an Ollama /api/chat endpoint. sweep_knobs.ts,
   * docs/CONTRACTS.md §32.
   */
  reasoning_effort?: string;
  /**
   * `"provider"` sends no temperature and no top_p here, whatever the role
   * declares, so the provider's defaults apply. `"harness"`, the default,
   * sends the role's. sweep_knobs.ts, docs/CONTRACTS.md §32.
   */
  sampling?: string;
}

export type EndpointKind = "ollama" | "openai";

/** The values `[endpoints.<name>] steer_role` takes. */
export const STEER_ROLES = ["system", "user"] as const;
export type SteerRole = (typeof STEER_ROLES)[number];

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
export type CotMode = "off" | "brief" | "tools" | "think" | "work" | "full";

/** config.toml [defaults] */
export interface Defaults {
  edit_format?: string;
  sandbox?: string;
  approval?: string;
  role_profile?: string;
  max_context_tokens?: number;
  /**
   * Stream replies from OpenAI-shaped endpoints that do not declare `stream`
   * themselves. Absent means false, the behaviour before streaming existed;
   * `gnomon init` writes true and `gnomon migrate` adds it. See resolveStream.
   */
  stream?: boolean;
  /**
   * Output limit when neither the role nor its endpoint declares one. Absent
   * means none is sent; `gnomon init` writes DEFAULT_MAX_TOKENS.
   */
  max_tokens?: number;
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
  /**
   * How a request's tokens are counted for the turn's trims. "chars4", the
   * default: ~4 characters a token (estimateTokens), the same on every
   * machine. "calibrated": that estimate times the ratio of the provider's
   * reported prompt_tokens to it, measured per endpoint and model over the
   * session's requests so far, so a trim bounds what the provider counts.
   * Measured: on C2D (2026-11) the provider counted more than the 65,536
   * window on 85 of 156 requests. docs/CONTRACTS.md §29.
   */
  token_estimate?: TokenEstimate;
  /**
   * Observation masking, opt-in: `[context.mask_observations]`. Absent means
   * every tool result stays verbatim until the overflow trim, as before. See
   * resolveMasking.
   *
   * A sub-table, not the inline `mask_observations = { keep_last = 10 }` the
   * name invites: gnomon's TOML subset reads an inline table as the STRING
   * "{ keep_last = 10 }" (CONTRACTS.md §5.3), so that spelling would be
   * hashed, look configured and do nothing. auditSurface refuses it.
   */
  mask_observations?: MaskObservationsConfig;
  /**
   * The environment bootstrap, opt-in: the id of a `[bootstrap.<id>]` block in
   * policy.toml. Absent means nothing runs before the first model call, as
   * before. See resolveBootstrap.
   */
  bootstrap?: string;
  /**
   * The built-in environment snapshot, opt-in: `true` runs a fixed, read-only
   * probe (sweep_knobs.ts envSnapshotCommand) through the bootstrap's path
   * before the first model call. A declared `bootstrap` wins over it.
   * docs/CONTRACTS.md §32.
   */
  env_snapshot?: boolean;
}

/** config.toml [context.mask_observations] */
export interface MaskObservationsConfig {
  /** The newest tool results always kept verbatim. */
  keep_last?: number;
  /** Mask only once the turn's context passes this fraction of the window. */
  at_fill?: number;
  /** ...and only when at least this many results can be masked at once. */
  batch?: number;
}

/**
 * policy.toml [bootstrap.<id>] — one read-only snapshot command per platform.
 *
 * Each platform key holds a LIST of probes, not one long string: the list is
 * what a reviewer reads and what the hash covers, and gnomon composes it into
 * the one compound command that runs (composeBootstrapCommand). In policy.toml
 * beside [verify] because it is the same kind of thing: a command the surface,
 * not the model, decides to run.
 */
export interface BootstrapDecl {
  linux?: string[];
  macos?: string[];
  windows?: string[];
  /** Cap on the snapshot put into the prompt, in bytes. */
  max_bytes?: number;
  /** Lines kept from each probe's output. */
  max_lines?: number;
  /** Deadline for the whole command; never longer than the tool timeout. */
  timeout_ms?: number;
}

/** `[context] token_estimate` */
export type TokenEstimate = "chars4" | "calibrated";
export const TOKEN_ESTIMATES: TokenEstimate[] = ["chars4", "calibrated"];

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
    /**
     * Hosts a command may name under `network = false` to download packages:
     * pip, uv and npm installs and downloads, and curl and wget GETs.
     * Default empty, which refuses every URL as before. sweep_knobs.ts,
     * shell.ts bashNetworkEgress, docs/CONTRACTS.md §32.
     */
    allow_package_index?: string[];
    // `env_whitelist` was declared here and read by nothing -- no code path, no
    // test, no doc. A surface author who wrote it got a key the harness ignores,
    // which is the published-option-that-does-nothing defect this project
    // removes rather than discloses. Deleted 2026-09-06; if environment scoping
    // is wanted it comes back as a key something reads.
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
     * which is the case the evidence supports; "change" runs it when the turn
     * changed the worktree by any route -- write/edit OR the shell -- and
     * "always" runs it on every turn that made any tool call.
     */
    after?: string;
    /**
     * How many times a failed check may hand the turn back to the model.
     * Bounded, and every re-entry still counts against max_steps_total, so a
     * check that can never pass cannot spend the budget in a circle.
     */
    max_rounds?: number;
    /** The completion gate (completion_gate.ts): "off", "checklist" or "review". */
    completion_gate?: string;
    completion_rounds?: number;
    completion_min_remaining?: number;
    completion_reviewer?: string;
  };
  exit_codes?: Record<string, string>;
  /** Environment bootstraps, by id; `[context] bootstrap` picks one. */
  bootstrap?: Record<string, BootstrapDecl>;
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
  /** A number, or `"provider"` to send none (sweep_knobs.ts). Absent is 0.2. */
  temperature?: number | "provider";
  /** A number, or `"provider"` to send none (sweep_knobs.ts). Absent is 0.9. */
  top_p?: number | "provider";
  /**
   * This role's reasoning effort, over its endpoint's: low | medium | high |
   * max, or `"provider"` to send none whatever the endpoint declares.
   * docs/CONTRACTS.md §32.
   */
  reasoning_effort?: string;
  description?: string;
  /** Named endpoint from config.toml [endpoints]; defaults to "local" */
  endpoint?: string;
  /** Output limit for this role's calls; wins over the endpoint's. 0 sends none. */
  max_tokens?: number;
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
   *
   * Each top-level command must match, and so must every program one of them
   * runs: what `find -exec`, `xargs`, `env`, `sudo`, `sh -c` or `eval` is
   * handed is checked as written. An intent filter, not containment -- see
   * bashPolicy and shell.ts.
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
   * Case-SENSITIVE regular expressions (`git branch -D` and `-d` differ only
   * by case), matched against the whole command, each top-level segment, and
   * every program the line runs in its ordinary spellings: options in any
   * order, clustered or separate, long options as their short letter
   * (`--recursive` is `-r`), and deletions or copies in their other common
   * forms (`rmdir x` is also `rm -d x`, `cat a > b` is `cp a b`). Write a
   * pattern against the short spelling. Deny wins over allow, and a pattern
   * that will not compile refuses rather than permits.
   *
   * An intent filter, not containment: a one-liner in an interpreter deletes
   * or copies with nothing here to match. `[sandbox] exec = "docker"` is the
   * containment.
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
  /**
   * Opt-in line cap (CX3), read on the `bash` and `read` declarations only.
   * On `bash`, output longer than this keeps its first and last lines and
   * says how many were omitted. On `read`, a file is shown this many lines at
   * a time and the schema gains `offset` and `limit`. Absent -- the default --
   * means the behaviour before it existed: the 32 KB byte cap alone and
   * whole-file reads. See toolMaxLines.
   */
  max_lines?: number;
  /**
   * On the `edit` declaration only: `"compat"` offers `old_string` and
   * `new_string` and matches with whitespace, then indentation, ignored when
   * an exact match finds nothing, always uniquely. `"default"` (or absent) is
   * edit as it was. sweep_knobs.ts, docs/CONTRACTS.md §32.
   */
  variant?: string;
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

    // Key = value.
    //
    // Three key forms, all of them valid TOML and all three REJECTED here until
    // 2026-09-03 with a hard "cannot parse" that killed the whole surface load:
    //
    //   max-steps = 4      bare keys may contain '-'; the old pattern was
    //                      [a-zA-Z_][a-zA-Z0-9_]* and allowed no dash at all
    //   "0" = "result"     a quoted (basic-string) key — the natural spelling
    //                      for the numeric keys an [exit_codes] block wants
    //   'lit' = 1          a literal-string key
    //
    // The error said `cannot parse "max-steps = 4"`, which reads as "you wrote
    // invalid TOML" to someone who did not. For a harness whose proposition is
    // explicit configuration, refusing correct configuration is worse than most
    // of the things it refuses on purpose.
    //
    // Dotted keys (`a.b = 1`) are still not supported, and still throw — which
    // is the honest outcome, because pretending to read one would put the value
    // somewhere the writer did not ask for.
    const kvMatch = trimmed.match(
      /^(?:([A-Za-z0-9_-]+)|"([^"]*)"|'([^']*)')\s*=\s*(.+)$/
    );
    if (kvMatch) {
      const key = kvMatch[1] ?? kvMatch[2] ?? kvMatch[3]!;
      const value = stripComment(kvMatch[4]!);
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
        // Only a COMPLETE \uXXXX / \UXXXXXXXX is decoded. The guard used to be
        // `esc[0] === "u" || esc[0] === "U"`, which is also true for the `.`
        // branch of the alternation above -- so `\U` followed by anything that
        // is not eight hex digits reached parseInt("", 16) = NaN and
        // String.fromCodePoint(NaN) threw "Invalid code point NaN", failing the
        // whole surface load.
        //
        // The string that does this in practice is a Windows path:
        // `command = "C:\Users\me\server.exe"`. `\Users` is not a valid
        // escape, so on Windows the most ordinary thing a person can write in
        // tools.toml took the entire surface down with an error naming neither
        // the file's line nor the word "escape". Found 2026-09-05 by the new
        // windows-latest job, in mcp.test.ts.
        //
        // Left alone rather than thrown on, which is what the comment above has
        // always promised: this parser is lenient, and a surface that fails to
        // load over an unrecognised escape helps nobody.
        if ((esc[0] === "u" && esc.length === 5) || (esc[0] === "U" && esc.length === 9)) {
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
/**
 * Which profile applies, and what it does.
 *
 * `role_profile` was a PUBLISHED ENUMERATION that nothing read. `gnomon init`
 * scaffolded `role_profile = "local_first"` and shipped two profile files;
 * `loadConfig` parsed them into `config.profiles`; and not one line of the
 * harness ever applied them. Rule 6 was satisfied in the letter — the options
 * were published — while `enumerations --json` advertised
 * `["local_first","frontier_plan","all_remote"]` to a reader who would
 * reasonably conclude that choosing one changed where inference goes. It did
 * not, and there is no worse thing for a config key to do.
 *
 * It also happens to be the feature that would have saved the most pain: a user
 * spent an evening hand-editing roles.toml to point `plan` at a cloud endpoint,
 * which is exactly what `role_profile = "frontier_plan"` says.
 *
 * A profile may set any per-role field — model, endpoint, temperature, tools.
 * It is merged OVER the base role, per field, so a profile that names only a
 * model leaves the endpoint alone.
 */
export function applyProfile(
  roles: Roles,
  profiles: Profiles,
  name: string | undefined
): { roles: Roles; applied?: string; problem?: string; shadowed?: ShadowedRouting[] } {
  if (!name) return { roles };
  const def = (profiles as Record<string, unknown>)[name] as
    | { roles?: Record<string, Record<string, unknown>> }
    | undefined;
  if (!def) {
    // Named and missing is a surface error, and it is reported rather than
    // ignored: silently running the base roles is how a profile becomes
    // decorative in the first place.
    const known = Object.keys(profiles).sort().join(", ") || "none";
    return { roles, problem: `profile "${name}" is not in .gnomon/profiles/ (have: ${known})` };
  }
  const overrides = def.roles ?? {};
  const merged: Roles = { ...roles };
  const shadowed: ShadowedRouting[] = [];
  for (const [role, fields] of Object.entries(overrides)) {
    // A roles.toml routing value the profile replaces with a DIFFERENT one is
    // an edit that does nothing. Equal values are the scaffold's normal state
    // and say nothing worth reporting.
    const base = (roles[role] ?? {}) as Record<string, unknown>;
    for (const field of ROUTING_FIELDS) {
      const over = (fields as Record<string, unknown>)[field];
      if (field in base && over !== undefined && base[field] !== over) {
        shadowed.push({ role, field, base: String(base[field]), profile: String(over) });
      }
    }
    merged[role] = { ...(merged[role] ?? {}), ...(fields as object) } as Roles[string];
  }
  return { roles: merged, applied: name, ...(shadowed.length > 0 ? { shadowed } : {}) };
}

/** A roles.toml `model`/`endpoint` the active profile overrides with another value. */
export interface ShadowedRouting {
  role: string;
  field: (typeof ROUTING_FIELDS)[number];
  /** The value roles.toml declares, which a run does not use. */
  base: string;
  /** The value the profile declares, which a run does use. */
  profile: string;
}

/**
 * Which file a role's `model`/`endpoint` is actually read from.
 *
 * A profile is merged OVER the base role, per field, so for a role the active
 * profile declares, `.gnomon/roles.toml` is not what a run reads. Every writer
 * and every instruction that named roles.toml unconditionally was therefore
 * wrong for exactly the roles a scaffolded project ships: `gnomon init` writes
 * `role_profile = "local_first"` and a `local_first.toml` that restates
 * `model` and `endpoint` for plan, implement, critique and smol, so the edit
 * that init and launch both tell you to make had no effect, and
 * `gnomon endpoint add --role plan` printed a routing change that never
 * happened. Found 2026-09-08 by an independent check of the v0.2.3 release.
 *
 * Only the routing fields count. A profile that sets `temperature` alone does
 * not take the role's model away from roles.toml, and saying it did would send
 * an editor to the wrong file just as surely.
 */
export interface RoleWriteTarget {
  /** Absolute path of the file whose `[roles.<role>]` block a run reads. */
  path: string;
  /** The path as a reader knows it: `.gnomon/roles.toml`, or the profile. */
  label: string;
  /** The profile that governs this role, when one does. */
  profile?: string;
  /** The routing fields that profile takes over from the base role. */
  shadowed?: string[];
}

const ROUTING_FIELDS = ["model", "endpoint"] as const;

export function roleWriteTarget(config: GnomonConfig, role: string): RoleWriteTarget {
  const base: RoleWriteTarget = {
    path: join(config.gnomonDir, "roles.toml"),
    label: ".gnomon/roles.toml",
  };
  const name = config.profile?.name;
  if (!name) return base;
  const def = (config.profiles as Record<string, unknown>)[name] as
    | { roles?: Record<string, Record<string, unknown>> }
    | undefined;
  const block = def?.roles?.[role];
  if (!block) return base;
  const shadowed = ROUTING_FIELDS.filter((f) => f in block);
  if (shadowed.length === 0) return base;
  return {
    path: join(config.gnomonDir, "profiles", `${name}.toml`),
    label: `.gnomon/profiles/${name}.toml`,
    profile: name,
    shadowed: [...shadowed],
  };
}

/**
 * The file to send someone to when they want to change a model tag.
 *
 * `init` and `launch` say "check .gnomon/roles.toml"; when a profile governs
 * every role that carries a model, that sentence names a file whose edits do
 * nothing. Returns the target that covers the most roles, so the instruction
 * points at the file the reader will actually be editing.
 */
export function modelEditTarget(config: GnomonConfig): RoleWriteTarget {
  const base: RoleWriteTarget = {
    path: join(config.gnomonDir, "roles.toml"),
    label: ".gnomon/roles.toml",
  };
  const counts = new Map<string, { target: RoleWriteTarget; n: number }>();
  for (const role of Object.keys(config.roles)) {
    const t = roleWriteTarget(config, role);
    const seen = counts.get(t.path);
    if (seen) seen.n += 1;
    else counts.set(t.path, { target: t, n: 1 });
  }
  // A tie goes to roles.toml: it is the file the reader already knows about,
  // and it is where a role the profile does not name is still edited.
  let best: { target: RoleWriteTarget; n: number } | undefined;
  for (const entry of counts.values()) {
    const better =
      !best || entry.n > best.n || (entry.n === best.n && entry.target.path === base.path);
    if (better) best = entry;
  }
  return best?.target ?? base;
}

/**
 * The second file a model pick has to touch: roles.toml, when the profile is
 * the target.
 *
 * `roleWriteTarget` made the pickers write the file a run reads, and that fixed
 * the routing. It left the surface disagreeing with itself. The scaffold
 * restates every role's `model` and `endpoint` in both roles.toml and
 * `local_first.toml`, and a pick changed only the profile, so roles.toml kept
 * the old tag. On every start after that, the shadowed-routing audit printed
 * one "is ignored" line per changed field, four to eight of them after the
 * first-run picker. Each was true, and each pointed at /models or
 * `gnomon endpoint add` as the fix, which are the commands that had caused it.
 * Found 2026-11-01 while every documented command was verified for the guide
 * (#69).
 *
 * So a pick changes both files, and the two agree again. The profile is still
 * the file that decides the route. roles.toml is updated so that it no longer
 * states a different value, and two limits keep that from becoming a second
 * routing change:
 *
 * - **Only the surface's own profile.** A `--profile` override is chosen for
 *   one run. A pick made under it goes to that profile alone. Copying it into
 *   roles.toml would move the base that `role_profile` and every other profile
 *   inherit from, and would bring the warning back on the next ordinary start.
 * - **Only lines roles.toml already has.** The pick replaces an existing
 *   `model` or `endpoint` line and never adds one. A surface that keeps routing
 *   in its profiles stays that way. A field roles.toml does not set cannot
 *   disagree with anything.
 *
 * Undefined when roles.toml is already the target, or when it must be left as
 * it is.
 */
export function roleMirrorTarget(config: GnomonConfig, role: string): RoleWriteTarget | undefined {
  const target = roleWriteTarget(config, role);
  if (!target.profile) return undefined;
  const own = (config.config.defaults as { role_profile?: string } | undefined)?.role_profile;
  if (target.profile !== own) return undefined;
  return { path: join(config.gnomonDir, "roles.toml"), label: ".gnomon/roles.toml" };
}

/**
 * Load the same surface again, under the same `--profile`.
 *
 * Both mid-session reloads (after /models writes a pick, and after a turn moves
 * the surface) called `loadConfig(root)` with no profile. A session started
 * with `--profile frontier_plan` therefore came back on the surface's
 * `role_profile` with nothing on screen to say so. /models had just written its
 * pick into frontier_plan.toml, the profile the reload stopped reading, so the
 * model it announced was not the one the next turn used.
 */
export function reloadConfig(config: GnomonConfig): GnomonConfig {
  return loadConfig(
    resolve(config.gnomonDir, ".."),
    config.profile?.overridden ? config.profile.requested : undefined
  );
}

export function loadConfig(root?: string, profileOverride?: string): GnomonConfig {
  const gnomonDir = resolveGnomonDir(root);
  const baseRoles = ((loadToml<Record<string, unknown>>(gnomonDir, "roles.toml") as Record<string, unknown>).roles ?? {}) as Roles;
  const cfg = loadToml<Config>(gnomonDir, "config.toml");
  const profiles = loadToml<Profiles>(gnomonDir, "profiles") as unknown as Profiles;
  // The surface names the default; --profile overrides it and is DISCLOSED at
  // startup, the same way GNOMON_MODEL_URL is, because it changes behaviour
  // without moving the hash.
  const wanted = profileOverride ?? (cfg.defaults as { role_profile?: string } | undefined)?.role_profile;
  const applied = applyProfile(baseRoles, profiles, wanted);

  return {
    gnomonDir,
    profile: {
      name: applied.applied,
      requested: wanted,
      overridden: Boolean(profileOverride),
      problem: applied.problem,
      ...(applied.shadowed ? { shadowed: applied.shadowed } : {}),
    },
    config: cfg,
    policy: loadToml<Policy>(gnomonDir, "policy.toml"),
    // roles.toml has [roles.X] headers → parseToml wraps in {roles: {...}}
    roles: applied.roles,
    profiles,
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
  /** Which profile was applied to `roles`, and whether a flag chose it. */
  profile?: {
    name?: string;
    requested?: string;
    overridden: boolean;
    problem?: string;
    /** roles.toml routing values this profile replaces, so a run never reads them. */
    shadowed?: ShadowedRouting[];
  };
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

/** The declarations that read `max_lines`. On any other tool it does nothing, and the audit says so. */
export const LINE_CAPPED_TOOLS = ["bash", "read"] as const;
export type LineCappedTool = (typeof LINE_CAPPED_TOOLS)[number];

/**
 * The smallest `max_lines` honoured. A window of a handful of lines turns one
 * read into dozens of calls, each paying the whole prompt again, which is the
 * opposite of what the cap is for. Below this the key is ignored and the
 * audit says so, rather than being quietly raised.
 */
export const MIN_MAX_LINES = 10;

/**
 * `max_lines` from a tool's `[[tools]]` declaration in tools.toml, when it is
 * a whole number of at least MIN_MAX_LINES; otherwise undefined, which is the
 * behaviour before the key existed.
 *
 * Opt-in, and in tools.toml beside `timeout_seconds` because both change what
 * one tool does, and because Rule 3 puts tool schemas there: declaring it on
 * `read` changes read's schema, and the surface hash moves with it. Read from
 * tools.toml only, as `timeout_seconds` is; the `[[tools]]` overrides in
 * config.toml carry `enabled` and nothing else.
 *
 * NOT VERIFIED as a default: SWE-agent's ACI found a windowed file view beat
 * whole-file views by 5.3 points, on other models and another harness. Here
 * it stays off until a paired A/B on gnomon's own lanes says otherwise.
 */
export function toolMaxLines(config: GnomonConfig, name: LineCappedTool): number | undefined {
  const v = (config.tools.tools ?? []).find((t) => t.name === name)?.max_lines;
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_MAX_LINES ? v : undefined;
}

/** Both caps, or undefined when neither is declared -- the default. */
export function resolveMaxLines(config: GnomonConfig): { bash?: number; read?: number } | undefined {
  const bash = toolMaxLines(config, "bash");
  const read = toolMaxLines(config, "read");
  if (bash === undefined && read === undefined) return undefined;
  return { ...(bash !== undefined ? { bash } : {}), ...(read !== undefined ? { read } : {}) };
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
  /** "chars4" unless the surface declares "calibrated" */
  token_estimate: TokenEstimate;
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

/** A declared positive whole number, or undefined. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** `[defaults] max_context_tokens`, or 65536 when the surface says nothing. */
export function defaultContextWindow(config: GnomonConfig): number {
  return pickInt(config.config.defaults?.max_context_tokens, 65536);
}

/**
 * The window fields of a route target, from its endpoint's declaration.
 *
 * A number is `declared`. `"auto"` is what this process has already resolved
 * for the URL and model (settleContextWindows in prompt_loop.ts does the
 * asking); until then, or when nothing was found, it is `[defaults]
 * max_context_tokens` marked `default`, which trims exactly as an undeclared
 * endpoint does. Anything else is the object an undeclared endpoint always got.
 */
function contextWindowOf(
  config: GnomonConfig,
  declared: unknown,
  at: { url: string; kind?: EndpointKind; model: string }
): Pick<RouteTarget, "contextTokens" | "contextSource" | "contextAuto"> {
  if (declared === AUTO_WINDOW) {
    const known = rememberedWindow(at);
    return known?.tokens
      ? { contextTokens: known.tokens, contextSource: known.source, contextAuto: true }
      : { contextTokens: defaultContextWindow(config), contextSource: "default", contextAuto: true };
  }
  const tokens = positiveInt(declared);
  return tokens ? { contextTokens: tokens, contextSource: "declared" } : { contextTokens: undefined };
}

/**
 * Resolve the context-window policy from config.toml.
 *
 * `[context]` and `[defaults].max_context_tokens` / `.compaction` are already
 * declared in the surface and already part of the surface hash — this reads
 * what is there rather than introducing new configuration.
 */
export function resolveContext(
  config: GnomonConfig,
  /**
   * The target a turn is routed to. Its endpoint's declared window replaces
   * `[defaults] max_context_tokens`: P2G (2026-11) ran a cloud model with a
   * window of hundreds of thousands of tokens under the 65536 default, and the
   * leg checkpoint trimmed its working context to ~39k every 12 steps.
   */
  target?: { contextTokens?: number }
): ResolvedContext {
  const ctx = config.config.context ?? {};
  const defaults = config.config.defaults ?? {};
  const window = target?.contextTokens ?? defaultContextWindow(config);
  return {
    policy: pickEnum(ctx.policy, CONTEXT_POLICIES, "sliding_window"),
    retain_after: pickInt(ctx.retain_after, 2048),
    max_context_tokens: window,
    compaction: pickEnum(defaults.compaction, COMPACTIONS, "summary"),
    summary_role:
      typeof ctx.summary_role === "string" ? ctx.summary_role : "smol",
    reserve_output: (() => {
      const budget = window;
      // 15% of the window, at least 1024 — but never more than 40% of it.
      // Without the cap a small max_context_tokens was consumed entirely by
      // the floor, leaving no room for history at all.
      const wanted = Math.max(1024, Math.floor(budget * 0.15));
      return pickInt(ctx.reserve_output, Math.min(wanted, Math.floor(budget * 0.4)));
    })(),
    token_estimate: pickEnum(ctx.token_estimate, TOKEN_ESTIMATES, "chars4"),
  };
}

// ---------------------------------------------------------------------------
// Context hygiene: observation masking and the environment bootstrap.
//
// Both opt-in, and both resolved separately from resolveContext on purpose:
// ResolvedContext is printed and fingerprinted as it stands, and an absent key
// has to leave every byte of that, and of every request, where it was. Each
// resolver returns null when its key is absent, and every call site treats
// null as "do exactly what the build before this did".
// ---------------------------------------------------------------------------

/** Observation masking, fully resolved. */
export interface ResolvedMasking {
  /** The newest tool results always kept verbatim. */
  keep_last: number;
  /** Fraction of the window the turn's context must reach before a batch. */
  at_fill: number;
  /** The fewest results a batch masks; fewer eligible means no batch yet. */
  batch: number;
}

/**
 * What a DECLARED `[context.mask_observations]` uses for a key it leaves out.
 * Never consulted when the table is absent: absent is no masking at all.
 *
 * - keep_last 10: the window the Complexity Trap study used (SWE-agent, the
 *   last 10 observations verbatim; arXiv 2508.21433).
 * - at_fill 0.5: under the leg checkpoint's trim budget (60% of the window),
 *   so a declared mask acts before the lossy trim would.
 * - batch 5: once past the threshold, the prompt prefix is rewritten at most
 *   once per five new tool results rather than on every call. Hybrid-attention
 *   models (Qwen3.5/3.6 under llama.cpp) cannot truncate a cached prefix, so
 *   each rewrite costs a re-prefill from the first changed byte.
 */
export const MASK_DEFAULTS: Readonly<ResolvedMasking> = Object.freeze({
  keep_last: 10,
  at_fill: 0.5,
  batch: 5,
});

/** The keys `[context.mask_observations]` reads. */
export const MASK_KEYS = Object.keys(MASK_DEFAULTS);

/**
 * Read `[context.mask_observations]`. Null when it is absent -- or not a table,
 * which auditSurface refuses before a run can start.
 */
export function resolveMasking(config: GnomonConfig): ResolvedMasking | null {
  const raw = config.config.context?.mask_observations as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const int = (v: unknown, min: number): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v >= min ? v : undefined;
  const fill =
    typeof r.at_fill === "number" && Number.isFinite(r.at_fill) && r.at_fill >= 0 && r.at_fill < 1
      ? r.at_fill
      : undefined;
  return {
    keep_last: int(r.keep_last, 0) ?? MASK_DEFAULTS.keep_last,
    at_fill: fill ?? MASK_DEFAULTS.at_fill,
    batch: int(r.batch, 1) ?? MASK_DEFAULTS.batch,
  };
}

/** The platform keys a `[bootstrap.<id>]` block declares its probes under. */
export const BOOTSTRAP_PLATFORMS = ["linux", "macos", "windows"] as const;
export type BootstrapPlatform = (typeof BOOTSTRAP_PLATFORMS)[number];

/**
 * Which platform key this machine reads. Windows runs the bash tool in Git
 * Bash, so its probes are shell too; every platform that is neither Windows
 * nor macOS reads `linux`, the POSIX variant.
 */
export function bootstrapPlatform(platform: NodeJS.Platform = process.platform): BootstrapPlatform {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
}

/**
 * What a declared `[bootstrap.<id>]` uses for a limit it leaves out. A
 * snapshot of a few hundred tokens is the size Meta-Harness injected; 3000
 * bytes is about 750 estimated tokens, paid on every call of the session.
 */
export const BOOTSTRAP_DEFAULTS = Object.freeze({ max_bytes: 3000, max_lines: 12, timeout_ms: 20_000 });

/** The keys a `[bootstrap.<id>]` block reads. */
export const BOOTSTRAP_KEYS: readonly string[] = [...BOOTSTRAP_PLATFORMS, ...Object.keys(BOOTSTRAP_DEFAULTS)];

/** The environment bootstrap, fully resolved for this machine. */
export interface ResolvedBootstrap {
  /** The `[bootstrap.<id>]` the surface selected, or `env_snapshot` for the built-in. */
  id: string;
  /**
   * Set on the built-in snapshot (`[context] env_snapshot = true`,
   * sweep_knobs.ts): its command is gnomon's, not the surface's, and its
   * block ends with what the policy lets the network do.
   */
  builtin?: true;
  platform: BootstrapPlatform;
  /** The probes declared for this platform; null when it declares none. */
  probes: string[] | null;
  /** The one compound command that runs; null when there is nothing to run. */
  command: string | null;
  max_bytes: number;
  max_lines: number;
  timeout_ms: number;
}

/**
 * Compose a probe list into ONE compound shell command.
 *
 * Each probe is labelled with its own text, runs in a subshell (a `cd` in one
 * cannot move the next), has stderr folded in -- "command not found" is
 * exactly what the snapshot is for -- and is cut to `maxLines` lines so one
 * chatty probe cannot crowd out the rest. The `)` sits on its own line so a
 * probe ending in a `# comment` cannot swallow it. Deterministic: the same
 * list gives the same bytes, which is what the hash and the audit record need.
 */
export function composeBootstrapCommand(probes: string[], maxLines: number): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return probes
    .map((p) => `printf '%s\\n' ${quote(`$ ${p}`)}; ( ${p}\n) 2>&1 | head -n ${Math.max(1, Math.floor(maxLines))}`)
    .join("\n");
}

/**
 * Read `[context] bootstrap` and the `[bootstrap.<id>]` it names. Null when no
 * bootstrap is selected. A selected id with no block, or no probes for this
 * platform, resolves with `command: null`: the turn then runs without a
 * snapshot and says so (`outcome: "unavailable"`), and auditSurface has
 * already refused the first case before any run.
 */
export function resolveBootstrap(
  config: GnomonConfig,
  platform: NodeJS.Platform = process.platform
): ResolvedBootstrap | null {
  const id = config.config.context?.bootstrap as unknown;
  if (typeof id !== "string" || id.trim() === "") {
    // `[context] env_snapshot = true` with no declared bootstrap: the
    // built-in probe, under the same path, records and limits.
    if (!resolveEnvSnapshot(config)) return null;
    const fam = bootstrapPlatform(platform);
    const command = envSnapshotCommand(fam);
    return {
      id: ENV_SNAPSHOT_ID,
      builtin: true,
      platform: fam,
      probes: [command],
      command,
      max_bytes: ENV_SNAPSHOT_LIMITS.max_bytes,
      max_lines: ENV_SNAPSHOT_LIMITS.max_lines,
      timeout_ms: ENV_SNAPSHOT_LIMITS.timeout_ms,
    };
  }
  const blocks = (config.policy?.bootstrap ?? {}) as Record<string, unknown>;
  const decl = (Object.prototype.hasOwnProperty.call(blocks, id) ? blocks[id] : undefined) as
    | Record<string, unknown>
    | undefined;
  const fam = bootstrapPlatform(platform);
  const list = decl && typeof decl === "object" ? decl[fam] : undefined;
  const probes = Array.isArray(list)
    ? list.filter((p): p is string => typeof p === "string" && p.trim() !== "")
    : [];
  const pos = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
  const max_lines = pos(decl?.max_lines, BOOTSTRAP_DEFAULTS.max_lines);
  return {
    id,
    platform: fam,
    probes: probes.length > 0 ? probes : null,
    command: probes.length > 0 ? composeBootstrapCommand(probes, max_lines) : null,
    max_bytes: pos(decl?.max_bytes, BOOTSTRAP_DEFAULTS.max_bytes),
    max_lines,
    timeout_ms: pos(decl?.timeout_ms, BOOTSTRAP_DEFAULTS.timeout_ms),
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
export const COT_MODES: CotMode[] = ["off", "brief", "tools", "think", "work", "full"];

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
    // `work` folds a run of steps that succeeded and changed nothing into one
    // line, because a wall of them is a rhythm you stop reading. `full` is the
    // escape and still prints every call. Safe to change without a migration:
    // `cot` is not in the published enumerations and `gnomon init` does not
    // write it, so this default reaches an existing surface too.
    cot: pickEnum(ui.cot, COT_MODES, "work"),
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
  /** Stream the reply (SSE). Absent means unstreamed. See resolveStream. */
  stream?: boolean;
  /** `[resilience] stream_idle_timeout_ms`, for a streamed call */
  streamIdleMs?: number;
  /** `[resilience] stream_total_timeout_ms`, for a streamed call */
  streamTotalMs?: number;
  /** The output limit sent with each call; 0 or absent sends none. */
  maxTokens?: number;
  /**
   * The field the limit is sent as on an OpenAI-shaped endpoint. `max_tokens`
   * unless the endpoint refused it by name for `max_completion_tokens`.
   */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /**
   * The window the turn's working context is trimmed to: `[endpoints.<name>]
   * max_context_tokens` when declared, what `"auto"` resolved, or, for an
   * `"auto"` that found nothing, `[defaults] max_context_tokens`. Absent when
   * the endpoint declares nothing, as before the key existed.
   */
  contextTokens?: number;
  /** Where `contextTokens` came from. Absent exactly when it is. */
  contextSource?: ContextSource;
  /** The endpoint declares `max_context_tokens = "auto"`. See settleContextWindows. */
  contextAuto?: true;
  /** Replay reasoning_content on assistant messages. See resolveReplayReasoning. */
  replayReasoning?: boolean;
  /**
   * Send gnomon's mid-conversation messages as user messages. Set only when
   * it is `user`, declared or learned from a refusal; absent means `system`,
   * so a target that never asked for it is the object it always was.
   */
  steerRole?: SteerRole;
  /**
   * The reasoning effort sent as `reasoning_effort`, when one is: the role's
   * or the endpoint's (sweep_knobs.ts resolveReasoningEffort). Absent sends
   * none, as before the key existed.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Sampling fields left to the provider: not sent (sweep_knobs.ts
   * samplingOmitted). Absent, or empty, sends both, as before.
   */
  samplingOmitted?: SamplingParam[];
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
 * The request shape a URL's path names, if it names one.
 *
 * `/api/chat` is Ollama's own route. `/chat/completions` is OpenAI's, which
 * every OpenAI-compatible server copies, Ollama's `/v1` included, and a path
 * that ends in a version segment (`/v1`) is the base of one. Any other path
 * gives no answer.
 */
export function kindFromUrl(url: string): EndpointKind | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? "";
  }
  path = path.replace(/\/+$/, "").toLowerCase();
  if (/\/api\/chat$/.test(path)) return "ollama";
  if (/\/chat\/completions$/.test(path) || /\/v\d+$/.test(path)) return "openai";
  return undefined;
}

/**
 * The request shape an endpoint is sent: its declared `kind`, else what its URL
 * names, else `unclear`.
 *
 * A block with no `kind` used to get the Ollama shape whatever its URL said.
 * A hand-written `[endpoints.vllm]` with `url = ".../v1/chat/completions"`
 * therefore sent `options: {temperature}` and `tool_name` to an OpenAI server.
 * Strict servers reject those fields with a 400, and nothing named the missing
 * line as the cause. `gnomon endpoint add` had always read the kind off the URL
 * (`/api/chat` is ollama, anything else openai). Only hand-written blocks went
 * without it, and the guide's recipes are hand-written blocks.
 *
 * `unclear` is what each caller used before this function existed, so a URL
 * that names no shape behaves exactly as it did. The primary route defaulted
 * to ollama and a fallback to openai. Nothing that worked can change: an
 * Ollama-native URL ends in `/api/chat`, and that still resolves to ollama.
 * auditSurface reports a kind-less block whose URL names no shape, because
 * there the kind is still a guess.
 */
export function endpointKind(
  endpoint: { url?: string; kind?: EndpointKind },
  unclear: EndpointKind = "ollama"
): EndpointKind {
  if (endpoint.kind) return endpoint.kind;
  return kindFromUrl(endpoint.url ?? "") ?? unclear;
}

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

/**
 * Whether calls to an endpoint are streamed.
 *
 * The endpoint's own `stream` wins; undeclared, it is `[defaults] stream`, and
 * absent from both it is false. Ollama's own /api/chat is never streamed: its
 * native route streams NDJSON, not server-sent events, and no reader for it
 * exists here. auditSurface says so when a block declares it.
 *
 * Absent means false, though streaming is the better behaviour, because a
 * default that changed in the code would change what an existing surface does
 * without moving its hash (Rule 1). `gnomon init` writes `[defaults] stream =
 * true`, and `gnomon migrate` adds it to an existing surface, where the line
 * moves the hash in plain sight.
 *
 * Streaming is the better behaviour because an unstreamed reply has only one clock:
 * nothing arrives until the whole generation is done, so a deadline long
 * enough for the longest legitimate reply is also how long a dead one is
 * waited on. Measured on P2G (2026-11, Terminal-Bench on hosted DeepSeek V4.1
 * Flash, gnomon v0.3.1): 11 of 18 cells hit the 30-minute cap, with replies
 * cut off at 300 s and sent again from the start. A streamed reply is timed
 * by the gap between chunks instead, which a reply that is still being
 * written never reaches.
 */
export function resolveStream(
  endpoint: { url?: string; kind?: EndpointKind; stream?: unknown },
  unclear: EndpointKind = "ollama",
  /** `[defaults] stream` */
  surfaceDefault: unknown = false
): boolean {
  if (endpointKind(endpoint, unclear) === "ollama") return false;
  if (typeof endpoint.stream === "boolean") return endpoint.stream;
  return surfaceDefault === true;
}

/** The only keys an [endpoints.<name>] block may carry. */
const ENDPOINT_KEYS = new Set([
  "url",
  "kind",
  "api_key_env",
  "provider",
  "stream",
  "max_tokens",
  "max_context_tokens",
  "replay_reasoning",
  "steer_role",
  "reasoning_effort",
  "sampling",
]);

/**
 * The role gnomon's mid-conversation messages go out in for this endpoint.
 *
 * Declared wins; anything else is `system`, which is what every surface got
 * before the key existed, so an existing surface sends the same bytes (Rule
 * 1). Whether `user` should be the default is for a benchmark to decide, not
 * this function.
 *
 * Why the key exists: gnomon's steering arrives as `role: "system"` after the
 * conversation has started, and two common local stacks do not take that.
 * vLLM serving Qwen3.x refuses the request, 400 "System message must be at the
 * beginning." (M1, 2026-11: 4 of 16 cells ended at their first nudge). Unsloth's
 * qwen3.6 template under llama.cpp has no branch for a system message after
 * the first two and drops it, so the model never sees the steering at all
 * (rendered offline with jinja2, 2026-11-03). The refusal is caught and
 * answered at run time (prompt_loop.ts, steerAsUser); the silent drop cannot
 * be, which is what declaring `user` is for.
 */
export function resolveSteerRole(endpoint: { steer_role?: unknown } | undefined): SteerRole {
  const v = endpoint?.steer_role;
  return typeof v === "string" && (STEER_ROLES as readonly string[]).includes(v) ? (v as SteerRole) : "system";
}

/**
 * Hosts whose own API documentation requires reasoning to be sent back.
 *
 * DeepSeek, api-docs.deepseek.com/guides/thinking_mode (read 2026-11-03):
 * thinking mode is on by default, and when `tools` are sent, "the
 * reasoning_content must be fully passed back to the API in all subsequent
 * requests" -- for turns with no tool call too -- and "If your code does not
 * correctly pass back reasoning_content, the API will return a 400 error."
 * Without tools it is ignored. Matched on the hostname only: a relay or a
 * gateway in front of DeepSeek is a different server and says so itself.
 */
const REPLAY_REASONING_HOSTS = [/(^|\.)api\.deepseek\.com$/];

/**
 * Whether an endpoint gets `reasoning_content` back on assistant messages.
 *
 * Declared wins. Undeclared it is off, except for a host listed above, because
 * the field is not part of OpenAI's message schema and strict servers refuse
 * extra message fields: opencode's Console Go answered gnomon's surplus
 * `tool_name` with "400 Extra inputs are not permitted". Ollama's /api/chat
 * calls it `thinking` and is never sent it.
 */
export function resolveReplayReasoning(endpoint: {
  url?: string;
  kind?: EndpointKind;
  replay_reasoning?: unknown;
}, unclear: EndpointKind = "ollama"): boolean {
  if (endpointKind(endpoint, unclear) === "ollama") return false;
  if (typeof endpoint.replay_reasoning === "boolean") return endpoint.replay_reasoning;
  let host = "";
  try {
    host = new URL(endpoint.url ?? "").hostname.toLowerCase();
  } catch {
    return false;
  }
  return REPLAY_REASONING_HOSTS.some((re) => re.test(host));
}

/**
 * The output limit `gnomon init` declares in `[defaults] max_tokens`.
 *
 * gnomon sent no limit at all, so a reply ran until the model stopped, and a
 * reasoning model does not stop early. On P2G (2026-11, hosted DeepSeek V4.1
 * Flash) gnomon wrote about twice the output per step that opencode and goose
 * did on the same tasks, up to nine times on some, most of it reasoning; one
 * cell spent 221k output tokens and left its solution a stub.
 *
 * 32k, not less, because on DeepSeek and llama.cpp the limit counts the
 * reasoning too: 9k tokens of thinking followed by a 30 KB file write needs
 * ~19k, and a limit below that turns a write that works unlimited into one
 * that is cut off every time. A provider whose own maximum is lower says so in
 * its 400, and the limit is clamped to what it states (see callEndpoint).
 *
 * Not a code default. Absent everywhere, no limit is sent, which is the
 * behaviour before this existed: a default that changed in the code would
 * change what an existing surface does without moving its hash (Rule 1).
 * `gnomon migrate` adds the line to an older surface.
 */
export const DEFAULT_MAX_TOKENS = 32_768;

/**
 * The output limit for a role on an endpoint: the role's own `max_tokens`,
 * else the endpoint's, else `[defaults] max_tokens`, else none (0). 0 at any
 * level also means "send none", and stops the search there.
 */
export function resolveMaxTokens(
  config: GnomonConfig,
  role: { max_tokens?: unknown } | undefined,
  endpoint: { max_tokens?: unknown } | undefined
): number {
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  for (const v of [role?.max_tokens, endpoint?.max_tokens, config.config?.defaults?.max_tokens]) {
    if (ok(v)) return Math.floor(v);
  }
  return 0;
}

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
interface ExecutingArg {
  /** What the allow-list ENTRY's TEXT must contain for this admission to fire. */
  admits: RegExp;
  /** How the warning names it. */
  why: string;
  /**
   * What a bash_deny entry must mention to actually neutralise THIS admission.
   *
   * This column exists because the guard used to be one loose test applied to
   * the whole deny-list -- /exec|delete|fprint|-c\b/ against any entry -- and
   * the starter surface's own rule for `git push --delete` contains the
   * substring "delete". So every surface scaffolded by `gnomon init` silently
   * satisfied the guard and this warning never fired again, on any role,
   * however its bash_allow read. A check that the shipped default disables is
   * worse than no check: it reports safety it never verified.
   */
  guard: RegExp;
  /**
   * The deny entries that close THIS admission, exactly as they go in the file.
   *
   * The whole point of holding them as data: `fix` is built from them, so the
   * remedy the operator is handed is BY CONSTRUCTION the thing whose absence
   * made this fire. `guard.test(denyText(d))` is true for at least one `d`
   * here, which is the invariant that makes following the fix clear the
   * warning. Nothing enforced that before and the shipped text did not satisfy
   * it -- see the note on the scaffolded verifier below.
   */
  deny: string[];
  /** What else applying `deny` does, said before the operator finds out. */
  note: string;
}

/**
 * A deny pattern reduced to the text a guard should be read against.
 *
 * Measured, 2026-09-02: the xargs admission's guard was /\bxargs\b/ and the
 * deny spelling this file itself recommended -- and that the scaffolded
 * verifier actually carries -- is '\bxargs\b'. As a SUBJECT string that is
 * the nine characters `\bxargs\b`, in which "xargs" is preceded by the word
 * character 'b', so \b does not hold and the guard returned false. Same for
 * env: /\benv\b/ against '\benv\b' is false. Two of the six admissions
 * could never be marked guarded by their own recommended remedy, so an
 * operator who applied it exactly would have kept the warning forever.
 * Verified with node: guard.test('\\bxargs\\b') === false,
 * guard.test('xargs') === true.
 *
 * Only \b is removed. Removing more would widen the guard, and a guard that
 * matches too much SUPPRESSES a real warning -- the failure direction this
 * whole table was rebuilt to close.
 */
const denyText = (pattern: string): string => pattern.replace(/\\b/g, "");

const EXECUTING_ARGS: ExecutingArg[] = [
  {
    admits: /\bfind\b/,
    why: "find (-exec, -execdir, -delete, -fprintf all write or run)",
    guard: /-exec|-execdir|-ok\b|-okdir|-delete|-fprint/,
    deny: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint"],
    note: "find still reads the tree; only its executing arguments are refused.",
  },
  {
    admits: /\bxargs\b/,
    why: "xargs (runs whatever it is piped)",
    guard: /\bxargs\b/,
    deny: ["\\bxargs\\b"],
    note: "Nothing else in bash_allow is affected.",
  },
  {
    admits: /\benv\b/,
    why: "env (runs its argument)",
    guard: /\benv\b/,
    deny: ["\\benv\\b"],
    note: "Nothing else in bash_allow is affected.",
  },
  // A shell NAME, not a script path (#46). With a bare \b, the `sh` of
  // `^\.gnomon/(ci|verify)\.sh$` counted -- \b holds after the '.' -- so a role
  // allowed exactly two scripts was told it admits a shell. Worse, the remedy
  // was the same unanchored pattern, which matches `.gnomon/ci.sh` itself; deny
  // wins, so applying it locked the verifier out of the gate it exists to run.
  // A name preceded by '.' is an extension and one followed by '/' is a
  // directory; `/bin/sh` is still a shell. The deny is anchored to the command
  // position, so it refuses `bash -c …`, `/bin/sh x` and `ls; sh x` but not a
  // path that merely ends in .sh.
  {
    admits: /(?<![\w.])(sh|bash|zsh|ksh|dash)\b(?!\/)/,
    why: "a shell (runs anything)",
    guard: /(?<![\w.])(sh|bash|zsh|ksh|dash)\b(?!\/)|-c\b/,
    deny: ["(^|[;&|(]\\s*)(\\S*/)?(sh|bash|zsh|ksh|dash)(\\s|$)"],
    note:
      "Deny wins over allow, so this also stops any bash_allow entry that runs " +
      "a shell by name. Scripts run by path (.gnomon/ci.sh) are unaffected.",
  },
  {
    admits: /\b(awk|gawk|perl|python3?|ruby|node)\b/,
    why: "an interpreter (runs anything)",
    guard: /\b(awk|gawk|perl|python3?|ruby|node)\b/,
    deny: ["\\b(awk|gawk|perl|python3?|ruby|node)\\b"],
    note:
      "Deny wins over allow, so this also stops bash_allow entries that spell an " +
      "interpreter -- 'python -m pytest' among them. If you need that one, narrow " +
      "bash_allow instead: 'pytest' on its own names no interpreter.",
  },
  {
    admits: /\bgit\b(?!\s*\()/,
    why: "git (-c core.pager / alias.* run commands)",
    guard: /core\.pager|alias\.|-c\b/,
    deny: ["\\bgit\\b[^|;&]*\\s-c\\s"],
    note: "Ordinary git subcommands are untouched; only `git -c \u2026` is refused.",
  },
];

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
  // Added with the feature, which is the point: [chain] shipped and this list
  // did not move, so every surface declaring one was told "[chain] is not a
  // block this harness reads; it does nothing" -- by the harness that had just
  // read it. A block the code honours and the auditor disowns is the same
  // silent mismatch in the other direction.
  "chain",
  // Same lesson, applied on the way in this time: resolveLoop reads [loop], so
  // this list moves in the same commit. Without it the auditor would print
  // "[loop] is not a block this harness reads" over a block the harness had
  // just read -- and the operator's most likely response is to delete the
  // block, which is how a declared loop setting silently reverts to a default.
  // NOT "loop": .gnomon/loops/*.toml already uses a [loop] header for a loop
  // DECLARATION (name/every/guard/act). Two schemas behind one name in two
  // files is how an operator writes [loop] name = "nightly" into config.toml
  // and gets silence -- the inert-setting failure this project exists to make
  // impossible. These numbers decide when a TURN stops.
  "turn",
  // [check.roles] in policy.toml: which role `gnomon check` judges another
  // harness's agent by. Listed with the feature, for the reason [chain] above
  // gives.
  "check",
  // resolveShadow reads [shadow]. Listed with the feature, for the reason
  // [chain] above gives.
  "shadow",
  // [skills] in policy.toml: skills.ts reads require_trial. It shipped without
  // this entry, and the auditor told every surface that declared it that the
  // block "does nothing" -- the [chain] mismatch again, on a control.
  "skills",
  // [bootstrap.<id>] in policy.toml: resolveBootstrap reads it when
  // `[context] bootstrap` names it. Listed with the feature.
  "bootstrap",
]);

/**
 * Keys whose VALUE is a closed set, and what silently happens to a typo.
 *
 * Keyed by (block, key), not by block alone. It used to be a Record keyed on
 * the block, with the key derived at the call site as
 * `block === "approval" ? "gate" : "level"` -- a shape that can hold exactly
 * ONE enumeration per block. [sandbox] has two. So `exec` was unreachable by
 * this check, and resolveExec resolves it as
 * `raw === "docker" ? "docker" : "off"`: every misspelling becomes "off".
 * A surface that asked for container isolation ran on the host and said
 * nothing -- and `exec` was already in ROLE_KEYS and KNOWN_BLOCKS, so no other
 * check saw it either.
 *
 * Measured, 2026-09-02, on a scratch surface carrying
 * `[sandbox] level = "confined"` and `exec = "dokcer"`: auditSurface returned
 * 0 problems before this change and 1 after.
 */
const EXEC_VALUES = ["off", "docker"] as const;

interface EnumSpec {
  block: string;
  key: string;
  values: readonly string[];
  falls_back_to: string;
}

const ENUM_KEYS: EnumSpec[] = [
  { block: "approval", key: "gate", values: ["never", "on_write", "always"], falls_back_to: "on_write" },
  // resolveAfterRefusal (after_refusal.ts): anything but "ask" is off. Written
  // out rather than imported, because after_refusal.ts reaches config.ts through
  // tools.ts; after_refusal.test.ts holds the two lists equal.
  { block: "approval", key: "after_refusal", values: ["off", "ask"], falls_back_to: "off" },
  { block: "sandbox", key: "level", values: ["off", "confined", "strict"], falls_back_to: "confined" },
  // resolveExec: anything that is not exactly "docker" resolves to "off".
  { block: "sandbox", key: "exec", values: EXEC_VALUES, falls_back_to: "off" },
  { block: "verify", key: "after", values: ["write", "change", "always"], falls_back_to: "write" },
  // resolveCompletionGate (completion_gate.ts): anything else is "off", so a
  // misspelt "reveiw" would silently turn the gate off.
  { block: "verify", key: "completion_gate", values: COMPLETION_GATE_MODES, falls_back_to: "off" },
  // [context] token_estimate: a misspelt "calibrated" would run as "chars4".
  { block: "context", key: "token_estimate", values: TOKEN_ESTIMATES, falls_back_to: "chars4" },
];

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
  mask_observations: "context",
  bootstrap: "context",
  token_estimate: "context",
  env_snapshot: "context",
  todo_gate: "turn",
  allow_package_index: "sandbox",
};

interface BlockOwner {
  /** The surface file this block is read from. */
  file: string;
  /**
   * Whether ANY code in this build reads it.
   *
   * False is not a hypothetical. `read: false` entries are blocks that are
   * typed on the config interfaces, listed in KNOWN_BLOCKS (so every other
   * check waves them through), hashed into the surface -- and read by nothing.
   * A setting that does nothing is worse than no setting, so they are reported
   * where they sit rather than left to look load-bearing.
   */
  read: boolean;
}

/**
 * Which file each top-level block is read from, and whether it is read at all.
 *
 * A block in the wrong file is legal TOML, hashes into the surface, and is read
 * by nothing. That is not hypothetical: a [verify] block sat in config.toml
 * instead of policy.toml for days, silently disabling the declared check, and
 * the campaign that missed it is the reason this audit exists. The two files sit
 * side by side, both are TOML, both are hashed, and the block is valid in both —
 * there is no way for an operator to see the difference unaided. That case is
 * fatal, because a control that is declared and not read is worse than one that
 * was never declared: the surface says the check runs.
 *
 * This table drifted away from KNOWN_BLOCKS. KNOWN_BLOCKS gained `chain` and
 * `turn` and deliberately dropped `loop` (two schemas behind one name --
 * .gnomon/loops/*.toml uses a [loop] header for a loop DECLARATION); this one
 * still named `loop` and had never carried `turn`, `chain`, `session`,
 * `process` or `exit_codes`. The consequence, measured on a scratch surface:
 * `[turn]` written into policy.toml -- exactly the [verify]-in-the-wrong-file
 * mistake this check exists for -- produced no problem at all, because a block
 * missing from this table is skipped by the loop that reads it.
 *
 * `process` and `exit_codes` are here with read: false. Verified 2026-09-02 by
 * grep over packages/*​/src and crates/*​/src: nothing reads
 * `config.config.process` and nothing reads `config.policy.exit_codes`. The
 * `exit_codes` that IS read is conformance/exit_codes.json, a different file
 * and a different shape (session.ts ExitCodeMap) -- the name collision is
 * precisely why an operator would write the block and expect it to matter.
 */
const BLOCK_OWNER: Record<string, BlockOwner> = {
  verify: { file: "policy.toml", read: true },
  approval: { file: "policy.toml", read: true },
  sandbox: { file: "policy.toml", read: true },
  // resolveCheckRole (guard.ts, shared by check and guard) reads config.policy.check.roles.
  check: { file: "policy.toml", read: true },
  // NOT read: no consumer of config.policy.exit_codes anywhere in this build.
  exit_codes: { file: "policy.toml", read: false },
  // requireTrial (skills.ts) reads config.policy.skills.require_trial.
  skills: { file: "policy.toml", read: true },
  // resolveBootstrap reads config.policy.bootstrap.<id>, as [verify] is read:
  // a command the surface decides to run belongs beside the other one.
  bootstrap: { file: "policy.toml", read: true },
  endpoints: { file: "config.toml", read: true },
  defaults: { file: "config.toml", read: true },
  context: { file: "config.toml", read: true },
  ui: { file: "config.toml", read: true },
  routing: { file: "config.toml", read: true },
  resilience: { file: "config.toml", read: true },
  audit: { file: "config.toml", read: true },
  // resolveSessionStore reads config.config.session.
  session: { file: "config.toml", read: true },
  // resolveChain reads config.config.chain.
  chain: { file: "config.toml", read: true },
  // resolveLoop reads config.config.turn. NOT "loop": that header means
  // a loop DECLARATION in .gnomon/loops/*.toml, and two schemas behind one
  // name is how a declared setting silently reverts to a default.
  turn: { file: "config.toml", read: true },
  // resolveShadow reads config.config.shadow.
  shadow: { file: "config.toml", read: true },
  // NOT read: ProcessConfig is typed on Config and no consumer exists.
  process: { file: "config.toml", read: false },
  roles: { file: "roles.toml", read: true },
  tools: { file: "tools.toml", read: true },
};

const ROLE_KEYS = new Set(["allowed_edit_formats", "bash_allow", "bash_deny", "converge_after", "description", "endpoint", "fallback", "max_steps", "max_steps_total", "max_tokens", "model", "exec", "image", "profile", "reasoning_effort", "task_allow", "temperature", "tools", "top_p", "write_allow"]);

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

/**
 * Enumeration values this build publishes but does not implement.
 *
 * Publishing an option that does nothing is the same defect as any other
 * mechanism that reports success while doing nothing — it is simply spelled in
 * the contract instead of in the code. Rule 6 says the enumerations are
 * published; it does not say a reader has to guess which of them work.
 *
 * `edit_format` is the live case: the enumeration offers ast | hashline |
 * str_replace, only the last is built, and a surface asking for `ast` used to
 * run on `str_replace` in silence — the surface saying one thing and the
 * harness doing another, which is the sentence this project exists to prevent.
 *
 * Entries leave this table by being implemented, never by being quietly
 * dropped from the contract.
 */
const DECLARED_NOT_IMPLEMENTED: Record<string, { values: string[]; inUse: string; why: string }> = {
  edit_format: {
    values: ["ast", "hashline"],
    inUse: "str_replace",
    why: "the edit tool matches an exact string; the structural and hash-line formats are in the enumerations contract, not in this build",
  },
};

export function auditSurface(config: GnomonConfig): SurfaceProblem[] {
  const problems: SurfaceProblem[] = [];
  const declared = config.config.endpoints ?? {};

  // Files under .gnomon/extensions/ are NOT hashed and NOT loaded. Inert in
  // both directions, so this is a note about what the directory is, not a
  // warning about a hash that moves for nothing.
  //
  // This block said the opposite until 2026-09-05, and it was wrong for a day.
  // 35cc702 excluded `extensions/` from the surface walk and left the
  // disclosure that described the behaviour before it -- so an operator with
  // extension files was told, specifically and falsely, that adding one moves
  // their surface hash. A stale disclosure is worse than none: it is a
  // confident sentence about the one thing this project asks people to trust.
  //
  // `benchmarks/surface-fidelity` did not catch it and could not: it measures
  // hash against behaviour, not whether a sentence about them is true. Nothing
  // mechanical can. What catches this class is reading, and the thing that
  // schedules the reading is `scripts/doc_reconciliation.mjs` -- which covers
  // the prose documents. This was a code comment, and it was found by reading
  // the walk beside it.
  //
  // The direction of the remaining risk is the one 35cc702 accepted on purpose:
  // if a host is ever built and nobody re-includes the directory, behaviour
  // would change without the hash moving. surface-fidelity's negative control
  // models exactly that trap and fires on it.
  try {
    const extDir = join(config.gnomonDir, "extensions");
    const files = existsSync(extDir)
      ? readdirSync(extDir)
          .filter((f) => /\.(ts|js|mjs)$/.test(f))
          // The first three are named below: by byte order, not by readdir's (GV17).
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : [];
    if (files.length > 0) {
      problems.push({
        where: `.gnomon/extensions/`,
        problem:
          `${files.length} extension file(s) here (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}) ` +
          `are NOT loaded by this build and are NOT part of the surface hash. They are inert: adding, ` +
          `editing or removing one changes nothing about a run and does not move the hash.`,
        fix:
          `Remove them, or keep them knowing they do nothing. No extension host reads this directory in ` +
          `this build; if one is ever built, this directory has to be re-included in the surface walk in ` +
          `the same change, or extensions would start taking effect without the hash moving.`,
        fatal: false,
      });
    }
  } catch {
    // Never fail an audit over the audit.
  }

  // A roles.toml model/endpoint the active profile overrides. Editing
  // roles.toml is what the README and most users reach for first, and with a
  // profile active that edit was silently ignored: no error, no notice, the run
  // kept using the profile's value. Found 2026-10-21 by the author, whose own
  // `plan -> go` edit had never taken effect.
  if (config.profile?.name && config.profile.shadowed) {
    const prof = `.gnomon/profiles/${config.profile.name}.toml`;
    for (const s of config.profile.shadowed) {
      problems.push({
        where: `.gnomon/roles.toml [roles.${s.role}] ${s.field}`,
        problem:
          `${s.field} = "${s.base}" is ignored: role_profile "${config.profile.name}" sets ` +
          `${s.field} = "${s.profile}" for this role, and the profile wins.`,
        fix:
          `Make the change in ${prof} instead, or use /models or \`gnomon endpoint add --role ${s.role}\` ` +
          `(both write to the file a run reads), or change role_profile in .gnomon/config.toml.`,
        fatal: false,
      });
    }
  }

  // approval and sandbox, set in both files to different values. The policy.toml
  // value is used. Before this check, `[defaults] approval = "never"` beside the
  // scaffold's `gate = "on_write"` did nothing and nothing said so. The edit
  // was simply lost, and in the other direction a stricter `[defaults]` value
  // that loses means the run asks less than one of the files says it will.
  for (const s of SPLIT_SETTINGS) {
    const { policy, defaults, used } = readSplit(config, s);
    if (policy === undefined || defaults === undefined || policy === defaults) continue;
    const rank = (v: unknown) => (s.order as readonly unknown[]).indexOf(v);
    const looser = rank(defaults) > rank(used) && rank(used) !== -1;
    problems.push({
      where: `.gnomon/config.toml [defaults] ${s.defaultsKey}`,
      problem:
        `${s.defaultsKey} = "${String(defaults)}" is ignored: .gnomon/policy.toml [${s.block}] ` +
        `${s.key} = "${String(policy)}" is also set, and policy.toml wins. This run uses "${used}"` +
        (looser ? `, which is looser than the value here.` : `.`),
      fix:
        `Set ${s.key} in .gnomon/policy.toml [${s.block}], the one a run reads, and delete ` +
        `${s.defaultsKey} from [defaults] (or make the two agree).`,
      fatal: false,
    });
  }

  // A published option that this build does not implement, named in the
  // surface. Reported rather than silently downgraded.
  for (const [key, spec] of Object.entries(DECLARED_NOT_IMPLEMENTED)) {
    const chosen = (config.config.defaults as Record<string, unknown> | undefined)?.[key];
    if (typeof chosen === "string" && spec.values.includes(chosen)) {
      problems.push({
        where: `.gnomon/config.toml [defaults] ${key}`,
        problem:
          `${key} = "${chosen}" is published in the enumerations contract but NOT implemented in this ` +
          `build. The run uses "${spec.inUse}" — ${spec.why}. Nothing said so until now, so a surface ` +
          `could ask for one edit format and get another in silence.`,
        fix: `Set ${key} = "${spec.inUse}", or keep "${chosen}" knowing it does not take effect. ` +
             `\`gnomon enumerations --json\` lists every published value; this is the subset that is inert.`,
        fatal: false,
      });
    }
  }

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
      // Every enumeration this block owns, not just the first one. See
      // ENUM_KEYS: the old shape could only express one per block, which is
      // how [sandbox] exec went unchecked.
      for (const spec of ENUM_KEYS) {
        if (spec.block !== block) continue;
        const value = (body as Record<string, unknown> | undefined)?.[spec.key];
        if (typeof value !== "string" || spec.values.includes(value)) continue;
        problems.push({
          where: `.gnomon/${file} [${block}]`,
          problem:
            `${spec.key} = "${value}" is not one of ${spec.values.join(" | ")}, so this ` +
            `silently falls back to "${spec.falls_back_to}".`,
          fix: `Use one of: ${spec.values.join(", ")}. \`gnomon enumerations\` lists them.`,
          fatal: false,
        });
      }
    }
  }

  // [approval] repo_code is read as `=== true` (tools.ts, repoCodeAsks): a
  // quoted "true" or a 1 would read as off, silently, on the one control that
  // asks before repository code runs.
  const repoCode = (config.policy as { approval?: { repo_code?: unknown } } | undefined)?.approval?.repo_code;
  if (repoCode !== undefined && typeof repoCode !== "boolean") {
    problems.push({
      where: ".gnomon/policy.toml [approval]",
      problem: `repo_code = ${JSON.stringify(repoCode)} is not a boolean, so it is read as false: calls that run repository code are not asked about.`,
      fix: "Write repo_code = true (or false), unquoted.",
      fatal: false,
    });
  }

  // [approval] after_refusal_calls is read only as a positive integer
  // (after_refusal.ts resolveAfterRefusal); anything else is the default
  // window, silently, on a control a surface turned on to be stricter.
  const afterRefusalCalls = (config.policy as { approval?: { after_refusal_calls?: unknown } } | undefined)
    ?.approval?.after_refusal_calls;
  if (
    afterRefusalCalls !== undefined &&
    !(typeof afterRefusalCalls === "number" && Number.isInteger(afterRefusalCalls) && afterRefusalCalls >= 1)
  ) {
    problems.push({
      where: ".gnomon/policy.toml [approval]",
      problem: `after_refusal_calls = ${JSON.stringify(afterRefusalCalls)} is not a positive integer, so the default window of 1 call is used.`,
      fix: "Write a whole number of 1 or more, unquoted: after_refusal_calls = 2.",
      fatal: false,
    });
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
      // [bootstrap]'s keys are the ids of its sub-tables, not settings: an id
      // spelled like a setting is a name, and has no owner to be moved to.
      if (file === "policy.toml" && block === "bootstrap") continue;
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
      if (!owner) continue;
      if (owner.file !== file) {
        problems.push({
          where: `.gnomon/${file} [${block}]`,
          problem: owner.read
            ? `[${block}] is declared here but read from ${owner.file} — so this block ` +
              `does nothing, while the surface reads as though it does.`
            : `[${block}] belongs in ${owner.file}, not here — so nothing reads it here. ` +
              `And nothing reads it there either: no consumer of [${block}] exists in ` +
              `this build.`,
          fix: `Move the [${block}] block to .gnomon/${owner.file}.`,
          // Fatal only when the block is a control that would otherwise be in
          // force. A block nothing reads is inert wherever it sits; refusing to
          // start over it would be a claim larger than the evidence.
          fatal: owner.read,
        });
        continue;
      }
      if (!owner.read) {
        problems.push({
          where: `.gnomon/${file} [${block}]`,
          problem:
            `[${block}] is in the right file and is read by nothing. Verified ` +
            `2026-09-02 by grep over packages/*/src and crates/*/src: no consumer. ` +
            `It is typed on the config interface and hashed into the surface, and it ` +
            `changes no behaviour.`,
          fix:
            `Delete the block. A setting that does nothing is worse than no setting: ` +
            `it invites tuning that cannot move, and it moves the surface hash while ` +
            `changing nothing about what the harness does.`,
          fatal: false,
        });
      }
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
      // One problem PER admission, each carrying the remedy for that admission
      // alone.
      //
      // The shipped version emitted a single problem whose `fix` was a fixed
      // string: "add a bash_deny for the executing forms, e.g. bash_deny =
      // ['-exec', '-execdir', '-delete', '-fprint', '\bxargs\b']". Measured
      // 2026-09-02 on a surface written by `gnomon init` itself: the fresh
      // surface warns on first launch, the admission is `an interpreter`
      // (bash_allow names `python -m pytest`), and all five patterns in that
      // remedy were ALREADY in the file init had just written. Following the
      // printed instruction to the letter could not clear the warning, because
      // none of those five patterns guards the interpreter admission. A remedy
      // that cannot clear the thing it is offered for teaches an operator to
      // ignore the auditor.
      //
      // `fix` is now built from the same `deny` data the guard is tested
      // against, so the remedy is by construction the thing whose absence made
      // this fire.
      for (const e of EXECUTING_ARGS) {
        const hits = allow.filter((pat) => typeof pat === "string" && e.admits.test(pat));
        if (hits.length === 0) continue;
        // Guarded per admission: a deny for `git push --delete` says nothing
        // about whether `python` can still run arbitrary code.
        if (deny.some((d) => typeof d === "string" && e.guard.test(denyText(d)))) continue;
        problems.push({
          where,
          problem:
            `bash_allow admits ${e.why} — a program that takes a command as an ` +
            `argument, so an allow-list of program NAMES does not bound this role by ` +
            `the names it appears to. Named by: ${hits.map((h) => JSON.stringify(h)).join(", ")}. ` +
            `NOT VERIFIED: this reads the allow-list pattern TEXT and does not evaluate ` +
            `which commands that pattern actually matches, so it does not show that any ` +
            `particular command reaches this role.`,
          fix:
            `Add to this role's bash_deny — deny wins over allow, so the rest of ` +
            `bash_allow is untouched:\n` +
            `        bash_deny = [${e.deny.map((d) => `'${d}'`).join(", ")}]\n` +
            `      ${e.note}\n` +
            `      Or drop the entr${hits.length > 1 ? "ies" : "y"} above from bash_allow ` +
            `(\`glob\`/\`grep\` are gated read-only tools that already exist).`,
          fatal: false,
        });
      }
    }

    // A per-role `exec` override falls back exactly like the [sandbox] one:
    // resolveExec reads `roleDef?.exec ?? sandbox.exec` and resolves anything
    // that is not the string "docker" to "off". ROLE_KEYS catches a misspelled
    // KEY; nothing caught a misspelled VALUE, so `exec = "dokcer"` on a role
    // read as an isolation request and ran on the host.
    {
      const value = (rawRole as RoleDef)?.exec;
      if (typeof value === "string" && !EXEC_VALUES.includes(value as typeof EXEC_VALUES[number])) {
        problems.push({
          where,
          problem:
            `exec = "${value}" is not one of ${EXEC_VALUES.join(" | ")}, so this role ` +
            `silently falls back to "off" — no sandbox, and no warning.`,
          fix: `Use one of: ${EXEC_VALUES.join(", ")}. Only "docker" is wired in this build.`,
          fatal: false,
        });
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

  // The three checks below are about the SURFACE, not about one role, and
  // they used to sit inside the per-role loop above. Each therefore ran once
  // per role: two genuine task_allow warnings were reported seven times each
  // on this repository's own surface, fifteen lines for three problems. A
  // fatal [chain] stage would have printed seven times and inflated the fatal
  // count sevenfold, which is worse -- warning fatigue is how a real finding
  // gets skipped, and an overstated count erodes trust in the diagnostic.
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
  // `gate = "on_check"` with nothing to check is an option that reads as a
  // guarantee and behaves as `on_refusal`. Exactly the class 7ebd8fd disclosed
  // for published options this build does not implement -- said here at
  // startup rather than discovered when a chain runs to the end that the
  // operator believed was gated.
  if (stages.length >= 2 && resolveChainGate(config) === "on_check" && !resolveVerify(config)) {
    problems.push({
      where: ".gnomon/config.toml [chain]",
      problem:
        `gate = "on_check" but no [verify] command is declared, so there is ` +
        `nothing to check and the gate can only ever act as "on_refusal".`,
      fix: 'Declare [verify] command in policy.toml, or set gate = "on_refusal".',
      fatal: false,
    });
  }
}

// The completion gate: a review naming no role cannot run (fatal); a
// reviewer role declaring tools the review withholds reads as more than it is.
problems.push(...auditCompletionGate(config));
// The sweep knobs (sweep_knobs.ts): each opt-in, none fatal.
problems.push(...auditSweepKnobs(config, (ep) => endpointKind(ep)));

// [shadow] is log-only, so nothing in it is fatal: a shadow that cannot run
// changes nothing about the run. What it can do is look like it is recording
// while it records nothing -- a misspelled key, an order nobody asks, a list
// that is not a list, `enabled` with no url or no model -- and that is the
// inert-setting failure this audit exists for.
{
  const raw = (config.config as { shadow?: Record<string, unknown> } | undefined)?.shadow;
  if (raw && typeof raw === "object") {
    const where = ".gnomon/config.toml [shadow]";
    for (const key of Object.keys(raw)) {
      if (SHADOW_KEYS.includes(key)) continue;
      const near = SHADOW_KEYS.map((k) => [k, editDistance(key, k)] as const)
        .filter(([, d]) => d <= 2)
        .sort((a, b) => a[1] - b[1])[0]?.[0];
      problems.push({
        where,
        problem: `${key} is not a key [shadow] reads; it does nothing` + (near ? `. Did you mean "${near}"?` : "."),
        fix: `[shadow] reads: ${SHADOW_KEYS.join(", ")}.`,
        fatal: false,
      });
    }
    for (const key of ["abort", "role", "approval", "orders"]) {
      const v = raw[key];
      if (v === undefined) continue;
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() !== "")) {
        problems.push({
          where: `${where} ${key}`,
          problem: `${key} is not a list of names, so it is ignored and the default is used.`,
          fix: key === "orders" ? 'orders = ["fwd", "rev"]' : `${key} = ["<model name the server knows>"]`,
          fatal: false,
        });
      }
    }
    if (Array.isArray(raw.orders)) {
      const bad = raw.orders.filter(
        (o) => typeof o === "string" && !(SHADOW_ORDERS as readonly string[]).includes(o)
      );
      if (bad.length > 0) {
        problems.push({
          where: `${where} orders`,
          problem: `${bad.map((o) => `"${o}"`).join(", ")} is not an order; it is skipped.`,
          fix: `orders takes ${SHADOW_ORDERS.map((o) => `"${o}"`).join(" and ")}.`,
          fatal: false,
        });
      }
    }
    if (raw.url !== undefined && !(typeof raw.url === "string" && validShadowUrl(raw.url))) {
      problems.push({
        where: `${where} url`,
        problem: `url is not an http(s) URL, so the shadow is off.`,
        fix: 'url = "http://127.0.0.1:<port>/v1/systemone"',
        fatal: false,
      });
    }
    for (const key of ["timeout_ms", "abort_timeout_ms"] as const) {
      const v = raw[key];
      if (v !== undefined && !(typeof v === "number" && isFinite(v) && v > 0)) {
        problems.push({
          where: `${where} ${key}`,
          problem: `${key} is not a positive number of milliseconds, so ${SHADOW_DEFAULTS[key]} is used.`,
          fix: `${key} = ${SHADOW_DEFAULTS[key]}`,
          fatal: false,
        });
      }
    }
    const s = resolveShadow(config);
    if (raw.enabled === true) {
      if (!s.url) {
        problems.push({
          where,
          problem: "enabled = true with no usable url, so nothing is asked and nothing is recorded.",
          fix: 'Add url = "http://127.0.0.1:<port>/v1/systemone", or remove enabled.',
          fatal: false,
        });
      } else if (s.abort.length + s.role.length + s.approval.length === 0) {
        problems.push({
          where,
          problem: "enabled = true but no model is named for abort, role or approval, so nothing is recorded.",
          fix: 'Name at least one, e.g. abort = ["d1-3b"].',
          fatal: false,
        });
      } else if (s.orders.length === 0) {
        problems.push({
          where: `${where} orders`,
          problem: "no usable order is declared, so no question is asked.",
          fix: 'orders = ["fwd", "rev"]',
          fatal: false,
        });
      }
    }
  }
}

// Context hygiene ([context.mask_observations], [context] bootstrap and the
// [bootstrap.<id>] it names). Both are new, opt-in and decide what reaches the
// model, so the misread shapes are FATAL rather than noted: a mask that fell
// back to its defaults in silence, or a bootstrap that never ran in silence,
// is a surface saying one thing while the harness does another -- on keys
// whose whole purpose is to be measured.
{
  const ctx = (config.config.context ?? {}) as Record<string, unknown>;
  const where = ".gnomon/config.toml [context]";
  const mask = ctx.mask_observations;
  if (mask !== undefined) {
    if (typeof mask === "string" && mask.trim().startsWith("{")) {
      problems.push({
        where: `${where} mask_observations`,
        problem:
          `mask_observations is written as an inline table, which gnomon's TOML subset reads as ` +
          `the string ${JSON.stringify(mask)} (CONTRACTS.md §5.3): nothing would be masked.`,
        fix:
          `Write it as a table of its own:\n` +
          `        [context.mask_observations]\n` +
          `        keep_last = ${MASK_DEFAULTS.keep_last}\n` +
          `        at_fill = ${MASK_DEFAULTS.at_fill}\n` +
          `        batch = ${MASK_DEFAULTS.batch}`,
        fatal: true,
      });
    } else if (mask === null || typeof mask !== "object" || Array.isArray(mask)) {
      problems.push({
        where: `${where} mask_observations`,
        problem: `mask_observations is a ${Array.isArray(mask) ? "list" : typeof mask}, not a table, so nothing would be masked.`,
        fix: `Declare it as [context.mask_observations] with ${MASK_KEYS.join(", ")}.`,
        fatal: true,
      });
    } else {
      const m = mask as Record<string, unknown>;
      const at = ".gnomon/config.toml [context.mask_observations]";
      for (const key of Object.keys(m)) {
        if (MASK_KEYS.includes(key)) continue;
        const near = MASK_KEYS.map((k) => [k, editDistance(key, k)] as const)
          .filter(([, d]) => d <= 3)
          .sort((a, b) => a[1] - b[1])[0]?.[0];
        problems.push({
          where: at,
          problem: `"${key}" is not a key this table reads` + (near ? `. Did you mean "${near}"?` : "."),
          fix: `[context.mask_observations] reads: ${MASK_KEYS.join(", ")}.`,
          fatal: true,
        });
      }
      const isInt = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min;
      if (m.keep_last !== undefined && !isInt(m.keep_last, 0)) {
        problems.push({
          where: `${at} keep_last`,
          problem: `keep_last must be a whole number, 0 or more; got ${JSON.stringify(m.keep_last)}.`,
          fix: `keep_last = ${MASK_DEFAULTS.keep_last}`,
          fatal: true,
        });
      }
      if (m.batch !== undefined && !isInt(m.batch, 1)) {
        problems.push({
          where: `${at} batch`,
          problem: `batch must be a whole number, 1 or more; got ${JSON.stringify(m.batch)}.`,
          fix: `batch = ${MASK_DEFAULTS.batch}`,
          fatal: true,
        });
      }
      if (
        m.at_fill !== undefined &&
        !(typeof m.at_fill === "number" && Number.isFinite(m.at_fill) && m.at_fill >= 0 && m.at_fill < 1)
      ) {
        problems.push({
          where: `${at} at_fill`,
          problem: `at_fill must be a fraction of the window, at least 0 and below 1; got ${JSON.stringify(m.at_fill)}.`,
          fix: `at_fill = ${MASK_DEFAULTS.at_fill}`,
          fatal: true,
        });
      }
    }
  }

  const blocks = config.policy?.bootstrap as unknown;
  const selected = ctx.bootstrap;
  if (selected !== undefined && (typeof selected !== "string" || selected.trim() === "")) {
    problems.push({
      where: `${where} bootstrap`,
      problem: `bootstrap must name a [bootstrap.<id>] block in policy.toml; got ${JSON.stringify(selected)}, so nothing would run.`,
      fix: `bootstrap = "env", with [bootstrap.env] declared in .gnomon/policy.toml.`,
      fatal: true,
    });
  }
  if (blocks !== undefined && (blocks === null || typeof blocks !== "object" || Array.isArray(blocks))) {
    problems.push({
      where: ".gnomon/policy.toml bootstrap",
      problem: `bootstrap is not a table of [bootstrap.<id>] blocks, so no bootstrap can be selected from it.`,
      fix: `Declare each one as [bootstrap.<id>] with ${BOOTSTRAP_PLATFORMS.join(", ")} lists.`,
      fatal: true,
    });
  }
  const declaredBoots =
    blocks && typeof blocks === "object" && !Array.isArray(blocks) ? (blocks as Record<string, unknown>) : {};
  if (
    typeof selected === "string" &&
    selected.trim() !== "" &&
    !Object.prototype.hasOwnProperty.call(declaredBoots, selected)
  ) {
    problems.push({
      where: `${where} bootstrap`,
      problem:
        `bootstrap = "${selected}" names no [bootstrap.${selected}] block in policy.toml, so nothing ` +
        `would run and the first prompt would carry no snapshot.`,
      fix:
        `Declared: ${Object.keys(declaredBoots).sort().join(", ") || "(none)"}. ` +
        `Add [bootstrap.${selected}] to .gnomon/policy.toml.`,
      fatal: true,
    });
  }
  const here = bootstrapPlatform();
  for (const [id, body] of Object.entries(declaredBoots)) {
    const at = `.gnomon/policy.toml [bootstrap.${id}]`;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      problems.push({
        where: at,
        problem: `[bootstrap.${id}] is not a table.`,
        fix: `Give it ${BOOTSTRAP_PLATFORMS.join(", ")} lists.`,
        fatal: true,
      });
      continue;
    }
    const b = body as Record<string, unknown>;
    for (const key of Object.keys(b)) {
      if (BOOTSTRAP_KEYS.includes(key)) continue;
      const near = BOOTSTRAP_KEYS.map((k) => [k, editDistance(key, k)] as const)
        .filter(([, d]) => d <= 3)
        .sort((x, y) => x[1] - y[1])[0]?.[0];
      problems.push({
        where: at,
        problem: `"${key}" is not a key this block reads` + (near ? `. Did you mean "${near}"?` : "."),
        fix: `[bootstrap.<id>] reads: ${BOOTSTRAP_KEYS.join(", ")}.`,
        fatal: true,
      });
    }
    let platforms = 0;
    for (const fam of BOOTSTRAP_PLATFORMS) {
      const list = b[fam];
      if (list === undefined) continue;
      platforms++;
      if (
        !Array.isArray(list) ||
        list.length === 0 ||
        !list.every((p) => typeof p === "string" && p.trim() !== "")
      ) {
        problems.push({
          where: `${at} ${fam}`,
          problem: `${fam} must be a non-empty list of commands, one probe per string; got ${JSON.stringify(list)}.`,
          fix: `${fam} = ["uname -srm", "git rev-parse --short HEAD"]`,
          fatal: true,
        });
      }
    }
    if (platforms === 0) {
      problems.push({
        where: at,
        problem: `[bootstrap.${id}] declares no probes for any platform, so it can never run.`,
        fix: `Add at least one of ${BOOTSTRAP_PLATFORMS.join(", ")} as a list of commands.`,
        fatal: true,
      });
    }
    for (const key of Object.keys(BOOTSTRAP_DEFAULTS) as (keyof typeof BOOTSTRAP_DEFAULTS)[]) {
      const v = b[key];
      if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v > 0)) {
        problems.push({
          where: `${at} ${key}`,
          problem: `${key} must be a positive whole number; got ${JSON.stringify(v)}.`,
          fix: `${key} = ${BOOTSTRAP_DEFAULTS[key]}`,
          fatal: true,
        });
      }
    }
    if (id === selected && platforms > 0 && b[here] === undefined) {
      problems.push({
        where: at,
        problem:
          `no ${here} probes are declared, and this machine reads ${here}: the bootstrap will not ` +
          `run here, and each session will record outcome "unavailable".`,
        fix: `Add a ${here} = [ ... ] list, or accept running without a snapshot on this machine.`,
        fatal: false,
      });
    }
    if (id !== selected) {
      problems.push({
        where: at,
        problem: `[bootstrap.${id}] is declared and not selected by [context] bootstrap, so it runs nowhere.`,
        fix: `Select it with [context] bootstrap = "${id}" in .gnomon/config.toml, or delete it.`,
        fatal: false,
      });
    }
  }
}

// `max_lines` (CX3) is opt-in and changes no permission, so nothing here is
// fatal. What it can do is look declared while doing nothing: on a tool that
// does not read it, or as a value toolMaxLines ignores.
for (const t of config.tools?.tools ?? []) {
  if (t.max_lines === undefined) continue;
  const where = `.gnomon/tools.toml [[tools]] name = "${t.name}"`;
  if (!(LINE_CAPPED_TOOLS as readonly string[]).includes(t.name)) {
    problems.push({
      where,
      problem: `max_lines is read on ${LINE_CAPPED_TOOLS.join(" and ")} only; on ${t.name} it does nothing.`,
      fix: `Remove it, or declare it on ${LINE_CAPPED_TOOLS.join(" or ")}.`,
      fatal: false,
    });
  } else if (toolMaxLines(config, t.name as LineCappedTool) === undefined) {
    problems.push({
      where,
      problem:
        `max_lines = ${JSON.stringify(t.max_lines)} is not a whole number of at least ` +
        `${MIN_MAX_LINES}, so it is ignored and ${t.name} output is not line-capped.`,
      fix: "max_lines = 200",
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

    for (const field of ["max_tokens", "max_context_tokens"]) {
      const v = block[field];
      if (field === "max_context_tokens" && v === AUTO_WINDOW) continue;
      if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) {
        problems.push({
          where,
          problem: `${field} = ${JSON.stringify(v)} is not a whole number of tokens, so it is ignored.`,
          fix:
            field === "max_tokens"
              ? "max_tokens = 16384 limits each reply; 0 sends no limit."
              : `max_context_tokens = <the model's window in tokens>, e.g. 131072, or "${AUTO_WINDOW}" to read it from the endpoint.`,
          fatal: false,
        });
      }
    }

    if (block.replay_reasoning !== undefined && typeof block.replay_reasoning !== "boolean") {
      problems.push({
        where,
        problem: `replay_reasoning = ${JSON.stringify(block.replay_reasoning)} is not true or false, so it is ignored.`,
        fix: "replay_reasoning = true sends reasoning_content back on assistant messages; false does not.",
        fatal: false,
      });
    } else if (
      block.replay_reasoning === true &&
      endpointKind({ url: block.url as string | undefined, kind: block.kind as EndpointKind | undefined }) ===
        "ollama"
    ) {
      problems.push({
        where,
        problem: `replay_reasoning = true on an Ollama /api/chat endpoint: that route is never sent reasoning_content, so the line does nothing.`,
        fix: "Delete the line, or use the server's OpenAI route with kind = \"openai\".",
        fatal: false,
      });
    }

    if (
      block.steer_role !== undefined &&
      !(typeof block.steer_role === "string" && (STEER_ROLES as readonly string[]).includes(block.steer_role))
    ) {
      problems.push({
        where,
        problem: `steer_role = ${JSON.stringify(block.steer_role)} is not one of ${STEER_ROLES.map((r) => `"${r}"`).join(", ")}, so gnomon's mid-turn messages stay system messages.`,
        fix: 'steer_role = "user" sends them as user messages marked [gnomon]; "system", or no line, keeps them as system messages.',
        fatal: false,
      });
    }

    if (block.stream !== undefined && typeof block.stream !== "boolean") {
      problems.push({
        where,
        problem: `stream = ${JSON.stringify(block.stream)} is not true or false, so it is ignored.`,
        fix: "stream = true streams the reply; false waits for it whole. Absent, [defaults] stream decides.",
        fatal: false,
      });
    } else if (
      block.stream === true &&
      endpointKind({ url: block.url as string | undefined, kind: block.kind as EndpointKind | undefined }) ===
        "ollama"
    ) {
      problems.push({
        where,
        problem:
          `stream = true on an Ollama /api/chat endpoint: that route is always called ` +
          `unstreamed, so the line does nothing.`,
        fix:
          `To stream from Ollama, point a kind = "openai" block at its OpenAI route, ` +
          `http://127.0.0.1:11434/v1/chat/completions. Otherwise delete the line.`,
        fatal: false,
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

    // No kind, and a URL that does not name one, so the request shape is a
    // guess. A URL that does name one is not reported: the shape follows from
    // a line in the surface (see endpointKind), and warning on every start
    // about a correct inference would teach people to skip the warnings.
    if (kind === undefined && typeof block.url === "string" && block.url && !kindFromUrl(block.url)) {
      problems.push({
        where,
        problem:
          `no kind, and the url does not name a request shape, so requests go out as ` +
          `kind = "${endpointKind({ url: block.url })}".`,
        fix:
          `Add kind = "openai" for a server that answers at …/chat/completions, ` +
          `or kind = "ollama" for Ollama's own …/api/chat.`,
        fatal: false,
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

  // ── Skills ───────────────────────────────────────────────────────────────
  //
  // A skill file is surface: it is hashed, and its body goes into the system
  // prompt. Three ways it can be inert or hostile, none of which said anything
  // before this:
  //
  //   1. `match` will not compile. selectSkills does
  //      `try { new RegExp(s.match, "i") } catch { return false }` -- so the
  //      skill silently applies to NOTHING, forever, and the surface reads as
  //      though the note is in force. The catch is right (one bad note must not
  //      break every turn) and silent is wrong.
  //   2. A control character. It renders as nothing in a terminal, so
  //      `gnomon skill list` and a diff both show a file that looks correct,
  //      while an ESC sequence in the body can repaint the operator's screen
  //      and any C0 byte reaches the model as prompt text. It hashes like any
  //      other byte, so the surface hash moves and the visible file does not.
  //   3. `roles` naming a role this surface does not declare. selectSkills
  //      filters on `s.roles.includes(role)`, so one typo -- "implementer" for
  //      "implementor" -- makes the note apply to nothing. Same silence as (1),
  //      one letter earlier.
  //
  // Warnings, not refusals: a dead skill costs knowledge, not safety.
  //
  // Guarded on gnomonDir because auditSurface is also called on hand-built
  // config objects that never loaded a directory (config.test.ts does this
  // throughout), and join(undefined, "skills") throws.
  if (typeof config.gnomonDir === "string" && config.gnomonDir) {
    const roleNames = new Set(Object.keys(config.roles ?? {}));
    let skills: ReturnType<typeof loadSkills> = [];
    try {
      skills = loadSkills(config);
    } catch (e) {
      problems.push({
        where: ".gnomon/skills/",
        problem: `the skills directory could not be read: ${(e as Error).message}`,
        fix: "Fix or remove the unreadable file. Until then no skill loads at all.",
        fatal: false,
      });
    }
    for (const skill of skills) {
      const where = `.gnomon/skills/${skill.id}.md`;

      if (skill.match !== undefined) {
        try {
          new RegExp(skill.match, "i");
        } catch (e) {
          problems.push({
            where,
            problem:
              `match = ${JSON.stringify(skill.match)} is not a valid regular expression: ` +
              `${(e as Error).message}. selectSkills catches this and returns false, so ` +
              `the skill applies to nothing — on every turn, silently.`,
            fix:
              `Fix the pattern, or delete the \`match\` line entirely: a skill with no ` +
              `match always applies, which is what a broken one was probably meant to do.`,
            fatal: false,
          });
        }
      }

      // C0 and C1 controls, minus the three that are legitimate text.
      // eslint-disable-next-line no-control-regex
      const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
      for (const [field, text] of [
        ["name", skill.name],
        ["description", skill.description],
        ["match", skill.match],
        ["body", skill.body],
      ] as const) {
        if (typeof text !== "string") continue;
        const at = text.search(CONTROL);
        if (at < 0) continue;
        const code = text.charCodeAt(at);
        problems.push({
          where,
          problem:
            `${field} holds a control character (U+${code.toString(16).toUpperCase().padStart(4, "0")}` +
            `${code === 0x1b ? ", ESC" : ""}) at offset ${at}. It renders as nothing, so the ` +
            `file looks correct in a terminal and in a diff while the surface hash has ` +
            `moved` +
            (field === "body"
              ? ` — and the body goes into the system prompt verbatim.`
              : `.`),
          fix:
            `Remove the byte. To find it:  grep -nP '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]' ` +
            `.gnomon/skills/${skill.id}.md`,
          fatal: false,
        });
        break; // one report per skill is enough to send someone to the file
      }

      for (const role of skill.roles ?? []) {
        if (roleNames.has(role)) continue;
        const near = [...roleNames]
          .map((r) => [r, editDistance(role, r)] as const)
          .filter(([, d]) => d <= 3)
          .sort((a, b) => a[1] - b[1])[0]?.[0];
        problems.push({
          where,
          problem:
            `roles names "${role}", which is not a role in this surface — selectSkills ` +
            `filters on that list, so this skill reaches nothing under that name` +
            (near ? `. Did you mean "${near}"?` : "."),
          fix:
            `Declared roles: ${[...roleNames].sort().join(", ") || "(none)"}. ` +
            `Remove \`roles\` entirely to apply the skill to every role.`,
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
/**
 * How long one auth probe may take.
 *
 * ONE number, because the answer must not depend on which command asked. It
 * was three — 15s in the loop's `/endpoints`, 20s in `gnomon endpoint list`,
 * 30s in `gnomon endpoint test` — against a cold local model that takes longer
 * than the smallest of them. Measured 2026-09-07 on this machine, first call
 * after `keep_alive: 0`, ollama serving qwen3.6:35b (the model `gnomon init`
 * itself selects here): 17.7s, 23.9s. So the same healthy endpoint reported
 *
 *     gnomon endpoint test local   ✓ answered a real completion
 *     /endpoints                   ✗ The operation was aborted due to timeout
 *
 * in the same minute, and `/endpoints` was a coin-flip run to run.
 *
 * A cold model load is the slowest thing this probe legitimately waits on, so
 * the budget is set above it rather than at it. An endpoint that is actually
 * unreachable fails on connect, long before this.
 */
export const PROBE_TIMEOUT_MS = 45000;

export async function probeEndpointAuth(
  endpoint: EndpointConfig,
  model: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const key = endpoint.api_key_env ? process.env[endpoint.api_key_env] : undefined;
  if (endpoint.api_key_env && !key) {
    return { ok: false, detail: `$${endpoint.api_key_env} is not set` };
  }

  const ollama = endpointKind(endpoint) === "ollama";
  const body = ollama
    ? { model, messages: [{ role: "user", content: "hi" }], stream: false }
    : { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      // The same client identity a real turn sends (callEndpoint in
      // prompt_loop.ts). Without it opencode's Console Go answers 400
      // MissingSessionID, and the probe reported a working key as a failure.
      headers: {
        "Content-Type": "application/json",
        "User-Agent": harnessBuild(),
        "x-opencode-session": `gnomon-probe-${process.pid}-${Date.now()}`,
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, status: res.status };
    const text = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: res.status, detail: text || res.statusText };
  } catch (err) {
    // Node's fetch says "fetch failed" for a refusal, a DNS miss and a TLS
    // error alike; the real errno hangs off `.cause`. `endpoint test` printed
    // "✗ fetch failed" for an Ollama that simply was not started.
    let code: string | undefined;
    for (let cur: unknown = err, i = 0; i < 8 && cur && !code; i++) {
      const c = (cur as { code?: unknown }).code;
      if (typeof c === "string") code = c;
      cur = (cur as { cause?: unknown }).cause;
    }
    let where = endpoint.url;
    try {
      const u = new URL(endpoint.url);
      where = `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
    } catch {
      /* keep the raw URL */
    }
    if (code === "ECONNREFUSED") {
      const local = /^(localhost|127\.|\[?::1\]?$)/.test(where);
      return {
        ok: false,
        detail: local
          ? `nothing is listening on ${where} — start the model server (\`ollama serve\` for Ollama)`
          : `connection refused by ${where}`,
      };
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return { ok: false, detail: `cannot resolve ${where} (${code}) — check the URL and the network` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: code ? `${msg} (${code})` : msg };
  }
}

/** Every endpoint the surface offers, built-ins included. */
/**
 * The environment-variable NAMES this surface declares as credential holders.
 *
 * The one legitimate reason for the machine-local store to touch process.env.
 * Anything not in this set is configuration, not a credential, and the store
 * refuses it -- see applyCredentials.
 */
export function declaredKeyVars(config: GnomonConfig): string[] {
  const out = new Set<string>();
  for (const ep of Object.values(config.config.endpoints ?? {})) {
    const name = (ep as { api_key_env?: unknown } | undefined)?.api_key_env;
    if (typeof name === "string" && name.trim()) out.add(name.trim());
  }
  // MCP servers forward named variables to their child process, and those are
  // credentials by the same definition.
  for (const def of Object.values(config.tools?.mcp_servers ?? {})) {
    for (const name of (def as { env?: unknown }).env as string[] | undefined ?? []) {
      if (typeof name === "string" && name.trim()) out.add(name.trim());
    }
  }
  return [...out].sort();
}

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

/** The reasoning effort and the sampling left to the provider, only when declared. */
function knobsOf(
  role: RoleDef,
  endpoint: EndpointConfig | undefined,
  kind: EndpointKind
): Pick<RouteTarget, "reasoningEffort" | "samplingOmitted"> {
  const effort = resolveReasoningEffort(role, endpoint, kind);
  const omitted = samplingOmitted(role, endpoint);
  return {
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(omitted.length > 0 ? { samplingOmitted: omitted } : {}),
  };
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
  // `"provider"` (sweep_knobs.ts) is not sent at all; the number carried for
  // display is then the default. Anything else is passed on as it always was.
  const temperature = (roleDef.temperature === "provider" ? 0.2 : roleDef.temperature ?? 0.2) as number;
  const top_p = (roleDef.top_p === "provider" ? 0.9 : roleDef.top_p ?? 0.9) as number;
  const description = roleDef.description ?? "";

  // Where inference goes is declared in the surface and hashed with it.
  // GNOMON_MODEL_URL remains only as an explicit override, and the prompt
  // loop announces it when set — a machine-scoped route that changed
  // behaviour silently is exactly what Rule 1 exists to prevent.
  const endpointName = roleDef.endpoint ?? DEFAULT_ENDPOINT;
  const endpoint = resolveEndpoint(config, endpointName);
  const resilience = resolveResilience(config);
  // `||`, not `??`. A variable set to nothing (`GNOMON_MODEL_URL= gnomon …`,
  // or a blank entry in a CI env block) is how people switch one off, and
  // `??` kept the empty string. Every route then failed with "Failed to
  // parse URL from", while the startup note, which tests the variable for
  // truthiness, said nothing was overridden.
  const url = process.env.GNOMON_MODEL_URL || endpoint.url;
  const kind = endpointKind(endpoint);
  const target: RouteTarget = {
    model,
    temperature,
    top_p,
    url,
    apiKeyEnv: endpoint.api_key_env,
    endpoint: endpointName,
    kind,
    stream: resolveStream(endpoint, "ollama", config.config.defaults?.stream),
    streamIdleMs: resilience.stream_idle_timeout_ms,
    streamTotalMs: resilience.stream_total_timeout_ms,
    maxTokens: resolveMaxTokens(config, roleDef, endpoint),
    ...contextWindowOf(config, endpoint.max_context_tokens, { url, kind, model }),
    replayReasoning: resolveReplayReasoning(endpoint),
    ...(resolveSteerRole(endpoint) === "user" ? { steerRole: "user" as const } : {}),
    // The sweep knobs (sweep_knobs.ts): each absent unless declared, so an
    // undeclared surface builds the target it always did.
    ...knobsOf(roleDef, endpoint, kind),
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
    const fbUrl = fb.url ?? fbEndpoint?.url ?? "";
    // A fallback with no kind has always defaulted to openai, so that stays
    // the default for a URL that names no shape.
    const fbKind = endpointKind(fbEndpoint ?? { url: fb.url }, "openai");
    fallback = {
      model: fb.model,
      temperature,
      top_p,
      url: fbUrl,
      apiKeyEnv: fb.api_key_env ?? fbEndpoint?.api_key_env,
      endpoint: fbEndpointName,
      kind: fbKind,
      stream: resolveStream(fbEndpoint ?? { url: fb.url }, "openai", config.config.defaults?.stream),
      streamIdleMs: resilience.stream_idle_timeout_ms,
      streamTotalMs: resilience.stream_total_timeout_ms,
      maxTokens: resolveMaxTokens(config, roleDef, fbEndpoint),
      ...contextWindowOf(config, fbEndpoint?.max_context_tokens, { url: fbUrl, kind: fbKind, model: fb.model }),
      replayReasoning: resolveReplayReasoning(fbEndpoint ?? { url: fb.url }, "openai"),
      ...(resolveSteerRole(fbEndpoint) === "user" ? { steerRole: "user" as const } : {}),
      ...knobsOf(roleDef, fbEndpoint, fbKind),
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
        //
        // `extensions/` is the same case, found 2026-09-04 by applying the
        // via-negativa principle to the surface: remove a source of fragility
        // rather than disclose it. Commit 9f38bfd DISCLOSED that every file
        // under `.gnomon/extensions/` is hashed by both implementations and
        // loaded by neither -- so dropping an extension in moves the hash,
        // which is the harness announcing that behaviour changed, while
        // behaviour does not change at all. Disclosure is the protective layer
        // bolted on top; this is the removal.
        //
        // The direction of the remaining error matters and is stated on
        // purpose. Excluding a path trades a FALSE POSITIVE (hash moves,
        // behaviour does not) for the risk of a FALSE NEGATIVE (behaviour
        // changes, hash does not) if an extension host is ever built and
        // nobody re-includes the directory. A false negative is far worse for
        // a project whose whole claim rests on this hash. That risk is not
        // accepted on trust: `benchmarks/surface-fidelity/` measures BOTH
        // directions over every surface path on every run, and a host that
        // starts loading extensions while they are excluded here shows up
        // there as a false negative.
        //
        // `trials/` IS hashed, deliberately (2026-11). A skill-trial spec does
        // not change what the agent does, but it decides what `require_trial`
        // accepts, so it is behaviour of the governed system. For a short
        // while it was excluded, which let the agent's shell loosen a spec
        // (alpha = 2, min_pass_gain = 0) without moving the hash, and a
        // no-effect skill then passed require_trial. Review caught it; the
        // surface-fidelity suite now counts a spec change as a behaviour
        // change (benchmarks/surface-fidelity).
        if (
          relPath !== ".gnomon/skills/proposed" &&
          relPath !== ".gnomon/extensions"
        ) {
          walk(fullPath);
        }
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

/**
 * The two settings that have two homes, and the order they are read in.
 *
 * `approval` and `sandbox` can each be set in config.toml `[defaults]` and in
 * policy.toml (`[approval] gate`, `[sandbox] level`). policy.toml wins. That
 * order was spelled out at eight call sites, and two of them left out the
 * `[defaults]` step: `/sandbox` and `explain sandbox` reported "confined" for a
 * surface whose turns ran under `[defaults] sandbox = "off"`. Each setting is
 * now resolved in one place, and auditSurface names the losing value when the
 * two files disagree (see SPLIT_SETTINGS).
 */
const SPLIT_SETTINGS = [
  { defaultsKey: "approval", block: "approval", key: "gate", fallback: "on_write",
    order: ["never", "on_write", "always"] },
  { defaultsKey: "sandbox", block: "sandbox", key: "level", fallback: "confined",
    order: ["off", "confined", "strict"] },
] as const;

type SplitSetting = (typeof SPLIT_SETTINGS)[number];

/** Each file's value for one split setting, and the one a run uses. */
function readSplit(
  config: GnomonConfig,
  s: SplitSetting
): { policy?: unknown; defaults?: unknown; used: string } {
  const policy = ((config.policy ?? {}) as Record<string, Record<string, unknown> | undefined>)[s.block]?.[s.key];
  const defaults = (config.config.defaults as Record<string, unknown> | undefined)?.[s.defaultsKey];
  const used = (policy ?? defaults ?? s.fallback) as string;
  return { policy, defaults, used };
}

/** The approval gate a turn runs under: policy.toml, then `[defaults]`, then on_write. */
export function resolveApprovalGate(config: GnomonConfig): "never" | "on_write" | "always" {
  return readSplit(config, SPLIT_SETTINGS[0]).used as "never" | "on_write" | "always";
}

/** The sandbox level a turn runs under: policy.toml, then `[defaults]`, then confined. */
export function resolveSandboxLevel(config: GnomonConfig): "off" | "confined" | "strict" {
  return readSplit(config, SPLIT_SETTINGS[1]).used as "off" | "confined" | "strict";
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
/**
 * A container image reference: `[registry[:port]/]path[:tag][@algo:hex]`, the
 * grammar of the distribution reference. Nothing else is accepted for
 * `[sandbox] image` or a role's `image`.
 *
 * WHY (fifth review, finding 5). The image was interpolated unquoted into the
 * host's `sh -c` line, and nothing checked it: `image = "x; touch ~/p"` ran
 * the tail on the host, and `image = "--privileged"` was a docker flag. The
 * surface is writable by whoever wrote it last, which under a container may
 * have been the container.
 */
const IMAGE_DOMAIN = "(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?))*(?::[0-9]+)?";
const IMAGE_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const IMAGE_REF = new RegExp(
  `^(?:${IMAGE_DOMAIN}/)?${IMAGE_COMPONENT}(?:/${IMAGE_COMPONENT})*` +
    "(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?" +
    "(?:@[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,})?$"
);

export function isValidImageRef(image: unknown): image is string {
  return typeof image === "string" && image.length > 0 && image.length <= 255 && !image.startsWith("-") && IMAGE_REF.test(image);
}

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
/**
 * What stops a declared chain early.
 *
 * One dial, three honest positions, in the same idiom as `approval.gate` —
 * each strictly stronger than the one above it:
 *
 * - `never`   — only an apparatus failure (10/12/13) stops the chain. A stage
 *               that refused, or whose declared check failed, still hands its
 *               answer to the next stage. This is the behaviour every existing
 *               surface has, and it stays the default for that reason.
 * - `on_refusal` — a stage whose bucket is `refusal` also stops it. A stage
 *               that declined to do the work has no answer to pass on, and the
 *               stages after it would be building on a non-answer.
 * - `on_check` — `on_refusal`, plus a stage whose declared `[verify]` check did
 *               not pass. This is the position that makes a chain a chain: the
 *               implementor's work is checked before the verifier is asked to
 *               look at it, and a failing check stops the run rather than being
 *               recorded and stepped over.
 *
 * What `on_check` deliberately does NOT do: gate on a stage's OPINION. A
 * verifier that reads the code and reports "this is wrong" in prose still exits
 * 0, and no amount of reading its sentence would be capability — it would be
 * instruction, on the wrong side of the line this harness is built around. The
 * thing that stops the chain is a check that ran and failed, which is real
 * state. A surface wanting a verdict to gate declares a `[verify] command` that
 * expresses it.
 */
export type ChainGate = "never" | "on_refusal" | "on_check";

/**
 * Read `[chain] gate`.
 *
 * Absent means `never`, which is what every surface written before this option
 * existed already does. `gnomon init` writes it explicitly, so a scaffolded
 * surface says what it chose; an existing one inherits the code default and
 * nothing moves under anybody — the lesson `compaction` cost this project a
 * release to learn.
 */
export function resolveChainGate(config: GnomonConfig): ChainGate {
  const raw = (config.config as { chain?: { gate?: unknown } } | undefined)?.chain?.gate;
  return raw === "on_refusal" || raw === "on_check" ? raw : "never";
}

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
  /**
   * Whether the surface wrote transport_grace_ms down. A refused socket on
   * this machine gets a short grace unless it did -- a default is not a
   * declaration. See the loopback branch in callEndpoint.
   */
  transport_grace_declared: boolean;
  /**
   * A streamed reply that sends nothing for this long has stalled, and the
   * request is aborted. Counted from the first byte of the body; before it,
   * `request_timeout_ms` is the wait, as it is for a whole unstreamed reply.
   */
  stream_idle_timeout_ms: number;
  /** The overall cap on one streamed reply, however steadily it arrives. */
  stream_total_timeout_ms: number;
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
    transport_grace_declared: num(r?.transport_grace_ms, -1) >= 0,
    // 300 s of silence: the longest gap a live stream is seen to leave is a
    // reasoning model thinking with its reasoning hidden, and Codex's
    // stream_idle_timeout_ms defaults to the same figure for that reason.
    stream_idle_timeout_ms: Math.max(1000, Math.floor(num(r?.stream_idle_timeout_ms, 300_000))),
    // 30 minutes. Generous on purpose: this is not the guard, the idle timeout
    // is. It stops a reply that never ends, which no idle clock can see.
    stream_total_timeout_ms: Math.max(
      1000,
      Math.floor(num(r?.stream_total_timeout_ms, 1_800_000))
    ),
  };
}

/**
 * Resolved [loop]: the numbers that decide when a turn stops, is nudged, or is
 * pushed to converge.
 *
 * Every one of these was a TypeScript constant until now, which broke the one
 * sentence the whole design exists to earn. From this repo's own
 * docs/HARNESS-RESEARCH-RECONCILIATION.md: all 114 session records in the
 * surviving benchmark arm carry `surface=be52a8a14db8` while the mechanism that
 * ended a large share of those runs -- `NUDGE_AFTER_IDLE = 12` -- was invisible
 * to that hash. "Today 12 can become 40 without moving a byte of the manifest."
 * Two checkouts with identical surface hashes on two gnomon builds behaved
 * differently and nothing in the record could say so.
 */
export interface ResolvedLoop {
  /**
   * Consecutive blank completions tolerated before the turn is called finished.
   *
   * Bounded so a model that has genuinely stopped producing cannot spin out the
   * budget, but not so tight that one blank ends a turn with steps to spare.
   * Measured: one nudge is survivable (10/14 trials pass), two is not (1/11).
   */
  max_consecutive_empty: number;
  /**
   * Consecutive replies whose tool calls could not be used, tolerated before
   * the turn is ended with `stop_reason: "malformed"`.
   *
   * "Could not be used" means every call in the reply had arguments that were
   * not a JSON object, or named a tool this role was not offered; or the reply
   * wrote its call out as markup in the text; or the endpoint itself failed to
   * parse the call the model emitted. Each such reply is answered with what was
   * wrong and the model is asked to re-issue the call -- a repair turn. Any
   * usable reply resets the count.
   *
   * Local Qwen-family models behind llama.cpp or Ollama produce all four shapes
   * when the chat template and the endpoint's tool parser disagree. Without a
   * bound the repair turns ran until the step wall. NOT VERIFIED: 2 is not a
   * measured optimum; it is "re-ask twice", the same order as the other
   * re-ask bounds in this block.
   */
  max_consecutive_malformed: number;
  /** How many run notes are kept and replayed. Oldest fall off first. */
  max_run_notes: number;
  /**
   * `converge_after` applied to a role that holds no tool which can change
   * anything, when the surface declared none of its own.
   *
   * Measured on a real read-only audit of a 229-file repository: 65 tool calls,
   * 54 of them reads, stop_reason step_wall, and no answer at all. A role whose
   * only possible output is a report has no reason to explore to the wall.
   * 0 disables it, which is the behaviour before the default existed.
   */
  read_only_converge_after: number;
  /**
   * Refusals of one tool, across all of its calls, before the loop says out
   * loud that the policy may be wrong.
   *
   * Measured on a greenfield run: 8 bash calls, 8 refusals, a stall, nothing
   * built -- an allow-list written `'...\\s'` in a TOML literal string compiles
   * and matches no command, so auditSurface cannot catch it.
   */
  all_refused_notice: number;
  /**
   * Tool calls one leg may make when a role declares no `max_steps`.
   *
   * A role's own `max_steps` in roles.toml still wins; this is only the value
   * used when it is silent. It was invisible before it was declarable: a
   * session read roles.toml, concluded "plan has no step limit", and then hit
   * this number.
   */
  max_steps: number;
  /**
   * Legs before the wall: `max_steps_total` defaults to `max_steps * legs`.
   *
   * `max_steps` was a wall, so a long task ended mid-sentence and an operator
   * had to notice and re-prompt. In a session left running for hours nobody is
   * watching to do that, so it is a checkpoint: the harness compacts and
   * continues. 1 restores the old stop-at-the-first-checkpoint behaviour.
   */
  legs: number;
  /** Consecutive identical tool calls that mean the model is going in circles. */
  stall_repeats: number;
  /**
   * Calls without a write before the anti-flailing nudge fires, and re-fires.
   *
   * `stall_repeats` catches a model repeating one call verbatim; it does not
   * catch the other measured failure -- many *different* diagnostic calls, none
   * of them a write. On `git-multibranch` gnomon ran a hundred distinct
   * read-only commands over twenty minutes and still failed; the fast harnesses
   * gave up in four. Persistence wins hard-but-solvable tasks, so this is a
   * nudge and not a wall.
   */
  nudge_after_idle: number;
  /**
   * Calls between convergence re-pushes once `converge_after` is reached.
   *
   * The first version re-fired every `max_steps` (~28), which in a short run --
   * a weak model under an external clock reaches only ~45 calls before being
   * killed -- fired once and then never again. A single "submit what you have"
   * is easy to ignore.
   */
  converge_refire: number;
}

/**
 * The compiled-in values, kept in ONE place.
 *
 * prompt_loop.ts re-exports these under their old constant names rather than
 * repeating the numbers, because a default written twice is a setting with two
 * values: `modelTimeoutMs` hardcoded 120_000 while resolveResilience defaulted
 * to 300_000, and the same surface got whichever path happened to ask.
 */
export const LOOP_DEFAULTS: ResolvedLoop = {
  max_consecutive_empty: 3,
  max_consecutive_malformed: 2,
  max_run_notes: 40,
  read_only_converge_after: 0.6,
  all_refused_notice: 3,
  max_steps: 12,
  legs: 8,
  stall_repeats: 3,
  nudge_after_idle: 12,
  converge_refire: 6,
};

/**
 * Read [loop] from config.toml.
 *
 * Defaults are exactly the constants this replaces, so no existing surface
 * changes behaviour and no existing hash starts meaning something new. What
 * changes is that a surface CAN now say -- and when it says, the hash moves.
 *
 * NOT VERIFIED: no run has been measured before and after this. It is a
 * correctness change to what the surface hash covers, not a tuning change, and
 * it is not evidence that any of these numbers is the right one.
 *
 * Known limit, published rather than papered over: three loop behaviours are
 * still compiled in and still outside the hash -- `STALL_WINDOW` (8) and
 * `STALL_DISTINCT` (2), which govern the A-B-A-B alternation test, and the TEXT
 * of the nudge and convergence messages, which the reconciliation doc names
 * alongside the numbers. So "[loop] declares the loop" is true of these ten and
 * of nothing else yet.
 */
export function resolveLoop(config: GnomonConfig): ResolvedLoop {
  const l = (config.config as { turn?: Record<string, unknown> } | undefined)?.turn;
  const num = (v: unknown, d: number) =>
    typeof v === "number" && isFinite(v) && v >= 0 ? v : d;
  const d = LOOP_DEFAULTS;
  return {
    // 0 is legal and means "one blank ends the turn": never re-ask.
    max_consecutive_empty: Math.floor(num(l?.max_consecutive_empty, d.max_consecutive_empty)),
    // 0 is legal too: the first unusable reply ends the turn, with no repair.
    max_consecutive_malformed: Math.floor(
      num(l?.max_consecutive_malformed, d.max_consecutive_malformed)
    ),
    // Floored at 1, not 0. `pushNote` keeps the tail with `slice(-limit)`, and
    // `[1,2,3].slice(-0)` returns the WHOLE array -- checked in node, not in a
    // test -- so a bound of zero would silently mean no bound at all. A setting
    // that reads as "keep none" and does the opposite is the failure this file
    // exists to prevent.
    max_run_notes: Math.max(1, Math.floor(num(l?.max_run_notes, d.max_run_notes))),
    // A fraction of the step budget, so clamped to it. 0 means never.
    read_only_converge_after: Math.min(
      1,
      num(l?.read_only_converge_after, d.read_only_converge_after)
    ),
    all_refused_notice: Math.floor(num(l?.all_refused_notice, d.all_refused_notice)),
    // Floored at 1 because 0 makes max_steps_total 0, which is the wall on the
    // first call: the turn ends before any tool runs. A role that really wants
    // that already has max_steps_total = 0 in roles.toml, where it is one role's
    // decision rather than every role's.
    max_steps: Math.max(1, Math.floor(num(l?.max_steps, d.max_steps))),
    legs: Math.max(1, Math.floor(num(l?.legs, d.legs))),
    // Floored at 1 for the same class of reason as max_run_notes: the stall test
    // is `recentCalls.slice(-stall_repeats).every(...)`, and at 0 that is
    // `[].every(...)`, which is `true`. Zero would declare a stall on the first
    // tool call of every turn.
    stall_repeats: Math.max(1, Math.floor(num(l?.stall_repeats, d.stall_repeats))),
    // Both are "calls since the last one", so 0 would fire on every single call
    // and turn a nudge into a wall of system messages.
    nudge_after_idle: Math.max(1, Math.floor(num(l?.nudge_after_idle, d.nudge_after_idle))),
    converge_refire: Math.max(1, Math.floor(num(l?.converge_refire, d.converge_refire))),
  };
}

/** The option orders a shadow question can be asked in. */
export const SHADOW_ORDERS = ["fwd", "rev"] as const;
export type ShadowOrder = (typeof SHADOW_ORDERS)[number];

/** A resolved [shadow] block. */
export interface ResolvedShadow {
  /** True only when declared AND there is a usable url to ask */
  enabled: boolean;
  url: string;
  abort: string[];
  role: string[];
  approval: string[];
  orders: ShadowOrder[];
  timeout_ms: number;
  abort_timeout_ms: number;
}

/**
 * No url by default. A shadow server is somebody's infrastructure, not a
 * property of the harness, and a built-in port would be a guess that points
 * every surface that says `enabled = true` at whatever happens to listen there.
 *
 * Both orders by default. The bench found every decision model flips its top
 * answer on more than 10% of items for some task when the options are
 * reversed, so a single-order record cannot be read on its own.
 */
export const SHADOW_DEFAULTS: ResolvedShadow = {
  enabled: false,
  url: "",
  abort: [],
  role: [],
  approval: [],
  orders: ["fwd", "rev"],
  timeout_ms: 1500,
  abort_timeout_ms: 3000,
};

const SHADOW_KEYS = Object.keys(SHADOW_DEFAULTS);

export function validShadowUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

/** Read [shadow] from config.toml. Off unless declared, and off without a url. */
export function resolveShadow(config: GnomonConfig): ResolvedShadow {
  const s = (config.config as { shadow?: Record<string, unknown> } | undefined)?.shadow;
  const d = SHADOW_DEFAULTS;
  const names = (v: unknown, dflt: string[]) =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "")
      ? [...new Set((v as string[]).map((x) => x.trim()))]
      : dflt;
  const ms = (v: unknown, dflt: number) =>
    typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : dflt;
  const url = typeof s?.url === "string" && validShadowUrl(s.url) ? s.url : d.url;
  const orders = Array.isArray(s?.orders)
    ? [
        ...new Set(
          (s!.orders as unknown[]).filter(
            (o): o is ShadowOrder =>
              typeof o === "string" && (SHADOW_ORDERS as readonly string[]).includes(o)
          )
        ),
      ]
    : d.orders;
  return {
    enabled: s?.enabled === true && url !== "",
    url,
    abort: names(s?.abort, d.abort),
    role: names(s?.role, d.role),
    approval: names(s?.approval, d.approval),
    orders,
    timeout_ms: ms(s?.timeout_ms, d.timeout_ms),
    abort_timeout_ms: ms(s?.abort_timeout_ms, d.abort_timeout_ms),
  };
}

/**
 * A TOML document with one top-level table (and its sub-tables) cut out.
 *
 * Line-based on purpose: it has to give the same bytes on every machine for the
 * same input, and it only ever has to recognise table headers, which TOML puts
 * on lines of their own.
 */
export function stripTomlTable(text: string, table: string): string {
  const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
  const out: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    const m = header.exec(line);
    if (m) inside = m[1] === table || m[1]!.startsWith(`${table}.`);
    if (!inside) out.push(line);
  }
  return out.join("\n");
}

/**
 * The surface hash with config.toml's [shadow] table cut out.
 *
 * A shadow changes what is recorded, not what the agent does, and a decision
 * model's calibration is bound to the surface it was fitted on. Keying it on
 * the full hash would make switching a shadow on, or naming one more model, a
 * new calibration cell, and no shadow-on surface could ever match the
 * shadow-off runs it is compared against. Same algorithm as recomputeManifest;
 * a surface with no [shadow] table gives exactly its surface hash.
 */
export function shadowFreeSurfaceHash(gnomonDir: string): string {
  const { manifest } = recomputeManifest(gnomonDir);
  const h = createHash("sha256");
  for (const source of manifest) {
    let sha = source.sha256;
    if (source.path === ".gnomon/config.toml" && sha !== null) {
      try {
        const text = readFileSync(join(gnomonDir, "config.toml"), "utf8");
        const stripped = stripTomlTable(text, "shadow");
        if (stripped !== text) sha = createHash("sha256").update(stripped).digest("hex");
      } catch {
        // Unreadable now, readable a moment ago: keep the manifest's hash.
      }
    }
    h.update(source.path);
    h.update(":");
    h.update(sha ?? "null");
    h.update("\n");
  }
  return h.digest("hex");
}

/** A resolved [verify] block, or null when the surface declares none. */
export interface ResolvedVerify {
  command: string;
  after: "write" | "change" | "always";
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
  const after =
    v?.after === "always" ? "always" : v?.after === "change" ? "change" : "write";
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
 * The project's own check, read off the files that declare it.
 *
 * `init` shipped [verify] commented out, so a surface nobody edited had no
 * gate at all: every turn that ended "done" was a belief nobody checked.
 * Measured 2026-09-29 on a 112-call interactive turn in a medical-device
 * repository -- the repo had `pnpm run verify`, the surface declared nothing,
 * and the agent re-ran the check by hand a dozen times through `| tail`, which
 * reports tail's exit status rather than the check's.
 *
 * Only a command the project already declares is returned; nothing is invented.
 * Order is most-specific first: a script literally named `verify` or `check`
 * is the project saying what "works" means, `test` is the fallback.
 */
export function detectVerifyCommand(root: string): string | null {
  const has = (f: string) => existsSync(join(root, f));
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = (JSON.parse(readFileSync(pkgPath, "utf-8")).scripts ?? {}) as Record<string, unknown>;
    } catch {
      scripts = {};
    }
    const runner = has("pnpm-lock.yaml")
      ? "pnpm"
      : has("yarn.lock")
        ? "yarn"
        : has("bun.lockb") || has("bun.lock")
          ? "bun"
          : "npm";
    for (const name of ["verify", "check", "test"]) {
      const body = scripts[name];
      if (typeof body !== "string" || !body.trim()) continue;
      // npm's placeholder exits 1 by design; declaring it would fail every turn.
      if (/no test specified/.test(body)) continue;
      return runner === "npm" && name === "test" ? "npm test" : `${runner} run ${name}`;
    }
  }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg") || has("tox.ini")) {
    return "pytest -q";
  }
  const makefile = join(root, "Makefile");
  if (existsSync(makefile)) {
    try {
      if (/^test\s*:/m.test(readFileSync(makefile, "utf-8"))) return "make test";
    } catch {
      /* unreadable Makefile: declare nothing */
    }
  }
  return null;
}

/**
 * Recompute the manifest from the .gnomon/ tree on disk.
 * Used for drift detection: compare against the cached manifest.
 * Returns a fresh Manifest suitable for comparison.
 *
 * It took a `build` parameter until this commit and never read it. Six call
 * sites passed the literal "0.1.0", which read as if the returned manifest were
 * stamped with a version — it is not, and the return type never carried one.
 * A dead argument that looks like provenance is worse than no argument in a
 * codebase whose subject is provenance, so it is gone rather than defaulted.
 * The build string a record actually carries comes from harnessBuild().
 */
export function recomputeManifest(baseDir: string): {
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

  return { manifest: sources, surface_hash: manifestHash(sources) };
}

/**
 * The surface hash of a manifest: sha256 over `path:sha256\n` per source, in
 * byte-wise path order. Exported so a caller can name the hash a change WILL
 * produce before making it -- `gnomon skill accept` records its decision
 * before it moves the file.
 */
export function manifestHash(sources: SourceEntry[]): string {
  const sorted = [...sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const source of sorted) {
    hash.update(source.path);
    hash.update(":");
    if (source.sha256) {
      hash.update(source.sha256);
    } else {
      hash.update("null");
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

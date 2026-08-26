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
  mkdirSync,
} from "node:fs";
import { resolve, relative, isAbsolute, dirname, join, sep } from "node:path";
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
   * tools.toml documents an [mcp_servers] block, and nothing reads it. A
   * declared server that is silently ignored is the failure system.md forbids:
   * the tool list would be shorter than the surface asked for, with no
   * refusal naming what is missing.
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
export function buildToolSet(config: GnomonConfig, role?: string): ToolSet {
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
      if (ch === quote && command[i - 1] !== "\\") quote = null;
      current += ch;
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

/** Longest-common-subsequence line diff, rendered as +/- lines. */
export function diffLines(before: string, after: string, context = 3): string[] {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];

  // LCS table. Files here are small enough that O(n·m) is fine.
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
  return `${text.slice(0, limit)}\n… [truncated at ${limit} bytes]`;
}

async function readTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const path = String(args.path ?? "");
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
  const command = String(args.command ?? "");
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
            `This is a guardrail in .gnomon/roles.toml, not a judgement about ` +
            `the command. If it should be allowed, the list is the thing to ` +
            `change — and changing it moves the surface hash.`,
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

  // Pinned before the command runs so drift can be attributed to it. See
  // surfaceHashOf: bash is arbitrary shell, so the surface is detected moving
  // rather than prevented from moving.
  const surfaceBefore = surfaceHashOf(ctx);

  return new Promise<ToolOutcome>((done) => {
    const proc = spawn(command, {
      shell: true,
      cwd: ctx.root,
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
      done({
        code: TOOL_FAILED,
        content: `Command timed out after ${ctx.timeoutMs}ms.`,
        summary: `bash — timeout`,
      });
    }, ctx.timeoutMs);

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
    proc.on("close", (exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const body = [
        `exit: ${exit}`,
        stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
        stderr ? `stderr:\n${stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const drift = surfaceDrift(ctx, surfaceBefore);
      done({
        code: TOOL_OK,
        content: clamp(body, ctx.maxOutputBytes) + (drift ? `\n\n${drift.notice}` : ""),
        summary: `bash — exit ${exit}${drift ? " · surface changed" : ""}`,
        surface_drift: drift ?? undefined,
      });
    });
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

export function inSurface(ctx: ToolContext, abs: string): boolean {
  const surface = ctx.config?.gnomonDir
    ? resolve(ctx.config.gnomonDir)
    : resolve(ctx.root, ".gnomon");
  const rel = relative(surface, resolve(abs));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function writeAllowed(
  ctx: ToolContext,
  abs: string
): { ok: true } | { ok: false; rel: string; listed: string } {
  const allowed = ctx.writeAllow?.filter((p) => p.trim().length > 0) ?? [];
  if (allowed.length === 0) return { ok: true };
  const rel = relative(ctx.root, abs).split(sep).join("/");
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
  if (v6.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(v6)) return true; // unique local
  // IPv4-mapped (::ffff:127.0.0.1) is the same destination by another spelling.
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedAddress(mapped[1]);
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
  const rel = String(args.path ?? "").trim() || ".";
  const abs = resolveInRoot(ctx.root, rel, ctx.sandbox);
  if (!abs) {
    return {
      code: TOOL_OUT_OF_SANDBOX,
      content: `Refused: "${rel}" is outside the repository root and sandbox=${ctx.sandbox}.`,
      summary: `search ${rel} — refused (outside sandbox)`,
    };
  }
  if (!existsSync(abs)) {
    return {
      code: TOOL_OK_EMPTY,
      content: `No such directory: ${rel}`,
      summary: `search ${rel} — not found`,
    };
  }
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
  const content = String(args.content ?? "");
  const abs = resolveInRoot(ctx.root, path, ctx.sandbox);
  if (!abs) {
    return {
      code: TOOL_OUT_OF_SANDBOX,
      content: `Refused: "${path}" is outside the repository root and sandbox=${ctx.sandbox}.`,
      summary: `write ${path} — refused (outside sandbox)`,
    };
  }

  if (inSurface(ctx, abs)) {
    return {
      code: TOOL_DENIED,
      content:
        `Refused: "${path}" is inside .gnomon/, the surface that decides how ` +
        `this agent behaves. It is not writable by a tool call — editing it ` +
        `is a human act, because it changes the surface hash and the rules ` +
        `the next turn runs under. To propose durable guidance instead, use ` +
        `the skill tool.`,
      summary: `write ${path} — refused (surface is read-only)`,
    };
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
        `the next turn runs under.`,
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

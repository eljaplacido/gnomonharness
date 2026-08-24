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
  mkdirSync,
} from "node:fs";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { GnomonConfig, declaredTools, isToolEnabled } from "./config.js";

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
};

export interface ToolSet {
  schemas: ToolSchema[];
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

  return { schemas, disabled, unimplemented, withheld };
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
  const rel = relative(resolve(root), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
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
const MUTATING = new Set(["bash", "write", "edit"]);

/** Whether a call needs sign-off under the configured gate. */
export function needsApproval(tool: string, gate: ApprovalGate): boolean {
  if (gate === "always") return true;
  if (gate === "never") return false;
  // on_write: bash is included because a command can write anything.
  return MUTATING.has(tool);
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
  root: string;
  sandbox: SandboxLevel;
  gate: ApprovalGate;
  approve: Approver;
  /** bash timeout, ms */
  timeoutMs: number;
  /** Cap on bytes returned to the model from read/bash */
  maxOutputBytes: number;
}

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated at ${limit} bytes]`;
}

function readTool(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
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
      done({
        code: TOOL_OK,
        content: clamp(body, ctx.maxOutputBytes),
        summary: `bash — exit ${exit}`,
      });
    });
  });
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
    case "write":
      return writeTool(args, ctx);
    case "edit":
      return editTool(args, ctx);
    default:
      return {
        code: TOOL_NOT_DECLARED,
        content: `Refused: "${name}" is declared but not implemented by this build.`,
        summary: `${name} — not implemented`,
      };
  }
}

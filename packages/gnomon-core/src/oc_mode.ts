/**
 * OC-mode: four opt-in long-task mechanics taken from opencode (docs/CONTRACTS.md
 * §42, conformance/oc_mode.json). Research notes 16 (opencode source) and 19
 * (step-level opencode vs gnomon on CB3).
 *
 * - `[context] compact_at_tokens = <int> | "auto"` (+ `compact_keep_turns`):
 *   inside a turn, once the prompt reaches the threshold, the history after the
 *   task is summarised by the model into a compact state (task, files changed,
 *   decisions, open issues, last test results) and the turn continues from it,
 *   keeping the instructions, the task statement and the last N steps. opencode
 *   compacts at window - max(15% of window, 16k) with an unknown window taken as
 *   200k, i.e. ~170k; on CB3 it did so in 37/80 cells at a median 172.6k (note
 *   19 §1). `"auto"` is that formula on the answering endpoint's window.
 * - `[turn] max_reasoning_tokens_without_action = <int>`: a streamed reply whose
 *   reasoning passes this many tokens (~4 characters each) with no content and
 *   no tool call is aborted and the model gets one short note to compute with a
 *   script instead. Note 19 §4.1: G spent 21% of its model time in calls over
 *   120 s; a 12k cap replayed on the CB3 wire saves 7205 s, 9 cells >= 300 s.
 * - `[sandbox] hide_internal = true` (policy.toml): read, grep and glob skip and
 *   refuse gnomon's own folders (`.gnomon`, `.gnomon-*`), and the system prompt
 *   tells bash to leave them alone. Bash itself is NOT confined: a model can
 *   still `cat .gnomon/system.md`. Note 19 §5: 51/80 G cells read them (517k chars).
 * - `[turn] grader_check = true`: one prompt block, "check like the grader":
 *   test through the task's public entry points, never private hooks, never
 *   edit a test to match the output, and run one varied-input check before an
 *   early answer. Note 19 §4.2-4.3.
 *
 * Every key is off when absent, declared in the surface (so it moves the surface
 * hash), and recorded: `session_start.resolved.oc_mode`, `compaction` and
 * `reasoning_cutoff` audit events, `counters.oc_mode`. With none declared the
 * loop sends exactly the bytes it sent before this file existed.
 */
import type { GnomonConfig } from "./config.js";

/** opencode v2.2.5's reserve: max(15% of the window, 16k) (compaction.ts RESERVE_SHARE/RESERVE_MIN). */
export const COMPACT_RESERVE_SHARE = 0.15;
export const COMPACT_RESERVE_MIN = 16_000;
/** Steps (assistant replies with their tool results) kept verbatim after a compaction, by default. */
export const COMPACT_KEEP_TURNS_DEFAULT = 4;
/** Characters of each message the summariser is shown (opencode clips tool input/output at 2000). */
export const COMPACT_CLIP_CHARS = 2000;
/** The smallest threshold accepted: below it a compaction would fire on the task statement alone. */
export const COMPACT_AT_MIN = 4096;
/** The smallest reasoning cap accepted. */
export const REASONING_CUTOFF_MIN = 1000;

export interface ResolvedOcMode {
  /** Absent: no in-turn compaction. */
  compact_at?: number | "auto";
  compact_keep_turns: number;
  /** Absent: no reasoning cutoff. */
  max_reasoning_tokens?: number;
  hide_internal: boolean;
  grader_check: boolean;
}

function turnOf(config: GnomonConfig): Record<string, unknown> | undefined {
  return (config.config as { turn?: Record<string, unknown> } | undefined)?.turn;
}
function contextOf(config: GnomonConfig): Record<string, unknown> | undefined {
  return (config.config as { context?: Record<string, unknown> } | undefined)?.context;
}
function sandboxOf(config: GnomonConfig): Record<string, unknown> | undefined {
  return (config.policy as { sandbox?: Record<string, unknown> } | undefined)?.sandbox;
}
const posInt = (v: unknown, min: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= min ? v : undefined;

/** The four keys, resolved. A value the audit refuses resolves to off here. */
export function resolveOcMode(config: GnomonConfig): ResolvedOcMode {
  const c = contextOf(config);
  const t = turnOf(config);
  const at = c?.compact_at_tokens;
  const compact_at = at === "auto" ? "auto" : posInt(at, COMPACT_AT_MIN);
  const max = posInt(t?.max_reasoning_tokens_without_action, REASONING_CUTOFF_MIN);
  return {
    ...(compact_at !== undefined ? { compact_at } : {}),
    compact_keep_turns: posInt(c?.compact_keep_turns, 1) ?? COMPACT_KEEP_TURNS_DEFAULT,
    ...(max !== undefined ? { max_reasoning_tokens: max } : {}),
    hide_internal: sandboxOf(config)?.hide_internal === true,
    grader_check: t?.grader_check === true,
  };
}

/** Whether any of the four is on: the record and the counters exist only then. */
export function ocModeOn(m: ResolvedOcMode): boolean {
  return m.compact_at !== undefined || m.max_reasoning_tokens !== undefined || m.hide_internal || m.grader_check;
}

/** `session_start.resolved.oc_mode`: what is on, with the defaults filled in. Undefined when nothing is. */
export function ocModeRecord(config: GnomonConfig): Record<string, unknown> | undefined {
  const m = resolveOcMode(config);
  if (!ocModeOn(m)) return undefined;
  return {
    ...(m.compact_at !== undefined ? { compact_at_tokens: m.compact_at, compact_keep_turns: m.compact_keep_turns } : {}),
    ...(m.max_reasoning_tokens !== undefined ? { max_reasoning_tokens_without_action: m.max_reasoning_tokens } : {}),
    ...(m.hide_internal ? { hide_internal: true } : {}),
    ...(m.grader_check ? { grader_check: true } : {}),
  };
}

/** The token count at which the turn compacts, for a window. `"auto"` is opencode's ceiling. */
export function compactThreshold(at: number | "auto", windowTokens: number): number {
  if (at !== "auto") return at;
  return Math.max(COMPACT_AT_MIN, Math.floor(windowTokens - Math.max(COMPACT_RESERVE_SHARE * windowTokens, COMPACT_RESERVE_MIN)));
}

// ── 1. Compaction ─────────────────────────────────────────────────────────

/** The minimal message shape compaction reads (prompt_loop.ts ChatMessage). */
export interface CompactMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  tool_name?: string;
  reasoning_content?: string;
}

/**
 * Where to cut: the head (everything up to and including the first user message,
 * which is the instructions and the task), the middle that is summarised, and
 * the tail kept verbatim, which starts at the `keepTurns`-th assistant message
 * from the end so no tool result is separated from its call. Null when there is
 * nothing to summarise.
 */
export function splitForCompaction<M extends CompactMessage>(
  working: M[],
  keepTurns: number
): { head: M[]; middle: M[]; tail: M[] } | null {
  const firstUser = working.findIndex((m) => m.role === "user");
  if (firstUser === -1) return null;
  const head = working.slice(0, firstUser + 1);
  const rest = working.slice(firstUser + 1);
  const assistants: number[] = [];
  rest.forEach((m, i) => {
    if (m.role === "assistant") assistants.push(i);
  });
  if (assistants.length <= keepTurns) return null;
  const cut = assistants[assistants.length - keepTurns]!;
  const middle = rest.slice(0, cut);
  if (middle.length === 0) return null;
  return { head, middle, tail: rest.slice(cut) };
}

function clip(s: string, n: number = COMPACT_CLIP_CHARS): string {
  return s.length <= n ? s : `${s.slice(0, n)} [... ${s.length - n} chars clipped]`;
}

/** The middle as plain text for the summariser: one block per message, each clipped. */
export function transcriptOf(middle: CompactMessage[]): string {
  const out: string[] = [];
  for (const m of middle) {
    if (m.role === "assistant") {
      const calls = (m.tool_calls ?? [])
        .map((c) => {
          const f = (c as { function?: { name?: string; arguments?: unknown } }).function;
          const args = typeof f?.arguments === "string" ? f.arguments : JSON.stringify(f?.arguments ?? {});
          return `  call ${f?.name ?? "?"} ${clip(args)}`;
        })
        .join("\n");
      out.push(`[assistant] ${clip(m.content)}${calls ? `\n${calls}` : ""}`);
    } else if (m.role === "tool") {
      out.push(`[tool result${m.tool_name ? ` ${m.tool_name}` : ""}] ${clip(m.content)}`);
    } else {
      out.push(`[${m.role}] ${clip(m.content)}`);
    }
  }
  return out.join("\n\n");
}

/** What the summariser is asked for: opencode's template, cut to the five sections the task needs. */
export const COMPACTION_INSTRUCTION =
  "You are compacting the history of a coding task that is still in progress, so the work can continue " +
  "in a shorter context. Write a compact state of the work so far under exactly these headings:\n" +
  "## Task\nThe objective and every requirement still in force, in one short paragraph.\n" +
  "## Files changed\nEach path created or edited, and what it now does.\n" +
  "## Decisions\nChoices made and why, including approaches that failed and must not be retried.\n" +
  "## Open issues\nWhat is still wrong, unverified or not yet done, and the next step.\n" +
  "## Last test results\nThe last checks or tests run: the exact command, pass/fail, and the key error lines.\n" +
  "Preserve exact paths, commands, identifiers and error strings. Do not call tools. Do not add anything " +
  "that is not in the history.";

/** The request the summariser gets: no tools, the task for context, the transcript. */
export function compactionRequest(task: string, middle: CompactMessage[]): CompactMessage[] {
  return [
    { role: "system", content: COMPACTION_INSTRUCTION },
    {
      role: "user",
      content:
        `The task statement:\n${clip(task, 8000)}\n\n` +
        `The history to compact (each message clipped to ${COMPACT_CLIP_CHARS} characters):\n\n` +
        transcriptOf(middle) +
        `\n\nWrite the compact state now.`,
    },
  ];
}

/** The message that replaces the middle. Sent as a system message, as every mid-turn note is. */
export function compactionNote(summary: string, compactedSteps: number): string {
  return (
    `[gnomon compaction] The context reached its limit, so ${compactedSteps} earlier message(s) of this ` +
    `turn were replaced by this summary of the work so far. Continue the task from it; the most recent ` +
    `steps follow unchanged.\n\n${summary.trim()}`
  );
}

/** head + note + tail. The tail never starts with a tool result (some backends refuse one). */
export function applyCompaction<M extends CompactMessage>(
  split: { head: M[]; middle: M[]; tail: M[] },
  summary: string,
  make: (content: string) => M
): M[] {
  const tail = split.tail.slice();
  while (tail.length > 0 && tail[0]!.role === "tool") tail.shift();
  return [...split.head, make(compactionNote(summary, split.middle.length)), ...tail];
}

// ── 2. Reasoning cutoff ────────────────────────────────────────────────────

/** Tokens a reasoning text is counted as while streaming: ~4 characters each (estimateTokens). */
export function reasoningTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Whether a streamed reply has run away: reasoning past the cap, and no text or call yet. */
export function reasoningRunaway(reasoningChars: number, content: string, toolCalls: number, cap: number): boolean {
  return toolCalls === 0 && content.trim() === "" && reasoningTokens(reasoningChars) > cap;
}

/** The one note sent after a cutoff. */
export function reasoningCutoffNote(cap: number): string {
  return (
    `Your last reply reasoned for over ${cap} tokens without a tool call or any text, so it was stopped. ` +
    `Stop reasoning at length; write a script or run a command to get the answer.`
  );
}

// ── 3. Hide internal folders ─────────────────────────────────────────────

/** gnomon's own folders: `.gnomon`, and every `.gnomon-*` (audit, out, sessions, loops, jobs, shadow). */
export function isInternalName(name: string): boolean {
  return name === ".gnomon" || name.startsWith(".gnomon-");
}

/** Whether a root-relative POSIX path is inside one of them (any segment). */
export function isInternalRel(rel: string): boolean {
  return rel
    .split(/[\\/]+/)
    .filter((s) => s !== "" && s !== ".")
    .some(isInternalName);
}

/** What read, grep and glob answer when asked for one. */
export function hiddenRefusal(tool: string, path: string): string {
  return (
    `Refused: "${path}" is inside gnomon's own folders (.gnomon, .gnomon-*), which hold the harness's ` +
    `configuration and records, not the task. [sandbox] hide_internal = true keeps ${tool} out of them. ` +
    `Work on the task's own files.`
  );
}

/** The system-prompt block for hide_internal: the bash half, which cannot be enforced. */
export const HIDE_INTERNAL_BLOCK =
  "## Harness folders\n\n" +
  "- `.gnomon/`, `.gnomon-audit/`, `.gnomon-out/` and any other `.gnomon-*` folder belong to the harness, " +
  "not the task. Do not read, list or search them: with bash, exclude them " +
  "(`grep -r --exclude-dir='.gnomon*'`, `find . -path './.gnomon*' -prune -o ...`, `ls` without `-a`).";

// ── 4. Check like the grader ─────────────────────────────────────────────

export const GRADER_CHECK_BLOCK =
  "## Check like the grader\n\n" +
  "- Test the way a hidden grader will: through the task's public entry points, commands or the tools " +
  "the task provides, never through private names (`_x`), internal hooks or monkeypatching.\n" +
  "- When your own test fails, assume the code is wrong. Never edit a test's assertions to match what " +
  "the code produces.\n" +
  "- Before answering with time left, run at least one varied-input check against the public interface: " +
  "shuffled or duplicated inputs, batched versus one at a time, repeated ids, or concurrent calls. If it " +
  "fails, keep working.";

/** The blocks appended to the system prompt, in order; "" when neither is on. */
export function ocModePromptBlocks(m: ResolvedOcMode): string {
  return (m.hide_internal ? `\n\n${HIDE_INTERNAL_BLOCK}` : "") + (m.grader_check ? `\n\n${GRADER_CHECK_BLOCK}` : "");
}

// ── Audit ────────────────────────────────────────────────────────────────

type Problem = { where: string; problem: string; fix: string; fatal: boolean };

/**
 * A declared value outside its range is fatal: a surface that seems to ask for
 * a mechanism must not run without it. `compact_keep_turns` without
 * `compact_at_tokens` is a warning (it is not read).
 */
export function auditOcMode(config: GnomonConfig): Problem[] {
  const out: Problem[] = [];
  const c = contextOf(config);
  const t = turnOf(config);
  const s = sandboxOf(config);
  const at = c?.compact_at_tokens;
  if (at !== undefined && at !== "auto" && posInt(at, COMPACT_AT_MIN) === undefined) {
    out.push({
      where: ".gnomon/config.toml [context] compact_at_tokens",
      problem: `compact_at_tokens = ${JSON.stringify(at)} is not "auto" or an integer of at least ${COMPACT_AT_MIN}.`,
      fix: 'compact_at_tokens = 170000 (opencode\'s effective point), or "auto" (window - max(15%, 16k))',
      fatal: true,
    });
  }
  const k = c?.compact_keep_turns;
  if (k !== undefined && posInt(k, 1) === undefined) {
    out.push({
      where: ".gnomon/config.toml [context] compact_keep_turns",
      problem: `compact_keep_turns = ${JSON.stringify(k)} is not a positive integer.`,
      fix: `compact_keep_turns = ${COMPACT_KEEP_TURNS_DEFAULT} (the default)`,
      fatal: true,
    });
  } else if (k !== undefined && at === undefined) {
    out.push({
      where: ".gnomon/config.toml [context] compact_keep_turns",
      problem: "compact_keep_turns is not read without compact_at_tokens.",
      fix: "Declare compact_at_tokens, or remove compact_keep_turns.",
      fatal: false,
    });
  }
  const r = t?.max_reasoning_tokens_without_action;
  if (r !== undefined && posInt(r, REASONING_CUTOFF_MIN) === undefined) {
    out.push({
      where: ".gnomon/config.toml [turn] max_reasoning_tokens_without_action",
      problem: `max_reasoning_tokens_without_action = ${JSON.stringify(r)} is not an integer of at least ${REASONING_CUTOFF_MIN}.`,
      fix: "max_reasoning_tokens_without_action = 12000",
      fatal: true,
    });
  }
  for (const [where, v] of [
    [".gnomon/policy.toml [sandbox] hide_internal", s?.hide_internal],
    [".gnomon/config.toml [turn] grader_check", t?.grader_check],
  ] as const) {
    if (v !== undefined && typeof v !== "boolean") {
      out.push({ where, problem: `${JSON.stringify(v)} is not a boolean.`, fix: "true (or false, the default)", fatal: true });
    }
  }
  return out;
}

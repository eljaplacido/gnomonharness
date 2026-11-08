/**
 * The completion gate: `[verify] completion_gate` in policy.toml.
 *
 * Opt-in. Absent (or "off"), nothing here runs and the loop sends the model
 * exactly the requests it sent before this file existed.
 *
 * Why it exists. P2G41 (2026-11, hosted recipe): in 16 cells gnomon declared
 * done with a median of 996 s left and was wrong, 5 of them near misses (at
 * least 75% of the hidden tests passing). A prompt rule asking the model to
 * "verify every stated requirement" moved nothing (H2). What the published
 * harnesses that close "almost right" have in common is enforcement rather
 * than instruction: a finish hook, a structured checklist, a read-only
 * auditor. This is that, as harness control:
 *
 * - **checklist** — the first time the model ends a turn that changed the
 *   worktree, with budget left, the answer is not accepted. The harness hands
 *   back a checklist built from the task's own text (requirements, paths,
 *   commands, values, formats, edge cases, stray files) and accepts the next
 *   end only once at least one bash command has run since.
 * - **review** — the checklist, and then a fresh-context, read-only sub-turn
 *   (the reviewer role) that is given the task text and the workspace, never
 *   the transcript, and asked to break the solution. Its findings go back to
 *   the main turn, which must address them or say why they do not apply.
 *
 * Bounded: at most `completion_rounds` hand-backs per turn, and skipped when
 * less than `completion_min_remaining` of the turn's budget is left (the step
 * wall, and a run deadline when the caller passes one). Every round is
 * recorded: `counters.completion_gate` and audit kind `completion_gate`
 * (docs/CONTRACTS.md §30, conformance/completion_gate.json).
 *
 * Everything here is pure: the loop owns the model calls, the tools and the
 * clock, and asks this module only what to do next and what to say.
 */
import type { GnomonConfig } from "./config.js";

export const COMPLETION_GATE_MODES = ["off", "checklist", "review", "review_only"] as const;
export type CompletionGateMode = (typeof COMPLETION_GATE_MODES)[number];

/**
 * Whether a mode runs the reviewer. `review_only` is `review` without the
 * checklist round: the first answer goes straight to the reviewer. It exists
 * so the reviewer can be measured on its own -- `review` is two mechanisms,
 * and the checklist alone screened futile (AS1, 2026-11).
 */
export function isReviewMode(mode: CompletionGateMode): boolean {
  return mode === "review" || mode === "review_only";
}

/** What the gate did at one end of the turn. */
export const COMPLETION_GATE_ACTIONS = ["checklist", "no_check", "review", "accept"] as const;
export type CompletionGateAction = (typeof COMPLETION_GATE_ACTIONS)[number];

/**
 * How the gate left the turn.
 *
 * - `passed`: every condition the mode sets was met when the answer was accepted.
 * - `exhausted`: the rounds ran out with a condition still unmet.
 * - `skipped_budget`: less than `min_remaining` of the budget was left.
 * - `not_applicable`: the turn answered without changing the worktree.
 * - `not_reached`: the turn ended some other way (step wall, stall, error).
 */
export const COMPLETION_GATE_OUTCOMES = [
  "passed",
  "exhausted",
  "skipped_budget",
  "not_applicable",
  "not_reached",
] as const;
export type CompletionGateOutcome = (typeof COMPLETION_GATE_OUTCOMES)[number];

/** The `[verify]` keys this module reads, with their defaults. */
export const COMPLETION_GATE_DEFAULTS = {
  completion_gate: "off" as CompletionGateMode,
  /** Checklist, a hand-back for a missing check, and one review. */
  completion_rounds: 3,
  /** Skip the gate when less than a fifth of the budget is left. */
  completion_min_remaining: 0.2,
  completion_reviewer: "verifier",
};
export const COMPLETION_GATE_KEYS = Object.keys(COMPLETION_GATE_DEFAULTS);

/**
 * Tools a reviewer may be offered, whatever its role declares. `bash` only
 * when the role also declares a non-empty `bash_allow`: bash with no
 * allow-list can write anything, so a reviewer holding it is not read-only.
 * `note` is absent on purpose: a run note reaches the main turn's later
 * prompts, which is a channel from the reviewer around its findings.
 */
export const REVIEWER_TOOLS = ["read", "glob", "grep", "compute", "todo", "bash"] as const;

export interface ResolvedCompletionGate {
  mode: CompletionGateMode;
  max_rounds: number;
  min_remaining: number;
  reviewer: string;
}

/** Read `[verify] completion_*` from policy.toml. Anything unreadable is the default. */
export function resolveCompletionGate(config: GnomonConfig): ResolvedCompletionGate {
  const v = (config.policy as { verify?: Record<string, unknown> } | undefined)?.verify ?? {};
  const raw = v.completion_gate;
  const mode: CompletionGateMode =
    raw === "checklist" || raw === "review" || raw === "review_only" ? raw : "off";
  const rounds =
    typeof v.completion_rounds === "number" && Number.isFinite(v.completion_rounds)
      ? Math.max(0, Math.floor(v.completion_rounds))
      : COMPLETION_GATE_DEFAULTS.completion_rounds;
  const minRaw = v.completion_min_remaining;
  const min_remaining =
    typeof minRaw === "number" && Number.isFinite(minRaw)
      ? Math.min(1, Math.max(0, minRaw))
      : COMPLETION_GATE_DEFAULTS.completion_min_remaining;
  const reviewer =
    typeof v.completion_reviewer === "string" && v.completion_reviewer.trim()
      ? v.completion_reviewer.trim()
      : COMPLETION_GATE_DEFAULTS.completion_reviewer;
  return { mode, max_rounds: rounds, min_remaining, reviewer };
}

/** A surface finding, in auditSurface's shape. */
export interface CompletionGateProblem {
  where: string;
  problem: string;
  fix: string;
  fatal: boolean;
}

/**
 * What is wrong with a declared gate. Called by auditSurface.
 *
 * Only a reviewer that does not exist is fatal: the surface asks for a review
 * that cannot run. A reviewer role that declares write-capable tools is not
 * fatal because the loop withholds them anyway (reviewerToolNames), but the
 * surface reads as if the reviewer could write, so it is said.
 */
export function auditCompletionGate(config: GnomonConfig): CompletionGateProblem[] {
  const v = (config.policy as { verify?: Record<string, unknown> } | undefined)?.verify;
  if (!v) return [];
  const where = ".gnomon/policy.toml [verify]";
  const out: CompletionGateProblem[] = [];
  const g = resolveCompletionGate(config);
  if (
    v.completion_min_remaining !== undefined &&
    (typeof v.completion_min_remaining !== "number" ||
      v.completion_min_remaining < 0 ||
      v.completion_min_remaining > 1)
  ) {
    out.push({
      where: `${where} completion_min_remaining`,
      problem: `completion_min_remaining is a fraction of the budget, 0 to 1; got ${JSON.stringify(v.completion_min_remaining)}, read as ${g.min_remaining}.`,
      fix: "completion_min_remaining = 0.2",
      fatal: false,
    });
  }
  if (
    v.completion_rounds !== undefined &&
    (typeof v.completion_rounds !== "number" || v.completion_rounds < 0)
  ) {
    out.push({
      where: `${where} completion_rounds`,
      problem: `completion_rounds is a count of hand-backs; got ${JSON.stringify(v.completion_rounds)}, read as ${g.max_rounds}.`,
      fix: "completion_rounds = 3",
      fatal: false,
    });
  }
  if (!isReviewMode(g.mode)) return out;
  const role = config.roles?.[g.reviewer];
  if (!role) {
    out.push({
      where: `${where} completion_reviewer`,
      problem: `completion_gate = "${g.mode}" names reviewer "${g.reviewer}", which is not a role in this surface, so no review can run.`,
      fix: `Declared roles: ${Object.keys(config.roles ?? {}).sort().join(", ")}. Set completion_reviewer to a read-only one.`,
      fatal: true,
    });
    return out;
  }
  const declared = Array.isArray(role.tools) ? role.tools : null;
  const withheld = declared
    ? declared.filter((t) => !(REVIEWER_TOOLS as readonly string[]).includes(t))
    : ["(every declared tool: the role has no tools list)"];
  const bashAllow = Array.isArray(role.bash_allow) && role.bash_allow.length > 0;
  if (declared?.includes("bash") && !bashAllow) withheld.push("bash (no bash_allow)");
  if (withheld.length > 0) {
    out.push({
      where: `.gnomon/roles.toml [roles.${g.reviewer}]`,
      problem:
        `the completion reviewer is run read-only, so ${withheld.join(", ")} ` +
        `${withheld.length === 1 ? "is" : "are"} withheld from it during a review.`,
      fix:
        `Give the reviewer role only ${REVIEWER_TOOLS.join(", ")}, and a bash_allow ` +
        `that cannot modify, so the surface says what the review can do.`,
      fatal: false,
    });
  }
  return out;
}

/**
 * The tools a reviewer sub-turn is offered: its role's tools, minus anything
 * that can change the worktree. Enforced by the loop, not by the prompt.
 */
export function reviewerToolNames(
  roleTools: readonly string[],
  bashAllow: readonly string[] | undefined
): string[] {
  const hasAllow = Array.isArray(bashAllow) && bashAllow.length > 0;
  return roleTools.filter(
    (t) => (REVIEWER_TOOLS as readonly string[]).includes(t) && (t !== "bash" || hasAllow)
  );
}

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

export interface CompletionChecklist {
  requirements: string[];
  paths: string[];
  commands: string[];
  names: string[];
  values: string[];
  formats: string[];
}

const MAX_REQUIREMENTS = 25;
const MAX_ITEM = 240;
const MAX_LIST = 20;

const REQUIREMENT_WORDS =
  /\b(must|should|shall|needs? to|required?|requires|ensure|make sure|do not|don't|never|only|exactly|at least|at most|no more than|always|without|create|write|save|store|output|return|print|produce|implement|add|fix|support|handle|use|keep|remove|place|put|generate|accept|reject|run|pass)\b/i;
const FORMAT_WORDS =
  /\b(JSONL|JSON|CSV|TSV|YAML|TOML|XML|Markdown|HTML|base64|hex|UTF-8|ISO[ -]8601|RFC ?\d{3,4}|SQL|regex|newline-terminated|tab-separated|comma-separated|sorted|ascending|descending)\b/gi;
const PATH_RE =
  /(?:^|[\s("'=:,])((?:~|\.{1,2})?\/[\w.@+\-]+(?:\/[\w.@+\-]*)*|[\w.@+\-]+\/[\w.@+\-]+(?:\/[\w.@+\-]*)*|[\w@+\-]+\.(?:py|js|mjs|cjs|ts|tsx|json|jsonl|csv|tsv|txt|md|toml|yaml|yml|sh|bash|c|h|cc|cpp|hpp|rs|go|java|kt|rb|php|html|css|sql|log|xml|ini|cfg|conf|db|sqlite|parquet|pkl|npy|png|jpg|jpeg|gif|svg|pdf|lock|env|wasm|so|bin|out|dat))(?=$|[\s)"',;:!?]|\.(?:\s|$))/gm;
const NUMBER_RE =
  /(?<![\w.\/\-])-?\d+(?:[.,]\d+)?(?:\s?(?:%|ms|s|sec|secs|seconds|minutes|min|hours|h|MB|KB|GB|MiB|KiB|GiB|bytes|px|x|°C?|digits|decimal places|lines|rows|columns|items|characters|chars|threads|workers|times|retries))?(?![\w\/])/g;
const COMMAND_START =
  /^(\$\s*)?(python3?|pytest|node|npm|pnpm|yarn|npx|cargo|go|make|bash|sh|curl|wget|git|docker|java|javac|gcc|g\+\+|clang|rustc|ruby|perl|psql|sqlite3|redis-cli|ls|cat|grep|sed|awk|jq|uv|pip3?|poetry|tsc|deno|bun|cmake|ctest|mvn|gradle|dotnet|php|R|Rscript|julia|lua)\b/;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_ITEM ? t.slice(0, MAX_ITEM - 1) + "…" : t;
}

function pushUnique(list: string[], item: string, cap: number): void {
  if (!item || list.length >= cap || list.includes(item)) return;
  list.push(item);
}

function looksLikePath(s: string): boolean {
  if (/^[a-z]+:\/\//i.test(s) || /\s/.test(s)) return false;
  PATH_RE.lastIndex = 0;
  const m = PATH_RE.exec(" " + s);
  return m !== null && m[1] === s;
}

/**
 * Build the checklist from the task's own text. Deterministic: the same text
 * gives the same checklist, so the request it goes into is reproducible.
 *
 * It does not understand the task. It lifts out what the task states -- the
 * sentences and list items that ask for something, and every path, command,
 * name, number and format they mention -- so the model checks its work
 * against the words it was given rather than against its memory of them.
 */
export function buildChecklist(task: string): CompletionChecklist {
  const out: CompletionChecklist = {
    requirements: [],
    paths: [],
    commands: [],
    names: [],
    values: [],
    formats: [],
  };
  const text = task.replace(/\r\n?/g, "\n");

  // Fenced code first, so its contents are not split into "sentences".
  const prose = text.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const shell = /^(bash|sh|shell|console|zsh)$/i.test(lang);
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (shell || line.startsWith("$ ") || COMMAND_START.test(line)) {
        pushUnique(out.commands, clip(line.replace(/^\$\s*/, "")), MAX_LIST);
      }
    }
    return "\n";
  });

  // Inline code: a path, a command, or a name the task fixes.
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    const code = m[1].trim();
    if (!code) continue;
    if (looksLikePath(code)) pushUnique(out.paths, code, MAX_LIST);
    else if (/\s/.test(code) || COMMAND_START.test(code)) pushUnique(out.commands, clip(code), MAX_LIST);
    else pushUnique(out.names, code, MAX_LIST);
  }

  // Requirements: every list item, and every prose sentence that asks for
  // something. A task's own sentences are the best statement of it there is.
  const lines = prose.split("\n");
  let para: string[] = [];
  const flush = () => {
    const block = para.join(" ").trim();
    para = [];
    if (!block) return;
    for (const s of block.split(/(?<=[.!?])\s+(?=[A-Z0-9`"'(\/~])/)) {
      if (REQUIREMENT_WORDS.test(s)) pushUnique(out.requirements, clip(s), MAX_REQUIREMENTS);
    }
  };
  for (const raw of lines) {
    const bullet = /^\s*(?:[-*•+]|\d{1,3}[.)])\s+(.*)$/.exec(raw);
    if (bullet) {
      flush();
      pushUnique(out.requirements, clip(bullet[1]), MAX_REQUIREMENTS);
    } else if (!raw.trim() || /^\s*#{1,6}\s/.test(raw)) {
      flush();
    } else {
      para.push(raw.trim());
    }
  }
  flush();

  // Paths, values and formats anywhere in the prose (inline code included:
  // `/app/out.txt` is a path whichever way it was written).
  const flat = prose.replace(/^\s*(?:[-*•+]|\d{1,3}[.)])\s+/gm, "").replace(/`/g, " ");
  PATH_RE.lastIndex = 0;
  for (const m of flat.matchAll(PATH_RE)) {
    // A sentence's full stop is not part of the path it ends on.
    const p = m[1].replace(/[.,;:!?]+$/, "");
    if (!p || /^[a-z]+:\/\//i.test(p) || /^\d+(\/\d+)+$/.test(p)) continue;
    pushUnique(out.paths, p, MAX_LIST);
  }
  const noPaths = flat.replace(PATH_RE, " ").replace(/[a-z]+:\/\/\S+/gi, " ");
  for (const m of noPaths.matchAll(NUMBER_RE)) pushUnique(out.values, m[0].trim(), MAX_LIST);
  for (const m of flat.matchAll(FORMAT_WORDS)) {
    const f = m[0];
    if (!out.formats.some((x) => x.toLowerCase() === f.toLowerCase())) pushUnique(out.formats, f, MAX_LIST);
  }
  return out;
}

const fmtList = (items: string[]) => items.map((i) => `\`${i}\``).join(", ");

/**
 * The hand-back for the first end: the checklist, and the check requirement.
 * `changed` is what git says this turn created or changed, when it can say.
 */
export function renderChecklist(
  cl: CompletionChecklist,
  opts: { round: number; maxRounds: number; canCheck: boolean; changed: string[] | null }
): string {
  const parts: string[] = [];
  parts.push(
    `Completion gate (round ${opts.round} of ${opts.maxRounds}): your answer is not accepted yet. ` +
      `This is the harness, not a reviewer's opinion: every turn that changes files is checked ` +
      `against the task's own words before it may end.`
  );
  const from: string[] = [];
  if (cl.requirements.length > 0) {
    from.push("Stated requirements:\n" + cl.requirements.map((r, i) => `  ${i + 1}. ${r}`).join("\n"));
  }
  if (cl.paths.length > 0) from.push(`Files and paths named: ${fmtList(cl.paths)}`);
  if (cl.commands.length > 0) from.push(`Commands named: ${fmtList(cl.commands)}`);
  if (cl.names.length > 0) from.push(`Names and literals named: ${fmtList(cl.names)}`);
  if (cl.values.length > 0) from.push(`Values named: ${cl.values.join(", ")}`);
  if (cl.formats.length > 0) from.push(`Formats named: ${cl.formats.join(", ")}`);
  if (from.length > 0) parts.push("From the task:\n" + from.join("\n"));
  const also = [
    "every path above exists where the task says, with the exact name, format and content it asks for;",
    "every number above is honoured exactly (counts, limits, precision, units);",
    "edge cases the task implies: empty or malformed input, boundaries, large input, repeated and concurrent runs, error paths;",
  ];
  if (opts.changed && opts.changed.length > 0) {
    const shown = opts.changed.slice(0, 30);
    const more = opts.changed.length > shown.length ? `, +${opts.changed.length - shown.length} more` : "";
    also.push(
      `no stray files: this turn created or changed ${fmtList(shown)}${more}. ` +
        `Remove any the task did not ask for (scratch scripts, backups, logs, build output).`
    );
  } else {
    also.push("no stray files: remove scratch scripts, backups, logs and build output the task did not ask for.");
  }
  parts.push("Also check:\n" + also.map((a) => `  - ${a}`).join("\n"));
  parts.push(
    opts.canCheck
      ? `Run at least one command that exercises the result -- the task's own command, a test, or a ` +
          `script that checks the output against the items above -- before you answer again. An answer ` +
          `with no command run after this message is not accepted. Fix what fails. Then answer, saying ` +
          `for each item how you checked it.`
      : `Re-read the result against each item above and fix what does not match. Then answer, saying ` +
          `for each item how you checked it.`
  );
  return parts.join("\n\n");
}

/** The hand-back for an end with no check run since the last one. */
export function renderNoCheck(opts: { round: number; maxRounds: number }): string {
  return (
    `Completion gate (round ${opts.round} of ${opts.maxRounds}): no command has run since the checklist, ` +
    `so the answer is still not accepted. Run at least one command that exercises the result against ` +
    `the task (its own command, a test, or a script that checks the output), fix what fails, then answer.`
  );
}

// ---------------------------------------------------------------------------
// The reviewer
// ---------------------------------------------------------------------------

/** The sentinel a reviewer writes when it found nothing. */
export const NO_FINDINGS = "NO FINDINGS";
const MAX_FINDINGS = 10;
const MAX_FINDING = 400;

/**
 * The reviewer's instruction: the task and where the work is. Never the
 * transcript or the main turn's answer -- a reviewer that reads the claim is
 * anchored on it, and fresh context is the point.
 */
export function reviewerInstruction(task: string, root: string, changed: string[] | null): string {
  const files =
    changed && changed.length > 0
      ? `Files the work created or changed (per git): ${fmtList(changed.slice(0, 40))}` +
        (changed.length > 40 ? `, +${changed.length - 40} more` : "") + "."
      : "Which files changed is not known; look at the workspace.";
  return [
    `You are reviewing finished work. You cannot change anything: your job is to find where it is wrong.`,
    `The task it was meant to do, verbatim:\n\n<task>\n${task}\n</task>`,
    `The work is in ${root}. ${files}`,
    `Try to break it. Check each stated requirement, path, format, value and command against what is ` +
      `actually on disk. Run what the task says to run, and probe the edge cases it implies (empty and ` +
      `malformed input, boundaries, repeated and concurrent runs, error paths). Look for stray files.`,
    `Answer with a list, one finding per line starting with "- ": what is wrong, where, and the ` +
      `evidence (the command and what it printed). Only concrete defects you observed, not style. ` +
      `If you found none, answer exactly ${NO_FINDINGS}.`,
  ].join("\n\n");
}

/** Findings out of a reviewer's answer. Empty when it said NO FINDINGS. */
export function parseFindings(answer: string): string[] {
  const text = answer.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!text) return [];
  const items: string[] = [];
  for (const raw of text.split("\n")) {
    const m = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    const item = m[1].replace(/\s+/g, " ");
    if (new RegExp(`^${NO_FINDINGS}\\b`, "i").test(item)) continue;
    pushUnique(
      items,
      item.length > MAX_FINDING ? item.slice(0, MAX_FINDING - 1) + "…" : item,
      MAX_FINDINGS
    );
  }
  if (items.length > 0) return items;
  if (new RegExp(`\\b${NO_FINDINGS}\\b`, "i").test(text)) return [];
  // Prose with no list: one finding, so a reviewer that ignored the format is
  // still heard rather than read as clean.
  const one = text.replace(/\s+/g, " ");
  return [one.length > MAX_FINDING ? one.slice(0, MAX_FINDING - 1) + "…" : one];
}

/** The hand-back carrying a review's findings. */
export function renderFindings(findings: string[], opts: { round: number; maxRounds: number }): string {
  return (
    `Completion gate (round ${opts.round} of ${opts.maxRounds}): an independent read-only reviewer ` +
    `checked the workspace against the task and reports:\n\n` +
    findings.map((f, i) => `  ${i + 1}. ${f}`).join("\n") +
    `\n\nAddress each one: fix it, or say concretely why it does not apply. Then answer.`
  );
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface CompletionGateState {
  /** Hand-backs so far this turn. */
  rounds: number;
  /** Whether the last hand-back asked for a check command. */
  checkRequired: boolean;
  /** Bash commands that ran since the last hand-back. */
  checksSince: number;
  /** Whether the reviewer has run this turn. */
  reviewed: boolean;
}

export type CompletionGateStep =
  | { act: "accept"; outcome: "passed" | "exhausted" | "skipped_budget" }
  | { act: "checklist" | "no_check" | "review" };

/**
 * What to do with an end the gate applies to. `budgetLeft` is the smaller of
 * the step and time fractions still left (budgetLeft below); `canCheck` is
 * whether the role holds bash, without which no check can be demanded.
 */
export function nextGateStep(
  g: ResolvedCompletionGate,
  s: CompletionGateState,
  opts: { budgetLeft: number; canCheck: boolean }
): CompletionGateStep {
  // `review_only` has no checklist round, so round 0 is not a condition of its own.
  const checklistDue = s.rounds === 0 && g.mode !== "review_only";
  const unmet =
    checklistDue ||
    (s.checkRequired && opts.canCheck && s.checksSince === 0) ||
    (isReviewMode(g.mode) && !s.reviewed);
  if (s.rounds >= g.max_rounds) return { act: "accept", outcome: unmet ? "exhausted" : "passed" };
  if (unmet && opts.budgetLeft < g.min_remaining) return { act: "accept", outcome: "skipped_budget" };
  if (checklistDue) return { act: "checklist" };
  if (s.checkRequired && opts.canCheck && s.checksSince === 0) return { act: "no_check" };
  if (isReviewMode(g.mode) && !s.reviewed) return { act: "review" };
  return { act: "accept", outcome: "passed" };
}

/**
 * The smaller of the two budgets still left, as a fraction: steps against the
 * role's wall, and time against a run deadline when the caller passed one
 * (`TurnDeps.deadline`, the shape `gnomon task --deadline` hands the loop).
 */
export function budgetLeft(opts: {
  steps: number;
  maxTotal: number;
  deadline?: { total_ms: number; started_at: number };
  now: number;
}): { fraction: number; by: "steps" | "deadline" } {
  const stepFrac =
    opts.maxTotal > 0 && Number.isFinite(opts.maxTotal)
      ? Math.max(0, (opts.maxTotal - opts.steps) / opts.maxTotal)
      : 1;
  if (opts.deadline && opts.deadline.total_ms > 0) {
    const timeFrac = Math.max(0, 1 - (opts.now - opts.deadline.started_at) / opts.deadline.total_ms);
    if (timeFrac < stepFrac) return { fraction: timeFrac, by: "deadline" };
  }
  return { fraction: stepFrac, by: "steps" };
}

/** `counters.completion_gate`: present only when a gate is declared. */
export interface CompletionGateCounters {
  v: 1;
  mode: Exclude<CompletionGateMode, "off">;
  max_rounds: number;
  /** Hand-backs. */
  rounds: number;
  /** Bash commands run after a hand-back. */
  checks: number;
  /** Reviewer sub-turns run, and the tool steps they took. */
  reviews: number;
  review_steps: number;
  /** Findings the reviewers returned. */
  findings: number;
  /** Reviews whose findings could not be used (the reviewer's turn failed,
   * or the worktree moved while it ran). Absent when none. */
  review_failures?: number;
  outcome: CompletionGateOutcome;
  /** Wall-clock spent in the gate, reviewer included. Volatile: on the task
   * record it is absent here and is `volatile.completion_gate_ms`. */
  ms?: number;
}

/** The task text a turn was given: its last user message, as text. */
export function taskTextOf(messages: ReadonlyArray<{ role: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return withoutChainCarry(m.content);
    if (Array.isArray(m.content)) {
      return withoutChainCarry(
        m.content
          .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
          .filter(Boolean)
          .join("\n")
      );
    }
    return "";
  }
  return "";
}

/**
 * Where a `[chain]` stage's input stops being the request and starts being
 * the previous stage's report. One constant, used where the stage input is
 * built (prompt_loop.ts) and here.
 */
export const CHAIN_CARRY = "\n\n---\nThe previous stage (";

/** The chain stage input as stage `i` builds it: the request, then the carry. */
export function chainStageInput(input: string, previousRole: string, carried: string): string {
  return `${input}${CHAIN_CARRY}${previousRole}) reported:\n${carried}`;
}

/**
 * The request alone. In stage 2 of a chain the last user message is the
 * request plus the previous stage's report; a reviewer handed that as "the
 * task, verbatim" would be anchored on the reading it is meant to check.
 */
export function withoutChainCarry(text: string): string {
  const at = text.indexOf(CHAIN_CARRY);
  return at < 0 ? text : text.slice(0, at);
}

/**
 * Paths whose numstat changed between two tree snapshots (prompt_loop.ts
 * TreeState): what this turn created or changed, as git sees it. Null when
 * either snapshot is unavailable -- not a repository, or git failed.
 */
export function changedPaths(
  before: { tracked: Map<string, unknown>; untracked: Map<string, unknown> } | null,
  after: { tracked: Map<string, unknown>; untracked: Map<string, unknown> } | null
): string[] | null {
  if (!before || !after) return null;
  const out = new Set<string>();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const [p, v] of after.tracked) if (!before.tracked.has(p) || !same(before.tracked.get(p), v)) out.add(p);
  for (const p of before.tracked.keys()) if (!after.tracked.has(p)) out.add(p);
  for (const [p, v] of after.untracked) if (!before.untracked.has(p) || !same(before.untracked.get(p), v)) out.add(p);
  for (const p of before.untracked.keys()) if (!after.untracked.has(p)) out.add(p);
  return [...out].sort();
}

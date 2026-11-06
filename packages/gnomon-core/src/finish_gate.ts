/**
 * The finish gate: `[verify] finish_gate` in policy.toml.
 *
 * Opt-in. Absent (or "off"), nothing here runs and the loop sends the model
 * exactly the requests it sent before this file existed.
 *
 * Why it exists. The 2026-11-06 near-miss analysis of P2G41 and H3 (35 cells
 * with at least 60% of the hidden tests passing and reward 0) found two
 * classes a harness can reach:
 *
 * - FLAG (6 cells): the final answer itself named the defect the hidden test
 *   checks ("One judgement call worth flagging … I kept it in the catalogue",
 *   "the plan reports `route_feasible: false`", "the plan necessarily carries
 *   lateness") and the turn ended anyway.
 * - BLIND (5 cells): the model's own checks passed and never exercised the
 *   property the hidden test checks (ordering under a blocked predecessor,
 *   a client-imported private module).
 *
 * The completion gate's checklist (§30) re-lists the task but never reads the
 * answer, and it is blind to the clock. This gate:
 *
 * 1. quotes the task back verbatim (Terminus-KIRA's completion check);
 * 2. lists the turn's open todos (ForgeCode's pending-todos hook);
 * 3. runs a **caveat audit**: a deterministic scan of the answer for the
 *    deviations it admits, each quoted back with a demand for the strict
 *    reading (the FLAG class);
 * 4. asks targeted questions in Codex's goal-continuation wording: outputs
 *    exist, requirement-to-evidence mapping, tests are evidence only once they
 *    are known to cover the requirement, no narrower substitute, no stray
 *    files (the BLIND class). A generic "verify" instruction measured worse
 *    than none in a third-party TB2 ablation; a targeted assumption check
 *    measured better.
 *
 * It accepts the next answer once at least one tool call has run since it
 * fired, hands back at most FINISH_GATE_ROUNDS times a turn, and never fires
 * with less than FINISH_GATE_MIN_REMAINING of the step budget or of the run
 * deadline left. Every judged end is recorded (counters.finish_gate, audit
 * kind finish_gate; docs/CONTRACTS.md §33, conformance/finish_gate.json).
 *
 * Pure: the loop owns the model calls, the tools and the clock.
 */
import type { GnomonConfig } from "./config.js";
import { COMPLETION_GATE_DEFAULTS } from "./completion_gate.js";
import { resolveTodoGate } from "./sweep_knobs.js";

export const FINISH_GATE_MODES = ["off", "v2"] as const;
export type FinishGateMode = (typeof FINISH_GATE_MODES)[number];

/**
 * What the gate did at one end of a turn.
 * - `fire`: the full hand-back (task, todos, caveat audit, targeted checks).
 * - `no_tool`: the answer came with no tool call since the last hand-back.
 * - `accept`: the answer stands; the record says why (`outcome`).
 */
export const FINISH_GATE_ACTIONS = ["fire", "no_tool", "accept"] as const;
export type FinishGateAction = (typeof FINISH_GATE_ACTIONS)[number];

/**
 * How the gate left the turn.
 * - `passed`: accepted after at least one tool call since the hand-back.
 * - `exhausted`: the rounds ran out with no tool call since the last one.
 * - `skipped_budget`: less than FINISH_GATE_MIN_REMAINING of the budget left.
 * - `not_applicable`: the turn answered without changing the worktree.
 * - `not_reached`: the turn ended some other way (step wall, stall, error).
 */
export const FINISH_GATE_OUTCOMES = [
  "passed",
  "exhausted",
  "skipped_budget",
  "not_applicable",
  "not_reached",
] as const;
export type FinishGateOutcome = (typeof FINISH_GATE_OUTCOMES)[number];

/** Hand-backs per turn, at most. Fixed: one knob, one arm. */
export const FINISH_GATE_ROUNDS = 2;
/** Never fire with less than this fraction of the steps or the deadline left. */
export const FINISH_GATE_MIN_REMAINING = 0.15;
/** The task is quoted verbatim up to this many characters. */
export const FINISH_GATE_TASK_CHARS = 16_000;

export const FINISH_GATE_DEFAULTS = { finish_gate: "off" as FinishGateMode };

/** Read `[verify] finish_gate`. Anything but "v2" is "off". */
export function resolveFinishGate(config: GnomonConfig): FinishGateMode {
  const v = (config.policy as { verify?: Record<string, unknown> } | undefined)?.verify;
  return v?.finish_gate === "v2" ? "v2" : "off";
}

/**
 * What is wrong with a declared finish gate, in auditSurface's shape. Not
 * fatal: the finish gate supersedes the completion gate and the todo gate
 * (its hand-back carries the task, the checks and the open todos), so with
 * it declared they do not run, and the surface says so rather than leave
 * their keys reading as active.
 */
export function auditFinishGate(
  config: GnomonConfig
): Array<{ where: string; problem: string; fix: string; fatal: boolean }> {
  const v = (config.policy as { verify?: Record<string, unknown> } | undefined)?.verify;
  if (!v || resolveFinishGate(config) !== "v2") return [];
  const out: Array<{ where: string; problem: string; fix: string; fatal: boolean }> = [];
  if (resolveTodoGate(config)) {
    out.push({
      where: ".gnomon/config.toml [turn] todo_gate",
      problem:
        `finish_gate = "v2" and todo_gate = true are both declared; the finish gate lists the ` +
        `turn's open todos in its own hand-back and supersedes the todo gate, so todo_gate does not run.`,
      fix: `Remove todo_gate, or set finish_gate = "off".`,
      fatal: false,
    });
  }
  const cg = v.completion_gate;
  if (cg === undefined || cg === COMPLETION_GATE_DEFAULTS.completion_gate) return out;
  return [
    ...out,
    {
      where: ".gnomon/policy.toml [verify] completion_gate",
      problem:
        `finish_gate = "v2" and completion_gate = ${JSON.stringify(cg)} are both declared; ` +
        `the finish gate replaces the completion gate, so completion_gate does not run.`,
      fix: `Remove completion_gate (or set it to "off"), or set finish_gate = "off".`,
      fatal: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// The caveat audit
// ---------------------------------------------------------------------------

/**
 * Admissions of a deviation, by id. Each is a phrase a final answer uses when
 * it reports that the result is not what the task literally asked for. The
 * list is short on purpose: every hit is quoted back to the model, and a
 * hand-back full of noise is a hand-back the model learns to ignore.
 * finish_gate.test.ts holds a true and a false positive for each.
 */
export const CAVEAT_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "judgement_call", re: /\bjudge?ment calls?\b/i },
  { id: "flagged", re: /\b(?:worth flagging|(?:thing|things|item|items|point|points|one|issue|caveat) to flag|(?:should|want to|need to|must) flag)\b/i },
  { id: "infeasible", re: /\b(?:infeasible|not feasible|unfeasible)\b/i },
  { id: "not_possible", re: /\b(?:not possible|impossible)\b/i },
  {
    id: "could_not",
    re: /\b(?:could not|couldn't|unable to|(?:was|were) not able to|cannot (?:all|be (?:met|satisfied|achieved|done|completed|reproduced|fixed|verified|avoided))|can't (?:all|be (?:met|satisfied|achieved|done|avoided)))\b/i,
  },
  { id: "skipped", re: /\b(?:skipped|skipping|left out|omitted)\b/i },
  { id: "approximate", re: /\b(?:approximately|approximate|approximated|roughly|approx\.)/i },
  { id: "only_the", re: /\bonly (?:the|covers?|handles?|supports?|partially)\b/i },
  {
    id: "carries",
    re: /\b(?:necessarily (?:carr(?:y|ies)|has|have|violates?|exceeds?|misses?)|carr(?:y|ies) (?:some |a |an )?(?:lateness|tardiness|risk|deviation|overrun|violation|shortfall|penalty))\b/i,
  },
  {
    id: "over_limit",
    re: /\b(?:over (?:the |its |their |a )?(?:limit|budget|cap|maximum|threshold|allowance|mtow)\b|exceed(?:s|ed|ing)? (?:the |its |their |a )?(?:limit|budget|cap|maximum|threshold|allowance|mtow)\b|\d[\d.,]*\s?[a-z]{0,6}\s+over\s*\))/i,
  },
  {
    id: "late",
    re: /\b(?:lateness|tardiness|(?:is|are|be|runs?|finish(?:es)?|arrives?) late\b|miss(?:es|ed)? (?:the |its |their |a )?(?:due date|due dates|deadline))/i,
  },
  // A literal `false` the answer reports as a result: `route_feasible: false`,
  // `ok` is `false`. Not "returns `false`", which describes behaviour.
  {
    id: "false_literal",
    re: /`[\w.\-]+\s*[:=]\s*false`|`[\w.\-]+`\s+(?:is|was|stays|remains|reports?|=)\s+`?false\b|(?<!returns?\s)(?<!\breturn\s)`false`/i,
  },
  { id: "todo", re: /\b(?:TODO|FIXME)\b/ },
  { id: "workaround", re: /\bwork-?arounds?\b|\bhack(?:y|ish)?\b/i },
  { id: "assumed", re: /\b(?:assumed|assuming|assumptions?|I assume|presumably)\b/i },
  {
    id: "not_implemented",
    re: /\b(?:not (?:yet )?(?:implemented|supported|handled|covered)|unimplemented|unsupported)\b/i,
  },
  { id: "partial", re: /\b(?:partial|partially|incomplete)\b/i },
  {
    id: "interpretation",
    re: /\b(?:I (?:kept|chose|decided|opted|went with|interpreted)|(?:my|this|one|the only) (?:reading|interpretation)|interpreted (?:as|this|it))\b/i,
  },
  { id: "unverified", re: /\b(?:untested|unverified|not (?:been )?(?:tested|verified)|did not (?:test|verify)|didn't (?:test|verify))\b/i },
];
export const CAVEAT_IDS = CAVEAT_PATTERNS.map((p) => p.id);

/** One sentence of the answer that admits a deviation. */
export interface CaveatHit {
  /** The pattern ids that matched, in CAVEAT_PATTERNS order. */
  ids: string[];
  /** The sentence (or list item) it is in, whitespace-collapsed and clipped. */
  quote: string;
}

const MAX_HITS = 8;
const MAX_QUOTE = 280;
/** "no TODOs", "nothing was skipped", "without workarounds": not admissions. */
const NEGATED = /\b(?:no|nothing|none|without|zero|never|not any)\s+(?:[\w'`-]+\s+){0,2}$/i;

function clipQuote(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_QUOTE ? t.slice(0, MAX_QUOTE - 1) + "…" : t;
}

/**
 * The answer's prose, in sentences: reasoning blocks and fenced code removed
 * (a code listing is not a claim, and a `TODO` inside one is code), split on
 * lines and sentence ends.
 */
function sentencesOf(answer: string): string[] {
  const text = answer
    .replace(/\r\n?/g, "\n")
    .replace(/<think>[\s\S]*?<\/think>/g, " ")
    .replace(/```[\s\S]*?(?:```|$)/g, "\n");
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const l = line.replace(/^\s*(?:#{1,6}\s+|[-*•+]\s+|\d{1,3}[.)]\s+|>\s*)/, "").trim();
    if (!l) continue;
    // Split on a sentence end, but not inside inline code (`a.b`, `1.5`).
    for (const s of l.split(/(?<=[.!?;])\s+(?=[A-Z0-9`"'(*])/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

/**
 * Scan a final answer for the deviations it admits. Deterministic: the same
 * answer gives the same hits, so the request they go into is reproducible.
 * At most MAX_HITS sentences, each once, in answer order.
 */
export function scanCaveats(answer: string): CaveatHit[] {
  const hits: CaveatHit[] = [];
  const seen = new Set<string>();
  for (const s of sentencesOf(answer)) {
    const ids: string[] = [];
    for (const { id, re } of CAVEAT_PATTERNS) {
      const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      for (const m of s.matchAll(g)) {
        if (NEGATED.test(s.slice(0, m.index))) continue;
        ids.push(id);
        break;
      }
    }
    if (ids.length === 0) continue;
    const quote = clipQuote(s);
    if (seen.has(quote)) continue;
    seen.add(quote);
    hits.push({ ids, quote });
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

/** The distinct ids across hits, sorted: what the audit record carries. */
export function caveatIds(hits: ReadonlyArray<CaveatHit>): string[] {
  return [...new Set(hits.flatMap((h) => h.ids))].sort();
}

// ---------------------------------------------------------------------------
// Claims against evidence (after clnkr's completion gate)
// ---------------------------------------------------------------------------

/**
 * One tool call the turn made, as the evidence check sees it: its name, the
 * bash command when it was bash, and whether it ran.
 */
export interface EvidenceCall {
  name: string;
  command?: string;
}

/**
 * Claim kinds and the evidence each needs, after clnkr's
 * `completionChallengeRules` (completion_gate.go). clnkr matches a claim
 * against checks the model *reports* in a structured done; gnomon has the
 * calls the turn *actually made*, so the evidence here is observed, not
 * claimed, and must come after the last write or edit: a check of a file
 * before it last changed is not a check of the file.
 */
export const EVIDENCE_RULES: ReadonlyArray<{
  id: string;
  claim: RegExp;
  /** A bash command that counts as the evidence. */
  command: RegExp;
  /** Tools other than bash whose call counts as the evidence. */
  tools: readonly string[];
  ask: string;
}> = [
  {
    id: "artifact_unchecked",
    claim: /\b(?:created|wrote|written|saved|generated|produced|exported)\b/i,
    command: /(?:^|[\s;&|(])(?:test\s+-[efsd]|\[\s+-[efsd]|cat|ls|stat|head|tail|wc|diff|cmp|jq|file|sha\d*sum|md5sum|xxd|od|python3?\s+-c|node\s+-e)\b/,
    tools: ["read", "glob"],
    ask: "you say you created or wrote an output, but no call after your last change looked at it (`ls -l`, `cat`, `head`, `test -f`, or a read)",
  },
  {
    id: "service_unchecked",
    claim: /\b(?:server|service|daemon|endpoint) (?:is |now )?(?:running|listening|up|started|serving)\b|\blistening on\b/i,
    command: /(?:^|[\s;&|(])(?:curl|wget|nc|ncat|ss|lsof|netstat|http|grpcurl)\b/,
    tools: [],
    ask: "you say a service is running, but no call after your last change probed it (`curl`, `nc`, `ss -ltnp`)",
  },
  {
    id: "behavior_unchecked",
    claim: /\b(?:implemented|fixed|works|working|passes|passing|all tests|verified)\b/i,
    command:
      /(?:^|[\s;&|(])(?:pytest|python3?|node|npm|pnpm|yarn|npx|cargo|go|make|ctest|mvn|gradle|dotnet|ruby|rspec|php|java|bun|deno|bash|sh|\.\/[\w.\-\/]+|Rscript|julia)\b/,
    tools: [],
    ask: "you say it works, but no command after your last change ran it or its tests",
  },
];
export const EVIDENCE_IDS = EVIDENCE_RULES.map((r) => r.id);

/** Tool calls that change files, for "after the last change". */
const CHANGING_TOOLS = new Set(["write", "edit"]);

/**
 * The claims in an answer that no call after the turn's last write or edit
 * supports. Deterministic, like the caveat audit. `calls` are the turn's tool
 * calls that ran, in order.
 */
export function evidenceGaps(answer: string, calls: ReadonlyArray<EvidenceCall>): string[] {
  const prose = sentencesOf(answer).join("\n");
  let last = -1;
  calls.forEach((c, i) => {
    if (CHANGING_TOOLS.has(c.name)) last = i;
  });
  const after = calls.slice(last + 1);
  const gaps: string[] = [];
  for (const r of EVIDENCE_RULES) {
    if (!r.claim.test(prose)) continue;
    const seen = after.some(
      (c) => r.tools.includes(c.name) || (c.name === "bash" && typeof c.command === "string" && r.command.test(c.command))
    );
    if (!seen) gaps.push(r.id);
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// The audit: what the hand-back is built from
// ---------------------------------------------------------------------------

/**
 * What one audit of an answer found. The deterministic audit below
 * (auditFinish) is the only producer today; the shape is the seam a later
 * variant -- one bounded judge call to a configured role -- would fill
 * instead, so the hand-back, the decision and the records stay as they are.
 */
export interface FinishAudit {
  /** Deviations the answer itself admits. */
  caveats: CaveatHit[];
  /** EVIDENCE_RULES ids: claims no call after the last change supports. */
  gaps: string[];
  /** Open items of the checklist this turn wrote. */
  todos: Array<{ content: string; status: string }>;
}

/** The deterministic audit: the caveat scan, claims against evidence, open todos. */
export function auditFinish(input: {
  answer: string;
  calls: ReadonlyArray<EvidenceCall>;
  todos: ReadonlyArray<{ content: string; status: string }>;
}): FinishAudit {
  return {
    caveats: scanCaveats(input.answer),
    gaps: evidenceGaps(input.answer, input.calls),
    todos: input.todos.filter((t) => t.status !== "completed").map((t) => ({ content: t.content, status: t.status })),
  };
}

// ---------------------------------------------------------------------------
// The hand-backs
// ---------------------------------------------------------------------------

function quoteTask(task: string): string {
  const t = task.replace(/\r\n?/g, "\n").trim();
  if (t.length <= FINISH_GATE_TASK_CHARS) return t;
  return t.slice(0, FINISH_GATE_TASK_CHARS) + `\n[… ${t.length - FINISH_GATE_TASK_CHARS} more characters of the task not repeated here]`;
}

function renderCaveats(hits: ReadonlyArray<CaveatHit>): string {
  if (hits.length === 0) {
    return (
      `Caveat audit: your answer states no deviation from the task. If you made a judgement call, ` +
      `an assumption or a reduction in scope that the answer does not say, name it now and fix it.`
    );
  }
  return (
    `Caveat audit: your own answer reports ${hits.length === 1 ? "a deviation" : "deviations"} from the task:\n` +
    hits
      .map(
        (h, i) =>
          `  ${i + 1}. Your answer says: "${h.quote}". The task requires the strict reading; ` +
          `fix it or show concretely why the task text allows it.`
      )
      .join("\n") +
    `\nHidden checks almost always encode a stated constraint as satisfiable and a stated term literally. ` +
    `A deviation you reported is a defect until the task's own words say otherwise.`
  );
}

/** The full hand-back: the first end of a turn the gate applies to. */
export function renderFinishGate(opts: {
  task: string;
  todos: ReadonlyArray<{ content: string; status: string }>;
  caveats: ReadonlyArray<CaveatHit>;
  changed: string[] | null;
  /** evidenceGaps ids: claims no call after the last change supports. */
  gaps?: readonly string[];
  round: number;
}): string {
  const parts: string[] = [];
  parts.push(
    `Finish gate (round ${opts.round} of ${FINISH_GATE_ROUNDS}): your answer is not accepted yet. This is the ` +
      `harness, not a reviewer's opinion: a turn that changed files is checked against the task's exact ` +
      `words before it may end. Treat completion as unproven; your claim that it is done is not evidence.`
  );
  parts.push(`The task, verbatim:\n<task>\n${quoteTask(opts.task)}\n</task>`);
  if (opts.todos.length > 0) {
    parts.push(
      `Your checklist still has open items:\n` +
        opts.todos.map((t) => `  - [${t.status === "in_progress" ? ">" : " "}] ${t.content}`).join("\n")
    );
  }
  parts.push(renderCaveats(opts.caveats));
  const gaps = (opts.gaps ?? [])
    .map((id) => EVIDENCE_RULES.find((r) => r.id === id))
    .filter((r): r is (typeof EVIDENCE_RULES)[number] => r !== undefined);
  if (gaps.length > 0) {
    parts.push(
      `Claims without evidence, from the calls this turn actually made:\n` +
        gaps.map((r) => `  - ${r.ask[0].toUpperCase()}${r.ask.slice(1)}.`).join("\n")
    );
  }
  const stray =
    opts.changed && opts.changed.length > 0
      ? `This turn created or changed ${opts.changed.slice(0, 30).map((p) => `\`${p}\``).join(", ")}` +
        `${opts.changed.length > 30 ? `, +${opts.changed.length - 30} more` : ""}. Remove any the task did not ` +
        `ask for and that you made only as scratch (throwaway scripts, backups, logs). Never delete an input, ` +
        `or a file the task names or that its checks may read.`
      : `Remove scratch files you made that the task did not ask for. Never delete an input, or a file the ` +
        `task names or that its checks may read.`;
  parts.push(
    `Targeted checks, before you answer again:\n` +
      [
        `Every output file, path and format the task names exists exactly where and as the task says. Check it on disk, not from memory.`,
        `Map each explicit requirement, numbered item, named artifact and value to the evidence that proves it: a command and what it printed, or the file's contents.`,
        `Tests, green checks and your own scripts are evidence only after you confirm they cover the requirement. Add a test for any stated property you have not exercised: ordering, concurrency, edge inputs, changed values (other sizes, numbers, file contents).`,
        `Do not substitute a narrower, safer, merely compatible or easier-to-test solution because it is more likely to pass.`,
        stray,
      ]
        .map((l) => `  - ${l}`)
        .join("\n")
  );
  parts.push(
    `Make at least one tool call that checks or fixes the work before you answer again; an answer with no ` +
      `tool call after this message is not accepted. Then answer, saying for each requirement how you know it holds.`
  );
  return parts.join("\n\n");
}

/** The hand-back for an answer with no tool call since the last one. */
export function renderFinishNoTool(opts: { round: number; caveats: ReadonlyArray<CaveatHit> }): string {
  const still =
    opts.caveats.length > 0
      ? ` Your answer still says: ${opts.caveats.map((h) => `"${h.quote}"`).join("; ")}.`
      : "";
  return (
    `Finish gate (round ${opts.round} of ${FINISH_GATE_ROUNDS}): no tool call has run since the last message, ` +
    `so the answer is still not accepted.${still} Check the work against the task and the items above with at ` +
    `least one tool call, fix what fails, then answer.`
  );
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface FinishGateState {
  /** Hand-backs so far this turn. */
  rounds: number;
  /** Tool calls that ran since the last hand-back. */
  toolsSince: number;
}

export type FinishGateStep =
  | { act: "accept"; outcome: "passed" | "exhausted" | "skipped_budget" }
  | { act: "fire" | "no_tool" };

/**
 * What to do with an end the gate applies to. `budgetLeft` is the smaller of
 * the step and deadline fractions left (completion_gate.ts budgetLeft).
 */
export function nextFinishStep(s: FinishGateState, budgetLeft: number): FinishGateStep {
  if (s.rounds > 0 && s.toolsSince > 0) return { act: "accept", outcome: "passed" };
  if (s.rounds >= FINISH_GATE_ROUNDS) return { act: "accept", outcome: "exhausted" };
  if (budgetLeft < FINISH_GATE_MIN_REMAINING) return { act: "accept", outcome: "skipped_budget" };
  return { act: s.rounds === 0 ? "fire" : "no_tool" };
}

/** `counters.finish_gate`: present only when the gate is declared. */
export interface FinishGateCounters {
  v: 1;
  mode: "v2";
  max_rounds: number;
  min_remaining: number;
  /** Hand-backs. */
  rounds: number;
  /** Tool calls that ran after a hand-back. */
  tool_calls: number;
  /** Caveat sentences in the answer the gate first fired on (0 if it never fired). */
  caveats: number;
  /** Caveat sentences in the answer accepted after a hand-back. Absent when the
   * gate never fired. */
  caveats_final?: number;
  /** Claims without evidence (evidenceGaps) in the answer the gate first
   * fired on. Absent when none. */
  evidence_gaps?: number;
  /** Open todo items listed in the first hand-back. Absent when none. */
  open_todos?: number;
  outcome: FinishGateOutcome;
}

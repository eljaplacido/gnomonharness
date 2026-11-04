/**
 * Stall signals: three log-only detectors over a turn's tool calls (LP5).
 *
 * The loop already acts on two stall shapes. `[loop] stall_repeats` stops a
 * turn that repeats one call verbatim, the A-B-A-B window stops a two-call
 * alternation, and `nudge_after_idle` tells the model to decide after N calls
 * that changed no file. The third is control, and control that reaches the
 * model has a measured cost: user-turn nudges took S1 from 19/30 to 16/31
 * (paired 0-4), and two nudges in one turn left 1 of 11 trials passing. So
 * these three detectors are not a fourth intervention. They write counters and
 * audit records, and nothing in the loop reads them back. They exist so the
 * stall-path experiments (signal-gated nudge LP2, restart-once LP4, cloud
 * rescue HY1) can measure trigger precision on runs that already happened, and
 * on runs that have not happened yet, before any of them is allowed to act.
 *
 * The three detectors:
 *
 * - **limit_cycle**: the last calls repeat with period 2, 3 or 4 over the call
 *   key, at least two distinct keys in the period, and nothing changed state
 *   inside the window. Period 1 is `stall_repeats`' job and stays there.
 * - **no_progress**: `no_progress_calls` calls in a row with no state change,
 *   no new test outcome and no new read. "New" is within the turn.
 * - **novelty_cusum**: a one-sided CUSUM over a per-call novelty score, to
 *   catch novelty decaying gradually rather than stopping outright.
 *
 * REPLAYABLE BY CONSTRUCTION. The input is exactly the fields a `tool_call`
 * audit record carries in `metadata` mode: tool, target, code, summary and
 * worktree_changed. The loop feeds the detectors the same values it writes to
 * the trail, so running this module over a trail recomputes what a live run
 * computed (benchmarks/analysis/stall_replay.mjs does that). The price is a
 * coarser view than the live call: `read` with a different offset has the same
 * target and summary, and a bash call's output is known only by its exit code.
 * A detector that used the tool output itself could not be checked against
 * any trail gnomon has written, and would be the one part of a published claim
 * nobody could recompute.
 *
 * Pure: no I/O, no clock, no randomness. Every number is in
 * STALL_SIGNAL_THRESHOLDS and every pattern in STALL_SIGNAL_PATTERNS.
 */

/** The record shape version for `counters.stall_signals` and `stall_signal`. */
export const STALL_SIGNALS_VERSION = 1;

/** The three detectors, in the order they are reported. */
export const STALL_SIGNAL_NAMES = ["limit_cycle", "no_progress", "novelty_cusum"] as const;
export type StallSignalName = (typeof STALL_SIGNAL_NAMES)[number];

export interface StallThresholds {
  /** Periods the cycle detector tests. 1 is excluded: see the module doc. */
  cycle_periods: readonly number[];
  /** A cycle must span at least this many calls... */
  cycle_min_calls: number;
  /** ...and at least this many full periods. Window = max of the two. */
  cycle_min_periods: number;
  /** Calls in a row without progress before no_progress fires. */
  no_progress_calls: number;
  /** CUSUM reference value k: novelty below k accumulates evidence. */
  cusum_k: number;
  /** CUSUM decision interval h: the alarm fires when the sum reaches h. */
  cusum_h: number;
}

/**
 * Every number the detectors use, declared once.
 *
 * Stated before any outcome was read (2026-11-04), from the mechanism alone:
 * - a cycle of 6 calls is 2 calls shorter than the A-B-A-B stop window (8),
 *   so a period-2 loop is flagged before the loop stops it;
 * - 8 calls without progress is two-thirds of `nudge_after_idle` (12), and
 *   counts fewer calls as idle than the nudge does (a new read is progress
 *   here and idle there);
 * - k = 0.5 sits halfway between a healthy novelty rate (~0.8, most calls new)
 *   and a stuck one (~0.2); h = 4 means eight fully repeated calls in a row,
 *   or a longer stretch in which most calls are repeats.
 * benchmarks/analysis/stall_replay.mjs states the tuning grid around these,
 * tunes on one campaign and reports a different one held out.
 */
export const STALL_SIGNAL_THRESHOLDS: StallThresholds = Object.freeze({
  cycle_periods: Object.freeze([2, 3, 4]),
  cycle_min_calls: 6,
  cycle_min_periods: 2,
  no_progress_calls: 8,
  cusum_k: 0.5,
  cusum_h: 4,
});

/**
 * Every pattern the detectors use, declared once. Command-text patterns only
 * CLASSIFY a call that already ran; nothing predicts from them.
 */
export const STALL_SIGNAL_PATTERNS = Object.freeze({
  /** Bookkeeping: advances the step count, invisible to every detector. */
  bookkeeping_tools: Object.freeze(["todo", "note"]) as readonly string[],
  /** Tools that gather information; a new key from one of these is a new read. */
  read_tools: Object.freeze(["read", "grep", "glob", "skill"]) as readonly string[],
  /** Tools whose success changes the worktree by definition. */
  write_tools: Object.freeze(["write", "edit"]) as readonly string[],
  /**
   * A delegated turn: what it changed is the child's to record, and the
   * parent's detectors count a successful delegation as progress rather than
   * flag a coordinator for waiting on its builder.
   */
  delegate_tools: Object.freeze(["task"]) as readonly string[],
  /** A shell command that runs tests: its exit code is a test outcome. */
  test_command:
    /\b(pytest|py\.test|unittest|nose2?|tox|jest|vitest|mocha|rspec|phpunit|ctest|bats)\b|\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\b(cargo|go|dotnet|mvn|gradle|mix|stack|cabal)\s+test\b|\bmake\s+(test|check)\b|\brun[-_]?tests?\b|\btest_[\w-]*\.(py|sh)\b|\btests?\/[\w./-]*\.(py|sh|js|ts)\b/,
  /** A shell command that only reads, judged on its first word. */
  read_command:
    /^(cat|head|tail|sed\s+-n|less|more|nl|wc|grep|egrep|fgrep|rg|ag|find|ls|tree|file|stat|du|diff|cmp|awk|jq|xxd|od|strings|readelf|objdump|which|whereis|type|man|pwd|env|printenv|uname|id|hostname|ps|apt-cache|dpkg(-query)?\s+-[lLsS]|(pip3?|python3?\s+-m\s+pip)\s+(show|list|freeze)|npm\s+(ls|list|view)|git\s+(status|log|show|diff|grep|blame|ls-files))\b/,
  /**
   * A shell command that changes the system outside the worktree, which the
   * worktree stamp cannot see (POSTMORTEM F13: the idle counter was blind to
   * `apt` and `/etc`). Counted as a state change only when it exited 0.
   */
  system_command:
    /\b(apt(-get)?\s+(-\S+\s+)*(install|remove|purge)|apk\s+add|(yum|dnf|zypper|brew|conda|gem)\s+install|(pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+install|(npm|pnpm)\s+(install|i|add)|yarn\s+add|(cargo|go)\s+install|useradd|groupadd|systemctl\s+(start|restart|enable)|service\s+\S+\s+(start|restart))\b|(>>?|\btee\s+(-a\s+)?)\s*\/(etc|usr|opt|var)\//,
});

/**
 * One tool call as the detectors see it: the fields of its `tool_call` audit
 * record, nothing more.
 */
export interface StallObservation {
  tool: string;
  /** The record's `target`: the whole (redacted) command for bash, else the path. */
  target: string;
  /** The tool's own code, which maps to a bucket. */
  code: number;
  /** The one-line outcome, e.g. `bash — exit 1` or `read /x — 30 lines`. */
  summary: string;
  /** The worktree stamp, for a bash call that took one. */
  worktree_changed?: boolean | null;
}

/** What `counters.stall_signals` carries for one detector. */
export interface StallSignalTally {
  /** Episodes: times the detector went from quiet to firing. */
  count: number;
  /** The turn's step (tool-call count) at the first episode. */
  first_step?: number;
}

/** `counters.stall_signals` on a turn record. */
export interface StallSignalCounters {
  v: number;
  /** Calls the detectors saw: every call but bookkeeping. */
  observed: number;
  limit_cycle: StallSignalTally & { period?: number };
  no_progress: StallSignalTally;
  novelty_cusum: StallSignalTally;
  /**
   * Set when a detector threw and observation stopped. The counters then cover
   * the calls before it. Absent otherwise. The loop catches the throw: a
   * detector failing must not change the turn.
   */
  error?: string;
}

/** One episode starting, as the `stall_signal` audit record writes it. */
export interface StallSignalFire {
  signal: StallSignalName;
  step: number;
  /** This detector's episode number in the turn, from 1. */
  episode: number;
  /** limit_cycle: the period found. */
  period?: number;
  /** no_progress: the streak length at the step it fired. */
  streak?: number;
  /** novelty_cusum: the sum when it crossed h. */
  cusum?: number;
}

const SEP = " — ";

/** The part of a summary before " — ": the tool and what it was pointed at. */
function summaryHead(summary: string): string {
  const i = summary.indexOf(SEP);
  return i === -1 ? summary : summary.slice(0, i);
}

/** The part after " — ": what came back. */
export function summaryOutcome(summary: string): string {
  const i = summary.indexOf(SEP);
  return (i === -1 ? "" : summary.slice(i + SEP.length)).replace(/\s+/g, " ").trim();
}

/**
 * A shell command with the noise that does not change what it asks for taken
 * out: full-line comments, whitespace, leading `cd <dir> &&` (or `;`, or a
 * line of its own), `VAR=value`, `timeout <n>` and `sudo`, `2>&1`, and a
 * trailing `| head` or `| tail`. `pytest 2>&1 | tail -20` and
 * `cd /app && pytest | tail -50` run the same tests.
 *
 * The comment and prefix rules came from the first replay (2026-11-04): 846
 * of 22,646 recorded bash calls began with a `# what I am about to do` line,
 * so a `cat` or `grep` behind one was not seen as a read.
 */
export function normalizeCommand(command: string): string {
  let c = command
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^\s*#/.test(line))
    .join(" ; ")
    .replace(/\s+/g, " ")
    .trim();
  for (;;) {
    const next = c
      .replace(/^cd\s+\S+\s*(&&|;)\s*/, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "")
      .replace(/^timeout\s+(-\S+\s+)*\d+(\.\d+)?[smhd]?\s+/, "")
      .replace(/^sudo\s+(-\S+\s+)*/, "");
    if (next === c) break;
    c = next;
  }
  c = c.replace(/\s*2>&1/g, "");
  for (;;) {
    const next = c.replace(/\s*\|\s*(head|tail)(\s+-[nc]?\s*\d+|\s+-\d+)?\s*$/, "");
    if (next === c) break;
    c = next;
  }
  return c.trim();
}

/** The identity two calls share when they ask for the same thing. */
export function stallKey(o: StallObservation): string {
  const target = o.tool === "bash" ? normalizeCommand(o.target) : o.target.replace(/\s+/g, " ").trim();
  return `${o.tool}\u0000${target}\u0000${summaryHead(o.summary)}`;
}

/** The exit status in a bash summary, or undefined (killed, refused, no command). */
export function summaryExit(summary: string): number | undefined {
  const m = /\bexit (-?\d+)\b/.exec(summary);
  return m ? Number(m[1]) : undefined;
}

/** Whether the call changed state: the worktree, or the system around it. */
export function changedState(o: StallObservation): boolean {
  if (o.code !== 0) return false;
  const P = STALL_SIGNAL_PATTERNS;
  if (P.write_tools.includes(o.tool)) return true;
  if (P.delegate_tools.includes(o.tool)) return true;
  if (o.worktree_changed === true) return true;
  if (o.tool === "bash" && summaryExit(o.summary) === 0 && P.system_command.test(normalizeCommand(o.target))) {
    return true;
  }
  return false;
}

/** Whether the call ran tests, so its outcome is a test outcome. */
export function isTestCall(o: StallObservation): boolean {
  return o.tool === "bash" && STALL_SIGNAL_PATTERNS.test_command.test(normalizeCommand(o.target));
}

/** Whether the call only gathered information. */
export function isReadCall(o: StallObservation): boolean {
  const P = STALL_SIGNAL_PATTERNS;
  if (P.read_tools.includes(o.tool)) return true;
  return o.tool === "bash" && P.read_command.test(normalizeCommand(o.target));
}

function emptyCounters(): StallSignalCounters {
  return {
    v: STALL_SIGNALS_VERSION,
    observed: 0,
    limit_cycle: { count: 0 },
    no_progress: { count: 0 },
    novelty_cusum: { count: 0 },
  };
}

/**
 * The three detectors over one turn. Feed it every executed tool call, in
 * order, with the turn's step count after that call; read `counters` at the
 * end. `observe` returns the episodes that started at this step, for the
 * audit trail.
 */
export class StallSignals {
  readonly counters: StallSignalCounters = emptyCounters();
  private readonly t: StallThresholds;
  /** Keys seen this turn, and the last outcome each produced. */
  private readonly lastOutcome = new Map<string, string>();
  /** The most recent calls (non-bookkeeping), for the cycle test. */
  private readonly recent: Array<{ key: string; changed: boolean }> = [];
  private readonly window: number;
  private inCycle = false;
  private streak = 0;
  private cusum = 0;

  constructor(thresholds: StallThresholds = STALL_SIGNAL_THRESHOLDS) {
    this.t = thresholds;
    this.window = Math.max(
      0,
      ...thresholds.cycle_periods.map((p) => Math.max(thresholds.cycle_min_calls, p * thresholds.cycle_min_periods))
    );
  }

  observe(o: StallObservation, step: number): StallSignalFire[] {
    if (STALL_SIGNAL_PATTERNS.bookkeeping_tools.includes(o.tool)) return [];
    this.counters.observed++;
    const fires: StallSignalFire[] = [];
    const key = stallKey(o);
    const outcome = `${o.code}\u0000${summaryOutcome(o.summary)}`;
    const changed = changedState(o);
    const seen = this.lastOutcome.has(key);
    const newOutcome = seen && this.lastOutcome.get(key) !== outcome;
    this.lastOutcome.set(key, outcome);

    // limit_cycle
    this.recent.push({ key, changed });
    if (this.recent.length > this.window) this.recent.shift();
    const period = this.cyclePeriod();
    if (period !== undefined && !this.inCycle) {
      const tally = this.counters.limit_cycle;
      tally.count++;
      if (tally.first_step === undefined) {
        tally.first_step = step;
        tally.period = period;
      }
      fires.push({ signal: "limit_cycle", step, episode: tally.count, period });
    }
    this.inCycle = period !== undefined;

    // no_progress
    const progress =
      changed ||
      (isTestCall(o) && (!seen || newOutcome)) ||
      (isReadCall(o) && !seen);
    this.streak = progress ? 0 : this.streak + 1;
    if (this.streak === this.t.no_progress_calls) {
      const tally = this.counters.no_progress;
      tally.count++;
      tally.first_step ??= step;
      fires.push({ signal: "no_progress", step, episode: tally.count, streak: this.streak });
    }

    // novelty_cusum
    const novelty = changed || !seen ? 1 : newOutcome ? 0.5 : 0;
    this.cusum = Math.max(0, this.cusum + this.t.cusum_k - novelty);
    if (this.cusum >= this.t.cusum_h) {
      const tally = this.counters.novelty_cusum;
      tally.count++;
      tally.first_step ??= step;
      fires.push({ signal: "novelty_cusum", step, episode: tally.count, cusum: this.cusum });
      // Reset after an alarm, the standard CUSUM restart: a second episode
      // needs fresh evidence, so `count` reads as alarms, not as calls.
      this.cusum = 0;
    }
    return fires;
  }

  /** The smallest period the recent calls repeat with, if any. */
  private cyclePeriod(): number | undefined {
    const r = this.recent;
    for (const p of this.t.cycle_periods) {
      const span = Math.max(this.t.cycle_min_calls, p * this.t.cycle_min_periods);
      if (p < 2 || r.length < span) continue;
      const w = r.slice(-span);
      if (w.some((c) => c.changed)) continue;
      let periodic = true;
      for (let i = p; i < span && periodic; i++) periodic = w[i]!.key === w[i - p]!.key;
      if (!periodic) continue;
      // At least two distinct keys in one period: a run of one key is
      // stall_repeats' shape, not a cycle.
      if (new Set(w.slice(0, p).map((c) => c.key)).size < 2) continue;
      return p;
    }
    return undefined;
  }
}

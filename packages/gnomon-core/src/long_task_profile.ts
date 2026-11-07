/**
 * Two declared opt-ins for unattended long tasks (docs/CONTRACTS.md §39,
 * conformance/long_task_profile.json):
 *
 * - `[turn] deadline_note = "plan" | "continue" | "none"`: the wording and timing of the
 *   `--deadline` time note. TEMPORARY: it exists so the SW1 sweep can test
 *   one wording against the other on one build, and the losing value is
 *   deleted after SW1 (research note convergence-synthesis-2026-11-07 §5a a6).
 * - `[turn] prompt_profile = "default" | "unattended"`: the scaffold's daily-dev
 *   stop sentences out, the long-task lines in, the idle nudge off.
 *
 * Both are declared in `.gnomon/config.toml`, so both move the surface hash.
 * Neither is ever inferred from a TTY, an environment variable or the command
 * that started gnomon (Rule 1): `gnomon task` with nothing declared sends the
 * bytes it sent before this file existed.
 *
 * Why, in one paragraph each.
 *
 * deadline_note. On v0.4.5 (FG1, hosted DeepSeek V4.1 Flash, `--deadline
 * 1740`) the half-time note "Plan the rest of the work, and checking it, to
 * finish inside that" was followed by an answer 30-250 s later with 9-13
 * minutes unused in 12 cells of the three never-solved tasks, in the model's
 * own words "Time is up", "did not have budget to implement"; 42% of FG1's C
 * runs ended at 900-1200 s against 6-10% without a deadline, while all three
 * opencode solves of those tasks landed at 1597-1800 s (research note 12 §1).
 * The note also turns caps into answers, which is worth keeping, so the
 * "continue" wording is one note at 0.8 that says to keep going and to make
 * sure the outputs exist -- the conditional deliverable-first note (§35)
 * still names a missing output. Which wording wins is SW1's question.
 *
 * prompt_profile. The scaffold's "Verify in proportion to the task: do not
 * build test suites, helper scripts or extra checks nobody asked for ..." and
 * "Once it works and the task's requirements are met, stop." were validated
 * on short tasks (lean-2026-11: 37 vs 34/48) and stay for daily development.
 * On long tasks every winning harness does the opposite: mini-swe-agent's
 * only quality instruction is "Test edge cases", it ends only on an explicit
 * submit, and 0 of its 14 losses on the contested tasks were early answers
 * against OpenCode's 11 of 51 (research note 07 §2.2, §4). gnomon's own
 * near-misses on vf2 and risk-scorer were measurement gaps: a 12x
 * self-overestimate from warm, mixed-case timing, and an rms check where the
 * verifier compares strings byte for byte (note 12, F3). H2 replaced the
 * sentence with a stronger verify rule and saw no change (2 vs 2 of 12), so
 * removal is a hypothesis for SW1's U arm, not a result -- hence opt-in.
 */
import type { GnomonConfig } from "./config.js";

export const DEADLINE_NOTE_STYLES = ["plan", "continue", "none"] as const;
export type DeadlineNoteStyle = (typeof DEADLINE_NOTE_STYLES)[number];

export const PROMPT_PROFILES = ["default", "unattended"] as const;
export type PromptProfile = (typeof PROMPT_PROFILES)[number];

/** Where the single "continue" note goes: 80% of the budget used. */
export const CONTINUE_NOTE_AT: readonly number[] = [0.8];

/**
 * The time note's text. `plan` is the text every `--deadline` run has sent
 * since §31, byte for byte; `continue` is the SW1 alternative. `none` sends no
 * time note at all (its deliverable-first note goes out alone, without a
 * countdown): DP1's decision-point replays put the early-stop cue in the
 * countdown itself ("about N of 29m remain"), not in the "plan the rest"
 * ending, and swapping the ending to `continue` barely changed it. Never
 * called for `none`; given it, it returns "".
 */
export function deadlineNoteText(style: DeadlineNoteStyle, left: string, total: string): string {
  if (style === "none") return "";
  const head = `Time check: about ${left} of this task's ${total} remain before it is stopped. `;
  return style === "continue"
    ? head + `There is enough time left for substantial work; keep going and make sure the required outputs exist.`
    : head + `Plan the rest of the work, and checking it, to finish inside that.`;
}

/**
 * The scaffold sentences the unattended profile drops, matched across any
 * line wrapping (the scaffold wraps at 76 columns; an edited system.md may
 * not). Each takes the whitespace before it, so the bullet it ended still
 * ends cleanly. Text that is not the scaffold's is left alone: a surface that
 * rewrote these lines keeps its own words, and the record says nothing was
 * dropped.
 */
export const UNATTENDED_DROPS: readonly RegExp[] = [
  /\s*Verify\s+in\s+proportion\s+to\s+the\s+task:\s+do\s+not\s+build\s+test\s+suites,\s+helper\s+scripts\s+or\s+extra\s+checks\s+nobody\s+asked\s+for,\s+and\s+do\s+not\s+re-check\s+what\s+already\s+passed\./g,
  /\s*Once\s+it\s+works\s+and\s+the\s+task's\s+requirements\s+are\s+met,\s+stop\./g,
];

/**
 * What the unattended profile adds, after the "This session" block. mini's
 * single quality line, and note 12's F3: reproduce a timed gate the way the
 * verifier measures it; for black-box parity, compare exact strings on many
 * random probes and round fitted constants.
 */
export const UNATTENDED_BLOCK =
  "## Unattended run\n\n" +
  "- Test edge cases, then submit. Your reply with no tool call is the submission.\n" +
  "- A timed gate (a speed-up, a latency or throughput bound): reproduce the stated measurement " +
  "literally before trusting a number -- fresh objects, one cold call each, the stated cases and " +
  "the stated statistic -- and require at least a 2x margin over the bar.\n" +
  "- Black-box parity (matching an existing program's output): compare exact output strings over " +
  "many random probes, not an error measure on a few rows, and round fitted constants to the exact " +
  "values they stand for.";

/** `[turn] deadline_note`, resolved: "plan" unless "continue" is declared. */
export function resolveDeadlineNoteStyle(config: GnomonConfig): DeadlineNoteStyle {
  const v = turnOf(config)?.deadline_note;
  return v === "continue" || v === "none" ? v : "plan";
}

/** `[turn] prompt_profile`, resolved: "default" unless "unattended" is declared. */
export function resolvePromptProfile(config: GnomonConfig): PromptProfile {
  const v = turnOf(config)?.prompt_profile;
  return v === "unattended" ? "unattended" : "default";
}

/**
 * The system text a profile builds from the surface's system.md, and how
 * many scaffold sentences it dropped. "default" returns the text unchanged.
 */
export function applyPromptProfile(text: string, profile: PromptProfile): { text: string; dropped: number } {
  if (profile !== "unattended") return { text, dropped: 0 };
  let dropped = 0;
  let out = text;
  for (const re of UNATTENDED_DROPS) {
    out = out.replace(re, () => {
      dropped++;
      return "";
    });
  }
  return { text: out, dropped };
}

/** The block appended for a profile: "" for "default", so the prompt is the one it always was. */
export function promptProfileBlock(profile: PromptProfile): string {
  return profile === "unattended" ? `\n\n${UNATTENDED_BLOCK}` : "";
}

/**
 * Surface problems for the two keys. A value outside the enumeration is
 * fatal: a surface that seems to ask for a behaviour must not run without it.
 * Non-fatal: `deadline_notes` declared beside `deadline_note = "continue"`
 * (the continue note's timing is fixed at 0.8, so the list is not read), and
 * an unattended profile over a system.md with none of the scaffold sentences
 * it drops.
 */
export function auditLongTaskProfile(
  config: GnomonConfig
): Array<{ where: string; problem: string; fix: string; fatal: boolean }> {
  const t = turnOf(config);
  const out: Array<{ where: string; problem: string; fix: string; fatal: boolean }> = [];
  const note = t?.deadline_note;
  if (note !== undefined && !(DEADLINE_NOTE_STYLES as readonly unknown[]).includes(note)) {
    out.push({
      where: ".gnomon/config.toml [turn] deadline_note",
      problem: `deadline_note = ${JSON.stringify(note)} is not "plan", "continue" or "none". Refused rather than run with a time note the surface did not ask for.`,
      fix: 'deadline_note = "continue" (one note at 0.8: keep going), "none" (no time note), or "plan" (the default).',
      fatal: true,
    });
  } else if ((note === "continue" || note === "none") && t?.deadline_notes !== undefined) {
    out.push({
      where: ".gnomon/config.toml [turn] deadline_notes",
      problem:
        note === "continue"
          ? `deadline_notes is not read under deadline_note = "continue": that style sends one note, at ${CONTINUE_NOTE_AT.join(", ")} of the budget.`
          : `deadline_notes is not read under deadline_note = "none": that style sends no time note.`,
      fix: 'Remove deadline_notes, or use deadline_note = "plan".',
      fatal: false,
    });
  }
  const profile = t?.prompt_profile;
  if (profile !== undefined && !(PROMPT_PROFILES as readonly unknown[]).includes(profile)) {
    out.push({
      where: ".gnomon/config.toml [turn] prompt_profile",
      problem: `prompt_profile = ${JSON.stringify(profile)} is not "default" or "unattended". Refused rather than run with a prompt the surface did not ask for.`,
      fix: 'prompt_profile = "unattended" (long unattended runs), or "default".',
      fatal: true,
    });
  } else if (profile === "unattended") {
    const system = (config as { system?: { content?: string } }).system?.content ?? "";
    if (applyPromptProfile(system, "unattended").dropped === 0) {
      out.push({
        where: ".gnomon/system.md",
        problem:
          `prompt_profile = "unattended" drops the scaffold's "Verify in proportion to the task ..." and ` +
          `"Once it works ... stop." sentences, and this system.md has neither, so only the profile's own lines are added.`,
        fix: "Nothing, if the stop sentences were removed on purpose.",
        fatal: false,
      });
    }
  }
  return out;
}

function turnOf(config: GnomonConfig): Record<string, unknown> | undefined {
  return (config.config as { turn?: Record<string, unknown> } | undefined)?.turn;
}

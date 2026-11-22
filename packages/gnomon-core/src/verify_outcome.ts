/**
 * gnomon-core: the one table that turns a [verify] run into a verdict (#232).
 *
 * A check had three outcomes: exit 0 passed, 126/127 unrunnable, anything else
 * failed. Many tools use other codes to say "nothing was measured": pytest 2
 * (collection error, usually a missing import), 4 (usage) and 5 (nothing
 * collected); SeptaCore's 2 (could not measure) and 3 (regressed); project
 * scripts that print "NOT RUN" and exit 4. gnomon flattened all of them to
 * `failed`, which is handed back to the model, so a check that never measured
 * anything made it rewrite correct code (the comment at prompt_loop.ts's
 * unrunnable branch records the measurement).
 *
 * This module is the only place the mapping lives. `gnomon task` (the loop)
 * and `gnomon check` both call classifyVerify, so the two cannot drift, and
 * replay re-derives a recorded verdict from the same function.
 *
 * Four verdicts:
 *   passed      exit 0. Nothing else is ever a pass: a map entry cannot make a
 *               non-zero exit pass, and cannot make exit 0 anything but passed.
 *   failed      the work is wrong. Handed back to the model.
 *   unrunnable  nothing was measured. Never handed back as "fix your code".
 *   regressed   measured, and worse than a baseline the check keeps. Recorded;
 *               handed back only when the surface sets regressed_hand_back.
 *
 * With nothing declared the table is the old one (0 passed, 126/127
 * unrunnable, a run that never exited unrunnable, anything else failed), so a
 * surface that does not opt in sees no change.
 */

export const VERIFY_VERDICTS = ["passed", "failed", "unrunnable", "regressed"] as const;
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number];

/** What a map entry may say: never "passed" (see above). */
export const EXIT_MAP_VERDICTS = ["failed", "unrunnable", "regressed"] as const;
export type ExitMapVerdict = (typeof EXIT_MAP_VERDICTS)[number];

/** exit code -> verdict, for the codes a tool uses to say something other than the default. */
export type ExitMap = Record<number, ExitMapVerdict>;

/**
 * Presets: `[verify] contract = "<name>"`. A published enumeration
 * (CONTRACTS.md section 52, conformance/verify_contract.json).
 *
 *   septacore  0 passed, 1 failed, 2 unrunnable, 3 regressed
 *   pytest     0 passed, 1 failed, 2 / 4 / 5 unrunnable (collection or usage
 *              error, nothing collected); 3 (internal error) stays failed
 */
export const VERIFY_CONTRACTS = {
  septacore: { 1: "failed", 2: "unrunnable", 3: "regressed" },
  pytest: { 1: "failed", 2: "unrunnable", 4: "unrunnable", 5: "unrunnable" },
} as const satisfies Record<string, ExitMap>;
export type VerifyContract = keyof typeof VERIFY_CONTRACTS;
export const VERIFY_CONTRACT_NAMES = Object.keys(VERIFY_CONTRACTS) as VerifyContract[];

/** The declared part of [verify] this module reads. */
export interface ExitMapDecl {
  /** The effective map: the preset, then the explicit entries over it. */
  exit_map?: ExitMap;
}

/**
 * Read `[verify] exit_map` and `contract` into one effective map, or undefined
 * when neither is declared. An entry that is not an integer code to a known
 * verdict is dropped here and named by auditVerifyKeys; a "0" entry and any
 * non-zero code mapped to "passed" are dropped too.
 */
export function resolveExitMap(raw: { exit_map?: unknown; contract?: unknown }): { map: ExitMap; contract?: VerifyContract } | undefined {
  const contract =
    typeof raw.contract === "string" && (VERIFY_CONTRACT_NAMES as string[]).includes(raw.contract)
      ? (raw.contract as VerifyContract)
      : undefined;
  const explicit = readExitMapEntries(raw.exit_map).valid;
  if (!contract && Object.keys(explicit).length === 0) return undefined;
  return { map: { ...(contract ? VERIFY_CONTRACTS[contract] : {}), ...explicit }, ...(contract ? { contract } : {}) };
}

/** The entries of a declared exit_map, split into those read and those not. */
export function readExitMapEntries(raw: unknown): { valid: ExitMap; ignored: Array<{ key: string; value: unknown; why: string }> } {
  const valid: ExitMap = {};
  const ignored: Array<{ key: string; value: unknown; why: string }> = [];
  if (raw === undefined) return { valid, ignored };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid, ignored: [{ key: "(exit_map)", value: raw, why: "exit_map is a table of exit code to verdict" }] };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{1,3}$/.test(key)) {
      ignored.push({ key, value, why: "the key is not an exit code (0 to 255)" });
    } else if (Number(key) === 0) {
      ignored.push({ key, value, why: "exit 0 is always passed" });
    } else if (value === "passed") {
      ignored.push({ key, value, why: "only exit 0 passes" });
    } else if (!(EXIT_MAP_VERDICTS as readonly unknown[]).includes(value)) {
      ignored.push({ key, value, why: `the verdict is one of ${EXIT_MAP_VERDICTS.join(", ")}` });
    } else {
      valid[Number(key)] = value as ExitMapVerdict;
    }
  }
  return { valid, ignored };
}

/** What a run of the declared command amounts to. */
export interface VerifyReading {
  verdict: VerifyVerdict;
  /** The shell's exit, or null when the run never reached one. */
  exit: number | null;
  /** True when the exit map (not the default table) decided it. */
  mapped: boolean;
}

/**
 * The verdict for one run, from readVerifyExit's reading (`exit`, `passed`)
 * and `notRun`: the tool ran nothing to an exit (timed out and killed, refused
 * by the sandbox or a rule), so nothing was measured. A status that cannot be
 * read from a run that did finish fails CLOSED as exit 1, and a run killed by
 * a signal keeps its exit of 1: an OOM-killed suite is not green.
 */
export function classifyVerify(
  run: { exit: number | null; passed: boolean; notRun: boolean },
  decl: ExitMapDecl | null | undefined
): VerifyReading {
  if (run.passed) return { verdict: "passed", exit: run.exit, mapped: false };
  if (run.notRun) return { verdict: "unrunnable", exit: null, mapped: false };
  const exit = run.exit ?? 1;
  const entry = decl?.exit_map?.[exit];
  if (entry) return { verdict: entry, exit, mapped: true };
  if (exit === 126 || exit === 127) return { verdict: "unrunnable", exit, mapped: false };
  return { verdict: "failed", exit, mapped: false };
}

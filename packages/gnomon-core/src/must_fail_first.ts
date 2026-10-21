/**
 * gnomon-core: the test-must-fail-first re-run, and reading a check's exit.
 *
 * Both lived inline in the turn loop (`prompt_loop.ts`, the [verify] gate), so
 * the only way to ask "does this new test pin anything?" was to have gnomon's
 * own loop write the test. `gnomon check` asks the same question of a change
 * some other harness made, from git alone -- and a second copy of this logic
 * would drift from the first on its first edit, which is the failure the
 * repository keeps measuring in its prose. One function, two callers.
 *
 * Nothing here decides WHETHER to run. The caller owns that: the loop runs it
 * only after [verify] passed with `test_must_fail_first` declared; `check` runs
 * it under the same rule. This module only does the re-run, and restores the
 * tree whatever happens.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import type { ResolvedVerify } from "./config.js";
import { globToRegExp, type ToolOutcome } from "./tools.js";

/**
 * What a file looked like before the change.
 *
 * A string is what the loop has always recorded (write/edit read the old text
 * to build their diff, and a file that did not exist reads as ""). A Buffer is
 * what `git show <base>:<path>` gives, which may not be text. `null` means the
 * file did not exist before the change: during the re-run it is removed, not
 * emptied -- an empty module and a missing one are different programs.
 */
export type PreImage = string | Buffer | null;

/** How a [verify] command's run reads, decided once for every caller. */
export interface VerifyExit {
  /** The shell's status, or null when there was none to read. */
  exit: number | null;
  /** Ran, and exited 0. Nothing else is a pass. */
  passed: boolean;
  /**
   * 126 / 127: not executable, not found. The check could not run, which is a
   * defect in the surface, not a verdict on the work.
   */
  unrunnable: boolean;
}

/**
 * Read a verify run's outcome.
 *
 * Fail CLOSED when the exit status cannot be read. bashTool reports TOOL_OK for
 * anything that ran, so a check killed by a signal came back as "bash — exit
 * null"; the old default read that as 0 and the gate reported PASSED. A
 * segfaulted suite was indistinguishable from a green one, in the one mechanism
 * whose job is to contradict a model that claims success.
 *
 * 126 and 127 are POSIX and tool-independent. Anything more specific would need
 * per-tool knowledge the harness does not have and should not guess at -- a
 * pytest collection error still reads as an ordinary failure, an honest limit.
 */
export function readVerifyExit(outcome: Pick<ToolOutcome, "code" | "summary">): VerifyExit {
  const exitMatch = /exit (-?\d+)/.exec(outcome.summary);
  const killed = /killed by /.test(outcome.summary);
  const exit = exitMatch ? Number(exitMatch[1]) : killed ? 1 : null;
  const passed = outcome.code === 0 && exitMatch !== null && exit === 0;
  return { exit, passed, unrunnable: exit === 126 || exit === 127 };
}

/** Is this repo-relative path a test, by the surface's own `test_paths`? */
export function isTestPath(testPaths: string[], rel: string): boolean {
  return testPaths.some((g) => {
    try {
      return globToRegExp(g).test(rel);
    } catch {
      // A glob that will not compile names no test. Treating it as matching
      // everything would make every source file a "test" and the check moot.
      return false;
    }
  });
}

export interface MustFailFirstResult {
  /** Whether the check was actually re-run against the pre-images. */
  ran: boolean;
  /** Re-run and still passed: the new or changed test pins nothing. */
  pinsNothing: boolean;
  /** Repo-relative test paths the change touched. */
  tests: string[];
  /** Repo-relative non-test paths put back to their pre-images for the re-run. */
  restored: string[];
  /** Why it did not run, when `ran` is false. */
  reason?: string;
}

/**
 * A test that would have passed BEFORE the change pins nothing.
 *
 * Meaningful only when the change wrote a test and something else: put every
 * non-test file back to its pre-image, run the same check again, and if it
 * still passes, the test does not depend on the change it claims to cover. T8
 * measured a model clearing that bar 1 time in 9, with three tests asserting
 * the bug itself -- so the cheapest honest guard is to re-run rather than ask.
 *
 * The tree is restored in a `finally`, byte for byte (read as Buffers, so a
 * non-UTF-8 file survives the round trip), whether the run passes, fails or
 * throws.
 *
 * `run` executes the verify command and returns its outcome. It is a parameter
 * because the two callers reach the shell differently -- the loop through its
 * own ToolContext (sandbox, exec, approval), `check` through one built from the
 * base surface -- and the re-run must go the way the first run went.
 */
export async function mustFailFirst(
  root: string,
  verify: Pick<ResolvedVerify, "command" | "test_paths">,
  preImages: Map<string, PreImage>,
  run: (command: string) => Promise<Pick<ToolOutcome, "code" | "summary">>
): Promise<MustFailFirstResult> {
  const rel = (abs: string) => relative(root, abs).split(sep).join("/");
  const isTest = (abs: string) => isTestPath(verify.test_paths, rel(abs));
  const tests = [...preImages.keys()].filter(isTest).map(rel);
  const sources = [...preImages.entries()].filter(([abs]) => !isTest(abs));
  const restored = sources.map(([abs]) => rel(abs));

  if (tests.length === 0) {
    return { ran: false, pinsNothing: false, tests, restored: [], reason: "the change touched no test" };
  }
  if (sources.length === 0) {
    // Only tests changed. With nothing to restore the re-run would be the
    // first run again; a characterisation test of existing behaviour is
    // legitimately green on both sides, so this says nothing either way.
    return {
      ran: false,
      pinsNothing: false,
      tests,
      restored: [],
      reason: "the change touched only tests — no other file to restore",
    };
  }

  const current = new Map<string, Buffer | null>(
    sources.map(([abs]) => [abs, existsSync(abs) ? readFileSync(abs) : null])
  );
  const put = (abs: string, content: string | Buffer | null) => {
    if (content === null) {
      if (existsSync(abs)) unlinkSync(abs);
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  try {
    for (const [abs, pre] of sources) put(abs, pre);
    const again = await run(verify.command);
    const stillPasses = again.code === 0 && /exit 0\b/.test(again.summary);
    return { ran: true, pinsNothing: stillPasses, tests, restored };
  } finally {
    for (const [abs, now] of current) put(abs, now);
  }
}

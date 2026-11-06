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

import { relative, sep } from "node:path";
import {
  CONTAINED_READONLY_DIRS,
  identityOf,
  readExactIn,
  removeIn,
  sameIdentity,
  writeFileIn,
  RootWriteError,
  type FileIdentity,
} from "./root_fs.js";
import { unsafeTreePath } from "./surface_tree.js";
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

/** gnomon's own directories, by name: the surface and every state dir. */
const OWN_DIRS = new Set<string>([...CONTAINED_READONLY_DIRS, ".gnomon-jobs", ".gnomon-out"]);

/**
 * Why host gnomon must not put a pre-image at `rel` (repo- or root-relative,
 * `/`-separated), or null when it may (eighth review).
 *
 * The pre-images come from `git diff <base>`, and the base is a commit the
 * model can make: its tree can hold `.git/config` (an fsmonitor the user's own
 * git then runs) or a `.gnomon/` other than the live one. Either, written for
 * the re-run, is in the tree for its length -- and for good after a SIGKILL
 * in that window. So: nothing with a `.git` component at any depth, nothing
 * `..` or absolute (surface_tree.ts), and nothing under the surface or a
 * gnomon state dir. A change to those is judged by the other checks; it is
 * never something the re-run needs to undo.
 */
export function unwritablePreImage(rel: string): string | null {
  const bad = unsafeTreePath(rel);
  if (bad) return bad;
  for (const part of rel.split("/")) {
    const folded = part.toLowerCase().replace(/[. ]+$/, "");
    if (OWN_DIRS.has(folded)) return `a path under gnomon's own ${part}/`;
  }
  return null;
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
  /**
   * Files NOT put back after the re-run because something replaced them
   * while it ran (the re-run executes the model's code): each says which and
   * why. The tree is left as that code left it, for a person to look at.
   */
  warnings?: string[];
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

  // Refused before anything is read or written: the loop's caller and
  // `check` both filter these, so one arriving here is a defect upstream.
  for (const abs of preImages.keys()) {
    const why = unwritablePreImage(rel(abs));
    if (why) {
      return { ran: false, pinsNothing: false, tests, restored: [], reason: `not re-run: ${rel(abs)} is ${why}; gnomon does not write it` };
    }
  }

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

  // The re-run puts files back and later restores them, as host gnomon, in a
  // tree the model's code has been writing (sixth review). Every source path
  // is read without following anything and must be a regular single-link
  // file (or absent); a symlink there made the pre-image land in ~/.bashrc and
  // the "current" copy read a credentials file into src/. Anything else
  // refuses the check rather than touching it.
  const current = new Map<string, { data: Buffer; mode: number } | null>();
  for (const [abs] of sources) {
    try {
      current.set(abs, readExactIn(root, abs));
    } catch (e) {
      if (!(e instanceof RootWriteError)) throw e;
      return { ran: false, pinsNothing: false, tests, restored: [], reason: `not re-run: ${e.message}` };
    }
  }
  const put = (abs: string, content: string | Buffer | null, mode?: number) => {
    if (content === null) removeIn(root, abs);
    else writeFileIn(root, abs, content, mode);
  };
  // What each path is after gnomon wrote it; compared before the restore.
  const placed = new Map<string, FileIdentity | null>();
  const warnings: string[] = [];
  try {
    for (const [abs, pre] of sources) {
      put(abs, pre, current.get(abs)?.mode);
      placed.set(abs, identityOf(abs));
    }
    const again = await run(verify.command);
    const stillPasses = again.code === 0 && /exit 0\b/.test(again.summary);
    // `warnings` is filled by the finally below, after this object is built.
    return { ran: true, pinsNothing: stillPasses, tests, restored, warnings };
  } finally {
    for (const [abs, now] of current) {
      // Not written (put threw first): nothing of gnomon's to undo there.
      if (!placed.has(abs)) continue;
      const was = placed.get(abs) ?? null;
      const is = identityOf(abs);
      if (!sameIdentity(was, is)) {
        warnings.push(`${rel(abs)} was replaced while the check re-ran; not restored (left as the re-run left it)`);
        continue;
      }
      try {
        put(abs, now ? now.data : null, now?.mode);
      } catch (e) {
        warnings.push(`${rel(abs)} could not be restored: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

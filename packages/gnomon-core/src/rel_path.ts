/**
 * Whether a relative path leaves the directory it is relative to.
 *
 * WHY. Every containment check in gnomon read `rel.startsWith("..")`, which
 * is also true of a NAME that begins with two dots. writeFileIn's temp file
 * for `.gitignore` is `..gitignore.<pid>.<hex>.tmp`, and on Linux the
 * descriptor's real path (/proc/self/fd) is checked against the root, so
 * every whole-file write of a dotfile -- `.gitignore`, `.env`, `.npmrc`,
 * `.eslintrc` -- was refused as "resolved outside the project root": the
 * edit and write tools failed with 11, and the `[verify]
 * test_must_fail_first` re-run, putting `.gitignore` back, threw out of the
 * turn and lost the run (dc1, 2026-11-12, react-lead-form). Kubernetes
 * mounts a ConfigMap through `..data`, and that was outside every root too.
 * Only the component `..` climbs.
 *
 * A leaf module (node:path and nothing else), so the guard's lean entry and
 * every checker can import it without pulling in anything that writes.
 */
import { isAbsolute, sep } from "node:path";

/**
 * True for `..` itself, for a path whose first component is `..`, and for an
 * absolute path (what path.relative returns for another drive on Windows).
 * Takes path.relative's output, or one re-joined with "/" (a git pathspec, a
 * record path): both separators are read on Windows, "/" alone elsewhere,
 * where `..\x` is an ordinary name. The empty path is the base itself, which
 * does not leave it; callers that mean "strictly below" test that apart.
 */
export function escapesBase(rel: string): boolean {
  return rel === ".." || rel.startsWith("../") || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

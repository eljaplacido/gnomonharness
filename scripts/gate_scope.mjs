#!/usr/bin/env node
/**
 * gate_scope — a gate that inspected nothing may not report success.
 *
 * THE BUG THIS EXISTS FOR, stated once because two different gates had it and
 * neither looked wrong: **a selector that matches nothing returns success.**
 *
 *   - `pnpm --filter gnomon-cli` matched nothing after the package was renamed
 *     `gnomon-harness` for npm. pnpm exits 0 when only SOME filters match, so
 *     three CI jobs kept exiting 0 while running three packages of four, and
 *     the CLI suite silently stopped running on windows-latest and
 *     macos-latest — the two platforms it exists to cover.
 *   - `.gnomon/ci.sh`'s portability gate used the git pathspec
 *     `benchmarks/**' + '/*.py`. A `**' + '/` pathspec requires an intermediate
 *     directory, so the five files that ARE the apparatus were never scanned:
 *     green over 98 files while 103 were in scope.
 *
 * Neither produced a wrong answer. Both reported success having checked less
 * than they claimed, which is worse than a failure — a red gate gets fixed and
 * a vacuous green one gets trusted. Both were found by an outside sweep rather
 * than by anything in this repository, months after they started.
 *
 * TWO MODES, and the order matters.
 *
 *   identity  The honest check. Compare what the gate selected against the set
 *             derived independently, and name every item the selector missed.
 *             Self-maintaining: it cannot go stale, and adding to the codebase
 *             raises the requirement automatically. Use it wherever the
 *             expected set can be computed some other way.
 *
 *   floor     The fallback, for sets with nothing to derive from. A smoke alarm
 *             for scope collapse, not an assertion about the codebase — set well
 *             below the real number so ordinary work never trips it. A floor at
 *             the current count fails on the first deleted test and gets
 *             switched off within a month, which is the reasoning
 *             scripts/coverage-floor.json already carries.
 *
 * A floor is the weaker instrument and this file says so where it uses one:
 * a floor of 90 would NOT have caught the 98-of-103 pathspec gap above. Only
 * the identity mode catches a partial miss. Prefer it.
 *
 * Usage:
 *   node scripts/gate_scope.mjs floor <gate-id> <actual-count>
 *   node scripts/gate_scope.mjs identity <label> --expected <file> --actual <file>
 *
 * Exit codes:
 *   0  the gate looked at enough
 *   1  it did not — the scope collapsed, or the floors file is malformed
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLOORS = join(HERE, "gate-scope-floors.json");

const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

function die(msg) {
  console.error(`${RED}❌ ${msg}${NC}`);
  process.exit(1);
}

/** Lines of a file, trimmed, blanks dropped. The shape both modes read. */
function lines(path) {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    die(`cannot read ${path} — ${String(e).slice(0, 120)}`);
  }
}

const [mode, label, ...rest] = process.argv.slice(2);

if (mode === "floor") {
  const actual = Number(rest[0]);
  if (!Number.isInteger(actual)) {
    // Not a number is not "zero". A gate whose count could not be parsed has
    // told us nothing, and treating that as a low count would report the wrong
    // failure -- the mistake scripts/coverage_gate.mjs already had to fix once.
    die(`${label}: scope count "${rest[0]}" is not an integer — the gate did not report a count.`);
  }

  let floors;
  try {
    floors = JSON.parse(readFileSync(FLOORS, "utf-8"));
  } catch (e) {
    die(`cannot read scripts/gate-scope-floors.json — ${String(e).slice(0, 120)}`);
  }

  const spec = floors[label];
  if (!spec || typeof spec.floor !== "number") {
    // Fail rather than skip. A gate asking about an id nobody declared is a
    // gate with no floor at all, and skipping silently is the same vacuous
    // green this whole file is about.
    die(
      `${label}: no floor declared in scripts/gate-scope-floors.json.\n` +
        `   Add one with a \`why\`, or stop calling scope() for this gate.`
    );
  }

  if (actual < spec.floor) {
    die(
      `${label}: inspected ${actual}, floor is ${spec.floor}.\n\n` +
        `   ${spec.why}\n\n` +
        `   This is a SCOPE failure, not a content failure: the gate found\n` +
        `   nothing wrong because it looked at less than it should have. Check\n` +
        `   whatever selects the set — a filter, a glob, a git pathspec — before\n` +
        `   assuming things were deleted. If the drop is deliberate, lower the\n` +
        `   floor in the same commit and say why.`
    );
  }
  console.log(`   scope: ${label} inspected ${actual} (floor ${spec.floor})`);
  process.exit(0);
}

if (mode === "identity") {
  const ei = rest.indexOf("--expected");
  const ai = rest.indexOf("--actual");
  if (ei === -1 || ai === -1) die("identity mode needs --expected <file> and --actual <file>");

  const expected = new Set(lines(rest[ei + 1]));
  const actual = new Set(lines(rest[ai + 1]));

  const missed = [...expected].filter((x) => !actual.has(x)).sort();

  if (expected.size === 0) {
    // The derivation itself came back empty, so there is nothing to compare
    // against and "0 of 0 match" would be the vacuous green in a new costume.
    die(
      `${label}: the EXPECTED set is empty, so this check proves nothing.\n` +
        `   Whatever derives the expected set is broken — fix that before reading\n` +
        `   the gate's verdict.`
    );
  }

  if (missed.length > 0) {
    die(
      `${label}: the gate's selector missed ${missed.length} of ${expected.size} item(s):\n` +
        missed.map((m) => `     ${m}`).join("\n") +
        `\n\n   The gate would have passed without looking at these. Fix the\n` +
        `   selector — this is the ${"`**/`"} pathspec and the stale ${"`--filter`"} bug\n` +
        `   shape, both of which read green for weeks.`
    );
  }

  // Extra is fine and deliberately not an error: a selector may legitimately
  // cover more than the derivation knows about. Only a MISS is a scope failure.
  console.log(`   scope: ${label} covered all ${expected.size} item(s)`);
  process.exit(0);
}

die(`unknown mode "${mode}" — expected "floor" or "identity"`);

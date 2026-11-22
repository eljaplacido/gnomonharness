/**
 * gnomon-core: `gnomon doctor verify`, run the declared check once (#235).
 *
 * `gnomon init` picks a command from marker files (detectVerifyCommand) and
 * never runs it. Measured in a cross-project test: one project's `pytest -q`
 * collected 0 tests (exit 5); another surface declared a Windows-only script
 * that exits 4 "NOT RUN" on Linux. Both looked like a working check until a
 * turn was handed their output.
 *
 * This runs the command the surface declares (or, with none, the one `init`
 * would detect) once, on the tree as it is, through the same bash tool and
 * sandbox the check runs in, read through the same table (verify_outcome.ts),
 * and says what it means. It is a separate command, never part of plain
 * `gnomon doctor`: that is read-only by construction, and this runs a command
 * that may write caches and build output. It does not run `[verify] setup`
 * (an install, possibly with network, is not a probe), and it says so.
 *
 * It writes nothing itself and changes no surface file.
 */

import { spawnSync } from "node:child_process";
import {
  detectVerifyCommand,
  loadConfig,
  resolveExec,
  resolveExtraRoots,
  resolveSandboxLevel,
  resolveVerify,
  workRootOf,
  type GnomonConfig,
} from "./config.js";
import { readVerifyRun } from "./must_fail_first.js";
import { toolTimeoutMs } from "./prompt_loop.js";
import { executeTool, type ToolContext, type ToolOutcome } from "./tools.js";
import { verifyContext } from "./verify_run.js";
import type { VerifyVerdict } from "./verify_outcome.js";

export const VERIFY_PROBE_SCHEMA = "gnomon.doctor_verify/1";

/** `gnomon doctor verify` exits: 0 ran and held up, 1 something to look at, 10 could not run. */
export const VERIFY_PROBE_EXIT = { clear: 0, attention: 1, couldNotRun: 10 } as const;

/** What a finding is about. A published enumeration (CONTRACTS section 52). */
export const VERIFY_PROBE_KINDS = ["not_declared", "unrunnable", "no_tests", "ambiguous_exit", "red_baseline", "dirty_tree", "setup_not_run"] as const;
export type VerifyProbeKind = (typeof VERIFY_PROBE_KINDS)[number];

export interface VerifyProbeFinding {
  kind: VerifyProbeKind;
  /** problem: the check will not do its job. info: worth knowing. */
  severity: "problem" | "info";
  message: string;
  fix?: string;
}

export interface VerifyProbeReport {
  schema: typeof VERIFY_PROBE_SCHEMA;
  dir: string;
  /** Where the command came from: the surface, init's detection, or nowhere. */
  source: "declared" | "detected" | "none";
  command: string | null;
  /** The shell's exit; null when it never reached one (or nothing ran). */
  exit: number | null;
  /** The verdict `gnomon task` would give this run; null when nothing ran. */
  verdict: VerifyVerdict | null;
  duration_ms: number;
  /** The last lines of the output of a run that did not hold up. */
  tail?: string;
  findings: VerifyProbeFinding[];
  exit_code: 0 | 1 | 10;
}

/** Output that says no test ran, whatever the exit. */
const NO_TESTS = [
  /\bcollected 0 items\b/i,
  /\bno tests ran\b/i,
  /\bno tests (were )?(found|collected)\b/i,
  /\bRan 0 tests\b/,
  /\b0 passing\b.*\b0 failing\b/is,
  /\bNo test files found\b/i,
  /\btest result: ok\. 0 passed; 0 failed\b/,
  /\[no test files\]/,
];

/** The exits tools use for "usage error" and "nothing collected", which the default table reads as a failure. */
const AMBIGUOUS_EXITS = new Set([4, 5]);

const tailOf = (text: string) => text.split("\n").slice(-12).join("\n").slice(-800);

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 10_000 });
  return r.status === 0 ? r.stdout : null;
}

export interface VerifyProbeDeps {
  /** Runs the command. Defaults to the bash tool in the surface's own sandbox. */
  run?: (command: string, ctx: ToolContext) => Promise<ToolOutcome>;
  now?: () => number;
}

/** Run the declared (or detected) check once and say what it means. */
export async function probeVerify(dir: string, deps: VerifyProbeDeps = {}): Promise<VerifyProbeReport> {
  const now = deps.now ?? Date.now;
  const report: VerifyProbeReport = {
    schema: VERIFY_PROBE_SCHEMA,
    dir,
    source: "none",
    command: null,
    exit: null,
    verdict: null,
    duration_ms: 0,
    findings: [],
    exit_code: VERIFY_PROBE_EXIT.clear,
  };
  const add = (f: VerifyProbeFinding) => report.findings.push(f);

  const config: GnomonConfig = loadConfig(dir);
  const root = workRootOf(config);
  const declared = resolveVerify(config);
  const detected = declared ? null : detectVerifyCommand(root);
  if (!declared && !detected) {
    report.exit_code = VERIFY_PROBE_EXIT.couldNotRun;
    add({
      kind: "not_declared",
      severity: "problem",
      message: "no [verify] command is declared, and the project's own check could not be detected: nothing checks a turn's work",
      fix: "declare [verify] command in .gnomon/policy.toml",
    });
    return report;
  }
  report.source = declared ? "declared" : "detected";
  report.command = declared?.command ?? detected!;
  const verify = declared ?? { command: detected! };

  if (declared?.setup) {
    add({
      kind: "setup_not_run",
      severity: "info",
      message: `[verify] setup (${declared.setup}) was not run: an install is not a probe. A fresh worktree runs it before the first check.`,
    });
  }
  const status = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  if (status !== null && status.trim() !== "") {
    add({ kind: "dirty_tree", severity: "info", message: "the tree has uncommitted changes, so this run reflects them, not a clean checkout" });
  }

  const exec = resolveExec(config);
  const ctx: ToolContext = {
    config,
    root,
    sandbox: resolveSandboxLevel(config),
    extraRoots: resolveExtraRoots(config),
    exec,
    network: exec.network,
    // The surface's own command, run by nobody to ask: the declared check is
    // not a model action, as in the loop and in `gnomon check`.
    gate: "never",
    approve: async () => false,
    timeoutMs: toolTimeoutMs(config),
    maxOutputBytes: 32_000,
    allow: "strict",
  };
  const vctx = verifyContext(ctx, declared ?? {});
  const run = deps.run ?? ((command: string, c: ToolContext) => executeTool("bash", { command }, c, new Set(["bash"])));
  const t0 = now();
  const out = await run(report.command, vctx);
  report.duration_ms = now() - t0;

  const read = readVerifyRun(out, declared);
  report.exit = read.notRun ? null : (read.exit ?? 1);
  report.verdict = read.verdict;

  if (read.verdict === "unrunnable") {
    const why = read.notRun ? out.summary.replace(/^bash — /, "") : `exit ${read.exit}`;
    report.tail = tailOf(out.content);
    add({
      kind: "unrunnable",
      severity: "problem",
      message: `the check could not run (${why}): a turn would never be checked, and this is not the work's fault`,
      fix: "install the project's dependencies (or declare [verify] setup), fix the command, or name the exit code in [verify.exit_map]",
    });
  } else if (read.verdict === "passed") {
    if (NO_TESTS.some((re) => re.test(out.content))) {
      report.tail = tailOf(out.content);
      add({
        kind: "no_tests",
        severity: "problem",
        message: "the check exits 0 but its output says no test ran: it would pass any change",
        fix: "point [verify] command at a suite that collects tests",
      });
    }
  } else {
    report.tail = tailOf(out.content);
    const exit = read.exit ?? 1;
    if (!read.mapped && AMBIGUOUS_EXITS.has(exit)) {
      add({
        kind: "ambiguous_exit",
        severity: "problem",
        message:
          `the check exits ${exit}, which tools use for a usage error or "nothing collected" (pytest 4 and 5, a script's "NOT RUN"), ` +
          `and gnomon reads as a failure of the work: a turn would be handed this output and rewrite correct code`,
        fix: 'declare [verify] contract = "pytest" (or "septacore"), or [verify.exit_map] with this exit set to "unrunnable"',
      });
    } else if (read.verdict === "regressed") {
      add({
        kind: "red_baseline",
        severity: "problem",
        message: `the check reports a regression (exit ${exit}) on the tree as it is`,
        fix: "fix the baseline first: every turn will be measured against it",
      });
    } else {
      add({
        kind: "red_baseline",
        severity: "problem",
        message: `the check fails (exit ${exit}) on the tree as it is, so every turn would be handed this failure`,
        fix: "fix the failing check on a clean tree first, or declare the right command",
      });
    }
  }

  report.exit_code = report.findings.some((f) => f.severity === "problem") ? VERIFY_PROBE_EXIT.attention : VERIFY_PROBE_EXIT.clear;
  return report;
}

/** The report as lines, for the terminal. */
export function formatVerifyProbe(r: VerifyProbeReport): string[] {
  const out: string[] = [];
  if (r.command) {
    out.push(`check: ${r.command}   (${r.source})`);
    out.push(
      r.verdict === null
        ? "result: did not run"
        : `result: ${r.verdict}${r.exit === null ? " (never reached an exit)" : ` (exit ${r.exit})`} in ${(r.duration_ms / 1000).toFixed(1)}s`
    );
  }
  for (const f of r.findings) {
    out.push(`${f.severity === "problem" ? "problem" : "note"}: ${f.message}`);
    if (f.fix) out.push(`  fix: ${f.fix}`);
  }
  if (r.tail && r.findings.some((f) => f.severity === "problem")) {
    out.push("last output:");
    for (const l of r.tail.split("\n")) out.push(`  ${l}`);
  }
  if (r.findings.length === 0) out.push("The check runs, and passes on this tree.");
  return out;
}

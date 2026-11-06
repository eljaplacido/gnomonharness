/**
 * Soft-timeout shell: a bash command that outlives the tool timeout is handed
 * back as a job, not killed. docs/CONTRACTS.md §34, conformance/soft_shell.json.
 *
 * Opt-in, one key: tools.toml `[[tools]] name = "bash"`, `soft_timeout`.
 *
 * | value | at the timeout |
 * |---|---|
 * | `kill` (default, and absent) | the command is killed, as it always was |
 * | `handle` | the command keeps running as job `jN`; the result carries the output so far, and a `job` tool is offered beside `bash` to wait on it, write to its stdin or kill it |
 *
 * Why. The research notes (2026-11-05, reverse-engineering 01 and 02) found
 * every peer that does well on long tasks refuses to cut a long command short:
 * Codex yields a session handle after 10 s and lets the model poll up to
 * 300 s at a time; opencode backgrounds the command and wakes the session;
 * OpenHands returns after 30 s of no output with the process still running.
 * gnomon kills at 120 s and refuses an identical re-run, so a build or test
 * suite longer than the limit can only be run through a hand-written
 * `setsid … &` recipe and polled with `sleep` calls. This lets the long tail
 * be tested as a surface change rather than a code branch.
 *
 * Absent or `kill`, nothing here runs and every request body is master's
 * (soft_shell.test.ts holds the pinned hashes of sweep_knobs.test.ts).
 *
 * Pure: the bash tool and the loop own the processes; this module says what a
 * setting resolves to, what the `job` tool takes, and how a result is framed.
 */
import type { GnomonConfig } from "./config.js";

/** tools.toml `[[tools]] name = "bash"` → `soft_timeout`. */
export const SOFT_TIMEOUT_MODES = ["kill", "handle"] as const;
export type SoftTimeoutMode = (typeof SOFT_TIMEOUT_MODES)[number];

/** The declaration the key is read on. */
export const SOFT_TIMEOUT_KEY = "soft_timeout";

/** The tool offered beside `bash` under `soft_timeout = "handle"`. */
export const JOB_TOOL = "job";

/** What `job` does. */
export const JOB_ACTIONS = ["wait", "send", "kill"] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

/** Control keys `job send` takes: an interrupt to the job, and end of input. */
export const JOB_KEYS = ["ctrl-c", "ctrl-d"] as const;
export type JobKey = (typeof JOB_KEYS)[number];

/**
 * The fixed numbers. Not declarable: one knob, so a sweep arm is one change.
 *
 * - `max_jobs`: jobs running at once. A fourth long command is refused, named,
 *   until one finishes or is killed. Codex allows 64 sessions; three is enough
 *   for a build, a server and a test run, and bounds what a turn can leave
 *   running for the turn-end cleanup to stop.
 * - `wait_max_seconds`: the longest one `wait` blocks (Codex's
 *   `background_terminal_max_timeout`).
 * - `wait_default_seconds`, `send_default_seconds`: when `seconds` is absent.
 * - `buffer_bytes`: per stream, per job. Output past it that nobody has read
 *   yet is dropped from the oldest end, and the next report says how much.
 */
export const JOB_LIMITS = Object.freeze({
  max_jobs: 3,
  wait_max_seconds: 300,
  wait_default_seconds: 30,
  send_default_seconds: 2,
  buffer_bytes: 1_000_000,
});

/** Audit kind `job`, `event`: what happened to a job. */
export const JOB_EVENTS = ["yield", "send", "exit", "kill"] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];

/** Why a job was killed: the model asked, the turn ended, or it was cancelled (Esc, `--deadline`). */
export const JOB_KILL_REASONS = ["model", "turn_end", "cancelled"] as const;
export type JobKillReason = (typeof JOB_KILL_REASONS)[number];

/** The mode this surface declares; anything but `handle` is `kill`. */
export function resolveSoftTimeout(config: GnomonConfig): SoftTimeoutMode {
  const decl = (config.tools?.tools ?? []).find((t) => t.name === "bash") as { soft_timeout?: unknown } | undefined;
  return decl?.soft_timeout === "handle" ? "handle" : "kill";
}

/** The `job` tool's description: the only place the model is told how jobs work. */
export const JOB_DESCRIPTION =
  "Manage a bash command that is still running. A bash command that runs past the tool timeout is " +
  "not killed: it keeps running as a job, and the bash result names its id (j1, j2, ...). " +
  `"wait": block up to \`seconds\` (at most ${JOB_LIMITS.wait_max_seconds}, default ${JOB_LIMITS.wait_default_seconds}) ` +
  "until it finishes; returns the output it printed since you last looked, and its exit code once it has finished. " +
  `"send": write \`input\` to its stdin (end a line with \\n), or send \`key\` "ctrl-c" (interrupt) or "ctrl-d" ` +
  `(end of input), then return what it printed within \`seconds\` (default ${JOB_LIMITS.send_default_seconds}). ` +
  `"kill": stop it. At most ${JOB_LIMITS.max_jobs} jobs run at once, and every job still running when your turn ends is killed.`;

/** The `job` tool's parameters. */
export const JOB_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...JOB_ACTIONS], description: "wait, send or kill" },
    id: { type: "string", description: "The job id a bash result gave, e.g. j1" },
    seconds: {
      type: "integer",
      description: `How long to wait for output or the exit, at most ${JOB_LIMITS.wait_max_seconds}.`,
    },
    input: { type: "string", description: "send: text written to the job's stdin, verbatim" },
    key: { type: "string", enum: [...JOB_KEYS], description: "send: ctrl-c interrupts the job, ctrl-d closes its stdin" },
  },
  required: ["action", "id"],
};

/** Whole seconds, one decimal: what the framing says. */
export function wallSeconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

/** Lines in a stream as printed: a last line without a newline still counts. */
export function countLines(text: string): number {
  if (text === "") return 0;
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n : n + 1;
}

/**
 * The header every bash and job result carries under `handle`, Codex's
 * framing: `Exit code`, `Wall time`, `Total output lines` (over the whole run
 * of the command, both streams). A running job says so, and its id, instead
 * of an exit code. Kill mode's results carry none, so they stay master's.
 */
export function frameHeader(f: {
  exit?: number | null;
  signal?: string | null;
  running?: string;
  wallMs: number;
  lines: number;
}): string {
  const status =
    f.running !== undefined
      ? `Job: ${f.running} (still running, not killed)`
      : typeof f.exit === "number"
        ? `Exit code: ${f.exit}`
        : `Exit code: none (killed by ${f.signal ?? "a signal"})`;
  return `${status}\nWall time: ${wallSeconds(f.wallMs)} seconds\nTotal output lines: ${f.lines}\n`;
}

/** What a running job's result tells the model it can do next. */
export function runningHint(id: string): string {
  return (
    `\n\nThe command is still running as job ${id}. Its output so far is above. Next: ` +
    `job {"action":"wait","id":"${id}","seconds":${JOB_LIMITS.wait_default_seconds}} for more output and its exit code ` +
    `(up to ${JOB_LIMITS.wait_max_seconds} s per call), ` +
    `job {"action":"send","id":"${id}","input":"...\\n"} to answer a prompt, ` +
    `or job {"action":"kill","id":"${id}"}. Other tools can be used meanwhile; it is killed when your turn ends.`
  );
}

/** A surface finding, in auditSurface's shape. */
export interface SoftShellProblem {
  where: string;
  problem: string;
  fix: string;
  fatal: boolean;
}

/**
 * What is wrong with a declared `soft_timeout`, for auditSurface.
 *
 * Strict: a value that is not one of SOFT_TIMEOUT_MODES, or the key on a
 * declaration that does not read it, is FATAL -- the session does not start.
 * A typo (`"handel"`, `soft_timeout` on `read`) would otherwise run the arm
 * as the default while the surface, and its hash, claimed the knob was set.
 * Only a stray `job` declaration is a warning: master ignored it as
 * unimplemented, and it still asks for nothing.
 */
export function auditSoftShell(config: GnomonConfig): SoftShellProblem[] {
  const out: SoftShellProblem[] = [];
  for (const t of config.tools?.tools ?? []) {
    const where = `.gnomon/tools.toml [[tools]] name = "${t.name}"`;
    if (t.name === JOB_TOOL) {
      out.push({
        where,
        problem:
          `"${JOB_TOOL}" is not declared: it is offered beside bash when bash declares soft_timeout = "handle", ` +
          `to every role holding bash, and this declaration does nothing.`,
        fix: `Remove it, and declare soft_timeout = "handle" on bash.`,
        fatal: false,
      });
    }
    const v = (t as { soft_timeout?: unknown }).soft_timeout;
    if (v === undefined) continue;
    if (t.name !== "bash") {
      out.push({
        where,
        problem: `soft_timeout is read on the bash declaration only; on ${t.name} it would do nothing, so the session does not start.`,
        fix: "Remove it, or declare it on bash.",
        fatal: true,
      });
    } else if (!(SOFT_TIMEOUT_MODES as readonly unknown[]).includes(v)) {
      out.push({
        where,
        problem:
          `soft_timeout = ${JSON.stringify(v)} is not one of ${SOFT_TIMEOUT_MODES.join(", ")}. ` +
          `Refused rather than run as "kill" under a surface that says otherwise.`,
        fix: `soft_timeout = "handle" (or "kill", the default)`,
        fatal: true,
      });
    }
  }
  return out;
}

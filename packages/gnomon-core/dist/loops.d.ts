/** Where a loop's runtime state lives. Sibling of `.gnomon/`, never inside. */
export declare const LOOP_STATE_DIR = ".gnomon-loops";
/**
 * A guard compares its command's stdout to a threshold. `exit_nonzero` looks
 * at the exit status instead, for commands that signal by status rather than
 * by printing a number.
 */
export type GuardOp = "gt" | "ge" | "lt" | "le" | "eq" | "ne" | "exit_nonzero";
export interface LoopGuard {
    /** Shell command. Its stdout is parsed as a number unless op is exit_nonzero. */
    run: string;
    /** e.g. "gt 12". Absent means the guard always trips. */
    act_when?: string;
    /** Seconds before the guard is abandoned. A hung guard must not wedge cron. */
    timeout_sec?: number;
}
export interface LoopAct {
    /**
     * Deterministic remediation. Preferred: it is reproducible, auditable, and
     * free. Most supervision ("restart it", "reap them") needs nothing more.
     */
    run?: string;
    /**
     * Escalate to the model. Only reached when the guard tripped, so the cost is
     * paid on exception rather than on schedule.
     */
    task?: string;
    timeout_sec?: number;
}
export interface LoopLimits {
    /**
     * Consecutive ACTION failures before the loop stops acting entirely. Without
     * this, a loop whose remediation cannot work retries forever — which is how
     * an automation that was supposed to clean up runaway processes becomes one.
     */
    max_consecutive_failures?: number;
    /** Ceiling on actions per rolling hour. Ticks that skip do not count. */
    max_runs_per_hour?: number;
}
export interface LoopDef {
    name: string;
    /** "5m" | "2h" | "1d". Cron's floor is one minute. */
    every: string;
    /** Role whose write_allow/bash_deny confine an escalated task. */
    role?: string;
    description?: string;
    guard?: LoopGuard;
    act: LoopAct;
    limits: LoopLimits;
}
export interface LoopState {
    consecutive_failures: number;
    /** Epoch ms of actions taken, for the rolling-hour ceiling. */
    action_times: number[];
    /** Set once the breaker opens. Cleared only by `gnomon loop reset`. */
    tripped: boolean;
    last_tick?: string;
    last_outcome?: string;
}
/** What a single tick did. Mirrors gnomon's three outcome buckets. */
export type TickOutcome = "skipped" | "acted" | "act_failed" | "guard_failed" | "rate_limited" | "breaker_open";
export interface TickResult {
    loop: string;
    outcome: TickOutcome;
    guardValue?: number | null;
    detail?: string;
}
/**
 * Read every `.gnomon/loops/*.toml`. Missing directory is not an error — most
 * projects declare no loops, and that must stay a zero-cost default.
 */
export declare function loadLoops(gnomonDir: string): LoopDef[];
export declare function readState(root: string, name: string): LoopState;
export declare function writeState(root: string, name: string, s: LoopState): void;
/** Parse "gt 12" and compare. An unparsable spec trips nothing. */
export declare function guardTrips(spec: string | undefined, value: number | null, exitCode: number): boolean;
/**
 * Run one tick.
 *
 * Order matters: breaker, then rate limit, then guard, then action. Checking
 * the guard first would let a tripped breaker still pay for the guard every
 * five minutes, and a guard that shells out to another host is not free.
 */
export declare function runTick(root: string, loop: LoopDef, opts?: {
    dryRun?: boolean;
}): TickResult;
/** "5m" | "90m" | "2h" | "1d" → a crontab schedule. */
export declare function cronExpr(every: string): string;
/** One crontab line gnomon installed: which loop, and which project declared it. */
export interface InstalledLoop {
    name: string;
    /**
     * The project root the line runs in, read back from its own `cd "<root>"`.
     * `null` only for a line carrying the marker without one — which gnomon
     * never writes, so it means a human edited the crontab by hand.
     */
    root: string | null;
}
/**
 * Read one crontab line back into the loop it schedules.
 *
 * The name is taken from the marker to the END OF LINE, not by substring
 * search, and the root is recovered from the `cd` the line already carries.
 * Both matter, and both were wrong:
 *
 *   - `l.includes(CRON_MARK + name)` is a prefix test. With `tidy` and
 *     `tidy-up` both installed, `uninstallLoop("tidy")` matched the line for
 *     `tidy-up` as well and removed both.
 *   - The name alone is not an identity. crontab is machine-wide and the root
 *     was discarded, so every loop in every project shared one namespace:
 *     `loop status` in project B reported project A's loops as DRIFT and
 *     exited 1, and `loop install tidy` in B silently deleted A's `tidy`
 *     line — the filter that clears the old entry before writing the new one
 *     matched across projects too.
 *
 * The line format is written by `installLoop` below and has always begun
 * `<schedule> cd "<root>" && …`, so the root is recoverable from every line
 * gnomon has ever installed. The quoting is `JSON.stringify`'s, so it is
 * parsed back the same way rather than by unescaping it by hand.
 */
export declare function parseCronLine(line: string): InstalledLoop | null;
/** Every gnomon loop line in this machine's crontab, with the project each belongs to. */
export declare function installedLoopEntries(): InstalledLoop[];
/**
 * Loop names in this machine's crontab.
 *
 * With `root`, only the ones that project installed — plus any line carrying
 * the marker with no recoverable root, which cannot be attributed to another
 * project and so must not be hidden from this one. Without `root`, every one
 * on the machine.
 */
export declare function installedLoops(root?: string): string[];
/** Machine-local environment for loops. Gitignored, never in the surface. */
export declare const LOOP_ENV_FILE = "env";
/**
 * Write the crontab line.
 *
 * cron does not run a login shell. Three things that hold in an interactive
 * terminal do not hold here, and all three were live bugs:
 *
 *   - `node` on cron's PATH is the SYSTEM node (v18 here), not the nvm one
 *     that can run this workspace. `gnomonBin` must therefore be an absolute
 *     interpreter path, not the word "node".
 *   - The CLI entry is TypeScript. Pointing cron at src/index.ts gave
 *     ERR_UNKNOWN_FILE_EXTENSION every five minutes; the caller must pass the
 *     gnomon.js launcher, which sets tsx up first.
 *   - Nothing the operator exported is present. Anything a guard needs -- a
 *     host address, a token -- has to come from `.gnomon-loops/env`, which is
 *     machine-scoped and gitignored precisely so it stays out of the surface.
 */
export declare function installLoop(root: string, loop: LoopDef, gnomonBin: string): string;
/**
 * Remove a loop's crontab line.
 *
 * `root` scopes it to one project. Omitting it removes every line for that
 * name on the machine, which is what the machine-wide stop wants and what
 * every caller used to get whether it wanted it or not.
 */
export declare function uninstallLoop(name: string, root?: string): boolean;
//# sourceMappingURL=loops.d.ts.map
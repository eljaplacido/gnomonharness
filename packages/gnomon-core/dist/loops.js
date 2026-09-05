/**
 * Loops: session-independent supervision.
 *
 * A loop is a trigger, a guard, and an action. It is deliberately NOT a
 * workflow engine — no DAGs, no inter-loop dependencies, no retry graphs.
 * Everything past "run this when that is true" belongs in a task.
 *
 * Three properties shape the design.
 *
 * 1. NO DAEMON. The OS scheduler invokes gnomon fresh and gnomon exits. There
 *    is no resident process, so an idle loop costs nothing — no memory, no
 *    latency on interactive runs. A supervisor that must itself be supervised
 *    is not a supervisor.
 *
 * 2. THE GUARD IS DETERMINISTIC. Every tick runs a shell predicate first. If
 *    it does not trip, the tick ends having spent zero tokens and no model
 *    call. Waking a model every five minutes to ask "is anything wrong" is
 *    both expensive and non-reproducible; `wc -l` answers it exactly. Only a
 *    tripped guard may escalate to `[act] task`.
 *
 * 3. DECLARATION AND MATERIALIZATION ARE SEPARATE. `.gnomon/loops/*.toml` says
 *    WHAT loops — it is content-hashed, committed, and portable. The crontab
 *    entry says HOW THIS MACHINE schedules it, and never enters the surface.
 *    That split is what keeps Rule 1 (no machine-scoped config in the surface)
 *    intact; `loopStatus()` reconciles the two the way surfaceDrift() does.
 *
 * Loop STATE (failure counts, rate-limit history) lives in `.gnomon-loops/`,
 * a sibling of `.gnomon/` — the same convention `.gnomon-sessions/` uses.
 * collectSurface() walks `.gnomon/` only, so state cannot perturb the hash.
 * Putting it inside would make the surface hash change every tick, which is
 * the one thing that must never happen.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { parseToml } from "./config.js";
import { tmpdir } from "node:os";
import { posixShell, NO_POSIX_SHELL } from "./tools.js";
/** Where a loop's runtime state lives. Sibling of `.gnomon/`, never inside. */
export const LOOP_STATE_DIR = ".gnomon-loops";
/** Marker appended to crontab lines so we can find and remove only our own. */
const CRON_MARK = "# gnomon-loop:";
// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
/**
 * Read every `.gnomon/loops/*.toml`. Missing directory is not an error — most
 * projects declare no loops, and that must stay a zero-cost default.
 */
export function loadLoops(gnomonDir) {
    const dir = join(gnomonDir, "loops");
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".toml")).sort()) {
        const raw = parseToml(readFileSync(join(dir, file), "utf-8"));
        // Accept both a bare table and a [loop] header. The header reads better
        // beside [guard] and [act], but requiring it is a papercut for no gain.
        const body = (raw.loop ?? raw);
        const name = body.name ?? file.replace(/\.toml$/, "");
        const act = (raw.act ?? {});
        if (!act.run && !act.task) {
            throw new Error(`loop "${name}": needs [act] run or [act] task`);
        }
        if (!body.every) {
            throw new Error(`loop "${name}": needs "every"`);
        }
        out.push({
            name,
            every: String(body.every),
            role: body.role,
            description: body.description,
            guard: raw.guard,
            act,
            limits: (raw.limits ?? {}),
        });
    }
    return out;
}
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function stateFile(root, name) {
    return join(root, LOOP_STATE_DIR, `${name}.json`);
}
export function readState(root, name) {
    const f = stateFile(root, name);
    if (!existsSync(f)) {
        return { consecutive_failures: 0, action_times: [], tripped: false };
    }
    try {
        return JSON.parse(readFileSync(f, "utf-8"));
    }
    catch {
        // A corrupt state file must not wedge the loop forever. Losing the failure
        // count is survivable; refusing to ever run again is not.
        return { consecutive_failures: 0, action_times: [], tripped: false };
    }
}
export function writeState(root, name, s) {
    const dir = join(root, LOOP_STATE_DIR);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile(root, name), JSON.stringify(s, null, 2));
}
// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
/**
 * Run a shell command, capped. Returns stdout and exit status rather than
 * throwing: a guard that exits non-zero is a legitimate signal, not a crash.
 */
function sh(cmd, timeoutSec) {
    // The same POSIX shell the `bash` tool uses, for the same reason: a loop's
    // guard and act commands are declared in the surface, and a surface that
    // means one language here and another there is machine-scoped behaviour the
    // hash cannot see. On a Windows box with no POSIX shell this reports a
    // failure rather than running the command under cmd.exe.
    const shell = posixShell();
    if (shell === null) {
        return { code: 127, out: "", err: NO_POSIX_SHELL };
    }
    try {
        const out = execFileSync(shell, ["-lc", cmd], {
            encoding: "utf-8",
            timeout: timeoutSec * 1000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, out: out.trim(), err: "" };
    }
    catch (e) {
        const err = e;
        // execFileSync reports a timeout as status:null + signal:"SIGTERM"; `killed`
        // is set on spawnSync's RESULT, not on the thrown error, so testing it
        // alone let every timeout fall through as a plain exit-1. Report 124 so
        // guard_failed stays distinguishable from a guard that answered "no".
        const timedOut = Boolean(err.killed) || (err.status == null && Boolean(err.signal));
        // stderr is the only place a failing guard says WHY. Discarding it left
        // "guard exit 255:" with an empty message -- an unattended supervisor
        // reporting that something is wrong and refusing to say what.
        return {
            code: timedOut ? 124 : (err.status ?? 1),
            out: (err.stdout ?? "").toString().trim(),
            err: (err.stderr ?? "").toString().trim(),
        };
    }
}
/** Parse "gt 12" and compare. An unparsable spec trips nothing. */
export function guardTrips(spec, value, exitCode) {
    if (!spec)
        return true;
    const [op, rhsRaw] = spec.trim().split(/\s+/, 2);
    if (op === "exit_nonzero")
        return exitCode !== 0;
    const rhs = Number(rhsRaw);
    if (value === null || Number.isNaN(rhs))
        return false;
    switch (op) {
        case "gt": return value > rhs;
        case "ge": return value >= rhs;
        case "lt": return value < rhs;
        case "le": return value <= rhs;
        case "eq": return value === rhs;
        case "ne": return value !== rhs;
        default: return false;
    }
}
/**
 * Run one tick.
 *
 * Order matters: breaker, then rate limit, then guard, then action. Checking
 * the guard first would let a tripped breaker still pay for the guard every
 * five minutes, and a guard that shells out to another host is not free.
 */
export function runTick(root, loop, opts = {}) {
    const state = readState(root, loop.name);
    const now = Date.now();
    if (state.tripped) {
        return {
            loop: loop.name,
            outcome: "breaker_open",
            detail: `open after ${state.consecutive_failures} consecutive failures; clear with \`gnomon loop reset ${loop.name}\``,
        };
    }
    const perHour = loop.limits.max_runs_per_hour;
    const recent = state.action_times.filter((t) => now - t < 3_600_000);
    if (perHour !== undefined && recent.length >= perHour) {
        return { loop: loop.name, outcome: "rate_limited", detail: `${recent.length}/${perHour} actions this hour` };
    }
    // --- guard -------------------------------------------------------------
    let value = null;
    if (loop.guard) {
        const g = sh(loop.guard.run, loop.guard.timeout_sec ?? 60);
        // A guard timeout is apparatus failure, not evidence. Reporting "nothing
        // wrong" because we could not look is how a supervisor goes quietly blind.
        if (g.code === 124) {
            return { loop: loop.name, outcome: "guard_failed", detail: "guard timed out" };
        }
        // Number("") is 0, not NaN. Parsing empty output as a number therefore
        // reported a guard that printed NOTHING -- because it crashed, or was
        // killed -- as the reading 0, which against "gt 0" reads as "all clear".
        // A supervisor that says healthy precisely when it has gone blind is worse
        // than no supervisor. Empty output is an absent reading, not a zero.
        const token = g.out.split(/\s+/).pop() ?? "";
        const n = token === "" ? Number.NaN : Number(token);
        value = Number.isNaN(n) ? null : n;
        if (loop.guard.act_when !== "exit_nonzero" && g.code !== 0 && value === null) {
            return { loop: loop.name, outcome: "guard_failed", detail: `guard exit ${g.code}: ${(g.err || g.out).slice(0, 300)}` };
        }
        if (!guardTrips(loop.guard.act_when, value, g.code)) {
            state.last_tick = new Date(now).toISOString();
            state.last_outcome = "skipped";
            // A clean skip is the loop working. Clear the failure streak so a past
            // incident does not leave the breaker one tick from opening forever.
            state.consecutive_failures = 0;
            if (!opts.dryRun)
                writeState(root, loop.name, state);
            return { loop: loop.name, outcome: "skipped", guardValue: value };
        }
    }
    if (opts.dryRun) {
        return { loop: loop.name, outcome: "acted", guardValue: value, detail: "DRY RUN — action not executed" };
    }
    // --- act ---------------------------------------------------------------
    let outcome;
    let detail = "";
    if (loop.act.run) {
        const a = sh(loop.act.run, loop.act.timeout_sec ?? 300);
        outcome = a.code === 0 ? "acted" : "act_failed";
        detail = (a.code === 0 ? a.out : (a.err || a.out)).slice(0, 500);
    }
    else {
        // Model escalation is deliberately not wired into this slice: it needs a
        // role, a budget, and an audit record, and shipping it half-done is how a
        // loop starts spending money nobody is watching.
        outcome = "act_failed";
        detail = "[act] task not implemented in this slice; use [act] run";
    }
    state.action_times = [...recent, now];
    state.last_tick = new Date(now).toISOString();
    state.last_outcome = outcome;
    if (outcome === "acted") {
        state.consecutive_failures = 0;
    }
    else {
        state.consecutive_failures += 1;
        const max = loop.limits.max_consecutive_failures ?? 3;
        if (state.consecutive_failures >= max)
            state.tripped = true;
    }
    writeState(root, loop.name, state);
    return { loop: loop.name, outcome, guardValue: value, detail };
}
// ---------------------------------------------------------------------------
// Materialization (machine-scoped — never part of the surface)
// ---------------------------------------------------------------------------
/** "5m" | "90m" | "2h" | "1d" → a crontab schedule. */
export function cronExpr(every) {
    const m = /^(\d+)([mhd])$/.exec(every.trim());
    if (!m)
        throw new Error(`bad "every": ${every} (use 5m, 2h, 1d)`);
    const n = Number(m[1]);
    if (n < 1)
        throw new Error(`bad "every": ${every}`);
    if (m[2] === "m") {
        // Cron cannot express periods that do not divide an hour: */90 in the
        // minute field means "every 90 minutes past each hour", i.e. never past 59.
        if (n > 59)
            throw new Error(`"every" in minutes must be < 60 (got ${every}); use hours`);
        return `*/${n} * * * *`;
    }
    if (m[2] === "h") {
        if (n > 23)
            throw new Error(`"every" in hours must be < 24 (got ${every}); use days`);
        return `0 */${n} * * *`;
    }
    return `0 0 */${n} * *`;
}
function crontabRead() {
    const r = sh("crontab -l 2>/dev/null || true", 15);
    return r.out;
}
function crontabWrite(text) {
    if (process.platform === "win32") {
        // Refused rather than half-done. Windows schedules with Task Scheduler, not
        // crontab, and pretending otherwise would leave an operator believing a
        // loop was installed when nothing was.
        throw new Error("gnomon loops are scheduled with cron, which Windows does not have.\n" +
            "The loop itself runs fine here -- `gnomon loops run <name>` works -- but " +
            "installing it on a schedule does not.\n" +
            "Schedule it yourself with Task Scheduler, invoking:\n" +
            "    gnomon loops run <name>");
    }
    const tmp = join(process.env.TMPDIR ?? tmpdir(), `gnomon-cron-${process.pid}`);
    writeFileSync(tmp, text.endsWith("\n") ? text : text + "\n");
    execFileSync(posixShell() ?? "/bin/sh", ["-lc", `crontab ${JSON.stringify(tmp)} && rm -f ${JSON.stringify(tmp)}`], {
        stdio: ["ignore", "pipe", "pipe"],
    });
}
/** Every loop name currently present in this machine's crontab. */
export function installedLoops() {
    return crontabRead()
        .split("\n")
        .filter((l) => l.includes(CRON_MARK))
        .map((l) => l.slice(l.indexOf(CRON_MARK) + CRON_MARK.length).trim())
        .filter(Boolean);
}
/** Machine-local environment for loops. Gitignored, never in the surface. */
export const LOOP_ENV_FILE = "env";
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
export function installLoop(root, loop, gnomonBin) {
    const envFile = join(root, LOOP_STATE_DIR, LOOP_ENV_FILE);
    // `set -a` exports everything the file defines, so a plain KEY=value works.
    const srcEnv = `[ -f ${JSON.stringify(envFile)} ] && set -a && . ${JSON.stringify(envFile)} && set +a;`;
    const line = `${cronExpr(loop.every)} cd ${JSON.stringify(root)} && ${srcEnv} ${gnomonBin} loop run ${loop.name} >> ${JSON.stringify(join(root, LOOP_STATE_DIR, "cron.log"))} 2>&1 ${CRON_MARK}${loop.name}`;
    const kept = crontabRead()
        .split("\n")
        .filter((l) => l.trim() && !l.includes(`${CRON_MARK}${loop.name}`));
    crontabWrite([...kept, line].join("\n"));
    return line;
}
export function uninstallLoop(name) {
    const lines = crontabRead().split("\n");
    const kept = lines.filter((l) => l.trim() && !l.includes(`${CRON_MARK}${name}`));
    if (kept.length === lines.filter((l) => l.trim()).length)
        return false;
    crontabWrite(kept.join("\n"));
    return true;
}
//# sourceMappingURL=loops.js.map
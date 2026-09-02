/**
 * gnomon-tui: Basic terminal UI
 *
 * Minimal TUI for the gnomon harness:
 * - Session status view (list, select, follow)
 * - Step listing with outcome buckets
 * - Input area for commands
 *
 * No external TUI dependencies — pure readline + ANSI escape codes.
 *
 * ── WHERE IT LOOKS, AND WHY THAT IS NOT A CONSTANT ───────────────────────────
 *
 * Measured 2026-09-02 in this checkout, which had three saved sessions:
 *
 *     $ gnomon tui
 *     No sessions found. Run commands with `gnomon session <cmd>`
 *
 *     $ gnomon tui --dir .gnomon-sessions          # the obvious workaround
 *     gnomon error: Cannot read properties of undefined (reading 'steps')
 *
 * Two separate faults. The directory was hard-coded to `<cwd>/sessions`, which
 * nothing in this harness has ever written to — every writer goes through
 * `resolveSessionStore`, whose default is `.gnomon-sessions/` and which a
 * surface can repoint with `[session].dir`. And the loader assumed every
 * `*.json` under it was a `SessionRecord`, when that directory legitimately
 * holds TWO shapes plus a `history/` subdirectory:
 *
 *   - `SessionRecord`  — `{ session: { steps: [...] }, metadata }`, written by
 *     `gnomon session <cmd>` (SessionManager.save).
 *   - `SessionSnapshot`— `{ format, id, surface_hash, exchanges: [...] }`,
 *     written after every turn of `gnomon prompt` / `launch`.
 *
 * So this file now (a) resolves the directory from the surface, and (b) reads
 * both shapes, normalising each into one display row, and SKIPS anything that
 * is neither — counting what it skipped and saying so on screen, because a
 * silent skip is indistinguishable from an empty directory, which is the
 * failure above wearing a different hat.
 */
import * as readline from "node:readline";
import { loadConfig, resolveSessionStore } from "gnomon-core";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Inner width of the banner box, excluding its two border columns. */
export const BANNER_WIDTH = 46;
/**
 * Centre `text` in `width` columns, colouring only the text itself.
 *
 * The padding is measured on the bare string and the escape codes are added
 * afterwards, because an ANSI sequence occupies characters in a JavaScript
 * string and zero columns in a terminal — padding a pre-coloured string is how
 * a box ends up looking right in the source and wrong on screen.
 */
export function centre(text, width, paint = (t) => t) {
    const visible = [...text].length;
    if (visible >= width)
        return paint(text);
    const left = Math.floor((width - visible) / 2);
    return " ".repeat(left) + paint(text) + " ".repeat(width - visible - left);
}
const ESC = "\x1b[";
const COLORS = {
    reset: `${ESC}0m`,
    bold: `${ESC}1m`,
    dim: `${ESC}2m`,
    gray: `${ESC}90m`,
    green: `${ESC}32m`,
    yellow: `${ESC}33m`,
    red: `${ESC}31m`,
    blue: `${ESC}34m`,
    cyan: `${ESC}36m`,
    white: `${ESC}37m`,
    bgGray: `${ESC}100m`,
};
function c(color, text) {
    const key = color;
    return `${COLORS[key]}${text}${COLORS.reset}`;
}
function bucketColor(bucket) {
    switch (bucket) {
        case "result":
            return "green";
        case "refusal":
            return "yellow";
        case "apparatus_failure":
            return "red";
        default:
            return "white";
    }
}
const BUCKETS = ["result", "refusal", "apparatus_failure"];
function asBucket(value) {
    return typeof value === "string" && BUCKETS.includes(value)
        ? value
        : null;
}
function oneLine(value, max = 70) {
    const text = typeof value === "string" ? value : "";
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
// ---------------------------------------------------------------------------
// Locating and reading sessions
// ---------------------------------------------------------------------------
/**
 * Where this project's saved sessions live.
 *
 * `dir` is the PROJECT directory, matching `--dir` everywhere else in the CLI,
 * and the store comes from the surface (`[session].dir`, default
 * `.gnomon-sessions/`) rather than from a constant here — a constant is what
 * made `gnomon tui` report an empty list in a project with three sessions in
 * it.
 *
 * A directory that holds no surface but does hold `*.json` is accepted as a
 * literal store, so `gnomon tui --dir .gnomon-sessions` — the workaround people
 * reached for while the default was wrong — keeps working instead of throwing
 * `.gnomon/ not found`.
 */
export function resolveSessionsDir(dir) {
    try {
        const store = resolveSessionStore(loadConfig(dir));
        return { dir: store.dir, from: "surface ([session].dir)" };
    }
    catch (err) {
        const literal = dir ? resolve(dir) : "";
        if (literal && existsSync(literal) && statSync(literal).isDirectory()) {
            return { dir: literal, from: "--dir, read as a session directory" };
        }
        throw err;
    }
}
/**
 * Read every session record in a directory, and report what was not one.
 *
 * Returning the skips is the point. The previous version indexed
 * `record.session.steps` on whatever parsed, so one prompt-loop snapshot in the
 * directory crashed the whole command with `Cannot read properties of undefined
 * (reading 'steps')`. Swallowing those files instead would have been the other
 * classic failure — a list that is short for a reason nobody is told.
 */
export function scanSessions(sessionsDir) {
    const scan = { dir: sessionsDir, sessions: [], skipped: [] };
    if (!existsSync(sessionsDir))
        return scan;
    let entries;
    try {
        entries = readdirSync(sessionsDir).sort();
    }
    catch (err) {
        scan.skipped.push({ file: sessionsDir, why: `unreadable: ${message(err)}` });
        return scan;
    }
    for (const file of entries) {
        if (!file.endsWith(".json"))
            continue;
        const path = join(sessionsDir, file);
        try {
            if (!statSync(path).isFile())
                continue;
        }
        catch {
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(path, "utf-8"));
        }
        catch (err) {
            scan.skipped.push({ file, why: `not JSON (${message(err)})` });
            continue;
        }
        const meta = readMeta(file, path, parsed);
        if (meta)
            scan.sessions.push(meta);
        else
            scan.skipped.push({ file, why: "not a session record (no session.steps, no exchanges)" });
    }
    return scan;
}
/** Back-compatible shim: the metadata only, for callers that want just that. */
export function discoverSessions(dir) {
    return scanSessions(dir ? resolve(dir) : join(process.cwd(), ".gnomon-sessions")).sessions;
}
function message(err) {
    return err instanceof Error ? err.message : String(err);
}
function emptyCounts() {
    return { result: 0, refusal: 0, apparatus_failure: 0 };
}
/** Classify one parsed file. Null when it is neither shape. */
function readMeta(file, path, parsed) {
    const rows = readRows(parsed);
    if (!rows)
        return null;
    const bucketCounts = emptyCounts();
    let otherBuckets = 0;
    for (const row of rows.steps) {
        if (bucketCounts[row.bucket] === undefined)
            otherBuckets++;
        else
            bucketCounts[row.bucket]++;
    }
    return {
        id: file.replace(/\.json$/, ""),
        path,
        file,
        kind: rows.kind,
        stepCount: rows.steps.length,
        bucketCounts,
        otherBuckets,
    };
}
/**
 * Normalise either on-disk shape into display rows.
 *
 * A bucket outside the three-value contract is displayed verbatim in the
 * preview and counted as "other" rather than being coerced into one of the
 * three — a record forced into `apparatus_failure` would be a fabricated
 * finding, which is worse than an unrecognised one.
 */
export function readRows(parsed) {
    if (!parsed || typeof parsed !== "object")
        return null;
    const obj = parsed;
    const session = obj.session;
    if (session && Array.isArray(session.steps)) {
        const steps = session.steps.map((s) => {
            const bucket = asBucket(s.bucket);
            const out = oneLine(s.stdout) || oneLine(s.stderr);
            return {
                bucket: bucket ?? "apparatus_failure",
                code: typeof s.native_code === "number" ? s.native_code : -1,
                duration_ms: typeof s.duration_ms === "number" ? s.duration_ms : 0,
                preview: bucket ? out : `[bucket=${String(s.bucket)}] ${out}`,
            };
        });
        return { kind: "steps", steps };
    }
    if (Array.isArray(obj.exchanges)) {
        const steps = obj.exchanges.map((e) => {
            const bucket = asBucket(e.bucket);
            const tools = typeof e.tool_steps === "number" && e.tool_steps > 0 ? ` (${e.tool_steps} tools)` : "";
            const head = `${String(e.role ?? "?")}${tools} ▸ ${oneLine(e.input, 52) || "(no input)"}`;
            return {
                bucket: bucket ?? "apparatus_failure",
                code: typeof e.code === "number" ? e.code : -1,
                duration_ms: typeof e.duration_ms === "number" ? e.duration_ms : 0,
                preview: bucket ? head : `[bucket=${String(e.bucket)}] ${head}`,
            };
        });
        return { kind: "turns", steps };
    }
    return null;
}
// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
/** Render the TUI header */
function renderHeader() {
    console.clear();
    // Centred against the border rather than padded by hand. Hand-counted
    // padding drifts the moment the title changes — and it had: the right edge
    // sat 13 columns inside the corner. Colour is applied after centring
    // because ANSI escapes have width in a string and none on screen.
    console.log(`${c("cyan", "╔" + "═".repeat(BANNER_WIDTH) + "╗")}`);
    console.log(`${c("cyan", "║")}${centre("gnomon — TUI", BANNER_WIDTH, (t) => c("bold", c("white", t)))}${c("cyan", "║")}`);
    console.log(`${c("cyan", "╚" + "═".repeat(BANNER_WIDTH) + "╝")}`);
    console.log();
}
/** The skip list, or nothing. Always printed where a short list is shown. */
function renderSkipped(state) {
    if (state.skipped.length === 0)
        return;
    console.log();
    console.log(c("gray", `  ${state.skipped.length} file(s) in that directory are not session records:`));
    for (const s of state.skipped.slice(0, 5)) {
        console.log(c("gray", `    ${s.file} — ${s.why}`));
    }
    if (state.skipped.length > 5) {
        console.log(c("gray", `    …and ${state.skipped.length - 5} more`));
    }
}
/** Render the session menu */
function renderMenu(state) {
    renderHeader();
    console.log(c("bold", "Sessions:") + c("gray", `  ${state.dir}`));
    console.log();
    if (state.sessions.length === 0) {
        console.log(c("gray", "  No saved sessions in that directory."));
        console.log(c("gray", "  Create one:  gnomon prompt   ·   gnomon session \"echo hello\""));
        renderSkipped(state);
        console.log();
        console.log(c("dim", "  r refresh, q to quit"));
        return;
    }
    state.sessions.forEach((s, i) => {
        const marker = i === state.selectedIndex ? c("cyan", "❯") : " ";
        const unit = s.kind === "turns" ? "turns" : "steps";
        const stepInfo = c("gray", `${s.stepCount} ${unit}`);
        const buckets = Object.entries(s.bucketCounts)
            .filter(([, count]) => count > 0)
            .map(([b, count]) => {
            const color = bucketColor(b);
            return c(color, `${b}=${count}`);
        })
            .concat(s.otherBuckets > 0 ? [c("white", `other=${s.otherBuckets}`)] : [])
            .join(" ");
        console.log(`  ${marker} ${c("bold", s.id.slice(0, 34).padEnd(34))}  ${stepInfo}  ${buckets}`);
    });
    renderSkipped(state);
    console.log();
    console.log(c("dim", "  <number> or Enter to view  ·  r refresh  ·  q quit"));
}
/** Render a session view */
function renderView(state) {
    renderHeader();
    const session = state.sessions[state.selectedIndex];
    if (!session) {
        console.log(c("red", "No session selected"));
        console.log(c("dim", "  m back to menu  q quit"));
        return;
    }
    const unit = session.kind === "turns" ? "turns" : "steps";
    console.log(c("bold", `Session: ${session.id}`) + c("gray", `  (${unit})`));
    console.log(c("dim", `  ${session.stepCount} ${unit} — `) +
        Object.entries(session.bucketCounts)
            .filter(([, cnt]) => cnt > 0)
            .map(([b, cnt]) => `${c("gray", `${b}=${cnt}`)}`)
            .join(" "));
    console.log();
    console.log(c("bold", unit === "turns" ? "Turns:" : "Steps:"));
    console.log();
    const steps = state.steps;
    const maxShow = 20;
    const show = steps.length > maxShow ? steps.slice(-maxShow) : steps;
    show.forEach((step, i) => {
        const idx = steps.length > maxShow ? i + (steps.length - maxShow) : i;
        const color = bucketColor(step.bucket);
        const dur = `${step.duration_ms}ms`;
        console.log(`  ${c("gray", `#${idx}`)} ${c(color, step.bucket.padEnd(18))} ` +
            `${c("dim", `code=${step.code}`)} ${c("dim", `dur=${dur}`)} ${c("white", step.preview)}`);
    });
    if (steps.length > maxShow) {
        console.log(c("dim", `  ... and ${steps.length - maxShow} more`));
    }
    console.log();
    console.log(c("dim", "  m menu  q quit"));
}
// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
/**
 * Run the gnomon TUI.
 *
 * @param dir The PROJECT directory (as `--dir` means everywhere else). The
 *            session store is resolved from its surface; see
 *            `resolveSessionsDir` for the one fallback.
 */
export async function runTui(dir) {
    let located;
    try {
        located = resolveSessionsDir(dir);
    }
    catch (err) {
        console.error(`gnomon tui: ${message(err)}`);
        console.error("\nThe TUI reads saved sessions out of this project's session store.\n" +
            "Run it inside a project that has a .gnomon/ surface, or pass the\n" +
            "project with --dir <path>.");
        process.exitCode = 1;
        return;
    }
    const scan = scanSessions(located.dir);
    const state = {
        mode: "menu",
        dir: scan.dir,
        sessions: scan.sessions,
        skipped: scan.skipped,
        selectedIndex: 0,
        steps: [],
        currentRole: "implement",
        inputBuffer: "",
    };
    // Nothing to drive an interactive loop with. Printing the menu once and
    // leaving is better than opening a prompt over an empty list — and it makes
    // the command usable from a pipe, which is how it was first found to be
    // reporting an empty directory that was not empty.
    if (!process.stdin.isTTY && state.sessions.length === 0) {
        renderMenu(state);
        return;
    }
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });
    function render() {
        switch (state.mode) {
            case "menu":
                renderMenu(state);
                break;
            case "view":
                renderView(state);
                break;
        }
        if (state.error) {
            console.log(c("yellow", `  ${state.error}`));
            state.error = undefined;
        }
        rl.setPrompt(c("cyan", "gnomon> "));
        rl.prompt();
    }
    /** Load the selected session's rows. Never throws into the loop. */
    function openSelected() {
        const session = state.sessions[state.selectedIndex];
        if (!session) {
            state.error = "No session selected.";
            return;
        }
        try {
            const rows = readRows(JSON.parse(readFileSync(session.path, "utf-8")));
            if (!rows) {
                state.error = `${session.file} is no longer a session record.`;
                return;
            }
            state.steps = rows.steps;
            state.mode = "view";
        }
        catch (err) {
            // A file deleted or truncated between the scan and the open is normal —
            // the harness writes into this directory while the TUI is up. It must
            // not take the TUI down.
            state.error = `Could not read ${session.file}: ${message(err)}`;
        }
    }
    render();
    rl.on("line", (line) => {
        const input = line.trim().toLowerCase();
        if (input === "q" || input === "quit") {
            console.log(c("gray", "Goodbye."));
            rl.close();
            return;
        }
        if (input === "r" || input === "refresh") {
            const fresh = scanSessions(located.dir);
            state.sessions = fresh.sessions;
            state.skipped = fresh.skipped;
            state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, state.sessions.length - 1));
            state.mode = "menu";
            render();
            return;
        }
        if (input === "m" || input === "menu") {
            state.mode = "menu";
            render();
            return;
        }
        if (state.mode === "menu") {
            // A number selects. Arrow keys never worked here: the handler that read
            // them was registered on "line", which only fires on Enter, so `escapeSeq`
            // was always the empty string it was initialised to and both branches
            // were dead. A typed index is one keystroke and actually runs.
            if (/^\d+$/.test(input)) {
                const idx = Number.parseInt(input, 10) - 1;
                if (idx < 0 || idx >= state.sessions.length) {
                    state.error = `No session ${input}. There are ${state.sessions.length}.`;
                    render();
                    return;
                }
                state.selectedIndex = idx;
            }
            if (state.sessions.length === 0) {
                render();
                return;
            }
            openSelected();
            render();
            return;
        }
        render();
    });
    rl.on("close", () => {
        process.stdout.write("\n");
    });
    process.on("SIGINT", () => {
        console.log(c("gray", "\nInterrupted. Goodbye."));
        rl.close();
        process.exit(0);
    });
    // Resolve only when the interface closes, so `await runTui()` means "the TUI
    // is finished". It used to resolve immediately, which is why the CLI returned
    // — and the process stayed alive only because readline held the event loop.
    await new Promise((done) => rl.on("close", () => done()));
}
//# sourceMappingURL=tui.js.map
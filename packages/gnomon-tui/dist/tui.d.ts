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
import { Bucket } from "gnomon-core";
/** TUI display mode */
export type TuiMode = "menu" | "view";
/**
 * One row of the step list.
 *
 * Deliberately NOT `SessionStep`. A prompt turn has no `native_code`/`stdout`
 * and a session step has no role or turn number; forcing turns into the step
 * shape meant writing the user's question into a field called `stdout`. This
 * is a display type, and it says so.
 */
export interface DisplayStep {
    bucket: Bucket;
    /** Process exit code (session steps) or turn code (prompt turns). */
    code: number;
    duration_ms: number;
    /** The one line that identifies this row. */
    preview: string;
}
/** TUI state */
export interface TuiState {
    mode: TuiMode;
    /** The directory actually read, shown on screen so a miss is diagnosable. */
    dir: string;
    sessions: SessionMeta[];
    /** Files under `dir` that were not session records, and why. */
    skipped: SkippedFile[];
    selectedIndex: number;
    steps: DisplayStep[];
    currentRole: string;
    inputBuffer: string;
    error?: string;
}
/** Which of the two on-disk shapes a file held. */
export type SessionKind = "steps" | "turns";
/** Metadata about a saved session */
export interface SessionMeta {
    id: string;
    path: string;
    file: string;
    /** `steps` = `gnomon session`; `turns` = `gnomon prompt`/`launch`. */
    kind: SessionKind;
    stepCount: number;
    bucketCounts: Record<Bucket, number>;
    /** Buckets outside the three-value contract, kept rather than miscounted. */
    otherBuckets: number;
}
export interface SkippedFile {
    file: string;
    why: string;
}
/** What a directory scan found — including what it refused. */
export interface SessionScan {
    dir: string;
    sessions: SessionMeta[];
    skipped: SkippedFile[];
}
/** Inner width of the banner box, excluding its two border columns. */
export declare const BANNER_WIDTH = 46;
/**
 * Centre `text` in `width` columns, colouring only the text itself.
 *
 * The padding is measured on the bare string and the escape codes are added
 * afterwards, because an ANSI sequence occupies characters in a JavaScript
 * string and zero columns in a terminal — padding a pre-coloured string is how
 * a box ends up looking right in the source and wrong on screen.
 */
export declare function centre(text: string, width: number, paint?: (t: string) => string): string;
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
export declare function resolveSessionsDir(dir?: string): {
    dir: string;
    from: string;
};
/**
 * Read every session record in a directory, and report what was not one.
 *
 * Returning the skips is the point. The previous version indexed
 * `record.session.steps` on whatever parsed, so one prompt-loop snapshot in the
 * directory crashed the whole command with `Cannot read properties of undefined
 * (reading 'steps')`. Swallowing those files instead would have been the other
 * classic failure — a list that is short for a reason nobody is told.
 */
export declare function scanSessions(sessionsDir: string): SessionScan;
/** Back-compatible shim: the metadata only, for callers that want just that. */
export declare function discoverSessions(dir?: string): SessionMeta[];
/**
 * Normalise either on-disk shape into display rows.
 *
 * A bucket outside the three-value contract is displayed verbatim in the
 * preview and counted as "other" rather than being coerced into one of the
 * three — a record forced into `apparatus_failure` would be a fabricated
 * finding, which is worse than an unrecognised one.
 */
export declare function readRows(parsed: unknown): {
    kind: SessionKind;
    steps: DisplayStep[];
} | null;
/**
 * Run the gnomon TUI.
 *
 * @param dir The PROJECT directory (as `--dir` means everywhere else). The
 *            session store is resolved from its surface; see
 *            `resolveSessionsDir` for the one fallback.
 */
export declare function runTui(dir?: string): Promise<void>;
//# sourceMappingURL=tui.d.ts.map
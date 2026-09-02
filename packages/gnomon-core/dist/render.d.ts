/**
 * gnomon-core: Terminal rendering
 *
 * Everything the prompt loop draws lives here, driven by `[ui]` in
 * .gnomon/config.toml. The loop decides *what* happened; this module decides
 * *how much of it you see*. Keeping the two apart is what makes the meta line
 * configurable instead of hard-coded.
 *
 * No dependencies — ANSI escapes only.
 */
import type { PromptExchange } from "./prompt_loop.js";
import type { ResolvedUi } from "./config.js";
/**
 * A named palette.
 *
 * Call sites ask for a role — `gray` for secondary text, `yellow` for
 * attention — and the theme decides what that becomes. Nothing needs to know
 * which escape it got.
 */
export interface Theme {
    name: string;
    description: string;
    codes: Record<string, string>;
    /**
     * Recolour the whole terminal, not just printed text, via OSC 11/10 (hex).
     * This is how a scrolling loop gets an edge-to-edge background without a
     * full-screen alternate buffer — but the change outlives the process, so
     * whenever a theme with this is applied the reset (`terminalThemeSequence(null)`)
     * MUST run on exit. Omit it and the theme leaves the terminal's own colours be.
     */
    terminal?: {
        bg: string;
        fg?: string;
    };
}
export declare const THEMES: Record<string, Theme>;
export declare const DEFAULT_THEME = "dark";
/** The palette in force, falling back rather than throwing on a bad name. */
export declare function themeOf(ui: ResolvedUi): Theme;
/**
 * The OSC sequence that paints — or resets — the whole terminal for a theme.
 *
 * OSC 11 sets the background and OSC 10 the foreground; 111/110 reset them to
 * the terminal's own defaults. Pass a theme with a `terminal` block to apply it,
 * or `null` to reset — which MUST run on exit, because unlike a full-screen
 * TUI's alternate buffer, this change persists in the terminal after gnomon is
 * gone. Callers emit this only to a TTY with colour on.
 */
export declare function terminalThemeSequence(theme: Theme | null): string;
/** Wrap text in a colour, or return it untouched when colour is off. */
export declare function paint(ui: ResolvedUi, color: string, text: string): string;
/**
 * Split reasoning out of a model reply.
 *
 * Reasoning models in this surface (qwen3.6, deepseek-r1) wrap their scratchpad
 * in <think>…</think>. Without this the scratchpad lands in the answer, which
 * is what makes replies look rambling. An unterminated opener — a reply cut off
 * mid-thought — is treated as reasoning all the way to the end, so a truncated
 * turn degrades to "no answer" rather than "answer made of reasoning".
 */
export declare function splitThinking(text: string): {
    think: string;
    answer: string;
};
/**
 * Build the meta line(s) shown with an answer.
 *
 * `ui.meta` is an ordered list, so the line reads in the order the surface
 * declares. An empty list means no meta at all.
 */
export declare function renderMeta(exchange: PromptExchange, ui: ResolvedUi, thinkTokens?: number): string[];
/**
 * Render a full exchange: reasoning (per `ui.think`), the answer, then meta.
 *
 * Pure — returns lines rather than printing, so the layout is testable and so
 * a different front-end can reuse it.
 */
/**
 * Columns available for an answer.
 *
 * `columns` is absent when output is piped, and a fixed width there keeps a
 * redirected transcript stable instead of varying with whoever ran it.
 */
export declare function terminalWidth(out?: NodeJS.WriteStream): number;
export declare function renderExchange(exchange: PromptExchange, ui: ResolvedUi): string[];
/**
 * A live progress line: frame, label, elapsed seconds.
 *
 * Silent on a non-TTY (piped output, CI) — it degrades to a single static line
 * so redirected output stays greppable instead of filling with escape codes.
 */
export declare class Progress {
    private ui;
    private out;
    private timer;
    private frame;
    private started;
    private label;
    private suspended;
    constructor(ui: ResolvedUi, out?: NodeJS.WriteStream);
    /** Would a spinner be drawn here at all? */
    private get live();
    /** Is a frame timer actually running right now? */
    private get drawing();
    start(label: string): void;
    private clearTimer;
    private arm;
    /** Change the label without restarting the elapsed clock. */
    update(label: string): void;
    private draw;
    /**
     * Stop redrawing and leave the line alone.
     *
     * Each frame writes a carriage return and an erase-line, twelve times a
     * second. That erases whatever the user is typing as fast as the terminal
     * echoes it — the queue was accepting typed-ahead input the whole time, but
     * nothing typed was ever visible. While someone is typing, the line is
     * theirs.
     */
    suspend(): boolean;
    /** Resume drawing after a suspend. No-op if it was never started. */
    resume(): void;
    /** Stop and clear the line. Safe to call when never started. */
    stop(): void;
    /**
     * Print a transcript line without fighting the spinner for the row.
     *
     * The model's reasoning was written straight onto the live frame, so a turn
     * that explained itself opened with the spinner spliced into it:
     * `⠸ qwen3.6:35b 6.4s  │ Let me read the config first`.
     */
    print(text: string): void;
}
/**
 * Make model-chosen text safe to print next to a question the operator answers.
 *
 * The approval prompt renders a tool's summary and preview verbatim, and both
 * are built from strings the MODEL chose -- `bash: ${command}`, and the diff
 * body. Nothing filtered control characters, so a command could carry ESC[2K
 * and a carriage return, erase the line the operator was about to read, and
 * redraw a different, innocuous one in its place. Reproduced: a curl-pipe-sh
 * command rendered on screen as two lines of `git status --short`, with the
 * real command invisible, above a prompt asking to approve it.
 *
 * An approval gate the thing being approved can rewrite is not a gate. Escaping
 * costs nothing and makes a crafted command conspicuous instead of invisible:
 * the operator sees the literal \x1b, which no ordinary command contains.
 *
 * Tab survives because it is legitimate layout in a diff. Everything else in
 * C0/C1, including ESC, CR and the backspace that could achieve the same trick,
 * becomes a visible escape.
 */
export declare function safeForPrompt(text: string): string;
//# sourceMappingURL=render.d.ts.map
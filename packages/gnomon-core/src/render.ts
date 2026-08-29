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
import type { ResolvedUi, MetaField } from "./config.js";
import { renderMarkdown, DEFAULT_WIDTH } from "./markdown.js";

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const ESC = "\x1b[";

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
  terminal?: { bg: string; fg?: string };
}

const RESET = `${ESC}0m`;

export const THEMES: Record<string, Theme> = {
  dark: {
    name: "dark",
    description: "Default. Secondary text stays legible on a dark background.",
    codes: {
      // NOT 90m. "Bright black" on a black terminal is charcoal on charcoal,
      // and this palette uses the muted role nineteen times — most of the
      // meta lines, every context note, every tool argument.
      gray: `${ESC}37m`,
      bold: `${ESC}1m`,
      italic: `${ESC}3m`,
      dim: `${ESC}2m`,
      green: `${ESC}32m`,
      yellow: `${ESC}33m`,
      red: `${ESC}31m`,
      cyan: `${ESC}36m`,
      magenta: `${ESC}35m`,
    },
  },
  dim: {
    name: "dim",
    description: "Quieter. Secondary text recedes — good on a bright terminal.",
    codes: {
      gray: `${ESC}90m`,
      bold: `${ESC}1m`,
      italic: `${ESC}3m`,
      dim: `${ESC}2m`,
      green: `${ESC}32m`,
      yellow: `${ESC}33m`,
      red: `${ESC}31m`,
      cyan: `${ESC}36m`,
      magenta: `${ESC}35m`,
    },
  },
  light: {
    name: "light",
    description: "For a light background: darker foregrounds, blue for accent.",
    codes: {
      gray: `${ESC}90m`,
      bold: `${ESC}1m`,
      italic: `${ESC}3m`,
      dim: `${ESC}2m`,
      green: `${ESC}32m`,
      yellow: `${ESC}33m`,
      red: `${ESC}31m`,
      cyan: `${ESC}34m`,
      magenta: `${ESC}35m`,
    },
  },
  "high-contrast": {
    name: "high-contrast",
    description: "Bright and bold throughout. For small text or poor displays.",
    codes: {
      gray: `${ESC}97m`,
      bold: `${ESC}1m`,
      italic: `${ESC}3m`,
      dim: `${ESC}97m`,
      green: `${ESC}1;92m`,
      yellow: `${ESC}1;93m`,
      red: `${ESC}1;91m`,
      cyan: `${ESC}1;96m`,
      magenta: `${ESC}1;95m`,
    },
  },
  mono: {
    name: "mono",
    description: "No colour, but keeps the layout. For logs and screenshots.",
    codes: {},
  },
  // 24-bit palettes that also recolour the whole terminal (OSC 11/10). They
  // need a terminal that honours OSC — most do — and the background is reset on
  // exit. Foreground roles are RGB; bold/italic/dim stay attribute-only.
  tokyonight: {
    name: "tokyonight",
    description: "Deep indigo with soft neon. Recolours the whole terminal.",
    codes: {
      gray: `${ESC}38;2;86;95;137m`,
      bold: `${ESC}1m`,
      italic: `${ESC}3m`,
      dim: `${ESC}38;2;68;71;90m`,
      green: `${ESC}38;2;158;206;106m`,
      yellow: `${ESC}38;2;224;175;104m`,
      red: `${ESC}38;2;247;118;142m`,
      cyan: `${ESC}38;2;125;207;255m`,
      magenta: `${ESC}38;2;187;154;247m`,
    },
    terminal: { bg: "#1a1b26", fg: "#c0caf5" },
  },
  catppuccin: {
    name: "catppuccin",
    description: "Mocha — warm pastels on a plum background. Whole terminal.",
    codes: {
      gray: `${ESC}38;2;108;112;134m`,
      bold: `${ESC}1m`,
      italic: `${ESC}3m`,
      dim: `${ESC}38;2;88;91;112m`,
      green: `${ESC}38;2;166;227;161m`,
      yellow: `${ESC}38;2;249;226;175m`,
      red: `${ESC}38;2;243;139;168m`,
      cyan: `${ESC}38;2;137;220;235m`,
      magenta: `${ESC}38;2;203;166;247m`,
    },
    terminal: { bg: "#1e1e2e", fg: "#cdd6f4" },
  },
};

export const DEFAULT_THEME = "dark";

/** The palette in force, falling back rather than throwing on a bad name. */
export function themeOf(ui: ResolvedUi): Theme {
  return THEMES[ui.theme] ?? THEMES[DEFAULT_THEME];
}

/**
 * The OSC sequence that paints — or resets — the whole terminal for a theme.
 *
 * OSC 11 sets the background and OSC 10 the foreground; 111/110 reset them to
 * the terminal's own defaults. Pass a theme with a `terminal` block to apply it,
 * or `null` to reset — which MUST run on exit, because unlike a full-screen
 * TUI's alternate buffer, this change persists in the terminal after gnomon is
 * gone. Callers emit this only to a TTY with colour on.
 */
export function terminalThemeSequence(theme: Theme | null): string {
  const t = theme?.terminal;
  if (!t) return "\x1b]111\x07\x1b]110\x07";
  return `\x1b]11;${t.bg}\x07` + (t.fg ? `\x1b]10;${t.fg}\x07` : "");
}

/** Wrap text in a colour, or return it untouched when colour is off. */
export function paint(ui: ResolvedUi, color: string, text: string): string {
  if (!ui.color) return text;
  const code = themeOf(ui).codes[color];
  return code ? `${code}${text}${RESET}` : text;
}

// ---------------------------------------------------------------------------
// Chain-of-thought
// ---------------------------------------------------------------------------

const THINK_BLOCK = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
const THINK_OPEN = /<think(?:ing)?>/i;

/**
 * Split reasoning out of a model reply.
 *
 * Reasoning models in this surface (qwen3.6, deepseek-r1) wrap their scratchpad
 * in <think>…</think>. Without this the scratchpad lands in the answer, which
 * is what makes replies look rambling. An unterminated opener — a reply cut off
 * mid-thought — is treated as reasoning all the way to the end, so a truncated
 * turn degrades to "no answer" rather than "answer made of reasoning".
 */
export function splitThinking(text: string): { think: string; answer: string } {
  const found: string[] = [];
  let answer = text.replace(THINK_BLOCK, (_m, body: string) => {
    found.push(body.trim());
    return "";
  });

  const open = answer.match(THINK_OPEN);
  if (open && open.index !== undefined) {
    found.push(answer.slice(open.index + open[0].length).trim());
    answer = answer.slice(0, open.index);
  }

  return {
    think: found.filter(Boolean).join("\n\n").trim(),
    answer: answer.trim(),
  };
}

// ---------------------------------------------------------------------------
// Meta line
// ---------------------------------------------------------------------------

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`;
}

function humanTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const STATUS: Record<string, { glyph: string; color: string }> = {
  result: { glyph: "✓", color: "green" },
  refusal: { glyph: "⚠", color: "yellow" },
  apparatus_failure: { glyph: "✗", color: "red" },
};

/**
 * Render one meta field, or null when the exchange carries no value for it.
 * Returning null (rather than an empty string) keeps separators tidy.
 */
function metaField(
  field: MetaField,
  exchange: PromptExchange,
  thinkTokens: number
): string | null {
  switch (field) {
    case "turn":
      return `turn ${exchange.turn}`;
    case "role":
      return exchange.role;
    case "model":
      return exchange.model;
    case "bucket":
      return exchange.bucket;
    case "duration":
      return humanDuration(exchange.duration_ms);
    case "context":
      if (exchange.context_turns === undefined) return null;
      return exchange.context_dropped
        ? `ctx ${exchange.context_turns} turns (−${exchange.context_dropped})`
        : `ctx ${exchange.context_turns} turns`;
    case "tokens": {
      // Two different numbers, and the difference matters enough to mark it.
      // `usage` is what the model server counted; the estimate is gnomon's own
      // ~4-chars-per-token approximation, which exists to slide the context
      // window identically on every machine and is wrong on code. A measured
      // count prints bare, an estimate keeps its tilde, so a cost read off
      // this line is never silently a guess.
      const u = exchange.usage;
      if (u && (u.input !== undefined || u.output !== undefined)) {
        const parts: string[] = [];
        if (u.input !== undefined) parts.push(`${humanTokens(u.input)} in`);
        if (u.output !== undefined) parts.push(`${humanTokens(u.output)} out`);
        return parts.join(" ");
      }
      if (exchange.context_tokens === undefined) return null;
      return `~${humanTokens(exchange.context_tokens)} tok`;
    }
    case "think":
      return thinkTokens > 0 ? `think ~${humanTokens(thinkTokens)} tok` : null;
    case "tools":
      return exchange.tool_steps ? `${exchange.tool_steps} tool call(s)` : null;
    default:
      return null;
  }
}

/**
 * Build the meta line(s) shown with an answer.
 *
 * `ui.meta` is an ordered list, so the line reads in the order the surface
 * declares. An empty list means no meta at all.
 */
export function renderMeta(
  exchange: PromptExchange,
  ui: ResolvedUi,
  thinkTokens = 0
): string[] {
  if (ui.meta.length === 0) return [];

  const parts = ui.meta
    .map((f) => metaField(f, exchange, thinkTokens))
    .filter((v): v is string => v !== null);
  if (parts.length === 0) return [];

  const status = STATUS[exchange.bucket] ?? STATUS.result;
  const line = parts.join("  ·  ");

  if (ui.meta_style === "compact") {
    return [paint(ui, "gray", `  ${line}`)];
  }
  return [
    paint(ui, "gray", `  ${"─".repeat(Math.min(60, line.length + 4))}`),
    `  ${paint(ui, status.color, status.glyph)} ${paint(ui, "gray", line)}`,
  ];
}

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
export function terminalWidth(out: NodeJS.WriteStream = process.stdout): number {
  return out.isTTY && out.columns ? Math.max(40, out.columns) : DEFAULT_WIDTH;
}

export function renderExchange(
  exchange: PromptExchange,
  ui: ResolvedUi
): string[] {
  const { think, answer } = splitThinking(exchange.output);
  const thinkTokens = Math.ceil(think.length / 4);
  const lines: string[] = [""];

  if (think && ui.think !== "hide") {
    if (ui.think === "show") {
      lines.push(paint(ui, "gray", "  ┌ reasoning"));
      for (const l of think.split("\n")) {
        lines.push(paint(ui, "gray", `  │ ${l}`));
      }
      lines.push(paint(ui, "gray", "  └"));
      lines.push("");
    } else {
      // collapse: first line only, so you can see it happened without reading it
      const first = think.split("\n").find((l) => l.trim()) ?? "";
      const clipped = first.length > 76 ? `${first.slice(0, 76)}…` : first;
      lines.push(paint(ui, "gray", `  ┆ ${clipped}`));
      lines.push("");
    }
  }

  if (!answer) {
    lines.push(paint(ui, "yellow", "(no answer — reply was reasoning only)"));
  } else if (ui.markdown) {
    lines.push(...renderMarkdown(answer, ui, terminalWidth()));
  } else {
    lines.push(answer);
  }
  lines.push("");
  lines.push(...renderMeta(exchange, ui, thinkTokens));
  lines.push("");
  return lines;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A live progress line: frame, label, elapsed seconds.
 *
 * Silent on a non-TTY (piped output, CI) — it degrades to a single static line
 * so redirected output stays greppable instead of filling with escape codes.
 */
export class Progress {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private started = 0;
  private label = "";
  private suspended = false;

  constructor(
    private ui: ResolvedUi,
    private out: NodeJS.WriteStream = process.stdout
  ) {}

  /** Would a spinner be drawn here at all? */
  private get live(): boolean {
    return this.ui.spinner && Boolean(this.out.isTTY);
  }

  /** Is a frame timer actually running right now? */
  private get drawing(): boolean {
    return this.timer !== null;
  }

  start(label: string): void {
    this.label = label;
    this.started = Date.now();
    // Suspension is sticky: it survives start() and stop(). A turn stops and
    // restarts the spinner at every tool boundary, and clearing the flag there
    // handed the line back to the spinner a few times a second while someone
    // was still typing into it. The typist keeps the line until they submit.
    // Nothing leaks between turns because the loop builds a fresh Progress per
    // turn.
    this.clearTimer();
    if (this.suspended) return;
    if (!this.live) {
      this.out.write(`  ${label}\n`);
      return;
    }
    // start() used to abandon a running interval without clearing it — see
    // clearTimer above. The orphans never stopped: they kept writing
    // "\r\x1b[2K" over the line, and they survived stop(), which sets
    // started = 0, so they rendered (Date.now() - 0) / 1000 and printed a Unix
    // epoch as the elapsed time.
    this.draw();
    this.arm();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    this.clearTimer();
    this.timer = setInterval(() => this.draw(), 80);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Change the label without restarting the elapsed clock. */
  update(label: string): void {
    this.label = label;
    if (!this.live) this.out.write(`  ${label}\n`);
  }

  private draw(): void {
    // Drawing without a start is a bug in the caller, but it must never render
    // the epoch as an elapsed time. Treat it as starting now.
    if (this.started === 0) this.started = Date.now();
    const secs = ((Date.now() - this.started) / 1000).toFixed(1);
    const f = FRAMES[this.frame++ % FRAMES.length];
    this.out.write(
      `\r\x1b[2K  ${paint(this.ui, "cyan", f)} ${this.label} ${paint(
        this.ui,
        "gray",
        `${secs}s`
      )}`
    );
  }

  /**
   * Stop redrawing and leave the line alone.
   *
   * Each frame writes a carriage return and an erase-line, twelve times a
   * second. That erases whatever the user is typing as fast as the terminal
   * echoes it — the queue was accepting typed-ahead input the whole time, but
   * nothing typed was ever visible. While someone is typing, the line is
   * theirs.
   */
  suspend(): boolean {
    if (this.suspended) return false;
    const wasDrawing = this.drawing;
    this.suspended = true;
    this.clearTimer();
    // Only erase a line this spinner was actually drawing on. When a tool is
    // waiting at an approval prompt no frame is running, and erasing then wiped
    // the `approve>` prompt and the keystroke that had just been echoed onto
    // it — typing `yes` showed `es`.
    if (wasDrawing && this.live) this.out.write("\r\x1b[2K");
    return wasDrawing;
  }

  /** Resume drawing after a suspend. No-op if it was never started. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (!this.live || this.started === 0) return;
    this.draw();
    this.arm();
  }

  /** Stop and clear the line. Safe to call when never started. */
  stop(): void {
    const wasDrawing = this.drawing;
    this.clearTimer();
    this.started = 0;
    // Leave `suspended` alone, and do not erase a line this spinner does not
    // own. stop() runs at every tool boundary, so erasing unconditionally wiped
    // whatever the typist had entered since the last one.
    if (wasDrawing && !this.suspended && this.live) this.out.write("\r\x1b[2K");
  }

  /**
   * Print a transcript line without fighting the spinner for the row.
   *
   * The model's reasoning was written straight onto the live frame, so a turn
   * that explained itself opened with the spinner spliced into it:
   * `⠸ qwen3.6:35b 6.4s  │ Let me read the config first`.
   */
  print(text: string): void {
    const wasDrawing = this.drawing;
    if (wasDrawing) {
      this.clearTimer();
      if (this.live) this.out.write("\r\x1b[2K");
    }
    this.out.write(`${text}\n`);
    if (wasDrawing && !this.suspended) {
      this.draw();
      this.arm();
    }
  }
}

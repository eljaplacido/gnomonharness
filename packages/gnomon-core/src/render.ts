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

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const ESC = "\x1b[";
const CODES: Record<string, string> = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  gray: `${ESC}90m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  cyan: `${ESC}36m`,
  magenta: `${ESC}35m`,
};

/** Wrap text in a colour, or return it untouched when colour is off. */
export function paint(ui: ResolvedUi, color: string, text: string): string {
  if (!ui.color) return text;
  return `${CODES[color] ?? ""}${text}${CODES.reset}`;
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
    case "tokens":
      if (exchange.context_tokens === undefined) return null;
      return `~${humanTokens(exchange.context_tokens)} tok`;
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

  lines.push(answer || paint(ui, "yellow", "(no answer — reply was reasoning only)"));
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

  constructor(
    private ui: ResolvedUi,
    private out: NodeJS.WriteStream = process.stdout
  ) {}

  private get live(): boolean {
    return this.ui.spinner && Boolean(this.out.isTTY);
  }

  start(label: string): void {
    this.label = label;
    this.started = Date.now();
    if (!this.live) {
      this.out.write(`  ${label}\n`);
      return;
    }
    this.draw();
    this.timer = setInterval(() => this.draw(), 80);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Change the label without restarting the elapsed clock. */
  update(label: string): void {
    this.label = label;
    if (!this.live) this.out.write(`  ${label}\n`);
  }

  private draw(): void {
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

  /** Stop and clear the line. Safe to call when never started. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.live) this.out.write("\r\x1b[2K");
  }
}

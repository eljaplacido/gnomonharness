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
import type { ResolvedUi, MetaField, ThinkMode } from "./config.js";
import { renderMarkdown, DEFAULT_WIDTH } from "./markdown.js";
import { cut, visibleWidth } from "./width.js";
import { downgradeCode, colorDepth, colorCode, legacyWindowsConsole } from "./boxed.js";

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
  /** The boxed look (boxed.ts): accent, rail colour, border set, header chip. */
  look?: ThemeLook;
}

/** A colour with its 16-colour fallback; the 256 value is derived from the hex. */
export interface ThemeColor {
  hex: string;
  /** SGR foreground code (30-37, 90-97) used on a 16-colour terminal. */
  c16: number;
}
export type BorderName = "rounded" | "sharp" | "heavy" | "double" | "ascii";
export interface ThemeLook {
  accent?: ThemeColor;
  rail?: ThemeColor;
  border: BorderName;
  /** How the role chip in a turn header is set. */
  chip: "plain" | "bold" | "inverse";
}

const RESET = `${ESC}0m`;

export const THEMES: Record<string, Theme> = {
  dark: {
    name: "dark",
    look: { accent: { hex: "#E2733F", c16: 33 }, rail: { hex: "#8A8178", c16: 37 }, border: "rounded", chip: "bold" },
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
    look: { accent: { hex: "#7C8FA6", c16: 36 }, rail: { hex: "#4B5563", c16: 90 }, border: "sharp", chip: "plain" },
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
    look: { accent: { hex: "#1D4ED8", c16: 34 }, rail: { hex: "#9CA3AF", c16: 90 }, border: "rounded", chip: "bold" },
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
    look: { accent: { hex: "#FFFF00", c16: 93 }, rail: { hex: "#FFFFFF", c16: 97 }, border: "heavy", chip: "inverse" },
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
    look: { border: "rounded", chip: "plain" },
    description: "No colour, but keeps the layout. For logs and screenshots.",
    codes: {},
  },
  // 24-bit palettes that also recolour the whole terminal (OSC 11/10). They
  // need a terminal that honours OSC — most do — and the background is reset on
  // exit. Foreground roles are RGB; bold/italic/dim stay attribute-only.
  tokyonight: {
    name: "tokyonight",
    look: { accent: { hex: "#7AA2F7", c16: 94 }, rail: { hex: "#3B4261", c16: 90 }, border: "rounded", chip: "bold" },
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
    look: { accent: { hex: "#CBA6F7", c16: 95 }, rail: { hex: "#585B70", c16: 90 }, border: "rounded", chip: "bold" },
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
  gruvbox: {
    name: "gruvbox",
    description: "Warm retro earth tones. Recolours the whole terminal.",
    look: { accent: { hex: "#FABD2F", c16: 93 }, rail: { hex: "#928374", c16: 90 }, border: "rounded", chip: "bold" },
    codes: {
      gray: `${ESC}38;2;146;131;116m`,
      bold: `${ESC}1m`,
      italic: `${ESC}3m`,
      dim: `${ESC}38;2;102;92;84m`,
      green: `${ESC}38;2;184;187;38m`,
      yellow: `${ESC}38;2;250;189;47m`,
      red: `${ESC}38;2;251;73;52m`,
      cyan: `${ESC}38;2;142;192;124m`,
      magenta: `${ESC}38;2;211;134;155m`,
    },
    terminal: { bg: "#282828", fg: "#ebdbb2" },
  },
  nord: {
    name: "nord",
    description: "Cool arctic blues, sharp corners. Recolours the whole terminal.",
    look: { accent: { hex: "#88C0D0", c16: 36 }, rail: { hex: "#4C566A", c16: 90 }, border: "sharp", chip: "plain" },
    codes: {
      gray: `${ESC}38;2;129;140;160m`,
      bold: `${ESC}1m`,
      italic: `${ESC}3m`,
      dim: `${ESC}38;2;76;86;106m`,
      green: `${ESC}38;2;163;190;140m`,
      yellow: `${ESC}38;2;235;203;139m`,
      red: `${ESC}38;2;191;97;106m`,
      cyan: `${ESC}38;2;136;192;208m`,
      magenta: `${ESC}38;2;180;142;173m`,
    },
    terminal: { bg: "#2e3440", fg: "#d8dee9" },
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
  // NO_COLOR (no-color.org) is the operator's machine saying no, and it wins
  // over the surface the same way an exported key wins over the store.
  if (!ui.color || process.env.NO_COLOR) return text;
  const code = themeOf(ui).codes[color];
  // The boxed look also fits a truecolor palette to a terminal that is not.
  return code ? `${ui.boxed ? downgradeCode(code, colorDepth()) : code}${text}${RESET}` : text;
}

// ---------------------------------------------------------------------------
// Chain-of-thought
// ---------------------------------------------------------------------------

/**
 * Reasoning markup that model families write inline, in the content, when the
 * server in front of them does not split it out (llama.cpp with
 * `--reasoning-format none`, a raw Ollama template, a provider that passes
 * the text through). Survey read 2026-11-21:
 *
 *   <think>…</think>          Qwen3/3.5+, DeepSeek-R1/V3.1+, GLM, Kimi, MiniMax M2,
 *                             Nemotron, Phi-4-reasoning, Granite, ERNIE, Ring, Hy
 *   <thinking>…</thinking>    the same, as some templates spell it
 *   <seed:think>…</seed:think> ByteDance Seed-OSS
 *   <thought>…</thought>      Gemini through its OpenAI-compatible endpoint
 *   [THINK]…[/THINK]          Mistral Magistral, raw
 *   <|channel>thought…<channel|>  Gemma 4
 *   ◁think▷…◁/think▷          Kimi-VL thinking
 *
 * Reasoning that arrives on a separate field (reasoning_content, reasoning,
 * thinking, reasoning_details) is read where the reply is parsed
 * (prompt_loop.ts readReasoning), not here.
 */
const REASONING_MARKUP: ReadonlyArray<{ open: RegExp; close: RegExp }> = [
  { open: /<think(?:ing)?>/i, close: /<\/think(?:ing)?>/i },
  { open: /<seed:think>/i, close: /<\/seed:think>/i },
  { open: /<thought>/i, close: /<\/thought>/i },
  { open: /\[THINK\]/, close: /\[\/THINK\]/ },
  { open: /<\|channel>thought/, close: /<channel\|>/ },
  { open: /◁think▷/, close: /◁\/think▷/ },
];

/**
 * The first match of `re` in `text` at or after `from` that is markup, not a
 * mention: a tag quoted in backticks (`` `</think>` ``) is an answer talking
 * about the tag, and reading it as markup ate the answer from there on.
 */
function findMarkup(text: string, re: RegExp, from = 0): { index: number; length: number } | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  g.lastIndex = from;
  for (let m = g.exec(text); m; m = g.exec(text)) {
    const quoted = text[m.index - 1] === "`" || text[m.index + m[0].length] === "`";
    if (!quoted) return { index: m.index, length: m[0].length };
  }
  return null;
}

/** Take one markup's reasoning out of `text`, into `found`. */
function takeMarkup(text: string, m: { open: RegExp; close: RegExp }, found: string[]): string {
  let rest = text;
  let answer = "";
  let opened = false;
  for (;;) {
    const o = findMarkup(rest, m.open);
    if (!o) break;
    opened = true;
    answer += rest.slice(0, o.index);
    const after = rest.slice(o.index + o.length);
    const c = findMarkup(after, m.close);
    if (!c) {
      // Unterminated: a reply cut off mid-thought is reasoning to the end, so
      // a truncated turn degrades to "no answer", never to "answer made of
      // reasoning".
      found.push(after.trim());
      return answer;
    }
    found.push(after.slice(0, c.index).trim());
    rest = after.slice(c.index + c.length);
  }
  answer += rest;
  // A closer with no opener anywhere: the template put the opener in the
  // PROMPT, so the reply starts mid-thought (Qwen3 *-Thinking-2507, QwQ,
  // DeepSeek-R1-0528). Everything before the closer is reasoning; it was being
  // shown, and replayed, as the answer. Only a lone closer: two of them is
  // not that shape, and guessing would cut an answer.
  if (!opened) {
    const c = findMarkup(answer, m.close);
    if (c && !findMarkup(answer, m.close, c.index + c.length)) {
      found.push(answer.slice(0, c.index).trim());
      answer = answer.slice(c.index + c.length);
    }
  }
  return answer;
}

// gpt-oss (Harmony) served raw: `<|channel|>analysis<|message|>…<|end|>` is
// the reasoning, `<|channel|>final<|message|>…` the answer, and `commentary`
// the prose beside tool calls. A parsing server splits these itself.
const HARMONY_SEGMENT =
  /<\|channel\|>(\w+)(?:(?!<\|channel\|>)[\s\S])*?<\|message\|>([\s\S]*?)(?=<\|end\|>|<\|return\|>|<\|call\|>|<\|start\|>|<\|channel\|>|$)/g;
const HARMONY_TOKEN = /<\|(?:start|end|return|call|message|channel|constrain)\|>(?:assistant)?/g;

function takeHarmony(text: string, found: string[]): string {
  if (!text.includes("<|channel|>")) return text;
  const said: string[] = [];
  for (const [, channel, body] of text.matchAll(HARMONY_SEGMENT)) {
    if (channel === "analysis") found.push(body!.trim());
    else said.push(body!.trim());
  }
  return said.length ? said.join("\n\n") : text.replace(HARMONY_SEGMENT, "").replace(HARMONY_TOKEN, "");
}

/**
 * The answer inside a wrapper some families put round it once the reasoning
 * is done: Granite's `<response>`, older Hunyuan's `<answer>`, Apriel's
 * `[BEGIN FINAL RESPONSE]` (where the text before it is the reasoning). Only a
 * wrapper the answer STARTS with is unwrapped, so an answer that merely
 * mentions one of these tags is left alone.
 */
function unwrapAnswer(text: string, found: string[]): string {
  const apriel = text.indexOf("[BEGIN FINAL RESPONSE]");
  if (apriel >= 0) {
    const before = text.slice(0, apriel).trim();
    if (before) found.push(before);
    const body = text.slice(apriel + "[BEGIN FINAL RESPONSE]".length);
    const end = body.indexOf("[END FINAL RESPONSE]");
    return (end >= 0 ? body.slice(0, end) : body).replace(/<\|end\|>\s*$/, "");
  }
  const t = text.trim();
  for (const tag of ["answer", "response"]) {
    if (t.toLowerCase().startsWith(`<${tag}>`)) {
      const body = t.slice(tag.length + 2);
      const end = body.toLowerCase().indexOf(`</${tag}>`);
      return end >= 0 ? body.slice(0, end) + body.slice(end + tag.length + 3) : body;
    }
  }
  return text;
}

/**
 * Split reasoning out of a model reply.
 *
 * Without this the scratchpad lands in the answer, which is what makes
 * replies look rambling, and in the history replayed to the model on the next
 * turn. See REASONING_MARKUP for the formats read.
 */
export function splitThinking(text: string): { think: string; answer: string } {
  const found: string[] = [];
  let answer = takeHarmony(text, found);
  for (const m of REASONING_MARKUP) answer = takeMarkup(answer, m, found);
  answer = unwrapAnswer(answer, found);
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
      // A turn that hit a boundary and then finished anyway reads as a failure
      // if the bucket is all you show. Measured across three real workflows --
      // a repo audit, a refactor, and a greenfield build: every one produced
      // correct work, and every one was bucketed `refusal` because the model
      // tried something its role forbade, was told no, and did it another way.
      //
      // That IS the policy working. settle() deliberately never demotes a
      // refusal to a result (CONTRACTS.md), and this does not change it -- the
      // bucket is the bucket. It adds the one word that stops it being read as
      // "the turn failed", which the record already knows from stop_reason.
      return exchange.bucket === "refusal" && exchange.stop_reason === "answered"
        ? "refusal (answered anyway)"
        : exchange.bucket;
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
 * Fields dropped first when the line does not fit, lowest priority first. The
 * bucket (how the turn ended), the duration and the token count stay longest;
 * a field is dropped whole, so no row ever breaks mid-word.
 */
const META_DROP_ORDER: MetaField[] = ["think", "context", "turn", "role", "tools", "model", "tokens", "duration", "bucket"];

const META_SEP = "  ·  ";

/**
 * The meta fields joined into one row of at most `room` columns. When the row
 * is too wide the long bucket wording is abbreviated first, then whole
 * low-priority fields are dropped in META_DROP_ORDER; the order the surface
 * declared is kept for what remains. `room` Infinity leaves everything in.
 */
function fitMetaParts(exchange: PromptExchange, ui: ResolvedUi, thinkTokens: number, room: number): string {
  let fields = [...ui.meta];
  const build = (abbrev: boolean): string[] =>
    fields
      .map((f) => {
        const v = metaField(f, exchange, thinkTokens);
        return abbrev && f === "bucket" && v ? v.replace(" (answered anyway)", "") : v;
      })
      .filter((v): v is string => v !== null);
  const width = (parts: string[]): number =>
    parts.reduce((n, p) => n + visibleWidth(p), 0) + META_SEP.length * Math.max(0, parts.length - 1);
  let abbrev = false;
  let parts = build(abbrev);
  if (width(parts) > room) {
    abbrev = true;
    parts = build(abbrev);
  }
  for (const drop of META_DROP_ORDER) {
    if (width(parts) <= room) break;
    if (!fields.includes(drop) || parts.length <= 1) continue;
    fields = fields.filter((f) => f !== drop);
    parts = build(abbrev);
  }
  const line = parts.join(META_SEP);
  // One field wider than the row (a long model id): clip it with an ellipsis.
  return width(parts) > room ? fitRow(line, room + 2) : line;
}

/** The meta fields joined as one plain string, with the exchange's status glyph. */
export function metaText(
  exchange: PromptExchange,
  ui: ResolvedUi,
  thinkTokens = 0,
  room: number = Number.POSITIVE_INFINITY
): { text: string; glyph: string; color: string } | null {
  if (ui.meta.length === 0) return null;
  const text = fitMetaParts(exchange, ui, thinkTokens, room);
  if (text === "") return null;
  const status = STATUS[exchange.bucket] ?? STATUS.result;
  return { text, glyph: status.glyph, color: status.color };
}

/**
 * Build the meta line(s) shown with an answer.
 *
 * `ui.meta` is an ordered list, so the line reads in the order the surface
 * declares. An empty list means no meta at all. `columns` is the terminal
 * width the line must fit (default: unbounded, for callers that fit it).
 */
export function renderMeta(
  exchange: PromptExchange,
  ui: ResolvedUi,
  thinkTokens = 0,
  columns: number = Number.POSITIVE_INFINITY
): string[] {
  if (ui.meta.length === 0) return [];
  // "  ✓ " leads the rule row, and compact has two spaces.
  const line = fitMetaParts(exchange, ui, thinkTokens, columns - 5);
  if (line === "") return [];

  const status = STATUS[exchange.bucket] ?? STATUS.result;

  if (ui.meta_style === "compact") {
    return [paint(ui, "gray", `  ${line}`)];
  }
  return [
    paint(ui, "gray", `  ${"─".repeat(Math.max(0, Math.min(60, visibleWidth(line) + 4, columns - 2)))}`),
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
  lines.push(...renderMeta(exchange, ui, thinkTokens, terminalWidth()));
  lines.push("");
  return lines;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Braille frames, except in the legacy Windows console. conhost's default
 * raster and Lucida fonts have no braille, so the spinner drew a row of boxes.
 * Windows Terminal sets WT_SESSION and VS Code sets TERM_PROGRAM; both render
 * braille and keep it.
 */
export function spinnerFrames(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env
): string[] {
  const legacyConsole = platform === "win32" && !env.WT_SESSION && !env.TERM_PROGRAM;
  return legacyConsole
    ? ["|", "/", "-", "\\"]
    : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
}

/** What a spinner draws: its frames, how long each stays, and the columns a frame takes. */
export interface SpinnerSpec {
  frames: string[];
  ms: number;
  width: number;
}

/**
 * The spinner for `[ui] spinner`. The default is the sundial: the shaded half of
 * the dial turns clockwise, the shadow sweeping round, as in gnomon's mark.
 * The legacy Windows console has none of these glyphs and always gets ascii.
 */
export function spinnerSpec(
  style: "sundial" | "clock" | "braille" | "ascii" = "sundial",
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env
): SpinnerSpec {
  const ascii = { frames: ["|", "/", "-", "\\"], ms: 100, width: 1 };
  if (legacyWindowsConsole(platform, env) || style === "ascii") return ascii;
  switch (style) {
    case "clock":
      return {
        frames: ["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"],
        ms: 150,
        width: 2,
      };
    case "braille":
      return { frames: spinnerFrames(platform, env), ms: 80, width: 1 };
    default:
      return { frames: ["◐", "◓", "◑", "◒"], ms: 150, width: 1 };
  }
}

function accentOf(ui: ResolvedUi, text: string): string {
  const c = themeOf(ui).look?.accent;
  if (!c) return paint(ui, "cyan", text);
  if (!ui.color || process.env.NO_COLOR) return text;
  return `${ESC}${colorCode(c, colorDepth())}m${text}${RESET}`;
}

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
  private readonly spec: SpinnerSpec;

  constructor(
    private ui: ResolvedUi,
    private out: NodeJS.WriteStream = process.stdout
  ) {
    this.spec = spinnerSpec(ui.spinner_style);
  }

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
    this.timer = setInterval(() => this.draw(), this.spec.ms);
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
    this.out.write(`\r\x1b[2K${this.row()}`);
  }

  /** One frame's row: `◐ thinking · 12s · esc cancels`, never wider than the terminal. */
  row(now = Date.now()): string {
    const e = (now - this.started) / 1000;
    const secs = e < 10 ? `${e.toFixed(1)}s` : `${Math.round(e)}s`;
    const f = this.spec.frames[this.frame++ % this.spec.frames.length];
    const cols = this.out.columns || 80;
    const tail = ` · ${secs} · esc cancels`;
    // 2 leading columns, the frame, a space, then label and tail.
    const room = Math.max(8, cols - 2 - this.spec.width - 1);
    const { head, tail: over } = cut(this.label, Math.max(4, room - visibleWidth(tail) - 1));
    const label = over ? `${head}…` : head;
    const glyph = accentOf(this.ui, f);
    return `  ${glyph} ${label}${paint(this.ui, "gray", tail)}`;
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
export function safeForPrompt(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g, (c) => {
    const code = c.charCodeAt(0);
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
}


/**
 * What some providers put in the reasoning channel when there is no
 * reasoning. OpenCode Go's free tier answers `content: null` with
 * `reasoning: "No reasoning available."`, and the loop reads that channel
 * when content is empty -- so the trace printed the same sentence under all
 * sixty steps of a turn, measured 2026-10-21. It says nothing, so it is not
 * shown. It is still what the model returned, and the transcript keeps it.
 */
const EMPTY_TRACE = /^(no reasoning( (is )?available)?|no thoughts?|reasoning (is )?not available|n\/a|none)[.!]?$/i;

/** A provider's stand-in for "no reasoning", which is not text the model wrote. */
export function isEmptyReasoning(text: string): boolean {
  return EMPTY_TRACE.test(text.trim());
}

// ---------------------------------------------------------------------------
// The live step trace
//
// What a turn prints while it works, one block per model response:
//
//   ✻ reasoning, from <think> tags or the provider's reasoning channel
//   ● the prose the model wrote beside its calls
//   ⚙ tool  what it was called on
//     ⎿ what came back, and a line of what it printed
//
// The reasoning channel (`reasoning_content`) is where GLM, DeepSeek, Kimi and
// Qwen-over-API put their chain of thought. It was replayed to the model and
// never shown, so a turn on those models read as a row of tool calls with no
// reason for any of them.
// ---------------------------------------------------------------------------

/**
 * The result half of a tool summary.
 *
 * Summaries read `tool subject — result` (`glob **\/*.py — 16 file(s)`), and
 * the `⚙` line above already names the tool and its subject, so printing them
 * twice is noise. A summary without that shape is returned whole.
 */
export function summaryResult(summary: string): string {
  const i = summary.indexOf(" — ");
  if (i < 0) return summary;
  const rest = summary.slice(i + 3).trim();
  return rest || summary;
}

// CSI and OSC sequences a program printed for its own terminal. Shown escaped
// they are noise (`\x1b[32mPASSED`), so a glimpse drops them before escaping
// whatever control characters are left.
// eslint-disable-next-line no-control-regex
const ANSI_SEQ = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * What a command printed, in one clause, for the line under its step.
 *
 * Success: how many lines it printed and the first of them, which is where a
 * listing, a count or a version starts. Failure: the last line of stderr,
 * else of stdout, which is where tracebacks, compilers and test runners put
 * the verdict. Display only; the model gets the full output as before.
 *
 * Program-chosen text, so terminal sequences are dropped and remaining control
 * characters escaped (safeForPrompt).
 */
export function outputGlimpse(stdout: string, stderr: string, failed: boolean): string {
  const lines = (s: string): string[] =>
    s
      .replace(ANSI_SEQ, "")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "");
  const out = lines(stdout);
  const err = lines(stderr);
  const clip = (l: string): string => {
    const safe = safeForPrompt(l.trim());
    return safe.length > 160 ? `${safe.slice(0, 159)}…` : safe;
  };
  if (failed) {
    const last = err.at(-1) ?? out.at(-1);
    return last ? clip(last) : "no output";
  }
  if (out.length === 0) return err.length ? `no stdout · ${clip(err[0]!)}` : "no output";
  return `${out.length} line${out.length === 1 ? "" : "s"} · ${clip(out[0]!)}`;
}

/** Fit one rendered row to the terminal, so a wrapped row cannot outlive the spinner's erase. */
export function fitRow(text: string, columns: number): string {
  const { head, tail } = cut(text, Math.max(20, columns - 2));
  return tail ? `${head}…` : head;
}

/** What a list item starts with, so a wrapped row can hang under its text. */
const LIST_LEAD = /^(\s*(?:[-*•]|\d+[.)])\s+)/;

/**
 * Word-wrap text to `width` display columns.
 *
 * Breaks at spaces; only a word wider than the row is split, at a grapheme
 * boundary. A list item ("- ", "1. ") keeps a hanging indent so its
 * continuation rows line up under the text. Control characters are escaped
 * (safeForPrompt) before measuring, so a carriage return cannot rewrite a row,
 * and every row is at most `width` columns. A "\n" starts a new paragraph.
 */
export function wordWrap(text: string, width: number): string[] {
  const w = Math.max(8, Math.floor(width));
  const out: string[] = [];
  for (const raw0 of text.split("\n")) {
    const raw = safeForPrompt(raw0);
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push("");
      continue;
    }
    const lead = LIST_LEAD.exec(line)?.[1];
    const indent = lead ?? /^\s*/.exec(line)![0];
    const hang = " ".repeat(Math.min(visibleWidth(indent), Math.floor(w / 2)));
    // A lead too wide to hang under is dropped to the hang width.
    const first = lead && visibleWidth(lead) <= Math.floor(w / 2) ? lead : hang;
    const words = line.slice(indent.length).split(/ +/).filter(Boolean);
    let row = first;
    let hasWord = false;
    const flush = (): void => {
      out.push(row.trimEnd());
      row = hang;
      hasWord = false;
    };
    for (let word of words) {
      if (hasWord && visibleWidth(row) + 1 + visibleWidth(word) > w) flush();
      // A word wider than the row: hard-split it.
      while (!hasWord && visibleWidth(row) + visibleWidth(word) > w) {
        const { head, tail } = cut(word, Math.max(1, w - visibleWidth(row)));
        if (!head) break;
        row += head;
        word = tail;
        flush();
      }
      row += (hasWord ? " " : "") + word;
      hasWord = word !== "";
    }
    out.push(row.trimEnd());
  }
  return out;
}

/** Cut at the last word boundary that fits, `…` marking the cut. */
function cutAtWord(line: string, room: number): { text: string; cut: boolean } {
  if (visibleWidth(line) <= room) return { text: line, cut: false };
  const { head } = cut(line, room - 1);
  const sp = head.lastIndexOf(" ");
  // One long token has no boundary worth keeping: cut it where it falls.
  const clipped = sp > head.length / 3 ? head.slice(0, sp) : head;
  return { text: `${clipped.trimEnd()}…`, cut: true };
}

export interface TraceOptions {
  /** Columns already spent left of the returned rows (prefix + gutter). Default 6. */
  reserve?: number;
  /** Whether a row naming the other modes may be added. Default true. */
  hint?: boolean;
}

/**
 * The leading characters of a tool-call tag and nothing else (`<`, `<t`,
 * `<tool_ca`). A server's tool-call parser can leak the start of the tag it
 * swallowed into the content beside a real call (nemotron-3-super via
 * OpenRouter sends `<t`); that is not prose and is not shown as it.
 */
export function isToolTagStub(text: string): boolean {
  return text.length > 0 && text.startsWith("<") && ["<tool_call>", "<function=", "<function_call>"].some((t) => t.startsWith(text));
}

/**
 * A trace note and the longest of its "how to see more" tails that still fits
 * `room`: a note wider than the row wraps in the terminal, and a wrapped row
 * is one the spinner's erase-line cannot see. With no tail that fits, the
 * bare note, cut to the row if even that is too wide.
 */
function hintRow(note: string, tails: string[], room: number): string {
  for (const t of tails) if ([...note + t].length <= room) return note + t;
  return [...note].length <= room ? note : [...note].slice(0, Math.max(1, room - 1)).join("") + "…";
}

/**
 * Model prose shown while a turn works, as lines ready for a `  │ ` prefix.
 *
 * - `collapse`: the first three lines, one row each, cut at a word boundary.
 * - `wrap`: the first three lines in full, word-wrapped, at most 12 rows.
 * - `show`: everything, word-wrapped with a hanging indent.
 *
 * No row is wider than `columns - reserve`: a wider row wraps in the
 * terminal, and a wrapped row is one the spinner's erase-line cannot see.
 * Every line is model-chosen text, so control characters are escaped -- a
 * carriage return in the reasoning rewrote the line before it.
 */
export function traceLines(
  text: string,
  mode: ThinkMode,
  columns: number,
  opts: TraceOptions = {}
): string[] {
  const body = text.trim();
  if (!body || mode === "hide" || isEmptyReasoning(body)) return [];
  const room = Math.max(20, columns - (opts.reserve ?? 6));
  const hint = opts.hint !== false;
  if (mode === "show") return wordWrap(body, room);
  const lines = body
    .split("\n")
    .map((l) => safeForPrompt(l.trimEnd()))
    .filter((l) => l.trim());
  const kept = lines.slice(0, 3);
  if (mode === "wrap") {
    const rows: string[] = [];
    let shown = 0;
    for (const l of kept) {
      const wrapped = wordWrap(l, room);
      if (rows.length + wrapped.length > 12) {
        rows.push(...wrapped.slice(0, 12 - rows.length));
        break;
      }
      rows.push(...wrapped);
      shown++;
    }
    const left = lines.length - shown;
    if (left > 0) rows.push(hintRow(`… ${left} more line(s)`, hint ? [" — /think show"] : [], room));
    return rows;
  }
  let cutAny = false;
  const rows = kept.map((l) => {
    const r = cutAtWord(l, room);
    cutAny ||= r.cut;
    return r.text;
  });
  const hidden = lines.length - kept.length;
  const ways = [" — /think wrap (whole lines) · /think show (all)", " — /think wrap · /think show", " — /think show"];
  if (hidden > 0) rows.push(hintRow(`… ${hidden} more line(s)`, hint ? ways : [], room));
  else if (cutAny && hint) rows.push(hintRow("… cut at the row edge", ways, room));
  return rows;
}

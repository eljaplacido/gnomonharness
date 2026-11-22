/**
 * gnomon-core: the boxed look.
 *
 * `[ui] style = "boxed"` frames the interactive terminal: a startup card, a
 * status rule above the prompt, and a rail down the left of each turn with a
 * header and footer. Everything here is pure (it returns lines) and takes its
 * environment -- columns, colour depth, ascii-only -- as an argument, so the
 * layout is testable at any width and depth.
 *
 * Two rules keep it from breaking a terminal:
 *   - Nothing is drawn to the right of, or below, the input line. Readline
 *     redraws that line itself and would erase it.
 *   - Rows are never wider than `columns`. The rail replaces the two-space
 *     indent the classic trace already uses, so no width is spent.
 *
 * No dependencies; ANSI escapes only.
 */

import type { ResolvedUi } from "./config.js";
import { themeOf, wordWrap, fitRow, type Theme, type ThemeColor, type BorderName } from "./render.js";
import { cut, plain, visibleWidth } from "./width.js";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** 4 = the 16 ANSI colours, 8 = the 256 palette, 24 = truecolor. */
export type Depth = 4 | 8 | 24;

type Env = Record<string, string | undefined>;

export function colorDepth(env: Env = process.env): Depth {
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return 24;
  if ((env.TERM ?? "").includes("256color")) return 8;
  return 4;
}

/** Windows' legacy console (conhost): no WT_SESSION and nothing that speaks VT. */
export function legacyWindowsConsole(
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env
): boolean {
  return (
    platform === "win32" &&
    !env.WT_SESSION &&
    !env.TERM_PROGRAM &&
    env.ConEmuANSI !== "ON" &&
    !env.ANSICON &&
    !env.TERM
  );
}

/** Should borders be drawn with + - | ? */
export function asciiOnly(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if ((env.TERM ?? "") === "dumb") return true;
  if (legacyWindowsConsole(platform, env)) return true;
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (loc && !/utf-?8/i.test(loc) && platform !== "win32") return true;
  return false;
}

/** Is the boxed style in force? `classic` never; `boxed` always; `auto` on a capable TTY. */
export function boxedActive(
  ui: Pick<ResolvedUi, "style" | "color">,
  out: { isTTY?: boolean; columns?: number } = process.stdout,
  env: Env = process.env
): boolean {
  const style = ui.style ?? "auto";
  if (style === "classic") return false;
  if (style === "boxed") return true;
  return Boolean(out.isTTY) && (out.columns ?? 0) >= 60 && ui.color && !env.NO_COLOR;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Nearest xterm-256 index for an RGB colour. */
export function to256(r: number, g: number, b: number): number {
  const cube = (v: number): number => Math.round((v / 255) * 5);
  const ci = 16 + 36 * cube(r) + 6 * cube(g) + cube(b);
  const grey = Math.round(((r + g + b) / 3 - 8) / 10);
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && grey >= 0 && grey < 24) return 232 + grey;
  return ci;
}

/** The SGR parameters for a colour at a depth. */
export function colorCode(c: ThemeColor, depth: Depth): string {
  if (depth === 24) {
    const [r, g, b] = rgb(c.hex);
    return `38;2;${r};${g};${b}`;
  }
  if (depth === 8) {
    const [r, g, b] = rgb(c.hex);
    return `38;5;${to256(r, g, b)}`;
  }
  return String(c.c16);
}

/** Turn a truecolor code (`38;2;r;g;b`) into what a lesser terminal can show. */
export function downgradeCode(code: string, depth: Depth): string {
  if (depth === 24) return code;
  return code.replace(/\x1b\[([0-9;]*)m/g, (m, p: string) => {
    const t = /^38;2;(\d+);(\d+);(\d+)$/.exec(p);
    if (!t) return m;
    const [r, g, b] = [Number(t[1]), Number(t[2]), Number(t[3])];
    if (depth === 8) return `${ESC}38;5;${to256(r, g, b)}m`;
    // 16 colours: pick by hue and brightness.
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    if (hi - lo < 30) return `${ESC}${hi > 190 ? 97 : hi > 120 ? 37 : 90}m`;
    const bright = hi > 200 ? 60 : 0;
    const name =
      r >= g && r >= b
        ? g > b * 1.4 && g > r * 0.5
          ? 33
          : b > g * 1.4 && b > r * 0.5
            ? 35
            : 31
        : g >= r && g >= b
          ? b > r * 1.2 && b > g * 0.6
            ? 36
            : 32
          : r > g * 1.2 && r > b * 0.6
            ? 35
            : g > r * 1.2 && g > b * 0.6
              ? 36
              : 34;
    return `${ESC}${name + bright}m`;
  });
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface BoxCtx {
  ui: ResolvedUi;
  theme: Theme;
  columns: number;
  depth: Depth;
  ascii: boolean;
  /** Colour at all: ui.color and no NO_COLOR. */
  color: boolean;
}

export interface BoxEnvOverride {
  columns?: number;
  depth?: Depth;
  ascii?: boolean;
  color?: boolean;
}

export function boxCtx(ui: ResolvedUi, o: BoxEnvOverride = {}): BoxCtx {
  const cols = o.columns ?? (process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 80);
  return {
    ui,
    theme: themeOf(ui),
    columns: Math.max(30, cols),
    depth: o.depth ?? colorDepth(),
    ascii: o.ascii ?? asciiOnly(),
    color: o.color ?? (ui.color && !process.env.NO_COLOR),
  };
}

/** Paint with a palette role, downgraded to the depth. */
export function role(ctx: BoxCtx, name: string, text: string): string {
  if (!ctx.color) return text;
  const code = ctx.theme.codes[name];
  return code ? `${downgradeCode(code, ctx.depth)}${text}${RESET}` : text;
}

function tint(ctx: BoxCtx, c: ThemeColor | undefined, text: string, attr = ""): string {
  if (!ctx.color || (!c && !attr)) return text;
  const parts = [attr, c ? colorCode(c, ctx.depth) : ""].filter(Boolean).join(";");
  return `${ESC}${parts}m${text}${RESET}`;
}

export const accent = (ctx: BoxCtx, text: string, bold = false): string =>
  tint(ctx, ctx.theme.look?.accent, text, bold ? "1" : "");
export const railTint = (ctx: BoxCtx, text: string): string => tint(ctx, ctx.theme.look?.rail, text);

// ---------------------------------------------------------------------------
// Borders
// ---------------------------------------------------------------------------

export interface BorderSet {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

export const BORDERS: Record<BorderName, BorderSet> = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  sharp: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};

export function bordersOf(ctx: BoxCtx): BorderSet {
  return ctx.ascii ? BORDERS.ascii : BORDERS[ctx.theme.look?.border ?? "rounded"];
}

/** The dial mark. ASCII borders get an ASCII mark. */
export function mark(ctx: BoxCtx): string {
  return ctx.ascii ? "o" : "◐";
}

const bullet = (ctx: BoxCtx): string => (ctx.ascii ? "*" : "◆");
const dot = (ctx: BoxCtx): string => (ctx.ascii ? "-" : "·");

/** Truncate plain text to `w` columns with an ellipsis. */
export function clip(text: string, w: number): string {
  if (w <= 0) return "";
  if (visibleWidth(text) <= w) return text;
  if (w === 1) return "…";
  return `${cut(text, w - 1).head}…`;
}

function chip(ctx: BoxCtx, text: string): string {
  const look = ctx.theme.look;
  const c = look?.accent;
  switch (look?.chip) {
    case "inverse":
      return ctx.color ? `${ESC}1;7;${colorCode(c ?? { hex: "#fff", c16: 37 }, ctx.depth)}m ${text} ${RESET}` : `[${text}]`;
    case "bold":
      return tint(ctx, c, text, "1");
    default:
      return tint(ctx, c, text);
  }
}

// ---------------------------------------------------------------------------
// Rules: header, footer, status
// ---------------------------------------------------------------------------

/** `╭─ <title> ─────────` filling the width; `title` is already painted. */
function rule(ctx: BoxCtx, left: string, title: string, right = ""): string {
  const b = bordersOf(ctx);
  const titleW = visibleWidth(title);
  const rightW = right ? visibleWidth(right) + 1 : 0;
  const fill = Math.max(1, ctx.columns - 1 - 3 - titleW - rightW);
  return (
    railTint(ctx, `${left}${b.h} `) +
    title +
    railTint(ctx, ` ${b.h.repeat(fill)}`) +
    (right ? ` ${right}` : "")
  );
}

export interface StatusInfo {
  role: string;
  model?: string;
  ctxPct?: number;
  cost?: string;
  branch?: string;
}

/** The status rule printed before each prompt. Only the values the loop has. */
export function statusRule(ctx: BoxCtx, s: StatusInfo): string {
  const b = bordersOf(ctx);
  const d = ` ${dot(ctx)} `;
  const left = [s.role, s.model].filter(Boolean) as string[];
  const right: string[] = [];
  if (s.ctxPct !== undefined) right.push(`ctx ${Math.max(0, Math.min(999, Math.round(s.ctxPct)))}%`);
  if (s.cost) right.push(s.cost);
  if (s.branch) right.push(s.branch);
  const rightRaw = right.join(d);
  // Budget: "╭─ " + left + " " + fill + " " + right + " ─"
  const fixed = 3 + 1 + (rightRaw ? 1 + 2 : 0) + 1;
  let leftTxt = left.join(d);
  let rightTxt = rightRaw;
  const room = ctx.columns - 1 - fixed;
  if (visibleWidth(leftTxt) + visibleWidth(rightTxt) > room) {
    rightTxt = clip(rightTxt, Math.max(0, Math.floor(room / 2)));
    leftTxt = clip(leftTxt, Math.max(4, room - visibleWidth(rightTxt)));
  }
  const fill = Math.max(1, room - visibleWidth(leftTxt) - visibleWidth(rightTxt));
  const parts: string[] = [
    railTint(ctx, `${b.tl}${b.h} `),
    accent(ctx, leftTxt, true),
    railTint(ctx, ` ${b.h.repeat(fill)}`),
  ];
  if (rightTxt) parts.push(" ", role(ctx, "gray", rightTxt), railTint(ctx, ` ${b.h}`));
  return parts.join("");
}

/** The prompt string itself. Nothing is drawn after it. */
export function promptGlyph(ctx: BoxCtx): string {
  return accent(ctx, ctx.ascii ? ">" : "›", true) + " ";
}

export function turnHeader(ctx: BoxCtx, h: { role: string; model?: string }): string {
  const title = `${chip(ctx, `${bullet(ctx)} ${h.role}`)}${h.model ? role(ctx, "gray", ` ${dot(ctx)} ${clip(h.model, Math.max(8, ctx.columns - 14 - visibleWidth(h.role)))}`) : ""}`;
  return rule(ctx, bordersOf(ctx).tl, title);
}

export function turnFooter(ctx: BoxCtx, f: { glyph?: string; glyphRole?: string; text: string }): string {
  const b = bordersOf(ctx);
  const glyph = f.glyph ? `${role(ctx, f.glyphRole ?? "green", f.glyph)} ` : "";
  const room = Math.max(8, ctx.columns - 6 - visibleWidth(glyph));
  const title = glyph + role(ctx, "gray", clip(f.text, room));
  return rule(ctx, b.bl, title);
}

const LEAD_ESC = /^((?:\x1b\[[0-9;]*m)*)  /;

/**
 * Put the rail where a trace row's two-space indent is. A row that does not
 * start with that indent (an answer, a wrapped paragraph) is left alone, so no
 * row ever grows. A blank row keeps the rail unbroken.
 */
export function railLine(ctx: BoxCtx, text: string): string {
  const v = bordersOf(ctx).v;
  return text
    .split("\n")
    .map((l) => {
      if (l === "") return railTint(ctx, v);
      const m = LEAD_ESC.exec(l);
      const row = m ? `${railTint(ctx, v)}${m[1]} ${l.slice(m[0].length)}` : l;
      // A row wider than the terminal wraps, and a wrapped row is one the
      // spinner's erase-line cannot see: cut it.
      return visibleWidth(row) > ctx.columns ? fitRow(row, ctx.columns) + (ctx.color ? RESET : "") : row;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Startup card
// ---------------------------------------------------------------------------

export interface CardInfo {
  version: string;
  role: string;
  model: string;
  where?: "local" | "cloud";
  surface?: string;
  governance?: string;
  audit?: boolean;
  repo: string;
  branch?: string;
  changed?: number;
}

export const TAGLINE = "the shadow tells the time — a coding agent you can audit";
export const CARD_HINTS = "/help /cot /think /skills /models · Esc cancels a turn";

export function startupCard(ctx: BoxCtx, c: CardInfo): string[] {
  const b = bordersOf(ctx);
  const W = Math.min(ctx.columns - 1, 88);
  const inner = W - 4;
  const d = ` ${dot(ctx)} `;
  const row = (segs: Array<[string, (t: string) => string]>): string => {
    let left = inner;
    let out = "";
    for (const [t, f] of segs) {
      const s = clip(t, left);
      out += f(s);
      left -= visibleWidth(s);
    }
    return `${railTint(ctx, b.v)} ${out}${" ".repeat(Math.max(0, left))} ${railTint(ctx, b.v)}`;
  };
  const id = (t: string): string => t;
  const gray = (t: string): string => role(ctx, "gray", t);
  const kv = (k: string, v: string): string =>
    row([[k.padEnd(8), gray], [v, id]]);
  const lines: string[] = [];
  lines.push(railTint(ctx, `${b.tl}${b.h.repeat(W - 2)}${b.tr}`));
  lines.push(row([[`${mark(ctx)} gnomon`, (t) => accent(ctx, t, true)], [` ${c.version}`, gray]]));
  lines.push(row([[TAGLINE, (t) => role(ctx, "italic", gray(t))]]));
  lines.push(row([]));
  lines.push(kv("role", [c.role, c.model, c.where].filter(Boolean).join(d)));
  const surf = [
    c.surface ? c.surface.slice(0, 12) : undefined,
    c.governance,
    c.audit === undefined ? undefined : `audit ${c.audit ? "on" : "off"}`,
  ].filter(Boolean) as string[];
  if (surf.length) lines.push(kv("surface", surf.join(d)));
  const repo = [c.repo, c.branch, c.changed ? `${c.changed} changed` : undefined].filter(Boolean) as string[];
  lines.push(kv("repo", repo.join(d)));
  lines.push(row([]));
  lines.push(row([[CARD_HINTS, gray]]));
  lines.push(railTint(ctx, `${b.bl}${b.h.repeat(W - 2)}${b.br}`));
  return lines;
}

// ---------------------------------------------------------------------------
// /theme swatch
// ---------------------------------------------------------------------------

/** One line showing a theme: its name, accent, rail and a mini header. */
export function swatch(ctx: BoxCtx): string {
  const b = bordersOf(ctx);
  const t = ctx.theme;
  return (
    accent(ctx, `${mark(ctx)} ${t.name}`, true) +
    "  " +
    railTint(ctx, `${b.v} rail`) +
    "  " +
    railTint(ctx, `${b.tl}${b.h} `) +
    chip(ctx, `${bullet(ctx)} role`) +
    railTint(ctx, ` ${b.h.repeat(4)}${b.tr}`) +
    "  " +
    role(ctx, "gray", "secondary") +
    " " +
    role(ctx, "yellow", "attention")
  );
}

export { plain };

// ---------------------------------------------------------------------------
// A scripted turn, for tests and the documentation's samples
// ---------------------------------------------------------------------------

/**
 * What a framed turn looks like, built the way the loop builds it: trace rows
 * with a two-space indent, a delegated sub-turn behind its `┊` gutter, then
 * `railLine` over all of it. Not used at runtime.
 */
export function sampleTurn(ctx: BoxCtx): string[] {
  const g = (t: string): string => role(ctx, "gray", t);
  const gutter = g("  ┊");
  const think = wordWrap(
    "The failing test imports parse() from the old path, so I will read the module first and then fix the import.",
    ctx.columns - 6
  );
  const rows: string[] = [
    ...think.map((l, i) => g(`  ${i === 0 ? "✻" : " "} ${l}`)),
    role(ctx, "cyan", "  ● ") + "read_file src/parse.ts",
    fitRow(g("    ⎿ 84 lines · export function parse(input: string)"), ctx.columns),
    role(ctx, "cyan", `  ${bullet(ctx)} `) + "plan · delegating the test run",
    `${gutter}${role(ctx, "cyan", "  ● ")}run_tests parse.test.ts`,
    `${gutter}${g("    ⎿ 12 passed")}`,
    g("  ↲ plan: 12 passed, nothing else to change"),
  ];
  const out = [turnHeader(ctx, { role: "build", model: "qwen3.5:122b" })];
  for (const r of rows) out.push(railLine(ctx, r));
  out.push(
    turnFooter(ctx, {
      glyph: "✓",
      text: "turn 3  ·  build  ·  qwen3.5:122b  ·  result  ·  8.4s  ·  ctx 3 turns  ·  2 tool call(s)",
    })
  );
  // The frame is closed first; the answer follows it with no prefix at all.
  out.push("");
  out.push("Fixed: parse() is imported from src/parse.ts; 12 pass.");
  return out;
}

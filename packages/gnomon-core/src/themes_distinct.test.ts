/**
 * gnomon-core: the nine themes are told apart by more than an accent colour.
 *
 * Border, rail glyph, tool glyph, chip style and spinner are each a theme's own;
 * the palette is hex from the theme's scheme and readable on its background.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { boxCtx, turnHeader, railLine, plain, downgradeCode, type Depth } from "./boxed.js";
import { THEMES, paint, spinnerSpec, glyphsOf, type ThemeLook } from "./render.js";
import type { ResolvedUi } from "./config.js";
import { visibleWidth } from "./width.js";

const ui = (theme: string, over: Partial<ResolvedUi> = {}): ResolvedUi => ({
  theme,
  meta: ["turn"],
  meta_style: "line",
  think: "collapse",
  spinner: false,
  color: true,
  markdown: true,
  style: "boxed",
  boxed: true,
  ...over,
});

const names = Object.keys(THEMES);
const looks = (n: string): Required<Pick<ThemeLook, "border" | "chip">> & { rail: string; tool: string; think: string; frames: string[] } => {
  const l = THEMES[n].look!;
  return {
    border: l.border,
    chip: l.chip,
    rail: l.railGlyph ?? { rounded: "│", sharp: "│", heavy: "┃", double: "║", ascii: "|" }[l.border],
    tool: l.toolGlyph ?? "⚙",
    think: l.thinkGlyph ?? "✻",
    frames: l.spinner?.frames ?? ["◐", "◓", "◑", "◒"],
  };
};

const lum = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

afterEach(() => vi.unstubAllEnvs());

describe("distinctive themes", () => {
  it("no two themes share border, rail, tool glyph, chip and spinner", () => {
    const sig = names.map((n) => {
      const l = looks(n);
      return [l.border, l.rail, l.tool, l.chip, l.frames.join("")].join("|");
    });
    expect(new Set(sig).size).toBe(names.length);
  });

  it("the default theme keeps its familiar look", () => {
    expect(looks("dark")).toMatchObject({ border: "rounded", rail: "│", tool: "⚙", think: "✻", chip: "bold" });
    expect(looks("dark").frames).toEqual(["◐", "◓", "◑", "◒"]);
    expect(THEMES.dark.look!.palette).toBeUndefined();
  });

  it("every glyph of every theme is one column wide", () => {
    for (const n of names) {
      const l = looks(n);
      for (const g of [l.rail, l.tool, l.think, ...l.frames]) expect(visibleWidth(g), `${n} ${g}`).toBe(1);
    }
  });

  it("every palette colour reads on its background (WCAG AA, 4.5:1)", () => {
    for (const n of names) {
      const p = THEMES[n].look!.palette;
      if (!p) continue;
      const bg = THEMES[n].terminal?.bg ?? (n === "light" ? "#ffffff" : "#1e1e1e");
      for (const [k, c] of Object.entries(p)) expect(contrast(c!.hex, bg), `${n}.${k} ${c!.hex}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the pill chip paints the accent as a background in the theme's own foreground", () => {
    const c = boxCtx(ui("tokyonight"), { columns: 80, depth: 24, ascii: false, color: true });
    expect(turnHeader(c, { role: "build" })).toContain("\x1b[1;38;2;26;27;38;48;2;122;162;247m ◆ build \x1b[0m");
    const c16 = boxCtx(ui("catppuccin"), { columns: 80, depth: 4, ascii: false, color: true });
    expect(turnHeader(c16, { role: "build" })).toContain("1;30;105m ◆ build ");
  });

  it("brackets and pills stay legible without colour; ascii borders get an ascii rail", () => {
    for (const [n, want] of [["mono", /^╭─ \[◆ build\] ─+$/], ["nord", /^┌─ \[◆ build\] ─+$/], ["gruvbox", /^╔═ \[◆ build\] ═+$/]] as const) {
      const c = boxCtx(ui(n, { color: false }), { columns: 80, depth: 24, ascii: false, color: false });
      expect(plain(turnHeader(c, { role: "build" })), n).toMatch(want);
    }
    const a = boxCtx(ui("gruvbox"), { columns: 80, depth: 24, ascii: true, color: false });
    expect(railLine(a, "  x")).toBe("| x");
    expect(plain(turnHeader(a, { role: "build" }))).toMatch(/^\+- \[\* build\] -+$/);
    expect(glyphsOf(ui("gruvbox"), true)).toEqual({ tool: ">", think: "*" });
    expect(glyphsOf(ui("dark"), true)).toEqual({ tool: "⚙", think: "✻" });
  });

  it("each theme draws its own spinner by default; an explicit style still wins", () => {
    for (const n of names) {
      expect(spinnerSpec("sundial", "linux", {}, THEMES[n].look?.spinner).frames, n).toEqual(looks(n).frames);
    }
    expect(spinnerSpec("braille", "linux", {}, THEMES.nord.look?.spinner).frames[0]).toBe("⠋");
    expect(spinnerSpec("sundial", "win32", {}, THEMES.nord.look?.spinner).frames).toEqual(["|", "/", "-", "\\"]);
  });

  it("mono emits no colour at any depth", () => {
    for (const depth of ["24", "8", "4"]) {
      vi.stubEnv("COLORTERM", depth === "24" ? "truecolor" : "");
      vi.stubEnv("TERM", depth === "8" ? "xterm-256color" : "xterm");
      for (const r of ["green", "red", "yellow", "cyan", "gray", "add", "del"]) {
        expect(paint(ui("mono"), r, "x")).toBe("x");
      }
      const c = boxCtx(ui("mono"), { columns: 80, depth: Number(depth) as Depth, ascii: false, color: true });
      expect(turnHeader(c, { role: "build" })).not.toMatch(/\x1b\[[0-9;]*3[0-9]|38;/);
    }
  });

  it("the palette is truecolor when the terminal is, and today's 16-colour codes when it is not", () => {
    for (const n of names) {
      if (!THEMES[n].look?.palette) continue;
      vi.stubEnv("COLORTERM", "truecolor");
      const p = THEMES[n].look!.palette!;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.ok!.hex.slice(i, i + 2), 16));
      expect(paint(ui(n), "green", "x"), n).toBe(`\x1b[38;2;${r};${g};${b}mx\x1b[0m`);
      vi.stubEnv("COLORTERM", "");
      vi.stubEnv("TERM", "xterm");
      const old = downgradeCode(THEMES[n].codes.green, 4);
      expect(paint(ui(n), "green", "x"), n).toBe(`${old}x\x1b[0m`);
      vi.unstubAllEnvs();
    }
  });

  it("diff sides take the palette's own add and del, green and red without one", () => {
    vi.stubEnv("COLORTERM", "truecolor");
    expect(paint(ui("catppuccin"), "add", "x")).toContain("38;2;148;226;213");
    expect(paint(ui("catppuccin"), "del", "x")).toContain("38;2;243;139;168");
    expect(paint(ui("dark"), "add", "x")).toBe(paint(ui("dark"), "green", "x"));
    expect(paint(ui("dark"), "del", "x")).toBe(paint(ui("dark"), "red", "x"));
  });
});

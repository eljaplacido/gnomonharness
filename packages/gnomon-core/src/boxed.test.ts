/**
 * gnomon-core: the boxed look.
 *
 * Fixed width and colour depth throughout, so the layout is the same on every
 * machine. The plain-text tests strip escapes and read like the screen; the
 * ANSI tests pin what each theme emits at 16, 256 and truecolor.
 */

import { describe, it, expect } from "vitest";
import {
  boxCtx, boxedActive, startupCard, statusRule, promptGlyph, turnHeader, turnFooter,
  railLine, swatch, sampleTurn, panelsTinted, tintRow, panelHeader, colorDepth, asciiOnly, legacyWindowsConsole, plain, type Depth,
} from "./boxed.js";
import { THEMES, renderExchange, renderMeta, Progress, spinnerSpec, spinnerFrames, paint } from "./render.js";
import { resolveUi, type ResolvedUi } from "./config.js";
import { visibleWidth } from "./width.js";

const ui = (over: Partial<ResolvedUi> = {}): ResolvedUi => ({
  theme: "dark",
  meta: ["turn", "role", "model", "bucket", "duration", "context"],
  meta_style: "line",
  think: "collapse",
  spinner: false,
  color: true,
  markdown: true,
  style: "boxed",
  boxed: true,
  ...over,
});

const ctxOf = (columns: number, theme = "dark", depth: Depth = 24, ascii = false, color = true) =>
  boxCtx(ui({ theme, color }), { columns, depth, ascii, color });

const info = {
  version: "0.6.5",
  role: "build",
  model: "qwen3.5:122b",
  where: "local" as const,
  surface: "9f3a1c7e2b5d41aa",
  governance: "prevent",
  audit: true,
  repo: "/home/user/projects/acme-api",
  branch: "feat/parser",
};

const text = (lines: string[]): string => plain(lines.join("\n"));

describe("startup card", () => {
  it("at 60 columns", () => {
    expect(text(startupCard(ctxOf(60), info))).toMatchInlineSnapshot(`
      "╭─────────────────────────────────────────────────────────╮
      │ ◐ gnomon 0.6.5                                          │
      │ the shadow tells the time — a coding agent you can aud… │
      │                                                         │
      │ role    build · qwen3.5:122b · local                    │
      │ surface 9f3a1c7e2b5d · prevent · audit on               │
      │ repo    /home/user/projects/acme-api · feat/parser      │
      │                                                         │
      │ /help /cot /think /skills /models · Esc cancels a turn  │
      ╰─────────────────────────────────────────────────────────╯"
    `);
  });

  it("at 80 columns", () => {
    expect(text(startupCard(ctxOf(80), info))).toMatchInlineSnapshot(`
      "╭─────────────────────────────────────────────────────────────────────────────╮
      │ ◐ gnomon 0.6.5                                                              │
      │ the shadow tells the time — a coding agent you can audit                    │
      │                                                                             │
      │ role    build · qwen3.5:122b · local                                        │
      │ surface 9f3a1c7e2b5d · prevent · audit on                                   │
      │ repo    /home/user/projects/acme-api · feat/parser                          │
      │                                                                             │
      │ /help /cot /think /skills /models · Esc cancels a turn                      │
      ╰─────────────────────────────────────────────────────────────────────────────╯"
    `);
  });

  it("at 120 columns it stops growing", () => {
    const lines = startupCard(ctxOf(120), info);
    expect(lines.every((l) => visibleWidth(l) === 88)).toBe(true);
    expect(text(lines)).toMatchInlineSnapshot(`
      "╭──────────────────────────────────────────────────────────────────────────────────────╮
      │ ◐ gnomon 0.6.5                                                                       │
      │ the shadow tells the time — a coding agent you can audit                             │
      │                                                                                      │
      │ role    build · qwen3.5:122b · local                                                 │
      │ surface 9f3a1c7e2b5d · prevent · audit on                                            │
      │ repo    /home/user/projects/acme-api · feat/parser                                   │
      │                                                                                      │
      │ /help /cot /think /skills /models · Esc cancels a turn                               │
      ╰──────────────────────────────────────────────────────────────────────────────────────╯"
    `);
  });

  it("never wraps, however narrow, and truncates values", () => {
    for (const cols of [30, 40, 60, 80, 120]) {
      for (const l of startupCard(ctxOf(cols), { ...info, repo: "/very/long/".repeat(12) })) {
        expect(visibleWidth(l)).toBeLessThan(cols);
      }
    }
  });
});

describe("status rule and prompt", () => {
  it("shows only what the loop knows", () => {
    const c = ctxOf(80);
    expect(text([statusRule(c, { role: "build", model: "qwen3.5:122b", ctxPct: 12, cost: "$0.03", branch: "feat/parser" })])).toMatchInlineSnapshot(`"╭─ build · qwen3.5:122b ────────────────────── ctx 12% · $0.03 · feat/parser ─"`);
    expect(text([statusRule(c, { role: "build" })])).toMatchInlineSnapshot(`"╭─ build ─────────────────────────────────────────────────────────────────────"`);
    expect(text([statusRule(c, { role: "build", model: "m", branch: "main" })])).not.toContain("ctx");
  });

  it("fits at every width", () => {
    for (const cols of [40, 60, 80, 120]) {
      const l = statusRule(ctxOf(cols), { role: "implement", model: "x".repeat(60), ctxPct: 97, cost: "$12.40", branch: "feat/" + "y".repeat(40) });
      expect(visibleWidth(l)).toBeLessThanOrEqual(cols - 1);
    }
  });

  it("the prompt is a glyph and a space, and nothing after it", () => {
    expect(plain(promptGlyph(ctxOf(80)))).toBe("› ");
    expect(plain(promptGlyph(ctxOf(80, "dark", 24, true)))).toBe("> ");
  });
});

describe("framed turn", () => {
  it("reasoning, a tool step, a delegated sub-turn and a footer", () => {
    expect(text(sampleTurn(ctxOf(80)))).toMatchInlineSnapshot(`
      "╭─ ◆ build · qwen3.5:122b ──────────────────────────────────────────────────────
      │ ✻ The failing test imports parse() from the old path, so I will read the
      │   module first and then fix the import.
      │ ● read_file src/parse.ts
      │   ⎿ 84 lines · export function parse(input: string)
      │ ◆ plan · delegating the test run
      │ ┊  ● run_tests parse.test.ts
      │ ┊    ⎿ 12 passed
      │ ↲ plan: 12 passed, nothing else to change
      ╰─ ✓ turn 3  ·  build  ·  qwen3.5:122b  ·  result  ·  8.4s  ·  ctx 3 turns  … ──

      Fixed: parse() is imported from src/parse.ts; 12 pass."
    `);
  });

  it("every row fits the width at 60, 80 and 120", () => {
    for (const cols of [60, 80, 120]) {
      for (const l of sampleTurn(ctxOf(cols))) expect(visibleWidth(l)).toBeLessThanOrEqual(cols);
    }
  });

  it("the rail takes the place of the two-space indent, so no row grows", () => {
    const c = ctxOf(80);
    const row = "  ● read_file x";
    expect(visibleWidth(railLine(c, row))).toBe(visibleWidth(row));
    expect(plain(railLine(c, row))).toBe("│ ● read_file x");
    // A row that has no indent is left alone, a blank row keeps the rail.
    expect(railLine(c, "answer")).toBe("answer");
    expect(plain(railLine(c, ""))).toBe("│");
    // Escapes ahead of the indent survive.
    expect(railLine(c, "\x1b[37m  hi\x1b[0m")).toContain("\x1b[37m hi");
  });

  it("header and footer carry the turn", () => {
    const c = ctxOf(80);
    expect(plain(turnHeader(c, { role: "plan", model: "m" }))).toMatch(/^╭─ ◆ plan · m ─+$/);
    expect(plain(turnFooter(c, { glyph: "✓", text: "turn 1 · 2s" }))).toMatch(/^╰─ ✓ turn 1 · 2s ─+$/);
  });
});

describe("themes", () => {
  const names = Object.keys(THEMES);

  it("every theme has a look, and the two new ones exist", () => {
    for (const n of names) expect(THEMES[n].look, n).toBeDefined();
    expect(names).toContain("gruvbox");
    expect(names).toContain("nord");
  });

  it("themes differ: border set, accent or chip", () => {
    const sig = names.map((n) => JSON.stringify(THEMES[n].look));
    expect(new Set(sig).size).toBe(names.length);
    expect(THEMES["high-contrast"].look!.border).toBe("heavy");
    expect(THEMES.dim.look!.border).toBe("sharp");
    expect(THEMES.nord.look!.border).toBe("sharp");
    expect(THEMES.gruvbox.look!.border).toBe("double");
    expect(THEMES.dark.look!.accent!.hex).toBe("#E2733F");
  });

  for (const [label, depth] of [["16", 4], ["256", 8], ["truecolor", 24]] as Array<[string, Depth]>) {
    it(`swatches at ${label} colours`, () => {
      const rows = names.map((n) => JSON.stringify(swatch(ctxOf(80, n, depth))));
      expect(rows.join("\n")).toMatchSnapshot();
      // No truecolor escape leaks below truecolor.
      if (depth !== 24) for (const n of names) expect(swatch(ctxOf(80, n, depth))).not.toContain("38;2;");
    });
  }

  it("mono keeps the box and drops the colour", () => {
    const s = swatch(ctxOf(80, "mono", 24, false, false));
    expect(s).not.toContain("\x1b");
    expect(s).toContain("╭─");
  });

  it("the swatch names the theme", () => {
    for (const n of names) expect(plain(swatch(ctxOf(80, n)))).toContain(n);
  });
});

describe("colour depth, ascii and platform", () => {
  it("reads depth from the environment", () => {
    expect(colorDepth({ COLORTERM: "truecolor" })).toBe(24);
    expect(colorDepth({ COLORTERM: "24bit" })).toBe(24);
    expect(colorDepth({ TERM: "xterm-256color" })).toBe(8);
    expect(colorDepth({ TERM: "xterm" })).toBe(4);
    expect(colorDepth({})).toBe(4);
  });

  it("falls back to ascii borders", () => {
    expect(asciiOnly({ TERM: "dumb" }, "linux")).toBe(true);
    expect(asciiOnly({ LANG: "C" }, "linux")).toBe(true);
    expect(asciiOnly({ LANG: "en_US.UTF-8" }, "linux")).toBe(false);
    expect(asciiOnly({}, "linux")).toBe(false);
    expect(asciiOnly({}, "win32")).toBe(true);
    expect(asciiOnly({ WT_SESSION: "x" }, "win32")).toBe(false);
    expect(legacyWindowsConsole("win32", { TERM_PROGRAM: "vscode" })).toBe(false);
  });

  it("draws +-| with the ascii set, at every width", () => {
    const lines = [...startupCard(ctxOf(80, "dark", 24, true), info), ...sampleTurn(ctxOf(80, "dark", 24, true))];
    const t = text(lines);
    expect(t).toMatch(/^\+-+\+$/m);
    expect(t).toContain("| role");
    expect(t).not.toMatch(/[╭╮╰╯─│◐]/);
    expect(t).toMatchSnapshot();
  });

  it("auto is boxed only on a wide colour TTY", () => {
    const u = { style: "auto" as const, color: true };
    expect(boxedActive(u, { isTTY: true, columns: 80 }, {})).toBe(true);
    expect(boxedActive(u, { isTTY: true, columns: 59 }, {})).toBe(false);
    expect(boxedActive(u, { isTTY: false, columns: 120 }, {})).toBe(false);
    expect(boxedActive({ ...u, color: false }, { isTTY: true, columns: 80 }, {})).toBe(false);
    expect(boxedActive(u, { isTTY: true, columns: 80 }, { NO_COLOR: "1" })).toBe(false);
    expect(boxedActive({ style: "classic", color: true }, { isTTY: true, columns: 120 }, {})).toBe(false);
    expect(boxedActive({ style: "boxed", color: true }, { isTTY: false }, {})).toBe(true);
  });
});

describe("[ui] style and spinner resolve", () => {
  const cfg = (u: Record<string, unknown>) => resolveUi({ config: { ui: u } } as never);

  it("default to auto and sundial", () => {
    const r = cfg({});
    expect(r.style).toBe("auto");
    expect(r.spinner_style).toBe("sundial");
    expect(r.spinner).toBe(true);
  });

  it("read the declared values", () => {
    expect(cfg({ style: "classic" }).style).toBe("classic");
    expect(cfg({ style: "nonsense" }).style).toBe("auto");
    expect(cfg({ spinner: "clock" }).spinner_style).toBe("clock");
    expect(cfg({ spinner: "clock" }).spinner).toBe(true);
    expect(cfg({ spinner: false }).spinner).toBe(false);
  });
});

describe("classic is untouched", () => {
  it("renders the exchange and meta line exactly as before", () => {
    const c = ui({ style: "classic", boxed: false, color: false });
    const ex = {
      turn: 3, role: "implement", input: "hi", output: "hello", model: "qwen3.6:35b",
      code: 0, bucket: "result", duration_ms: 4200, context_turns: 2,
    };
    expect(renderExchange(ex, c)).toEqual([
      "",
      "  hello",
      "",
      "  ────────────────────────────────────────────────────────────",
      "  ✓ turn 3  ·  implement  ·  qwen3.6:35b  ·  result  ·  4.2s  ·  ctx 2 turns",
      "",
    ]);
    expect(renderMeta(ex, { ...c, meta_style: "compact" })).toEqual([
      "  turn 3  ·  implement  ·  qwen3.6:35b  ·  result  ·  4.2s  ·  ctx 2 turns",
    ]);
  });

  it("paint does not downgrade a truecolor theme unless boxed", () => {
    const classic = paint({ ...ui({ theme: "tokyonight" }), boxed: false }, "gray", "x");
    expect(classic).toBe("\x1b[38;2;86;95;137mx\x1b[0m");
  });
});

describe("spinner", () => {
  it("has the frame sets", () => {
    expect(spinnerSpec("sundial", "linux", {}).frames).toEqual(["◐", "◓", "◑", "◒"]);
    expect(spinnerSpec("sundial", "linux", {}).ms).toBe(150);
    expect(spinnerSpec("clock", "linux", {}).frames).toHaveLength(12);
    expect(spinnerSpec("clock", "linux", {}).frames[0]).toBe("🕛");
    expect(spinnerSpec("clock", "linux", {}).width).toBe(2);
    expect(spinnerSpec("braille", "linux", {}).frames).toEqual(spinnerFrames("linux", {}));
    expect(spinnerSpec("ascii", "linux", {}).frames).toEqual(["|", "/", "-", "\\"]);
  });

  it("the legacy Windows console always gets ascii", () => {
    for (const s of ["sundial", "clock", "braille", "ascii"] as const) {
      expect(spinnerSpec(s, "win32", {}).frames).toEqual(["|", "/", "-", "\\"]);
    }
    expect(spinnerSpec("sundial", "win32", { WT_SESSION: "x" }).frames[0]).toBe("◐");
  });

  it("the clock's frames are two columns wide", () => {
    for (const f of spinnerSpec("clock", "linux", {}).frames) expect(visibleWidth(f)).toBe(2);
    for (const f of spinnerSpec("sundial", "linux", {}).frames) expect(visibleWidth(f)).toBe(1);
  });

  const rowAt = (style: "sundial" | "clock", cols: number, label: string): string => {
    const out = { isTTY: true, columns: cols, write: () => true } as unknown as NodeJS.WriteStream;
    const p = new Progress(ui({ spinner: true, spinner_style: style, color: false, boxed: false }), out);
    p.start(label); // draws once, then arms a timer
    const r = p.row(Date.now() + 12_000);
    p.stop();
    return r;
  };

  it("reads like Claude Code: frame, label, seconds, esc", () => {
    // The frames this machine draws: the sundial, or ascii on a legacy Windows console
    // (the Windows CI runner is one). The frame set itself is pinned by the tests above.
    const frames = spinnerSpec("sundial", process.platform, process.env, THEMES.dark.look?.spinner).frames.map((f) => f.replace(/[\\|]/g, "\\$&")).join("|");
    expect(rowAt("sundial", 80, "thinking")).toMatch(new RegExp(`^ {2}(?:${frames}) thinking · 12s · esc cancels$`));
  });

  it("fits one row at 60 columns, with a long label and the double-width clock", () => {
    for (const style of ["sundial", "clock"] as const) {
      const r = rowAt(style, 60, "qwen3.5:122b — loading model · 14 turn(s) of context and a very long tail of words");
      expect(visibleWidth(r)).toBeLessThanOrEqual(60);
      expect(r).toContain("esc cancels");
      expect(r).toContain("…");
    }
  });
});

describe("the answer sits below the closed frame, unprefixed", () => {
  it("the footer comes before the answer in a framed turn", () => {
    const rows = plain(sampleTurn(ctxOf(80)).join("\n")).split("\n");
    const footer = rows.findIndex((r) => r.startsWith("╰─"));
    const answer = rows.findIndex((r) => r.startsWith("Fixed:"));
    expect(footer).toBeGreaterThan(0);
    expect(answer).toBeGreaterThan(footer);
  });

  it("boxed code has no gutter; classic keeps its own", async () => {
    const { renderMarkdown } = await import("./markdown.js");
    const src = "text\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n";
    const boxed = plain(renderMarkdown(src, ui({ color: false, boxed: true }), 80).join("\n"));
    expect(boxed).toContain("\nconst a = 1;\n");
    expect(boxed).not.toMatch(/│ const/);
    const classic = plain(renderMarkdown(src, ui({ color: false, boxed: false }), 80).join("\n"));
    expect(classic).toContain("  │ const a = 1;");
  });

  it("a rail row wider than the terminal is cut to fit", () => {
    const c = ctxOf(60);
    const r = railLine(c, "  " + "x".repeat(200));
    expect(visibleWidth(r)).toBeLessThanOrEqual(60);
    expect(plain(r)).toMatch(/^│ x+…$/);
  });
});

describe("tinted panels ([ui] panels = tinted)", () => {
  const tinted = (columns = 80, depth: Depth = 24) => boxCtx(ui({ panels: "tinted" }), { columns, depth, ascii: false, color: true });

  it("default is byte-identical: no tint unless the key opts in", () => {
    const c = ctxOf(80);
    expect(panelsTinted(c)).toBe(false);
    expect(tintRow(c, "  hello")).toBe("  hello");
    expect(panelHeader(c, { role: "build" })).toBe(turnHeader(c, { role: "build" }));
  });

  it("tints each row to exactly columns - 1 cells, re-opens after inner resets, never erases the line", () => {
    const c = tinted(60);
    const row = tintRow(c, "│ \x1b[1mhi\x1b[0m there");
    expect(visibleWidth(row)).toBe(59);
    expect(row.endsWith("\x1b[0m")).toBe(true);
    expect(row).toContain("48;2;");
    expect(row).not.toContain("\x1b[K");
    expect(row.split("\x1b[0m").length).toBeGreaterThan(2);
  });

  it("uses the width it is given, so a row after a resize is the new width", () => {
    const c = tinted(80);
    expect(visibleWidth(tintRow(c, "x", 40))).toBe(39);
    expect(visibleWidth(tintRow(c, "x", 100))).toBe(99);
  });

  it("stays plain below truecolor; the header bar fills the width", () => {
    expect(tintRow(tinted(80, 256), "x")).toBe("x");
    expect(visibleWidth(panelHeader(tinted(80), { role: "build", model: "m" }))).toBe(79);
  });
});

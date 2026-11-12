/**
 * gnomon-cli: the dashboard page (dashboard/app.js, app.css), checked without
 * a browser.
 *
 * - Contrast: every colour token used for text is at least 4.5:1 (WCAG AA,
 *   normal text) on every surface it can sit on, read from app.css itself.
 * - Labels: every input, select and textarea has a label, read from app.js.
 * - The confirm dialog, run against a small fake DOM: Esc cancels and runs
 *   nothing, and focus goes back to the control that opened it.
 * - Every button names a command that exists, and the Start step's command is
 *   quoted for the shell it is pasted into.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_COMMANDS } from "./index.js";
import { DASHBOARD_ACTIONS } from "./dashboard_actions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const APP_JS = readFileSync(join(HERE, "..", "dashboard", "app.js"), "utf-8");
const APP_CSS = readFileSync(join(HERE, "..", "dashboard", "app.css"), "utf-8");

// ── a JavaScript scanner just good enough for app.js ────────────────────────
// Strings, template literals, comments and regex literals are skipped, so a
// bracket or quote inside one is never read as code.

const CLOSE: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

function skipQuote(src: string, i: number): number {
  const q = src[i];
  for (i++; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === q) return i + 1;
  }
  throw new Error("unterminated string");
}
function skipTemplate(src: string, i: number): number {
  for (i++; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i + 1;
    else if (src[i] === "$" && src[i + 1] === "{") i = matchClose(src, i + 1);
  }
  throw new Error("unterminated template");
}
function regexAllowed(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j]!)) j--;
  if (j < 0) return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(src[j]!)) return true;
  return /\b(return|typeof|case|of|in)$/.test(src.slice(Math.max(0, j - 6), j + 1));
}
function skipRegex(src: string, i: number): number {
  let cls = false;
  for (i++; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "[") cls = true;
    else if (c === "]") cls = false;
    else if (c === "/" && !cls) {
      i++;
      while (/[a-z]/.test(src[i] ?? "")) i++;
      return i;
    }
  }
  throw new Error("unterminated regex");
}
/** Visit every bracket that is code, with the stack of brackets open around it. */
function walk(src: string, from: number, visit: (i: number, c: string, open: number[]) => boolean | void): number {
  const open: number[] = [];
  for (let i = from; i < src.length; ) {
    const c = src[i]!;
    if (c === '"' || c === "'") i = skipQuote(src, i);
    else if (c === "`") i = skipTemplate(src, i);
    else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i) + 1 || src.length;
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i) + 2;
    else if (c === "/" && regexAllowed(src, i)) i = skipRegex(src, i);
    else {
      if (CLOSE[c]) {
        if (visit(i, c, open)) return i;
        open.push(i);
      } else if (c === ")" || c === "}" || c === "]") {
        const o = open.pop();
        if (o === undefined || CLOSE[src[o]!] !== c) throw new Error(`unbalanced ${c} at ${i}`);
        if (visit(i, c, open)) return i;
      }
      i++;
    }
  }
  return -1;
}
/** The index of the bracket that closes the one at `at`. */
function matchClose(src: string, at: number): number {
  let depth = 0;
  return walk(src, at, (_i, c) => {
    if (CLOSE[c]) depth++;
    else depth--;
    return depth === 0;
  });
}
/** A top-level `function name(...) {...}` from app.js, as source. */
function fn(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  expect(start, `function ${name} in app.js`).toBeGreaterThanOrEqual(0);
  const params = APP_JS.indexOf("(", start);
  const body = APP_JS.indexOf("{", matchClose(APP_JS, params));
  return APP_JS.slice(start, matchClose(APP_JS, body) + 1);
}

// ── contrast ────────────────────────────────────────────────────────────────

const tokens = Object.fromEntries(
  [...APP_CSS.slice(APP_CSS.indexOf(":root {"), APP_CSS.indexOf("}", APP_CSS.indexOf(":root {"))).matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map(
    (m) => [m[1]!, m[2]!]
  )
);
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("dashboard contrast: text tokens are at least 4.5:1", () => {
  // The surfaces text sits on, and the tokens used (or meant) for text.
  const SURFACES = ["ground", "panel", "side", "well", "sunk", "hover", "chip"];
  const TEXT = ["ink", "muted", "dim", "clay", "allowed", "refused"];
  // Dark text on a filled control: primary buttons, timeline segments, toggles.
  const ON_FILL: Array<[string, string]> = [
    ["ground", "clay"],
    ["ground", "local"],
    ["ground", "hybrid"],
    ["ground", "ink"],
    ["refused", "refused-bg"],
    ["allowed", "allowed-bg"],
  ];

  it("reads every token it checks from app.css", () => {
    for (const t of [...SURFACES, ...TEXT, ...ON_FILL.flat()]) expect(tokens[t], `--${t}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it.each(TEXT)("--%s on every surface", (t) => {
    for (const s of SURFACES) {
      expect(contrast(tokens[t]!, tokens[s]!), `--${t} on --${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(ON_FILL)("--%s text on --%s", (fg, bg) => {
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("every token app.css uses as a text colour is one checked here", () => {
    const used = [...APP_CSS.matchAll(/(?:^|[^-])color:\s*var\(--([a-z0-9-]+)\)/gm)].map((m) => m[1]!);
    const checked = new Set([...TEXT, ...ON_FILL.map(([fg]) => fg)]);
    expect(used.length).toBeGreaterThan(0);
    for (const t of used) expect(checked.has(t), `color: var(--${t}) is not checked for contrast`).toBe(true);
  });
});

// ── labels ──────────────────────────────────────────────────────────────────

describe("dashboard labels: every form control has one", () => {
  it("each input, select and textarea is inside a <label> or carries aria-label(ledby)", () => {
    // Every "(" that is code, with the "(" positions open around it.
    const around = new Map<number, number[]>();
    walk(APP_JS, 0, (i, c, open) => {
      if (c === "(") around.set(i, [...open]);
    });
    const controls = [...APP_JS.matchAll(/(?<![\w$])h\("(input|select|textarea)"/g)];
    expect(controls.length).toBeGreaterThanOrEqual(5);
    const unlabelled: string[] = [];
    let checked = 0;
    for (const m of controls) {
      const paren = m.index! + 1;
      const enclosing = around.get(paren);
      if (!enclosing) continue; // inside a string or comment, not code
      checked++;
      const inLabel = enclosing.some((o) => APP_JS.slice(o - 1, o + 8) === 'h("label"');
      const own = APP_JS.slice(paren, matchClose(APP_JS, paren) + 1);
      const aria = /"aria-label(ledby)?":/.test(own);
      if (!inLabel && !aria) {
        const line = APP_JS.slice(0, m.index).split("\n").length;
        unlabelled.push(`app.js:${line} ${own.slice(0, 80)}`);
      }
    }
    expect(checked).toBe(controls.length);
    expect(unlabelled).toEqual([]);
  });

  it("radio groups are fieldsets with a legend", () => {
    expect(APP_JS).toMatch(/h\("fieldset", \{ class: "choices"[^)]*\},\s*h\("legend"/);
  });
});

// ── the confirm dialog, on a fake DOM ───────────────────────────────────────

class FakeNode {
  parent: FakeEl | null = null;
  get isConnected(): boolean {
    for (let n: FakeNode | null = this; n; n = n.parent) if (n === dom.body) return true;
    return false;
  }
}
class FakeText extends FakeNode {
  constructor(public text: string) {
    super();
  }
}
class FakeEl extends FakeNode {
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  listeners = new Map<string, Array<(e: unknown) => void>>();
  style: Record<string, string> = {};
  open = false;
  value = "";
  constructor(public tagName: string) {
    super();
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
    if (k === "value") this.value = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  set textContent(t: string) {
    this.children = [new FakeText(t)];
  }
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.text : (c as FakeEl).textContent)).join("");
  }
  addEventListener(type: string, f: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }
  /** Fire an event; false when a handler called preventDefault. */
  dispatch(type: string): boolean {
    let prevented = false;
    const e = { type, target: this, preventDefault: () => (prevented = true) };
    for (const f of this.listeners.get(type) ?? []) f(e);
    return !prevented;
  }
  append(...kids: Array<FakeNode | string>): void {
    for (const k of kids) {
      const n = typeof k === "string" ? new FakeText(k) : k;
      n.parent?.children.splice(n.parent.children.indexOf(n), 1);
      n.parent = this;
      this.children.push(n);
    }
  }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  focus(): void {
    dom.activeElement = this;
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
  all(): FakeEl[] {
    return this.children.flatMap((c) => (c instanceof FakeEl ? [c, ...c.all()] : []));
  }
  querySelector(sel: string): FakeEl | null {
    const want = sel.split(".").filter(Boolean);
    return this.all().find((e) => want.every((w) => (e.getAttribute("class") ?? "").split(" ").includes(w))) ?? null;
  }
}
const dom = {
  body: new FakeEl("body"),
  activeElement: null as FakeEl | null,
  createElement: (tag: string) => new FakeEl(tag),
  createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  createTextNode: (t: string) => new FakeText(t),
};

type Confirm = (o: { title: string; command: string; effect: string[]; secretLabel?: string }) => Promise<{ value?: string } | null>;
const page = new Function(
  "document",
  "Node",
  `${fn("h")}\n${fn("setAttrs")}\n${fn("append")}\n${fn("confirmDialog")}\nreturn { confirmDialog };`
)(dom, FakeNode) as { confirmDialog: Confirm };

function opened(secretLabel?: string) {
  dom.body = new FakeEl("body");
  const opener = new FakeEl("button");
  dom.body.append(opener);
  opener.focus();
  const result = page.confirmDialog({ title: "Write this change?", command: "gnomon setup --yes", effect: ["writes .gnomon/"], ...(secretLabel ? { secretLabel } : {}) });
  const dlg = dom.body.children.find((c) => c instanceof FakeEl && c.tagName === "dialog") as FakeEl;
  return { opener, result, dlg };
}

describe("the confirm dialog", () => {
  it("is modal, named by its heading, and focuses Confirm first", async () => {
    const { dlg, result } = opened();
    expect(dlg.open).toBe(true);
    const by = dlg.getAttribute("aria-labelledby");
    expect(dlg.all().find((e) => e.getAttribute("id") === by)?.tagName).toBe("h2");
    expect(dom.activeElement).toBe(dlg.querySelector(".btn.primary"));
    dlg.querySelector(".btn.primary")!.dispatch("click");
    expect(await result).toEqual({ value: undefined });
  });

  it("Esc cancels: nothing runs, the dialog goes, focus returns to what opened it", async () => {
    const { dlg, opener, result } = opened();
    expect(dlg.dispatch("cancel")).toBe(false); // the default close is replaced by finish(false)
    expect(await result).toBeNull();
    expect(dlg.open).toBe(false);
    expect(dlg.isConnected).toBe(false);
    expect(dom.activeElement).toBe(opener);
  });

  it("Cancel and Confirm return focus too", async () => {
    for (const label of ["Cancel", "Confirm"]) {
      const { dlg, opener, result } = opened();
      dlg.all().find((e) => e.tagName === "button" && e.textContent === label)!.dispatch("click");
      await result;
      expect(dom.activeElement, label).toBe(opener);
    }
  });

  it("a key field is labelled, focused first, required, and cleared after", async () => {
    const { dlg, result, opener } = opened("API key for OPENROUTER_API_KEY");
    const pw = dlg.all().find((e) => e.tagName === "input")!;
    expect(pw.getAttribute("type")).toBe("password");
    expect(pw.getAttribute("aria-label")).toBe("API key for OPENROUTER_API_KEY");
    expect(dom.activeElement).toBe(pw);
    dlg.querySelector(".btn.primary")!.dispatch("click");
    expect(dlg.isConnected).toBe(true); // empty: stays open, says why
    expect(dlg.all().find((e) => e.getAttribute("role") === "alert")?.textContent).toMatch(/Paste the key/);
    pw.value = "sk-test";
    dlg.querySelector(".btn.primary")!.dispatch("click");
    expect(await result).toEqual({ value: "sk-test" });
    expect(pw.value).toBe("");
    expect(dom.activeElement).toBe(opener);
  });
});

// ── commands ────────────────────────────────────────────────────────────────

describe("every dashboard button maps to a command that exists", () => {
  const names = new Set(CLI_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));

  it("each action in the server's table is a CLI command", () => {
    for (const a of DASHBOARD_ACTIONS) expect(names.has(a.argv[0]), a.name).toBe(true);
  });

  it("each `gnomon <command>` the page names is a CLI command", () => {
    // Inline code in the page's text, template commands, and plain commands.
    const named = [
      ...[...APP_JS.matchAll(/`gnomon ([a-z]+)\b/g)].map((m) => m[1]!),
      ...[...APP_JS.matchAll(/plainCommand\("[^"]*", ["`]gnomon ([a-z]+)\b/g)].map((m) => m[1]!),
    ];
    expect(named).toEqual(expect.arrayContaining(["setup", "doctor", "audit", "init"]));
    for (const n of named) expect(names.has(n), `gnomon ${n}`).toBe(true);
    // A flag no command reads is a button that does not do what it says.
    expect(APP_JS).not.toContain("audit show --json");
  });

  it("a plain command is a gnomon command, or a script the repository has", () => {
    const plain = [...APP_JS.matchAll(/plainCommand\("[^"]*", ("[^"]*"|`[^`]*`)/g)].map((m) => m[1]!.slice(1, -1));
    expect(plain.length).toBeGreaterThan(0);
    for (const text of plain) {
      if (text.startsWith("gnomon ")) continue;
      const script = text.replace(/^node /, "");
      expect(existsSync(join(REPO, script)), text).toBe(true);
    }
  });
});

describe("the Start step: the exact command for the project, quoted for its shell", () => {
  const start = new Function(`${fn("shellPath")}\n${fn("startCommand")}\nreturn startCommand;`)() as (root: string, platform: string) => string;

  it("cd <path> && gnomon launch", () => {
    expect(start("/home/me/app", "linux")).toBe("cd /home/me/app && gnomon launch");
    expect(start("C:\\work\\app", "win32")).toBe("cd C:\\work\\app && gnomon launch");
  });

  it("quotes a path a shell would split or expand", () => {
    expect(start("/home/me/my app", "darwin")).toBe("cd '/home/me/my app' && gnomon launch");
    expect(start("/tmp/it's $HOME", "linux")).toBe("cd '/tmp/it'\\''s $HOME' && gnomon launch");
    expect(start("C:\\Users\\Jane Doe\\app", "win32")).toBe('cd "C:\\Users\\Jane Doe\\app" && gnomon launch');
  });

  it("is a wizard step after Review, and is shown, never run", () => {
    expect(APP_JS).toMatch(/\[6, "Review and accept"\],\s*\[7, "Start"\]/);
    const panel = fn("startPanel");
    expect(panel).not.toMatch(/perform\(|call\(|fetch\(/);
    expect(panel).toContain("navigator.clipboard");
  });
});

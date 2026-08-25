/**
 * gnomon-core: Render tests
 */

import { describe, it, expect } from "vitest";
import { splitThinking, renderMeta, renderExchange, Progress, paint, THEMES } from "./render.js";
import { ResolvedUi, parseMetaFields, META_FIELDS } from "./config.js";
import { PromptExchange } from "./prompt_loop.js";

const ui = (over: Partial<ResolvedUi> = {}): ResolvedUi => ({
  theme: "dark",
  meta: ["turn", "role", "model", "bucket", "duration", "context"],
  meta_style: "line",
  think: "collapse",
  spinner: false,
  color: false,
  ...over,
});

const exchange = (over: Partial<PromptExchange> = {}): PromptExchange => ({
  turn: 3,
  role: "implement",
  input: "hi",
  output: "hello",
  model: "qwen3.6:35b",
  code: 0,
  bucket: "result",
  duration_ms: 4200,
  context_turns: 2,
  context_tokens: 1500,
  ...over,
});

describe("splitThinking", () => {
  it("separates a <think> block from the answer", () => {
    const r = splitThinking("<think>weighing options</think>The answer is 4.");
    expect(r.think).toBe("weighing options");
    expect(r.answer).toBe("The answer is 4.");
  });

  it("handles <thinking> too", () => {
    const r = splitThinking("<thinking>hmm</thinking>done");
    expect(r.think).toBe("hmm");
    expect(r.answer).toBe("done");
  });

  it("treats an unterminated opener as reasoning to the end", () => {
    const r = splitThinking("prelude<think>cut off mid-thought");
    expect(r.answer).toBe("prelude");
    expect(r.think).toBe("cut off mid-thought");
  });

  it("leaves a plain answer untouched", () => {
    const r = splitThinking("just an answer");
    expect(r.think).toBe("");
    expect(r.answer).toBe("just an answer");
  });

  it("collects multiple blocks", () => {
    const r = splitThinking("<think>a</think>X<think>b</think>Y");
    expect(r.think).toBe("a\n\nb");
    expect(r.answer).toBe("XY");
  });
});

describe("renderMeta", () => {
  it("renders declared fields in declared order", () => {
    const lines = renderMeta(exchange(), ui({ meta: ["model", "turn"] }));
    const body = lines.join("\n");
    expect(body.indexOf("qwen3.6:35b")).toBeLessThan(body.indexOf("turn 3"));
  });

  it("renders nothing when meta is empty", () => {
    expect(renderMeta(exchange(), ui({ meta: [] }))).toEqual([]);
  });

  it("compact style is a single line", () => {
    const lines = renderMeta(exchange(), ui({ meta_style: "compact" }));
    expect(lines).toHaveLength(1);
  });

  it("humanises duration", () => {
    expect(renderMeta(exchange({ duration_ms: 4200 }), ui({ meta: ["duration"] })).join())
      .toContain("4.2s");
    expect(renderMeta(exchange({ duration_ms: 812 }), ui({ meta: ["duration"] })).join())
      .toContain("812ms");
  });

  it("omits context when the exchange has none", () => {
    const lines = renderMeta(
      exchange({ context_turns: undefined, context_tokens: undefined }),
      ui({ meta: ["context", "tokens"] })
    );
    expect(lines).toEqual([]);
  });

  it("shows dropped turns when the window slid", () => {
    const lines = renderMeta(
      exchange({ context_dropped: 4 }),
      ui({ meta: ["context"] })
    );
    expect(lines.join()).toContain("−4");
  });

  it("every declared field renders without throwing", () => {
    expect(() =>
      renderMeta(exchange(), ui({ meta: [...META_FIELDS] }), 40)
    ).not.toThrow();
  });
});

describe("renderExchange", () => {
  const withThink = exchange({
    output: "<think>line one\nline two</think>The answer.",
  });

  it("think=hide drops reasoning entirely", () => {
    const body = renderExchange(withThink, ui({ think: "hide" })).join("\n");
    expect(body).toContain("The answer.");
    expect(body).not.toContain("line one");
  });

  it("think=collapse shows one line of it", () => {
    const body = renderExchange(withThink, ui({ think: "collapse" })).join("\n");
    expect(body).toContain("line one");
    expect(body).not.toContain("line two");
    expect(body).toContain("The answer.");
  });

  it("think=show renders the whole block", () => {
    const body = renderExchange(withThink, ui({ think: "show" })).join("\n");
    expect(body).toContain("line one");
    expect(body).toContain("line two");
    expect(body).toContain("The answer.");
  });

  it("flags a reply that was reasoning only", () => {
    const body = renderExchange(
      exchange({ output: "<think>only thinking</think>" }),
      ui({ think: "hide" })
    ).join("\n");
    expect(body).toContain("no answer");
  });
});

describe("parseMetaFields", () => {
  it("accepts known fields and reports unknown ones", () => {
    const r = parseMetaFields(["turn", "bogus", "model"]);
    expect(r.fields).toEqual(["turn", "model"]);
    expect(r.unknown).toEqual(["bogus"]);
  });

  it("de-duplicates", () => {
    expect(parseMetaFields(["turn", "turn"]).fields).toEqual(["turn"]);
  });
});

describe("Progress", () => {
  it("prints one static line on a non-TTY and never escapes", () => {
    const written: string[] = [];
    const fake: any = { isTTY: false, write: (s: string) => written.push(s) };
    const p = new Progress(ui({ spinner: true }), fake);
    p.start("loading");
    p.stop();
    expect(written.join("")).toBe("  loading\n");
    expect(written.join("")).not.toContain("\x1b");
  });

  it("does not spin when the surface disables it", () => {
    const written: string[] = [];
    const fake: any = { isTTY: true, write: (s: string) => written.push(s) };
    const p = new Progress(ui({ spinner: false }), fake);
    p.start("x");
    p.stop();
    expect(written.join("")).toBe("  x\n");
  });
});

describe("paint", () => {
  it("returns text untouched when colour is off", () => {
    // Piped output and CI logs must stay greppable.
    expect(paint(ui({ color: false }), "green", "hello")).toBe("hello");
  });

  it("wraps in escapes when colour is on, without altering the text", () => {
    const out = paint(ui({ color: true }), "green", "hello");
    expect(out).toContain("hello");
    expect(out).toMatch(/\x1b\[32m/);
    expect(out).toMatch(/\x1b\[0m$/);
  });

  it("an unknown colour still returns the text", () => {
    expect(paint(ui({ color: true }), "chartreuse", "hello")).toContain("hello");
  });
});

describe("Progress suspend/resume", () => {
  const tty = () => {
    const written: string[] = [];
    const out: any = { isTTY: true, write: (s: string) => written.push(s) };
    return { out, written };
  };

  it("suspend clears the line and stops redrawing", () => {
    // Each frame writes carriage-return + erase-line twelve times a second,
    // which erased whatever the user was typing as fast as it was echoed.
    const { out, written } = tty();
    const p = new Progress(ui({ spinner: true, color: false }), out);
    p.start("working");
    const before = written.length;
    p.suspend();
    expect(written[written.length - 1]).toBe("\r\x1b[2K");
    // Nothing further is drawn while suspended.
    const after = written.length;
    expect(after).toBeGreaterThan(before);
    p.stop();
  });

  it("resume draws again", () => {
    const { out, written } = tty();
    const p = new Progress(ui({ spinner: true, color: false }), out);
    p.start("working");
    p.suspend();
    const quiet = written.length;
    p.resume();
    expect(written.length).toBeGreaterThan(quiet);
    p.stop();
  });

  it("resume does nothing when it was never started", () => {
    const { out, written } = tty();
    const p = new Progress(ui({ spinner: true, color: false }), out);
    p.resume();
    expect(written).toEqual([]);
  });

  it("suspend is safe to call twice", () => {
    const { out } = tty();
    const p = new Progress(ui({ spinner: true, color: false }), out);
    p.start("working");
    expect(() => { p.suspend(); p.suspend(); }).not.toThrow();
    p.stop();
  });

  it("a non-TTY never writes escapes, suspended or not", () => {
    const written: string[] = [];
    const out: any = { isTTY: false, write: (s: string) => written.push(s) };
    const p = new Progress(ui({ spinner: true }), out);
    p.start("working");
    p.suspend();
    p.resume();
    p.stop();
    expect(written.join("")).not.toContain("\x1b");
  });
});

describe("themes", () => {
  it("the default does not use bright-black for secondary text", () => {
    // 90m on a black terminal is charcoal on charcoal, and the muted role
    // carries most of the meta lines and every context note.
    const painted = paint(ui({ color: true, theme: "dark" }), "gray", "x");
    expect(painted).not.toContain("[90m");
    expect(painted).toContain("[37m");
  });

  it("every theme defines the roles the code actually asks for", () => {
    // A theme missing a role would silently render that text unstyled.
    const used = ["gray", "cyan", "yellow", "green", "red", "bold"];
    for (const [name, theme] of Object.entries(THEMES)) {
      if (name === "mono") continue; // deliberately empty
      for (const role of used) {
        expect(theme.codes[role], `${name}.${role}`).toBeTruthy();
      }
    }
  });

  it("mono emits no escapes but keeps the text", () => {
    const out = paint(ui({ color: true, theme: "mono" }), "gray", "hello");
    expect(out).toBe("hello");
  });

  it("an unknown theme falls back rather than rendering unstyled", () => {
    const out = paint(ui({ color: true, theme: "chartreuse" }), "gray", "hello");
    expect(out).toContain("hello");
    expect(out).toContain("\x1b[");
  });

  it("colour = false wins over any theme", () => {
    expect(paint(ui({ color: false, theme: "high-contrast" }), "red", "x")).toBe("x");
  });
});

describe("Progress does not leave timers running", () => {
  const fake = () => {
    const writes: string[] = [];
    return {
      writes,
      stream: {
        write: (t: string) => { writes.push(t); return true; },
        isTTY: true,
      } as unknown as NodeJS.WriteStream,
    };
  };
  const ui = { spinner: true, color: false } as never;
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // A turn calls start() again on every leg and after every tool. Each call
  // used to abandon the running interval without clearing it, and the orphans
  // never stopped.
  it("start() twice leaves exactly one interval", async () => {
    const f = fake();
    const p = new Progress(ui, f.stream);
    p.start("one");
    p.start("two");
    f.writes.length = 0;
    await tick(300);
    p.stop();
    const frames = f.writes.length;
    const f2 = fake();
    const q = new Progress(ui, f2.stream);
    q.start("only");
    f2.writes.length = 0;
    await tick(300);
    q.stop();
    // Within one frame of each other, not double.
    expect(Math.abs(frames - f2.writes.length)).toBeLessThanOrEqual(1);
  });

  it("stop() ends all drawing, however many times start() was called", async () => {
    const f = fake();
    const p = new Progress(ui, f.stream);
    p.start("a");
    p.start("b");
    p.start("c");
    p.stop();
    f.writes.length = 0;
    await tick(300);
    expect(f.writes).toEqual([]);
  });

  // The reported symptom: "1787650983.7s". stop() sets started = 0, so an
  // orphaned frame rendered (Date.now() - 0) / 1000 — a Unix epoch.
  it("never renders a Unix epoch as an elapsed time", async () => {
    const f = fake();
    const p = new Progress(ui, f.stream);
    p.start("x");
    p.start("y");
    p.stop();
    await tick(300);
    expect(f.writes.join("")).not.toMatch(/\b1[0-9]{9}\.[0-9]s/);
  });

  // Typing during a turn calls suspend(). It could only ever clear the one
  // handle the field pointed at, so orphans kept erasing the line and nothing
  // typed was visible.
  it("suspend() stops every writer, so a typed line survives", async () => {
    const f = fake();
    const p = new Progress(ui, f.stream);
    p.start("leg 1");
    p.start("leg 2");
    p.start("leg 3");
    p.suspend();
    f.writes.length = 0;
    await tick(300);
    expect(f.writes).toEqual([]);
  });

  it("resume() after suspend() draws again, and only once per frame", async () => {
    const f = fake();
    const p = new Progress(ui, f.stream);
    p.start("a");
    p.suspend();
    p.resume();
    f.writes.length = 0;
    await tick(250);
    p.stop();
    expect(f.writes.length).toBeGreaterThan(0);
    expect(f.writes.length).toBeLessThanOrEqual(4);
  });

  it("elapsed time counts from the last start, in seconds", async () => {
    const f = fake();
    const p = new Progress(ui, f.stream);
    p.start("a");
    await tick(150);
    const shown = f.writes.join("").match(/([0-9]+\.[0-9])s/g) ?? [];
    p.stop();
    expect(shown.length).toBeGreaterThan(0);
    for (const v of shown) expect(parseFloat(v)).toBeLessThan(5);
  });
});

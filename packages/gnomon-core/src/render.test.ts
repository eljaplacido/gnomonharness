/**
 * gnomon-core: Render tests
 */

import { describe, it, expect } from "vitest";
import { splitThinking, renderMeta, renderExchange, Progress, paint } from "./render.js";
import { ResolvedUi, parseMetaFields, META_FIELDS } from "./config.js";
import { PromptExchange } from "./prompt_loop.js";

const ui = (over: Partial<ResolvedUi> = {}): ResolvedUi => ({
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

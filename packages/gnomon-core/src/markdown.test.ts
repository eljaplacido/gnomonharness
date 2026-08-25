import { describe, it, expect } from "vitest";
import { renderMarkdown, renderInline, visibleWidth, wrap, plain } from "./markdown.js";
import { renderDiagram, parseGraph, isDiagramLanguage } from "./diagram.js";
import { ResolvedUi } from "./config.js";

const ui: ResolvedUi = {
  theme: "dark", meta: [], meta_style: "line", think: "hide",
  spinner: false, color: false, markdown: true,
};
const colour: ResolvedUi = { ...ui, color: true };
const out = (src: string, w = 80) => renderMarkdown(src, ui, w).join("\n");

describe("visibleWidth", () => {
  it("ignores escape codes", () => {
    expect(visibleWidth("\x1b[1mabc\x1b[0m")).toBe(3);
  });
  it("counts CJK and emoji as two columns", () => {
    expect(visibleWidth("日本")).toBe(4);
    expect(visibleWidth("🔹")).toBe(2);
  });
  it("does not count zero-width joiners", () => {
    expect(visibleWidth("a‍b")).toBe(2);
  });
});

describe("inline marks", () => {
  it("applies bold and drops the asterisks", () => {
    const r = renderInline("a **bold** b", ui);
    expect(r).toBe("a bold b");
    expect(r).not.toContain("**");
  });
  it("leaves marks inside code spans alone", () => {
    expect(plain(renderInline("`a ** b`", ui))).toBe("a ** b");
  });
  it("does not italicise snake_case or a lone asterisk", () => {
    expect(renderInline("some_var_name here", ui)).toBe("some_var_name here");
    expect(renderInline("2 * 3 * 4", ui)).toBe("2 * 3 * 4");
  });
  it("shows a link's label, with the target after it", () => {
    const r = plain(renderInline("see [the docs](https://x.dev)", ui));
    expect(r).toBe("see the docs (https://x.dev)");
  });
  it("actually emits colour when colour is on", () => {
    expect(renderInline("**b**", colour)).toContain("\x1b[");
  });
});

describe("blocks", () => {
  it("renders a heading without the hashes", () => {
    const r = out("### Summary");
    expect(r).toContain("Summary");
    expect(r).not.toContain("###");
  });
  it("renders bullets with a glyph, not an asterisk", () => {
    expect(out("- one\n- two")).toContain("• one");
  });
  it("keeps numbering as written", () => {
    expect(out("3. third\n4. fourth")).toContain("3. third");
  });
  // A model soft-wraps prose, so a span can straddle a line break.
  it("applies a mark that spans a source line break", () => {
    const r = out("a **strict, policy-driven\nexecution engine** b");
    expect(r).not.toContain("**");
    expect(r).toContain("strict, policy-driven execution engine");
  });
  it("never formats inside a code fence", () => {
    const r = out("```\nconst a = **not bold**;\n```");
    expect(r).toContain("const a = **not bold**;");
  });
  it("wraps prose to the width it is given", () => {
    for (const line of renderMarkdown("word ".repeat(80), ui, 50)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(50);
    }
  });
});

describe("tables", () => {
  const src = [
    "| Feature | Gnomon | Others |",
    "| :--- | :---: | ---: |",
    "| **Goal** | Deterministic | Conversational |",
    "| Config | `.gnomon/` | global |",
  ].join("\n");

  it("draws a frame instead of printing pipes", () => {
    const r = out(src);
    expect(r).toContain("┌");
    expect(r).toContain("│");
    expect(r).not.toContain("| :--- |");
    expect(r).not.toContain("**Goal**");
  });

  it("every row is the same visible width", () => {
    const rows = renderMarkdown(src, ui, 80).filter((l) => l.includes("│") || l.includes("┌"));
    const widths = new Set(rows.map(visibleWidth));
    expect(widths.size).toBe(1);
  });

  it("stays inside the terminal width when the content is too wide", () => {
    const wide = [
      "| A | B |",
      "| --- | --- |",
      `| ${"x".repeat(200)} | ${"y".repeat(200)} |`,
    ].join("\n");
    for (const line of renderMarkdown(wide, ui, 60)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  it("aligns a table whose cells are CJK", () => {
    const cjk = ["| a | b |", "| --- | --- |", "| 日本語 | x |"].join("\n");
    const rows = renderMarkdown(cjk, ui, 80).filter((l) => l.includes("│"));
    expect(new Set(rows.map(visibleWidth)).size).toBe(1);
  });

  it("tolerates a ragged row without dropping it", () => {
    const ragged = ["| a | b | c |", "| --- | --- | --- |", "| 1 |"].join("\n");
    expect(out(ragged)).toContain("1");
  });
});

describe("diagrams", () => {
  it("claims only the fence languages it can read", () => {
    expect(isDiagramLanguage("mermaid")).toBe(true);
    expect(isDiagramLanguage("rust")).toBe(false);
  });

  it("draws a top-down graph as boxes", () => {
    const r = renderDiagram("graph TD\n  A[Start] --> B[End]", ui, 80).join("\n");
    expect(r).toContain("Start");
    expect(r).toContain("End");
    expect(r).toContain("┌");
    expect(r).toContain("▼");
  });

  // A pipeline is written as one chained statement; taking only the first
  // arrow rendered a five-stage flow as two boxes.
  it("reads a chained statement as every edge in it", () => {
    const g = parseGraph("graph LR\n  A --> B --> C --> D");
    expect(g?.edges.map((e) => `${e.from}${e.to}`)).toEqual(["AB", "BC", "CD"]);
  });

  it("draws a left-right chain across the page", () => {
    const r = renderDiagram("graph LR\n  A --> B --> C", ui, 80).join("\n");
    expect(r).toContain("──▶");
    expect(r.split("\n").length).toBeLessThan(6);
  });

  it("keeps edge labels", () => {
    const r = renderDiagram("graph TD\n  A -->|yes| B", ui, 80).join("\n");
    expect(r).toContain("yes");
  });

  // Inventing a picture for a diagram it cannot lay out would be worse than
  // showing what the model wrote.
  it("falls back to the source, with a reason, for anything else", () => {
    const r = renderDiagram("sequenceDiagram\n  A->>B: hi", ui, 80).join("\n");
    expect(r).toContain("sequenceDiagram");
    expect(r).toContain("A->>B: hi");
    expect(r).toContain("mermaid —");
  });

  it("falls back rather than mangling a graph with subgraphs", () => {
    const r = renderDiagram("graph TD\n subgraph one\n A --> B\n end", ui, 80).join("\n");
    expect(r).toContain("subgraph one");
  });

  it("terminates on a cycle instead of spinning", () => {
    const r = renderDiagram("graph TD\n  A --> B\n  B --> A", ui, 80).join("\n");
    expect(r.length).toBeGreaterThan(0);
  });

  it("never exceeds the width it is given", () => {
    const wide = `graph LR\n  ${["A", "B", "C", "D", "E", "F"].map((n) => `${n}[${n.repeat(20)}]`).join(" --> ")}`;
    for (const line of renderDiagram(wide, ui, 70)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(70);
    }
  });
});

describe("nothing is lost", () => {
  it("returns plain prose unchanged apart from indentation", () => {
    expect(out("just a sentence.").trim()).toBe("just a sentence.");
  });
  it("survives an empty answer", () => {
    expect(renderMarkdown("", ui, 80)).toEqual([]);
  });
  it("keeps the text of a table it cannot parse", () => {
    expect(out("| a | b |\nnot a divider")).toContain("a");
  });
  it("wrap() never loses a word", () => {
    const words = "alpha beta gamma delta epsilon".split(" ");
    expect(wrap(words.join(" "), 12).join(" ").split(/\s+/)).toEqual(words);
  });
});

// ---------------------------------------------------------------------------
// Regressions from the adversarial pass. Each of these lost or mangled text.
// ---------------------------------------------------------------------------

describe("text is never lost", () => {
  it("keeps a citation's parentheses — that is not a link", () => {
    const r = plain(renderInline("see [Smith et al.](Nature 2020, vol 5) here", ui));
    expect(r).toBe("see [Smith et al.](Nature 2020, vol 5) here");
  });

  it("still renders a real link", () => {
    expect(plain(renderInline("[docs](https://x.dev/a_b)", ui))).toBe("docs (https://x.dev/a_b)");
  });

  it("keeps backslashes in a table cell", () => {
    const t = ["| Path | Regex |", "| --- | --- |", "| C:\\Users\\bin | \\d+\\.\\d+ |"].join("\n");
    const r = out(t);
    expect(r).toContain("C:\\Users\\bin");
    expect(r).toContain("\\d+\\.\\d+");
  });

  it("keeps a pipe that is escaped, without splitting the cell", () => {
    const t = ["| a | b |", "| --- | --- |", "| x \\| y | z |"].join("\n");
    expect(out(t)).toContain("x | y");
  });

  it("does not split a cell on a pipe inside a code span", () => {
    const t = ["| expr | note |", "| --- | --- |", "| `a | b` | alt |"].join("\n");
    const rows = renderMarkdown(t, ui, 80).filter((l) => l.includes("│"));
    // Three columns would mean the code span was read as a cell boundary.
    for (const row of rows) expect(row.split("│").length).toBeLessThanOrEqual(4);
  });

  it("keeps a code fence that carries a title, and everything after it", () => {
    const src = ['```js title="a.js"', "const a = 1;", "```", "", "## After", "", "Final."].join("\n");
    const r = out(src);
    expect(r).toContain("const a = 1;");
    expect(r).toContain("After");
    expect(r).toContain("Final.");
  });

  it("does not eat a shell glob", () => {
    expect(plain(renderInline("run `x` then rm *.log and *.tmp", ui))).toContain("*.log");
  });

  it("does not pair unrelated ** in Python prose", () => {
    const r = plain(renderInline("pass **kwargs, **args to it", ui));
    expect(r).toBe("pass **kwargs, **args to it");
  });

  it("leaves name[i](args) alone", () => {
    expect(plain(renderInline("call arr[i](x) now", ui))).toBe("call arr[i](x) now");
  });

  it("keeps a backtick inside a double-backtick span", () => {
    expect(plain(renderInline("``a ` b``", ui))).toBe("a ` b");
  });

  it("survives a NUL in pasted output", () => {
    const r = out("before \u0000 0 \u0000 after `code`");
    expect(r).toContain("before");
    expect(r).toContain("after");
    expect(r).toContain("code");
  });
});

describe("blocks the first version mangled", () => {
  it("renders a setext heading without its underline as text", () => {
    const r = out("Installation\n============\n\nProse.");
    expect(r).toContain("Installation");
    expect(r).not.toContain("====");
  });

  it("keeps an indented code block on its own lines", () => {
    const r = out("Example:\n\n    def main():\n        return 1\n\nDone.");
    expect(r).toContain("def main():");
    expect(r).toContain("    return 1");
    expect(r.split("\n").filter((l) => l.includes("return 1")).length).toBe(1);
  });

  it("does not absorb a sentence containing a pipe as a table row", () => {
    const src = ["| Model | Speed |", "|---|---|", "| a | fast |", "Note the a|b form is accepted."].join("\n");
    const r = out(src);
    expect(r).toContain("Note the a|b form is accepted.");
  });

  it("renders header cells, not their markers", () => {
    const src = ["| **Flag** | `Default` |", "|---|---|", "| a | b |"].join("\n");
    const r = out(src);
    expect(r).not.toContain("**Flag**");
    expect(r).toContain("Flag");
    expect(r).toContain("Default");
  });

  it("accepts a single-dash alignment row", () => {
    expect(out(["| a | b |", "| :- | -: |", "| 1 | 2 |"].join("\n"))).toContain("┌");
  });

  it("drops the closing hashes of an ATX heading", () => {
    expect(out("## Title ##")).not.toContain("#");
  });

  it("keeps consecutive emoji bullets as separate items", () => {
    const r = out("🔹 first\n🔹 second");
    expect(r.split("\n").filter((l) => l.includes("first") || l.includes("second")).length).toBe(2);
  });

  it("wraps a heading longer than the width", () => {
    for (const l of renderMarkdown(`# ${"long ".repeat(40)}`, ui, 40)) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    }
  });

  it("renders a list inside a block quote as a list", () => {
    expect(out("> - one\n> - two")).toContain("•");
  });
});

describe("width holds for everything drawn", () => {
  const widths = [24, 40, 41, 100];
  const samples = [
    ["| a | b | c | d | e | f |", "|---|---|---|---|---|---|", "| 1 | 2 | 3 | 4 | 5 | 6 |"].join("\n"),
    ["| Status | Note |", "|---|---|", "| ✅ done | ⚠️ careful |", "| ❌ no | 🎉 yes |"].join("\n"),
    "```mermaid\ngraph LR\n  " + ["A", "B", "C", "D", "E"].map((n) => `${n}[${n.repeat(18)}]`).join(" --> ") + "\n```",
    "```mermaid\nsequenceDiagram\n  " + "x".repeat(200) + "\n```",
    "# " + "wide ".repeat(30),
  ];
  for (const w of widths) {
    for (const [n, src] of samples.entries()) {
      it(`sample ${n} fits ${w} columns`, () => {
        for (const line of renderMarkdown(src, ui, w)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(w);
        }
      });
    }
  }

  it("emoji count as two columns, so rows stay square", () => {
    const src = ["| Status | Note |", "|---|---|", "| ✅ done | ⚠️ careful |"].join("\n");
    const rows = renderMarkdown(src, ui, 80).filter((l) => l.includes("│") || l.includes("┌"));
    expect(new Set(rows.map(visibleWidth)).size).toBe(1);
  });

  it("a ZWJ family emoji is one cluster of two columns", () => {
    expect(visibleWidth("👨‍👩‍👧‍👦")).toBe(2);
  });

  it("a combining accent does not add a column", () => {
    expect(visibleWidth("e\u0301")).toBe(1);
  });

  it("never splits an escape sequence when wrapping in colour", () => {
    const src = ["| a | b |", "|---|---|", `| **${"x".repeat(60)}** | y |`].join("\n");
    for (const line of renderMarkdown(src, colour, 40)) {
      // A half-written escape would leave a bare ESC with no terminator.
      expect(/\x1b(?!\[[0-9;]*[A-Za-z])/.test(line)).toBe(false);
    }
  });

  it("closes a style before a table border rather than bleeding through it", () => {
    const src = ["| a | b |", "|---|---|", `| **${"x".repeat(60)}** | y |`].join("\n");
    for (const line of renderMarkdown(src, colour, 40)) {
      if (line.includes("\x1b[1m")) expect(line).toContain("\x1b[0m");
    }
  });
});

describe("diagrams the first version got wrong", () => {
  it("reads arrows written without spaces", () => {
    const g = parseGraph("graph TD\n  A-->B\n  B---C");
    expect(g?.edges.length).toBe(2);
  });

  it("keeps an id that contains a hyphen", () => {
    const g = parseGraph("graph TD\n  my-node --> other");
    expect(g?.edges[0].from).toBe("my-node");
  });

  it("lists a bypass edge instead of dropping it", () => {
    const r = renderDiagram("flowchart LR\n Parse --> Plan\n Plan --> Run\n Parse -->|cache hit| Run", ui, 80).join("\n");
    expect(r).toContain("cache hit");
  });

  it("keeps both labels on parallel edges", () => {
    const r = renderDiagram("graph LR\n A -->|first| B\n A -->|second| B", ui, 80).join("\n");
    expect(r).toContain("first");
    expect(r).toContain("second");
  });

  it("does not draw a connector where the graph has no edge", () => {
    const r = renderDiagram("graph TD\n A --> B\n B --> A", ui, 80).join("\n");
    expect(r.length).toBeGreaterThan(0);
  });

  it("keeps a label containing a bracket", () => {
    const g = parseGraph("graph TD\n  A[read x[0]] --> B");
    expect(g?.labels.get("A") ?? "").toContain("[0]");
  });

  it("says nothing extra for an empty fence", () => {
    expect(renderDiagram("", ui, 80).join("\n")).not.toContain("│");
  });
});

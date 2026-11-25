/**
 * gnomon-core: the task graph file, the allow-list, the order (task_graph.ts, CONTRACTS §64)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPH_NODE_KEYS, dependentsOf, outsideAllowList, parseTaskGraph, pathAllowed, retryInstruction, topoOrder } from "./task_graph.js";

const node = (id: string, extra = "") => `[nodes.${id}]\ninstruction = "do ${id}"\nfiles = ["${id}.txt"]\ncheck = "test -f ${id}.txt"\n${extra}\n`;

describe("parseTaskGraph", () => {
  it("reads nodes in the file's order, with deps and an optional role", () => {
    const r = parseTaskGraph(node("a") + node("b") + node("c", `deps = ["a", "b"]\nrole = "coder"`));
    expect("graph" in r).toBe(true);
    if (!("graph" in r)) return;
    expect(r.graph.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(r.graph.nodes[2]).toMatchObject({ deps: ["a", "b"], role: "coder", files: ["c.txt"], check: "test -f c.txt" });
  });

  it("refuses a node without its own check", () => {
    const r = parseTaskGraph(`[nodes.a]\ninstruction = "x"\nfiles = ["a.txt"]\n`);
    expect(r).toEqual({ errors: [expect.stringContaining("[nodes.a]: needs a check")] });
  });

  it("refuses missing files, unknown keys, unknown deps, cycles and paths out of the repository", () => {
    const errs = (t: string) => ("errors" in parseTaskGraph(t) ? (parseTaskGraph(t) as { errors: string[] }).errors.join("\n") : "");
    expect(errs(`[nodes.a]\ninstruction = "x"\ncheck = "true"\n`)).toContain("needs files");
    expect(errs(node("a", `chek = "true"`))).toContain('unknown key "chek"');
    expect(errs(node("a", `deps = ["zz"]`))).toContain('"zz", which the graph does not declare');
    expect(errs(node("a", `deps = ["b"]`) + node("b", `deps = ["a"]`))).toContain("cycle");
    expect(errs(`[nodes.a]\ninstruction = "x"\nfiles = ["../x"]\ncheck = "true"\n`)).toContain("inside the repository");
    expect(errs(`[other]\nx = 1\n` + node("a"))).toContain('unknown top-level key or table "other"');
    expect(errs(``)).toContain("no nodes");
  });

  it("the published fixture lists the same node keys", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fx = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "graph.json"), "utf-8"));
    expect(fx.graph_file.keys).toEqual([...GRAPH_NODE_KEYS]);
  });
});

describe("the allow-list", () => {
  it("allows a listed file or anything under a listed directory, nothing else", () => {
    expect(pathAllowed("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(pathAllowed("src/lib/x.ts", ["src/lib/"])).toBe(true);
    expect(pathAllowed("src/lib/x.ts", ["./src//lib/."])).toBe(true);
    expect(pathAllowed("./src/a.ts", ["src/a.ts"])).toBe(true);
    expect(pathAllowed("docs/\u00e4.md", ["docs/\u00e4.md"])).toBe(true);
    expect(pathAllowed("src/lib/x.ts", ["src/lib"])).toBe(true);
    expect(pathAllowed("src/library.ts", ["src/lib"])).toBe(false);
    expect(outsideAllowList(["a.txt", "z.txt", "d/e.txt"], ["a.txt", "d"])).toEqual(["z.txt"]);
  });
});

describe("allow-list edges", () => {
  it("folds case only where the file system does (Windows, macOS)", () => {
    expect(pathAllowed("Src/A.ts", ["src/a.ts"], true)).toBe(true);
    expect(pathAllowed("Src/A.ts", ["src/a.ts"], false)).toBe(false);
    expect(outsideAllowList(["SRC/x"], ["src"], true)).toEqual([]);
  });
  it("normalises entries at parse time and refuses gnomon's own paths", () => {
    const r = parseTaskGraph(`[nodes.a]\ninstruction = "x"\nfiles = ["./src//lib/", "a/../b.txt"]\ncheck = "true"\n`);
    if (!("graph" in r)) throw new Error("parse");
    expect(r.graph.nodes[0]!.files).toEqual(["src/lib", "b.txt"]);
    for (const bad of [".gnomon/policy.toml", ".gnomon-audit", "./.gnomon", ".tmp/x"]) {
      const e = parseTaskGraph(`[nodes.a]\ninstruction = "x"\nfiles = ["${bad}"]\ncheck = "true"\n`);
      expect("errors" in e && e.errors.join(), bad).toContain("gnomon's own files");
    }
    const up = parseTaskGraph(`[nodes.a]\ninstruction = "x"\nfiles = ["a/../../x"]\ncheck = "true"\n`);
    expect("errors" in up && up.errors.join()).toContain("inside the repository");
  });
});

describe("order", () => {
  it("is dependency order, ties broken by the file's order; dependents are transitive", () => {
    const r = parseTaskGraph(node("c", `deps = ["b"]`) + node("a") + node("b", `deps = ["a"]`) + node("d"));
    if (!("graph" in r)) throw new Error("parse");
    expect(topoOrder(r.graph)).toEqual(["a", "b", "c", "d"]);
    expect(dependentsOf(r.graph, "a")).toEqual(["c", "b"]);
  });
});

describe("retryInstruction", () => {
  it("carries the check's output and the out-of-bounds paths, and nothing from the model", () => {
    const r = parseTaskGraph(node("a"));
    if (!("graph" in r)) throw new Error("parse");
    const t = retryInstruction(r.graph.nodes[0]!, { outside: ["z.txt"], check_exit: 1, output: "MISSING-A\n" });
    expect(t).toContain("do a");
    expect(t).toContain("z.txt");
    expect(t).toContain("exited 1");
    expect(t).toContain("MISSING-A");
  });
});

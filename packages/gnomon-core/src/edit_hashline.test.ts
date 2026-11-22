/**
 * `edit_format = "hashline"` (edit_hashline.ts): the anchor spec through
 * conformance/edit_hashline.json, and the tools end to end. The default
 * (`str_replace`) is pinned byte for byte: nothing here may change its
 * schemas, descriptions or output.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HASHLINE_OPS,
  anchorOf,
  applyHashlineEdits,
  lineHash,
  parseAnchor,
  resolveEditMode,
} from "./edit_hashline.js";
import { auditSurface, loadConfig } from "./config.js";
import { buildToolSet, executeTool, TOOL_FAILED, TOOL_OK, type ToolContext } from "./tools.js";

const REPO = join(__dirname, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(REPO, "conformance/edit_hashline.json"), "utf-8"));

let root: string;
const offered = new Set(["read", "edit", "write", "bash"]);
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  root,
  sandbox: "confined",
  gate: "never",
  approve: async () => true,
  timeoutMs: 10_000,
  maxOutputBytes: 32_000,
  editVariant: "hashline",
  ...over,
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-hashline-"));
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  } catch {
    /* the OS reaps it */
  }
});

const withHashline = (config: ReturnType<typeof loadConfig>) => ({
  ...config,
  config: { ...config.config, defaults: { ...(config.config.defaults as object), edit_format: "hashline" } },
});

describe("the anchor spec (conformance/edit_hashline.json)", () => {
  it("hashes every vector the same way", () => {
    for (const v of FIXTURE.hash_vectors) expect(lineHash(v.text), JSON.stringify(v.text)).toBe(v.hash);
    expect(FIXTURE.ops).toEqual([...HASHLINE_OPS]);
  });

  it("runs every edit vector to the pinned result", () => {
    for (const v of FIXTURE.edit_vectors) {
      const r = applyHashlineEdits(v.before, v.edits, "f.txt");
      if (v.error_starts !== undefined) {
        expect(r.ok, v.name).toBe(false);
        if (!r.ok) expect(r.why, v.name).toContain(v.error_starts);
      } else {
        expect(r, v.name).toEqual({ ok: true, after: v.after });
      }
    }
  });

  it("gives identical lines distinct anchors through their number", () => {
    expect(anchorOf(1, "x")).not.toBe(anchorOf(2, "x"));
    expect(lineHash("x")).toBe(lineHash("x"));
  });

  it("parses LINE:HASH, tolerating case and a pasted |text, and nothing else", () => {
    expect(parseAnchor("12:A3")).toEqual({ line: 12, hash: "a3" });
    expect(parseAnchor("12:a3|foo")).toEqual({ line: 12, hash: "a3" });
    for (const bad of ["12", "a3", "12:a", "12:zz", "", null, 7]) expect(parseAnchor(bad)).toBeNull();
  });
});

describe("read and edit under edit_format = hashline", () => {
  it("read tags each line; a trailing newline adds no phantom line", async () => {
    writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
    const r = await executeTool("read", { path: "a.txt" }, ctx(), offered);
    expect(r.code).toBe(TOOL_OK);
    expect(r.content).toBe(`${anchorOf(1, "alpha")}|alpha\n${anchorOf(2, "beta")}|beta`);
  });

  it("read shows a CRLF file without the CR, and edit writes CRLF back", async () => {
    writeFileSync(join(root, "w.txt"), "a\r\nb\r\n");
    const r = await executeTool("read", { path: "w.txt" }, ctx(), offered);
    expect(r.content).toBe(`${anchorOf(1, "a")}|a\n${anchorOf(2, "b")}|b`);
    const e = await executeTool("edit", { path: "w.txt", edits: [{ op: "replace", anchor: anchorOf(2, "b"), text: "x\ny" }] }, ctx(), offered);
    expect(e.code).toBe(TOOL_OK);
    expect(readFileSync(join(root, "w.txt"), "utf-8")).toBe("a\r\nx\r\ny\r\n");
  });

  it("edits a file in a subdirectory by anchor, several edits in one call", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "c.ts"), "one\ntwo\nthree\nfour\n");
    const e = await executeTool(
      "edit",
      {
        path: "sub/c.ts",
        edits: [
          { op: "replace", anchor: anchorOf(1, "one"), text: "ONE" },
          { op: "delete", anchor: anchorOf(3, "three") },
          { op: "insert_after", anchor: anchorOf(4, "four"), text: "five" },
        ],
      },
      ctx(),
      offered
    );
    expect(e.code).toBe(TOOL_OK);
    expect(readFileSync(join(root, "sub", "c.ts"), "utf-8")).toBe("ONE\ntwo\nfour\nfive\n");
  });

  it("refuses a stale anchor, writes nothing, and says to read again", async () => {
    writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
    const stale = anchorOf(2, "beta");
    writeFileSync(join(root, "a.txt"), "alpha\nBETA CHANGED\n");
    const e = await executeTool(
      "edit",
      { path: "a.txt", edits: [{ op: "replace", anchor: anchorOf(1, "alpha"), text: "A" }, { op: "replace", anchor: stale, text: "x" }] },
      ctx(),
      offered
    );
    expect(e.code).toBe(TOOL_FAILED);
    expect(e.content).toContain(`Stale anchor ${stale}`);
    expect(e.content).toContain("Read the file again");
    // The valid first edit was not applied either: all or nothing.
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("alpha\nBETA CHANGED\n");
  });

  it("refuses an edit that moved under the approval prompt", async () => {
    writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
    const e = await executeTool(
      "edit",
      { path: "a.txt", edits: [{ op: "replace", anchor: anchorOf(1, "alpha"), text: "A" }] },
      ctx({
        gate: "always",
        approve: async () => {
          writeFileSync(join(root, "a.txt"), "other\nbeta\n");
          return true;
        },
      }),
      offered
    );
    expect(e.content).toContain("changed on disk while the approval prompt was open");
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("other\nbeta\n");
  });

  it("refuses a missing file and a directory, as the default edit does", async () => {
    writeFileSync(join(root, "d"), "x");
    const e = await executeTool("edit", { path: "nope.txt", edits: [{ op: "delete", anchor: "1:00" }] }, ctx(), offered);
    expect(e.code).toBe(TOOL_FAILED);
    expect(e.content).toContain("No such file");
    const dir = await executeTool("edit", { path: ".", edits: [{ op: "delete", anchor: "1:00" }] }, ctx(), offered);
    expect(dir.content).toContain("is a directory");
  });

  it("refuses a call with no edits, a bad op and an unparseable anchor", () => {
    expect(applyHashlineEdits("a\n", [], "f").ok).toBe(false);
    expect(applyHashlineEdits("a\n", [{ op: "swap", anchor: anchorOf(1, "a") }], "f").ok).toBe(false);
    const r = applyHashlineEdits("a\n", [{ op: "delete", anchor: "first" }], "f");
    expect(r.ok).toBe(false);
  });

  it("windowed read numbers the window's lines with their real anchors", async () => {
    writeFileSync(join(root, "m.txt"), "a\nb\nc\nd\n");
    const r = await executeTool("read", { path: "m.txt", offset: 3, limit: 1 }, ctx({ maxLines: { read: 2 } }), offered);
    expect(r.content.startsWith(`${anchorOf(3, "c")}|c`)).toBe(true);
  });
});

describe("the surface", () => {
  it("resolves hashline only when the surface asks for it", () => {
    const base = loadConfig(REPO);
    expect(resolveEditMode(base)).toBe("default");
    expect(resolveEditMode(withHashline(base))).toBe("hashline");
  });

  it("offers anchored read/edit schemas and short descriptions under hashline", () => {
    const set = buildToolSet(withHashline(loadConfig(REPO)));
    const edit = set.schemas.find((s) => s.function.name === "edit")!.function;
    const read = set.schemas.find((s) => s.function.name === "read")!.function;
    expect((edit.parameters as { required: string[] }).required).toEqual(["path", "edits"]);
    expect(edit.description.length).toBeLessThan(120);
    expect(read.description).toContain("LINE:HASH");
  });

  it("leaves the default tool schemas and read output byte-identical", async () => {
    const base = loadConfig(REPO);
    const set = buildToolSet(base);
    const edit = set.schemas.find((s) => s.function.name === "edit")!.function;
    expect(JSON.stringify(edit.parameters)).toBe(
      JSON.stringify({
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the repository root" },
          old_text: { type: "string", description: "Exact text to replace. Must appear exactly once." },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      })
    );
    expect(edit.description).toBe("Make precise text replacements with exact text matching");
    writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
    const r = await executeTool("read", { path: "a.txt" }, ctx({ editVariant: undefined }), offered);
    expect(r.content).toBe("    1\talpha\n    2\tbeta\n    3\t");
    const e = await executeTool("edit", { path: "a.txt", old_text: "beta", new_text: "B" }, ctx({ editVariant: undefined }), offered);
    expect(e.code).toBe(TOOL_OK);
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("alpha\nB\n");
  });

  it("no longer calls hashline inert, and still says so for ast", () => {
    const base = loadConfig(REPO);
    const audit = (fmt: string) =>
      auditSurface({ ...base, config: { ...base.config, defaults: { ...(base.config.defaults as object), edit_format: fmt } } }).find((p) =>
        p.where.includes("edit_format")
      );
    expect(audit("hashline")).toBeUndefined();
    expect(audit("ast")?.problem).toContain("NOT implemented");
  });
});

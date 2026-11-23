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
  applyHashlineEditsDetailed,
  anchorWindow,
  refreshedAnchorsNote,
  splitAnchorLines,
  lineHash,
  parseAnchor,
  resolveEditMode,
} from "./edit_hashline.js";
import { auditSurface, loadConfig } from "./config.js";
import { redact } from "./audit.js";
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

  it("shows the pinned refreshed anchors for every refreshed_anchor_vector", () => {
    for (const v of FIXTURE.refreshed_anchor_vectors) {
      const r = applyHashlineEditsDetailed(v.before, v.edits, "f.txt");
      expect(r.ok, v.name).toBe(true);
      if (!r.ok) continue;
      expect(r.after, v.name).toBe(v.after);
      const texts = splitAnchorLines(r.after).lines.map((l) => l.text);
      expect(anchorWindow(texts, r.regions).lines, v.name).toEqual(v.refreshed);
    }
  });

  it("a stale refusal lists the pinned current anchors", () => {
    for (const v of FIXTURE.stale_anchor_vectors) {
      const r = applyHashlineEdits(v.before, v.edits, "f.txt");
      expect(r.ok, v.name).toBe(false);
      if (!r.ok) for (const line of v.error_contains) expect(r.why, v.name).toContain(line);
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

  it("a second edit using the anchors from the first edit's result succeeds", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
    writeFileSync(join(root, "s.txt"), lines.join("\n") + "\n");
    // Edit 1 adds two lines at the top, so every anchor below it moves.
    const e1 = await executeTool("edit", { path: "s.txt", edits: [{ op: "insert_before", anchor: anchorOf(1, "l1"), text: "p\nq" }] }, ctx(), offered);
    expect(e1.code).toBe(TOOL_OK);
    expect(e1.content).toContain("Refreshed anchors");
    expect(e1.content).toContain(`${anchorOf(3, "l1")}|l1`);
    // The old anchor for l4 is stale now; the one the result shows works.
    const old = await executeTool("edit", { path: "s.txt", edits: [{ op: "replace", anchor: anchorOf(4, "l4"), text: "X" }] }, ctx(), offered);
    expect(old.code).toBe(TOOL_FAILED);
    const shown = e1.content.split("\n").find((l) => l.endsWith("|l4"));
    // l4 is outside the window of edit 1; ask for l3 which is inside.
    const l3 = e1.content.split("\n").find((l) => l.endsWith("|l3"))!;
    expect(shown).toBeUndefined();
    const e2 = await executeTool("edit", { path: "s.txt", edits: [{ op: "replace", anchor: l3.split("|")[0], text: "THREE" }] }, ctx(), offered);
    expect(e2.code).toBe(TOOL_OK);
    expect(readFileSync(join(root, "s.txt"), "utf-8")).toBe(["p", "q", "l1", "l2", "THREE", ...lines.slice(3)].join("\n") + "\n");
    // The refusal above carried current anchors, so a retry needs no read.
    expect(old.content).toContain("Current anchors for the lines you targeted");
    const cur = old.content.split("\n").find((l) => l.endsWith("|l2"));
    expect(cur).toBe(`${anchorOf(4, "l2")}|l2`);
  });

  it("a stale refusal includes the current anchors and writes nothing", () => {
    const r = applyHashlineEdits("a\nb\nc\n", [{ op: "replace", anchor: "2:00", text: "x" }], "f");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toContain(`${anchorOf(1, "a")}|a`);
    expect(r.why).toContain(`${anchorOf(3, "c")}|c`);
    expect(r.why).toContain("Read the file again");
    const oob = applyHashlineEdits("a\nb\nc\n", [{ op: "delete", anchor: "9:00" }], "f");
    expect(oob.ok).toBe(false);
    if (!oob.ok) expect(oob.why).toContain(`${anchorOf(3, "c")}|c`);
  });

  it("caps the refreshed anchors and says how many were left out", () => {
    const before = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const text = Array.from({ length: 90 }, (_, i) => `n${i}`).join("\n");
    const r = applyHashlineEditsDetailed(before, [{ op: "replace", anchor: anchorOf(1, "l1"), end: anchorOf(90, "l90"), text }], "f");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const note = refreshedAnchorsNote(r.after, r.regions);
    expect(note.split("\n").filter((l) => /^\d+:[0-9a-f]{2}\|/.test(l))).toHaveLength(60);
    expect(note).toMatch(/… \d+ more lines changed — read again for the rest\./);
  });

  it("the approval preview and the str_replace result are unchanged by refreshed anchors", async () => {
    writeFileSync(join(root, "c.txt"), "alpha\nbeta\n");
    const seen: string[][] = [];
    const approve = async (r: { preview?: string[] }) => (seen.push(r.preview ?? []), true);
    const a = await executeTool("edit", { path: "c.txt", edits: [{ op: "replace", anchor: anchorOf(2, "beta"), text: "B" }] }, ctx({ gate: "always", approve }), offered);
    writeFileSync(join(root, "c.txt"), "alpha\nbeta\n");
    const b = await executeTool("edit", { path: "c.txt", old_text: "beta", new_text: "B" }, ctx({ editVariant: undefined, gate: "always", approve }), offered);
    expect(seen[0]).toEqual(seen[1]);
    expect(b.content).toBe("Edited c.txt (+1 −1).");
    expect(a.content.startsWith("Edited c.txt (+1 −1).\nRefreshed anchors")).toBe(true);
    expect(a.summary).toBe(b.summary);
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

describe("governance sees a hashline edit as it sees str_replace", () => {
  const SECRET = "AKIAABCDEFGHIJKLMNOP";
  const pattern = "AKIA[0-9A-Z]{16}";

  it("the approval preview shows the new text of a hashline edit, as it does for str_replace", async () => {
    writeFileSync(join(root, "c.txt"), "alpha\nbeta\n");
    const seen: string[][] = [];
    const approve = async (r: { preview?: string[] }) => (seen.push(r.preview ?? []), false);
    await executeTool("edit", { path: "c.txt", old_text: "beta", new_text: `key=${SECRET}` }, ctx({ editVariant: undefined, gate: "always", approve }), offered);
    await executeTool("edit", { path: "c.txt", edits: [{ op: "replace", anchor: anchorOf(2, "beta"), text: `key=${SECRET}` }] }, ctx({ gate: "always", approve }), offered);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[1].join("\n")).toContain(SECRET);
  });

  it("a path outside the sandbox is refused for a hashline edit exactly as for str_replace", async () => {
    const out = join(tmpdir(), `gnomon-hl-out-${process.pid}.txt`);
    writeFileSync(out, "A=1\n");
    try {
      const a = await executeTool("edit", { path: out, old_text: "A=1", new_text: "A=2" }, ctx({ editVariant: undefined }), offered);
      const b = await executeTool("edit", { path: out, edits: [{ op: "replace", anchor: anchorOf(1, "A=1"), text: "A=2" }] }, ctx(), offered);
      expect(a.code).not.toBe(TOOL_OK);
      expect(b.code).toBe(a.code);
      expect(readFileSync(out, "utf-8")).toBe("A=1\n");
    } finally {
      rmSync(out, { force: true });
    }
  });

  it("audit redaction catches a secret inside edits[] the way it does inside new_text", () => {
    const hash = JSON.stringify({ path: "c.txt", edits: [{ op: "insert_after", anchor: "1:00", text: `k=${SECRET}` }] });
    const plain = JSON.stringify({ path: "c.txt", old_text: "x", new_text: `k=${SECRET}` });
    expect(redact(hash, [pattern])).not.toContain(SECRET);
    expect(redact(plain, [pattern])).not.toContain(SECRET);
  });
});

import { describe, it, expect } from "vitest";
import { checkCitations } from "./citations.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// From a real review of a gnomon audit run: the code analysis was accurate and
// every line citation landed, while three claims about the harness's own state
// were asserted rather than measured. A citation is the load-bearing part of an
// audit answer — it is what lets a reader check the argument — so one that
// lands nowhere is a false statement in the most trustworthy-looking format
// available. Nothing was checking them.
describe("checkCitations", () => {
  const repo = (): string => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-cite-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
    writeFileSync(join(root, "src", "dup.ts"), "x\ny\n");
    writeFileSync(join(root, "other", "dup.ts"), "x\ny\n");
    return root;
  };

  it("passes a citation that lands, and echoes nothing it did not check", () => {
    const root = repo();
    const r = checkCitations("see src/a.ts:12 for the cause", root);
    expect(r).toMatchObject({ checked: 1, ok: 1, ambiguous: 0 });
    expect(r.broken).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("catches a line past the end of the file", () => {
    const root = repo();
    const r = checkCitations("the bug is at src/a.ts:999", root);
    expect(r.broken).toHaveLength(1);
    expect(r.broken[0]!.detail).toContain("past the end");
    rmSync(root, { recursive: true, force: true });
  });

  it("catches a file that does not exist", () => {
    const root = repo();
    const r = checkCitations("look at src/nope.ts:3", root);
    expect(r.broken).toHaveLength(1);
    expect(r.broken[0]!.detail).toBe("no such file");
    rmSync(root, { recursive: true, force: true });
  });

  it("calls a duplicated filename AMBIGUOUS, never broken", () => {
    // The failure that matters most. A checker that manufactures false
    // accusations trains its reader to ignore it, which is worse than none —
    // and an early version of the standalone tool did exactly this to two
    // correct citations.
    const root = repo();
    const r = checkCitations("see dup.ts:1", root);
    expect(r.ambiguous).toBe(1);
    expect(r.broken).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a path-qualified citation that is not relative to the root", () => {
    const root = repo();
    const r = checkCitations("see other/dup.ts:2", root);
    expect(r.ok).toBe(1);
    expect(r.broken).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not read a ratio or a clock time as a citation", () => {
    const root = repo();
    const r = checkCitations("throughput was 1.5:1 at 08:30, and 41% timed out", root);
    expect(r.checked).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

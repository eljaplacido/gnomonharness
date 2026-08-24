/**
 * gnomon-core: Tool execution tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildToolSet,
  executeTool,
  resolveInRoot,
  needsApproval,
  diffLines,
  diffStat,
  ToolContext,
  TOOL_OK,
  TOOL_DENIED,
  TOOL_OUT_OF_SANDBOX,
  TOOL_NOT_DECLARED,
  TOOL_FAILED,
} from "./tools.js";
import { loadConfig } from "./config.js";
import { mapBucket } from "./session.js";

let root: string;
const offered = new Set(["read", "bash", "write", "edit"]);

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  root,
  sandbox: "confined",
  gate: "never",
  approve: async () => true,
  timeoutMs: 10_000,
  maxOutputBytes: 32_000,
  ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-tools-"));
  writeFileSync(join(root, "hello.txt"), "alpha\nbeta\ngamma\n");
  mkdirSync(join(root, "sub"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("buildToolSet", () => {
  it("offers the tools the surface declares", () => {
    const set = buildToolSet(loadConfig("../.."));
    const names = set.schemas.map((s) => s.function.name).sort();
    expect(names).toEqual(["bash", "edit", "read", "write"]);
  });

  it("gives every tool a parameter schema", () => {
    for (const s of buildToolSet(loadConfig("../..")).schemas) {
      expect(s.type).toBe("function");
      expect(s.function.parameters).toHaveProperty("properties");
    }
  });
});

describe("sandbox", () => {
  it("allows paths inside the root", () => {
    expect(resolveInRoot(root, "hello.txt", "confined")).toContain("hello.txt");
  });

  it("blocks traversal out of the root", () => {
    expect(resolveInRoot(root, "../../etc/passwd", "confined")).toBeNull();
    expect(resolveInRoot(root, "/etc/passwd", "confined")).toBeNull();
  });

  it("allows anything when sandbox is off", () => {
    expect(resolveInRoot(root, "/etc/passwd", "off")).toBe("/etc/passwd");
  });

  it("read outside the sandbox is a refusal, not a crash", async () => {
    const out = await executeTool("read", { path: "/etc/passwd" }, ctx(), offered);
    expect(out.code).toBe(TOOL_OUT_OF_SANDBOX);
    expect(mapBucket(out.code)).toBe("refusal");
  });

  it("write outside the sandbox is a refusal", async () => {
    const out = await executeTool(
      "write",
      { path: "../escaped.txt", content: "x" },
      ctx(),
      offered
    );
    expect(out.code).toBe(TOOL_OUT_OF_SANDBOX);
  });
});

describe("approval gate", () => {
  it("on_write gates mutation but not reads", () => {
    expect(needsApproval("read", "on_write")).toBe(false);
    expect(needsApproval("write", "on_write")).toBe(true);
    expect(needsApproval("edit", "on_write")).toBe(true);
    expect(needsApproval("bash", "on_write")).toBe(true);
  });

  it("always gates everything; never gates nothing", () => {
    expect(needsApproval("read", "always")).toBe(true);
    expect(needsApproval("write", "never")).toBe(false);
  });

  it("a declined write leaves the file untouched and reports refusal", async () => {
    const out = await executeTool(
      "write",
      { path: "hello.txt", content: "REPLACED" },
      ctx({ gate: "on_write", approve: async () => false }),
      offered
    );
    expect(out.code).toBe(TOOL_DENIED);
    expect(mapBucket(out.code)).toBe("refusal");
    expect(readFileSync(join(root, "hello.txt"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("a declined bash command does not run", async () => {
    const out = await executeTool(
      "bash",
      { command: `touch ${join(root, "should-not-exist")}` },
      ctx({ gate: "on_write", approve: async () => false }),
      offered
    );
    expect(out.code).toBe(TOOL_DENIED);
  });

  it("an approved write applies", async () => {
    const out = await executeTool(
      "write",
      { path: "new.txt", content: "fresh" },
      ctx({ gate: "on_write", approve: async () => true }),
      offered
    );
    expect(out.code).toBe(TOOL_OK);
    expect(readFileSync(join(root, "new.txt"), "utf-8")).toBe("fresh");
  });

  it("the approval preview carries a diff", async () => {
    let seen: string[] = [];
    await executeTool(
      "edit",
      { path: "hello.txt", old_text: "beta", new_text: "BETA" },
      ctx({
        gate: "on_write",
        approve: async (req) => {
          seen = req.preview;
          return false;
        },
      }),
      offered
    );
    expect(seen.join("\n")).toContain("- beta");
    expect(seen.join("\n")).toContain("+ BETA");
  });
});

describe("read", () => {
  it("returns numbered lines", async () => {
    const out = await executeTool("read", { path: "hello.txt" }, ctx(), offered);
    expect(out.code).toBe(TOOL_OK);
    expect(out.content).toContain("1\talpha");
    expect(out.content).toContain("2\tbeta");
  });

  it("lists a directory", async () => {
    const out = await executeTool("read", { path: "." }, ctx(), offered);
    expect(out.code).toBe(TOOL_OK);
    expect(out.content).toContain("hello.txt");
    expect(out.content).toContain("sub/");
  });

  it("a missing file is an apparatus failure, not a refusal", async () => {
    const out = await executeTool("read", { path: "nope.txt" }, ctx(), offered);
    expect(out.code).toBe(TOOL_FAILED);
    expect(mapBucket(out.code)).toBe("apparatus_failure");
  });
});

describe("edit", () => {
  it("replaces a unique match", async () => {
    const out = await executeTool(
      "edit",
      { path: "hello.txt", old_text: "beta", new_text: "BETA" },
      ctx(),
      offered
    );
    expect(out.code).toBe(TOOL_OK);
    expect(readFileSync(join(root, "hello.txt"), "utf-8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("refuses an ambiguous match instead of guessing", async () => {
    writeFileSync(join(root, "dup.txt"), "x\nx\n");
    const out = await executeTool(
      "edit",
      { path: "dup.txt", old_text: "x", new_text: "y" },
      ctx(),
      offered
    );
    expect(out.code).toBe(TOOL_FAILED);
    expect(out.content).toContain("2 times");
    expect(readFileSync(join(root, "dup.txt"), "utf-8")).toBe("x\nx\n");
  });

  it("reports a missing match without writing", async () => {
    const out = await executeTool(
      "edit",
      { path: "hello.txt", old_text: "zzz", new_text: "y" },
      ctx(),
      offered
    );
    expect(out.code).toBe(TOOL_FAILED);
    expect(out.content).toContain("not found");
  });
});

describe("bash", () => {
  it("captures stdout and exit code", async () => {
    const out = await executeTool("bash", { command: "echo hi" }, ctx(), offered);
    expect(out.code).toBe(TOOL_OK);
    expect(out.content).toContain("hi");
    expect(out.content).toContain("exit: 0");
  });

  it("runs in the repository root", async () => {
    const out = await executeTool("bash", { command: "ls" }, ctx(), offered);
    expect(out.content).toContain("hello.txt");
  });

  it("a non-zero exit is still a result — the tool ran", async () => {
    const out = await executeTool("bash", { command: "exit 3" }, ctx(), offered);
    expect(out.code).toBe(TOOL_OK);
    expect(out.content).toContain("exit: 3");
  });

  it("times out rather than hanging", async () => {
    const out = await executeTool(
      "bash",
      { command: "sleep 5" },
      ctx({ timeoutMs: 200 }),
      offered
    );
    expect(out.code).toBe(TOOL_FAILED);
    expect(out.content).toContain("timed out");
  });

  it("a timed-out command leaves no live orphan behind", async () => {
    // shell:true means the direct child is `sh -c`; killing only that would
    // leave the real work running. The marker file appears only if the
    // grandchild survived the kill.
    const marker = join(root, "orphan-marker");
    const out = await executeTool(
      "bash",
      { command: `sleep 0.4 && touch "${marker}"` },
      ctx({ timeoutMs: 120 }),
      offered
    );
    expect(out.code).toBe(TOOL_FAILED);
    await new Promise((r) => setTimeout(r, 900));
    expect(existsSync(marker)).toBe(false);
  });
});

describe("undeclared tools", () => {
  it("are refused by name, never ignored", async () => {
    const out = await executeTool("list_directory", { path: "." }, ctx(), offered);
    expect(out.code).toBe(TOOL_NOT_DECLARED);
    expect(out.content).toContain("list_directory");
    expect(out.content).toContain("read");
  });
});

describe("diffLines", () => {
  it("marks additions and removals", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc");
    expect(d).toContain("- b");
    expect(d).toContain("+ B");
    expect(diffStat(d)).toEqual({ added: 1, removed: 1 });
  });

  it("handles a new file", () => {
    const d = diffLines("", "x\ny");
    expect(diffStat(d)).toEqual({ added: 2, removed: 0 });
  });

  it("elides unchanged regions", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const after = before.replace("line20", "CHANGED");
    const d = diffLines(before, after);
    expect(d).toContain("  …");
    expect(d.length).toBeLessThan(20);
  });
});

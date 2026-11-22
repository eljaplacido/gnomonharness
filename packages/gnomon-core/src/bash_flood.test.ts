/**
 * A foreground command that floods its output must not take the process with it.
 *
 * The streams used to accumulate in an unbounded string and were clamped only
 * after the command exited, so `yes` (or a multi-GB `cat`) ran Node out of
 * memory, or into "Invalid string length", inside a stream handler. Now a
 * stream is held whole up to twice the output limit and, past that, as its head
 * and tail with the rest saved to a size-capped file the model is told about.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, createSpillSink, StreamCapture, FLOOD_SPILL_CAP_BYTES, TOOL_OK, type ToolContext } from "./tools.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    } catch {
      /* a handle a child just left; the OS reaps it */
    }
  }
});

const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "gnomon-flood-"));
  roots.push(root);
  return root;
};
const ctxIn = (root: string, over: Partial<ToolContext> = {}): ToolContext => ({
  root,
  sandbox: "confined",
  gate: "never",
  approve: async () => true,
  timeoutMs: 60_000,
  maxOutputBytes: 32_000,
  ...over,
});
const ALL = new Set(["read", "bash", "write", "edit", "todo", "grep"]);

/** Writes HEAD-MARK, `mb` megabytes of lines, then TAIL-MARK, honouring back-pressure. */
const FLOOD = `
const mb = Number(process.argv[2]);
const line = Buffer.from("x".repeat(1023) + "\\n");
const chunk = Buffer.concat(Array.from({ length: 1024 }, () => line));
process.stdout.write("HEAD-MARK\\n");
let n = mb;
(function go() {
  while (n > 0) {
    n--;
    if (!process.stdout.write(chunk)) return process.stdout.once("drain", go);
  }
  process.stdout.write("TAIL-MARK\\n");
})();
`;

describe("A1: foreground bash output is bounded", () => {
  it("survives a 300 MB flood with memory held down, keeps head and tail, and saves a capped file", async () => {
    const root = scratch();
    writeFileSync(join(root, "flood.js"), FLOOD);
    const spill = createSpillSink(root, "flood");
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    let r;
    try {
      r = await executeTool("bash", { command: "node flood.js 300" }, ctxIn(root, { spill }), ALL);
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, process.memoryUsage().rss);

    // It returned, as an ordinary result.
    expect(r.code).toBe(TOOL_OK);
    expect(r.content.startsWith("exit: 0\nstdout:\nHEAD-MARK\n")).toBe(true);
    expect(r.content.trimEnd().endsWith("TAIL-MARK")).toBe(true);
    // The model is told what went missing and where the rest is.
    expect(r.content).toMatch(/\d+ bytes dropped from the middle/);
    expect(r.content).toContain(".gnomon-out/flood/001-bash-stdout.txt");
    expect(r.content).toContain(`of ${300 * 1024 * 1024 + 10 + 10} bytes`);
    // What it is shown fits one result.
    expect(r.content.length).toBeLessThan(32_000 + 1000);
    // The saved file is capped, and starts at the start.
    const file = join(root, ".gnomon-out", "flood", "001-bash-stdout.txt");
    expect(statSync(file).size).toBeLessThanOrEqual(FLOOD_SPILL_CAP_BYTES);
    expect(statSync(file).size).toBeGreaterThan(FLOOD_SPILL_CAP_BYTES - 1024);
    expect(r.content).toContain("the file stops at its size cap");
    // Memory stayed bounded: the old string alone was 300 MB.
    const grew = peak - baseline;
    expect(grew, `rss grew ${(grew / 1048576).toFixed(0)} MB`).toBeLessThan(150 * 1024 * 1024);
  }, 120_000);

  it("a flood on stderr is bounded the same way, and a failing exit still reports it", async () => {
    const root = scratch();
    writeFileSync(join(root, "flood.js"), FLOOD.replaceAll("process.stdout", "process.stderr") + "\nprocess.exitCode = 3;\n");
    const spill = createSpillSink(root, "flood2");
    const r = await executeTool("bash", { command: "node flood.js 80" }, ctxIn(root, { spill }), ALL);
    expect(r.content.startsWith("exit: 3\nstderr:\nHEAD-MARK\n")).toBe(true);
    expect(r.content).toContain("001-bash-stderr.txt");
    expect(r.content).toContain("TAIL-MARK");
    expect(r.content.length).toBeLessThan(32_000 + 1000);
  }, 60_000);

  it("is byte-identical for output that fits (and for output up to twice the limit, which spills whole as before)", async () => {
    const root = scratch();
    const small = await executeTool("bash", { command: "echo one; echo two" }, ctxIn(root), ALL);
    expect(small.content).toBe("exit: 0\nstdout:\none\ntwo\n");
    // 40 KB: over the 32 KB limit, under twice it: the old path, the whole text saved by clamp.
    const spill = createSpillSink(root, "mid");
    const mid = await executeTool("bash", { command: "i=0; while [ $i -lt 800 ]; do echo 0123456789012345678901234567890123456789012345678; i=$((i+1)); done" }, ctxIn(root, { spill }), ALL);
    expect(mid.content).toContain("001-bash-exit.txt");
    expect(mid.content).toMatch(/The full \d+ bytes are saved at/);
    expect(mid.content).not.toContain("size cap");
    expect(readFileSync(join(root, ".gnomon-out", "mid", "001-bash-exit.txt"), "utf-8").length).toBeGreaterThan(39_000);
  });
});

describe("StreamCapture", () => {
  it("does not corrupt a multi-byte character split across chunks", () => {
    const cap = new StreamCapture(ctxIn(scratch()), "t");
    const bytes = Buffer.from("héllo wörld ✓ 日本語", "utf8");
    for (let i = 0; i < bytes.length; i += 1) cap.push(bytes.subarray(i, i + 1));
    expect(cap.text()).toBe("héllo wörld ✓ 日本語");
    expect(cap.overflowed).toBe(false);
  });

  it("holds a small limit's stream as head and tail, without a sink saying so", () => {
    const cap = new StreamCapture(ctxIn(scratch(), { maxOutputBytes: 100 }), "t");
    for (let i = 0; i < 50; i++) cap.push(Buffer.from(`line ${String(i).padStart(2, "0")} ${"y".repeat(20)}\n`));
    const out = cap.text();
    expect(cap.overflowed).toBe(true);
    expect(out.startsWith("line 00")).toBe(true);
    expect(out.trimEnd().endsWith("y".repeat(10))).toBe(true);
    expect(out).toContain("No copy could be saved");
    expect(out.length).toBeLessThan(400);
  });
});

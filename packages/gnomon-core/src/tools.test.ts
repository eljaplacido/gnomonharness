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
  readdirSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as tools from "./tools.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  buildToolSet,
  executeTool,
  globToRegExp,
  resolveInRoot,
  sandboxCommand,
  needsApproval,
  diffLines,
  diffStat,
  ToolContext,
  TOOL_OK,
  TOOL_DENIED,
  TOOL_OUT_OF_SANDBOX,
  TOOL_NOT_DECLARED,
  TOOL_FAILED,
  TOOL_OK_EMPTY,
  scanShellCommand,
  ApprovalGate,
  ApprovalRequest,
  Todo,
  backgroundRecipe,
  createSpillSink,
  OVERFLOW_DIR,
} from "./tools.js";
import { loadConfig, declaredTools, isToolEnabled } from "./config.js";
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
  it("offers schemas in a stable, sorted order — Rule 3 says sorted", () => {
    // This returned file order. Two surfaces with identical tools written in a
    // different order presented the model a differently-ordered schema list,
    // and MCP tools are appended in CONNECTION order on top of that, so the
    // same surface could differ between runs whenever a server was slow.
    const config = loadConfig("../..");
    const names = buildToolSet(config).schemas.map((s) => s.function.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });


  it("offers exactly the tools the surface declares and enables", () => {
    // Derived from the surface, not hardcoded: adding a tool to tools.toml
    // should not break this test, only a mismatch should.
    const config = loadConfig("../..");
    const expected = declaredTools(config)
      .filter((t) => isToolEnabled(config, t.name))
      .map((t) => t.name)
      .sort();
    const names = buildToolSet(config).schemas.map((s) => s.function.name).sort();
    expect(names).toEqual(expected);
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

  it("admits a path inside a granted extra root, and nothing else", () => {
    // "Let the agent read my other checkout" had two spellings before this,
    // and both were worse than a named root: sandbox = "off", which drops
    // confinement everywhere at once, or `bash cat`, which the sandbox level
    // does not govern at all. Measured on a strict surface: `read` of a
    // neighbouring repository was refused while `cat` of the same file
    // succeeded in the same turn.
    const other = mkdtempSync(join(tmpdir(), "gnomon-other-"));
    writeFileSync(join(other, "NOTES.md"), "neighbour");
    const grant = [other];

    // Granted: inside the named root.
    expect(resolveInRoot(root, join(other, "NOTES.md"), "confined", grant)).not.toBeNull();
    // Still confined: a sibling of the granted root is NOT granted.
    expect(resolveInRoot(root, join(other, "..", "elsewhere.txt"), "confined", grant)).toBeNull();
    // Still confined: everything else is unchanged by the grant.
    expect(resolveInRoot(root, "/etc/passwd", "confined", grant)).toBeNull();
    // And the repository root itself still works.
    expect(resolveInRoot(root, "hello.txt", "confined", grant)).toContain("hello.txt");
    rmSync(other, { recursive: true, force: true });
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

  it("a missing file is a result — the tool ran, the answer is 'absent'", async () => {
    // Exploring a tree turns up missing paths constantly. Reporting each as
    // broken apparatus made the bucket meaningless in real sessions.
    const out = await executeTool("read", { path: "nope.txt" }, ctx(), offered);
    expect(out.code).toBe(TOOL_OK_EMPTY);
    expect(mapBucket(out.code)).toBe("result");
    expect(out.content).toContain("No such file");
  });

  it("reading a directory path with a trailing slash reads cleanly", async () => {
    const out = await executeTool("read", { path: "sub/" }, ctx(), offered);
    expect(out.code).toBe(TOOL_OK);
    expect(out.summary).not.toContain("//");
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

  it("a timed-out command hands back what it printed before the kill", async () => {
    // The benchmark's long tail was the model re-running a command that had
    // already timed out, because the timeout discarded everything the command
    // had said. The output is evidence the harness is holding; killing the
    // process is not a reason to drop it.
    const out = await executeTool(
      "bash",
      { command: `echo "made it to step 3"; sleep 5` },
      ctx({ timeoutMs: 250 }),
      offered
    );
    expect(out.code).toBe(TOOL_FAILED);
    expect(out.content).toContain("timed out");
    expect(out.content).toContain("made it to step 3");
    // and it must say the output is partial, so the model does not read a
    // truncated log as the whole story
    expect(out.content).toContain("partial");
  });

  it("a timed-out command keeps both ends of an oversized output", async () => {
    // A killed command cannot be cheaply narrowed and re-run, and the reason it
    // was still running is usually the last thing it printed — so the tail is
    // kept too, unlike the head-only clamp used on a command that completed.
    const out = await executeTool(
      "bash",
      { command: `printf 'HEAD'; for i in $(seq 1 400); do printf 'xxxxxxxxxx'; done; printf 'TAIL'; sleep 5` },
      ctx({ timeoutMs: 400, maxOutputBytes: 200 }),
      offered
    );
    expect(out.code).toBe(TOOL_FAILED);
    expect(out.content).toContain("HEAD");
    expect(out.content).toContain("TAIL");
    expect(out.content).toContain("bytes dropped from the middle");
  });

  it("note records what the run learned, and refuses to drop it silently", async () => {
    const kept: any[] = [];
    const withNotes = ctx({
      notes: { list: () => kept, add: (t: string) => { kept.push({ turn: 1, text: t }); } },
    });
    const offeredWithNote = new Set([...offered, "note"]);
    const ok = await executeTool("note", { text: "pytest -k slow exceeds the tool timeout" }, withNotes, offeredWithNote);
    expect(ok.code).toBe(0);
    expect(kept).toHaveLength(1);

    const empty = await executeTool("note", { text: "   " }, withNotes, offeredWithNote);
    expect(empty.code).toBe(TOOL_FAILED);

    // A build with no store must say so rather than accept and discard.
    const noStore = await executeTool("note", { text: "something" }, ctx({}), offeredWithNote);
    expect(noStore.code).toBe(TOOL_FAILED);
    expect(noStore.content).toContain("silently dropped");
  });

  it("remembers what a file looked like before the turn touched it", async () => {
    // This is what makes a test checkable. T8 measured this model writing a
    // test that actually pins behaviour 1 time in 9, with three of the nine
    // asserting the BUG as the contract -- tests that pass today and block the
    // correct fix tomorrow. The mechanical check for all of those is to run the
    // new test against the code as it was, and that needs the pre-image.
    const preImages = new Map<string, string>();
    const c = ctx({ preImages });
    writeFileSync(join(root, "src.txt"), "ORIGINAL\n");

    await executeTool("write", { path: "src.txt", content: "FIRST\n" }, c, offered);
    await executeTool("edit", { path: "src.txt", old_text: "FIRST", new_text: "SECOND" }, c, offered);

    // FIRST WRITE WINS: the entry is the state at the start of the TURN, so a
    // file edited three times still compares against what the turn inherited.
    expect([...preImages.values()]).toEqual(["ORIGINAL\n"]);

    // and a brand-new file records an empty pre-image, not a missing entry
    await executeTool("write", { path: "fresh.txt", content: "new\n" }, c, offered);
    expect(preImages.get(join(root, "fresh.txt"))).toBe("");
  });

  it("a declined read does not reveal whether the path exists", async () => {
    // The existence probe ran BEFORE the gate, so under approval = "always" a
    // declined read still answered "does this path exist?" -- the operator said
    // no and the model learned something anyway. A refusal that leaks the
    // answer is not a refusal.
    let asked = 0;
    const declining = ctx({
      gate: "always" as ApprovalGate,
      approve: async () => { asked++; return false; },
    });

    const missing = await executeTool("read", { path: "definitely-not-here.txt" }, declining, offered);
    const present = await executeTool("read", { path: "keepme.txt" }, declining, offered);

    // both were gated...
    expect(asked).toBe(2);
    // ...and both refusals look identical: nothing distinguishes them
    expect(missing.code).toBe(present.code);
    expect(missing.content).not.toMatch(/No such file/);
  });

  it("glob finds the same files however the path is spelled", async () => {
    // `rel` was the raw argument, while the file list it is sliced against comes
    // back normalised relative to the root. So the slice length was wrong for
    // every spelling except "dir" and "dir/": `./src` and an absolute path both
    // returned ZERO results, silently, with code 0 -- a model reaching for the
    // ordinary `./src` was told the directory was empty.
    mkdirSync(join(root, "globsrc"), { recursive: true });
    writeFileSync(join(root, "globsrc", "a.ts"), "a\n");
    writeFileSync(join(root, "globsrc", "b.ts"), "b\n");
    const spellings = ["globsrc", "globsrc/", "./globsrc", "./globsrc/", join(root, "globsrc")];
    for (const path of spellings) {
      const out = await executeTool("glob", { pattern: "*.ts", path }, ctx(), new Set(["glob"]));
      const hits = (out.content ?? "").split("\n").filter((l) => l.endsWith(".ts")).length;
      expect(hits, `path spelled ${JSON.stringify(path)}`).toBe(2);
    }
  });

  it("a malformed tool call is refused, and never silently does something else", async () => {
    // Small models omit arguments routinely. Every one of these used to return
    // code 0 -- a plain RESULT -- having done something the call never asked for.
    // The worst by far: `write` with no `content` truncated an existing file to
    // zero bytes and reported success, one malformed call away from silent data
    // loss.
    writeFileSync(join(root, "keepme.txt"), "IMPORTANT CONTENT\n");

    const noContent = await executeTool("write", { path: "keepme.txt" }, ctx(), offered);
    expect(noContent.code).toBe(TOOL_DENIED);
    expect(readFileSync(join(root, "keepme.txt"), "utf-8")).toBe("IMPORTANT CONTENT\n");
    // an EMPTY string is still a legitimate write; an ABSENT one is not
    const emptyOnPurpose = await executeTool("write", { path: "keepme.txt", content: "" }, ctx(), offered);
    expect(emptyOnPurpose.code).toBe(0);

    // a missing path resolved to "" and then to the FILESYSTEM ROOT
    for (const args of [{}, { path: "" }, ["keepme.txt"] as unknown]) {
      const out = await executeTool("read", args as Record<string, unknown>, ctx(), offered);
      expect(out.code).toBe(TOOL_DENIED);
      expect(out.summary).toContain("no path");
    }

    // String({}) is "[object Object]", which the shell tried to run
    const badCmd = await executeTool("bash", { command: { evil: true } as unknown as string }, ctx(), offered);
    expect(badCmd.code).toBe(TOOL_DENIED);

    // and all of these are REFUSALS (2-4), never apparatus_failure (11):
    // CONTRACTS.md says a model's malformed argument landing in 11 would make
    // apparatus_failure meaningless, since that bucket means "look at the harness".
    expect(noContent.code).toBeGreaterThanOrEqual(2);
    expect(noContent.code).toBeLessThanOrEqual(4);
  });

  it("names the signal instead of reporting a killed command as exit null", async () => {
    // Node passes exit === null when the child dies on a signal, and the old
    // summary said "bash — exit null". The verify gate's /exit (-?\d+)/ then
    // failed to match and fell through to a default of 0, so a segfaulted or
    // OOM-killed test suite reported PASSED -- in the one mechanism whose whole
    // job is to contradict a model that claims success.
    const out = await executeTool("bash", { command: "kill -9 $$" }, ctx({ timeoutMs: 5000 }), offered);
    expect(out.summary).toMatch(/killed by SIG/);
    expect(out.summary).not.toContain("exit null");
  });

  it("write_allow resolves symlinks, like the two guards beside it", async () => {
    // resolveInRoot and inSurface both realpath, each with a comment about a
    // symlink defeating them. writeAllowed computed its relative path
    // lexically, so a symlink inside an allowed directory pointed anywhere on
    // the filesystem and still counted as allowed.
    mkdirSync(join(root, "src"), { recursive: true });
    const outside = join(root, "..", `escape-${process.pid}.txt`);
    try {
      symlinkSync(outside, join(root, "src", "link.txt"));
    } catch {
      return; // no symlink support here; nothing to assert
    }
    const out = await executeTool(
      "write",
      { path: "src/link.txt", content: "escaped" },
      ctx({ writeAllow: ["src/**"] }),
      offered
    );
    expect(out.code).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
  });

  it("Esc reaches a command that has already started", async () => {
    // Cancellation was only checked BETWEEN tool calls, so a running command
    // could not be interrupted at all -- the operator's only exits were the tool
    // timeout or killing the terminal, and detached:true means the terminal's
    // own Ctrl-C does not reach the process group either. On the 120s default
    // that is two minutes of a command they have already asked to stop.
    const ac = new AbortController();
    const began = Date.now();
    setTimeout(() => ac.abort(), 200);
    const out = await executeTool(
      "bash",
      { command: "sleep 20" },
      ctx({ timeoutMs: 15000, signal: ac.signal }),
      offered
    );
    expect(out.summary).toContain("cancelled");
    expect(Date.now() - began).toBeLessThan(3000);
  });

  it("the backgrounding recipe it hands back is a command that actually runs", async () => {
    // The first version prefixed "setsid " onto the command text, which is only
    // valid for a bare program invocation. For `cd /home && sleep 5 && echo done`
    // it emitted a string setsid rejects ("failed to execute cd") while the shell
    // ran the remaining && branches in the FOREGROUND. Advice that does not work
    // is worse than none: the model follows it, sees exit 0, and concludes the
    // job is running.
    const recipe = backgroundRecipe("cd /tmp && sleep 5 && echo done", "/tmp/gn-recipe.log");
    expect(recipe).toContain("sh -c");
    const began = Date.now();
    const out = await executeTool("bash", { command: recipe }, ctx({ timeoutMs: 5000 }), offered);
    expect(out.code).toBe(0);
    expect(out.content).not.toContain("failed to execute");
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it("a huge write does not take the whole process down with it", async () => {
    // diffLines allocated an (n+1)x(m+1) LCS table with the standing comment
    // "files here are small enough that O(n·m) is fine". Measured before the
    // guard: 6 000 lines cost 371MB, 12 000 cost 866MB, 40 000 aborted the
    // process with a V8 heap OOM -- exit 134. executeTool's try/catch cannot
    // catch that, so nothing was emitted: no exit-contract code, no session
    // snapshot, no session_end record. Rule 5 promises a published exit
    // contract and an ordinary `write` walked past it.
    const big = Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join("\n");
    const other = Array.from({ length: 40_000 }, (_, i) => `changed ${i}`).join("\n");
    writeFileSync(join(root, "huge.txt"), big);

    const began = Date.now();
    const out = await executeTool("write", { path: "huge.txt", content: other }, ctx(), offered);
    expect(out.code).toBe(0);
    expect(Date.now() - began).toBeLessThan(4000);

    // and the counts stay truthful rather than reporting the sample size
    const stat = diffStat(diffLines(big, other));
    expect(stat.removed).toBe(40_000);
    expect(stat.added).toBe(40_000);
    expect(diffLines(big, other)[0]).toContain("too large to diff");
  });

  it("a backgrounded job returns at once, however its streams are redirected", async () => {
    // The promise used to settle on `close`, which waits for the child's stdio
    // to close as well as the child to end. A backgrounded job inherits sh's
    // pipe write-ends, so the pipes stayed open for as long as the JOB ran and
    // `close` never fired though sh had exited in milliseconds. Measured:
    // `sleep 30 & echo started` blocked the full timeout and was then SIGKILLed,
    // so the model got proof the job started AND a timeout, with the job dead.
    // Only `>log 2>&1 &` escaped -- and that is the harness's own advice for
    // long commands, so the recommended path was the broken one.
    for (const command of [
      "sleep 20 >/tmp/gn-bg-a.log 2>&1 & echo started",
      "sleep 20 & echo started",
      "sh -c 'echo boot; sleep 20' >/tmp/gn-bg-b.log & echo started",
    ]) {
      const began = Date.now();
      const out = await executeTool("bash", { command }, ctx({ timeoutMs: 3000 }), offered);
      expect(out.code, command).toBe(0);
      expect(Date.now() - began, command).toBeLessThan(1500);
    }
  });

  it("keeps the diagnostics when a chatty command fails", async () => {
    // stderr was last in the body and the clamp was head-only, so a build that
    // printed thousands of progress lines and then failed returned its preamble
    // and dropped the compiler error entirely. The model was told the build
    // failed and shown nothing about why. The timeout path already keeps both
    // ends for exactly this reason; a non-zero exit now does too.
    const noisy =
      'for i in $(seq 1 3000); do echo "   Compiling crate-$i"; done; ' +
      'echo "error[E0308]: mismatched types" >&2; exit 101';
    const out = await executeTool("bash", { command: noisy }, ctx({ maxOutputBytes: 4000 }), offered);
    expect(out.summary).toContain("exit 101");
    expect(out.content).toContain("E0308");
    expect(out.content).toContain("stderr:");
  });

  it("does not hand a command an stdin nobody will ever write to", async () => {
    // An inherited stdin pipe makes anything that reads stdin block until the
    // tool timeout kills it. Nothing in the loop can answer a prompt, so the
    // honest thing is EOF.
    const began = Date.now();
    const out = await executeTool("bash", { command: "cat" }, ctx({ timeoutMs: 3000 }), offered);
    expect(out.code).toBe(0);
    expect(Date.now() - began).toBeLessThan(1500);
  });

  it("refuses a command that already timed out, instead of stalling on it again", async () => {
    // The measured long tail is a model re-running the same blocking command
    // until the wall, paying the full timeout every time. Both the tool
    // description and the timeout message already tell it to detach and poll,
    // which is the evidence that prose was the wrong lever. The second attempt
    // now costs nothing and comes back with the recipe.
    const timedOutCommands = new Set<string>();
    const c = ctx({ timeoutMs: 150, timedOutCommands });

    const first = await executeTool("bash", { command: "sleep 5" }, c, offered);
    expect(first.code).toBe(TOOL_FAILED);
    expect(timedOutCommands.size).toBe(1);

    const began = Date.now();
    const second = await executeTool("bash", { command: "  sleep   5  " }, c, offered);
    const elapsed = Date.now() - began;

    expect(second.code).toBe(TOOL_FAILED);
    expect(second.summary).toContain("already timed out");
    // whitespace-normalised, so a cosmetically different retry is still caught
    expect(second.content).toContain("setsid");
    // and it refused immediately rather than spending the timeout a second time
    expect(elapsed).toBeLessThan(100);
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

describe("directory paths never crash the session", () => {
  it("write to a directory is a tool failure, not a throw", async () => {
    // This exact case (write to `.gnomon/`) threw an uncaught EISDIR and
    // killed a live session outright.
    const out = await executeTool(
      "write",
      { path: "sub", content: "x" },
      ctx(),
      offered
    );
    expect(out.code).toBe(TOOL_FAILED);
    expect(out.content).toContain("is a directory");
  });

  it("edit on a directory is a tool failure, not a throw", async () => {
    const out = await executeTool(
      "edit",
      { path: "sub", old_text: "a", new_text: "b" },
      ctx(),
      offered
    );
    expect(out.code).toBe(TOOL_FAILED);
    expect(out.content).toContain("is a directory");
  });

  it("a tool that throws becomes an apparatus_failure, not an exception", async () => {
    // hello.txt is a file, so treating it as a parent directory makes the
    // underlying mkdir throw ENOTDIR. It must surface as an outcome.
    const out = await executeTool(
      "write",
      { path: join("hello.txt", "nested", "x.txt"), content: "y" },
      ctx(),
      offered
    );
    expect(out.code).toBe(TOOL_FAILED);
    expect(mapBucket(out.code)).toBe("apparatus_failure");
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

describe("per-role tool scope", () => {
  const cfgWithRoles = (roles: Record<string, unknown>): any => {
    const c: any = loadConfig("../..");
    c.roles = roles;
    return c;
  };

  it("a role with no tool list gets everything declared", () => {
    const c = cfgWithRoles({ implement: { model: "m" } });
    const expected = declaredTools(c)
      .filter((t) => isToolEnabled(c, t.name))
      .map((t) => t.name)
      .sort();
    const names = buildToolSet(c, "implement").schemas.map((s) => s.function.name);
    expect(names.sort()).toEqual(expected);
  });

  it("a verifier cannot write or edit — the capability is absent", () => {
    const c = cfgWithRoles({ verifier: { model: "m", tools: ["read", "bash"] } });
    const set = buildToolSet(c, "verifier");
    const names = set.schemas.map((s) => s.function.name).sort();
    expect(names).toEqual(["bash", "read"]);
    // Everything else the surface declares is withheld, whatever that is.
    expect(set.withheld).toContain("write");
    expect(set.withheld).toContain("edit");
    expect(set.withheld).not.toContain("read");
  });

  it("a withheld tool is refused by name, naming what IS available", async () => {
    const c = cfgWithRoles({ verifier: { model: "m", tools: ["read", "bash"] } });
    const offeredForRole = new Set(
      buildToolSet(c, "verifier").schemas.map((s) => s.function.name)
    );
    const out = await executeTool(
      "write",
      { path: "x.txt", content: "y" },
      ctx(),
      offeredForRole
    );
    expect(out.code).toBe(TOOL_NOT_DECLARED);
    expect(mapBucket(out.code)).toBe("refusal");
    expect(out.content).toContain("read");
  });

  it("an empty tool list means no tools at all", () => {
    const c = cfgWithRoles({ talker: { model: "m", tools: [] } });
    expect(buildToolSet(c, "talker").schemas).toHaveLength(0);
  });

  it("a role's scope cannot widen past what the surface declares", () => {
    const c = cfgWithRoles({ greedy: { model: "m", tools: ["read", "teleport"] } });
    const names = buildToolSet(c, "greedy").schemas.map((s) => s.function.name);
    expect(names).toEqual(["read"]);
  });
});

describe("bash_allow — the constraint that actually makes a role read-only", () => {
  it("an unlisted command is refused", async () => {
    const out = await executeTool(
      "bash",
      { command: "echo pwned > hack.txt" },
      ctx({ bashAllow: ["^cargo\\s", "^pnpm\\s"] }),
      offered
    );
    expect(out.code).toBe(TOOL_DENIED);
    expect(mapBucket(out.code)).toBe("refusal");
    expect(existsSync(join(root, "hack.txt"))).toBe(false);
  });

  it("a listed command runs", async () => {
    const out = await executeTool(
      "bash",
      { command: "echo ok" },
      ctx({ bashAllow: ["^echo\\s"] }),
      offered
    );
    expect(out.code).toBe(TOOL_OK);
    expect(out.content).toContain("ok");
  });

  it("no allow-list means any command — granting bash grants writing", async () => {
    // The point of the test is that this is TRUE, and therefore that a role
    // holding bash without an allow-list is not read-only however its `tools`
    // list reads.
    const out = await executeTool(
      "bash",
      { command: `touch ${join(root, "written.txt")}` },
      ctx(),
      offered
    );
    expect(out.code).toBe(TOOL_OK);
    expect(existsSync(join(root, "written.txt"))).toBe(true);
  });

  it("a pattern that will not compile does not widen the allow-list", async () => {
    const out = await executeTool(
      "bash",
      { command: "echo hi" },
      ctx({ bashAllow: ["(["] }),
      offered
    );
    expect(out.code).toBe(TOOL_DENIED);
  });

  it("the refusal names what the role may run", async () => {
    const out = await executeTool(
      "bash",
      { command: "rm -rf /" },
      ctx({ bashAllow: ["^cargo\\s"] }),
      offered
    );
    expect(out.content).toContain("cargo");
  });
});

describe("scanShellCommand", () => {
  it("splits on every top-level separator", () => {
    expect(scanShellCommand("a; b").segments).toEqual(["a", "b"]);
    expect(scanShellCommand("a && b").segments).toEqual(["a", "b"]);
    expect(scanShellCommand("a || b").segments).toEqual(["a", "b"]);
    expect(scanShellCommand("a | b").segments).toEqual(["a", "b"]);
    expect(scanShellCommand("a & b").segments).toEqual(["a", "b"]);
    expect(scanShellCommand("a\nb").segments).toEqual(["a", "b"]);
  });

  it("does not split inside quotes", () => {
    // grep "a;b" file is one command, not two.
    expect(scanShellCommand('grep "a;b" f').segments).toEqual(['grep "a;b" f']);
    expect(scanShellCommand("grep 'a && b' f").segments).toEqual(["grep 'a && b' f"]);
  });

  it("sees substitution in every form it can take", () => {
    expect(scanShellCommand("ls $(whoami)").substitution).toBe(true);
    expect(scanShellCommand("ls `whoami`").substitution).toBe(true);
    expect(scanShellCommand("diff <(a) <(b)").substitution).toBe(true);
    // Double quotes still expand; single quotes do not.
    expect(scanShellCommand('echo "$(whoami)"').substitution).toBe(true);
    expect(scanShellCommand("echo '$(whoami)'").substitution).toBe(false);
  });

  it("sees output redirection", () => {
    expect(scanShellCommand("cargo test > out.txt").redirection).toBe(true);
    expect(scanShellCommand("cargo test >> out.txt").redirection).toBe(true);
    expect(scanShellCommand('grep ">" file').redirection).toBe(false);
  });

  it("a backslash-escaped quote outside a quote is literal, not a quote-open", () => {
    // `\'` and `\"` are literal characters to bash; they must not open a quote
    // that hides the `;`-chained tail from the segment split.
    expect(scanShellCommand("cat x \\'; b").segments).toEqual(["cat x \\'", "b"]);
    expect(scanShellCommand('cat x \\" ; b').segments.length).toBe(2);
    // An escaped separator stays inside its own segment.
    expect(scanShellCommand("echo a\\; b").segments).toEqual(["echo a\\; b"]);
    // Substitution hidden behind an escaped quote is still seen.
    expect(scanShellCommand("ls \\'; echo $(x)").substitution).toBe(true);
  });

  it("closes a single quote on the first quote, backslash or not", () => {
    // Single quotes are literal in bash: `'x\'` is the string `x\` and the
    // quote is then closed. Treating the backslash as an escape kept the quote
    // open and hid a `;`-chained command inside one allow-listed segment.
    expect(scanShellCommand("a --f 'x\\'; b").segments).toEqual(["a --f 'x\\'", "b"]);
    // Double quotes are unaffected: a `;` inside them still does not split, and
    // an unquoted one after the closing quote still does.
    expect(scanShellCommand('echo "a;b" ; c').segments).toEqual(['echo "a;b"', "c"]);
  });

  it("leaves an ordinary command alone", () => {
    const scan = scanShellCommand("cargo test --all");
    expect(scan.segments).toEqual(["cargo test --all"]);
    expect(scan.substitution).toBe(false);
    expect(scan.redirection).toBe(false);
  });
});

describe("bash_allow cannot be escaped by chaining", () => {
  // Every one of these was PERMITTED, and the file was created. The control
  // existed specifically to make a verifier read-only.
  const readOnly = () => ctx({ bashAllow: ["^(cargo|pnpm|pytest)\\s", "^(ls|cat|grep)\\s"] });

  const bypasses: Array<[string, string]> = [
    ["semicolon", "ls . ; echo pwned > hack.txt"],
    ["and-and", "ls . && echo pwned > hack.txt"],
    ["or-or", "ls . || echo pwned > hack.txt"],
    ["pipe", "ls . | tee hack.txt"],
    ["background", "ls . & echo pwned > hack.txt"],
    ["newline", "ls .\necho pwned > hack.txt"],
    ["substitution", "ls $(echo pwned > hack.txt)"],
    ["backticks", "ls `echo pwned > hack.txt`"],
    ["redirect", "cargo test > hack.txt"],
    ["process-substitution", "cat <(echo pwned > hack.txt)"],
    // A single-quoted arg ending in a backslash used to keep the scanner's
    // quote open — bash closes it (single quotes are literal), and the `;`
    // tail became a second, unreviewed command. The whole line was permitted.
    ["single-quote-escape", "cargo test --features 'x\\'; echo pwned > hack.txt"],
    // A backslash-escaped quote OUTSIDE any quote is a literal to bash, but the
    // scanner used to let it OPEN a quote, swallowing the `;`-chained tail into
    // one allow-listed segment — arbitrary write/exec from a read-only role.
    ["bs-escaped-squote-write", "cat hello.txt \\'; echo pwned > hack.txt"],
    ["bs-escaped-dquote-pipe", "cat hello.txt \\\"; tee hack.txt"],
    ["bs-escaped-squote-subst", "ls . \\'; echo $(echo pwned > hack.txt)"],
    ["bs-escaped-squote-rm", "cat hello.txt \\'; rm -rf hack.txt"],
  ];

  for (const [name, cmd] of bypasses) {
    it(`refuses ${name}`, async () => {
      const out = await executeTool("bash", { command: cmd }, readOnly(), offered);
      expect(out.code, cmd).toBe(TOOL_DENIED);
      expect(existsSync(join(root, "hack.txt")), `${cmd} wrote a file`).toBe(false);
    });
  }

  it("still permits a plain allowed command", async () => {
    const out = await executeTool("bash", { command: "ls ." }, readOnly(), offered);
    expect(out.code).toBe(TOOL_OK);
  });

  it("permits chaining when every segment is allowed", async () => {
    // The point is not to forbid chaining, only unreviewed commands.
    const out = await executeTool("bash", { command: "ls . && cat hello.txt" }, readOnly(), offered);
    expect(out.code).toBe(TOOL_OK);
  });

  it("names what it objected to", async () => {
    const out = await executeTool(
      "bash", { command: "ls . ; rm -rf /" }, readOnly(), offered
    );
    expect(out.content).toContain("rm -rf /");
  });
});

describe("write_allow confines where a role may write", () => {
  const offered = new Set(["read", "write", "edit"]);
  const planner = () => ctx({ writeAllow: ["docs/**", "specs/**", "*.md"] });

  it("permits a path the scope names", async () => {
    const out = await executeTool(
      "write",
      { path: "docs/spec.md", content: "# spec\n" },
      planner(),
      offered
    );
    expect(out.code).toBe(TOOL_OK);
    expect(readFileSync(join(root, "docs/spec.md"), "utf-8")).toBe("# spec\n");
  });

  // The gap this closes: a coordinator holds `write` and not `edit`, and was
  // described as writing specs and never source. Withholding `edit` only stops
  // it revising a file that exists — creating one was never in question.
  it("refuses source, and does not create it", async () => {
    const out = await executeTool(
      "write",
      { path: "src/main.rs", content: "fn main() {}\n" },
      planner(),
      offered
    );
    expect(out.code).toBe(TOOL_DENIED);
    expect(existsSync(join(root, "src/main.rs"))).toBe(false);
  });

  it("names what the role may write, so the refusal is actionable", async () => {
    const out = await executeTool(
      "write",
      { path: "src/main.rs", content: "x" },
      planner(),
      offered
    );
    expect(out.content).toContain("docs/**");
    expect(out.content).toContain("src/main.rs");
  });

  it("judges the resolved path, so .. cannot walk out of the scope", async () => {
    const out = await executeTool(
      "write",
      { path: "docs/../src/main.rs", content: "fn main() {}\n" },
      planner(),
      offered
    );
    expect(out.code).toBe(TOOL_DENIED);
    expect(existsSync(join(root, "src/main.rs"))).toBe(false);
  });

  it("gates edit as well as write", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/main.rs"), "fn main() {}\n");
    const out = await executeTool(
      "edit",
      { path: "src/main.rs", old_text: "fn main() {}", new_text: "fn main() { panic!() }" },
      planner(),
      offered
    );
    expect(out.code).toBe(TOOL_DENIED);
    expect(readFileSync(join(root, "src/main.rs"), "utf-8")).toBe("fn main() {}\n");
  });

  it("an absent scope still means anywhere in the sandbox", async () => {
    const out = await executeTool(
      "write",
      { path: "src/main.rs", content: "fn main() {}\n" },
      ctx(),
      offered
    );
    expect(out.code).toBe(TOOL_OK);
  });

  it("* stops at a separator", async () => {
    const out = await executeTool(
      "write",
      { path: "docs/deep/notes.md", content: "x" },
      ctx({ writeAllow: ["*.md"] }),
      offered
    );
    expect(out.code).toBe(TOOL_DENIED);
  });

  it("**/ matches at depth zero as well as deeper", () => {
    expect(globToRegExp("**/*.md").test("NOTES.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("docs/a/NOTES.md")).toBe(true);
  });

  // A regex `docs/` would match this. That is why these are globs.
  it("a scope for docs/ does not also permit src/docs/", () => {
    expect(globToRegExp("docs/**").test("src/docs/evil.rs")).toBe(false);
    expect(globToRegExp("docs/**").test("docs/ok.md")).toBe(true);
  });
});

describe("the surface is not writable by a tool call", () => {
  // .gnomon/ decides the tool list, the approval gate and every allow-list.
  // An agent that can write there rewrites the rules it is judged by, and
  // moves the one hash a session is traced by.
  beforeEach(() => {
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "policy.toml"), 'gate = "on_write"\n');
  });

  it("refuses write into .gnomon/, even with the gate open", async () => {
    const r = await executeTool(
      "write",
      { path: ".gnomon/pwned.txt", content: "OWNED" },
      ctx({ gate: "never" }),
      offered
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(existsSync(join(root, ".gnomon", "pwned.txt"))).toBe(false);
  });

  it("refuses the privilege escalation: editing the approval gate away", async () => {
    const r = await executeTool(
      "edit",
      {
        path: ".gnomon/policy.toml",
        old_text: 'gate = "on_write"',
        new_text: 'gate = "never"',
      },
      ctx({ gate: "never" }),
      offered
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(readFileSync(join(root, ".gnomon", "policy.toml"), "utf-8")).toContain(
      'gate = "on_write"'
    );
  });

  it("is not bypassable by walking out and back in", async () => {
    const r = await executeTool(
      "write",
      { path: "src/../.gnomon/roles.toml", content: "x" },
      ctx({ gate: "never" }),
      offered
    );
    expect(r.code).toBe(TOOL_DENIED);
  });

  it("is not bypassable by a symlink that aliases the surface", async () => {
    // A lexical inSurface judged `glink/roles.toml` an ordinary file while the
    // write followed the link into .gnomon/. The guard has to realpath, the
    // way the sandbox check already does, or one symlink defeats the pillar.
    symlinkSync(join(root, ".gnomon"), join(root, "glink"), "dir");
    const r = await executeTool(
      "write",
      { path: "glink/roles.toml", content: "pwned" },
      ctx({ gate: "never", allow: "strict" }),
      offered
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(existsSync(join(root, ".gnomon", "roles.toml"))).toBe(false);
  });

  it("still allows writes everywhere else", async () => {
    const r = await executeTool(
      "write",
      { path: "src/main.ts", content: "ok" },
      ctx({ gate: "never" }),
      offered
    );
    expect(r.code).toBe(TOOL_OK);
  });

  it("/allow all lets the agent write the surface — and says the hash moved", async () => {
    const r = await executeTool(
      "write",
      { path: ".gnomon/roles.toml", content: 'model = "x"\n' },
      ctx({ gate: "never", allow: "all" }),
      offered
    );
    expect(r.code).toBe(TOOL_OK);
    expect(readFileSync(join(root, ".gnomon", "roles.toml"), "utf-8")).toContain(
      'model = "x"'
    );
    expect(r.content).toMatch(/surface|hash moved/i);
  });

  it("/allow custom requires approval for each surface write", async () => {
    const denied = await executeTool(
      "write",
      { path: ".gnomon/roles.toml", content: "nope" },
      ctx({ gate: "never", allow: "custom", approve: async () => false }),
      offered
    );
    expect(denied.code).toBe(TOOL_DENIED);
    expect(existsSync(join(root, ".gnomon", "roles.toml"))).toBe(false);

    const okd = await executeTool(
      "write",
      { path: ".gnomon/roles.toml", content: "yes" },
      ctx({ gate: "never", allow: "custom", approve: async () => true }),
      offered
    );
    expect(okd.code).toBe(TOOL_OK);
    expect(readFileSync(join(root, ".gnomon", "roles.toml"), "utf-8")).toBe("yes");
  });

  it("/allow strict (the default) refuses, and edit refuses the surface at every level", async () => {
    const w = await executeTool(
      "write",
      { path: ".gnomon/roles.toml", content: "x" },
      ctx({ gate: "never", allow: "strict" }),
      offered
    );
    expect(w.code).toBe(TOOL_DENIED);
    // Surface files are changed by a full-file write under /allow, never edit.
    const e = await executeTool(
      "edit",
      { path: ".gnomon/policy.toml", old_text: 'gate = "on_write"', new_text: 'gate = "never"' },
      ctx({ gate: "never", allow: "all" }),
      offered
    );
    expect(e.code).toBe(TOOL_DENIED);
  });

  it("detects — does not prevent — a surface moved by bash", async () => {
    // bash is arbitrary shell, so it is reported rather than blocked.
    const r = await executeTool(
      "bash",
      { command: "printf x >> .gnomon/policy.toml" },
      ctx({ gate: "never" }),
      new Set(["bash"])
    );
    expect(r.summary).toContain("surface changed");
    expect(r.surface_drift).toBeDefined();
    expect(r.surface_drift!.before).not.toBe(r.surface_drift!.after);
    expect(r.content).toContain("surface hash");
  });

  it("says nothing when bash leaves the surface alone", async () => {
    const r = await executeTool(
      "bash",
      { command: "echo hello" },
      ctx({ gate: "never" }),
      new Set(["bash"])
    );
    expect(r.summary).not.toContain("surface changed");
    expect(r.surface_drift).toBeUndefined();
  });
});

describe("an MCP call is gated, not waved through", () => {
  // MCP reaches an arbitrary third-party server with model-chosen args — the
  // tool class most likely to have external side effects. It used to run with
  // no approval even under the strictest gate; every other tool self-gates.
  const stubMcp = (calls: string[]) => ({
    tools: () => [],
    call: async (name: string) => {
      calls.push(name);
      return { isError: false, content: "ok" };
    },
    close: () => {},
  });
  const mcpOffered = new Set(["mcp__srv__do"]);

  it("prompts under on_write and a decline never reaches the server", async () => {
    const calls: string[] = [];
    const r = await executeTool(
      "mcp__srv__do",
      { x: 1 },
      ctx({ gate: "on_write", approve: async () => false, mcp: stubMcp(calls) as never }),
      mcpOffered
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(calls).toEqual([]);
  });

  it("runs when the human approves", async () => {
    const calls: string[] = [];
    const r = await executeTool(
      "mcp__srv__do",
      { x: 1 },
      ctx({ gate: "on_write", approve: async () => true, mcp: stubMcp(calls) as never }),
      mcpOffered
    );
    expect(r.code).toBe(TOOL_OK);
    expect(calls).toEqual(["mcp__srv__do"]);
  });

  it("does not prompt under the never gate", async () => {
    const calls: string[] = [];
    let asked = false;
    const r = await executeTool(
      "mcp__srv__do",
      { x: 1 },
      ctx({
        gate: "never",
        approve: async () => {
          asked = true;
          return false;
        },
        mcp: stubMcp(calls) as never,
      }),
      mcpOffered
    );
    expect(asked).toBe(false);
    expect(r.code).toBe(TOOL_OK);
    expect(calls).toEqual(["mcp__srv__do"]);
  });
});

describe("glob and grep — search without spending an approval", () => {
  const search = new Set(["read", "glob", "grep", "bash"]);

  beforeEach(() => {
    mkdirSync(join(root, "src", "db"), { recursive: true });
    mkdirSync(join(root, "src", "util"), { recursive: true });
    mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
    writeFileSync(join(root, "src", "db", "conn.py"), "TIMEOUT_SECONDS = 30\ndef f(): pass\n");
    writeFileSync(join(root, "src", "util", "retry.py"), "TIMEOUT_SECONDS = 5\n");
    writeFileSync(join(root, "README.md"), "no symbols here\n");
    writeFileSync(join(root, "node_modules", "junk", "x.py"), "TIMEOUT_SECONDS = 999\n");
  });

  it("grep finds a symbol across the tree as path:line:text", async () => {
    const r = await executeTool("grep", { pattern: "TIMEOUT_SECONDS" }, ctx(), search);
    expect(r.code).toBe(TOOL_OK);
    expect(r.content).toContain("src/db/conn.py:1:TIMEOUT_SECONDS = 30");
    expect(r.content).toContain("src/util/retry.py:1:TIMEOUT_SECONDS = 5");
  });

  it("never walks node_modules, so a dependency cannot answer for the repo", async () => {
    const r = await executeTool("grep", { pattern: "TIMEOUT_SECONDS" }, ctx(), search);
    expect(r.content).not.toContain("node_modules");
  });

  it("search costs no approval under on_write — that is the point of it", async () => {
    // A role with no bash could not previously find a file it had not been
    // told the name of, and a role with bash spent an approval on `find` to
    // do what is plainly a read. Under `always` search does ask, because
    // `always` means consent for every action; that is covered separately.
    let asked = false;
    const c = ctx({
      gate: "on_write",
      approve: async () => { asked = true; return true; },
    });
    await executeTool("grep", { pattern: "TIMEOUT" }, c, search);
    await executeTool("glob", { pattern: "**/*.py" }, c, search);
    expect(asked).toBe(false);
  });

  it("glob matches by path pattern and sorts deterministically", async () => {
    const r = await executeTool("glob", { pattern: "**/*.py" }, ctx(), search);
    expect(r.code).toBe(TOOL_OK);
    const files = r.content.split("\n").filter(Boolean);
    expect(files).toEqual(["src/db/conn.py", "src/util/retry.py"]);
    expect([...files].sort()).toEqual(files);
  });

  it("grep can be narrowed by include", async () => {
    const r = await executeTool(
      "grep",
      { pattern: "TIMEOUT_SECONDS", include: "**/retry.py" },
      ctx(),
      search
    );
    expect(r.content).toContain("src/util/retry.py");
    expect(r.content).not.toContain("conn.py");
  });

  it("a miss is an empty result, not a broken tool", async () => {
    const r = await executeTool("grep", { pattern: "NOTHING_HERE" }, ctx(), search);
    expect(mapBucket(r.code)).toBe("result");
    expect(r.summary).toContain("0 matches");
  });

  it("an invalid regex is refused with the reason, not thrown", async () => {
    const r = await executeTool("grep", { pattern: "([" }, ctx(), search);
    expect(r.code).toBe(TOOL_FAILED);
    expect(r.content).toContain("not a valid regular expression");
  });

  it("cannot search outside the sandbox", async () => {
    const r = await executeTool("grep", { pattern: "x", path: "../.." }, ctx(), search);
    expect(r.code).toBe(TOOL_OUT_OF_SANDBOX);
  });

  it("is withheld from a role that does not declare it", async () => {
    const r = await executeTool("grep", { pattern: "x" }, ctx(), new Set(["read"]));
    expect(r.code).toBe(TOOL_NOT_DECLARED);
    expect(r.content).toContain("not available to this role");
  });
});

describe("the sandbox follows symlinks, not just `..`", () => {
  // resolve() is string algebra: it collapses `..` and nothing else, so a
  // symlink inside the repository used to reach anywhere on the filesystem
  // while sandbox was set to "confined".
  let outside: string;

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), "gnomon-outside-"));
    writeFileSync(join(outside, "secret.txt"), "SECRET_TOKEN=abc123\n");
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a read through a symlink pointing out of the repo", async () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    const r = await executeTool("read", { path: "link.txt" }, ctx(), offered);
    expect(r.code).toBe(TOOL_OUT_OF_SANDBOX);
    expect(r.content).not.toContain("SECRET_TOKEN");
  });

  it("refuses a write through a symlinked directory", async () => {
    symlinkSync(outside, join(root, "escape"), "dir");
    const r = await executeTool(
      "write",
      { path: "escape/pwned.txt", content: "OWNED" },
      ctx({ gate: "never" }),
      offered
    );
    expect(r.code).toBe(TOOL_OUT_OF_SANDBOX);
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
  });

  it("a symlink that stays inside the repo is still allowed", async () => {
    mkdirSync(join(root, "real"), { recursive: true });
    writeFileSync(join(root, "real", "f.txt"), "inside\n");
    symlinkSync(join(root, "real"), join(root, "alias"), "dir");
    const r = await executeTool("read", { path: "alias/f.txt" }, ctx(), offered);
    expect(r.code).toBe(TOOL_OK);
    expect(r.content).toContain("inside");
  });

  it("a checkout reached through a symlinked parent is not an escape", async () => {
    // A home directory on another volume, or a macOS /tmp that is really
    // /private/tmp. Realpathing the target but not the root would make every
    // path in such a checkout look like it pointed outside.
    const alias = join(outside, "repo-alias");
    symlinkSync(root, alias, "dir");
    writeFileSync(join(root, "inside.txt"), "ok\n");
    expect(resolveInRoot(alias, "inside.txt", "confined")).not.toBeNull();
  });

  it("sandbox=off still opts out entirely", () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "link2.txt"));
    expect(resolveInRoot(root, "link2.txt", "off")).not.toBeNull();
  });

  it("search does not walk out through a symlink either", async () => {
    symlinkSync(outside, join(root, "escape2"), "dir");
    const r = await executeTool(
      "grep",
      { pattern: "SECRET_TOKEN" },
      ctx(),
      new Set(["grep"])
    );
    expect(r.content).not.toContain("SECRET_TOKEN=abc123");
  });
});

describe("the approval gate is three distinct modes", () => {
  // always → consent for every action. on_write → consent per change.
  // never → unattended. `always` used to be reached only from the four
  // mutating tools, which are the same four `on_write` stops, so the two
  // settings behaved identically and one of them was a dial that turned
  // nothing.
  const all = new Set(["read", "glob", "grep", "compute", "bash", "write", "edit"]);

  beforeEach(() => {
    writeFileSync(join(root, "f.txt"), "one\ntwo\n");
  });

  /** Run one call under `gate`, recording whether sign-off was requested. */
  async function under(gate: ApprovalGate, tool: string, args: Record<string, unknown>) {
    let asked = false;
    const r = await executeTool(
      tool,
      args,
      ctx({ gate, approve: async () => { asked = true; return true; } }),
      all
    );
    return { asked, r };
  }

  const READS: Array<[string, Record<string, unknown>]> = [
    ["read", { path: "f.txt" }],
    ["glob", { pattern: "**/*.txt" }],
    ["grep", { pattern: "one" }],
    ["compute", { expression: "2+2" }],
  ];
  const WRITES: Array<[string, Record<string, unknown>]> = [
    ["write", { path: "w.txt", content: "x" }],
    ["edit", { path: "f.txt", old_text: "one", new_text: "1" }],
    ["bash", { command: "echo hi" }],
  ];

  it("always: every call asks, reads and searches included", async () => {
    for (const [tool, args] of [...READS, ...WRITES]) {
      const { asked } = await under("always", tool, args);
      expect(asked, `${tool} should ask under always`).toBe(true);
    }
  });

  it("on_write: only calls that can change something ask", async () => {
    for (const [tool, args] of READS) {
      const { asked } = await under("on_write", tool, args);
      expect(asked, `${tool} should not ask under on_write`).toBe(false);
    }
    for (const [tool, args] of WRITES) {
      const { asked } = await under("on_write", tool, args);
      expect(asked, `${tool} should ask under on_write`).toBe(true);
    }
  });

  it("never: nothing asks", async () => {
    for (const [tool, args] of [...READS, ...WRITES]) {
      const { asked } = await under("never", tool, args);
      expect(asked, `${tool} should not ask under never`).toBe(false);
    }
  });

  it("a declined read under always is a refusal that returns no content", async () => {
    const r = await executeTool(
      "read",
      { path: "f.txt" },
      ctx({ gate: "always", approve: async () => false }),
      all
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(r.content).not.toContain("two");
  });

  it("always and on_write are not the same setting", async () => {
    // The regression this exists to catch.
    const strict = await under("always", "read", { path: "f.txt" });
    const loose = await under("on_write", "read", { path: "f.txt" });
    expect(strict.asked).not.toBe(loose.asked);
  });
});

describe("todo — the checklist a long run is steered by", () => {
  const offer = new Set(["todo"]);

  /** A context with a real store, so a write can be read back. */
  function withStore(over: Partial<ToolContext> = {}) {
    let items: Todo[] = [];
    const c = ctx({
      todos: { list: () => items, replace: (t) => { items = t; } },
      ...over,
    });
    return { c, read: () => items };
  }

  it("replaces the whole list and reports progress", async () => {
    const { c, read } = withStore();
    const r = await executeTool(
      "todo",
      { todos: [
        { content: "read the config", status: "completed" },
        { content: "write the test", status: "in_progress" },
        { content: "implement", status: "pending" },
      ] },
      c,
      offer
    );
    expect(r.code).toBe(TOOL_OK);
    expect(r.summary).toContain("1/3 done");
    expect(r.content).toContain("[x] read the config");
    expect(r.content).toContain("[>] write the test");
    expect(r.content).toContain("[ ] implement");
    expect(read()).toHaveLength(3);
  });

  it("replacing is idempotent — the same list twice is the same state", async () => {
    // Replace rather than patch: a patch protocol needs identifiers, and
    // identifiers a model invents mismatch a list it has since reordered.
    const { c, read } = withStore();
    const todos = [{ content: "one", status: "pending" }];
    await executeTool("todo", { todos }, c, offer);
    await executeTool("todo", { todos }, c, offer);
    expect(read()).toEqual([{ content: "one", status: "pending" }]);
  });

  it("allows at most one item in progress", async () => {
    // A list with four things in progress is a list nobody is steering by.
    const { c, read } = withStore();
    const r = await executeTool(
      "todo",
      { todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ] },
      c,
      offer
    );
    expect(r.code).toBe(TOOL_FAILED);
    expect(r.content).toContain("one thing is worked");
    expect(read()).toEqual([]); // rejected, not half-applied
  });

  it("rejects a bad status rather than coercing it", async () => {
    const { c } = withStore();
    const r = await executeTool(
      "todo",
      { todos: [{ content: "a", status: "nearly" }] },
      c,
      offer
    );
    expect(r.code).toBe(TOOL_FAILED);
    expect(r.content).toContain("not a status");
  });

  it("costs no approval under on_write — it changes no file", async () => {
    let asked = false;
    const { c } = withStore({
      gate: "on_write",
      approve: async () => { asked = true; return true; },
    });
    await executeTool("todo", { todos: [{ content: "a", status: "pending" }] }, c, offer);
    expect(asked).toBe(false);
  });
});

describe("webfetch — the tool that makes [sandbox] network real", () => {
  const offer = new Set(["webfetch"]);

  it("refuses everything when the surface disables the network", async () => {
    // The key was declared and unenforced; the startup banner said so. Now it
    // decides, and gaining network reach is a visible edit to the surface.
    const r = await executeTool(
      "webfetch",
      { url: "https://example.com" },
      ctx({ network: false, gate: "never" }),
      offer
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(r.content).toContain("network = false");
  });

  it("refuses loopback and private addresses — SSRF", async () => {
    // A URL a model chose is attacker-influenced wherever the model reads
    // anything it did not write. Unchecked, this reaches services the machine
    // can see and the network cannot.
    for (const url of [
      "http://127.0.0.1:11434/api/tags",
      "http://localhost:8080/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://[::1]/",
      // IPv4-mapped/compatible IPv6 — Node keeps (and even normalizes down to)
      // the hex form, which the dotted-only guard used to wave through.
      "http://[::ffff:7f00:1]/",           // 127.0.0.1
      "http://[::ffff:a9fe:a9fe]/",        // 169.254.169.254 (metadata)
      "http://[::ffff:169.254.169.254]/",  // normalizes to the hex form above
      "http://[::a9fe:a9fe]/",             // IPv4-compatible, same destination
      "http://[fe90::1]/",                  // link-local: fe80::/10 spans past fe80
      "http://[64:ff9b::7f00:1]/",          // NAT64 well-known prefix wrapping 127.0.0.1
    ]) {
      const r = await executeTool(
        "webfetch",
        { url },
        ctx({ network: true, gate: "never" }),
        offer
      );
      expect(r.code, url).toBe(TOOL_DENIED);
      expect(r.summary, url).toContain("private address");
    }
  });

  it("refuses schemes that are not http(s)", async () => {
    // file: would read the filesystem with none of the checks `read` applies.
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/html,x"]) {
      const r = await executeTool(
        "webfetch",
        { url },
        ctx({ network: true, gate: "never" }),
        offer
      );
      expect(r.code, url).toBe(TOOL_DENIED);
    }
  });

  it("is gated like a write — the request leaves the machine", async () => {
    let asked = false;
    await executeTool(
      "webfetch",
      { url: "http://127.0.0.1/" },
      ctx({
        network: true,
        gate: "on_write",
        approve: async () => { asked = true; return false; },
      }),
      offer
    );
    // Blocked before the prompt here (private address), which is the stronger
    // guarantee: the address check runs before anyone is asked.
    expect(asked).toBe(false);
    expect(needsApproval("webfetch", "on_write")).toBe(true);
  });
});

describe("task — delegation crosses a capability boundary", () => {
  const offer = new Set(["task"]);

  function delegating(over: Partial<ToolContext> = {}) {
    const calls: Array<{ role: string; instruction: string }> = [];
    const c = ctx({
      delegate: {
        depth: 0,
        roles: () => ["implementor", "verifier"],
        run: async (role, instruction) => {
          calls.push({ role, instruction });
          return { content: "done", code: 0, toolSteps: 2, model: "m" };
        },
      },
      ...over,
    });
    return { c, calls };
  }

  it("runs the sub-turn and returns only its answer", async () => {
    const { c, calls } = delegating({ gate: "never" });
    const r = await executeTool(
      "task",
      { role: "verifier", instruction: "run the suite" },
      c,
      offer
    );
    expect(r.code).toBe(TOOL_OK);
    expect(calls).toEqual([{ role: "verifier", instruction: "run the suite" }]);
    expect(r.content).toContain("done");
  });

  it("cannot nest — a sub-turn may not start another", async () => {
    const { c } = delegating({ gate: "never" });
    (c.delegate as any).depth = 1;
    const r = await executeTool(
      "task",
      { role: "verifier", instruction: "again" },
      c,
      offer
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(r.content).toContain("cannot start another");
  });

  it("refuses a role the surface does not define", async () => {
    const { c, calls } = delegating({ gate: "never" });
    const r = await executeTool(
      "task",
      { role: "root", instruction: "x" },
      c,
      offer
    );
    expect(r.code).toBe(TOOL_FAILED);
    expect(calls).toEqual([]);
  });

  it("carries the sub-turn's outcome rather than reporting success", async () => {
    // A delegated refusal is a refusal, not a successful delegation of one.
    const c = ctx({
      gate: "never",
      delegate: {
        depth: 0,
        roles: () => ["verifier"],
        run: async () => ({ content: "declined", code: 2, toolSteps: 1, model: "m" }),
      },
    });
    const r = await executeTool("task", { role: "verifier", instruction: "x" }, c, offer);
    expect(mapBucket(r.code)).toBe("refusal");
  });

  it("is gated: delegation is the moment capability changes hands", async () => {
    let seen: ApprovalRequest | null = null;
    const { c, calls } = delegating({
      gate: "on_write",
      approve: async (req) => { seen = req; return false; },
    });
    const r = await executeTool(
      "task",
      { role: "implementor", instruction: "write it" },
      c,
      offer
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(calls).toEqual([]);
    expect(seen!.summary).toContain("implementor");
  });
});

describe("bash_deny — the guardrail on operations that are not undoable", () => {
  // An allow-list cannot say "everything except three catastrophes", and that
  // is the shape the implementing role needs: unrestricted bash for builds and
  // suites nobody can enumerate, minus force-pushing over a release branch.
  const DENY = [
    String.raw`\bgit\s+push\b[^|;&]*\s(--force|-f)\b`,
    String.raw`\bgit\s+push\b[^|;&]*\s(main|master|release)\b`,
    String.raw`\bgit\s+push\b[^|;&]*--delete\b`,
    String.raw`\bgit\s+branch\b[^|;&]*\s-D\b`,
  ];
  const c = () => ctx({ gate: "never", bashDeny: DENY });
  const offer = new Set(["bash"]);

  const run = (command: string) => executeTool("bash", { command }, c(), offer);

  it("refuses the operations that lose someone else's work", async () => {
    for (const cmd of [
      "git push --force origin feature",
      "git push -f",
      "git push origin main",
      "git push origin master",
      "git push origin --delete feature",
      "git branch -D feature",
    ]) {
      const r = await run(cmd);
      expect(r.code, cmd).toBe(TOOL_DENIED);
      expect(r.summary, cmd).toContain("bash_deny");
    }
  });

  it("leaves ordinary work alone", async () => {
    // Over-blocking is its own failure: a guardrail people route around is
    // worse than none, because it teaches them the harness is in the way.
    for (const cmd of [
      "git status",
      "git push origin feature/thing",
      "git push -u origin my-branch",
      "git branch -d merged-branch",
      "git commit -m 'main point of the change'",
      "cargo test --all",
      "echo pushing to main later",
    ]) {
      const r = await run(cmd);
      expect(r.code, cmd).not.toBe(TOOL_DENIED);
    }
  });

  it("catches a denied command hidden behind a permitted one", async () => {
    const r = await run("git status && git push --force origin main");
    expect(r.code).toBe(TOOL_DENIED);
  });

  it("deny wins over allow", async () => {
    const r = await executeTool(
      "bash",
      { command: "git push --force origin main" },
      ctx({ gate: "never", bashAllow: ["^git\\s"], bashDeny: DENY }),
      offer
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(r.summary).toContain("bash_deny");
  });

  it("a deny pattern that will not compile refuses rather than permits", async () => {
    // The opposite of bash_allow, deliberately: refusing a safe command costs
    // an error message, running an unsafe one costs a branch.
    const r = await executeTool(
      "bash",
      { command: "echo hi" },
      ctx({ gate: "never", bashDeny: ["(["] }),
      offer
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(r.content).toContain("not a valid regular expression");
  });

  it("does nothing when the role declares no deny list", async () => {
    const r = await executeTool(
      "bash",
      { command: "git push --force origin main" },
      ctx({ gate: "never" }),
      offer
    );
    expect(r.code).not.toBe(TOOL_DENIED);
  });
});

describe("shell-mediated work is observed, not inferred", () => {
  it("a bash command that writes a file reports the worktree moved", async () => {
    // The nudge counted only write/edit, so a model editing through heredocs or
    // sed -i looked idle. 49 of the 50 nudged trials in the 48-task arm had made
    // no write/edit call at all.
    const out = await executeTool(
      "bash",
      { command: `echo hello > made-by-shell.txt` },
      ctx(),
      offered
    );
    expect(out.code).toBe(TOOL_OK);
    expect(out.worktree_changed).toBe(true);
  });

  it("sees work done outside the root when the shell cd's there", async () => {
    // worktreeStampOf walked only ctx.root, so an apt install, an /etc config
    // or a system service could never move the stamp — and the anti-flailing
    // nudge fired on an agent that was working correctly. One benchmark trial
    // printed "98 call(s) without changing a file" straight after postconf -e,
    // service start and chown, with two of its tests already passing.
    const outside = mkdtempSync(join(tmpdir(), "gnomon-outside-"));
    try {
      const out = await executeTool(
        "bash",
        { command: `cd ${outside} && echo hi > made-outside.txt` },
        ctx(),
        offered
      );
      expect(out.code).toBe(TOOL_OK);
      expect(out.worktree_changed).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a read-only bash command does not", async () => {
    // The guard must stay armed against real flailing: ls/cat/grep in a loop is
    // exactly the failure the nudge exists to catch.
    const out = await executeTool("bash", { command: `ls -la` }, ctx(), offered);
    expect(out.code).toBe(TOOL_OK);
    expect(out.worktree_changed).toBe(false);
  });

  it("does not report a surface edit as worktree progress", async () => {
    // .gnomon/ moving is drift, reported by surface_drift; it is not the model
    // making progress on the task.
    const out = await executeTool(
      "bash",
      { command: `mkdir -p .gnomon && echo x >> .gnomon/scratch.txt` },
      ctx(),
      offered
    );
    expect(out.worktree_changed).toBe(false);
  });
});

describe("task_allow bounds what delegation can reach", () => {
  const ctxFor = (taskAllow?: string[]) =>
    ({
      root: "/tmp",
      sandbox: "confined" as const,
      gate: "never" as const,
      approve: async () => true,
      taskAllow,
      delegate: {
        depth: 0,
        roles: () => ["implement", "verifier", "critique"],
        run: async () => ({ answer: "done", code: 0 }),
      },
    }) as unknown as Parameters<typeof executeTool>[2];

  it("refuses a target the role may not delegate to", async () => {
    // Without this, `task` is an unconditional capability upgrade: a sub-turn
    // runs with the TARGET role's tools, so a role declaring no `write` could
    // reach one that has it and have files written on its behalf. Its own
    // tools list stopped being the answer to what it could cause.
    const r = await executeTool(
      "task",
      { role: "implement", instruction: "write a file" },
      ctxFor(["verifier"]),
      new Set(["task"])
    );
    expect(r.code).toBe(2); // TOOL_DENIED — a refusal, not a failure
    expect(r.content).toContain("may not delegate");
    expect(r.content).toContain("verifier");
  });

  it("allows a declared target", async () => {
    const r = await executeTool(
      "task",
      { role: "verifier", instruction: "check it" },
      ctxFor(["verifier"]),
      new Set(["task"])
    );
    expect(r.code).not.toBe(2);
  });

  it("an empty list forbids delegation entirely", async () => {
    const r = await executeTool(
      "task",
      { role: "verifier", instruction: "check it" },
      ctxFor([]),
      new Set(["task"])
    );
    expect(r.code).toBe(2);
    expect(r.content).toContain("may not delegate at all");
  });

  it("an omitted list keeps the shipped behaviour", async () => {
    const r = await executeTool(
      "task",
      { role: "implement", instruction: "do it" },
      ctxFor(undefined),
      new Set(["task"])
    );
    expect(r.code).not.toBe(2);
  });
});

describe("sandboxCommand — where bash actually runs", () => {
  const off = { root: "/repo", exec: { mode: "off" as const, image: "x", network: false } };
  const on = { root: "/repo", exec: { mode: "docker" as const, image: "img:1", network: false } };

  it("leaves the command alone when exec is off, which is the default", () => {
    expect(sandboxCommand("echo hi", off, "n")).toBe("echo hi");
    expect(sandboxCommand("echo hi", { root: "/repo" }, "n")).toBe("echo hi");
  });

  it("mounts the repository at the same absolute path it has outside", () => {
    // So absolute paths the model has already seen keep working, and its cwd
    // is unchanged from its point of view.
    const c = sandboxCommand("ls", on, "n");
    expect(c).toContain('-v "/repo":"/repo"');
    expect(c).toContain('-w "/repo"');
  });

  it("maps the caller, or every file comes back owned by root", () => {
    // The first thing testing this found: without --user the operator cannot
    // edit their own repository after the agent writes in it.
    expect(sandboxCommand("ls", on, "n")).toMatch(/--user \d+:\d+/);
  });

  it("gives the sandbox no network unless the surface declares one", () => {
    expect(sandboxCommand("ls", on, "n")).toContain("--network none");
    const net = { ...on, exec: { ...on.exec, network: true } };
    expect(sandboxCommand("ls", net, "n")).not.toContain("--network none");
  });

  it("names the container so a cancelled turn can remove it", () => {
    // Killing the process group stops `docker run`, not the container it
    // started, so the work would continue after the turn gave up on it.
    expect(sandboxCommand("ls", on, "run-7")).toContain("--name run-7");
  });

  it("survives quotes in the command", () => {
    const c = sandboxCommand(`echo 'it'\''s fine'`, on, "n");
    expect(c).toContain("sh -c");
    // the single quote is escaped rather than ending the wrapper's own quoting
    expect(c.endsWith("'")).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Overflow: output too large for the window is kept, not thrown away.
//
// The truncation message used to end "narrow it instead". That is honest and
// it is the wrong advice for the measured failure: roughly 41% of benchmark
// trials end at the timeout cap, and the long tail is a model re-running a
// long command. The bytes it needed already existed and were discarded.

describe("oversized tool output is offloaded, not just truncated", () => {
  const big = () => "x".repeat(5000) + "NEEDLE_AT_THE_END\n";

  it("writes the FULL output and names a path the model can read", async () => {
    writeFileSync(join(root, "big.txt"), big());
    const spill = createSpillSink(root, "sess-1");
    const out = await executeTool(
      "read",
      { path: "big.txt" },
      ctx({ maxOutputBytes: 200, spill }),
      offered
    );
    const m = out.content.match(/saved at (\S+)/);
    expect(m, "the notice must name the file it wrote").toBeTruthy();
    const rel = m![1];
    expect(rel.startsWith(`${OVERFLOW_DIR}/`)).toBe(true);
    // The whole point: the tail the model was truncated away from is on disk.
    const saved = readFileSync(join(root, rel), "utf-8");
    expect(saved).toContain("NEEDLE_AT_THE_END");
    expect(saved.length).toBeGreaterThan(5000);
    // And the model was still told what it got is partial.
    expect(out.content).toContain("not all of it");
  });

  it("the path it names resolves under the sandbox, so `read` can reach it", async () => {
    writeFileSync(join(root, "big.txt"), big());
    const spill = createSpillSink(root, "sess-1");
    const first = await executeTool(
      "read", { path: "big.txt" }, ctx({ maxOutputBytes: 200, spill }), offered
    );
    const rel = first.content.match(/saved at (\S+)/)![1];
    // Confined is the shipped default; a path the harness names and the
    // sandbox then refuses would be worse than saying nothing.
    const back = await executeTool(
      "read", { path: rel }, ctx({ sandbox: "confined" }), offered
    );
    expect(back.code).toBe(0);
    expect(back.content).toContain("NEEDLE_AT_THE_END");
  });

  it("keeps the old message, and names no path, when there is no sink", async () => {
    writeFileSync(join(root, "big.txt"), big());
    const out = await executeTool(
      "read", { path: "big.txt" }, ctx({ maxOutputBytes: 200 }), offered
    );
    expect(out.content).toContain("narrow it instead");
    expect(out.content).not.toContain("saved at");
  });

  it("names no path when the write fails — a citation to nothing is worse", async () => {
    writeFileSync(join(root, "big.txt"), big());
    const out = await executeTool(
      "read",
      { path: "big.txt" },
      ctx({ maxOutputBytes: 200, spill: () => null }),
      offered
    );
    expect(out.content).not.toContain("saved at");
    expect(out.content).toContain("narrow it instead");
  });

  it("numbers files across calls instead of overwriting the last one", () => {
    const spill = createSpillSink(root, "sess-1");
    const a = spill("first", "bash-exit");
    const b = spill("second", "bash-exit");
    expect(a).not.toBe(b);
    expect(readFileSync(join(root, a!), "utf-8")).toBe("first");
    expect(readFileSync(join(root, b!), "utf-8")).toBe("second");
  });

  it("prunes old session directories so scratch cannot grow without bound", () => {
    // Four older sessions already on disk, then a fifth writes with keep=2.
    for (const old of ["s1", "s2", "s3", "s4"]) {
      mkdirSync(join(root, OVERFLOW_DIR, old), { recursive: true });
      writeFileSync(join(root, OVERFLOW_DIR, old, "001-x.txt"), "old");
    }
    createSpillSink(root, "s5", 2)("new", "x");
    const left = readdirSync(join(root, OVERFLOW_DIR)).sort();
    expect(left).toContain("s5");
    expect(left.length).toBeLessThanOrEqual(3);
  });

  it("grep reaches the file it names — the advice has to actually work", async () => {
    // The first version of the notice said "read or grep that file". Measured
    // end to end, BOTH halves were wrong: `read` truncated at the same limit
    // and offloaded a second, larger copy, and `grep` on a file path walked it
    // as a directory, found nothing, and answered "No match" for a file that
    // contained the pattern.
    writeFileSync(join(root, "big.txt"), "x".repeat(5000) + "\nFINAL_ERROR: linker failed\n");
    const spill = createSpillSink(root, "sess-1");
    const first = await executeTool(
      "read", { path: "big.txt" }, ctx({ maxOutputBytes: 200, spill }), offered
    );
    const rel = first.content.match(/saved at (\S+)/)![1];
    const hit = await executeTool(
      "grep", { pattern: "FINAL_ERROR", path: rel },
      ctx({ maxOutputBytes: 4000 }), new Set(["grep"])
    );
    expect(hit.code).toBe(0);
    expect(hit.content).toContain("FINAL_ERROR: linker failed");
  });

  it("reading an offloaded file does not offload it again", async () => {
    writeFileSync(join(root, "big.txt"), big());
    const spill = createSpillSink(root, "sess-1");
    const c = ctx({ maxOutputBytes: 200, spill });
    const first = await executeTool("read", { path: "big.txt" }, c, offered);
    const rel = first.content.match(/saved at (\S+)/)![1];
    await executeTool("read", { path: rel }, c, offered);
    await executeTool("read", { path: rel }, c, offered);
    // Two further reads of the same file wrote nothing: the bytes are already
    // on disk, and a second copy is a bigger file and another truncated prefix.
    const files = readdirSync(join(root, OVERFLOW_DIR, "sess-1"));
    expect(files).toHaveLength(1);
  });

  it("never writes inside .gnomon/, which would move the surface hash", () => {
    const rel = createSpillSink(root, "sess-1")("payload", "bash-exit");
    expect(rel).toBeTruthy();
    expect(rel!.startsWith(".gnomon/")).toBe(false);
    expect(rel!.startsWith(`${OVERFLOW_DIR}/`)).toBe(true);
  });
});

describe("portability: the shell is POSIX on every platform", () => {
  // The design claim this pins: a surface at a given hash means the same
  // commands everywhere. `shell: true` would have run /bin/sh here and
  // cmd.exe on Windows -- two languages behind one hash.
  it("resolves to a shell that exists on this machine", () => {
    const sh = tools.posixShell();
    expect(sh, "no POSIX shell resolved on this platform").not.toBeNull();
    expect(existsSync(sh!)).toBe(true);
  });

  it("is /bin/sh off Windows", () => {
    if (process.platform === "win32") return;
    expect(tools.posixShell()).toBe("/bin/sh");
  });

  it("the refusal names how to get a shell, rather than only that one is missing", () => {
    // A refusal an operator cannot act on is a worse failure than the one it
    // reports. This is the message a Windows box with no Git for Windows sees.
    expect(tools.NO_POSIX_SHELL).toMatch(/GNOMON_SHELL/);
    expect(tools.NO_POSIX_SHELL).toMatch(/Git/i);
    // It names cmd.exe on purpose -- saying why the obvious fallback is NOT
    // taken is the part an operator needs, not a detail to hide.
    expect(tools.NO_POSIX_SHELL).toMatch(/cmd\.exe/);
    expect(tools.NO_POSIX_SHELL).toMatch(/winget|install/i);
  });
});

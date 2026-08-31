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
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildToolSet,
  executeTool,
  globToRegExp,
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
  TOOL_OK_EMPTY,
  scanShellCommand,
  ApprovalGate,
  ApprovalRequest,
  Todo,
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

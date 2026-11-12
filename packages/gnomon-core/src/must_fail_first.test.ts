/**
 * mustFailFirst and readVerifyExit, the two pieces the [verify] gate and
 * `gnomon check` share.
 *
 * The loop carried this logic inline with no test of its own: the only thing
 * that exercised it was a benchmark probe. These pin the behaviour the loop
 * had, on the extracted function, so the second caller inherits a contract
 * rather than a copy.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mustFailFirst, readVerifyExit, isTestPath, type PreImage } from "./must_fail_first.js";
import { executeTool, type ToolContext } from "./tools.js";

const TEST_PATHS = ["**/test_*.py", "**/*_test.py", "**/*.test.ts", "**/*.test.js", "**/tests/**"];

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-mff-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

/**
 * A stand-in for the suite: "passes" when src/pay.js says what the test wants.
 * Reads the tree at call time, which is the only thing the function under test
 * can influence.
 */
const suite = (want: string) => async () => {
  const ok = existsSync(join(root, "src/pay.js")) && read("src/pay.js").includes(want);
  return { code: 0, summary: `bash — exit ${ok ? 0 : 1}` };
};

describe("mustFailFirst", () => {
  it("flags a new test that passes against the code as it was", async () => {
    put("src/pay.js", "total = 2\n");
    put("tests/test_pay.py", "assert total == 2\n");
    const pre = new Map<string, PreImage>([
      [join(root, "src/pay.js"), "total = 2  # unchanged in meaning\n"],
      [join(root, "tests/test_pay.py"), ""],
    ]);
    const r = await mustFailFirst(root, { command: "suite", test_paths: TEST_PATHS }, pre, suite("total = 2"));
    expect(r).toMatchObject({ ran: true, pinsNothing: true, tests: ["tests/test_pay.py"], restored: ["src/pay.js"] });
  });

  it("accepts a test that fails on the pre-image and passes on the change", async () => {
    put("src/pay.js", "total = 2\n");
    put("tests/test_pay.py", "assert total == 2\n");
    const pre = new Map<string, PreImage>([
      [join(root, "src/pay.js"), "total = 1\n"],
      [join(root, "tests/test_pay.py"), ""],
    ]);
    const r = await mustFailFirst(root, { command: "suite", test_paths: TEST_PATHS }, pre, suite("total = 2"));
    expect(r).toMatchObject({ ran: true, pinsNothing: false });
  });

  it("restores the tree byte for byte, including when the run throws", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]); // not UTF-8
    writeFileSync(join(root, "blob.bin"), bytes);
    put("tests/test_x.py", "x\n");
    const pre = new Map<string, PreImage>([
      [join(root, "blob.bin"), "old\n"],
      [join(root, "tests/test_x.py"), ""],
    ]);
    let seen = "";
    await expect(
      mustFailFirst(root, { command: "c", test_paths: TEST_PATHS }, pre, async () => {
        seen = read("blob.bin");
        throw new Error("shell went away");
      })
    ).rejects.toThrow("shell went away");
    expect(seen).toBe("old\n");
    expect(readFileSync(join(root, "blob.bin")).equals(bytes)).toBe(true);
  });

  it("removes a file that did not exist before (null), then puts it back", async () => {
    put("src/new.js", "module\n");
    put("src/a.test.ts", "t\n");
    const pre = new Map<string, PreImage>([
      [join(root, "src/new.js"), null],
      [join(root, "src/a.test.ts"), null],
    ]);
    let existedDuring = true;
    await mustFailFirst(root, { command: "c", test_paths: TEST_PATHS }, pre, async () => {
      existedDuring = existsSync(join(root, "src/new.js"));
      return { code: 0, summary: "bash — exit 1" };
    });
    expect(existedDuring).toBe(false);
    expect(read("src/new.js")).toBe("module\n");
    // The test itself is never touched: it is what is being judged.
    expect(read("src/a.test.ts")).toBe("t\n");
  });

  it("recreates a file the change deleted, then deletes it again", async () => {
    put("tests/test_y.py", "y\n");
    const pre = new Map<string, PreImage>([
      [join(root, "src/gone.js"), "was here\n"],
      [join(root, "tests/test_y.py"), ""],
    ]);
    let during = "";
    await mustFailFirst(root, { command: "c", test_paths: TEST_PATHS }, pre, async () => {
      during = read("src/gone.js");
      return { code: 0, summary: "bash — exit 1" };
    });
    expect(during).toBe("was here\n");
    expect(existsSync(join(root, "src/gone.js"))).toBe(false);
  });

  it("does not run when no test was touched, or when only tests were", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return { code: 0, summary: "bash — exit 0" };
    };
    put("src/a.js", "a\n");
    const noTest = await mustFailFirst(
      root, { command: "c", test_paths: TEST_PATHS },
      new Map<string, PreImage>([[join(root, "src/a.js"), ""]]), run
    );
    expect(noTest).toMatchObject({ ran: false, reason: "the change touched no test" });
    put("tests/test_a.py", "t\n");
    const onlyTests = await mustFailFirst(
      root, { command: "c", test_paths: TEST_PATHS },
      new Map<string, PreImage>([[join(root, "tests/test_a.py"), ""]]), run
    );
    expect(onlyTests.ran).toBe(false);
    expect(onlyTests.reason).toMatch(/only tests/);
    expect(calls).toBe(0);
  });

  // dc1 (2026-11-12, react-lead-form): the turn's edit of `.gitignore` gave it
  // a pre-image; at the end the re-run put it back through writeFileIn, whose
  // temp file `..gitignore.<pid>.<hex>.tmp` read as outside the root on Linux
  // (rel_path.ts), and the throw ended a 58-call run as "could not start".
  it("puts a dotfile back for the re-run, and restores it after", async () => {
    put(".gitignore", "node_modules/\ndist/\n");
    put("tests/test_x.py", "x\n");
    const pre = new Map<string, PreImage>([
      [join(root, ".gitignore"), "node_modules/\n"],
      [join(root, "tests/test_x.py"), ""],
    ]);
    let during = "";
    const r = await mustFailFirst(root, { command: "c", test_paths: TEST_PATHS }, pre, async () => {
      during = read(".gitignore");
      return { code: 0, summary: "bash — exit 1" };
    });
    expect(r).toMatchObject({ ran: true, pinsNothing: false, restored: [".gitignore"] });
    expect(during).toBe("node_modules/\n");
    expect(read(".gitignore")).toBe("node_modules/\ndist/\n");
  });

  // Whatever stops a pre-image going back (here a directory gnomon may not
  // write), the check is refused, said, and the turn goes on: it is not
  // thrown out of the turn, and what was already put back is restored.
  const canDenyWrites = process.platform !== "win32" && process.getuid?.() !== 0;
  it.skipIf(!canDenyWrites)("a pre-image that cannot be put back refuses the check instead of throwing", async () => {
    put("src/a.js", "new a\n");
    put("ro/b.js", "new b\n");
    put("tests/test_z.py", "z\n");
    chmodSync(join(root, "ro"), 0o555);
    try {
      const pre = new Map<string, PreImage>([
        [join(root, "src/a.js"), "old a\n"],
        [join(root, "ro/b.js"), "old b\n"],
        [join(root, "tests/test_z.py"), ""],
      ]);
      let calls = 0;
      const r = await mustFailFirst(root, { command: "c", test_paths: TEST_PATHS }, pre, async () => {
        calls++;
        return { code: 0, summary: "bash — exit 0" };
      });
      expect(r).toMatchObject({ ran: false, pinsNothing: false, restored: [] });
      expect(r.reason).toMatch(/^not re-run: ro\/b\.js could not be put back: /);
      expect(calls).toBe(0);
      expect(read("src/a.js")).toBe("new a\n");
      expect(read("ro/b.js")).toBe("new b\n");
    } finally {
      chmodSync(join(root, "ro"), 0o755);
    }
  });

  it("re-runs through a real shell, the way the loop calls it", async () => {
    put("src/val.txt", "2\n");
    put("tests/test_val.sh", "grep -qx 2 src/val.txt\n");
    const ctx: ToolContext = {
      root, sandbox: "confined", gate: "never", approve: async () => true,
      timeoutMs: 10_000, maxOutputBytes: 32_000,
    };
    const run = (command: string) => executeTool("bash", { command }, ctx, new Set(["bash"]));
    const verify = { command: "sh tests/test_val.sh", test_paths: TEST_PATHS };
    const pins = await mustFailFirst(root, verify, new Map<string, PreImage>([
      [join(root, "src/val.txt"), "1\n"], [join(root, "tests/test_val.sh"), ""],
    ]), run);
    expect(pins).toMatchObject({ ran: true, pinsNothing: false });
    const nothing = await mustFailFirst(root, verify, new Map<string, PreImage>([
      [join(root, "src/val.txt"), "2\n"], [join(root, "tests/test_val.sh"), ""],
    ]), run);
    expect(nothing).toMatchObject({ ran: true, pinsNothing: true });
    expect(read("src/val.txt")).toBe("2\n");
  });
});

describe("readVerifyExit", () => {
  it("passes only on a readable exit 0", () => {
    expect(readVerifyExit({ code: 0, summary: "bash — exit 0" })).toEqual({ exit: 0, passed: true, unrunnable: false });
    expect(readVerifyExit({ code: 0, summary: "bash — exit 1" }).passed).toBe(false);
  });

  it("fails closed when the status cannot be read", () => {
    // `exit null` is what a signal kill used to look like; it read as 0.
    expect(readVerifyExit({ code: 0, summary: "bash — exit null" })).toEqual({ exit: null, passed: false, unrunnable: false });
    expect(readVerifyExit({ code: 0, summary: "bash — killed by SIGKILL" })).toEqual({ exit: 1, passed: false, unrunnable: false });
  });

  it("names 126 and 127 as could-not-run", () => {
    expect(readVerifyExit({ code: 0, summary: "bash — exit 127" }).unrunnable).toBe(true);
    expect(readVerifyExit({ code: 0, summary: "bash — exit 126" }).unrunnable).toBe(true);
  });

  it("does not pass a run the tool itself refused", () => {
    expect(readVerifyExit({ code: 2, summary: "bash — exit 0" }).passed).toBe(false);
  });
});

describe("isTestPath", () => {
  it("matches the surface's globs and treats a bad glob as matching nothing", () => {
    expect(isTestPath(TEST_PATHS, "pkg/tests/x.py")).toBe(true);
    expect(isTestPath(TEST_PATHS, "src/pay.py")).toBe(false);
    expect(isTestPath(["[unclosed"], "anything")).toBe(false);
  });
});

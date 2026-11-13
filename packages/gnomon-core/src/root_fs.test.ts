import { describe, it, expect, afterEach } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import {
  appendFileIn,
  containedReadonlyPaths,
  createExclusiveIn,
  ensureDirIn,
  RootWriteError,
  writeFileIn,
  writeRegular,
  writeRootFor,
} from "./root_fs.js";
import { escapesBase } from "./rel_path.js";
import { executeTool, TOOL_OK, type ToolContext } from "./tools.js";
import { isValidImageRef } from "./config.js";
import { planGit, _resetGitSafety } from "./git_safe.js";

const made: string[] = [];
const dir = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  made.push(d);
  return d;
};
afterEach(() => {
  _resetGitSafety();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const posix = process.platform !== "win32";

describe("root_fs — host writes under a root", () => {
  it("writes, appends and creates exclusively in plain directories", () => {
    const root = dir("gnomon-rootfs-");
    writeFileIn(root, join(root, "a", "b", "f.json"), "1\n");
    appendFileIn(root, join(root, "a", "log"), "x\n");
    appendFileIn(root, join(root, "a", "log"), "y\n");
    createExclusiveIn(root, join(root, "a", "lock"), "me");
    expect(readFileSync(join(root, "a", "b", "f.json"), "utf-8")).toBe("1\n");
    expect(readFileSync(join(root, "a", "log"), "utf-8")).toBe("x\ny\n");
    expect(() => createExclusiveIn(root, join(root, "a", "lock"))).toThrow(/EEXIST/);
  });

  it.skipIf(!posix)("replaces a symlink rather than writing through it, and refuses to append through one", () => {
    const root = dir("gnomon-rootfs-");
    const outside = join(dir("gnomon-rootfs-out-"), "bashrc");
    writeFileSync(outside, "keep\n");
    symlinkSync(outside, join(root, "state.json"));
    writeFileIn(root, join(root, "state.json"), "{}\n");
    expect(readFileSync(outside, "utf-8")).toBe("keep\n");
    expect(lstatSync(join(root, "state.json")).isFile()).toBe(true);
    symlinkSync(outside, join(root, "trail.jsonl"));
    expect(() => appendFileIn(root, join(root, "trail.jsonl"), "x\n")).toThrow(RootWriteError);
    expect(() => createExclusiveIn(root, join(root, "trail.jsonl"))).toThrow();
    expect(readFileSync(outside, "utf-8")).toBe("keep\n");
  });

  it.skipIf(!posix)("refuses a directory component that is a symlink", () => {
    const root = dir("gnomon-rootfs-");
    const outside = dir("gnomon-rootfs-out-");
    symlinkSync(outside, join(root, ".gnomon-audit"));
    expect(() => appendFileIn(root, join(root, ".gnomon-audit", "s.jsonl"), "x\n")).toThrow(RootWriteError);
    expect(() => writeFileIn(root, join(root, ".gnomon-audit", "s.json"), "x\n")).toThrow(RootWriteError);
    expect(() => ensureDirIn(root, join(root, ".gnomon-audit", "sub"))).toThrow(RootWriteError);
  });

  it.skipIf(!posix)("refuses a file with a second hard link (one to a file outside the root)", () => {
    const root = dir("gnomon-rootfs-");
    const outside = join(dir("gnomon-rootfs-out-"), "bashrc");
    writeFileSync(outside, "keep\n");
    linkSync(outside, join(root, "trail.jsonl"));
    expect(() => appendFileIn(root, join(root, "trail.jsonl"), "x\n")).toThrow(/hard link/);
    expect(readFileSync(outside, "utf-8")).toBe("keep\n");
  });
});

// dc1 (2026-11-12, react-lead-form): `rel.startsWith("..")` read a NAME that
// begins with two dots as a climb. writeFileIn's temp file for `.gitignore`
// is `..gitignore.<pid>.<hex>.tmp`, and on Linux verifyFd checks the
// descriptor's real path against the root, so every edit or write of a
// dotfile failed (11), and the [verify] must-fail-first re-run threw out of
// the turn putting `.gitignore` back. escapesBase (rel_path.ts) is the one
// test every containment check now shares.
describe("a name that begins with two dots is inside the root", () => {
  it("writeFileIn and writeRegular write dotfiles (the temp file is ..<name>.<pid>.<hex>.tmp)", () => {
    const root = dir("gnomon-rootfs-dot-");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileIn(root, join(root, ".gitignore"), "node_modules/\ndist/\n");
    writeRegular([root], join(root, ".env"), "A=1\n");
    writeFileIn(root, join(root, "sub", ".npmrc"), "x=1\n");
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe("node_modules/\ndist/\n");
    expect(readFileSync(join(root, ".env"), "utf-8")).toBe("A=1\n");
    expect(readFileSync(join(root, "sub", ".npmrc"), "utf-8")).toBe("x=1\n");
    // No temp file is left behind.
    expect(readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("the edit and write tools change a dotfile (they failed with 11 on Linux)", async () => {
    const root = dir("gnomon-rootfs-dot-");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    const ctx: ToolContext = {
      root, sandbox: "confined", gate: "never", approve: async () => true,
      timeoutMs: 10_000, maxOutputBytes: 32_000,
    };
    const offered = new Set(["edit", "write", "read"]);
    const edit = await executeTool("edit", { path: ".gitignore", old_text: "node_modules/\n", new_text: "node_modules/\ndist/\n" }, ctx, offered);
    expect(edit.code, edit.content).toBe(TOOL_OK);
    const write = await executeTool("write", { path: ".eslintrc", content: "{}\n" }, ctx, offered);
    expect(write.code, write.content).toBe(TOOL_OK);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe("node_modules/\ndist/\n");
    expect(readFileSync(join(root, ".eslintrc"), "utf-8")).toBe("{}\n");
    // And a path through a `..`-named directory resolves inside the root.
    mkdirSync(join(root, "..data"));
    writeFileSync(join(root, "..data", "app.json"), "{}\n");
    const read = await executeTool("read", { path: "..data/app.json" }, ctx, offered);
    expect(read.code, read.content).toBe(TOOL_OK);
  });

  it("a ..data directory (a Kubernetes ConfigMap mount) is under the root", () => {
    const root = dir("gnomon-rootfs-dot-");
    writeFileIn(root, join(root, "..data", "config.json"), "{}\n");
    expect(ensureDirIn(root, join(root, "cfg", "..2026_11_12", "x"))).toBe(join(root, "cfg", "..2026_11_12", "x"));
    expect(readFileSync(join(root, "..data", "config.json"), "utf-8")).toBe("{}\n");
    expect(writeRootFor(root, join(root, "..audit"))).toBe(root);
    for (const rel of ["..data", "..data/config.json", "..gitignore.4147.fbc4a3b7.tmp", "...", "a/../b", ".", ""]) {
      expect(escapesBase(rel), rel).toBe(false);
    }
  });

  it("a real escape is still one: .., ../x, an absolute path elsewhere, a symlink out", () => {
    const root = dir("gnomon-rootfs-dot-");
    const outside = dir("gnomon-rootfs-dot-out-");
    for (const rel of ["..", "../x", `..${sep}x`, "../..data", relative(root, outside), relative(root, join(dirname(root), "..sibling"))]) {
      expect(escapesBase(rel), rel).toBe(true);
    }
    expect(escapesBase(outside)).toBe(true);
    expect(() => writeFileIn(root, join(root, "..", "x"), "x\n")).toThrow(RootWriteError);
    expect(() => writeFileIn(root, join(dirname(root), "..sibling"), "x\n")).toThrow(RootWriteError);
    if (posix) {
      symlinkSync(outside, join(root, "out"));
      expect(() => writeRegular([root], join(root, "out", ".gitignore"), "x\n")).toThrow(RootWriteError);
      expect(() => writeFileIn(root, join(root, "out", ".gitignore"), "x\n")).toThrow(RootWriteError);
      expect(readdirSync(outside)).toEqual([]);
    }
  });
});

describe("containedReadonlyPaths — what a container gets read-only", () => {
  it("the surface, the records, and git's control files; records made when absent", () => {
    const root = dir("gnomon-rootfs-");
    mkdirSync(join(root, ".gnomon"));
    execFileSync("git", ["init", "-q", root]);
    rmSync(join(root, ".git", "hooks"), { recursive: true, force: true });
    const paths = containedReadonlyPaths(root).map((p) => p.slice(root.length + 1));
    expect(paths).toEqual([
      ".gnomon",
      ".gnomon-audit",
      ".gnomon-sessions",
      ".gnomon-loops",
      join(".git", "config"),
      join(".git", "commondir"),
      join(".git", "config.worktree"),
      join(".git", "hooks"),
      join(".git", "info"),
    ]);
  });

  it.skipIf(!posix)("refuses to set up a sandbox over a symlinked record directory", () => {
    const root = dir("gnomon-rootfs-");
    mkdirSync(join(root, ".gnomon"));
    symlinkSync(dir("gnomon-rootfs-out-"), join(root, ".gnomon-sessions"));
    expect(() => containedReadonlyPaths(root)).toThrow(RootWriteError);
  });
});

describe("isValidImageRef", () => {
  it("accepts references and refuses anything else", () => {
    for (const ok of ["debian:stable-slim", "img:1", "ghcr.io/org/app:v1.2", "localhost:5000/a/b", `alpine@sha256:${"a".repeat(64)}`]) {
      expect(isValidImageRef(ok), ok).toBe(true);
    }
    for (const bad of ["", "-x", "--privileged", "a b", "x;id", "$(id)", "Upper/Case", "a:b:c", "a\nb"]) {
      expect(isValidImageRef(bad), bad).toBe(false);
    }
  });
});

describe("git_safe — programs named per URL or per remote are blanked by name", () => {
  it("credential.<url>.helper, gpg.<fmt>.program, remote.<name>.uploadpack and .vcs", () => {
    const repo = dir("gnomon-rootfs-git-");
    execFileSync("git", ["init", "-q", repo]);
    for (const [k, v] of [
      ["credential.https://example.com.helper", "!touch /tmp/x"],
      ["gpg.ssh.program", "/tmp/evil"],
      ["remote.origin.uploadpack", "/tmp/evil"],
      ["remote.origin.vcs", "evil"],
    ]) {
      execFileSync("git", ["-C", repo, "config", k!, v!]);
    }
    const plan = planGit(["status"], { cwd: repo });
    expect(plan).not.toBeNull();
    const blanked = new Map<string, string>();
    for (let i = 0; i < Number(plan!.env.GIT_CONFIG_COUNT); i++) {
      blanked.set(String(plan!.env[`GIT_CONFIG_KEY_${i}`]).toLowerCase(), String(plan!.env[`GIT_CONFIG_VALUE_${i}`]));
    }
    for (const k of ["credential.https://example.com.helper", "gpg.ssh.program", "remote.origin.uploadpack", "remote.origin.vcs"]) {
      expect(blanked.get(k), k).toBe("");
    }
  });
});

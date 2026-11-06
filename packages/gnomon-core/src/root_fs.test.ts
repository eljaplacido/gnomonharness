import { describe, it, expect, afterEach } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  appendFileIn,
  containedReadonlyPaths,
  createExclusiveIn,
  ensureDirIn,
  RootWriteError,
  writeFileIn,
} from "./root_fs.js";
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

describe("containedReadonlyPaths — what a container gets read-only", () => {
  it("the surface, the records, and git's control files; records made when absent", () => {
    const root = dir("gnomon-rootfs-");
    mkdirSync(join(root, ".gnomon"));
    execFileSync("git", ["init", "-q", root]);
    rmSync(join(root, ".git", "hooks"), { recursive: true, force: true });
    const paths = containedReadonlyPaths(root).map((p) => p.slice(root.length + 1));
    expect(paths).toEqual([".gnomon", ".gnomon-audit", ".gnomon-sessions", join(".git", "config"), join(".git", "hooks"), join(".git", "info")]);
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

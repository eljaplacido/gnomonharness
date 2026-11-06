/**
 * The seventh review's reproductions, one per finding, against the public
 * API as it stood when they were found (4c3ce63e) -- so each fails there and
 * passes after.
 *
 * The threat is unchanged: exec = "docker" (and "os"), the model's bash
 * writes the project root (and so `.git/objects` and `.git/refs`), the model
 * is hostile. B1, B2 and B4 share a root cause: `gnomon check --base <rev>`
 * took more than the policy under judgement from a revision the model can
 * make.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";
import { executeTool, sandboxCommand, type ToolContext } from "./tools.js";
import { runCheck } from "./check.js";
import { guardToolCall } from "./guard.js";
import { recordExecFloor, surfaceGrants } from "./trust.js";
import { _resetGitSafety } from "./git_safe.js";
import { repoStateDir, restoreProtected, snapshotProtected } from "./root_fs.js";
import { measureTreeDelta } from "./prompt_loop.js";

const REPO_SURFACE = resolve(process.cwd(), "..", "..", ".gnomon");
const POLICY = (exec: string, opts: { network?: boolean; verify?: string } = {}) =>
  `[approval]\ngate = "on_write"\n\n[sandbox]\nlevel = "confined"\nnetwork = ${opts.network === true}\nexec = "${exec}"\nimage = "img:1"\n` +
  (opts.verify ? `\n[verify]\ncommand = "${opts.verify}"\ntest_paths = ["tests/**"]\n` : "");

const made: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}
afterEach(() => {
  _resetGitSafety();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const posix = process.platform !== "win32";

/** A committed project: the repo's surface with `policy`, one commit. */
function repo(policy: string): { root: string; git: (...a: string[]) => string } {
  const root = tmp("gnomon-r7-");
  cpSync(REPO_SURFACE, join(root, ".gnomon"), { recursive: true });
  writeFileSync(join(root, ".gnomon", "policy.toml"), policy);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf-8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "surface");
  return { root, git };
}

/** The model's base: HEAD with `.gnomon/<file>` rewritten, committed on branch `evil`, then reset away. */
function evilBase(r: ReturnType<typeof repo>, files: Record<string, string>): string {
  for (const [f, text] of Object.entries(files)) writeFileSync(join(r.root, ".gnomon", f), text);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "x");
  r.git("branch", "-f", "evil", "HEAD");
  r.git("reset", "-q", "--hard", "HEAD~1");
  return r.git("rev-parse", "evil");
}

/** The change under judgement. */
function change(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
}

/** No docker here: a stub that runs nothing and says no container is up. */
async function withoutDocker<T>(fn: () => Promise<T>): Promise<T> {
  const bin = tmp("gnomon-r7-bin-");
  writeFileSync(join(bin, "docker"), '#!/bin/sh\n[ "$1" = run ] && exit 125\nexit 0\n');
  chmodSync(join(bin, "docker"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = path;
  }
}

/**
 * A commit whose tree is `.gnomon/` holding `..`/`..`/<name> = "pwned":
 * `git mktree` takes the `..` entries a hostile model would write.
 */
function dotDotCommit(git: (args: string[], input?: string) => string, name: string): string {
  const blob = git(["hash-object", "-w", "--stdin"], "pwned\n");
  const t1 = git(["mktree"], `100644 blob ${blob}\t${name}\n`);
  const t2 = git(["mktree"], `040000 tree ${t1}\t..\n`);
  const t3 = git(["mktree"], `040000 tree ${t2}\t..\n`);
  const top = git(["mktree"], `040000 tree ${t3}\t.gnomon\n`);
  return git(["commit-tree", top, "-p", "HEAD", "-m", "evil"]);
}

describe("seventh review — B1: a committed surface never writes outside the copy", () => {
  it.skipIf(!posix)("gnomon check refuses a base whose .gnomon/ holds `..` entries, and writes nothing outside", async () => {
    const r = repo(POLICY("off", { verify: "true" }));
    const name = `gnomon-r7-escape-${randomBytes(6).toString("hex")}`;
    const git = (args: string[], input?: string) =>
      execFileSync("git", args, { cwd: r.root, encoding: "utf-8", ...(input !== undefined ? { input } : {}) }).trim();
    const sha = dotDotCommit(git, name);
    change(r.root);
    // .gnomon/../../<name> from the temp copy is <tmpdir>/<name>.
    const landed = join(tmpdir(), name);
    try {
      const v = await runCheck({ dir: r.root, base: sha, role: "implement" });
      expect(existsSync(landed)).toBe(false);
      expect(v.exit).toBe(10);
      expect(v.error).toMatch(/\.\./);
    } finally {
      rmSync(landed, { force: true });
    }
  });

  it.skipIf(!posix)("gnomon guard refuses the same tree and writes nothing beside its cache", async () => {
    const r = repo(POLICY("off"));
    const name = `gnomon-r7-escape-${randomBytes(6).toString("hex")}`;
    const git = (args: string[], input?: string) =>
      execFileSync("git", args, { cwd: r.root, encoding: "utf-8", ...(input !== undefined ? { input } : {}) }).trim();
    const sha = dotDotCommit(git, name);
    const v = await guardToolCall({ cwd: r.root, base: sha, role: "implement", call: { tool: "read", input: { path: "README.md" } } });
    // <cache>/rules/<tree>.tmp-…/.gnomon/../../<name> is <cache>/rules/<name>.
    expect(existsSync(join(repoStateDir(join(r.root, ".git")), "guard", "rules", name))).toBe(false);
    expect(v.decision).toBe("ask");
    expect(v.error).toMatch(/\.\./);
  });
});

describe("seventh review — B2: what acts on the host comes from the live surface, not the base", () => {
  it.skipIf(!posix)("a base's [audit.attest] sign is not run by gnomon check", async () => {
    const r = repo(POLICY("off", { verify: "true" }));
    const marker = join(tmp("gnomon-r7-mark-"), "SIGNED_ON_HOST");
    const config = readFileSync(join(r.root, ".gnomon", "config.toml"), "utf-8");
    const base = evilBase(r, { "config.toml": `${config}\n[audit.attest]\nsign = "touch ${marker}"\n` });
    change(r.root);
    const v = await runCheck({ dir: r.root, base, role: "implement" });
    expect(existsSync(marker)).toBe(false);
    expect(v.audit?.trail).toBeDefined();
  });

  it.skipIf(!posix)("a base's absolute [audit] dir is not where the verdict goes", async () => {
    const r = repo(POLICY("off", { verify: "true" }));
    const elsewhere = join(tmp("gnomon-r7-out-"), "trail");
    const config = readFileSync(join(r.root, ".gnomon", "config.toml"), "utf-8").replace(/^dir = ".gnomon-audit"$/m, `dir = "${elsewhere}"`);
    expect(config).toContain(elsewhere);
    const base = evilBase(r, { "config.toml": config });
    change(r.root);
    const v = await runCheck({ dir: r.root, base, role: "implement" });
    expect(existsSync(elsewhere)).toBe(false);
    expect(v.audit?.trail.startsWith(join(r.root, ".gnomon-audit"))).toBe(true);
  });

  it.skipIf(!posix)("a base's [audit.attest] sign is not run by gnomon guard", async () => {
    const r = repo(POLICY("off"));
    const marker = join(tmp("gnomon-r7-mark-"), "SIGNED_ON_HOST");
    const config = readFileSync(join(r.root, ".gnomon", "config.toml"), "utf-8").replace(/^enabled = false$/m, "enabled = true");
    const base = evilBase(r, { "config.toml": `${config}\n[audit.attest]\nsign = "touch ${marker}"\n` });
    await guardToolCall({ cwd: r.root, base, role: "implement", call: { tool: "read", input: { path: "README.md" } } });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("seventh review — B3: a role named only in the base is held to the project's strictest floor", () => {
  it.skipIf(!posix)("[verify] for it does not run on the host", async () => {
    // Live: the default off, `implement` contained. A session ran here.
    const r = repo(POLICY("off"));
    const roles = readFileSync(join(r.root, ".gnomon", "roles.toml"), "utf-8").replace(
      /^\[roles\.implement\]$/m,
      '[roles.implement]\nexec = "docker"\nimage = "img:1"'
    );
    writeFileSync(join(r.root, ".gnomon", "roles.toml"), roles);
    r.git("commit", "-qam", "implement contained");
    recordExecFloor(loadConfig(r.root));
    // The model's base: a role of its own, with a [verify] of its own.
    const marker = join(tmp("gnomon-r7-mark-"), "RAN_ON_HOST");
    const base = evilBase(r, {
      "roles.toml": `${roles}\n[roles.evil]\nmodel = "x"\n`,
      "policy.toml": POLICY("off", { verify: `touch ${marker}` }),
    });
    change(r.root);
    const v = await withoutDocker(() => runCheck({ dir: r.root, base, role: "evil" }));
    expect(existsSync(marker)).toBe(false);
    expect(v.exec?.mode).toBe("docker");
  });
});

describe("seventh review — B4: [verify]'s network is the live surface's, held to the floor", () => {
  it.skipIf(!posix)("a base that turns the network on does not get it", async () => {
    const r = repo(POLICY("docker", { verify: "true" }));
    recordExecFloor(loadConfig(r.root));
    const base = evilBase(r, { "policy.toml": POLICY("docker", { verify: "true", network: true }) });
    change(r.root);
    const v = await withoutDocker(() => runCheck({ dir: r.root, base, role: "implement" }));
    expect(v.exec?.mode).toBe("docker");
    expect(v.exec?.network).toBe(false);
  });

  it.skipIf(!posix)("nor does a live surface that turns it on after a contained session ran with it off", async () => {
    const r = repo(POLICY("docker", { verify: "true" }));
    recordExecFloor(loadConfig(r.root));
    writeFileSync(join(r.root, ".gnomon", "policy.toml"), POLICY("docker", { verify: "true", network: true }));
    r.git("commit", "-qam", "network on");
    change(r.root);
    const v = await withoutDocker(() => runCheck({ dir: r.root, base: "HEAD", role: "implement" }));
    expect(v.exec?.network).toBe(false);
    expect((v.warnings ?? []).join("\n")).toMatch(/trust grant/);
  });
});

describe("seventh review — B5: linked worktrees' and submodules' git dirs are read-only to a container", () => {
  function argvOf(root: string): string[] {
    const line = sandboxCommand("ls", { root, exec: { mode: "docker", image: "img:1", network: false } }, "n");
    return execFileSync("/bin/sh", ["-c", `docker() { printf '%s\\n' "$@"; }\n${line}`], { encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);
  }

  it.skipIf(!posix)("a linked worktree's admin dir, and the dir holding it, are mounted", () => {
    const r = repo(POLICY("docker"));
    const wt = join(tmp("gnomon-r7-wt-"), "wt");
    r.git("worktree", "add", "-q", wt);
    const argv = argvOf(r.root);
    const admin = join(r.root, ".git", "worktrees", "wt");
    expect(argv).toContain(`${admin}:${admin}:ro`);
    const holder = join(r.root, ".git", "worktrees");
    expect(argv).toContain(`${holder}:${holder}`);
    expect(argv.indexOf(`${holder}:${holder}`)).toBeLessThan(argv.indexOf(`${admin}:${admin}:ro`));
    // The user's worktree still works.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf-8" })).toBe("");
  });

  it.skipIf(!posix)("a submodule's config, hooks, info and .git file are read-only, recursively", () => {
    const lib = repo(POLICY("off"));
    const inner = repo(POLICY("off"));
    const r = repo(POLICY("docker"));
    const sub = (cwd: string, path: string, url: string) =>
      execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", url, path], { cwd, encoding: "utf-8" });
    sub(lib.root, "deep", inner.root);
    lib.git("commit", "-qm", "inner");
    sub(r.root, "libs/a", lib.root);
    r.git("commit", "-qm", "sub");
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init", "--recursive"], { cwd: r.root });
    const argv = argvOf(r.root);
    const ro = (p: string) => argv.includes(`${p}:${p}:ro`);
    const point = (p: string) => argv.includes(`${p}:${p}`);
    const mod = join(r.root, ".git", "modules", "libs", "a");
    for (const p of ["config", "hooks", "info", "commondir", "config.worktree"]) expect(ro(join(mod, p)), p).toBe(true);
    const nested = join(mod, "modules", "deep");
    for (const p of ["config", "hooks", "info"]) expect(ro(join(nested, p)), `deep/${p}`).toBe(true);
    expect(ro(join(r.root, "libs", "a", ".git"))).toBe(true);
    for (const p of [join(r.root, ".git", "modules"), join(r.root, ".git", "modules", "libs"), mod, join(r.root, "libs"), join(r.root, "libs", "a")]) {
      expect(point(p), p).toBe(true);
    }
    // And git still reads the submodule as itself.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: join(r.root, "libs", "a"), encoding: "utf-8" })).toBe("");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: r.root, encoding: "utf-8" })).toBe("");
  });
});

describe("seventh review — L2: the tree count reads only regular files in the root", () => {
  it.skipIf(!posix)("an untracked symlink to a host file does not report its line count", () => {
    const r = repo(POLICY("off"));
    const host = join(tmp("gnomon-r7-host-"), "secret.txt");
    writeFileSync(host, "1\n2\n3\n4\n5\n6\n7\n");
    symlinkSync(host, join(r.root, "leak.txt"));
    const d = measureTreeDelta(r.root);
    expect(d.insertions).toBe(0);
  });
});

describe("seventh review — L3: only loopback is local for a key", () => {
  it("a key sent to a LAN, tailnet or .local host is a grant", () => {
    const root = tmp("gnomon-r7-key-");
    cpSync(REPO_SURFACE, join(root, ".gnomon"), { recursive: true });
    const base = readFileSync(join(root, ".gnomon", "config.toml"), "utf-8");
    for (const host of ["10.0.0.5", "172.20.0.1", "100.100.1.1", "box.local", "192.168.1.9"]) {
      writeFileSync(join(root, ".gnomon", "config.toml"), `${base}\n[endpoints.lan]\nurl = "http://${host}:8080/v1"\napi_key_env = "OPENAI_API_KEY"\n`);
      const keys = surfaceGrants(loadConfig(root)).map((g) => g.key);
      expect(keys.some((k) => k.startsWith("key:") && k.includes(host)), host).toBe(true);
    }
    writeFileSync(join(root, ".gnomon", "config.toml"), `${base}\n[endpoints.lan]\nurl = "http://127.0.0.1:8080/v1"\napi_key_env = "OPENAI_API_KEY"\n`);
    expect(surfaceGrants(loadConfig(root)).some((g) => g.key.includes("127.0.0.1"))).toBe(false);
  });
});

describe("seventh review — L4: the archive listing the write precheck runs is bounded", () => {
  it.skipIf(!posix)("a FIFO named as the archive does not hold the precheck for the listing deadline", async () => {
    const root = tmp("gnomon-r7-tar-");
    execFileSync("mkfifo", [join(root, "evil.tar")]);
    const ctx: ToolContext = {
      root,
      sandbox: "confined",
      writeAllow: ["docs/**"],
      gate: "never",
      approve: async () => true,
      timeoutMs: 20_000,
      maxOutputBytes: 32_000,
      allow: "strict",
    };
    const t0 = Date.now();
    const out = await executeTool("bash", { command: "tar -xf evil.tar -C src" }, ctx, new Set(["bash"]));
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(out.content).toMatch(/Refused/);
  }, 20_000);
});

describe("seventh review — B5 under exec = \"os\": the Linux snapshot covers the same git dirs", () => {
  it.skipIf(!posix)("a linked worktree's commondir and a submodule's config are put back; the user's index and the command's own worktree are not touched", () => {
    const lib = repo(POLICY("off"));
    const r = repo(POLICY("os"));
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.root, "libs/a"], { cwd: r.root });
    r.git("commit", "-qm", "sub");
    const wt = join(tmp("gnomon-r7-wt-"), "wt");
    r.git("worktree", "add", "-q", wt);
    const admin = join(r.root, ".git", "worktrees", "wt");
    const subConfig = join(r.root, ".git", "modules", "libs", "a", "config");
    const before = { commondir: readFileSync(join(admin, "commondir"), "utf-8"), sub: readFileSync(subConfig, "utf-8") };
    const snap = snapshotProtected(r.root);
    // While the command runs the user works in their worktree (its index),
    // and the command adds a worktree of its own...
    writeFileSync(join(wt, "new.txt"), "x\n");
    execFileSync("git", ["add", "new.txt"], { cwd: wt });
    const index = readFileSync(join(admin, "index"));
    r.git("worktree", "add", "-q", join(r.root, "own"));
    // ...then redirects the user's worktree and plants an fsmonitor in the submodule.
    writeFileSync(join(admin, "commondir"), "/tmp/evil\n");
    writeFileSync(subConfig, `${before.sub}[core]\n\tfsmonitor = touch /tmp/pwned\n`);
    const out = restoreProtected(snap);
    expect(readFileSync(join(admin, "commondir"), "utf-8")).toBe(before.commondir);
    expect(readFileSync(subConfig, "utf-8")).toBe(before.sub);
    expect(out.restored.length).toBeGreaterThan(0);
    expect(readFileSync(join(admin, "index")).equals(index)).toBe(true);
    expect(existsSync(join(r.root, ".git", "worktrees", "own", "commondir"))).toBe(true);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: join(r.root, "own"), encoding: "utf-8" })).toBe("");
  });
});

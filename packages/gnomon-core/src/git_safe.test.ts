/**
 * PR #156 second review, finding A: a sandboxed command writes the
 * repository's git config (core.fsmonitor, a filter driver), and gnomon's own
 * per-turn git -- on the HOST -- runs what it names. Reproduced against
 * v0.4.3's exec = "docker" too: the container bind-mounts the root, so it can
 * write .git/config, and measureTreeDelta's `git status` ran the program
 * outside the container.
 *
 * Every test plants the config in a fresh repository, runs gnomon's real
 * bookkeeping (measureTreeDelta, the per-command stamp, safeGit), and asserts
 * on a marker file the planted program would create. Each is paired with a
 * CONTROL: plain `git status` in the same repository, which must create the
 * marker -- so the planted config is live and the test could have failed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, appendFileSync, utimesSync, readFileSync, statSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { safeGit, hardenGitArgs, _resetGitSafety, gitHardenedEnv } from "./git_safe.js";
import { measureTreeDelta, treeSnapshot } from "./prompt_loop.js";

const onWindows = process.platform === "win32";

let repo: string;
let outside: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "ignore" });

beforeEach(() => {
  _resetGitSafety();
  repo = mkdtempSync(join(tmpdir(), "gnomon-gitsafe-repo-"));
  outside = mkdtempSync(join(tmpdir(), "gnomon-gitsafe-out-"));
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(() => {
  _resetGitSafety();
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** What a contained command can do: append to .git/config, write .gitattributes, touch a file. */
function plant(kind: "fsmonitor" | "filter" | "hook"): string {
  const marker = join(outside, `${kind}-ran`);
  if (kind === "fsmonitor") {
    appendFileSync(join(repo, ".git", "config"), `[core]\n\tfsmonitor = "touch '${marker}'; false"\n`);
  } else if (kind === "filter") {
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil\n");
    appendFileSync(join(repo, ".git", "config"), `[filter "evil"]\n\tclean = "touch '${marker}'; cat"\n\tprocess = "touch '${marker}'"\n`);
  } else {
    // post-index-change fires on a status that refreshes the index.
    writeFileSync(join(repo, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  }
  // A changed tracked file whose stat no longer matches the index: status and
  // diff must re-read it, which is when a clean filter runs.
  writeFileSync(join(repo, "a.txt"), "two\n");
  const t = new Date(Date.now() + 5000);
  utimesSync(join(repo, "a.txt"), t, t);
  return marker;
}

describe.skipIf(onWindows)("finding A — gnomon's own git runs nothing the repository names", () => {
  for (const kind of ["fsmonitor", "filter", "hook"] as const) {
    it(`${kind}: the control runs it; measureTreeDelta and safeGit do not`, () => {
      const marker = plant(kind);
      // No contained command has run in THIS process: the config was planted
      // by one in an earlier session (finding 3).
      const base = treeSnapshot(repo);
      const d = measureTreeDelta(repo, base);
      expect(d.unavailable).toBeUndefined();
      safeGit(["status", "--porcelain=v2"], { cwd: repo });
      safeGit(["diff", "--numstat", "HEAD"], { cwd: repo });
      expect(existsSync(marker), `${kind} ran from gnomon's bookkeeping`).toBe(false);

      // CONTROL: the same repository, plain git. The planted program is live.
      // A fresh stat first: gnomon's own status may already have refreshed
      // the index, and post-index-change fires only on a status that does.
      const t2 = new Date(Date.now() + 10000);
      utimesSync(join(repo, "a.txt"), t2, t2);
      spawnSync("git", ["status"], { cwd: repo, stdio: "ignore" });
      spawnSync("git", ["diff", "HEAD"], { cwd: repo, stdio: "ignore" });
      // An add always writes the index, so post-index-change always fires.
      if (kind === "hook") spawnSync("git", ["add", "a.txt"], { cwd: repo, stdio: "ignore" });
      expect(existsSync(marker), `control: ${kind} did not run under plain git, so this test proves nothing`).toBe(true);
    });
  }

  it("a filter named with characters `-c k=v` cannot spell is still blanked", () => {
    const marker = join(outside, "odd-ran");
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=a=b.c\n");
    appendFileSync(join(repo, ".git", "config"), `[filter "a=b.c"]\n\tclean = "touch '${marker}'; cat"\n`);
    writeFileSync(join(repo, "a.txt"), "three\n");
    const r = safeGit(["diff", "--numstat"], { cwd: repo });
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    spawnSync("git", ["diff"], { cwd: repo, stdio: "ignore" });
    expect(existsSync(marker), "control").toBe(true);
  });

  it("a driver added after a listing was cached is still blanked", () => {
    // The listing is cached per config state; an append changes the state.
    expect(safeGit(["diff", "--numstat"], { cwd: repo }).status).toBe(0);
    const marker = join(outside, "late-ran");
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=late\n");
    appendFileSync(join(repo, ".git", "config"), `[filter "late"]\n\tclean = "touch '${marker}'; cat"\n`);
    writeFileSync(join(repo, "a.txt"), "four\n");
    expect(safeGit(["diff", "--numstat"], { cwd: repo }).status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    spawnSync("git", ["diff"], { cwd: repo, stdio: "ignore" });
    expect(existsSync(marker), "control").toBe(true);
  });

  it("a driver defined later in an INCLUDED file is still blanked (no stale cached listing)", () => {
    // The cache key holds .git/config's stat, not an include target's: a
    // repository that includes anything is never cached.
    appendFileSync(join(repo, ".git", "config"), `[include]\n\tpath = inc.cfg\n`);
    expect(safeGit(["diff", "--numstat"], { cwd: repo }).status).toBe(0);
    const marker = join(outside, "inc-ran");
    writeFileSync(join(repo, ".git", "inc.cfg"), `[filter "inc"]\n\tclean = "touch '${marker}'; cat"\n`);
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=inc\n");
    writeFileSync(join(repo, "a.txt"), "five\n");
    expect(safeGit(["diff", "--numstat"], { cwd: repo }).status).toBe(0);
    expect(existsSync(marker), "a driver from an include target ran").toBe(false);
    spawnSync("git", ["diff"], { cwd: repo, stdio: "ignore" });
    expect(existsSync(marker), "control").toBe(true);
  });

  it("a same-size in-place rewrite of .git/config with its mtime restored still re-lists", () => {
    const cfg = join(repo, ".git", "config");
    const marker = join(outside, "forged-ran");
    const def = `[filter "f"]\n\tclean = "touch '${marker}'; cat"\n`;
    const before = readFileSync(cfg, "utf8");
    // Same length as the definition planted later: a comment.
    writeFileSync(cfg, before + "#" + "x".repeat(def.length - 2) + "\n");
    // A whole-second mtime, which utimes can restore exactly.
    const t = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(cfg, t, t);
    expect(safeGit(["diff", "--numstat"], { cwd: repo }).status).toBe(0);
    const st = statSync(cfg);
    writeFileSync(cfg, before + def);
    utimesSync(cfg, t, t);
    expect(statSync(cfg).size).toBe(st.size);
    expect(statSync(cfg).mtimeMs).toBe(st.mtimeMs);
    expect(statSync(cfg).ino).toBe(st.ino);
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=f\n");
    writeFileSync(join(repo, "a.txt"), "six\n");
    expect(safeGit(["diff", "--numstat"], { cwd: repo }).status).toBe(0);
    expect(existsSync(marker), "a driver behind a forged signature ran").toBe(false);
    spawnSync("git", ["diff"], { cwd: repo, stdio: "ignore" });
    expect(existsSync(marker), "control").toBe(true);
  });

  it("a `commondir` written after a listing was cached is followed (third review, finding 2)", () => {
    // .git/config never changes: git reads <commondir>/config instead.
    expect(safeGit(["diff", "--numstat"], { cwd: repo }).status).toBe(0);
    const common = join(outside, "common");
    cpSync(join(repo, ".git"), common, { recursive: true });
    const marker = join(outside, "commondir-ran");
    appendFileSync(join(common, "config"), `[filter "cd"]\n\tclean = "touch '${marker}'; cat"\n`);
    writeFileSync(join(repo, ".git", "commondir"), `${common}\n`);
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=cd\n");
    writeFileSync(join(repo, "a.txt"), "seven\n");
    expect(safeGit(["diff", "--numstat"], { cwd: repo }).status).toBe(0);
    expect(existsSync(marker), "a driver behind a commondir redirect ran from a cached listing").toBe(false);
    spawnSync("git", ["diff"], { cwd: repo, stdio: "ignore" });
    expect(existsSync(marker), "control").toBe(true);
  });

  it("a linked worktree: a driver added to the main repository's config after caching is blanked", () => {
    const wt = join(outside, "wt");
    git("worktree", "add", "-q", wt);
    expect(safeGit(["diff", "--numstat"], { cwd: wt }).status).toBe(0);
    const marker = join(outside, "wt-ran");
    appendFileSync(join(repo, ".git", "config"), `[filter "w"]\n\tclean = "touch '${marker}'; cat"\n`);
    writeFileSync(join(wt, ".gitattributes"), "*.txt filter=w\n");
    writeFileSync(join(wt, "a.txt"), "eight\n");
    expect(safeGit(["diff", "--numstat"], { cwd: wt }).status).toBe(0);
    expect(existsSync(marker), "a driver in the shared config ran in the worktree").toBe(false);
    spawnSync("git", ["diff"], { cwd: wt, stdio: "ignore" });
    expect(existsSync(marker), "control").toBe(true);
  });

  it("a hot rev-parse skips the listing; a hot status does not", () => {
    const marker = plant("filter");
    expect(safeGit(["rev-parse", "HEAD"], { cwd: repo, hot: true }).status).toBe(0);
    expect(safeGit(["status", "--porcelain"], { cwd: repo, hot: true }).status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("blanks the program-naming keys and drops partial-repository redirections (finding 6)", () => {
    const a = hardenGitArgs(["status"]);
    for (const kv of [
      "core.sshCommand=", "core.gitProxy=", "commit.gpgSign=false", "tag.gpgSign=false", "gpg.program=",
      "core.editor=:", "sequence.editor=:", "core.alternateRefsCommand=",
    ]) {
      expect(a, kv).toContain(kv);
    }
    const env = gitHardenedEnv({
      PATH: "/bin", GIT_INDEX_FILE: "/x/index", GIT_COMMON_DIR: "/x", GIT_OBJECT_DIRECTORY: "/x/o",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/x/a", GIT_CONFIG_SYSTEM: "/x/c",
    });
    for (const k of ["GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_SYSTEM"]) {
      expect(env[k], k).toBeUndefined();
    }
  });

  it("puts the hardening before the subcommand and the driver flags after it", () => {
    const a = hardenGitArgs(["-C", "/x", "--no-optional-locks", "diff", "--numstat", "HEAD"]);
    expect(a.slice(0, 4)).toEqual(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]);
    const i = a.indexOf("diff");
    expect(a.slice(i, i + 5)).toEqual(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--numstat"]);
    const s = hardenGitArgs(["status", "--porcelain", "--", "x"]);
    expect(s.slice(s.indexOf("status"))).toEqual(["status", "--ignore-submodules=all", "--porcelain", "--", "x"]);
    expect(hardenGitArgs(["rev-parse", "HEAD"]).slice(-2)).toEqual(["rev-parse", "HEAD"]);
  });

  it("measures the same tree as plain git where nothing is planted", () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    const d = measureTreeDelta(repo);
    expect(d.files).toBe(2);
    expect(d.insertions).toBe(2);
  });
});

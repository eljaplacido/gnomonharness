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
import { mkdtempSync, writeFileSync, rmSync, existsSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { safeGit, hardenGitArgs, markGitContained, _resetGitSafety } from "./git_safe.js";
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
      // A contained command (docker / os) has run in this process.
      markGitContained();
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
    markGitContained();
    const d = measureTreeDelta(repo);
    expect(d.files).toBe(2);
    expect(d.insertions).toBe(2);
  });
});

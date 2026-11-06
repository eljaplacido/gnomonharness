/**
 * The eighth review's reproduction: must-fail-first's pre-images came from
 * `git diff --name-status <from>` unchecked, so a base commit whose TREE holds
 * `.git/config` (and a rewritten `.gnomon/policy.toml`) had host gnomon write
 * the planted config into the real `.git/config` -- and the base's surface
 * over the live one -- for the length of the re-run. A SIGKILL in that window
 * left both planted, and the user's own next `git status` ran the fsmonitor.
 *
 * Threat as before: exec = "docker" (or "os"), the model's container writes
 * `.git/objects` and `.git/refs`, the model is hostile. Each case fails on
 * 7f4718582 and passes after.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCheck } from "./check.js";
import { mustFailFirst } from "./must_fail_first.js";
import { writeFileIn, RootWriteError } from "./root_fs.js";
import { _resetGitSafety } from "./git_safe.js";
import { enqueueAnchor, pendingAnchors, type ResolvedAnchor } from "./anchor.js";
import type { AuditRecord } from "./audit.js";

const REPO_SURFACE = resolve(process.cwd(), "..", "..", ".gnomon");
const posix = process.platform !== "win32";

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

const POLICY = (verify: string, extra = "") =>
  `${extra}[approval]\ngate = "on_write"\n\n[sandbox]\nlevel = "confined"\nnetwork = false\nexec = "off"\n\n` +
  `[verify]\ncommand = "${verify}"\ntest_paths = ["tests/**"]\ntest_must_fail_first = true\n`;

describe("eighth review — must-fail-first never writes .git/ or the surface", () => {
  it.skipIf(!posix)("gnomon check --base <a tree holding .git/config> writes neither .git/config nor .gnomon/", async () => {
    // What the [verify] command sees in the re-run window, recorded outside the repo
    // (the pattern is bracketed so the command, in the live policy, does not match itself).
    const seen = join(tmp("gnomon-r8-seen-"), "seen");
    const verify =
      `grep -q PLANT[E]D .git/config && echo git >> ${seen}; grep -q PLANT[E]D .gnomon/policy.toml && echo surface >> ${seen}; true`;

    const root = tmp("gnomon-r8-");
    cpSync(REPO_SURFACE, join(root, ".gnomon"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "policy.toml"), POLICY(verify));
    const git = (args: string[], input?: string) =>
      execFileSync("git", args, { cwd: root, encoding: "utf-8", ...(input !== undefined ? { input } : {}) }).trim();
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.invalid"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "surface"]);
    const realConfig = readFileSync(join(root, ".git", "config"), "utf-8");

    // The model's commit E: HEAD's tree, a rewritten .gnomon/policy.toml, and
    // a `.git/config` entry naming an fsmonitor. HEAD (master) moved to it.
    const policyBlob = git(["hash-object", "-w", "--stdin"], POLICY(verify, "# PLANTED\n"));
    const cfgBlob = git(["hash-object", "-w", "--stdin"], `[core]\n\tfsmonitor = touch /nonexistent # PLANTED\n`);
    const surface = git(["ls-tree", "HEAD:.gnomon"])
      .split("\n")
      .map((l) => (l.endsWith("\tpolicy.toml") ? `100644 blob ${policyBlob}\tpolicy.toml` : l))
      .join("\n");
    const surfaceTree = git(["mktree"], `${surface}\n`);
    const gitTree = git(["mktree"], `100644 blob ${cfgBlob}\tconfig\n`);
    const top = git(["mktree"], `040000 tree ${surfaceTree}\t.gnomon\n040000 tree ${gitTree}\t.git\n`);
    const e = git(["commit-tree", top, "-p", "HEAD", "-m", "evil"]);
    git(["update-ref", "refs/heads/master", e]);
    git(["symbolic-ref", "HEAD", "refs/heads/master"]);

    // The change under judgement: a source and a test.
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "tests", "a.test.ts"), "a\n");

    const v = await runCheck({ dir: root, base: "master", role: "implement" });

    expect(existsSync(seen) ? readFileSync(seen, "utf-8") : "").toBe("");
    expect(readFileSync(join(root, ".git", "config"), "utf-8")).toBe(realConfig);
    expect(readFileSync(join(root, ".gnomon", "policy.toml"), "utf-8")).not.toMatch(/PLANTED/);
    const said = [...(v.warnings ?? []), ...v.checks.map((c) => c.reason ?? "")].join("\n");
    expect(said).toMatch(/\.git\/config/);
    expect(said).toMatch(/\.gnomon\/policy\.toml/);
  });

  it.skipIf(!posix)("mustFailFirst refuses a .git/ or .gnomon/ pre-image, and writes nothing", async () => {
    const root = tmp("gnomon-r8-mff-");
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".gnomon"));
    mkdirSync(join(root, "sub", ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "real\n");
    writeFileSync(join(root, ".gnomon", "policy.toml"), "real\n");
    writeFileSync(join(root, "sub", ".git", "HEAD"), "real\n");
    for (const bad of [".git/config", ".gnomon/policy.toml", "sub/.git/HEAD", ".gnomon-audit/x.jsonl"]) {
      let ran = 0;
      const pre = new Map<string, string | null>([
        [join(root, "tests", "a.test.ts"), ""],
        [join(root, ...bad.split("/")), "PLANTED\n"],
      ]);
      const r = await mustFailFirst(root, { command: "true", test_paths: ["tests/**"] }, pre, async () => {
        ran++;
        return { code: 0, summary: "bash — exit 0" };
      });
      expect(r.ran).toBe(false);
      expect(r.reason).toContain(bad);
      expect(ran).toBe(0);
    }
    expect(readFileSync(join(root, ".git", "config"), "utf-8")).toBe("real\n");
    expect(readFileSync(join(root, ".gnomon", "policy.toml"), "utf-8")).toBe("real\n");
    expect(readFileSync(join(root, "sub", ".git", "HEAD"), "utf-8")).toBe("real\n");
    expect(existsSync(join(root, ".gnomon-audit"))).toBe(false);
  });

  it("writeFileIn refuses a target outside the root instead of writing it unchecked", () => {
    const root = tmp("gnomon-r8-root-");
    const outside = join(tmp("gnomon-r8-out-"), "x");
    expect(() => writeFileIn(root, outside, "x")).toThrow(RootWriteError);
    expect(existsSync(outside)).toBe(false);
  });

  it("an absolute [audit] dir outside the root still takes its anchor queue (writeFileIn's caller names that dir)", () => {
    const root = tmp("gnomon-r8-proj-");
    const dir = join(tmp("gnomon-r8-audit-"), "anchors");
    const settings = {
      enabled: true,
      declared: true,
      backend: "command",
      root,
      dir,
      scope: "s",
      remote: null,
      ref: "refs/heads/anchors",
      url: null,
      tsa_cert: null,
      command: null,
      verify: null,
      timeout_sec: 5,
      problems: [],
    } as unknown as ResolvedAnchor;
    const sealing = { seq: 1, hash: "h", ts: new Date(0).toISOString() } as unknown as AuditRecord;
    enqueueAnchor(settings, join(root, ".gnomon-audit", "t.jsonl"), sealing, 1);
    expect(pendingAnchors(settings)).toHaveLength(1);
  });
});

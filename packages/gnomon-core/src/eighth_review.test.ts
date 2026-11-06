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
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCheck } from "./check.js";
import { mustFailFirst, unwritablePreImage } from "./must_fail_first.js";
import { writeFileIn, RootWriteError } from "./root_fs.js";
import { _resetGitSafety } from "./git_safe.js";
import { enqueueAnchor, pendingAnchors, type ResolvedAnchor } from "./anchor.js";
import type { AuditRecord } from "./audit.js";
import { loadConfig } from "./config.js";
import { compareWithCheckpoint, resolveTamper, unresolvedTamper, writeCheckpoint } from "./record_tamper.js";
import { acceptSkill, proposeSkill, RecordTamperRefusal } from "./skills.js";
import { setDecisionContextProbe } from "./agent_context.js";
import { readdirSync } from "node:fs";

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

describe("ninth review", () => {
  it("refuses Windows short names and HFS-ignorable spellings of .git and gnomon's dirs", async () => {
    for (const bad of ["GNOMON~1/policy.toml", "git~1/config", "sub/GNOMON~2./x", ".g\u200cit/config", ".gno\u200dmon/policy.toml", "\ufeff.GIT/HEAD"]) {
      expect(unwritablePreImage(bad), bad).not.toBeNull();
    }
    expect(unwritablePreImage("src/a.ts")).toBeNull();
    const root = tmp("gnomon-r9-mff-");
    for (const bad of ["GNOMON~1/policy.toml", ".g\u200cit/config"]) {
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
    expect(readdirSync(root)).toEqual([]);
  });

  it("the live custom [audit] dir is refused under any case or trailing-dot spelling", () => {
    expect(unwritablePreImage("My-Audit/t.jsonl", ["my-audit"])).toMatch(/gnomon's own my-audit/);
    expect(unwritablePreImage("var/TRAIL./t.jsonl", ["var/trail"])).toMatch(/gnomon's own/);
    expect(unwritablePreImage("var/other/t.jsonl", ["var/trail"])).toBeNull();
  });

  it.skipIf(!posix)("gnomon check does not take a case variant of the custom [audit] dir as a pre-image", async () => {
    const seen = join(tmp("gnomon-r9-seen-"), "seen");
    const verify = `test -e My-Audit/t.jsonl || echo gone >> ${seen}; true`;
    const root = tmp("gnomon-r9-");
    cpSync(REPO_SURFACE, join(root, ".gnomon"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "policy.toml"), POLICY(verify));
    const cfg = join(root, ".gnomon", "config.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf-8").replace('dir = ".gnomon-audit"', 'dir = "my-audit"'));
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.invalid"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "surface"]);
    for (const [rel, text] of [
      ["src/a.ts", "export const a = 1;\n"],
      ["tests/a.test.ts", "a\n"],
      ["My-Audit/t.jsonl", "{}\n"],
    ] as const) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const v = await runCheck({ dir: root, base: "HEAD", role: "implement" });
    expect(existsSync(seen) ? readFileSync(seen, "utf-8") : "").toBe("");
    expect(readFileSync(join(root, "My-Audit", "t.jsonl"), "utf-8")).toBe("{}\n");
    expect((v.warnings ?? []).join("\n")).toMatch(/My-Audit\/t\.jsonl/);
  });

  describe("an absolute [audit] dir outside the project", () => {
    beforeEach(() => setDecisionContextProbe(() => ({ agent: null, interactive: true })));
    afterEach(() => setDecisionContextProbe(null));
    let marker: string | undefined;
    beforeEach(() => {
      marker = process.env.GNOMON_AGENT_SESSION;
      delete process.env.GNOMON_AGENT_SESSION;
    });
    afterEach(() => {
      if (marker === undefined) delete process.env.GNOMON_AGENT_SESSION;
      else process.env.GNOMON_AGENT_SESSION = marker;
    });

    it("takes the checkpoint, the skill-accept tamper record and the resolution", () => {
      const root = tmp("gnomon-r9-proj-");
      const audit = join(tmp("gnomon-r9-audit-"), "trail");
      const put = (rel: string, text: string) => {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), text, "utf-8");
      };
      put(
        ".gnomon/config.toml",
        `[defaults]\napproval = "on_write"\n\n[endpoints.local]\nurl = "http://127.0.0.1:9/api/chat"\nkind = "ollama"\n\n` +
          `[audit]\nenabled = true\ndir = ${JSON.stringify(audit)}\n`
      );
      put(".gnomon/roles.toml", `[roles.implement]\nmodel = "stub"\nendpoint = "local"\ntools = ['read']\n`);
      put(".gnomon/tools.toml", `[[tools]]\nname = "read"\nenabled = true\n`);
      put(".gnomon/policy.toml", `[approval]\ngate = "on_write"\n`);
      put(".gnomon/system.md", "x\n");
      const config = loadConfig(root);
      proposeSkill(config, { name: "fix it", body: "x" });

      // The session-end checkpoint: written into the outside dir.
      expect(writeCheckpoint(config)).not.toBeNull();
      expect(readdirSync(join(audit, "checkpoints")).some((f) => f.endsWith(".files.json"))).toBe(true);

      // A change between sessions: accept records it, checkpoints, and refuses.
      writeFileSync(join(audit, "forged.jsonl"), "{}\n");
      expect(compareWithCheckpoint(config)?.changes.length).toBeGreaterThan(0);
      expect(() => acceptSkill(config, "fix-it")).toThrow(RecordTamperRefusal);

      // The person resolves it (which checkpoints again), and accept goes through.
      const open = unresolvedTamper(config);
      expect(open).toHaveLength(1);
      resolveTamper(config, { trail: open[0]!.trail, seq: open[0]!.seq }, "reviewed: a test", { interactive: true });
      expect(unresolvedTamper(config)).toEqual([]);
      expect(acceptSkill(config, "fix-it").record?.kind).toBe("skill_accept");
      expect(existsSync(join(root, ".gnomon-audit"))).toBe(false);
    });
  });
});

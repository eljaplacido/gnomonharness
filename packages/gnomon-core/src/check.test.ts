/**
 * `gnomon check`: one fixture repository per way a foreign change can fail,
 * plus the ways the command must refuse to give a verdict at all.
 *
 * Every repository here is real git, and every [verify] is a real shell
 * command — the point of the command is that it reads nothing but the
 * repository, so a fake of either would test something else.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runCheck, checkExit, type CheckVerdict } from "./check.js";
import { resolveCheckRole } from "./guard.js";
import { verifyTrail, recordHash, type AuditRecord } from "./audit.js";
import { loadConfig } from "./config.js";
import { replay } from "./replay.js";

let repo: string;
const sh = (args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const commit = (msg: string) => {
  sh(["add", "-A"]);
  sh(["commit", "-q", "-m", msg]);
  return sh(["rev-parse", "HEAD"]);
};

interface SurfaceOpts {
  verify?: string | null;
  mff?: boolean;
  audit?: boolean;
  checkRoles?: Record<string, string>;
}

/** A minimal surface: one role that may write src/ and tests/, and a suite. */
function surface(o: SurfaceOpts = {}): void {
  put(
    ".gnomon/roles.toml",
    `[roles.implement]\nmodel = "m"\nwrite_allow = ["src/**", "tests/**"]\n\n[roles.plan]\nmodel = "m"\n`
  );
  const verify = o.verify === undefined ? "sh run_tests.sh" : o.verify;
  let policy = "";
  if (verify) {
    policy += `[verify]\ncommand = "${verify}"\ntest_paths = ["tests/**"]\n`;
    if (o.mff !== false) policy += `test_must_fail_first = true\n`;
  }
  if (o.checkRoles) {
    policy += `\n[check.roles]\n`;
    for (const [k, v] of Object.entries(o.checkRoles)) policy += `${k} = "${v}"\n`;
  }
  put(".gnomon/policy.toml", policy);
  put(".gnomon/config.toml", o.audit === undefined ? "" : `[audit]\nenabled = ${o.audit}\n`);
  // Every tests/*.sh must exit 0.
  put("run_tests.sh", 'for t in tests/*.sh; do [ -e "$t" ] || continue; sh "$t" || exit 1; done\n');
  put("src/pay.txt", "1\n");
}

beforeEach(() => {
  // Canonical, as runCheck makes it: macOS tmpdir is a symlink and Windows
  // hands out 8.3 short names, and the verdict reports real paths.
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-check-")));
  sh(["init", "-q"]);
  sh(["config", "user.email", "t@example.invalid"]);
  sh(["config", "user.name", "t"]);
  sh(["config", "commit.gpgsign", "false"]);
  // Git for Windows checks out CRLF by default, and a temporary worktree is a
  // fresh checkout: the fixture bytes must be the bytes the test wrote.
  sh(["config", "core.autocrlf", "false"]);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const byId = (v: CheckVerdict, id: string) => v.checks.find((c) => c.id === id);

describe("gnomon check — a check that fails", () => {
  it("write_allow: a path outside the role's list fails, and says which", async () => {
    surface();
    const base = commit("base");
    put("src/pay.txt", "2\n");
    put("infra/.env", "SECRET=1\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(v.exit).toBe(2);
    expect(byId(v, "write_allow")).toMatchObject({
      status: "fail",
      inspected: 2,
      findings: [{ path: "infra/.env", change: "A", rule: "write_allow", listed: "src/**, tests/**" }],
    });
  });

  it("surface: an edit to .gnomon/ fails, and the rules are base's, not the edited ones", async () => {
    surface();
    const base = commit("base");
    // The change widens its own write_allow and writes outside the old one.
    put(".gnomon/roles.toml", `[roles.implement]\nmodel = "m"\nwrite_allow = ["**"]\n`);
    put("docs/x.md", "x\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(v.exit).toBe(2);
    expect(byId(v, "surface")?.status).toBe("fail");
    expect(byId(v, "surface")?.findings?.[0]).toMatchObject({ path: ".gnomon/roles.toml", rule: "surface" });
    // Judged by the base write_allow: the widened one would have let docs/ through.
    const wa = byId(v, "write_allow")!;
    expect(wa.findings!.map((f) => f.path)).toEqual([".gnomon/roles.toml", "docs/x.md"]);
  });

  it("verify: a suite that fails on head fails the check", async () => {
    surface();
    const base = commit("base");
    put("tests/pay.sh", "grep -qx 2 src/pay.txt\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(v.exit).toBe(2);
    expect(byId(v, "verify")).toMatchObject({ status: "fail", findings: [{ command: "sh run_tests.sh", exit: 1 }] });
    expect(byId(v, "must_fail_first")).toMatchObject({ status: "skipped" });
  });

  it("must_fail_first: a new test that passes on base sources pins nothing", async () => {
    surface();
    const base = commit("base");
    put("src/pay.txt", "1\n\n"); // a change that changes nothing the test reads
    put("tests/pay.sh", "grep -qx 1 src/pay.txt\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(v.exit).toBe(2);
    expect(byId(v, "must_fail_first")).toMatchObject({
      status: "fail",
      findings: [{ test: "tests/pay.sh", detail: "passes against base sources — pins nothing" }],
    });
    // The worktree is exactly as the agent left it.
    expect(readFileSync(join(repo, "src/pay.txt"), "utf-8")).toBe("1\n\n");
  });

  it("must_fail_first: a test that fails on base and passes on head holds", async () => {
    surface();
    const base = commit("base");
    put("src/pay.txt", "2\n");
    put("tests/pay.sh", "grep -qx 2 src/pay.txt\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(byId(v, "must_fail_first")).toMatchObject({ status: "pass", inspected: 1 });
    expect(v.exit).toBe(0);
    expect(readFileSync(join(repo, "src/pay.txt"), "utf-8")).toBe("2\n");
  });

  it("must_fail_first: no test in the change is skipped, never passed", async () => {
    surface();
    const base = commit("base");
    put("src/pay.txt", "2\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(byId(v, "must_fail_first")).toEqual({
      id: "must_fail_first",
      status: "skipped",
      reason: "the change touched no test",
    });
    expect(v.exit).toBe(0);
  });
});

describe("gnomon check — no verdict (exit 10)", () => {
  it("a change with no paths inspected nothing", async () => {
    surface();
    const base = commit("base");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(v.exit).toBe(10);
    expect(v.error).toMatch(/nothing to judge/);
    expect(v.checks).toEqual([]);
  });

  it("no [verify] declared is could-not-run, not a pass", async () => {
    surface({ verify: null });
    const base = commit("base");
    put("src/pay.txt", "2\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(byId(v, "verify")?.status).toBe("error");
    expect(v.exit).toBe(10);
  });

  it("a verify command that is not found is could-not-run", async () => {
    surface({ verify: "no-such-command-anywhere" });
    const base = commit("base");
    put("src/pay.txt", "2\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(byId(v, "verify")?.status).toBe("error");
    expect(v.exit).toBe(10);
  });

  it("a base with no surface has no rules to judge by", async () => {
    put("src/pay.txt", "1\n");
    const base = commit("base");
    surface();
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(v.exit).toBe(10);
    expect(v.error).toMatch(/no \.gnomon\/.*must predate it/);
  });

  it("an unknown base revision", async () => {
    surface();
    commit("base");
    const v = await runCheck({ dir: repo, base: "no-such-rev", role: "implement" });
    expect(v.exit).toBe(10);
    expect(v.error).toMatch(/git rev-parse/);
  });

  it("checkExit: fail beats error, and skips plus an audit pass are not a verdict", () => {
    expect(checkExit([{ id: "verify", status: "error" }, { id: "surface", status: "fail" }])).toBe(2);
    expect(checkExit([{ id: "verify", status: "error" }, { id: "surface", status: "pass" }])).toBe(10);
    expect(checkExit([{ id: "write_allow", status: "skipped" }, { id: "audit", status: "pass" }])).toBe(10);
    expect(checkExit([{ id: "surface", status: "pass" }, { id: "bash_allow", status: "skipped" }])).toBe(0);
  });
});

describe("gnomon check — role resolution", () => {
  it("--role wins over --agent and the table", async () => {
    surface({ checkRoles: { "frontend-developer": "implement" } });
    commit("base");
    const config = loadConfig(repo);
    expect(resolveCheckRole(config, { role: "plan", agent: "frontend-developer" })).toEqual({ role: "plan", source: "--role" });
  });

  it("--agent maps through [check.roles] in the base surface", () => {
    surface({ checkRoles: { "frontend-developer": "implement" } });
    const config = loadConfig(repo);
    expect(resolveCheckRole(config, { agent: "frontend-developer" })).toEqual({
      role: "implement",
      source: "[check.roles] frontend-developer",
    });
  });

  it("refuses to guess: no role, an unmapped agent, a role that is not declared", () => {
    surface({ checkRoles: { ghost: "nonexistent" } });
    const config = loadConfig(repo);
    expect(resolveCheckRole(config, {})).toMatchObject({ error: expect.stringMatching(/never guessed/) });
    expect(resolveCheckRole(config, { agent: "other" })).toMatchObject({ error: expect.stringMatching(/no entry in \[check\.roles\]/) });
    expect(resolveCheckRole(config, { agent: "ghost" })).toMatchObject({ error: expect.stringMatching(/not a role/) });
    expect(resolveCheckRole(config, { role: "nope" })).toMatchObject({ error: expect.stringMatching(/not a role/) });
  });

  it("an unresolvable role is exit 10 end to end, and the table is read from base", async () => {
    surface();
    const base = commit("base");
    // The change adds its own mapping. It must not count.
    put(".gnomon/policy.toml", readFileSync(join(repo, ".gnomon/policy.toml"), "utf-8") + `\n[check.roles]\nsneaky = "implement"\n`);
    const v = await runCheck({ dir: repo, base, agent: "sneaky" });
    expect(v.exit).toBe(10);
    expect(v.role).toBeNull();
  });
});

describe("gnomon check — the verdict on the trail", () => {
  it("is appended even with [audit] off, verifies, and the JSON names its hash", async () => {
    surface({ audit: false });
    const base = commit("base");
    put("src/pay.txt", "2\n");
    const v = await runCheck({ dir: repo, base, role: "implement", agent: "frontend-developer" });
    expect(v.exit).toBe(0);
    expect(v.audit?.surface_audit_enabled).toBe(false);
    const trail = v.audit!.trail;
    expect(trail.startsWith(join(repo, ".gnomon-audit"))).toBe(true);
    expect(verifyTrail(trail)).toMatchObject({ ok: true, sealed: true, records: 3 });
    const records = readFileSync(trail, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as AuditRecord);
    const rec = records.find((r) => r.kind === "check")!;
    expect(rec.hash).toBe(v.audit!.hash);
    expect(recordHash(rec)).toBe(v.audit!.hash);
    expect(rec).toMatchObject({ base, head: "worktree", role: "implement", agent: "frontend-developer", exit: 0 });
    expect(byId(v, "audit")?.status).toBe("pass");
    // Replay re-derives the exit from the recorded statuses rather than
    // calling the record a kind it has no rules for.
    const entry = replay(trail, loadConfig(repo)).entries.find((e) => e.kind === "check")!;
    expect(entry.checks).toEqual([
      expect.objectContaining({ field: "check.exit", status: "match", recorded: 0, replayed: 0 }),
    ]);
  });

  it("a second check does not count the first one's trail as a change", async () => {
    surface();
    const base = commit("base");
    put("src/pay.txt", "2\n");
    await runCheck({ dir: repo, base, role: "implement" });
    const again = await runCheck({ dir: repo, base, role: "implement" });
    expect(byId(again, "write_allow")).toMatchObject({ status: "pass", inspected: 1 });
    expect(readdirSync(join(repo, ".gnomon-audit"))).toHaveLength(2);
  });
});

describe("gnomon check — head as a revision", () => {
  it("judges a commit that is not checked out, in a temporary worktree", async () => {
    surface();
    const base = commit("base");
    put("src/pay.txt", "2\n");
    put("tests/pay.sh", "grep -qx 2 src/pay.txt\n");
    const head = commit("work");
    // Leave the checkout somewhere else entirely.
    sh(["checkout", "-q", base]);
    const v = await runCheck({ dir: repo, base, head, role: "implement" });
    expect(v.head).toBe(head);
    expect(byId(v, "verify")?.status).toBe("pass");
    expect(byId(v, "must_fail_first")?.status).toBe("pass");
    expect(v.exit).toBe(0);
    // The temporary worktree is gone and the checkout untouched.
    expect(sh(["worktree", "list"]).split("\n")).toHaveLength(1);
    expect(readFileSync(join(repo, "src/pay.txt"), "utf-8")).toBe("1\n");
  });

  it("diffs from the merge-base, so base moving on is not the change's doing", async () => {
    surface();
    const base = commit("base");
    sh(["checkout", "-q", "-b", "work"]);
    put("src/pay.txt", "2\n");
    const head = commit("work");
    sh(["checkout", "-q", "-"]);
    put("elsewhere.md", "main moved on\n");
    const main = commit("main");
    sh(["checkout", "-q", "work"]);
    const v = await runCheck({ dir: repo, base: main, head, role: "implement" });
    expect(v.base).toBe(base);
    expect(byId(v, "write_allow")).toMatchObject({ status: "pass", inspected: 1 });
  });

  it("reads the rules from the base given, not from a merge-base head's history chose", async () => {
    // Permissive policy first, then a tightening. Head is built on the commit
    // BEFORE the tightening (a reset, or a branch rebased onto an old commit),
    // so merge-base(base, head) is the permissive commit.
    surface();
    put(".gnomon/roles.toml", `[roles.implement]\nmodel = "m"\n`);
    const loose = commit("loose");
    surface();
    const tight = commit("tight");
    sh(["checkout", "-q", "-b", "work", loose]);
    put("infra/env.txt", "SECRET=1\n");
    const head = commit("work");
    const v = await runCheck({ dir: repo, base: tight, head, role: "implement" });
    expect(v.base).toBe(loose); // the diff still starts at the merge-base
    expect(byId(v, "write_allow")).toMatchObject({ status: "fail", findings: [{ path: "infra/env.txt" }] });
    expect(v.exit).toBe(2);
  });
});

describe("gnomon check — an interrupted re-run", () => {
  it("restores what the journal holds before judging anything", async () => {
    surface();
    const base = commit("base");
    put("src/pay.txt", "2\n");
    // What a killed must-fail-first leaves: the operator's file at its base
    // content, and the journal holding the real bytes.
    const gitDir = sh(["rev-parse", "--absolute-git-dir"]);
    writeFileSync(
      join(gitDir, "gnomon-check-restore.json"),
      JSON.stringify({ files: [{ path: join(repo, "src/pay.txt"), b64: Buffer.from("2\n").toString("base64") }] })
    );
    put("src/pay.txt", "1\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(v.recovered).toEqual([join(repo, "src/pay.txt")]);
    expect(readFileSync(join(repo, "src/pay.txt"), "utf-8")).toBe("2\n");
    expect(existsSync(join(gitDir, "gnomon-check-restore.json"))).toBe(false);
    expect(byId(v, "write_allow")?.inspected).toBe(1);
  });
});

describe("gnomon check — with a transcript (check 5)", () => {
  const deny = `bash_deny = ['\\bgit\\s+push\\b[^|;&]*\\s(--force|-f)\\b']\n`;

  it("a session that changed no file still has its commands judged", async () => {
    surface();
    put(".gnomon/roles.toml", `[roles.implement]\nmodel = "m"\nwrite_allow = ["src/**"]\n${deny}`);
    const base = commit("base");
    const v = await runCheck({
      dir: repo,
      base,
      role: "implement",
      transcript: { format: "claude-code", commands: [{ tool: "Bash", command: "git push --force origin main", at: "s.jsonl:3" }] },
    });
    expect(v.exit).toBe(2);
    for (const id of ["write_allow", "surface", "verify", "must_fail_first"]) {
      expect(byId(v, id)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/no file changed/) });
    }
    expect(byId(v, "bash_allow")).toMatchObject({ status: "fail", findings: [{ rule: "bash_deny", at: "s.jsonl:3" }] });
  });

  it("reads another harness's command as the shell would, like the loop does (#63)", async () => {
    // One matcher, two callers: the spelling that gets past bashTool must not
    // get past check 5, or the two would disagree on the first command nobody
    // tried. `git -C . push -fu` matched none of the pattern's text.
    surface();
    put(".gnomon/roles.toml", `[roles.implement]\nmodel = "m"\nwrite_allow = ["src/**"]\n${deny}`);
    const base = commit("base");
    const v = await runCheck({
      dir: repo,
      base,
      role: "implement",
      transcript: { format: "claude-code", commands: [{ tool: "Bash", command: "git -C . push -fu origin feature", at: "s.jsonl:7" }] },
    });
    expect(v.exit).toBe(2);
    expect(byId(v, "bash_allow")).toMatchObject({ status: "fail", findings: [{ rule: "bash_deny", at: "s.jsonl:7" }] });
  });

  it("an unreadable transcript is could-not-run", async () => {
    surface();
    const base = commit("base");
    put("src/pay.txt", "2\n");
    const v = await runCheck({ dir: repo, base, role: "implement", transcript: "the transcript could not be read: gone" });
    expect(byId(v, "bash_allow")?.status).toBe("error");
    expect(v.exit).toBe(10);
  });

  it("the transcript's agent picks the role through [check.roles]", async () => {
    surface({ checkRoles: { build: "implement" } });
    const base = commit("base");
    put("src/pay.txt", "2\n");
    const v = await runCheck({ dir: repo, base, transcript: { format: "opencode", agent: "build", commands: [] } });
    expect(v.role).toBe("implement");
  });

  it("a redact pattern scrubs a command before it is chained", async () => {
    surface();
    put(".gnomon/roles.toml", `[roles.implement]\nmodel = "m"\nwrite_allow = ["src/**"]\n${deny}`);
    put(".gnomon/config.toml", `[audit]\nredact = ['token=\\S+']\n`);
    const base = commit("base");
    const v = await runCheck({
      dir: repo, base, role: "implement",
      transcript: { format: "claude-code", commands: [{ tool: "Bash", command: "git push -f https://x token=SECRET1" }] },
    });
    const trail = readFileSync(v.audit!.trail, "utf-8");
    expect(trail).not.toContain("SECRET1");
    expect(trail).toContain("[redacted]");
  });
});

describe("gnomon check — a session's starting point (the Claude Code hook)", () => {
  it("diffs from the snapshot, so the operator's own uncommitted edits are not the agent's", async () => {
    surface();
    const base = commit("base");
    // Before the session: the operator had run_tests.sh edited, uncommitted.
    put("run_tests.sh", readFileSync(join(repo, "run_tests.sh"), "utf-8") + "# operator's edit\n");
    const snapshot = sh(["stash", "create"]);
    // The session then changes src/.
    put("src/pay.txt", "2\n");
    const v = await runCheck({ dir: repo, base, snapshot, role: "implement" });
    expect(v.base).toBe(snapshot);
    expect(byId(v, "write_allow")).toMatchObject({ status: "pass", inspected: 1 });
    // Without it, the operator's edit is charged to the agent.
    const naive = await runCheck({ dir: repo, base, role: "implement" });
    expect(byId(naive, "write_allow")?.status).toBe("fail");
  });

  it("an untracked file already there, unchanged, is not charged; one that changed is", async () => {
    surface();
    const base = commit("base");
    const h = (s: string) => createHash("sha256").update(s).digest("hex");
    put("notes.txt", "mine\n");
    put("scratch.txt", "the agent rewrote it\n");
    put("src/pay.txt", "2\n");
    const v = await runCheck({
      dir: repo, base, role: "implement",
      preexisting: { "notes.txt": h("mine\n"), "scratch.txt": h("mine too\n") },
    });
    expect(byId(v, "write_allow")?.findings?.map((f) => f.path)).toEqual(["scratch.txt"]);
  });
});

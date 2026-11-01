/**
 * `gnomon check` at the command line: the exit code a caller gates on, the
 * JSON it parses, and the lines a person reads. The judging itself is pinned
 * in gnomon-core's check.test.ts; this is the contract around it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_IDS, CHECK_STATUSES, CHECK_SCHEMA, type CheckVerdict, type ResolvedUi } from "gnomon-core";
import { cmdCheck, renderVerdict } from "./check.js";
import { parseArgs } from "./index.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const plain = { color: false } as ResolvedUi;

describe("gnomon check — arguments", () => {
  it("parses the flags it reads", () => {
    const a = parseArgs(["check", "--base", "origin/main", "--head", "HEAD", "--agent", "frontend-developer", "--json"]);
    expect(a.command).toBe("check");
    expect(a.flags).toMatchObject({ base: "origin/main", head: "HEAD", agent: "frontend-developer" });
    expect(a.json).toBe(true);
  });

  it("no --base is exit 10 with a JSON refusal, not a usage exit 1", async () => {
    const lines: string[] = [];
    const code = await cmdCheck({ json: true, flags: {} }, (s) => lines.push(s));
    expect(code).toBe(10);
    const v = JSON.parse(lines.join("\n")) as CheckVerdict;
    expect(v).toMatchObject({ schema: "gnomon.check/1", exit: 10, checks: [] });
    expect(v.error).toMatch(/--base/);
  });
});

describe("gnomon check — terminal output", () => {
  const verdict: CheckVerdict = {
    schema: "gnomon.check/1",
    base: "fd7796f0000000000000000000000000000000aa",
    head: "worktree",
    role: "implement",
    surface_hash: "315867aabbccddeeff00112233445566778899aabbccddeeff0011223344556677",
    checks: [
      { id: "write_allow", status: "fail", inspected: 2, findings: [{ path: "infra/.env", change: "A", rule: "write_allow", listed: "src/**, tests/**" }] },
      { id: "surface", status: "pass", inspected: 2 },
      { id: "verify", status: "pass", inspected: 1, findings: [{ command: "pytest -q", exit: 0 }] },
      { id: "must_fail_first", status: "fail", inspected: 1, findings: [{ test: "tests/test_pay.py", detail: "passes against base sources — pins nothing" }] },
      { id: "bash_allow", status: "skipped", reason: "no --transcript" },
      { id: "audit", status: "pass", inspected: 3, findings: [{ trail: ".gnomon-audit/check-x.jsonl", seq: 1, hash: "ab".repeat(32) }] },
    ],
    exit: 2,
  };

  it("one line per check, marked, with the findings indented under it", () => {
    const text = renderVerdict(verdict, plain).join("\n");
    expect(text).toContain("gnomon check  fd7796f00000 → worktree  ·  role implement");
    expect(text).toMatch(/\n  ✗ write_allow\s+1 path\(s\) outside write_allow \(src\/\*\*, tests\/\*\*\)\n      A infra\/\.env\n/);
    expect(text).toMatch(/\n  ✓ surface\s+not edited/);
    expect(text).toMatch(/\n  ✓ verify\s+pytest -q — exit 0/);
    expect(text).toMatch(/\n  ✗ must_fail_first\s+1 test\(s\) pass against base sources — they pin nothing\n      tests\/test_pay\.py/);
    expect(text).toMatch(/\n  – bash_allow\s+skipped: no --transcript/);
    expect(text).toMatch(/\n  ✓ audit\s+appended, chain verified\n      \.gnomon-audit\/check-x\.jsonl · seq 1 · abababab/);
    expect(text).toContain("FAILED — 2 check(s) failed (exit 2)");
  });

  it("a run that stopped early says why and that there is no verdict", () => {
    const text = renderVerdict({ ...verdict, checks: [], exit: 10, error: "no changes — nothing to judge" }, plain).join("\n");
    expect(text).toContain("! no changes — nothing to judge");
    expect(text).toContain("NO VERDICT");
  });
});

describe("gnomon check — through the real binary", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "gnomon-check-cli-"));
    mkdirSync(join(repo, ".gnomon"));
    writeFileSync(join(repo, ".gnomon/roles.toml"), `[roles.implement]\nmodel = "m"\nwrite_allow = ["src/**"]\n`);
    writeFileSync(join(repo, ".gnomon/policy.toml"), `[verify]\ncommand = "true"\n`);
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(repo, "outside.txt"), "x\n");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("exits 2 and prints parseable JSON for a write outside write_allow", () => {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, "check", "--base", "HEAD", "--role", "implement", "--json", "--dir", repo],
      { encoding: "utf-8", timeout: 60_000 }
    );
    expect(r.status).toBe(2);
    const v = JSON.parse(r.stdout) as CheckVerdict;
    expect(v.checks.find((c) => c.id === "write_allow")?.findings?.[0]).toMatchObject({ path: "outside.txt" });
    expect(v.audit?.hash).toMatch(/^[0-9a-f]{64}$/);
    live = v;
  });

  // ── The contract: code, CONTRACTS.md §6 and the fixture are one set ──────
  let live: CheckVerdict | undefined;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const fixture = JSON.parse(readFileSync(join(repoRoot, "conformance/check_verdict.json"), "utf-8")) as {
    schema: string;
    exit_codes: Record<string, string>;
    check_ids: string[];
    statuses: string[];
    verdict_keys: { required: string[]; optional: string[] };
    entry_keys: { required: string[]; optional: string[] };
    audit_keys: { required: string[]; optional: string[] };
  };

  it("check ids and statuses agree across the code, CONTRACTS.md §6 and the fixture", () => {
    expect([...CHECK_IDS]).toEqual(fixture.check_ids);
    expect([...CHECK_STATUSES]).toEqual(fixture.statuses);
    expect(fixture.schema).toBe(CHECK_SCHEMA);
    expect(Object.keys(fixture.exit_codes)).toEqual(["0", "2", "10"]);
    const doc = readFileSync(join(repoRoot, "docs/CONTRACTS.md"), "utf-8");
    // §6 only: later sections have tables of their own (§8, gnomon guard).
    const start = doc.indexOf("## 6. `gnomon check --json`");
    const section = doc.slice(start, doc.indexOf("\n## ", start + 1));
    const rows = [...section.matchAll(/^\| `([a-z_]+)` \| ([a-z, ]+) \|$/gm)];
    expect(rows.map((m) => m[1])).toEqual(fixture.check_ids);
    for (const m of rows) {
      for (const s of m[2]!.split(",").map((x) => x.trim())) expect(fixture.statuses).toContain(s);
    }
  });

  it("a document the real binary printed fits the fixture's key lists", () => {
    expect(live, "the binary test above must run first").toBeDefined();
    const fits = (obj: object, spec: { required: string[]; optional: string[] }, where: string) => {
      const keys = Object.keys(obj);
      for (const k of spec.required) expect(keys, `${where} lacks ${k}`).toContain(k);
      for (const k of keys) expect([...spec.required, ...spec.optional], `${where} has undeclared ${k}`).toContain(k);
    };
    fits(live!, fixture.verdict_keys, "verdict");
    for (const c of live!.checks) {
      fits(c, fixture.entry_keys, `check ${c.id}`);
      expect(fixture.check_ids).toContain(c.id);
      expect(fixture.statuses).toContain(c.status);
    }
    fits(live!.audit!, fixture.audit_keys, "audit");
    expect(Object.keys(fixture.exit_codes)).toContain(String(live!.exit));
  });
});

describe("gnomon check — the Claude Code hook", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const errs: string[] = [];
  const realError = console.error;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "gnomon-check-hook-"));
    mkdirSync(join(repo, ".gnomon"));
    writeFileSync(
      join(repo, ".gnomon/roles.toml"),
      `[roles.implement]\nmodel = "m"\nwrite_allow = ["src/**"]\nbash_deny = ['\\bgit\\s+push\\b[^|;&]*\\s--force\\b']\n`
    );
    writeFileSync(join(repo, ".gnomon/policy.toml"), `[verify]\ncommand = "true"\n\n[check.roles]\nclaude-code = "implement"\n`);
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/a.txt"), "1\n");
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  });
  afterAll(() => {
    console.error = realError;
    rmSync(repo, { recursive: true, force: true });
  });

  const hook = (kind: string, input: Record<string, unknown>, flags: Record<string, string> = {}) =>
    cmdCheck({ flags: { hook: kind, ...flags } }, () => {}, () => JSON.stringify({ cwd: repo, ...input }));

  it("records the session's start once, and judges everything since at Stop", async () => {
    // The operator's own uncommitted edit, before the session.
    writeFileSync(join(repo, "notes.md"), "operator\n");
    expect(await hook("session-start", { session_id: "s-1", source: "startup" })).toBe(0);
    const state = join(git("rev-parse", "--absolute-git-dir"), "gnomon-check/sessions/s-1.json");
    expect(existsSync(state)).toBe(true);
    const first = readFileSync(state, "utf-8");
    // A resume fires SessionStart again; the start it recorded stands.
    writeFileSync(join(repo, "src/a.txt"), "2\n");
    expect(await hook("session-start", { session_id: "s-1", source: "resume" })).toBe(0);
    expect(readFileSync(state, "utf-8")).toBe(first);

    const transcript = join(repo, "..", `${basename(repo)}-s-1.jsonl`);
    writeFileSync(
      transcript,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }] } }) + "\n"
    );
    errs.length = 0;
    // src/ changed, inside write_allow; notes.md predates the session; ls is allowed.
    expect(await hook("stop", { session_id: "s-1", transcript_path: transcript }, { agent: "claude-code" })).toBe(0);
    expect(errs).toEqual([]);
    rmSync(transcript);
  });

  it("blocks the stop once with the findings, then lets go", async () => {
    writeFileSync(join(repo, "outside.txt"), "x\n");
    errs.length = 0;
    expect(await hook("stop", { session_id: "s-1" }, { agent: "claude-code" })).toBe(2);
    const said = errs.join("\n");
    expect(said).toMatch(/✗ write_allow/);
    expect(said).toMatch(/A outside\.txt/);
    expect(said).toMatch(/governance check failed/);
    // stop_hook_active: this is already the send-back. Report, do not block again.
    expect(await hook("stop", { session_id: "s-1", stop_hook_active: true }, { agent: "claude-code" })).toBe(1);
    rmSync(join(repo, "outside.txt"));
  });

  it("judges from the session's start even when the agent reset HEAD behind it", async () => {
    // A clean tree at the start, so no snapshot is recorded: the diff must
    // still start at the session's HEAD, not at a merge-base the reset chose.
    git("checkout", "-q", "--", ".");
    rmSync(join(repo, "notes.md"), { force: true });
    const loose = git("rev-parse", "HEAD");
    writeFileSync(
      join(repo, ".gnomon/roles.toml"),
      `[roles.implement]\nmodel = "m"\nwrite_allow = ["src/a.txt"]\n`
    );
    git("add", "-A");
    git("commit", "-q", "-m", "tighten");
    expect(await hook("session-start", { session_id: "s-reset", source: "startup" })).toBe(0);
    git("reset", "-q", "--hard", loose);
    errs.length = 0;
    expect(await hook("stop", { session_id: "s-reset" }, { agent: "claude-code" })).toBe(2);
    // Undoing the tightening is an edit to the surface, and it is seen.
    expect(errs.join("\n")).toMatch(/✗ surface/);
  });

  it("stays silent where it has nothing to say: an ungoverned repo, an unsafe id", async () => {
    const plainRepo = mkdtempSync(join(tmpdir(), "gnomon-ungoverned-"));
    execFileSync("git", ["init", "-q"], { cwd: plainRepo });
    expect(await cmdCheck({ flags: { hook: "stop" } }, () => {}, () => JSON.stringify({ cwd: plainRepo, session_id: "x" }))).toBe(0);
    rmSync(plainRepo, { recursive: true, force: true });
    expect(await hook("session-start", { session_id: "../../etc" })).toBe(0);
    expect(existsSync(join(git("rev-parse", "--absolute-git-dir"), "gnomon-check/sessions/../../etc.json"))).toBe(false);
  });

  it("--install-hook prints a settings fragment and writes nothing", async () => {
    const lines: string[] = [];
    expect(await cmdCheck({ flags: { "install-hook": "claude-code" } }, (s) => lines.push(s))).toBe(0);
    const fragment = JSON.parse(lines.join("\n")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>> };
    expect(fragment.hooks.SessionStart![0]!.hooks[0]!.command).toBe("gnomon check --hook session-start");
    expect(fragment.hooks.Stop![0]!.hooks[0]!.command).toBe("gnomon check --hook stop --agent claude-code");
    expect(fragment.hooks.Stop![0]!.hooks[0]!.timeout).toBeGreaterThan(60);
  });
});

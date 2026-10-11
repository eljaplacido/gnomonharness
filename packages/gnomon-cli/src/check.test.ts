/**
 * `gnomon check` at the command line: the exit code a caller gates on, the
 * JSON it parses, and the lines a person reads. The judging itself is pinned
 * in gnomon-core's check.test.ts; this is the contract around it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
    const section = doc.slice(doc.indexOf("## 6. `gnomon check --json`"));
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

/**
 * `gnomon security test` (security_test.ts) against
 * conformance/security_test.json (CONTRACTS.md §50): the real guard, a
 * scratch repository, no model.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSurface } from "./init.js";
import {
  runSecurityTest,
  formatSecurityTest,
  testRole,
  ATTACK_FAMILIES,
  CORPUS,
  EXPECTATIONS,
  SECURITY_TEST_HOSTS,
  hostPayload,
  readAnswer,
  OWASP_LLM,
  SECURITY_TEST_EXIT,
  SECURITY_TEST_SCHEMA,
  type SecurityTestReport,
} from "./security_test.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "conformance/security_test.json"), "utf-8"));

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), "gnomon-sectest-p-"));
  await initSurface({ dir: root });
  return root;
}
function keysHold(obj: object, spec: { required: string[]; optional: string[] }): void {
  for (const k of spec.required) expect(obj, k).toHaveProperty(k);
  for (const k of Object.keys(obj)) expect([...spec.required, ...spec.optional], k).toContain(k);
}
function shapeHolds(r: SecurityTestReport): void {
  keysHold(r, FIXTURE.report_keys);
  for (const c of r.cases) keysHold(c, FIXTURE.case_keys);
  for (const h of r.hosts) keysHold(h, FIXTURE.host_keys);
  for (const n of r.not_covered) keysHold(n, FIXTURE.not_covered_keys);
}

describe("gnomon security test: the contract", () => {
  it("schema, exits, expectations, families, OWASP ids and the corpus are the fixture's", () => {
    expect(SECURITY_TEST_SCHEMA).toBe(FIXTURE.schema);
    expect(Object.values(SECURITY_TEST_EXIT).map(String).sort()).toEqual(Object.keys(FIXTURE.exit_codes).sort());
    expect([...EXPECTATIONS]).toEqual(Object.keys(FIXTURE.expectations));
    expect([...ATTACK_FAMILIES]).toEqual(FIXTURE.families);
    expect(OWASP_LLM).toEqual(FIXTURE.owasp_llm);
    expect(CORPUS.map((c) => c.id)).toEqual(FIXTURE.corpus);
    expect([...SECURITY_TEST_HOSTS]).toEqual(FIXTURE.hosts);
    // Which cases a host cannot be asked about is part of the contract.
    for (const host of SECURITY_TEST_HOSTS) {
      const missing = CORPUS.filter((k) => "why" in hostPayload(host, k, k.input, "/sb", "s")).map((k) => k.id);
      expect(missing, host).toEqual(FIXTURE.not_covered[host]);
    }
    for (const c of CORPUS) for (const o of c.owasp) expect(Object.keys(OWASP_LLM)).toContain(o);
  });

  it("a fresh scaffold holds every case on every host, and the scratch repository is gone afterwards", async () => {
    const dir = await project();
    const parent = mkdtempSync(join(tmpdir(), "gnomon-sectest-p-scratch-"));
    const r = runSecurityTest(dir, { scratchParent: parent });
    shapeHolds(r);
    expect(r.cases.filter((c) => !c.pass).map((c) => `${c.host} ${c.id}: ${c.decision}`)).toEqual([]);
    const covered = (h: string) => CORPUS.length - FIXTURE.not_covered[h].length;
    const total = SECURITY_TEST_HOSTS.reduce((n, h) => n + covered(h), 0);
    expect(r).toMatchObject({ passed: total, total, exit: 0 });
    for (const h of r.hosts) expect(h).toMatchObject({ role: "implement", passed: covered(h.host), total: covered(h.host) });
    expect(r.not_covered.length).toBe(SECURITY_TEST_HOSTS.length * CORPUS.length - total);
    expect(r.by_owasp.LLM06!.total).toBeGreaterThan(0);
    expect(readdirSync(parent)).toEqual([]);
    rmSync(parent, { recursive: true, force: true });
    // Nothing in the project moved: no trail, no hook, no bait.
    expect(existsSync(join(dir, ".gnomon-audit"))).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  }, 120_000);

  it("a loosened surface fails the cases it lets through (exit 2), and names them", async () => {
    const dir = await project();
    const p = join(dir, ".gnomon/policy.toml");
    writeFileSync(p, readFileSync(p, "utf-8").replace(/gate = "on_write"/, 'gate = "never"'));
    const r = runSecurityTest(dir);
    // Every host sees the loosening: the same rules decide each one's calls.
    for (const host of SECURITY_TEST_HOSTS) {
      const failed = r.cases.filter((c) => c.host === host && !c.pass).map((c) => c.id);
      expect(failed, host).toContain("rm_rf");
      if (host !== "cursor") expect(failed, host).toContain("plain_write");
      // The structural rules hold whatever the approval gate says.
      for (const id of ["read_env", "write_ci", "write_policy", "rm_audit"]) expect(failed, host).not.toContain(id);
    }
    expect(r.exit).toBe(SECURITY_TEST_EXIT.failed);
    expect(formatSecurityTest(r).join("\n")).toMatch(/✗ rm_rf .*got allow/);
  }, 120_000);

  it("each host's answer is read the way that host reads it", () => {
    expect(readAnswer("claude-code", "")).toEqual({ decision: "allow", rule: null });
    expect(readAnswer("claude-code", JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "gnomon guard (secret_path): no" } }))).toEqual({ decision: "deny", rule: "secret_path" });
    expect(readAnswer("opencode", JSON.stringify({ decision: "ask", rule: null }))).toEqual({ decision: "ask", rule: "approval" });
    expect(readAnswer("cursor", "{}")).toEqual({ decision: "allow", rule: null });
    expect(readAnswer("cursor", JSON.stringify({ permission: "deny", user_message: "gnomon guard (network): no" }))).toEqual({ decision: "deny", rule: "network" });
    expect(() => readAnswer("opencode", "{}")).toThrow(/no decision/);
  });

  it("the role: --role wins, an unknown one is refused, else [check.roles] <host>, else implement", async () => {
    const dir = await project();
    expect(testRole(dir)).toEqual({ role: "implement", source: "default: implement" });
    const p = join(dir, ".gnomon/policy.toml");
    writeFileSync(p, readFileSync(p, "utf-8") + '\n[check.roles]\nopencode = "plan"\n');
    expect(testRole(dir, undefined, "opencode")).toEqual({ role: "plan", source: "[check.roles] opencode" });
    expect(testRole(dir, undefined, "cursor")).toEqual({ role: "implement", source: "default: implement" });
    const h = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "security", "test", "--host", "goose", "--json", "--dir", dir], { encoding: "utf-8" });
    expect(h.status).toBe(10);
    expect(JSON.parse(h.stdout).error).toMatch(/--host goose/);
    expect(testRole(dir, "plan")).toEqual({ role: "plan", source: "--role" });
    expect(testRole(dir, "nope")).toMatchObject({ error: expect.stringMatching(/--role nope is not a role/) });
    const r = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "security", "test", "--role", "nope", "--json", "--dir", dir], { encoding: "utf-8" });
    expect(r.status).toBe(10);
    expect(JSON.parse(r.stdout).error).toMatch(/--role nope/);
    const u = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "security", "nope", "--json", "--dir", dir], { encoding: "utf-8" });
    expect(u.status).toBe(10);
  });
});


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
}

describe("gnomon security test: the contract", () => {
  it("schema, exits, expectations, families, OWASP ids and the corpus are the fixture's", () => {
    expect(SECURITY_TEST_SCHEMA).toBe(FIXTURE.schema);
    expect(Object.values(SECURITY_TEST_EXIT).map(String).sort()).toEqual(Object.keys(FIXTURE.exit_codes).sort());
    expect([...EXPECTATIONS]).toEqual(Object.keys(FIXTURE.expectations));
    expect([...ATTACK_FAMILIES]).toEqual(FIXTURE.families);
    expect(OWASP_LLM).toEqual(FIXTURE.owasp_llm);
    expect(CORPUS.map((c) => c.id)).toEqual(FIXTURE.corpus);
    for (const c of CORPUS) for (const o of c.owasp) expect(Object.keys(OWASP_LLM)).toContain(o);
  });

  it("a fresh scaffold holds every case, and the scratch repository is gone afterwards", async () => {
    const dir = await project();
    const parent = mkdtempSync(join(tmpdir(), "gnomon-sectest-p-scratch-"));
    const r = runSecurityTest(dir, { scratchParent: parent });
    shapeHolds(r);
    expect(r.cases.filter((c) => !c.pass).map((c) => `${c.id}: ${c.decision}`)).toEqual([]);
    expect(r).toMatchObject({ passed: CORPUS.length, total: CORPUS.length, exit: 0, role: "implement" });
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
    const failed = r.cases.filter((c) => !c.pass).map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["rm_rf", "plain_write"]));
    // The structural rules hold whatever the approval gate says.
    for (const id of ["read_env", "write_ci", "write_policy", "rm_audit"]) expect(failed).not.toContain(id);
    expect(r.exit).toBe(SECURITY_TEST_EXIT.failed);
    expect(formatSecurityTest(r).join("\n")).toMatch(/✗ rm_rf .*got allow/);
  }, 120_000);

  it("the role: --role wins, an unknown one is refused, else [check.roles] claude-code, else implement", async () => {
    const dir = await project();
    expect(testRole(dir)).toEqual({ role: "implement", source: "default: implement" });
    expect(testRole(dir, "plan")).toEqual({ role: "plan", source: "--role" });
    expect(testRole(dir, "nope")).toMatchObject({ error: expect.stringMatching(/--role nope is not a role/) });
    const r = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "security", "test", "--role", "nope", "--json", "--dir", dir], { encoding: "utf-8" });
    expect(r.status).toBe(10);
    expect(JSON.parse(r.stdout).error).toMatch(/--role nope/);
    const u = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "security", "nope", "--json", "--dir", dir], { encoding: "utf-8" });
    expect(u.status).toBe(10);
  });
});


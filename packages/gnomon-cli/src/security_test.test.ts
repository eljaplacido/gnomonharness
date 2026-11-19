/**
 * `gnomon security test` (security_test.ts) against
 * conformance/security_test.json (CONTRACTS.md §50): the real guard, a
 * scratch repository, no model.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  readGuardRun,
  guardCommand,
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


// #202: the npm package has no gnomon.js beside dist/, so every case spawned a
// missing file, and Claude Code's reading of an empty answer scored the failed
// launch as allow (1/24 on a fresh scaffold, 1/61 across hosts).
describe("gnomon security test: launching the guard (#202)", () => {
  const layout = (files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-sectest-layout-"));
    for (const f of files) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), "");
    }
    return dir;
  };

  it("runs this node with the launcher of the gnomon running: bin/gnomon.mjs in the package, gnomon.js in a checkout", () => {
    // `npm i -g gnomon-harness` (and its Windows layout under %APPDATA%\npm\node_modules):
    // bin, catalog, dashboard, dist, and no gnomon.js.
    const pkg = layout(["dist/security_test.js", "dist/guard_main.js", "bin/gnomon.mjs", "package.json"]);
    // A checkout or a pnpm link runs src/ through gnomon.js.
    const checkout = layout(["src/security_test.ts", "gnomon.js", "bin/gnomon.mjs"]);
    const neither = layout(["dist/security_test.js"]);
    try {
      expect(guardCommand(pathToFileURL(join(pkg, "dist", "security_test.js")), "/opt/node")).toEqual(["/opt/node", join(pkg, "bin", "gnomon.mjs")]);
      expect(guardCommand(pathToFileURL(join(checkout, "src", "security_test.ts")), "/opt/node")).toEqual(["/opt/node", join(checkout, "gnomon.js")]);
      expect(guardCommand(pathToFileURL(join(neither, "dist", "security_test.js")))).toBeNull();
    } finally {
      for (const d of [pkg, checkout, neither]) rmSync(d, { recursive: true, force: true });
    }
    // This module: node itself (never a .cmd shim, which needs a shell) and a file that exists.
    const mine = guardCommand();
    expect(mine?.[0]).toBe(process.execPath);
    expect(existsSync(mine![1]!)).toBe(true);
  });

  it("a launch that failed, a signal or a foreign exit is an apparatus error, never Claude Code's allow", () => {
    // What the npm package produced: node could not find the script, exit 1, nothing on stdout.
    const missing = {
      status: 1,
      signal: null,
      stdout: "",
      stderr: "node:internal/modules/cjs/loader:1386\n  throw err;\n  ^\n\nError: Cannot find module '/pkg/gnomon.js'\n    at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)\n",
    };
    for (const host of SECURITY_TEST_HOSTS) {
      expect(readGuardRun(host, missing), host).toEqual({ error: "the guard exited 1: Error: Cannot find module '/pkg/gnomon.js'" });
    }
    expect(readGuardRun("claude-code", { error: Object.assign(new Error("spawnSync /nope ENOENT"), { code: "ENOENT" }), status: null, signal: null, stdout: "", stderr: "" })).toMatchObject({ error: expect.stringMatching(/did not run.*ENOENT/) });
    expect(readGuardRun("claude-code", { status: null, signal: "SIGTERM", stdout: "", stderr: "" })).toEqual({ error: "the guard was stopped by SIGTERM" });
    // The published launcher's own message spans two lines: the path is on the second.
    expect(readGuardRun("claude-code", { status: 1, signal: null, stdout: "", stderr: "gnomon: the compiled entry point is missing at\n  /pkg/dist/guard_main.js\n\nThis file is..." })).toEqual({
      error: "the guard exited 1: gnomon: the compiled entry point is missing at /pkg/dist/guard_main.js",
    });
    expect(readGuardRun("cursor", { status: 0, signal: null, stdout: "not json", stderr: "" })).toMatchObject({ error: expect.stringMatching(/no decision in the guard's answer/) });
    // The guard's own answers still read as decisions.
    expect(readGuardRun("claude-code", { status: 0, signal: null, stdout: "", stderr: "" })).toEqual({ decision: "allow", rule: null });
    expect(readGuardRun("opencode", { status: 2, signal: null, stdout: JSON.stringify({ decision: "deny", rule: "secret_path" }), stderr: "" })).toEqual({ decision: "deny", rule: "secret_path" });
    expect(readGuardRun("opencode", { status: 10, signal: null, stdout: JSON.stringify({ decision: "ask", rule: "error" }), stderr: "" })).toEqual({ decision: "ask", rule: "error" });
  });

  it("a guard that cannot be launched at all: the test could not run, and says why", async () => {
    const dir = await project();
    for (const guard of [[process.execPath, join(dir, "no-such", "gnomon.js")], [join(dir, "no-such-program")]]) {
      expect(() => runSecurityTest(dir, { guard, hosts: ["claude-code"] })).toThrow(/the guard gave no decision for any case/);
    }
  }, 60_000);

  it("a guard that answers some cases and fails others: those are not measured, and the run is exit 10, not a pass or an allow", async () => {
    const dir = await project();
    const fake = join(dir, "fake-guard.mjs");
    // Allows a Read (Claude Code's empty answer), crashes on anything else.
    writeFileSync(
      fake,
      `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
         if (JSON.parse(s).tool_name === "Read") process.exit(0);
         process.stderr.write("boom: guard_main.js is missing\\n"); process.exit(1);
       });`
    );
    const cases = CORPUS.filter((k) => k.id === "read_readme" || k.id === "rm_rf");
    const r = runSecurityTest(dir, { guard: [process.execPath, fake], hosts: ["claude-code"], cases });
    shapeHolds(r);
    const rm = r.cases.find((c) => c.id === "rm_rf")!;
    expect(rm).toMatchObject({ decision: null, rule: null, pass: false, detail: "the guard exited 1: boom: guard_main.js is missing" });
    expect(r.cases.find((c) => c.id === "read_readme")).toMatchObject({ decision: "allow", pass: true });
    expect(r).toMatchObject({ passed: 1, total: 2, errors: 1, exit: SECURITY_TEST_EXIT.couldNotRun });
    expect(r.hosts[0]).toMatchObject({ passed: 1, total: 2, errors: 1 });
    const text = formatSecurityTest(r).join("\n");
    expect(text).toMatch(/\? rm_rf .*not measured — the guard exited 1/);
    expect(text).toMatch(/1 of 2 cases were not measured.*not a result/);
    expect(text).not.toMatch(/rm_rf .*got allow/);
  }, 60_000);

  it("a case that did not hold is still a finding (exit 2) beside one that was not measured", async () => {
    const dir = await project();
    const fake = join(dir, "fake-guard.mjs");
    // Allows everything except a Write, on which it crashes.
    writeFileSync(fake, `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.exit(JSON.parse(s).tool_name === "Write" ? 1 : 0));`);
    const cases = CORPUS.filter((k) => k.id === "rm_rf" || k.id === "write_env");
    const r = runSecurityTest(dir, { guard: [process.execPath, fake], hosts: ["claude-code"], cases });
    expect(r).toMatchObject({ passed: 0, total: 2, errors: 1, exit: SECURITY_TEST_EXIT.failed });
    expect(formatSecurityTest(r).join("\n")).toMatch(/Summary: 1 of 2 cases did not hold\. 1 of 2 cases were not measured/);
  }, 60_000);
});

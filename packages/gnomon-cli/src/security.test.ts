/**
 * `gnomon security` (security.ts): the posture report against its contract,
 * conformance/security_posture.json (CONTRACTS.md §45).
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveAudit } from "gnomon-core";
import { initSurface } from "./init.js";
import { buildSecurityReport, formatSecurity, SECURITY_EXIT, SECURITY_FINDING_IDS, SECURITY_TRAIL_LIMIT, type SecurityReport } from "./security.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "conformance/security_posture.json"), "utf-8"));

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

async function project(opts: { noVerify?: boolean } = {}): Promise<string> {
  root = mkdtempSync(join(tmpdir(), "gnomon-security-"));
  await initSurface({ dir: root, ...opts });
  return root;
}

function keysHold(obj: Record<string, unknown>, spec: { required: string[]; optional: string[] }): void {
  for (const k of spec.required) expect(obj, k).toHaveProperty(k);
  for (const k of Object.keys(obj)) expect([...spec.required, ...spec.optional], k).toContain(k);
}

function shapeHolds(r: SecurityReport): void {
  keysHold(r as unknown as Record<string, unknown>, FIXTURE.report_keys);
  keysHold(r.audit as unknown as Record<string, unknown>, FIXTURE.audit_keys);
  for (const x of r.roles) keysHold(x as unknown as Record<string, unknown>, FIXTURE.role_keys);
  for (const f of r.findings) {
    keysHold(f as unknown as Record<string, unknown>, FIXTURE.finding_keys);
    expect(FIXTURE.finding_ids).toContain(f.id);
    expect(f.severity).toBe(FIXTURE.risk_ids.includes(f.id) ? "risk" : "advice");
  }
  expect(r.exit).toBe(r.findings.some((f) => f.severity === "risk") ? 2 : 0);
}

describe("gnomon security: the contract", () => {
  it("finding ids, exits, schema and trail limit are the fixture's", () => {
    expect([...SECURITY_FINDING_IDS]).toEqual(FIXTURE.finding_ids);
    expect(Object.values(SECURITY_EXIT).map(String).sort()).toEqual(Object.keys(FIXTURE.exit_codes).sort());
    expect(SECURITY_TRAIL_LIMIT).toBe(FIXTURE.trail_limit);
  });

  it("a fresh scaffold: no risk, audit on, host commands advised, the shape holds", async () => {
    const r = buildSecurityReport(await project(), {}, "linux");
    shapeHolds(r);
    expect(r.schema).toBe(FIXTURE.schema);
    expect(r.exit).toBe(0);
    expect(r.trust.status).toBe("default");
    expect(r.audit.enabled).toBe(true);
    expect(r.findings.map((f) => f.id)).toContain("host_exec");
    expect(r.findings.find((f) => f.id === "host_exec")!.fix).toMatch(/exec = "os"/);
    expect(r.findings.map((f) => f.id)).not.toContain("audit_off");
    // The scaffold declares [governance] level = "prevent".
    expect(r.findings.map((f) => f.id)).not.toContain("governance_off");
    const verifier = r.roles.find((x) => x.role === "verifier")!;
    expect(verifier).toMatchObject({ exec: "off", bash: true, writes: false, bash_allowlist: true });
  });

  it("host_exec's fix names the file [sandbox] lives in, policy.toml, on every platform", async () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const fix = buildSecurityReport(await project(), {}, platform).findings.find((f) => f.id === "host_exec")!.fix;
      expect(fix).toMatch(/\.gnomon\/policy\.toml/);
      expect(fix).not.toMatch(/config\.toml/);
    }
  });

  it("off Linux, the advice names docker, not the Landlock sandbox", async () => {
    const r = buildSecurityReport(await project(), {}, "darwin");
    expect(r.findings.find((f) => f.id === "host_exec")!.fix).not.toMatch(/exec = "os" \(/);
  });

  it("--no-verify scaffold (audit off) is advised, not a risk", async () => {
    const r = buildSecurityReport(await project({ noVerify: true }), {}, "linux");
    expect(r.audit.enabled).toBe(false);
    expect(r.findings.find((f) => f.id === "audit_off")?.severity).toBe("advice");
    expect(r.exit).toBe(0);
  });

  it("a read-only docker verifier drops out of host_exec and judge_can_write", async () => {
    const dir = await project();
    const roles = readFileSync(join(dir, ".gnomon/roles.toml"), "utf-8").replace(
      /\[roles\.verifier\]\n/,
      '[roles.verifier]\nexec = "docker"\nsource = "read_only"\n'
    );
    writeFileSync(join(dir, ".gnomon/roles.toml"), roles);
    const r = buildSecurityReport(dir, {}, "linux");
    shapeHolds(r);
    const v = r.roles.find((x) => x.role === "verifier")!;
    expect(v).toMatchObject({ exec: "docker", read_only_source: true, network: false });
    expect(r.findings.find((f) => f.id === "host_exec")!.message).not.toMatch(/verifier/);
    expect(r.findings.find((f) => f.id === "judge_can_write")?.message ?? "").not.toMatch(/verifier/);
    // #208: the default image carries no toolchain, and the report says so until one is declared.
    const image = r.findings.find((f) => f.id === "surface_warning" && /default image/.test(f.message))!;
    expect(image).toMatchObject({ severity: "advice" });
    expect(image.message).toMatch(/^\.gnomon\/policy\.toml \[sandbox\] image: verifier runs bash under exec = "docker" in the default image, debian:stable-slim/);
    expect(image.fix).toMatch(/\[sandbox\] image = /);
    writeFileSync(join(dir, ".gnomon/roles.toml"), roles.replace('exec = "docker"\n', 'exec = "docker"\nimage = "node:22-bookworm"\n'));
    expect(buildSecurityReport(dir, {}, "linux").findings.some((f) => /default image/.test(f.message))).toBe(false);
  });

  // Measured 2026-11-20 (gnomon 0.6.2): a surface with no [governance] had
  // secret_path, ci_path and outside_root off, and nothing here said so.
  const policyOf = (dir: string) => join(dir, ".gnomon/policy.toml");
  const withoutGovernance = (dir: string, extra = ""): string => {
    const p = policyOf(dir);
    const text = readFileSync(p, "utf-8");
    expect(text).toMatch(/^\[governance\]\n/m);
    writeFileSync(p, text.replace(/^\[governance\]\n/m, "").replace(/^level = "prevent"\n/m, "") + extra);
    return dir;
  };

  it("no [governance]: governance_off, advice, names the families that are off and the fix", async () => {
    const r = buildSecurityReport(withoutGovernance(await project()), {}, "linux");
    shapeHolds(r);
    expect(r.roles.every((x) => x.governance === undefined)).toBe(true);
    const f = r.findings.find((x) => x.id === "governance_off")!;
    expect(f.severity).toBe("advice");
    expect(f.message).toMatch(/^no \[governance\] is declared/);
    expect(f.message).toMatch(/secrets and ci families are off/);
    expect(f.message).toMatch(/secret_path, ci_path, outside_root never run/);
    expect(f.fix).toMatch(/^\[governance\] level = "prevent"/);
    expect(r.exit).toBe(0);
    expect(formatSecurity(r).join("\n")).toMatch(/\[governance_off\] no \[governance\] is declared/);
  });

  it("[governance] with families below prevent names them, and only them", async () => {
    const dir = await project();
    const p = policyOf(dir);
    writeFileSync(p, readFileSync(p, "utf-8").replace(/^level = "prevent"\n/m, 'level = "prevent"\nsecrets = "observe"\nci = "advise"\n'));
    const r = buildSecurityReport(dir, {}, "linux");
    shapeHolds(r);
    const f = r.findings.find((x) => x.id === "governance_off")!;
    expect(f.message).toBe("below prevent: secrets=observe, ci=advise; those families' verdicts are recorded, not applied");
    expect(f.message).not.toMatch(/write|bash|network|rules/);
    expect(r.exit).toBe(0);
  });

  it("a governance layer on one role only: the other roles are named", async () => {
    const dir = withoutGovernance(await project());
    const roles = join(dir, ".gnomon/roles.toml");
    writeFileSync(roles, `${readFileSync(roles, "utf-8")}\n[roles.verifier.governance]\nlevel = "prevent"\n`);
    const r = buildSecurityReport(dir, {}, "linux");
    expect(r.roles.find((x) => x.role === "verifier")!.governance).toBeDefined();
    const f = r.findings.find((x) => x.id === "governance_off")!;
    const others = r.roles.filter((x) => x.role !== "verifier").map((x) => x.role);
    expect(f.message.startsWith(`${others.join(", ")} have no governance, so`)).toBe(true);
  });

  it("approval never with commands on the host is advised", async () => {
    const dir = await project();
    const p = join(dir, ".gnomon/policy.toml");
    writeFileSync(p, readFileSync(p, "utf-8").replace(/gate = "on_write"/, 'gate = "never"'));
    const r = buildSecurityReport(dir, {}, "linux");
    expect(r.approval).toBe("never");
    expect(r.findings.map((f) => f.id)).toContain("approval_never_on_host");
    expect(r.exit).toBe(0);
  });

  // #216 (2026-11-20, Windows 11): Windows has no OS sandbox, so there
  // exec = "os" refuses every shell command (fail closed, and it stays so).
  // A surface committed with it and shared with Windows machines has no
  // shell on them, and nothing said so before the first refusal.
  it('exec = "os" is said plainly: no bash on Windows, here or on a Windows clone; advice, no exit change (#216)', async () => {
    const dir = await project();
    const p = join(dir, ".gnomon/policy.toml");
    const plain = readFileSync(p, "utf-8");
    expect(buildSecurityReport(dir, {}, "win32").findings.map((f) => f.id)).not.toContain("exec_os_windows");
    writeFileSync(p, plain.replace(/^\[sandbox\]\n/m, '[sandbox]\nexec = "os"\n'));
    const win = buildSecurityReport(dir, {}, "win32");
    shapeHolds(win);
    const w = win.findings.find((f) => f.id === "exec_os_windows")!;
    expect(w.severity).toBe("advice");
    expect(w.message).toMatch(/Windows has no OS sandbox: on this machine every shell command is refused/);
    expect(w.fix).toMatch(/exec = "docker"/);
    expect(w.fix).toMatch(/WSL2/);
    expect(win.exit).toBe(0);
    const linux = buildSecurityReport(dir, {}, "linux");
    expect(linux.findings.find((f) => f.id === "exec_os_windows")!.message).toMatch(/on a Windows machine that runs this surface/);
    // What else stops there: [verify] and gnomon check (finding M of the 2026-11-20 shadow test).
    expect(w.message).toMatch(/\[verify\] and gnomon check cannot run/);
    expect(linux.findings.find((f) => f.id === "exec_os_windows")!.message).toMatch(/no \[verify\] or gnomon check verdict/);
    expect(formatSecurity(win).join("\n")).toMatch(/exec_os_windows|no OS sandbox/);
  });

  it("a declared secret inside the repository is advice, and a risk under exec = os at prevent (#227)", async () => {
    const dir = await project();
    expect(buildSecurityReport(dir, {}, "linux").findings.map((f) => f.id)).not.toContain("secrets_in_tree");
    writeFileSync(join(dir, ".env"), "TOKEN=x\n");
    const r = buildSecurityReport(dir, {}, "linux");
    shapeHolds(r);
    const f = r.findings.find((x) => x.id === "secrets_in_tree")!;
    expect(f.severity).toBe("advice");
    expect(f.message).toMatch(/\.env .*readable by any interpreter the role may run/);
    expect(f.fix).toMatch(/move it out of the repository/);
    expect(r.exit).toBe(0);
    // exec = "os" under governance prevent: the session would not start, so it is a risk.
    const p = join(dir, ".gnomon/policy.toml");
    const plain = readFileSync(p, "utf-8");
    writeFileSync(p, plain.replace(/^\[sandbox\]\n/m, '[sandbox]\nexec = "os"\n') + '\n[governance]\nlevel = "prevent"\n');
    const os = buildSecurityReport(dir, {}, "linux");
    expect(os.findings.some((x) => x.id === "surface_fatal" && /declared secret sits inside it/.test(x.message))).toBe(true);
    expect(os.findings.map((x) => x.id)).not.toContain("secrets_in_tree");
    expect(os.exit).toBe(SECURITY_EXIT.risk);
    // exec = "docker" hides it: nothing to report.
    writeFileSync(p, plain.replace(/^\[sandbox\]\n/m, '[sandbox]\nexec = "docker"\n') + '\n[governance]\nlevel = "prevent"\n');
    expect(buildSecurityReport(dir, {}, "linux").findings.map((x) => x.id)).not.toContain("secrets_in_tree");
  });

  it("a trail whose chain does not hold is a risk: exit 2", async () => {
    const dir = await project();
    const auditDir = resolveAudit(loadConfig(dir)).dir;
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, "edited.jsonl"), '{"seq":0,"kind":"session_start","hash":"00","prev":null}\n{"seq":1,"kind":"turn","hash":"11","prev":"ff"}\n');
    const r = buildSecurityReport(dir, {}, "linux");
    shapeHolds(r);
    expect(r.audit.broken).toEqual(["edited.jsonl"]);
    expect(r.findings.find((f) => f.id === "chain_broken")?.severity).toBe("risk");
    expect(r.exit).toBe(SECURITY_EXIT.risk);
  });

  it("the text report names risks and advice and ends in a summary", async () => {
    const lines = formatSecurity(buildSecurityReport(await project(), {}, "linux"));
    expect(lines[0]).toMatch(/^Security posture — /);
    expect(lines.join("\n")).toMatch(/Advice:\n {2}\[host_exec\]/);
    expect(lines.at(-1)).toMatch(/^Summary: no risks/);
  });

  it("the CLI: no .gnomon/ is exit 10 with the error document", () => {
    const empty = mkdtempSync(join(tmpdir(), "gnomon-security-none-"));
    try {
      const r = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "security", "--json", "--dir", empty], { encoding: "utf-8" });
      expect(r.status).toBe(10);
      const doc = JSON.parse(r.stdout);
      keysHold(doc, FIXTURE.error_keys);
      expect(doc.schema).toBe(FIXTURE.schema);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

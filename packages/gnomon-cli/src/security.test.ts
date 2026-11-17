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
    const verifier = r.roles.find((x) => x.role === "verifier")!;
    expect(verifier).toMatchObject({ exec: "off", bash: true, writes: false, bash_allowlist: true });
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

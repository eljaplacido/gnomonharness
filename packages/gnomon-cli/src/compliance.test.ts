/**
 * `gnomon compliance` (compliance.ts) and its catalog (catalog/controls.toml)
 * against the contract, conformance/compliance_report.json (CONTRACTS.md §46).
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSurface } from "./init.js";
import {
  buildComplianceReport,
  formatCompliance,
  loadControls,
  parseControls,
  COMPLIANCE_EXIT,
  CONTROL_SCOPES,
  CONTROL_STATUSES,
  PROBE_IDS,
  type ComplianceReport,
} from "./compliance.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "conformance/compliance_report.json"), "utf-8"));
const CATALOG = loadControls();

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), "gnomon-compliance-"));
  await initSurface({ dir: root });
  return root;
}
function keysHold(obj: Record<string, unknown>, spec: { required: string[]; optional: string[] }): void {
  for (const k of spec.required) expect(obj, k).toHaveProperty(k);
  for (const k of Object.keys(obj)) expect([...spec.required, ...spec.optional], k).toContain(k);
}
function shapeHolds(r: ComplianceReport): void {
  keysHold(r as unknown as Record<string, unknown>, FIXTURE.report_keys);
  for (const f of r.frameworks) keysHold(f as unknown as Record<string, unknown>, FIXTURE.framework_keys);
  for (const c of r.controls) {
    keysHold(c as unknown as Record<string, unknown>, FIXTURE.control_keys);
    expect(FIXTURE.statuses).toContain(c.status);
    for (const p of c.probes) keysHold(p as unknown as Record<string, unknown>, FIXTURE.probe_keys);
  }
  const open = r.controls.some((c) => c.status === "gap" || c.status === "partial");
  expect(r.exit).toBe(open ? 2 : 0);
}
const slug = (h: string) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");

describe("gnomon compliance: the contract", () => {
  it("statuses, scopes, probes, frameworks and exits are the fixture's", () => {
    expect([...CONTROL_STATUSES]).toEqual(FIXTURE.statuses);
    expect([...CONTROL_SCOPES]).toEqual(FIXTURE.scopes);
    expect(PROBE_IDS).toEqual(FIXTURE.probes);
    expect(Object.keys(CATALOG.frameworks)).toEqual(FIXTURE.frameworks);
    expect(Object.values(COMPLIANCE_EXIT).map(String).sort()).toEqual(Object.keys(FIXTURE.exit_codes).sort());
  });

  it("the shipped catalog: dated, a disclaimer, and every probe used by some control", () => {
    expect(CATALOG.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CATALOG.disclaimer).toMatch(/not legal advice/);
    const used = new Set(CATALOG.controls.flatMap((c) => c.project));
    expect(PROBE_IDS.filter((p) => !used.has(p))).toEqual([]);
  });

  it("every fact points at a file in this repository, and an anchor at one of its headings", () => {
    for (const f of Object.values(CATALOG.facts)) {
      const [file, anchor] = f.ref.split("#");
      const abs = join(ROOT, file!);
      expect(existsSync(abs), f.ref).toBe(true);
      if (anchor) {
        const headings = readFileSync(abs, "utf-8").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, "")));
        expect(headings, f.ref).toContain(anchor);
      }
    }
  });

  it("refuses a catalog that names an unknown probe, an undeclared framework or evidence for an organisation control", () => {
    const head = 'as_of = "2026-01-01"\nstale_after_days = 1\ndisclaimer = "d"\n[frameworks.x]\nname = "X"\nsource = "s"\n';
    expect(() => parseControls(head + '[[controls]]\nframework = "x"\nid = "a"\ntitle = "t"\nscope = "gnomon"\nproject = ["nope"]\nharness = []\n')).toThrow(/unknown probe nope/);
    expect(() => parseControls(head + '[[controls]]\nframework = "y"\nid = "a"\ntitle = "t"\nscope = "gnomon"\nproject = []\nharness = []\n')).toThrow(/framework y is not declared/);
    expect(() => parseControls(head + '[[controls]]\nframework = "x"\nid = "a"\ntitle = "t"\nscope = "organisation"\nproject = ["audit_on"]\nharness = []\n')).toThrow(/lists no evidence/);
  });

  it("a fresh scaffold: the shape holds, organisation controls carry no evidence, and nothing says compliant", async () => {
    const r = buildComplianceReport(await project(), CATALOG, { platform: "linux", now: new Date(CATALOG.as_of) });
    shapeHolds(r);
    expect(r.catalog.stale).toBe(false);
    for (const c of r.controls.filter((k) => k.scope === "organisation")) {
      expect(c.status).toBe("organisational");
      expect(c.probes).toEqual([]);
    }
    const art12 = r.controls.find((c) => c.framework === "eu-ai-act" && c.id === "art12")!;
    expect(art12.probes.find((p) => p.id === "audit_on")!.holds).toBe(true);
    expect(art12.probes.find((p) => p.id === "audit_anchored")).toMatchObject({ holds: false, fix: expect.stringMatching(/audit\.anchor/) });
    expect(JSON.stringify(r)).not.toMatch(/\bcompliant\b/i);
    expect(formatCompliance(r).join("\n")).not.toMatch(/\bcompliant\b/i);
  });

  it("containing every role's commands closes the probe everywhere it is used", async () => {
    const dir = await project();
    const p = join(dir, ".gnomon/policy.toml");
    writeFileSync(p, readFileSync(p, "utf-8").replace(/\[sandbox\]\n/, '[sandbox]\nexec = "docker"\n'));
    const r = buildComplianceReport(dir, CATALOG, { platform: "linux" });
    for (const c of r.controls) for (const pr of c.probes.filter((x) => x.id === "commands_contained")) expect(pr.holds).toBe(true);
  });

  it("a remote endpoint fails endpoints_local, and the catalog goes stale after its window", async () => {
    const dir = await project();
    const p = join(dir, ".gnomon/config.toml");
    writeFileSync(p, readFileSync(p, "utf-8").replace(/url = "http:\/\/(127\.0\.0\.1|localhost):\d+[^"]*"/, 'url = "https://api.example.com/v1"'));
    const later = new Date(Date.parse(CATALOG.as_of) + (CATALOG.stale_after_days + 2) * 86_400_000);
    const r = buildComplianceReport(dir, CATALOG, { frameworks: ["gdpr"], platform: "linux", now: later });
    expect(r.frameworks.map((f) => f.id)).toEqual(["gdpr"]);
    expect(r.controls.find((c) => c.id === "art28")!.probes[0]).toMatchObject({ id: "endpoints_local", holds: false });
    expect(r.controls.find((c) => c.id === "art44")!.probes[0]).toMatchObject({ id: "residency_held", holds: false });
    expect(r.catalog.stale).toBe(true);
  });

  it("the CLI: an unknown framework is exit 10 with the error document", async () => {
    const dir = await project();
    const r = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "compliance", "--json", "--framework", "nope", "--dir", dir], { encoding: "utf-8" });
    expect(r.status).toBe(10);
    const doc = JSON.parse(r.stdout);
    keysHold(doc, FIXTURE.error_keys);
    expect(doc.error).toMatch(/unknown framework nope/);
  });
});

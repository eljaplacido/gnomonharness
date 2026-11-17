/**
 * `gnomon compliance dataflow` (dataflow.ts) against its contract,
 * conformance/dataflow_report.json (CONTRACTS.md §48).
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSurface } from "./init.js";
import {
  buildDataflowReport,
  formatDataflow,
  DATAFLOW_EXIT,
  DATAFLOW_SCHEMA,
  DESTINATION_KINDS,
  LOCALITIES,
  REGION_SOURCES,
  ROUTE_SIDES,
  type DataflowReport,
} from "./dataflow.js";
import { buildComplianceReport, loadControls } from "./compliance.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "conformance/dataflow_report.json"), "utf-8"));

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), "gnomon-dataflow-"));
  await initSurface({ dir: root });
  return root;
}
function keysHold(obj: object, spec: { required: string[]; optional: string[] }): void {
  for (const k of spec.required) expect(obj, k).toHaveProperty(k);
  for (const k of Object.keys(obj)) expect([...spec.required, ...spec.optional], k).toContain(k);
}
function shapeHolds(r: DataflowReport): void {
  keysHold(r, FIXTURE.report_keys);
  keysHold(r.residency, FIXTURE.residency_keys);
  for (const d of r.destinations) {
    keysHold(d, FIXTURE.destination_keys);
    expect(FIXTURE.destination_kinds).toContain(d.kind);
    if (d.locality !== null) expect(FIXTURE.localities).toContain(d.locality);
    if (d.region_source !== null) expect(FIXTURE.region_sources).toContain(d.region_source);
    for (const u of d.used_by) keysHold(u, FIXTURE.use_keys);
  }
}
/** A remote endpoint, and a role that routes to it. */
function routeRemote(dir: string, region?: string): void {
  appendFileSync(
    join(dir, ".gnomon/config.toml"),
    `\n[endpoints.cloud]\nurl = "https://cloud.example.com/v1"\nkind = "openai"\napi_key_env = "CLOUD_KEY"\n${region ? `region = "${region}"\n` : ""}`
  );
  // Its own role: the scaffold's default profile routes the built-in roles.
  appendFileSync(join(dir, ".gnomon/roles.toml"), `\n[roles.remote]\nmodel = "m"\nendpoint = "cloud"\ntools = ["read"]\n`);
}

describe("gnomon compliance dataflow: the contract", () => {
  it("schema, kinds, sides, sources, localities and exits are the fixture's", () => {
    expect(DATAFLOW_SCHEMA).toBe(FIXTURE.schema);
    expect([...DESTINATION_KINDS]).toEqual(FIXTURE.destination_kinds);
    expect([...ROUTE_SIDES]).toEqual(FIXTURE.route_sides);
    expect([...REGION_SOURCES]).toEqual(FIXTURE.region_sources);
    expect([...LOCALITIES]).toEqual(FIXTURE.localities);
    expect(Object.values(DATAFLOW_EXIT).map(String).sort()).toEqual(Object.keys(FIXTURE.exit_codes).sort());
  });

  it("a fresh scaffold: every role on this machine, no rule, exit 0, and the version check disclosed", async () => {
    const r = buildDataflowReport(await project());
    shapeHolds(r);
    expect(r.residency.allowed_regions).toBeNull();
    const models = r.destinations.filter((d) => d.kind === "model");
    expect(models.length).toBeGreaterThan(0);
    for (const d of models) {
      expect(d.region_source).toBe("this_machine");
      for (const u of d.used_by) expect(u.admitted).toBeNull();
    }
    expect(r.records.leaves_machine).toBe(false);
    expect(r.harness[0]!.destinations).toEqual(["registry.npmjs.org", "api.github.com"]);
    expect(r.exit).toBe(0);
  });

  it("a remote endpoint shows its host, key variable name (never a value) and undeclared region", async () => {
    const dir = await project();
    routeRemote(dir);
    const r = buildDataflowReport(dir);
    shapeHolds(r);
    const cloud = r.destinations.find((d) => d.name === "cloud")!;
    expect(cloud).toMatchObject({ host: "cloud.example.com", locality: "remote", region: null, region_source: "undeclared", key_env: "CLOUD_KEY" });
    expect(cloud.used_by).toEqual([{ role: "remote", as: "primary", admitted: null }]);
    expect(formatDataflow(r).join("\n")).toMatch(/region undeclared/);
  });

  it("with the rule: an undeclared region is refused (exit 2); declaring an admitted one admits it (exit 0)", async () => {
    const dir = await project();
    routeRemote(dir);
    appendFileSync(join(dir, ".gnomon/policy.toml"), `\n[compliance]\nallowed_regions = ["eu"]\n`);
    const refused = buildDataflowReport(dir);
    expect(refused.residency.allowed_regions).toEqual(["eu"]);
    expect(refused.destinations.find((d) => d.name === "cloud")!.used_by[0]!.admitted).toBe(false);
    expect(refused.exit).toBe(DATAFLOW_EXIT.refused);

    rmSync(dir, { recursive: true, force: true });
    const dir2 = await project();
    routeRemote(dir2, "eu");
    appendFileSync(join(dir2, ".gnomon/policy.toml"), `\n[compliance]\nallowed_regions = ["eu"]\n`);
    const ok = buildDataflowReport(dir2);
    expect(ok.destinations.find((d) => d.name === "cloud")).toMatchObject({ region: "eu", region_source: "declared" });
    expect(ok.destinations.find((d) => d.name === "cloud")!.used_by[0]!.admitted).toBe(true);
    expect(ok.exit).toBe(0);
  });

  it("compliance: residency_held holds on this machine, fails for a remote route with no rule, holds again with one", async () => {
    const catalog = loadControls();
    const held = (dir: string) =>
      buildComplianceReport(dir, catalog, { frameworks: ["gdpr"], platform: "linux" })
        .controls.find((c) => c.id === "art44")!.probes.find((p) => p.id === "residency_held")!.holds;
    const dir = await project();
    expect(held(dir)).toBe(true);
    routeRemote(dir, "eu");
    expect(held(dir)).toBe(false);
    appendFileSync(join(dir, ".gnomon/policy.toml"), `\n[compliance]\nallowed_regions = ["eu"]\n`);
    expect(held(dir)).toBe(true);
  });

  it("the CLI: an unknown subcommand is exit 10 with the error document", async () => {
    const dir = await project();
    const r = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "compliance", "nope", "--json", "--dir", dir], { encoding: "utf-8" });
    expect(r.status).toBe(10);
    expect(JSON.parse(r.stdout).error).toMatch(/Unknown compliance subcommand: nope/);
    const ok = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "compliance", "dataflow", "--json", "--dir", dir], { encoding: "utf-8" });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).schema).toBe(DATAFLOW_SCHEMA);
  });
});

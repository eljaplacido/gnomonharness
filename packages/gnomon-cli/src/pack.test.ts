/**
 * `gnomon compliance pack` (pack.ts) against conformance/evidence_pack.json
 * (CONTRACTS.md §51).
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditTrail, loadConfig, resolveAudit } from "gnomon-core";
import { initSurface } from "./init.js";
import { loadControls } from "./compliance.js";
import { buildPack, verifyPack, formatPack, PACK_EXIT, PACK_PARTS, PACK_SCHEMA, type PackManifest } from "./pack.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "conformance/evidence_pack.json"), "utf-8"));
const CATALOG = loadControls();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function project(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "gnomon-pack-"));
  dirs.push(d);
  await initSurface({ dir: d });
  return d;
}
function outDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gnomon-pack-out-"));
  dirs.push(d);
  return join(d, "pack");
}
function keysHold(obj: object, spec: { required: string[]; optional: string[] }): void {
  for (const k of spec.required) expect(obj, k).toHaveProperty(k);
  for (const k of Object.keys(obj)) expect([...spec.required, ...spec.optional], k).toContain(k);
}

describe("gnomon compliance pack", () => {
  it("schema, exits and parts are the fixture's", () => {
    expect(PACK_SCHEMA).toBe(FIXTURE.schema);
    expect(Object.values(PACK_EXIT).map(String).sort()).toEqual(Object.keys(FIXTURE.exit_codes).sort());
    expect([...PACK_PARTS]).toEqual(FIXTURE.parts);
  });

  it("writes every report with its hash, and --verify finds an edit and a deletion", async () => {
    const dir = await project();
    const t = new AuditTrail({ ...resolveAudit(loadConfig(dir)), enabled: true, chain: true }, "task-x");
    t.write("session_start", { surface_hash: "x", harness: "t", cwd: dir, mode: "task" });
    t.write("session_end", {});
    mkdirSync(join(dir, ".gnomon-trials", "_eval", "s"), { recursive: true });
    writeFileSync(join(dir, ".gnomon-trials", "_eval", "s", "report.json"), '{"schema":"gnomon.eval/1"}\n');
    const out = outDir();
    const r = buildPack(dir, out, CATALOG, { platform: "linux", withTrails: true });
    const m = JSON.parse(readFileSync(join(out, "pack.json"), "utf-8")) as PackManifest;
    keysHold(m, FIXTURE.manifest_keys);
    for (const f of m.files) keysHold(f, FIXTURE.file_keys);
    for (const f of FIXTURE.always) expect(m.files.map((x) => x.path)).toContain(f);
    expect(m.files.map((x) => x.path)).toEqual(expect.arrayContaining(["audit/trails/task-x.jsonl", "evals/_eval/s/report.json"]));
    expect(m.audit).toEqual({ trails: 1, verified: 1, broken: 0, copied: true });
    expect(m.exits.security_test).toBe(0);
    expect(m.disclaimer).toMatch(/not legal advice/);
    expect(JSON.stringify(m)).not.toMatch(/\bcompliant\b/i);
    expect(formatPack(r).join("\n")).toMatch(new RegExp(`pack.json sha256 ${r.pack_sha256}`));

    expect(verifyPack(out)).toMatchObject({ missing: [], changed: [], exit: 0, pack_sha256: r.pack_sha256 });
    writeFileSync(join(out, "security.txt"), "all good\n");
    rmSync(join(out, "dataflow.json"));
    expect(verifyPack(out)).toMatchObject({ missing: ["dataflow.json"], changed: ["security.txt"], exit: PACK_EXIT.mismatch });
  }, 120_000);

  it("never writes over a directory with something in it, nor inside the surface", async () => {
    const dir = await project();
    const out = outDir();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "x"), "x");
    expect(() => buildPack(dir, out, CATALOG)).toThrow(/not empty/);
    expect(() => buildPack(dir, join(dir, ".gnomon", "pack"), CATALOG)).toThrow(/inside the project's surface/);
    expect(existsSync(join(dir, ".gnomon", "pack"))).toBe(false);
  });

  it("the CLI: --out is required, and --verify of a missing pack is exit 10", async () => {
    const dir = await project();
    const g = join(ROOT, "packages/gnomon-cli/gnomon.js");
    const a = spawnSync(process.execPath, [g, "compliance", "pack", "--json", "--dir", dir], { encoding: "utf-8" });
    expect(a.status).toBe(10);
    expect(JSON.parse(a.stdout).error).toMatch(/--out/);
    const b = spawnSync(process.execPath, [g, "compliance", "pack", "--verify", join(dir, "nope"), "--json", "--dir", dir], { encoding: "utf-8" });
    expect(b.status).toBe(10);
  });
});

/**
 * `gnomon audit schema` (CONTRACTS.md section 55): the install serves the
 * audit record schema it writes, with no surface and no trail needed.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const GNOMON = join(ROOT, "packages/gnomon-cli/gnomon.js");
const FIXTURE = readFileSync(join(ROOT, "conformance/audit_record_schema.json"), "utf-8");

function run(args: string[]) {
  // An empty directory: no surface, no trail, no credential store.
  const dir = mkdtempSync(join(tmpdir(), "gnomon-audit-schema-cmd-"));
  try {
    return spawnSync(process.execPath, [GNOMON, "audit", "schema", ...args], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, HOME: dir, USERPROFILE: dir, XDG_DATA_HOME: join(dir, "x"), GNOMON_NO_UPDATE_CHECK: "1" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gnomon audit schema", () => {
  it("the copy shipped in the package is the conformance fixture, byte for byte", () => {
    expect(readFileSync(join(ROOT, "packages/gnomon-cli/catalog/audit_record_schema.json"), "utf-8")).toBe(FIXTURE);
  });

  it("--json prints the schema document, in an empty directory", () => {
    const r = run(["--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(FIXTURE));
  });

  it("without --json it lists every kind with its fields and classes", () => {
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(FIXTURE) as { kinds: Record<string, unknown> };
    for (const kind of Object.keys(doc.kinds)) expect(r.stdout, kind).toMatch(new RegExp(`^${kind}$`, "m"));
    expect(r.stdout).toContain("target [content]");
  });
});

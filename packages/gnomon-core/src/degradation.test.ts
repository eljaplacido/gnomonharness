/**
 * The degradation registry as a published contract (docs/CONTRACTS.md section 15).
 *
 * `benchmarks/degradation-contract` measures behaviour: every declared id is
 * injected and must be announced and recorded. This pins the declaration
 * itself, so an id cannot be added, renamed or dropped without the fixture and
 * the section moving in the same change -- a reader filtering a trail by id
 * reads the fixture, not the code.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEGRADATION_IDS, DEGRADATIONS, recordDegradation } from "./degradation.js";

const repo = join(process.cwd(), "..", "..");
const fixture = JSON.parse(readFileSync(join(repo, "conformance", "degradations.json"), "utf8")) as {
  ids: string[];
  record: { kind: string; required: string[]; optional: string[] };
};

describe("the degradation contract (CONTRACTS.md section 15)", () => {
  it("declares exactly the fixture's ids, in order, each with a description", () => {
    expect(DEGRADATION_IDS).toEqual(fixture.ids);
    for (const id of DEGRADATION_IDS) expect(DEGRADATIONS[id].length, id).toBeGreaterThan(20);
  });

  it("section 15 names every declared id in its table, and no other", () => {
    const doc = readFileSync(join(repo, "docs", "CONTRACTS.md"), "utf8");
    const start = doc.indexOf("## 15. Degradations");
    expect(start, "CONTRACTS.md has no section 15").toBeGreaterThan(-1);
    // The table body: from its separator row on, so the header is not a row.
    const section = doc.slice(start);
    const body = section.slice(section.indexOf("|---|"));
    const rows = [...body.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(rows).toEqual(fixture.ids);
  });

  it("writes a record with the fixture's keys and nothing else", () => {
    const written: Array<[string, Record<string, unknown>]> = [];
    const sink = { write: (kind: "degradation", fields: Record<string, unknown>) => void written.push([kind, fields]) };
    recordDegradation(sink, { id: "shadow_unreachable", declared: "d", actual: "a" });
    recordDegradation(sink, { id: "shadow_unreachable", declared: "d", actual: "a", detail: { url: "u" } });
    const allowed = [...fixture.record.required, ...fixture.record.optional];
    for (const [kind, fields] of written) {
      expect(kind).toBe(fixture.record.kind);
      expect(Object.keys(fields).filter((k) => !allowed.includes(k))).toEqual([]);
      expect(fixture.record.required.filter((k) => !(k in fields))).toEqual([]);
    }
    expect("detail" in written[0]![1]).toBe(false);
    expect(written[1]![1].detail).toEqual({ url: "u" });
  });
});

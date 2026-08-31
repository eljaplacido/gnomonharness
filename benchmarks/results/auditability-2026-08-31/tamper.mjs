/**
 * T1 — adversarial tamper-evidence benchmark for gnomon's audit trail.
 *
 * gnomon's headline differentiator is an auditable, hash-chained record, and it
 * had never been attacked. This runs nine distinct tampering strategies against
 * a real trail and asks verifyTrail() to catch each one. One of them is expected
 * to SUCCEED against gnomon, and publishing that is the point: a hash chain with
 * no external anchor cannot detect a wholesale rewrite by someone holding the
 * file. Knowing exactly where the guarantee ends is the useful result.
 */
import { verifyTrail, recordHash } from "/home/eljaplacido/Desktop/gnomon/packages/gnomon-core/dist/audit.js";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const load = (p) => readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const save = (p, rs) => writeFileSync(p, rs.map((r) => JSON.stringify(r)).join("\n") + "\n");
const rechain = (rs) => {           // a forger who understands the format
  let prev = null;
  for (const r of rs) { r.prev = prev; delete r.hash; r.hash = recordHash(r); prev = r.hash; }
  return rs;
};

const ATTACKS = [
  ["edit-a-field",        (rs) => { rs[2].role = "root"; return rs; }],
  ["delete-a-record",     (rs) => { rs.splice(2, 1); return rs; }],
  ["reorder-records",     (rs) => { const t = rs[2]; rs[2] = rs[3]; rs[3] = t; return rs; }],
  ["append-forged-tail",  (rs) => { const f = { ...rs[rs.length - 1] }; f.seq = 999; f.kind = "tool_call"; f.hash = recordHash(f); rs.push(f); return rs; }],
  ["truncate-the-tail",   (rs) => rs.slice(0, 3)],
  ["strip-one-hash",      (rs) => { delete rs[2].hash; return rs; }],
  ["insert-hashless",     (rs) => { const f = { ...rs[2], seq: 998, kind: "tool_call" }; delete f.hash; rs.splice(3, 0, f); return rs; }],
  ["edit-and-rehash-one", (rs) => { rs[2].role = "root"; delete rs[2].hash; rs[2].hash = recordHash(rs[2]); return rs; }],
  ["full-rewrite",        (rs) => { rs[2].role = "root"; return rechain(rs); }],
];

// Expected-detectable. full-rewrite is expected UNDETECTABLE without an external
// anchor, and is included precisely so the limit is measured, not assumed.
const EXPECT_UNDETECTED = new Set(["full-rewrite"]);

const dir = mkdtempSync(join(tmpdir(), "tamper-"));
const src = process.argv[2];
const genuine = load(src);
if (genuine.length < 6) { console.error(`need >=6 records, got ${genuine.length}`); process.exit(2); }

const base = verifyTrail(src);
console.log(`baseline: ok=${base.ok} records=${base.records} broken=[${base.broken}]`);
if (!base.ok) { console.error("the untampered trail does not verify — apparatus failure"); process.exit(2); }

const rows = [];
for (const [name, mutate] of ATTACKS) {
  const p = join(dir, `${name}.jsonl`);
  save(p, mutate(JSON.parse(JSON.stringify(genuine))));
  const v = verifyTrail(p);
  const detected = !v.ok || v.sealed === false;   // truncation shows as unsealed, not as a broken chain
  const expected = !EXPECT_UNDETECTED.has(name);
  rows.push({ attack: name, detected, expected_detected: expected, correct: detected === expected, broken: v.broken, sealed: v.sealed, ok: v.ok });
  const mark = detected === expected ? (detected ? "DETECTED" : "undetected (expected)") : (detected ? "DETECTED (bonus)" : "*** MISSED ***");
  console.log(`  ${name.padEnd(22)} ${mark}`);
}
const caught = rows.filter((r) => r.detected).length;
const surprises = rows.filter((r) => !r.correct);
console.log(`\ndetected ${caught}/${rows.length}; ${rows.filter(r=>r.correct).length}/${rows.length} matched expectation`);
if (surprises.length) console.log("surprises:", surprises.map((s) => s.attack).join(", "));
writeFileSync(join(process.cwd(), "results.json"), JSON.stringify({ baseline: base, rows }, null, 2));

/**
 * Drive the fingerprint under conditions that differ in every way EXCEPT the
 * surface. Anything that shifts is machine-scoped behaviour, which is the one
 * thing Rule 1 forbids.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync, utimesSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = process.argv[2];
const runIn = (dir, env, cwd) =>
  JSON.parse(execFileSync("node", ["-e", `
    import(${JSON.stringify(join(process.cwd(), "determinism.mjs"))}).then(m => {
      const fp = m.fingerprint(${JSON.stringify(dir)});
      console.log(JSON.stringify({ hash: fp.hash, surface: m.surfaceHash(${JSON.stringify(dir)}) }));
    });`],
    { encoding: "utf-8", cwd: cwd ?? process.cwd(), env: { ...process.env, ...env } }).trim());

const touchAll = (d) => { const t = new Date(Date.now() - 86400000);
  for (const f of readdirSync(d, { recursive: true })) {
    const p = join(d, String(f)); try { if (statSync(p).isFile()) utimesSync(p, t, t); } catch {} } };

const copy = (label) => { const d = mkdtempSync(join(tmpdir(), `det-${label}-`)); cpSync(SRC, d, { recursive: true }); return d; };

const CASES = [
  ["baseline",              () => ({ dir: SRC, env: {} })],
  ["different-cwd",         () => ({ dir: SRC, env: {}, cwd: "/" })],
  ["copied-to-new-path",    () => ({ dir: copy("path"), env: {} })],
  ["LC_ALL=tr_TR.UTF-8",    () => ({ dir: SRC, env: { LC_ALL: "tr_TR.UTF-8", LANG: "tr_TR.UTF-8" } })],
  ["LC_ALL=C",              () => ({ dir: SRC, env: { LC_ALL: "C", LANG: "C" } })],
  ["TZ=Pacific/Kiritimati", () => ({ dir: SRC, env: { TZ: "Pacific/Kiritimati" } })],
  ["HOME=elsewhere",        () => ({ dir: SRC, env: { HOME: mkdtempSync(join(tmpdir(), "home-")) } })],
  ["XDG_CONFIG_HOME set",   () => ({ dir: SRC, env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "xdg-")) } })],
  ["mtimes changed",        () => { const d = copy("mtime"); touchAll(d); return { dir: d, env: {} }; }],
  ["GNOMON_MODEL_URL set",  () => ({ dir: SRC, env: { GNOMON_MODEL_URL: "http://127.0.0.1:9/v1/chat/completions" } })],
];

// The env override is DECLARED to change routing and is announced at startup,
// so it is expected to move the fingerprint. Everything else must not.
const EXPECT_DIFFERENT = new Set(["GNOMON_MODEL_URL set"]);

let base = null;
const rows = [];
for (const [label, setup] of CASES) {
  const { dir, env, cwd } = setup();
  let got;
  try { got = runIn(dir, env, cwd); } catch (e) { got = { hash: `ERR:${String(e).slice(0, 80)}`, surface: "ERR" }; }
  base ??= got;
  const same = got.hash === base.hash;
  const sameSurface = got.surface === base.surface;
  const expected = !EXPECT_DIFFERENT.has(label);
  const correct = same === expected;
  rows.push({ label, same, sameSurface, expected_same: expected, correct });
  const mark = correct ? (same ? "stable" : "differs (expected)") : (same ? "STABLE (unexpected)" : "*** DIFFERS ***");
  console.log(`  ${label.padEnd(24)} behaviour:${same ? "same" : "DIFF"}  surface:${sameSurface ? "same" : "DIFF"}   ${mark}`);
}
const bad = rows.filter((r) => !r.correct);
console.log(`\n${rows.filter(r=>r.correct).length}/${rows.length} matched expectation`);
if (bad.length) console.log("PROBLEMS:", bad.map((b) => b.label).join(", "));
writeFileSync("results.json", JSON.stringify(rows, null, 2));

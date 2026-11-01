#!/usr/bin/env node
/**
 * The five model-free property suites, as a CI gate.
 *
 * Each suite already exits non-zero when its own headline fails. That was not
 * enough: none of them ran in CI, so the degradation suite read 11/14 for a
 * whole release (its stub audit lacked `action()`, #82) and nothing noticed.
 * Found by the 2026-11-01 audit, row 22.
 *
 * Exit status alone is also not enough. A suite whose case list shrank, or whose
 * cases all errored the same way, can still exit 0. So each one here is held to
 * the figure the README and the website publish, case count included:
 *
 *   surface-fidelity      13/13 faithful, 0 false negatives, 0 false positives, 0 unmeasurable
 *   degradation-contract  14/14 complete
 *   fault-disclosure       8/8 disclosed, 0 misnamed
 *   silent-success         0/11 falsely successful, 0 void
 *   determinism           10/10 matched expectation
 *
 * A changed count is a changed published claim, and has to be changed here and
 * in the docs in the same commit. That is the point.
 *
 * The suites run in a stranger's state: empty HOME and XDG dirs, no API keys,
 * no inherited env beyond PATH. A green run that depends on this machine's
 * credentials measures this machine (benchmark-discipline, 2026-09-02).
 *
 * Usage: node scripts/property_suites.mjs   (after `pnpm -r run build` and
 * `cargo build --workspace --bins`, which ci.sh does first)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const work = mkdtempSync(join(tmpdir(), "gnomon-suites-"));
for (const d of ["home", "xdg-data", "xdg-config", "tmp"]) mkdirSync(join(work, d));

const env = {
  PATH: process.env.PATH,
  HOME: join(work, "home"),
  XDG_DATA_HOME: join(work, "xdg-data"),
  XDG_CONFIG_HOME: join(work, "xdg-config"),
  TMPDIR: join(work, "tmp"),
  LANG: "C.UTF-8",
  GNOMON_NO_UPDATE_CHECK: "1",
};
// The native binaries ci.sh just built. Without them, surface hashing falls back
// to an error and every determinism row would be INVALID.
const bins = join(REPO, "target", "debug");
if (existsSync(join(bins, "gnomon-surface"))) env.GNOMON_BIN_OVERRIDE = bins;

const run = (cwd, args) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: "utf-8", maxBuffer: 64 << 20 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "", s: (Date.now() - t0) / 1000 };
};
const json = (f) => JSON.parse(readFileSync(f, "utf-8"));
const count = (rows, pred) => rows.filter(pred).length;

const results = [];
const check = (name, r, problems) => {
  if (r.code !== 0) problems.unshift(`exit ${r.code}`);
  results.push({ name, ok: problems.length === 0, problems, s: r.s });
  if (problems.length) {
    const tail = (r.out + r.err).trim().split("\n").slice(-8).join("\n    ");
    console.log(`  ✗ ${name}: ${problems.join("; ")} (${r.s.toFixed(1)}s)\n    ${tail}`);
  } else {
    console.log(`  ✓ ${name} (${r.s.toFixed(1)}s)`);
  }
};

// ── surface fidelity: 13/13 ──
{
  const out = join(work, "sf.json");
  const r = run(join(REPO, "benchmarks/surface-fidelity"), ["fidelity.mjs", "--json", out]);
  const p = [];
  if (existsSync(out)) {
    const d = json(out), s = d.summary ?? {};
    if (d.rows?.length !== 13) p.push(`${d.rows?.length} paths, published 13`);
    if (s.faithful !== 13) p.push(`faithful ${s.faithful}/13`);
    for (const k of ["false_negative", "false_positive", "unmeasurable"]) if (s[k] !== 0) p.push(`${k} ${s[k]}`);
  } else p.push("no JSON written");
  check("surface-fidelity 13/13", r, p);
}

// ── degradation contract: 14/14 complete ──
{
  const out = join(work, "dc.json");
  const r = run(join(REPO, "benchmarks/degradation-contract"), ["contract.mjs", "--json", out]);
  const p = [];
  if (existsSync(out)) {
    const rows = json(out).rows ?? [];
    if (rows.length !== 14) p.push(`${rows.length} paths, published 14`);
    const c = count(rows, (x) => x.complete === true);
    if (c !== 14) p.push(`complete ${c}/14`);
  } else p.push("no JSON written");
  check("degradation-contract 14/14", r, p);
}

// ── fault disclosure: 8/8 ──
{
  const out = join(work, "fd.json");
  const r = run(join(REPO, "benchmarks/fault-disclosure"), ["disclose.mjs", "--json", out]);
  const p = [];
  if (existsSync(out)) {
    const rows = json(out).rows ?? [];
    if (rows.length !== 8) p.push(`${rows.length} faults, published 8`);
    const c = count(rows, (x) => x.disclosed === true);
    if (c !== 8) p.push(`disclosed ${c}/8`);
    const m = count(rows, (x) => x.misnamed === true);
    if (m) p.push(`${m} misnamed`);
  } else p.push("no JSON written");
  check("fault-disclosure 8/8", r, p);
}

// ── silent success: 0/11 ──
{
  const out = join(work, "ss.json");
  const r = run(join(REPO, "benchmarks/silent-success"), ["sweep.mjs", "--json", out]);
  const p = [];
  if (existsSync(out)) {
    const rows = json(out).rows ?? [];
    if (rows.length !== 11) p.push(`${rows.length} decision points, published 11`);
    const f = count(rows, (x) => x.falsely_successful === true);
    if (f) p.push(`${f}/11 falsely successful`);
    const v = count(rows, (x) => x.void === true);
    if (v) p.push(`${v}/11 void`);
  } else p.push("no JSON written");
  check("silent-success 0/11", r, p);
}

// ── determinism: 10/10, on a freshly scaffolded project ──
{
  const proj = join(work, "proj");
  mkdirSync(proj);
  spawnSync("git", ["init", "-q"], { cwd: proj, env });
  const init = spawnSync(join(REPO, "node_modules/.bin/tsx"),
    [join(REPO, "packages/gnomon-cli/src/index.ts"), "init"], { cwd: proj, env, encoding: "utf-8" });
  const dir = join(REPO, "benchmarks/results/determinism-2026-08-31");
  const r = init.status === 0
    ? run(dir, ["run.mjs", proj])
    : { code: init.status ?? 1, out: init.stdout ?? "", err: init.stderr ?? "", s: 0 };
  const p = [];
  if (init.status !== 0) p.push("gnomon init failed");
  else if (!/^10\/10 matched expectation$/m.test(r.out)) {
    p.push(`summary line: ${(r.out.match(/^\d+\/\d+ matched.*$/m) ?? ["none"])[0]}`);
  }
  check("determinism 10/10", r, p);
}

const failed = results.filter((x) => !x.ok);
const total = results.reduce((a, x) => a + x.s, 0);
console.log(`\n  ${results.length - failed.length}/${results.length} property suites at their published figure (${total.toFixed(1)}s)`);
process.exit(failed.length ? 1 : 0);

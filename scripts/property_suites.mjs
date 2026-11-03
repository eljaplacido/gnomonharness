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
 *   surface-fidelity      14/14 faithful, 0 false negatives, 0 false positives, 0 unmeasurable,
 *                         and a trial-spec change that flips a verdict and moves the hash
 *   degradation-contract  15/15 complete
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
 * `cargo build --workspace --bins`, which ci.sh does first). Runs unchanged on
 * Linux, macOS and Windows; CI runs it on Linux (ci.sh) and on windows-latest.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const WIN = process.platform === "win32";
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
  // Windows reads its home and temp from these, and a child process cannot
  // start without SystemRoot; the stranger's state is the same dirs as above.
  ...(WIN
    ? {
        SystemRoot: process.env.SystemRoot,
        PATHEXT: process.env.PATHEXT,
        USERPROFILE: join(work, "home"),
        APPDATA: join(work, "xdg-config"),
        LOCALAPPDATA: join(work, "xdg-data"),
        TEMP: join(work, "tmp"),
        TMP: join(work, "tmp"),
      }
    : {}),
};
// The native binaries ci.sh just built. Without them, surface hashing falls back
// to an error and every determinism row would be INVALID.
const bins = join(REPO, "target", "debug");
if (existsSync(join(bins, WIN ? "gnomon-surface.exe" : "gnomon-surface"))) env.GNOMON_BIN_OVERRIDE = bins;

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

// ── surface fidelity: 14/14 ──
//
// 13 until 2026-11-03. The 14th path is `.gnomon/trials/probe.toml`: a
// skill-trial spec decides what `require_trial` accepts, so the suite counts it
// as behaviour, and the hash must move with it. Specs were briefly left out of
// the hash, which let the agent's shell loosen one unseen (review of #108).
{
  const out = join(work, "sf.json");
  const r = run(join(REPO, "benchmarks/surface-fidelity"), ["fidelity.mjs", "--json", out]);
  const p = [];
  if (existsSync(out)) {
    const d = json(out), s = d.summary ?? {};
    if (d.rows?.length !== 14) p.push(`${d.rows?.length} paths, published 14`);
    if (s.faithful !== 14) p.push(`faithful ${s.faithful}/14`);
    for (const k of ["false_negative", "false_positive", "unmeasurable"]) if (s[k] !== 0) p.push(`${k} ${s[k]}`);
    if (!d.trial_spec_flip?.flipped || !d.trial_spec_flip?.hash_moved) p.push("a trial-spec change did not flip the verdict and move the hash");
  } else p.push("no JSON written");
  check("surface-fidelity 14/14", r, p);
}

// ── degradation contract: 15/15 complete ──
//
// 14 until 2026-11-03. The 15th path is `audit_anchor_queued`: a sealed head
// that could not reach its declared [audit.anchor] witness stays queued, and
// the next session announces and records it.
{
  const out = join(work, "dc.json");
  const r = run(join(REPO, "benchmarks/degradation-contract"), ["contract.mjs", "--json", out]);
  const p = [];
  if (existsSync(out)) {
    const rows = json(out).rows ?? [];
    if (rows.length !== 15) p.push(`${rows.length} paths, published 15`);
    const c = count(rows, (x) => x.complete === true);
    if (c !== 15) p.push(`complete ${c}/15`);
  } else p.push("no JSON written");
  check("degradation-contract 15/15", r, p);
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
  // tsx's CLI through node, not node_modules/.bin/tsx: on Windows that is a
  // .cmd shim, which Node will not spawn without a shell.
  const init = spawnSync(process.execPath,
    [join(REPO, "node_modules/tsx/dist/cli.mjs"), join(REPO, "packages/gnomon-cli/src/index.ts"), "init"],
    { cwd: proj, env, encoding: "utf-8" });
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

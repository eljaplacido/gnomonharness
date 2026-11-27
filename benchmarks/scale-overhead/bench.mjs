#!/usr/bin/env node
/**
 * B-SCALE-1 — Monorepo scale & live-hook latency benchmark ($0, deterministic).
 *
 * Measures wall-clock latency (p50 / p95 / max) of gnomon's core CLI hot paths
 * across synthetic git repositories of increasing size (default: 100, 1000,
 * 10000, 25000 tracked files):
 *
 *   1. `gnomon surface hash`           — must remain O(|.gnomon/|), flat w.r.t. repo size
 *   2. `gnomon guard --from claude-code` (Bash allow + Edit allow) — live IDE hook budget
 *   3. `gnomon audit scan --json`      — offline multi-step trajectory scan (100 steps)
 *   4. `gnomon migrate --check`        — surface drift check
 *
 * Zero external dependencies. Isolates HOME and XDG_DATA_HOME so the host's
 * real credential store is never touched.
 *
 * Usage:
 *   node benchmarks/scale-overhead/bench.mjs [--sizes 100,1000,10000,25000] [--iters 7] [--out results.json]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const GNOMON_JS = join(REPO_ROOT, "packages/gnomon-cli/gnomon.js");

function parseArgs(argv) {
  let sizes = [100, 1000, 10000, 25000];
  let iters = 7;
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sizes" && argv[i + 1]) {
      sizes = argv[++i].split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    } else if (argv[i] === "--iters" && argv[i + 1]) {
      iters = Math.max(3, Number(argv[++i]));
    } else if (argv[i] === "--out" && argv[i + 1]) {
      outPath = resolve(argv[++i]);
    }
  }
  return { sizes, iters, outPath };
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    min_ms: Number(s[0].toFixed(2)),
    p50_ms: pct(s, 50),
    p95_ms: pct(s, 95),
    max_ms: Number(s[s.length - 1].toFixed(2)),
  };
}

function runCmd(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  }
  return r;
}

function buildSyntheticRepo(root, fileCount, env) {
  mkdirSync(root, { recursive: true });
  const dirs = 20;
  for (let d = 0; d < dirs; d++) mkdirSync(join(root, "src", `mod_${String(d).padStart(2, "0")}`), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const dir = join(root, "src", `mod_${String(i % dirs).padStart(2, "0")}`);
    writeFileSync(join(dir, `f_${String(i).padStart(5, "0")}.ts`), `export const v_${i} = ${i};\n`);
  }
  runCmd("git", ["init", "-q", "-b", "main"], { cwd: root, env });
  runCmd("node", [GNOMON_JS, "init", "--dir", root], { cwd: root, env });

  // Write a realistic 100-step synthetic audit trail for audit scan timing.
  const auditDir = join(root, ".gnomon-audit");
  mkdirSync(auditDir, { recursive: true });
  const records = [{ seq: 0, kind: "session_start", mode: "task", cwd: root, record: "metadata" }];
  for (let i = 1; i <= 100; i++) {
    records.push({
      seq: i,
      kind: "tool_call",
      tool: i % 3 === 0 ? "bash" : "read",
      target: i % 3 === 0 ? "git status" : `src/mod_00/f_${String(i % Math.min(fileCount, 100)).padStart(5, "0")}.ts`,
      bucket: "result",
      code: 0,
    });
  }
  writeFileSync(join(auditDir, "bench-100.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

  runCmd("git", ["add", "-A"], { cwd: root, env });
  runCmd("git", ["-c", "user.email=bench@gnomon.local", "-c", "user.name=bench", "commit", "-qm", `seed ${fileCount} files`], { cwd: root, env });
}

function measure(iters, fn) {
  // 1 warmup iteration (unrecorded) to warm OS page cache
  fn();
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

const { sizes, iters, outPath } = parseArgs(process.argv.slice(2));
const scratch = mkdtempSync(join(tmpdir(), "gnomon-scale-bench-"));
const env = {
  ...process.env,
  HOME: join(scratch, "home"),
  XDG_DATA_HOME: join(scratch, "xdg"),
  NO_COLOR: "1",
  GNOMON_NO_UPDATE_CHECK: "1",
};
mkdirSync(env.HOME, { recursive: true });
mkdirSync(env.XDG_DATA_HOME, { recursive: true });

try {
  const version = runCmd("node", [GNOMON_JS, "--version"], { env }).stdout.trim();
  const gitVersion = runCmd("git", ["--version"], { env }).stdout.trim();
  const guardBashPayload = JSON.stringify({
    session_id: "bench-s1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git status" },
  });
  const guardEditPayload = JSON.stringify({
    session_id: "bench-s1",
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "src/mod_00/f_00000.ts", old_string: "0", new_string: "1" },
  });

  const rows = [];
  for (const n of sizes) {
    const repo = join(scratch, `repo-${n}`);
    const tBuild = performance.now();
    buildSyntheticRepo(repo, n, env);
    const buildMs = Number((performance.now() - tBuild).toFixed(1));

    const surfaceHash = measure(iters, () => {
      runCmd("node", [GNOMON_JS, "surface", "hash", "--dir", repo], { cwd: repo, env });
    });
    const guardBash = measure(iters, () => {
      const r = spawnSync("node", [GNOMON_JS, "guard", "--from", "claude-code", "--dir", repo], {
        cwd: repo,
        env,
        input: guardBashPayload,
        encoding: "utf-8",
      });
      if (![0, 2, 3].includes(r.status)) throw new Error(`guard bash exit ${r.status}: ${r.stderr}`);
    });
    const guardEdit = measure(iters, () => {
      const r = spawnSync("node", [GNOMON_JS, "guard", "--from", "claude-code", "--dir", repo], {
        cwd: repo,
        env,
        input: guardEditPayload,
        encoding: "utf-8",
      });
      if (![0, 2, 3].includes(r.status)) throw new Error(`guard edit exit ${r.status}: ${r.stderr}`);
    });
    const auditScan = measure(iters, () => {
      runCmd("node", [GNOMON_JS, "audit", "scan", "--json", "--dir", repo], { cwd: repo, env });
    });
    const migrateCheck = measure(iters, () => {
      const r = spawnSync("node", [GNOMON_JS, "migrate", "--check", "--dir", repo], {
        cwd: repo,
        env,
        encoding: "utf-8",
      });
      if (![0, 1, 2].includes(r.status)) throw new Error(`migrate check exit ${r.status}: ${r.stderr}`);
    });

    rows.push({
      files: n,
      setup_ms: buildMs,
      surface_hash: surfaceHash,
      guard_bash: guardBash,
      guard_edit: guardEdit,
      audit_scan_100: auditScan,
      migrate_check: migrateCheck,
    });
    rmSync(repo, { recursive: true, force: true });
  }

  const report = {
    schema: "gnomon.bench.scale_overhead/1",
    date: new Date().toISOString(),
    harness: version,
    host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, node: process.version, git: gitVersion },
    iters,
    rows,
  };

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  }

  console.log(`\nB-SCALE-1 — Monorepo Scale & Live-Hook Latency (${version}, ${platform()}/${arch()}, iters=${iters})\n`);
  console.log("| Tracked files | surface hash p50/p95 (ms) | guard Bash p50/p95 (ms) | guard Edit p50/p95 (ms) | audit scan 100p p50/p95 (ms) | migrate --check p50/p95 (ms) |");
  console.log("|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const fmt = (m) => `${m.p50_ms} / ${m.p95_ms}`;
    console.log(`| ${r.files.toLocaleString("en-US")} | ${fmt(r.surface_hash)} | ${fmt(r.guard_bash)} | ${fmt(r.guard_edit)} | ${fmt(r.audit_scan_100)} | ${fmt(r.migrate_check)} |`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

#!/usr/bin/env node
/**
 * Zero-dependency paired A/B runner for v0.6.8 local-model capability levers:
 *   - suite=hashline  : `[defaults] edit_format = "hashline"` vs `"str_replace"`
 *   - suite=reqchange : `[verify] require_change = true` vs `false` (#273)
 *
 * Outputs:
 *   - <out>/cells.csv    (compatible with benchmarks/kit/analyze_paired.py)
 *   - <out>/cells.jsonl  (full per-cell telemetry)
 *   - <out>/summary.json (mechanism & score aggregates)
 *
 * Isolation: every cell gets a fresh temp HOME, XDG_DATA_HOME, and git repo.
 * Hidden verification scripts never enter the agent's workspace during the turn.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, appendFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HASHLINE_TASKS } from "./tasks_hashline.mjs";
import { REQCHANGE_TASKS, REQCHANGE_CATCH_TASKS } from "./tasks_reqchange.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GNOMON_BIN = join(REPO_ROOT, "packages", "gnomon-cli", "gnomon.js");
const TOOLS_TOML = join(REPO_ROOT, ".gnomon", "tools.toml");

function parseArgs(argv) {
  const opts = {
    suite: "hashline",
    waves: 3,
    deadline: 180,
    out: "",
    endpoint: "http://127.0.0.1:18080/v1/chat/completions",
    model: "qwen3.6-35b",
    verifyTasks: false,
    limitTasks: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--suite") opts.suite = argv[++i];
    else if (a === "--waves") opts.waves = Number(argv[++i]);
    else if (a === "--deadline") opts.deadline = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--endpoint") opts.endpoint = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--verify-tasks") opts.verifyTasks = true;
    else if (a === "--limit-tasks") opts.limitTasks = Number(argv[++i]);
    else throw new Error(`Unknown arg: ${a}`);
  }
  return opts;
}

function makeSurfaceFiles(suite, arm, opts) {
  const editFormat = suite === "hashline" ? arm : "str_replace";
  const configToml = `[endpoints.local]
url = "${opts.endpoint}"
kind = "openai"
api_key_env = "GNOMON_BENCH_KEY"

[defaults]
edit_format = "${editFormat}"
approval = "never"
sandbox = "confined"
max_context_tokens = 32768
compaction = "summary"

[resilience]
attempts = 2
backoff_ms = 500
request_timeout_ms = 90000
transport_grace_ms = 10000

[audit]
enabled = true
record = "metadata"
chain = true
`;

  // In E-HASHLINE, omit `write` and deny shell file-editing interpreters/redirects
  // so 100% of file mutations go through the `edit` tool (eliminating shell-edit confounding).
  const rolesToml =
    suite === "hashline"
      ? `[roles.implement]
model = "${opts.model}"
endpoint = "local"
temperature = 0.2
top_p = 0.9
max_steps = 20
max_steps_total = 60
max_tokens = 3072
tools = ["read", "edit", "grep", "glob", "bash"]
bash_allow = ['^python3\\s+-m\\s+unittest\\b', '^node\\s+--test\\b', '^ls(\\s|$)']
bash_deny = ['\\bsed\\b', '\\bawk\\b', '\\bperl\\b', '[>|;&\`]', '\\$\\(']
description = "Implement code fixes via edit tool"
`
      : `[roles.implement]
model = "${opts.model}"
endpoint = "local"
temperature = 0.2
top_p = 0.9
max_steps = 16
max_steps_total = 48
max_tokens = 2048
tools = ["read", "edit", "grep", "glob", "bash"]
bash_allow = ['^python3\\s+-m\\s+unittest\\b', '^ls(\\s|$)']
bash_deny = ['\\bsed\\b', '\\bawk\\b', '\\bperl\\b', '[>|;&\`]', '\\$\\(']
description = "Implement code fixes"
`;

  const policyToml =
    suite === "hashline"
      ? `[approval]
gate = "never"

[sandbox]
level = "confined"
network = false
`
      : `[approval]
gate = "never"

[sandbox]
level = "confined"
network = false

[verify]
command = "python3 -m unittest test_smoke.py"
after = "write"
max_rounds = 1
require_change = ${arm === "on" ? "true" : "false"}
`;

  return { configToml, rolesToml, policyToml };
}

function initTaskRepo(dir, task) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(task.files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  git(["init", "-q"]);
  git(["config", "user.email", "bench@gnomon.local"]);
  git(["config", "user.name", "gnomon-bench"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
}

function runHiddenTest(repoDir, task) {
  const testPath = join(repoDir, task.hiddenTest.filename);
  writeFileSync(testPath, task.hiddenTest.content, "utf-8");
  try {
    const [cmd, ...args] = task.hiddenTest.cmd;
    const r = spawnSync(cmd, args, { cwd: repoDir, encoding: "utf-8", timeout: 30_000 });
    const combined = `${r.stdout || ""}\n${r.stderr || ""}`;
    const m = /PASS=(\d+)\/(\d+)/.exec(combined);
    if (!m) {
      return { passed: 0, total: 1, solved: 0, share: 0, raw: combined.slice(0, 400), exit: r.status };
    }
    const passed = Number(m[1]);
    const total = Number(m[2]);
    return {
      passed,
      total,
      solved: passed === total && r.status === 0 ? 1 : 0,
      share: total > 0 ? passed / total : 0,
      raw: combined.trim().slice(0, 400),
      exit: r.status,
    };
  } finally {
    rmSync(testPath, { force: true });
  }
}

function verifyAllTasks(tasks) {
  let ok = true;
  for (const t of tasks) {
    const scratch = mkdtempSync(join(tmpdir(), `gnomon-verify-${t.id}-`));
    try {
      const repoDir = join(scratch, "repo");
      initTaskRepo(repoDir, t);
      const res = runHiddenTest(repoDir, t);
      const smokeCmd = t.lang === "node" ? ["node", "--test", "smoke.test.mjs"] : ["python3", "-m", "unittest", "test_smoke.py"];
      const sm = spawnSync(smokeCmd[0], smokeCmd.slice(1), { cwd: repoDir, encoding: "utf-8" });
      const badInit = res.solved === 1 || res.total < 3;
      if (badInit || sm.status !== 0) {
        ok = false;
        console.error(`TASK ERROR ${t.id}: smoke_exit=${sm.status} hidden=${res.passed}/${res.total} raw=${res.raw}`);
      } else {
        console.log(`TASK OK ${t.id}: smoke=0 hidden_initial=${res.passed}/${res.total}`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (!ok) process.exit(1);
}

function runCell(suite, task, wave, arm, opts) {
  const scratch = mkdtempSync(join(tmpdir(), `gnomon-ab-${task.id}-${arm}-`));
  const home = join(scratch, "home");
  const xdg = join(scratch, "xdg");
  const repoDir = join(scratch, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  try {
    initTaskRepo(repoDir, task);
    const gnomonDir = join(repoDir, ".gnomon");
    mkdirSync(gnomonDir, { recursive: true });
    copyFileSync(TOOLS_TOML, join(gnomonDir, "tools.toml"));
    const { configToml, rolesToml, policyToml } = makeSurfaceFiles(suite, arm, opts);
    writeFileSync(join(gnomonDir, "config.toml"), configToml, "utf-8");
    writeFileSync(join(gnomonDir, "roles.toml"), rolesToml, "utf-8");
    writeFileSync(join(gnomonDir, "policy.toml"), policyToml, "utf-8");

    const t0 = Date.now();
    const proc = spawnSync(
      process.execPath,
      [
        GNOMON_BIN,
        "task",
        "--role",
        "implement",
        "--trust",
        "--yes",
        "--json",
        "--deadline",
        String(opts.deadline),
        task.prompt,
      ],
      {
        cwd: repoDir,
        encoding: "utf-8",
        timeout: (opts.deadline + 30) * 1000,
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: xdg,
          GNOMON_BENCH_KEY: "local",
          NO_COLOR: "1",
          GNOMON_NO_UPDATE_CHECK: "1",
        },
      }
    );
    const wallS = (Date.now() - t0) / 1000;

    let rec = null;
    try {
      rec = JSON.parse(proc.stdout || "{}");
    } catch {
      rec = null;
    }

    const st = spawnSync("git", ["status", "--porcelain", "--", ".", ":!.gnomon", ":!.gnomon-audit"], {
      cwd: repoDir,
      encoding: "utf-8",
    });
    const worktreeChanged = Boolean((st.stdout || "").trim());

    const hidden = runHiddenTest(repoDir, task);

    const code = typeof rec?.code === "number" ? rec.code : proc.status ?? -1;
    const bucket = rec?.bucket || "apparatus_failure";
    const stopReason = rec?.stop_reason || "apparatus";
    const requests = rec?.volatile?.requests ?? 0;
    // Apparatus validity per METHOD.md: valid unless apparatus_failure / transport / timeout / 0 metered requests
    const isApparatusFailure = bucket === "apparatus_failure" || [10, 11, 12].includes(code) || requests < 1;
    const valid = isApparatusFailure ? 0 : 1;

    const perTool = rec?.counters?.per_tool || {};
    const editStats = perTool.edit || { calls: 0, refusals: 0, apparatus: 0 };
    const readStats = perTool.read || { calls: 0, refusals: 0, apparatus: 0 };
    const bashStats = perTool.bash || { calls: 0, refusals: 0, apparatus: 0 };

    return {
      task: task.id,
      wave,
      arm,
      valid,
      solved: valid ? hidden.solved : 0,
      hidden_share: valid ? Number(hidden.share.toFixed(4)) : "",
      usd: 0,
      hidden_passed: hidden.passed,
      hidden_total: hidden.total,
      edit_calls: editStats.calls || 0,
      edit_refusals: editStats.refusals || 0,
      edit_apparatus: editStats.apparatus || 0,
      read_calls: readStats.calls || 0,
      bash_calls: bashStats.calls || 0,
      tool_steps: rec?.tool_steps ?? 0,
      writes: rec?.counters?.writes ?? 0,
      model_calls: rec?.counters?.model_calls?.count ?? requests,
      wall_s: Number(wallS.toFixed(2)),
      tokens_in: rec?.volatile?.tokens_in ?? 0,
      tokens_out: rec?.volatile?.tokens_out ?? 0,
      bucket,
      stop_reason: stopReason,
      exit_code: code,
      worktree_changed: worktreeChanged ? 1 : 0,
      surface_hash: rec?.surface_hash || "",
      harness: rec?.harness || "",
      model: rec?.model || opts.model,
      tool_log: rec?.tool_log || [],
      stderr_tail: (proc.stderr || "").trim().slice(-300),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const CSV_COLS = [
  "task",
  "wave",
  "arm",
  "valid",
  "solved",
  "hidden_share",
  "usd",
  "hidden_passed",
  "hidden_total",
  "edit_calls",
  "edit_refusals",
  "edit_apparatus",
  "read_calls",
  "bash_calls",
  "tool_steps",
  "writes",
  "model_calls",
  "wall_s",
  "tokens_in",
  "tokens_out",
  "bucket",
  "stop_reason",
  "exit_code",
  "worktree_changed",
  "surface_hash",
];

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function summarize(rows, arms) {
  const byArm = {};
  for (const arm of arms) {
    const all = rows.filter((r) => r.arm === arm);
    const valid = all.filter((r) => r.valid === 1);
    const sum = (k) => valid.reduce((a, r) => a + Number(r[k] || 0), 0);
    const editCalls = sum("edit_calls");
    const editRefusals = sum("edit_refusals");
    const solves = sum("solved");
    const falseResultNoChange = valid.filter((r) => r.bucket === "result" && r.worktree_changed === 0).length;
    const stopReasons = {};
    for (const r of all) stopReasons[r.stop_reason] = (stopReasons[r.stop_reason] || 0) + 1;
    const hashes = [...new Set(valid.map((r) => r.surface_hash).filter(Boolean))];
    byArm[arm] = {
      cells: all.length,
      valid: valid.length,
      apparatus_failures: all.length - valid.length,
      solves,
      solve_rate: valid.length ? Number((solves / valid.length).toFixed(4)) : 0,
      mean_hidden_share: valid.length
        ? Number((valid.reduce((a, r) => a + Number(r.hidden_share || 0), 0) / valid.length).toFixed(4))
        : 0,
      edit_calls: editCalls,
      edit_refusals: editRefusals,
      edit_refusal_rate: editCalls ? Number((editRefusals / editCalls).toFixed(4)) : 0,
      cells_with_edit_refusal: valid.filter((r) => r.edit_refusals > 0).length,
      worktree_changed_cells: sum("worktree_changed"),
      false_result_no_change: falseResultNoChange,
      stop_reasons: stopReasons,
      tokens_in_total: sum("tokens_in"),
      tokens_out_total: sum("tokens_out"),
      mean_tokens_in: valid.length ? Math.round(sum("tokens_in") / valid.length) : 0,
      mean_tokens_out: valid.length ? Math.round(sum("tokens_out") / valid.length) : 0,
      mean_wall_s: valid.length ? Number((sum("wall_s") / valid.length).toFixed(2)) : 0,
      mean_tool_steps: valid.length ? Number((sum("tool_steps") / valid.length).toFixed(2)) : 0,
      surface_hashes: hashes,
    };
  }
  return byArm;
}

function main() {
  const opts = parseArgs(process.argv);
  const allTasks =
    opts.suite === "hashline"
      ? HASHLINE_TASKS
      : opts.suite === "reqchange"
        ? REQCHANGE_TASKS
        : opts.suite === "reqchange-catch"
          ? REQCHANGE_CATCH_TASKS
          : null;
  if (!allTasks) throw new Error(`Unknown suite: ${opts.suite}`);
  const tasks = opts.limitTasks > 0 ? allTasks.slice(0, opts.limitTasks) : allTasks;

  if (opts.verifyTasks) {
    verifyAllTasks(tasks);
    return;
  }

  const outDir = opts.out ? resolve(opts.out) : resolve(REPO_ROOT, "benchmarks", "results", `v068-${opts.suite}-2026-11-28`);
  mkdirSync(outDir, { recursive: true });
  const csvPath = join(outDir, "cells.csv");
  const jsonlPath = join(outDir, "cells.jsonl");
  const summaryPath = join(outDir, "summary.json");

  const arms = opts.suite === "hashline" ? ["str_replace", "hashline"] : ["off", "on"];
  writeFileSync(csvPath, CSV_COLS.join(",") + "\n", "utf-8");
  writeFileSync(jsonlPath, "", "utf-8");

  const startedAt = new Date().toISOString();
  const rows = [];
  const totalCells = tasks.length * opts.waves * arms.length;
  let done = 0;

  console.log(
    `[v068-ab] suite=${opts.suite} tasks=${tasks.length} waves=${opts.waves} arms=${arms.join(",")} total=${totalCells} model=${opts.model}`
  );

  for (let w = 1; w <= opts.waves; w++) {
    const waveId = `w${w}`;
    // Alternate arm order across waves to balance thermal/cache/ordering drift
    const orderedArms = w % 2 === 1 ? [arms[0], arms[1]] : [arms[1], arms[0]];
    for (const task of tasks) {
      for (const arm of orderedArms) {
        const row = runCell(opts.suite, task, waveId, arm, opts);
        rows.push(row);
        done += 1;
        appendFileSync(csvPath, CSV_COLS.map((c) => csvEscape(row[c])).join(",") + "\n", "utf-8");
        appendFileSync(jsonlPath, JSON.stringify(row) + "\n", "utf-8");
        console.log(
          `[${done}/${totalCells}] ${waveId} ${task.id} ${arm}: valid=${row.valid} solved=${row.solved} (${row.hidden_passed}/${row.hidden_total}) ` +
            `edit=${row.edit_calls}(ref=${row.edit_refusals}) chg=${row.worktree_changed} bucket=${row.bucket}/${row.stop_reason} ${row.wall_s}s`
        );
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const summary = {
    suite: opts.suite,
    started_at: startedAt,
    finished_at: finishedAt,
    model: opts.model,
    endpoint: opts.endpoint,
    harness: rows.find((r) => r.harness)?.harness || "",
    waves: opts.waves,
    tasks: tasks.map((t) => t.id),
    arms: summarize(rows, arms),
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary.arms, null, 2));
}

main();

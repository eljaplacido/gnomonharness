#!/usr/bin/env node
/**
 * stall_replay.mjs: the LP5 stall detectors, replayed over recorded trails.
 *
 * Runs packages/gnomon-core/dist/stall_signals.js, the module the loop runs,
 * over the `tool_call` records of finished benchmark runs, and asks how well
 * its flags anticipate the outcome. The loop feeds that module exactly the
 * fields a metadata-mode `tool_call` record carries, so this is the live
 * computation, not a model of it (see the module's doc for what that costs).
 *
 *   pnpm -r run build
 *   node benchmarks/analysis/stall_replay.mjs <results-root> [--out <dir>]
 *
 * <results-root> holds the campaign directories (`r1h-2026-11/`, ...). It is
 * read and never written. --out writes replay.json and replay.md there.
 *
 * ── PRE-REGISTRATION ─ written 2026-11-04, before this script read an outcome ──
 *
 * DATA. Terminal-Bench campaigns in the `<name>-2026-11/runs[-...]/` layout:
 * `runs/<cell>/<task>/<trial>/agent-logs/audit/task-*.jsonl`, with the trial's
 * `results.json` (is_resolved, failure_mode) beside `agent-logs/`. Only the
 * measured run directories `runs/` and `runs-a3/` count; `runs-smoke*`,
 * `runs-aborted`, `runs-dev` do not. p2/p2g are excluded: a different (Harbor)
 * layout, and p2g is still running. Campaigns on master before 2026-11 hold
 * summaries, not per-call trails (one trail in total, auditability-2026-08-31,
 * with no outcome), so they cannot be replayed.
 *
 * UNIT. A step is one executed tool call: the index of its `tool_call` record
 * in the trail, from 1. That is the loop's `steps`, the unit of
 * `first_nudge_step`. "Turns" in the LP5 text are read as steps.
 *
 * STREAMS. A delegated turn (the `task` tool) writes its calls into the same
 * trail under its own role, before the parent's `task` record. Live, it has its
 * own detectors. So the replay keeps one detector per role and drops every
 * other role's detector when a `task` record arrives. A run is flagged at the
 * earliest step (trail index) any stream fires.
 *
 * CLASSES, per run with a results.json:
 * - success: is_resolved === true;
 * - failed: is_resolved === false;
 * - stall_or_cap, the LP5 positive class, a subset of failed: the turn's
 *   stop_reason is stall, step_wall or cancelled (a benchmark has no operator
 *   to press Esc: a cancel is the adapter's time cap), or failure_mode is
 *   agent_timeout;
 * - unscored: no is_resolved. Counted, never in a denominator.
 *
 * METRICS, per campaign, for the composite flag ANY (any detector) and for
 * each detector alone. Every share with a Wilson 95% interval.
 * - recall_sc: share of stall_or_cap runs flagged at least 2 steps before
 *   their last call (lead = last step - first flag step >= 2);
 * - recall_failed: the same over all failed runs;
 * - fire_success: share of successful runs flagged at any step;
 * - lead: median and IQR of (last step - first flag) over flagged
 *   stall_or_cap runs;
 * - vs_nudge: among stall_or_cap runs flagged with lead >= 2, the share
 *   flagged at least 2 steps before the existing idle nudge, or where no
 *   nudge fired; and the median (nudge step - flag step) where one did.
 *   The nudge step is simulated from the trail with the loop's rule
 *   (nudge_after_idle = 12 in every campaign's surface) after each call; the
 *   loop checks after each batch, so the live nudge is at or after the
 *   simulated one, and this comparison can only understate the lead.
 *   Agreement with the recorded `first_nudge_step` is reported.
 * - the existing nudge's own recall_sc and fire_success, as a baseline row.
 *
 * SUCCESS CRITERION (LP5): recall_sc >= 30% and fire_success < 5%, on the
 * HELD-OUT campaign, at the tuned thresholds. Read on the point estimates;
 * the interval bounds are reported beside them and decide nothing.
 *
 * SPLIT. Tune on r1h-2026-11. Hold out m1-2026-11 (runs/ and runs-a3/): other
 * local models, other arms, a later build. Every other campaign is reported
 * as further out-of-sample evidence and is not used for tuning.
 *
 * A-PRIORI THRESHOLDS: STALL_SIGNAL_THRESHOLDS in stall_signals.ts
 * (cycle_min_calls 6, cycle_min_periods 2, periods 2-4, no_progress_calls 8,
 * cusum_k 0.5, cusum_h 4). Reported untuned on every campaign as well.
 *
 * GRID, joint over the three detectors (448 points); "off" disables one:
 *   cycle_min_calls    6, 8, 10, off
 *   no_progress_calls  6, 8, 10, 12, 16, 20, off
 *   (cusum_k, cusum_h) {0.4, 0.5, 0.6} x {3, 4, 6, 8, 12}, or off
 * OBJECTIVE on the tuning campaign, for ANY: among points with
 * fire_success <= 5%, the highest recall_sc; ties by recall_failed, then by
 * median lead, then by grid order. If no point reaches 5%: the lowest
 * fire_success, ties by recall_sc. The pick is then applied, unchanged, to
 * the held-out campaign.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const MODULE = join(REPO, "packages/gnomon-core/dist/stall_signals.js");
if (!existsSync(MODULE)) {
  console.error(`missing ${MODULE}: run \`pnpm -r run build\` first`);
  process.exit(2);
}
const { StallSignals, STALL_SIGNAL_THRESHOLDS, STALL_SIGNAL_NAMES } = await import(pathToFileURL(MODULE).href);

const TUNE = "r1h";
const HELD_OUT = "m1";
const RUN_DIRS = ["runs", "runs-a3"];
const EXCLUDED = { p2: "Harbor layout; campaign in progress", p2g: "Harbor layout; campaign in progress" };
const NUDGE_AFTER_IDLE = 12;
const LEAD_MIN = 2;
const SUCCESS_MAX = 0.05;
const RECALL_MIN = 0.3;
const SC_STOPS = new Set(["stall", "step_wall", "cancelled"]);

const args = process.argv.slice(2);
const root = args[0];
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
if (!root || !existsSync(root)) {
  console.error("usage: node benchmarks/analysis/stall_replay.mjs <results-root> [--out <dir>]");
  process.exit(2);
}

// ── Grid ────────────────────────────────────────────────────────────────────
const OFF = Infinity;
function thresholds({ cycle, np, k, h }) {
  return {
    cycle_periods: cycle === OFF ? [] : STALL_SIGNAL_THRESHOLDS.cycle_periods,
    cycle_min_calls: cycle === OFF ? 0 : cycle,
    cycle_min_periods: STALL_SIGNAL_THRESHOLDS.cycle_min_periods,
    no_progress_calls: np,
    cusum_k: k,
    cusum_h: h,
  };
}
const GRID = [];
for (const cycle of [6, 8, 10, OFF])
  for (const np of [6, 8, 10, 12, 16, 20, OFF])
    for (const kh of [
      ...[0.4, 0.5, 0.6].flatMap((k) => [3, 4, 6, 8, 12].map((h) => [k, h])),
      [0.5, OFF],
    ])
      GRID.push({ cycle, np, k: kh[0], h: kh[1] });
const A_PRIORI = {
  cycle: STALL_SIGNAL_THRESHOLDS.cycle_min_calls,
  np: STALL_SIGNAL_THRESHOLDS.no_progress_calls,
  k: STALL_SIGNAL_THRESHOLDS.cusum_k,
  h: STALL_SIGNAL_THRESHOLDS.cusum_h,
};
const fmtPoint = (p) =>
  `cycle_min_calls=${p.cycle === OFF ? "off" : p.cycle} no_progress_calls=${p.np === OFF ? "off" : p.np} ` +
  `cusum=${p.h === OFF ? "off" : `k${p.k}/h${p.h}`}`;

// ── Discovery ───────────────────────────────────────────────────────────────
function findTrails(dir, depth = 0, out = []) {
  if (depth > 7) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "checkpoints") continue;
      findTrails(p, depth + 1, out);
    } else if (/^task-.*\.jsonl$/.test(e.name) && basename(dir) === "audit" && basename(dirname(dir)) === "agent-logs") {
      out.push(p);
    }
  }
  return out;
}

function readJsonl(path) {
  const recs = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      /* a torn last line: skipped */
    }
  }
  return recs;
}

function loadRun(trailPath, campaign) {
  const trial = dirname(dirname(dirname(trailPath)));
  const recs = readJsonl(trailPath);
  const calls = recs.filter((r) => r.kind === "tool_call");
  const turn = [...recs].reverse().find((r) => r.kind === "turn");
  const start = recs.find((r) => r.kind === "session_start");
  let resolved;
  let failure_mode;
  try {
    const res = JSON.parse(readFileSync(join(trial, "results.json"), "utf-8"));
    resolved = typeof res.is_resolved === "boolean" ? res.is_resolved : undefined;
    failure_mode = res.failure_mode;
  } catch {
    /* no results.json: unscored */
  }
  const stop = turn?.stop_reason;
  const scored = resolved !== undefined;
  const success = resolved === true;
  const failed = resolved === false;
  const sc = failed && (SC_STOPS.has(stop) || failure_mode === "agent_timeout");
  return {
    campaign,
    trail: trailPath,
    harness: start?.harness,
    calls,
    top_role: turn?.role ?? start?.role,
    recorded_first_nudge: turn?.counters?.first_nudge_step,
    stop_reason: stop,
    failure_mode,
    scored,
    success,
    failed,
    sc,
  };
}

// ── Replay: the module, per stream ──────────────────────────────────────────
function replay(run, t) {
  const streams = new Map();
  const first = Object.fromEntries(STALL_SIGNAL_NAMES.map((n) => [n, undefined]));
  let nudge;
  let topNudgeLocal;
  const stream = (role) => {
    let s = streams.get(role);
    if (!s) {
      s = { det: new StallSignals(t), local: 0, since: 0, atNudge: 0 };
      streams.set(role, s);
    }
    return s;
  };
  run.calls.forEach((r, i) => {
    const step = i + 1;
    const role = r.role ?? "?";
    if (r.tool === "task") for (const k of [...streams.keys()]) if (k !== role) streams.delete(k);
    const s = stream(role);
    s.local++;
    const obs = {
      tool: String(r.tool ?? ""),
      target: String(r.target ?? ""),
      code: Number(r.code),
      summary: String(r.summary ?? ""),
      worktree_changed: r.worktree_changed,
    };
    for (const f of s.det.observe(obs, s.local)) first[f.signal] ??= step;
    // The idle nudge, as prompt_loop.ts counts it.
    s.since++;
    if ((obs.tool === "write" || obs.tool === "edit") && obs.code === 0) {
      s.since = 0;
      s.atNudge = 0;
    } else if (obs.worktree_changed === true) {
      s.since = 0;
      s.atNudge = 0;
    } else if (obs.worktree_changed === null) {
      s.since--;
    }
    if (s.since - s.atNudge >= NUDGE_AFTER_IDLE) {
      s.atNudge = s.since;
      nudge ??= step;
      if (role === run.top_role && topNudgeLocal === undefined) topNudgeLocal = s.local;
    }
  });
  const fired = Object.values(first).filter((v) => v !== undefined);
  return { first, any: fired.length ? Math.min(...fired) : undefined, nudge, topNudgeLocal };
}

// ── Statistics ──────────────────────────────────────────────────────────────
function wilson(k, n, z = 1.96) {
  if (n === 0) return [null, null];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const share = (k, n) => ({ k, n, p: n ? k / n : null, ci: wilson(k, n) });
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Metrics for one flag (a step per run, or undefined) over a set of runs. */
function metrics(runs, flagOf, nudgeOf) {
  const scored = runs.filter((r) => r.scored);
  const sc = scored.filter((r) => r.sc);
  const failed = scored.filter((r) => r.failed);
  const success = scored.filter((r) => r.success);
  const early = (r) => {
    const f = flagOf(r);
    return f !== undefined && r.calls.length - f >= LEAD_MIN;
  };
  const scEarly = sc.filter(early);
  const leads = scEarly.map((r) => r.calls.length - flagOf(r));
  const beforeNudge = scEarly.filter((r) => {
    const n = nudgeOf(r);
    return n === undefined || n - flagOf(r) >= LEAD_MIN;
  });
  const nudgeLeads = scEarly.filter((r) => nudgeOf(r) !== undefined).map((r) => nudgeOf(r) - flagOf(r));
  return {
    recall_sc: share(scEarly.length, sc.length),
    recall_failed: share(failed.filter(early).length, failed.length),
    fire_success: share(success.filter((r) => flagOf(r) !== undefined).length, success.length),
    lead_median: quantile(leads, 0.5),
    lead_iqr: [quantile(leads, 0.25), quantile(leads, 0.75)],
    before_nudge: share(beforeNudge.length, scEarly.length),
    vs_nudge_median: quantile(nudgeLeads, 0.5),
  };
}

function evaluate(runs, point) {
  const t = thresholds(point);
  const rep = new Map(runs.map((r) => [r, replay(r, t)]));
  const nudgeOf = (r) => rep.get(r).nudge;
  const out = { ANY: metrics(runs, (r) => rep.get(r).any, nudgeOf) };
  for (const n of STALL_SIGNAL_NAMES) out[n] = metrics(runs, (r) => rep.get(r).first[n], nudgeOf);
  out.existing_nudge = metrics(runs, nudgeOf, nudgeOf);
  return out;
}

// ── Load ────────────────────────────────────────────────────────────────────
const campaigns = new Map();
const inventory = [];
for (const dir of readdirSync(root).sort()) {
  const m = /^(.+)-2026-11$/.exec(dir);
  if (!m || !statSync(join(root, dir)).isDirectory()) continue;
  const name = m[1];
  if (EXCLUDED[name]) {
    inventory.push({ campaign: name, excluded: EXCLUDED[name] });
    continue;
  }
  const trails = RUN_DIRS.flatMap((d) => (existsSync(join(root, dir, d)) ? findTrails(join(root, dir, d)) : []));
  if (!trails.length) {
    inventory.push({ campaign: name, trails: 0 });
    continue;
  }
  const runs = trails.map((p) => loadRun(p, name));
  const usable = runs.filter((r) => r.calls.length > 0);
  const bash = usable.flatMap((r) => r.calls.filter((c) => c.tool === "bash"));
  inventory.push({
    campaign: name,
    trails: runs.length,
    with_calls: usable.length,
    scored: usable.filter((r) => r.scored).length,
    success: usable.filter((r) => r.success).length,
    failed: usable.filter((r) => r.failed).length,
    stall_or_cap: usable.filter((r) => r.sc).length,
    bash_stamped: bash.length ? bash.filter((c) => "worktree_changed" in c).length / bash.length : null,
    bash_target_truncated: bash.length ? bash.filter((c) => String(c.target ?? "").endsWith("…")).length / bash.length : null,
    builds: [...new Set(usable.map((r) => r.harness))].sort(),
  });
  campaigns.set(name, usable);
}
for (const need of [TUNE, HELD_OUT]) {
  if (!campaigns.has(need)) {
    console.error(`campaign ${need} not found under ${root}`);
    process.exit(2);
  }
}

// ── Nudge simulation check ──────────────────────────────────────────────────
const nudgeCheck = { compared: 0, exact: 0, within3: 0, sim_never_rec_did: 0, sim_did_rec_never: 0 };
for (const runs of campaigns.values()) {
  for (const r of runs) {
    if (new Set(r.calls.map((c) => c.role)).size !== 1) continue;
    const sim = replay(r, thresholds(A_PRIORI)).topNudgeLocal;
    const rec = r.recorded_first_nudge;
    if (sim === undefined && rec === undefined) continue;
    nudgeCheck.compared++;
    if (sim === undefined) nudgeCheck.sim_never_rec_did++;
    else if (rec === undefined) nudgeCheck.sim_did_rec_never++;
    else {
      if (sim === rec) nudgeCheck.exact++;
      if (Math.abs(sim - rec) <= 3) nudgeCheck.within3++;
    }
  }
}

// ── Tune ────────────────────────────────────────────────────────────────────
const tuneRuns = campaigns.get(TUNE);
const scored = GRID.map((point, order) => ({ point, order, m: evaluate(tuneRuns, point).ANY }));
const feasible = scored.filter((s) => s.m.fire_success.p !== null && s.m.fire_success.p <= SUCCESS_MAX);
const cmp = (a, b) =>
  b.m.recall_sc.p - a.m.recall_sc.p ||
  b.m.recall_failed.p - a.m.recall_failed.p ||
  (b.m.lead_median ?? -1) - (a.m.lead_median ?? -1) ||
  a.order - b.order;
const pick = feasible.length
  ? [...feasible].sort(cmp)[0]
  : [...scored].sort((a, b) => a.m.fire_success.p - b.m.fire_success.p || b.m.recall_sc.p - a.m.recall_sc.p || a.order - b.order)[0];
const TUNED = pick.point;

// ── Report ──────────────────────────────────────────────────────────────────
const result = {
  generated: new Date().toISOString(),
  module: "packages/gnomon-core/dist/stall_signals.js",
  a_priori: A_PRIORI,
  tune_campaign: TUNE,
  held_out_campaign: HELD_OUT,
  grid_points: GRID.length,
  feasible_on_tune: feasible.length,
  tuned: TUNED,
  inventory,
  nudge_simulation_check: nudgeCheck,
  campaigns: {},
};
for (const [name, runs] of campaigns) {
  result.campaigns[name] = {
    role: name === TUNE ? "tune" : name === HELD_OUT ? "held-out" : "other",
    a_priori: evaluate(runs, A_PRIORI),
    tuned: evaluate(runs, TUNED),
  };
}
const ho = result.campaigns[HELD_OUT].tuned.ANY;
result.criterion = {
  recall_sc: ho.recall_sc,
  fire_success: ho.fire_success,
  met: ho.recall_sc.p !== null && ho.recall_sc.p >= RECALL_MIN && ho.fire_success.p !== null && ho.fire_success.p < SUCCESS_MAX,
};

const pct = (s) => (s.p === null ? "n/a" : `${(100 * s.p).toFixed(0)}% (${s.k}/${s.n})`);
const ci = (s) => (s.ci[0] === null ? "" : `[${(100 * s.ci[0]).toFixed(0)}, ${(100 * s.ci[1]).toFixed(0)}]`);
const num = (x) => (x === null || x === undefined ? "n/a" : Number.isInteger(x) ? String(x) : x.toFixed(1));
const lines = [];
lines.push(`# Stall-signal replay (LP5)`, ``);
lines.push(`Module: \`${result.module}\`. Tune: **${TUNE}**. Held out: **${HELD_OUT}**.`);
lines.push(`A priori: ${fmtPoint(A_PRIORI)}.`);
lines.push(`Tuned (${feasible.length}/${GRID.length} grid points met fire_success <= 5% on ${TUNE}): **${fmtPoint(TUNED)}**.`, ``);
lines.push(`## Inventory`, ``);
lines.push(`| campaign | trails | with calls | scored | success | failed | stall_or_cap | bash stamped | bash target cut | builds |`);
lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
for (const i of inventory) {
  if (i.excluded) lines.push(`| ${i.campaign} | excluded: ${i.excluded} |||||||||`);
  else if (!i.trails) lines.push(`| ${i.campaign} | 0 |||||||||`);
  else
    lines.push(
      `| ${i.campaign} | ${i.trails} | ${i.with_calls} | ${i.scored} | ${i.success} | ${i.failed} | ${i.stall_or_cap} | ` +
        `${i.bash_stamped === null ? "n/a" : `${(100 * i.bash_stamped).toFixed(0)}%`} | ` +
        `${i.bash_target_truncated === null ? "n/a" : `${(100 * i.bash_target_truncated).toFixed(0)}%`} | ${i.builds.join(", ")} |`
    );
}
lines.push(``, `Nudge simulation vs recorded \`first_nudge_step\` (single-role runs where either fired): ` +
  `${nudgeCheck.compared} compared, ${nudgeCheck.exact} exact, ${nudgeCheck.within3} within 3 steps, ` +
  `${nudgeCheck.sim_never_rec_did} recorded-only, ${nudgeCheck.sim_did_rec_never} simulated-only.`, ``);
for (const which of ["tuned", "a_priori"]) {
  lines.push(`## ${which === "tuned" ? "Tuned thresholds" : "A-priori thresholds"}`, ``);
  lines.push(`| campaign | role | flag | recall stall/cap, lead >= 2 [95% CI] | fire on success [95% CI] | recall failed | lead median (IQR) | >= 2 before nudge | nudge - flag median |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  const order = [TUNE, HELD_OUT, ...[...campaigns.keys()].filter((c) => c !== TUNE && c !== HELD_OUT)];
  for (const c of order) {
    const block = result.campaigns[c][which];
    for (const flag of ["ANY", ...STALL_SIGNAL_NAMES, "existing_nudge"]) {
      const m = block[flag];
      lines.push(
        `| ${c} | ${result.campaigns[c].role} | ${flag} | ${pct(m.recall_sc)} ${ci(m.recall_sc)} | ` +
          `${pct(m.fire_success)} ${ci(m.fire_success)} | ${pct(m.recall_failed)} | ` +
          `${num(m.lead_median)} (${num(m.lead_iqr[0])}-${num(m.lead_iqr[1])}) | ` +
          `${flag === "existing_nudge" ? "-" : pct(m.before_nudge)} | ${flag === "existing_nudge" ? "-" : num(m.vs_nudge_median)} |`
      );
    }
  }
  lines.push(``);
}
lines.push(
  `## Criterion (held out: ${HELD_OUT}, tuned, ANY)`,
  ``,
  `recall stall/cap ${pct(ho.recall_sc)} ${ci(ho.recall_sc)} (needs >= 30%); ` +
    `fire on success ${pct(ho.fire_success)} ${ci(ho.fire_success)} (needs < 5%): ` +
    `**${result.criterion.met ? "MET" : "NOT MET"}**.`
);
const md = lines.join("\n") + "\n";
process.stdout.write(md);
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "replay.json"), JSON.stringify(result, null, 1) + "\n");
  writeFileSync(join(outDir, "replay.md"), md);
  console.error(`wrote ${join(outDir, "replay.json")} and replay.md`);
}

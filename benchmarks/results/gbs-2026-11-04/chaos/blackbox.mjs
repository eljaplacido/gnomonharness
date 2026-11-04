#!/usr/bin/env node
/**
 * GBS-CHAOS 0.1, arm B: the black-box procedure of CHAOS.md §6, run on gnomon.
 *
 * This is the runner a peer harness would be put through. The endpoint is
 * `gnomon chaos serve` (any harness can point at it); the plan and each
 * fault's naming pattern come from `gnomon chaos list --json` (the published
 * contract, §9); the scoring is CHAOS.md §4, re-implemented here from the spec
 * text, not imported from gnomon. Only ADAPTER below is harness-specific:
 *
 *   adapter.setup(projectDir, url)  write the harness's config pointing at url
 *   adapter.run(projectDir, input, {task, stream})
 *        -> { exit, stop_reason, degradations: string[], trace: string[], output }
 *
 * Usage: node blackbox.mjs --seed 1 --out raw/blackbox-seed1.json [--work <dir>]
 * Needs: gnomon on PATH (the build under test; it serves the endpoint), node >= 20.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, xs) => (x.startsWith("--") ? [...a, [x.slice(2), xs[i + 1]]] : a), []));
const seed = Number(args.seed ?? 1);
const out = args.out ?? `blackbox-seed${seed}.json`;
const work = args.work ?? mkdtempSync(join(tmpdir(), "gbs-chaos-bb-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The adapter: gnomon, run exactly as `gnomon task --json` is run by a CI job ──
const corePath = spawnSync("sh", ["-c", 'dirname "$(dirname "$(readlink -f "$(command -v gnomon)")")"'], { encoding: "utf-8" }).stdout.trim();
const ADAPTER = {
  name: "gnomon",
  async setup(dir, url) {
    // The reference surface of CHAOS.md §6 / chaos_suite.ts, pointed at the served endpoint.
    const core = await import(pathToFileURL(join(corePath, "..", "gnomon-core", "dist", "index.js")).href);
    for (const [rel, content] of Object.entries(core.chaosSurfaceFiles(url))) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    this.config_hash = createHash("sha256").update(JSON.stringify(core.chaosSurfaceFiles("<chaos-endpoint>"))).digest("hex");
  },
  run(dir, input, { stream }) {
    return new Promise((resolve) => {
      const p = spawn("gnomon", ["task", input, "--json", "--yes", "--trust", "--role", stream ? "chaos_stream" : "chaos"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let so = "", se = "";
      p.stdout.on("data", (d) => (so += d));
      p.stderr.on("data", (d) => (se += d));
      p.on("close", (code) => {
        let rec = {};
        try { rec = JSON.parse(so); } catch { rec = { stop_reason: "(no JSON record)" }; }
        resolve({
          exit: code,
          stop_reason: String(rec.stop_reason),
          degradations: (rec.degradations ?? []).map((d) => String(d.id ?? d)),
          trace: se.split(/\r?\n/).filter((l) => l.trim() !== ""),
          output: typeof rec.output === "string" ? rec.output : JSON.stringify(rec.output ?? ""),
        });
      });
    });
  },
};
// --trust: the reference surface grants approval = "never" and a [verify] command, which an
// untrusted surface runs CLAMPED to the defaults (stderr says so); the in-process suite never
// meets that clamp. Without --trust the fix task cannot finish (found in the seed-999 smoke run).
// Channel mapping published with the result (§6): stop reason = record.stop_reason
// ("answered" is normal completion); declared degradations = record.degradations[].id;
// trace = stderr, line by line.

// ── The endpoint ──
const list = JSON.parse(spawnSync("gnomon", ["chaos", "list", "--json"], { encoding: "utf-8" }).stdout);
const logFile = join(work, "serve.jsonl");
const srv = spawn("gnomon", ["chaos", "serve", "--port", "0", "--seed", String(seed), "--log", logFile], { stdio: ["ignore", "ignore", "pipe"] });
let banner = "";
srv.stderr.on("data", (d) => (banner += d));
for (let i = 0; i < 100 && !/fix needs/.test(banner); i++) await sleep(50);
const url = /(http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions)/.exec(banner)?.[1];
const token = /CHAOS-OK ([A-Z0-9]+)/.exec(banner)?.[1];
if (!url || !token) { console.error("serve did not start:\n" + banner); srv.kill(); process.exit(2); }
const base = url.replace(/\/v1\/chat\/completions$/, "");
const post = async (body) => (await fetch(`${base}/chaos/case`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const span = async () => { await sleep(300); return (await fetch(`${base}/chaos/log`)).json(); }; // 300 ms: the in-process suite's takeLog grace

const inputOf = (task) => ({
  answer: `Reply with exactly: CHAOS-OK ${token} [chaos-task answer ${token}]`,
  read: `Read chaos/input.txt and reply with CHAOS-READ and the value it holds. [chaos-task read ${token}]`,
  fix: `Write ${token} to chaos/out.txt; the declared check verifies it. [chaos-task fix ${token}]`,
})[task];
const fileValue = `CHAOSVAL-${token.split("").reverse().join("")}`;
const expected = (task) => ({ answer: `CHAOS-OK ${token}`, read: `CHAOS-READ ${fileValue}`, fix: `CHAOS-FIXED ${token}` })[task];

const projects = [join(work, "project"), join(work, "lane-a"), join(work, "lane-b")];
for (const p of projects) { mkdirSync(p, { recursive: true }); await ADAPTER.setup(p, url); }
function fixtures(dir) {
  mkdirSync(join(dir, "chaos"), { recursive: true });
  writeFileSync(join(dir, "chaos/input.txt"), `${fileValue}\n`);
  writeFileSync(join(dir, "chaos/expected.txt"), `${token}\n`);
  rmSync(join(dir, "chaos/out.txt"), { force: true });
}
async function observe(dir, task, stream, body) {
  if (body) await post(body);
  fixtures(dir);
  const t0 = Date.now();
  const o = await ADAPTER.run(dir, inputOf(task), { task, stream });
  const ms = Date.now() - t0;
  const endpoint = body ? await span() : null;
  let outFile = null;
  try { outFile = readFileSync(join(dir, "chaos/out.txt"), "utf-8").trim(); } catch {}
  o.recovered = o.output.includes(expected(task)) && (task !== "fix" || outFile === token);
  return { ...o, endpoint, ms };
}

// ── §4 scoring, from the spec text ──
const re = (src, flags) => new RegExp(src, flags);
function score(fault, b, o, flags = "i") {
  const channels = [];
  if (o.exit !== b.exit) channels.push("exit");
  if (o.stop_reason !== b.stop_reason) channels.push("stop_reason");
  const newDeg = [...new Set(o.degradations.filter((d) => !b.degradations.includes(d)))];
  if (newDeg.length) channels.push("degradation");
  const seen = new Set(b.trace);
  const newTrace = o.trace.filter((l) => !seen.has(l));
  const naming = newTrace.filter((l) => re(fault.names, flags).test(l));
  if (naming.length) channels.push("trace");
  const fired = (o.endpoint?.fired ?? 0) > 0;
  return {
    fired, announced: channels.length > 0, channels,
    named: naming.length > 0 || newDeg.some((d) => (fault.degradations ?? []).includes(d)),
    recovered: o.recovered, silent: fired && channels.length === 0, new_trace: newTrace, new_degradations: newDeg,
  };
}

const card = { schema: "gbs-chaos-blackbox/0", spec: "GBS-CHAOS 0.1", arm: "B", adapter: ADAPTER.name, seed, token, endpoint: url,
  harness: spawnSync("gnomon", ["--version"], { encoding: "utf-8" }).stdout.trim(), problems: [], baselines: [], controls: [], lane_check: {}, cases: [] };
try {
  const plan = [];
  for (const f of list.faults) for (const s of f.schedules) plan.push({ id: `${f.id}/${s}`, fault: f, schedule: s, task: f.task, stream: f.stream });
  card.plan_cases = plan.length;
  card.config_hash = ADAPTER.config_hash;

  // Clean runs per (task, transport)
  const key = (t, s) => `${t}:${s ? "stream" : "json"}`;
  const need = new Map([[key("answer", false), ["answer", false]]]);
  for (const c of plan) need.set(key(c.task, c.stream), [c.task, c.stream]);
  const baselines = new Map();
  for (const [k, [t, s]] of need) {
    const o = await observe(projects[0], t, s, {});
    baselines.set(k, o);
    card.baselines.push({ key: k, exit: o.exit, stop_reason: o.stop_reason, recovered: o.recovered, requests: o.endpoint.requests.length, billed: o.endpoint.tokens.billed, trace_lines: o.trace.length });
    if (!o.recovered) card.problems.push(`clean ${k} did not finish (exit ${o.exit}, ${o.stop_reason})`);
  }

  // §5.1 negative controls, through this scorer, on the real clean answer/json run
  const b0 = baselines.get(key("answer", false));
  const err = list.faults.find((f) => f.id === "error"), rate = list.faults.find((f) => f.id === "rate_limit");
  const fired = { ...b0, endpoint: { ...b0.endpoint, fired: 1 } };
  card.controls = [
    ["a run identical to the clean run scores silent", false, score(err, b0, fired).announced],
    ["a trace line naming the wrong fault scores silent", false, score(rate, b0, { ...fired, trace: [...b0.trace, "  [retry] endpoint unreachable — attempt 1 of 3, waiting 20ms"] }).announced],
    ["a changed exit status scores announced", true, score(err, b0, { ...fired, exit: b0.exit === 10 ? 0 : 10 }).announced],
  ].map(([name, expected, scored]) => ({ name, expected, scored, ok: expected === scored }));
  for (const c of card.controls) if (!c.ok) card.problems.push(`control failed: ${c.name}`);

  // §5.2 lane check: serial vs concurrent is runnable black-box; the garbling control is not
  await post({});
  const serial = await observe(projects[1], "answer", false, null);
  const pair = await Promise.all([observe(projects[1], "answer", false, null), observe(projects[2], "answer", false, null)]);
  const lane = await span();
  const overlapped = lane.requests.length >= 3; // serial + two concurrent; overlap itself cannot be forced without the latency option
  card.lane_check = {
    serial_equals_concurrent: pair.every((o) => o.output === serial.output && o.exit === serial.exit),
    requests_seen: lane.requests.length,
    overlap_forced: false,
    garbling_caught: "not runnable: POST /chaos/case takes fault, schedule and seed only — no latency or garbling option",
  };
  card.problems.push("§5.2 lane check incomplete through `chaos serve` (no garbling control): void by the spec as written (pre-registered)");
  void overlapped;

  // The cases
  for (const c of plan) {
    const b = baselines.get(key(c.task, c.stream));
    const o = await observe(projects[0], c.task, c.stream, { fault: c.fault.id, schedule: c.schedule, seed });
    const v = score(c.fault, b, o);
    const vNoFlag = score(c.fault, b, o, "");
    const billed = o.endpoint.tokens.billed;
    card.cases.push({
      id: c.id, fault: c.fault.id, schedule: c.schedule, task: c.task, stream: c.stream,
      fired: v.fired, injected: o.endpoint.fired, requests: o.endpoint.requests.length,
      announced: v.announced, named: v.named, channels: v.channels, recovered: v.recovered, silent: v.silent,
      named_if_pattern_compiled_without_i_flag: vNoFlag.named,
      exit: o.exit, stop_reason: o.stop_reason, degradations: v.new_degradations,
      tokens: { billed, baseline: b.endpoint.tokens.billed, wasted: v.recovered ? Math.max(0, billed - b.endpoint.tokens.billed) : billed },
      leaked: o.endpoint.leaked, ms: o.ms, new_trace: v.new_trace.slice(0, 12),
    });
    if (!v.fired) card.problems.push(`${c.id} never fired`);
    process.stderr.write(`${v.fired ? (v.silent ? "SILENT   " : "announced") : "NOT FIRED"} ${c.id} ${v.channels.join("+")}\n`);
  }
  const f = card.cases.filter((r) => r.fired), failed = f.filter((r) => !r.recovered);
  const byFault = {};
  for (const r of card.cases) (byFault[r.fault] ??= []).push(r);
  card.faults = Object.entries(byFault).map(([id, rs]) => {
    const fr = rs.filter((r) => r.fired);
    return { id, cases: rs.length, fired: fr.length, announced: fr.filter((r) => r.announced).length, named: fr.filter((r) => r.named).length, recovered: fr.filter((r) => r.recovered).length,
      verdict: fr.length === 0 ? "not_fired" : fr.some((r) => r.silent) ? "silent" : "announced" };
  });
  card.summary = {
    faults: card.faults.length, faults_announced: card.faults.filter((x) => x.verdict === "announced").length,
    faults_silent: card.faults.filter((x) => x.verdict === "silent").map((x) => x.id),
    cases: card.cases.length, cases_fired: f.length, cases_announced: f.filter((r) => r.announced).length,
    cases_named: f.filter((r) => r.named).length, cases_named_without_i_flag: f.filter((r) => r.named_if_pattern_compiled_without_i_flag).length,
    cases_recovered: f.filter((r) => r.recovered).length, failed: failed.length, silent_failures: failed.filter((r) => r.silent).length,
    leaked: card.cases.reduce((a, r) => a + r.leaked, 0),
  };
} finally {
  srv.kill("SIGTERM");
  card.void = card.problems.length > 0;
  writeFileSync(out, JSON.stringify(card, null, 2) + "\n");
  appendFileSync(out.replace(/\.json$/, ".serve-log-path.txt"), logFile + "\n");
}
console.log(JSON.stringify(card.summary ?? card.problems));

#!/usr/bin/env node
// THE PERF GATE: head against the previous release, interleaved, on one runner,
// with a model that answers at once (no network, no cost), so what is measured
// is the harness: startup, per-request overhead, exit.
//
//   node scripts/perf_gate.mjs --head <gnomon bin> --prev <gnomon bin> [--n 15]
//
// Arms, each run N times, interleaved round by round with the order rotated,
// after two untimed warm-ups per arm:
//
//   warm     one `gnomon task` turn, the endpoint's window DECLARED
//            (max_context_tokens), so no window lookup happens
//   session  a 10-turn scripted session (ten `cat` tool calls, then "Done")
//   lookup   one turn with the window UNDECLARED and the endpoint's /models
//            answering after 200 ms: the case 0.6.6-rc regressed (a blocking
//            window lookup, +0.3 to +10 s, caught only by a manual overhead
//            check, benchmarks/results/ux4-2026-11). It stays here so that
//            cannot reach a release again.
//
// Per run: wall, CPU (user+system) and peak RSS, from GNU time. Per arm and
// metric: the median of the PAIRED differences (head minus prev, same round).
//
// FAILS (exit 1) when, for wall or CPU, head's paired median difference
// exceeds BOTH 15% of the previous release's median AND 30 ms. Both, so
// runner noise (a 5% wobble on a 200 ms run is 10 ms) cannot fail a build and a
// real 70 ms regression cannot hide inside a percentage. Peak RSS fails on
// 15% AND 10 MB. The table is always printed. Linux only (GNU time, /proc).

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const HEAD = opt("head") && resolve(opt("head"));
const PREV = opt("prev") && resolve(opt("prev"));
const N = Number(opt("n", "15"));
const PCT = Number(opt("pct", "0.15"));
const MS = Number(opt("ms", "30"));
const MB = Number(opt("mb", "10"));
const SESSION_TURNS = 10;
const MODELS_DELAY_MS = 200;
if (!HEAD || !PREV || !(N >= 15)) {
  console.error("usage: perf_gate.mjs --head <gnomon> --prev <gnomon> [--n >=15]");
  process.exit(2);
}
if (process.platform !== "linux") {
  console.error("perf gate: Linux only (GNU time).");
  process.exit(2);
}

const BASE = mkdtempSync(join(tmpdir(), "gnomon-perf-"));

// ── the model: instant, OpenAI wire format, scripted tool calls for the session
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    res.setHeader("content-type", "application/json");
    const url = req.url ?? "";
    if (url.endsWith("/models")) {
      await sleep(MODELS_DELAY_MS);
      return res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model" }] }));
    }
    if (!url.includes("/chat/completions")) {
      res.statusCode = 404;
      return res.end("{}");
    }
    let j = {};
    try {
      j = JSON.parse(body);
    } catch {
      /* answer anyway */
    }
    const messages = Array.isArray(j.messages) ? j.messages : [];
    const done = messages.filter((m) => m.role === "tool").length;
    const session = /chunk_0\.txt/.test(JSON.stringify(messages.find((m) => m.role === "user") ?? ""));
    const hasBash = (j.tools ?? []).some((t) => (t.function?.name ?? t.name) === "bash");
    const msg =
      session && hasBash && done < SESSION_TURNS
        ? { role: "assistant", content: null, tool_calls: [{ id: `c${done}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `cat notes/chunk_${done}.txt` }) } }] }
        : { role: "assistant", content: session ? "Done." : "OK." };
    res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "fake-model", choices: [{ index: 0, finish_reason: msg.tool_calls ? "tool_calls" : "stop", message: msg }], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 } }));
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const PORT = server.address().port;

// ── process helpers (async: the model above lives in this process)
function exec(cmd, args, o = {}) {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeout ?? 120_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => (stderr += String(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}
const envFor = (home) => ({
  PATH: process.env.PATH,
  HOME: home,
  LANG: "C.UTF-8",
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  TERM: "dumb",
  NO_COLOR: "1",
  CI: "1",
  GNOMON_NO_UPDATE_CHECK: "1",
  ...(process.env.GNOMON_BIN_OVERRIDE ? { GNOMON_BIN_OVERRIDE: process.env.GNOMON_BIN_OVERRIDE } : {}),
});

// One scratch project per arm and mode, made by that arm's OWN `init`, then
// copied for every run so no run inherits another's sessions.
async function template(arm, bin, declared, mode) {
  const home = join(BASE, "home", arm);
  mkdirSync(home, { recursive: true });
  const dir = join(BASE, "tpl", `${arm}-${mode}`);
  mkdirSync(join(dir, "notes"), { recursive: true });
  for (let i = 0; i < SESSION_TURNS; i++) writeFileSync(join(dir, "notes", `chunk_${i}.txt`), `note ${i}\n`.repeat(200));
  writeFileSync(join(dir, "README.md"), "perf fixture\n");
  const env = envFor(home);
  const git = (...a) => exec("git", ["-c", "user.email=p@example.invalid", "-c", "user.name=p", ...a], { cwd: dir, env });
  await git("init", "-q");
  const init = await exec(bin, ["init"], { cwd: dir, env });
  if (init.code !== 0) throw new Error(`${arm}: gnomon init failed\n${init.stderr}`);
  const url = `http://127.0.0.1:${PORT}/v1`;
  const cfgPath = join(dir, ".gnomon", "config.toml");
  let cfg = readFileSync(cfgPath, "utf-8");
  cfg = `[endpoints.bench]\nurl = "${url}/chat/completions"\nkind = "openai"\n${declared ? "max_context_tokens = 131072\n" : ""}\n${cfg}`;
  cfg = cfg.replace(/\[audit\]([\s\S]*?)enabled = false/, "[audit]$1enabled = true");
  writeFileSync(cfgPath, cfg);
  const retarget = (t) => t.replace(/endpoint = "[^"]*"/g, 'endpoint = "bench"').replace(/model = "[^"]*"/g, 'model = "fake-model"');
  writeFileSync(join(dir, ".gnomon", "roles.toml"), retarget(readFileSync(join(dir, ".gnomon", "roles.toml"), "utf-8")));
  const pd = join(dir, ".gnomon", "profiles");
  try {
    for (const f of readdirSync(pd)) if (f.endsWith(".toml")) writeFileSync(join(pd, f), retarget(readFileSync(join(pd, f), "utf-8")));
  } catch {
    /* no profiles in this scaffold */
  }
  const pol = join(dir, ".gnomon", "policy.toml");
  const p = readFileSync(pol, "utf-8");
  if (!/\[approval\]/.test(p)) writeFileSync(pol, `${p}\n[approval]\ngate = "never"\n`);
  await git("add", "-A");
  await git("commit", "-q", "-m", "fixture");
  return { dir, home, env, bin };
}

const PROMPT = {
  warm: "Reply with OK.",
  session: `Read notes/chunk_0.txt through notes/chunk_${SESSION_TURNS - 1}.txt one at a time with the shell, then reply Done.`,
  lookup: "Reply with OK.",
};

// One timed run in a fresh copy of the template: wall, CPU, peak RSS from GNU time.
async function timed(t, mode, n) {
  const work = join(BASE, "run", `${mode}-${n}-${Math.random().toString(36).slice(2, 8)}`);
  cpSync(t.dir, work, { recursive: true });
  const t0 = process.hrtime.bigint();
  const r = await exec("/usr/bin/time", ["-f", "__T %e %U %S %M", t.bin, "task", PROMPT[mode], "--role", "implementor", "--yes", "--trust"], { cwd: work, env: t.env, timeout: 180_000 });
  const wallHr = Number(process.hrtime.bigint() - t0) / 1e6;
  rmSync(work, { recursive: true, force: true });
  const m = /__T (\S+) (\S+) (\S+) (\d+)\s*$/m.exec(r.stderr);
  if (r.code !== 0 || !m) throw new Error(`run failed (exit ${r.code}): ${t.bin} ${mode}\n${r.stderr.slice(-600)}`);
  return { wall: wallHr, cpu: (Number(m[2]) + Number(m[3])) * 1000, rss: Number(m[4]) / 1024 };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

async function arm(mode, declared) {
  const tpl = { prev: await template("prev", PREV, declared, mode), head: await template("head", HEAD, declared, mode) };
  const names = ["prev", "head"];
  const runMode = mode === "lookup" ? "lookup" : mode;
  for (let w = 0; w < 2; w++) for (const a of names) await timed(tpl[a], runMode, -1 - w);
  const rows = { prev: [], head: [] };
  for (let r = 0; r < N; r++) {
    // Order rotates every round, so neither build always runs on a cold cache.
    for (const a of r % 2 ? [...names].reverse() : names) rows[a].push(await timed(tpl[a], runMode, r));
  }
  return rows;
}

const RULES = { wall: { ms: MS, unit: "ms" }, cpu: { ms: MS, unit: "ms" }, rss: { ms: MB, unit: "MB" } };
const out = [];
let failed = false;
try {
  const plans = [
    ["one warm turn (window declared)", "warm", true],
    [`${SESSION_TURNS}-turn session (window declared)`, "session", true],
    [`one turn, window undeclared, /models ${MODELS_DELAY_MS} ms`, "lookup", false],
  ];
  out.push(`perf gate: head ${HEAD} vs previous ${PREV}; n=${N}, interleaved, 2 warm-ups per arm`);
  out.push(`fails when a paired median difference exceeds ${Math.round(PCT * 100)}% of the previous median AND ${MS} ms (RSS: ${MB} MB)`);
  out.push("");
  out.push("| arm | metric | previous median | head median | paired diff | diff % | verdict |");
  out.push("|---|---|---:|---:|---:|---:|---|");
  for (const [label, mode, declared] of plans) {
    const rows = await arm(mode, declared);
    for (const [metric, rule] of Object.entries(RULES)) {
      const prev = median(rows.prev.map((x) => x[metric]));
      const diff = median(rows.head.map((x, i) => x[metric] - rows.prev[i][metric]));
      const pct = prev > 0 ? diff / prev : 0;
      const bad = diff > rule.ms && pct > PCT;
      if (bad) failed = true;
      out.push(`| ${label} | ${metric} | ${prev.toFixed(0)} ${rule.unit} | ${median(rows.head.map((x) => x[metric])).toFixed(0)} ${rule.unit} | ${diff >= 0 ? "+" : ""}${diff.toFixed(0)} ${rule.unit} | ${(pct * 100).toFixed(1)}% | ${bad ? "REGRESSION" : "ok"} |`);
    }
  }
} catch (e) {
  console.error(String(e?.stack ?? e));
  failed = true;
} finally {
  server.close();
  try {
    rmSync(BASE, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* discarded with the runner */
  }
}
console.log(out.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${out.join("\n")}\n`, { flag: "a" });
  } catch {
    /* best effort */
  }
}
console.log(failed ? "\nperf gate FAILED" : "\nperf gate passed");
process.exit(failed ? 1 : 0);

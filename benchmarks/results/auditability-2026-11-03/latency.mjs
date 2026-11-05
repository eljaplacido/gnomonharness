#!/usr/bin/env node
/**
 * Does `[audit.anchor]` cost the turn anything? Off vs on, interleaved, $0.
 *
 * Four measurements, each with anchoring off and on (git backend, a local
 * bare witness), alternated so drift on a loaded machine lands on both arms:
 *
 *   tool_call   one ordinary record written in the turn path
 *   seal        the session_end write: the only place anchoring adds work
 *               (one small queue file)
 *   checkpoint  writeCheckpoint at session end, including the scheduling of
 *               the delivery: a DETACHED `gnomon audit anchor --background`,
 *               exactly as the CLI starts it
 *   turn        a whole `runTask` against a stub model: the turn record's own
 *               duration_ms, and the wall time of the call
 *
 * Usage: node latency.mjs [--json latency.json] [--n 200]
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "");
const core = (m) => import(pathToFileURL(`${REPO}/packages/gnomon-core/dist/${m}`).href);
const { AuditTrail, resolveAudit } = await core("audit.js");
const { setAnchorScheduler, pendingAnchors } = await core("anchor.js");
const { writeCheckpoint } = await core("record_tamper.js");
const { loadConfig } = await core("config.js");
const { runTask } = await core("prompt_loop.js");

const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const N = Number(flag("--n", "200"));
const out = flag("--json", join(fileURLToPath(new URL(".", import.meta.url)), "latency.json"));
const LAUNCHER = join(REPO, "packages", "gnomon-cli", "gnomon.js");

const work = mkdtempSync(join(tmpdir(), "gnomon-anchor-latency-"));
const witness = join(work, "witness.git");
spawnSync("git", ["init", "--bare", "-q", witness]);

function project(name, anchored) {
  const root = join(work, name);
  const put = (rel, text) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text, "utf-8");
  };
  put(".gnomon/config.toml",
    `[defaults]\napproval = "on_write"\n\n[endpoints.local]\nurl = "http://127.0.0.1:9/api/chat"\nkind = "ollama"\n\n[audit]\nenabled = true\n` +
    (anchored ? `\n[audit.anchor]\nbackend = "git"\nremote = "${witness.replace(/\\/g, "/")}"\n` : ""));
  put(".gnomon/roles.toml", `[roles.implement]\nmodel = "stub"\nendpoint = "local"\ntools = ['read']\n`);
  put(".gnomon/tools.toml", `[[tools]]\nname = "read"\nenabled = true\n`);
  put(".gnomon/policy.toml", `[approval]\ngate = "on_write"\n`);
  put(".gnomon/system.md", "x\n");
  return root;
}
const roots = { off: project("off", false), on: project("on", true) };
const configs = { off: loadConfig(roots.off), on: loadConfig(roots.on) };

// The CLI's scheduler (packages/gnomon-cli/src/index.ts detachedAnchorFlush).
let spawned = 0;
setAnchorScheduler((s) => {
  spawned++;
  // `--trust` as a `gnomon task --trust` run hands it on; HOME and the data
  // dir are this run's own, so no real trust or credential store is read.
  const child = spawn(process.execPath, [LAUNCHER, "audit", "anchor", "--background", "--dir", s.root, "--trust"], {
    cwd: s.root, detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1", HOME: join(work, "home"), XDG_DATA_HOME: join(work, "xdg") },
  });
  child.on("error", () => undefined);
  child.unref();
});

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3) };
};
const results = {};
const record = (name, arm, ms) => ((results[name] ??= { off: [], on: [] })[arm].push(ms));

// tool_call and seal
for (let i = 0; i < N; i++) {
  for (const arm of i % 2 ? ["on", "off"] : ["off", "on"]) {
    const t = new AuditTrail(resolveAudit(configs[arm]), `micro-${i}`);
    t.write("session_start", {});
    let t0 = performance.now();
    t.write("tool_call", { tool: "read", target: "x.ts" });
    record("tool_call", arm, performance.now() - t0);
    t0 = performance.now();
    t.write("session_end", {});
    record("seal", arm, performance.now() - t0);
  }
}

// checkpoint, with the real detached delivery behind it
const CP = Math.max(10, Math.floor(N / 10));
for (let i = 0; i < CP; i++) {
  for (const arm of i % 2 ? ["on", "off"] : ["off", "on"]) {
    const t0 = performance.now();
    writeCheckpoint(configs[arm]);
    record("checkpoint", arm, performance.now() - t0);
  }
}

// a whole task against a stub model
const TASKS = Math.max(10, Math.floor(N / 20));
const original = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: "done" }, eval_count: 1 }) });
for (let i = 0; i < TASKS; i++) {
  for (const arm of i % 2 ? ["on", "off"] : ["off", "on"]) {
    const t0 = performance.now();
    await runTask(loadConfig(roots[arm]), "go", { role: "implement", yes: true, verbose: false });
    record("task_wall", arm, performance.now() - t0);
  }
}
globalThis.fetch = original;
for (const arm of ["off", "on"]) {
  const dir = join(roots[arm], ".gnomon-audit");
  for (const f of readdirSync(dir).filter((f) => f.startsWith("task-"))) {
    const turn = readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.kind === "turn");
    if (turn) record("turn_duration_ms", arm, turn.duration_ms);
  }
}

// Let the detached deliveries finish, then count what reached the witness.
const until = Date.now() + 60_000;
const settings = resolveAudit(configs.on).anchor;
while (pendingAnchors(settings).length > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
const log = spawnSync("git", ["--git-dir", witness, "log", "--format=%H", "refs/heads/gnomon-anchors"], { encoding: "utf-8" });
const delivered = log.status === 0 ? log.stdout.trim().split("\n").filter(Boolean).length : 0;

const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { off: stats(v.off), on: stats(v.on) }]));
console.log(`node ${process.version}, ${process.platform}/${process.arch}; interleaved off/on\n`);
console.log("measure            off p50   on p50    off p95   on p95   (ms)");
for (const [k, v] of Object.entries(summary)) {
  console.log(`${k.padEnd(18)} ${String(v.off.p50).padStart(8)} ${String(v.on.p50).padStart(8)}  ${String(v.off.p95).padStart(8)} ${String(v.on.p95).padStart(8)}   n=${v.off.n}/${v.on.n}`);
}
console.log(`\ndetached deliveries started: ${spawned}; anchor commits on the witness: ${delivered}; still queued after 60 s: ${pendingAnchors(settings).length}`);
writeFileSync(out, JSON.stringify({
  date: new Date().toISOString().slice(0, 10),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  summary,
  deliveries: { started: spawned, commits_on_witness: delivered, still_queued: pendingAnchors(settings).length },
}, null, 2) + "\n");
rmSync(work, { recursive: true, force: true });

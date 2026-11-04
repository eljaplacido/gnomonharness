#!/usr/bin/env node
// GBS-AUDIT 0.1 runner for gnomon v0.4.1 (installed release; see ../common/INSTALL.md).
//
//   GBS_SCRATCH=<dir> node run_audit.mjs <workdir> <outdir>
//
// Phases: setup (real trails from scripted v0.4.1 sessions; apparatus, not
// measurement) → controls (control verifies clean per arm; an `exit 0`
// verifier through the same scorer) → the cases (fresh copy of the control,
// at the SAME path, per case) → false positives (N untampered sessions).
// The verifier is the documented CLI, `gnomon audit verify`, run in the
// project as a user runs it. Score = its exit status; localisation is read
// from its own output. No network beyond loopback fakes.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { adapter } from "./adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [WORK, OUT] = process.argv.slice(2);
const SCR = process.env.GBS_SCRATCH;
const DIST = `${SCR}/prefix/lib/node_modules/gnomon-core/dist`;
const A = await adapter(DIST);
const { flushAnchors, enqueueAnchor } = await import(`${DIST}/anchor.js`);
mkdirSync(WORK, { recursive: true }); mkdirSync(join(OUT, "raw", "verifier"), { recursive: true });
const now = () => new Date().toISOString();
const ENV = { ...process.env, HOME: `${SCR}/home-audit` };
mkdirSync(ENV.HOME, { recursive: true });
const ver = execFileSync("gnomon", ["--version"], { env: ENV, encoding: "utf-8" }).trim();
if (ver !== "gnomon/0.4.1+v0.4.1-c511b81") throw new Error(`wrong build ${ver}`);
const LOG = join(OUT, "raw", "runlog.jsonl");
const log = (o) => appendFileSync(LOG, JSON.stringify({ t: now(), ...o }) + "\n");

// ── fakes ────────────────────────────────────────────────────────────────────
function startProc(args) {
  const p = spawn("node", args, { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((res) => p.stdout.once("data", (d) => res({ p, port: Number(String(d).trim()) })));
}
const model = await startProc([join(HERE, "fake_model.mjs"), join(WORK, "model.log")]);
const tsaPin = join(WORK, "tsa-pin.pem");
const tsa = await startProc([join(HERE, "fake_tsa.mjs"), DIST, tsaPin]);
log({ phase: "fakes", model_port: model.port, tsa_port: tsa.port, model_pid: model.p.pid, tsa_pid: tsa.p.pid });

// The unattended signing key: a file on the attacked machine, read by a script.
const KEYS = join(WORK, "keys"); mkdirSync(KEYS, { recursive: true });
const kp = generateKeyPairSync("ed25519");
writeFileSync(join(KEYS, "priv.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }));
writeFileSync(join(KEYS, "pub.pem"), kp.publicKey.export({ format: "pem", type: "spki" }));
writeFileSync(join(KEYS, "signer.mjs"),
  `import { readFileSync } from "node:fs"; import { createPrivateKey, sign } from "node:crypto";\n` +
  `const key = createPrivateKey(readFileSync(${JSON.stringify(join(KEYS, "priv.pem"))}));\n` +
  `process.stdout.write(sign(null, readFileSync(0), key).toString("base64"));\n`);

const ARMS = {
  off: "",
  attest: `\n[audit.attest]\nsign = "node ${join(KEYS, "signer.mjs")}"\npublic_key = "${join(KEYS, "pub.pem")}"\nkey_id = "gbs-unattended"\n`,
  git: (w) => `\n[audit.anchor]\nbackend = "git"\nremote = "${w}"\n`,
  rfc3161: `\n[audit.anchor]\nbackend = "rfc3161"\nurl = "http://127.0.0.1:${tsa.port}/"\ntsa_cert = "${tsaPin}"\n`,
};

const g = (cwd, args, extra = {}) => spawnSync("gnomon", args, { cwd, env: { ...ENV, ...extra }, encoding: "utf-8" });
const git = (args, input) => spawnSync("git", args, { input, encoding: "utf-8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Finding while building the apparatus (logged, not scored): after `gnomon
// task` exits, anchors/flush.lock is sometimes left behind with no delivery
// process alive, and `gnomon audit anchor` answers "A delivery is already
// running" until the lock is 120 s old. The drain waits 5 s for a live
// delivery, then removes a lock no live process holds, and counts it.
const staleLocks = [];
async function drainAnchors(proj) {
  const lock = join(proj, ".gnomon-audit", "anchors", "flush.lock");
  for (let i = 0; i < 40; i++) {
    const r = g(proj, ["audit", "anchor"]);
    const s = r.stdout + r.stderr;
    if (/Nothing queued/.test(s)) return true;
    if (r.status === 0 && /Anchored/.test(s)) continue;
    if (/already running/.test(s) && i >= 10 && existsSync(lock)) {
      const live = spawnSync("pgrep", ["-f", `audit anchor --background --dir ${proj}`], { encoding: "utf-8" }).stdout.trim();
      if (!live) { staleLocks.push({ proj, t: now() }); rmSync(lock, { force: true }); log({ phase: "stale-lock-removed", proj }); continue; }
    }
    await sleep(500);
  }
  throw new Error(`apparatus: anchors never drained in ${proj}`);
}

/** A project with the arm's surface and `sessions` scripted v0.4.1 sessions. */
async function makeProject(dir, arm, scripts, snapshotAfter = null) {
  rmSync(dir, { recursive: true, force: true });
  const proj = join(dir, "proj"); mkdirSync(proj, { recursive: true });
  const witness = join(dir, "witness.git");
  git(["init", "-q", proj]);
  writeFileSync(join(proj, "README.md"), "# gbs-audit fixture\n");
  git(["-C", proj, "add", "-A"]); git(["-C", proj, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "init"]);
  const init = g(proj, ["init"]);
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const cfgp = join(proj, ".gnomon/config.toml");
  let t = readFileSync(cfgp, "utf-8");
  const from = 'url = "http://127.0.0.1:11434/api/chat"\nkind = "ollama"';
  if (!t.includes(from)) throw new Error("endpoint block not as expected");
  t = t.replace(from, `url = "http://127.0.0.1:${model.port}/v1/chat/completions"\nkind = "openai"\nstream = false`);
  if (arm === "git") {
    git(["init", "--bare", "-q", witness]);
    git(["--git-dir", witness, "config", "receive.denyNonFastForwards", "true"]);
    git(["--git-dir", witness, "config", "receive.denyDeletes", "true"]);
  }
  const block = typeof ARMS[arm] === "function" ? ARMS[arm](witness) : ARMS[arm];
  writeFileSync(cfgp, t + block);
  const tr = g(proj, ["trust", "grant"]);
  log({ phase: "setup", arm, dir, trust: tr.status, surface: g(proj, ["surface", "hash"]).stdout.trim() });
  const units = [];
  for (const [i, v] of scripts.entries()) {
    const r = g(proj, ["task", `make a small change [audit-script ${v}]`, "--yes", "--json"]);
    if (r.status !== 0) throw new Error(`session ${v} exit ${r.status}: ${r.stderr}`);
    const rec = JSON.parse(r.stdout);
    if (rec.stop_reason !== "answered") throw new Error(`session ended ${rec.stop_reason}`);
    if (arm === "git" || arm === "rfc3161") await drainAnchors(proj);
    const trails = readdirSync(join(proj, ".gnomon-audit")).filter((f) => f.endsWith(".jsonl")).sort();
    units.push(trails.find((f) => !units.includes(f)));
    if (snapshotAfter === i) cpSync(join(proj, ".gnomon-audit"), join(dir, "audit-after-session-" + (i + 1)), { recursive: true });
    await sleep(1100); // distinct session timestamps
  }
  return { proj, witness, units };
}

// ── verifier and scorer ──────────────────────────────────────────────────────
const FAIL = /BROKEN|NOT SEALED|RE-CHAINED|INVALID|NOT SIGNED — [^t]|UNVERIFIABLE|UNCHECKED|no such trail|no longer on disk|rollback|NOT ANCHORED|nothing to verify/i;
function verify(proj, verifier) {
  // stdout and stderr on ONE pipe, in the order the verifier wrote them, as a
  // terminal shows them: a failing line on stderr belongs under the trail
  // line printed just before it on stdout.
  const r = verifier === "exit0"
    ? spawnSync("sh", ["-c", "exit 0"], { encoding: "utf-8" })
    : spawnSync("sh", ["-c", "exec gnomon audit verify 2>&1"], { cwd: proj, env: ENV, encoding: "utf-8" });
  return { exit: r.status, out: r.stdout ?? "" };
}
function score(v, target) {
  const lines = v.out.split("\n");
  // Blocks: a line starting with a trail name opens that trail's block.
  const blocks = []; let cur = { name: null, lines: [] };
  for (const l of lines) {
    const m = /^(\S+\.jsonl):/.exec(l);
    if (m) { blocks.push(cur); cur = { name: m[1], lines: [l] }; } else cur.lines.push(l);
  }
  blocks.push(cur);
  const about = [
    ...blocks.filter((b) => b.name && basename(b.name) === target).flatMap((b) => b.lines),
    ...lines.filter((l) => l.includes(target)),
  ].filter((l) => FAIL.test(l) || /seq|after|ago|at \d{4}-/.test(l));
  const failingAboutTarget = about.some((l) => FAIL.test(l)) ||
    blocks.some((b) => b.name && basename(b.name) === target && b.lines.some((l) => FAIL.test(l)));
  const textFlag = lines.some((l) => FAIL.test(l));
  const detected = v.exit !== 0;
  const L1 = detected && failingAboutTarget;
  const tgtText = blocks.filter((b) => b.name && basename(b.name) === target).flatMap((b) => b.lines).concat(lines.filter((l) => l.includes(target))).join("\n");
  const L2 = L1 && /seq(?:uence)?s?\s*(?:range\s*)?\d|at seq \d|seq \d+\s*[–-]\s*\d+|seq \d/.test(tgtText);
  const L3 = L1 && /after \d{4}-\d\d-\d\dT|after .*\d{2}:\d{2}/.test(tgtText);
  return {
    verdict: !detected ? (textFlag && failingAboutTarget ? "undetected_text_flag_exit0" : "undetected") : (L1 ? "detected" : "detected_unlocalised"),
    exit: v.exit, L1, L2, L3,
  };
}

// ── cases ────────────────────────────────────────────────────────────────────
const M = (rs) => Math.floor(rs.length / 2);
const ED = "2026-01-01T00:00:00.000Z";
const anchored = (arm) => arm === "git" || arm === "rfc3161";
async function reanchor(ctx, skewMs = 0) {
  const s = A.settings(ctx.proj).anchor;
  const rs = A.load(ctx.unit);
  enqueueAnchor(s, ctx.unit, rs[rs.length - 1], rs.length);
  if (skewMs) {
    // The attacker sets the clock back: gnomon's own delivery code, run by the
    // attacker with a clock an hour slow (the CLI reads the real clock, and
    // the apparatus has no root to set it).
    const f = await flushAnchors(s, { now: () => new Date(Date.now() - skewMs) });
    return { delivered: f.delivered, via: "library, clock -1h" };
  }
  const r = g(ctx.proj, ["audit", "anchor"]);
  return { delivered: /Anchored/.test(r.stdout), via: "gnomon audit anchor", out: r.stdout.trim() };
}
function witnessMoves(ctx) {
  // The attacker's best moves against the witness itself (§6): replace the
  // anchor ref with a history lacking the original anchor, and delete the ref.
  if (ctx.arm !== "git") return ctx.arm === "rfc3161"
    ? { move: "n/a: the authority is a third party; the attacker has no write access to it, only to the local receipts" }
    : { move: "n/a: no off-machine witness in this configuration" };
  const scratch = join(dirname(ctx.proj), "scratch.git");
  rmSync(scratch, { recursive: true, force: true });
  git(["init", "--bare", "-q", scratch]);
  const blob = git(["--git-dir", scratch, "hash-object", "-w", "--stdin"], "{}\n").stdout.trim();
  const tree = git(["--git-dir", scratch, "mktree"], `100644 blob ${blob}\tanchors.jsonl\n`).stdout.trim();
  const forged = git(["--git-dir", scratch, "-c", "user.name=x", "-c", "user.email=x@x", "commit-tree", tree, "-m", "x"]).stdout.trim();
  const ref = "refs/heads/gnomon-anchors";
  const push = git(["--git-dir", scratch, "push", "--force", ctx.witness, `${forged}:${ref}`]);
  const del = git(["--git-dir", scratch, "push", ctx.witness, `:${ref}`]);
  rmSync(scratch, { recursive: true, force: true });
  return { forced_push_refused: push.status !== 0, ref_delete_refused: del.status !== 0 };
}
const NA = (why) => ({ na: why });
const CASES = [
  ["E1", "A1", (c) => { const rs = A.load(c.unit); rs[M(rs)].ts = ED; A.save(c.unit, rs); }],
  ["E2", "A2", (c) => { const rs = A.load(c.unit); rs[M(rs)].ts = ED; A.rehashOne(rs[M(rs)]); A.save(c.unit, rs); }],
  ["E3", "A1", (c) => { const rs = A.load(c.unit); delete rs[M(rs)].hash; A.save(c.unit, rs); }],
  ["I1", "A2", (c) => { const rs = A.load(c.unit); const l = rs[rs.length - 1];
    const f = { seq: l.seq + 1, ts: l.ts, kind: "tool_call", prev: l.hash, tool: "bash", ok: true }; f.hash = A.recordHash(f); rs.push(f); A.save(c.unit, rs); }],
  ["I2", "A1", (c) => { const rs = A.load(c.unit); const m = M(rs); const f = { ...rs[m], kind: "tool_call", seq: 998 }; delete f.hash; rs.splice(m + 1, 0, f); A.save(c.unit, rs); }],
  ["D1", "A1", (c) => { const rs = A.load(c.unit); rs.splice(M(rs), 1); A.save(c.unit, rs); }],
  ["D2", "A1", (c) => { const stem = c.unit.replace(/\.jsonl$/, "");
    // A1 knows nothing of the integrity mechanism: the unit and its record file go, the heads file stays.
    for (const p of [c.unit, `${stem}.record.json`]) rmSync(p, { force: true }); }],
  ["D3", "A3", (c) => { for (const d of A.anchor_state()) rmSync(join(dirname(c.unit), d), { recursive: true, force: true }); return witnessMoves(c); }],
  ["T1", "A1", (c) => { const rs = A.load(c.unit); A.save(c.unit, rs.slice(0, rs.length - 3)); }],
  ["O1", "A1", (c) => { const rs = A.load(c.unit); const m = M(rs); [rs[m], rs[m + 1]] = [rs[m + 1], rs[m]]; A.save(c.unit, rs); }],
  ["R1", "A2", (c) => { const rs = A.load(c.unit); const m = M(rs); rs[m].ts = ED; A.rehash(rs, m); A.save(c.unit, rs); }],
  ["R2", "A3", async (c) => {
    if (c.arm === "off") return NA("no integrity state outside the records and no signer or anchor to re-run: R2 is R1");
    const rs = A.load(c.unit); const m = M(rs); rs[m].ts = ED; A.rehash(rs, m); A.save(c.unit, rs);
    for (const d of ["anchors", "heads"]) rmSync(join(dirname(c.unit), d), { recursive: true, force: true });
    const wm = witnessMoves(c);
    if (c.arm === "attest") { A.resign(c.proj, c.unit); return { ...wm, resigned: true }; }
    return { ...wm, reanchor: await reanchor(c) };
  }],
  ["C1", "A3", async (c) => {
    if (c.arm === "off") return NA("no anchor or signed head carries a time: C1 is R1");
    const rs = A.load(c.unit); const m = M(rs); rs[m].ts = ED; A.rehash(rs, m); A.save(c.unit, rs);
    for (const d of ["anchors", "heads"]) rmSync(join(dirname(c.unit), d), { recursive: true, force: true });
    const wm = witnessMoves(c);
    if (c.arm === "attest") { A.resign(c.proj, c.unit, 3600_000); return { ...wm, resigned: "head ts -1h" }; }
    return { ...wm, reanchor: await reanchor(c, 3600_000) };
  }],
  ["K1", "A3", async (c) => {
    if (c.arm !== "attest") return NA("this configuration declares no signer, so there is no key to re-sign with");
    const rs = A.load(c.unit); const m = M(rs); rs[m].ts = ED; A.rehash(rs, m); A.save(c.unit, rs);
    A.resign(c.proj, c.unit); return { resigned: true, ...witnessMoves(c) };
  }],
  ["K2", "A3", async (c) => {
    if (!anchored(c.arm)) return NA("this configuration has no witness to append to");
    const rs = A.load(c.unit); const m = M(rs); rs[m].ts = ED; A.rehash(rs, m); A.save(c.unit, rs);
    return { reanchor: await reanchor(c), ...witnessMoves(c) };
  }],
  ["B1", "A3", (c) => {
    const ad = join(c.proj, ".gnomon-audit");
    rmSync(ad, { recursive: true, force: true });
    cpSync(join(c.dir, "audit-after-session-2"), ad, { recursive: true });
    return witnessMoves(c);
  }],
];

// ── run ──────────────────────────────────────────────────────────────────────
const result = { started: now(), arms: {}, rows: [], controls: [], fp: {} };
const SCRIPTS = ["v2", "v4", "v3"]; // the target unit is session 2 (v4: glob, write, edit, read)
for (const arm of Object.keys(ARMS)) {
  const dir = join(WORK, arm);
  const p = await makeProject(dir, arm, SCRIPTS, 1);
  const pristine = join(WORK, `${arm}.pristine`);
  rmSync(pristine, { recursive: true, force: true });
  cpSync(dir, pristine, { recursive: true });
  const target = p.units[1];
  const records = A.load(join(p.proj, ".gnomon-audit", target)).length;
  result.arms[arm] = { units: p.units, target, target_records: records, surface: g(p.proj, ["surface", "hash"]).stdout.trim() };
  cpSync(join(p.proj, ".gnomon-audit", target), join(OUT, "raw", `control-trail-${arm}.jsonl`));
  log({ phase: "setup-done", arm, target, records });
}
if (process.argv.includes("--setup-only")) { model.p.kill(); tsa.p.kill(); console.log(JSON.stringify(result.arms, null, 1)); process.exit(0); }
result.first_measured_trial = now();
log({ phase: "first-measured-trial" });
const restore = (arm) => { const dir = join(WORK, arm); rmSync(dir, { recursive: true, force: true }); cpSync(join(WORK, `${arm}.pristine`), dir, { recursive: true }); };

// Control 1: each control verifies clean.
for (const arm of Object.keys(ARMS)) {
  restore(arm);
  const proj = join(WORK, arm, "proj");
  const v = verify(proj, "gnomon");
  writeFileSync(join(OUT, "raw", "verifier", `control-${arm}.txt`), `exit ${v.exit}\n${v.out}`);
  result.controls.push({ control: "control trail verifies clean", arm, exit: v.exit, ok: v.exit === 0 });
}
const controlsOk = result.controls.every((c) => c.ok);

for (const verifier of ["gnomon", "exit0"]) {
  for (const arm of Object.keys(ARMS)) {
    for (const [id, level, mutate] of CASES) {
      restore(arm);
      const dir = join(WORK, arm);
      const ctx = { arm, dir, proj: join(dir, "proj"), witness: join(dir, "witness.git"), unit: join(dir, "proj", ".gnomon-audit", result.arms[arm].target) };
      const extra = (await mutate(ctx)) ?? {};
      if (extra.na) { result.rows.push({ verifier, arm, id, level, verdict: "n/a", reason: extra.na }); continue; }
      const v = verify(ctx.proj, verifier);
      const s = score(v, result.arms[arm].target);
      if (verifier === "gnomon") writeFileSync(join(OUT, "raw", "verifier", `${arm}-${id}.txt`), `exit ${v.exit}\n${v.out}`);
      result.rows.push({ verifier, arm, id, level, ...s, ...extra });
      log({ phase: "case", verifier, arm, id, verdict: s.verdict });
    }
  }
}
const nullRows = result.rows.filter((r) => r.verifier === "exit0" && r.verdict !== "n/a");
result.controls.push({ control: "an `exit 0` verifier scores every case undetected", cases: nullRows.length,
  undetected: nullRows.filter((r) => r.verdict.startsWith("undetected")).length,
  ok: nullRows.every((r) => r.verdict.startsWith("undetected")) });

// False positives: N untampered sessions, each verified by name.
const FP = { off: 24, attest: 8, git: 8, rfc3161: 8 };
const V = ["v0", "v1", "v2", "v3", "v4"];
for (const [arm, n] of Object.entries(FP)) {
  const p = await makeProject(join(WORK, `fp-${arm}`), arm, Array.from({ length: n }, (_, i) => V[i % V.length]));
  const per = p.units.map((u) => { const r = g(p.proj, ["audit", "verify", u]); return { unit: u, exit: r.status, out: r.stdout + r.stderr }; });
  const bad = per.filter((x) => x.exit !== 0);
  for (const b of bad) writeFileSync(join(OUT, "raw", "verifier", `fp-${arm}-${b.unit}.txt`), `exit ${b.exit}\n${b.out}`);
  const all = g(p.proj, ["audit", "verify"]);
  result.fp[arm] = { sessions: n, non_success: bad.length, whole_dir_exit: all.status };
}
result.finished = now();
result.stale_flush_locks_removed = staleLocks;
result.controls_ok = controlsOk && result.controls.every((c) => c.ok);
writeFileSync(join(OUT, "raw", "cases.json"), JSON.stringify(result, null, 2) + "\n");
model.p.kill(); tsa.p.kill();
console.log(JSON.stringify({ controls_ok: result.controls_ok, fp: result.fp }));

// LG1 offline wire test (no lane, no cloud, no network beyond 127.0.0.1). Its output is committed as ../wiretest-lg1.txt.
// It runs the REAL builds under test, from git-archive trees (apparatus/mktree_lg1.sh = R4H's mktree_r4h.sh), each with
// its own launcher bundle cache (GNOMON_LAUNCH_CACHE): a shared cache serves whichever tree built it first.
//
// A. Surface. `gnomon init` of OLD (v0.4.2, 2498d16d) and NEW (PR #153 head, 59f1e314), each followed by the node block of
//    R3R's gnomon-setup-r3r.sh.j2 (the setup both builds run under, via peer_agents_r3r.GnomonR3R), extracted exactly as
//    the preflight extracts it, with L's routing:
//    - both inits pass R3R's assertion (stream = true, max_tokens = 32768, no steer_role / replay_reasoning, no fallback);
//    - the settings (non-comment lines) that differ OLD -> NEW are listed; nudge_after_idle is 12 on OLD and 0 on NEW,
//      and neither build's init (nor the setup) names replay_reasoning: each runs its release default;
//    - the r1 profile (L's routing) is byte-identical on both builds and to the one R3R's L cells ran.
// B. Wire on a LANE-SHAPED fake (llama.cpp with reasoning_format none, as R1H's lane-props.json says: content only, no
//    reasoning field), through relay-meter-s1 (createRelay, this exact code): L on both builds. Every request local,
//    streamed, max_tokens 32768; nothing reaches the cloud; NO reasoning_content is replayed on either build: on a lane
//    that returns no reasoning, NEW's replay default is inert (PR #153: "an endpoint that sends no reasoning is sent none").
// C. Positive control on a REASONING-RETURNING fake (reasoning_content on every reply): OLD replays nothing; NEW replays
//    from its second request on. So the meter's req_with_reasoning_content would see the replay default had the lane
//    returned reasoning: the mechanism metric is live.
// D. The nudge on a lane-shaped fake that asks for 14 read-only bash calls before it answers: OLD sends the idle nudge
//    (meter steer_nudge_*), NEW sends none.
// E. NEG (NEW, routed all to the cloud): every request goes to the cloud endpoint, none to the local one.
//   node wiretest_lg1.mjs <OLD tree> <NEW tree> <empty work dir>
// exit 0 when every check holds.
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay, newTotals, newCell } from "./relay-meter-s1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, "../..");
const [treeOld, treeNew, work] = process.argv.slice(2);
if (!treeOld || !treeNew || !work) { console.error("usage: node wiretest_lg1.mjs <OLD tree> <NEW tree> <empty work dir>"); process.exit(2); }
const SHA = { OLD: "2498d16dc248bc18a203a1a98ba0b942acae5b23", NEW: "59f1e3144099ff47c10f1b3e26249f763d764f42" };
const TREE = { OLD: treeOld, NEW: treeNew };
for (const [b, t] of Object.entries(TREE)) {
  const got = existsSync(join(t, ".sha")) ? readFileSync(join(t, ".sha"), "utf8").trim() : "";
  if (got !== SHA[b]) { console.error(`${b} tree ${t} is ${got || "unlabelled"}, not ${SHA[b]} (make it with mktree_lg1.sh)`); process.exit(2); }
}
const GN = (b) => join(TREE[b], "packages/gnomon-cli/gnomon.js");
const JS = readFileSync(join(HERE, "gnomon-setup-r3r.sh.j2"), "utf8").split("cat > /opt/gnomon-run.sh <<'RUN'\n")[1].split("\nRUN\n")[0].split("node -e '")[1].split("\n'\n")[0];
const J = JSON.stringify;
const ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"];
const ARMS = {  // run_lg1.py ARMS (R1H's L; NEG)
  L: { entry: "implementor", routes: Object.fromEntries(ROLES.map((r) => [r, "local"])) },
  NEG: { entry: "implementor", routes: Object.fromEntries(ROLES.map((r) => [r, "cloud"])) },
};
const SURF = /surface=([0-9a-f]{8,64})/g;  // collect_m1.py
let ok = true;
const check = (cond, what) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`); ok &&= Boolean(cond); };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const envFor = (build, arm, localUrl, cloudUrl) => {
  const e = { ...process.env, XDG_DATA_HOME: join(work, "xdg"), XDG_CONFIG_HOME: join(work, "xdgc"), XDG_STATE_HOME: join(work, "xdgs"), NO_COLOR: "1",
    GNOMON_LAUNCH_CACHE: join(TREE[build], ".launch-cache"),
    R1_ROUTES: ROLES.map((r) => `${r}=${ARMS[arm].routes[r]}`).join(","), R1_ENTRY: ARMS[arm].entry,
    R1_LOCAL_URL: localUrl, R1_CLOUD_URL: cloudUrl, R1_LOCAL_MODEL: "qwen3.6-35b", R1_CLOUD_MODEL: "deepseek-v4.1-flash", R1_ARM: arm };
  for (const k of ["OPENAI_API_KEY", "OPENCODE_API_KEY", "GNOMON_MODEL_URL", "GNOMON_MODEL_TIMEOUT_MS", "GNOMON_LAUNCH", "GNOMON_DEADLINE"]) delete e[k];
  return e;
};
const readTree = (dir) => {
  const out = {};
  const walk = (d, rel) => { for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name), r = rel ? `${rel}/${f.name}` : f.name;
    if (f.isDirectory()) walk(p, r); else out[r] = readFileSync(p, "utf8");
  } };
  walk(join(dir, ".gnomon"), "");
  return out;
};
const settings = (toml) => toml.split("\n").map((l) => l.replace(/\s+#.*$/, "").trimEnd()).filter((l) => l && !l.trimStart().startsWith("#"));
const recorded = (study, re, file) => {  // the file as an arbitrary finished cell of that study recorded it
  const runs = join(RES, study, "runs");
  for (const c of readdirSync(runs).filter((n) => re.test(n)).sort()) {
    for (const t of readdirSync(join(runs, c), { withFileTypes: true }).filter((x) => x.isDirectory())) {
      for (const tr of readdirSync(join(runs, c, t.name))) {
        const p = join(runs, c, t.name, tr, "agent-logs", file);
        if (existsSync(p)) return { cell: c, text: readFileSync(p, "utf8") };
      }
    }
  }
  return null;
};

console.log(`== LG1 wire test ${new Date().toISOString()}: OLD ${SHA.OLD} (v0.4.2, tree ${TREE.OLD}); NEW ${SHA.NEW} (PR #153 head, tree ${TREE.NEW})`);
const LURL = "http://172.17.0.1:6110/v1/chat/completions", CURL = "http://172.17.0.1:6111/openai/v1/chat/completions";

// ------------------------------------------------------------------------------------------- A. surface
console.log("\nA. surface: each build's init + R3R's node block (L routing)");
const init = {}, after = {}, err = {};
for (const b of ["OLD", "NEW"]) {
  const d = join(work, `a-${b}`); mkdirSync(d, { recursive: true });
  const env = envFor(b, "L", LURL, CURL);
  execFileSync("node", [GN(b), "init"], { cwd: d, env, stdio: "ignore" });
  init[b] = readTree(d);
  try { execFileSync("node", ["-e", JS], { cwd: d, env, stdio: "pipe" }); err[b] = null; }
  catch (e) { err[b] = String(e.stderr || e.message).split("\n").find((l) => /Error:/.test(l)) ?? "error"; }
  after[b] = readTree(d);
}
check(!err.OLD && !err.NEW, `R3R's node block (its init assertion included) runs on both builds' init (${err.OLD ?? "-"} / ${err.NEW ?? "-"})`);
const sOld = settings(init.OLD["config.toml"]), sNew = settings(init.NEW["config.toml"]);
const sd = [...sOld.filter((l) => !sNew.includes(l)).map((l) => `- ${l}`), ...sNew.filter((l) => !sOld.includes(l)).map((l) => `+ ${l}`)];
console.log(`  config.toml settings (non-comment lines) that differ OLD -> NEW in gnomon init:\n${sd.map((l) => `    ${l}`).join("\n") || "    (none)"}`);
const nudge = (t) => (t.match(/^nudge_after_idle = (\d+)/m) || [])[1];
check(nudge(after.OLD["config.toml"]) === "12" && nudge(after.NEW["config.toml"]) === "0", `nudge_after_idle in the surface each cell runs: OLD ${nudge(after.OLD["config.toml"])}, NEW ${nudge(after.NEW["config.toml"])} (each build's release default)`);
check(![...Object.values(after.OLD), ...Object.values(after.NEW)].some((t) => /replay_reasoning|steer_role/.test(t)),
  "no surface file names replay_reasoning or steer_role on either build: replay runs at each build's code default");
check(sd.every((l) => /nudge_after_idle/.test(l)), `the only setting that differs is nudge_after_idle (others: ${J(sd.filter((l) => !/nudge_after_idle/.test(l)))})`);
const p3 = recorded("r3r-2026-11", /-k1-l-/, "r1-profile.toml");
check(p3 && after.OLD["profiles/r1.toml"] === after.NEW["profiles/r1.toml"] && after.NEW["profiles/r1.toml"] === p3.text,
  `the r1 profile (L's routing, every role local) is byte-identical on both builds and to what ${p3?.cell} ran`);
const dd = Object.keys({ ...after.OLD, ...after.NEW }).sort().filter((f) => after.OLD[f] !== after.NEW[f]);
console.log(`  surface files that differ OLD -> NEW after the setup (comments included): ${dd.join(", ")}`);

// ------------------------------------------------------------------------------------------- the fakes
// mode: "lane" (content only, as R1H's lane: reasoning_format none), "reasoning" (reasoning_content on every reply),
// "idle" (lane-shaped, asks for IDLE_CALLS read-only bash calls before it answers). Always streamed when asked.
const IDLE_CALLS = 14;
function fake(kind, mode) {
  const seen = { bodies: [] };
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b);
      seen.bodies.push(body);
      const n = seen.bodies.length;
      const tools = (body.tools ?? []).map((t) => t.function?.name);
      const toolMsgs = (body.messages ?? []).filter((m) => m.role === "tool").length;
      const want = mode === "idle" ? IDLE_CALLS : 1;
      let delta;
      if (tools.includes("bash") && toolMsgs < want) {
        delta = { tool_calls: [{ index: 0, id: `call_${kind}_${n}`, type: "function", function: { name: "bash", arguments: J({ command: `echo lg1-wire-${toolMsgs}` }) } }] };
      } else {
        delta = { content: "Done: the command printed lg1-wire." };
      }
      const finish = delta.tool_calls ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 1000 + n, completion_tokens: 20, total_tokens: 1020 + n };
      const timings = { cache_n: 900, prompt_n: 100 + n, predicted_n: 20, prompt_ms: 50, predicted_ms: 80 };
      const thought = mode === "reasoning" ? { reasoning_content: `thinking about step ${n}` } : {};
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (mode === "reasoning") res.write(`data: ${J({ choices: [{ index: 0, delta: { role: "assistant", ...thought }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${J({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${J({ choices: [{ index: 0, delta: {}, finish_reason: finish }], timings })}\n\n`);
        if (body.stream_options?.include_usage) res.write(`data: ${J({ choices: [], usage, timings })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(J({ choices: [{ index: 0, message: { role: "assistant", ...thought, ...delta }, finish_reason: finish }], usage, timings }));
      }
    });
  });
  return { srv, seen };
}

async function runTask(build, arm, mode, tag) {
  const dir = join(work, `${tag}-${build}-${arm}`);
  mkdirSync(dir, { recursive: true });
  const loc = fake("local", mode), cld = fake("cloud", mode);
  const lp = await listen(loc.srv), cp = await listen(cld.srv);
  const state = { totals: newTotals(), cell: newCell(`wiretest-${tag}-${build}-${arm}`) };
  const relay = createRelay(`http://127.0.0.1:${lp}`, state);
  const rp = await listen(relay);
  const env = envFor(build, arm, `http://127.0.0.1:${rp}/v1/chat/completions`, `http://127.0.0.1:${cp}/openai/v1/chat/completions`);
  execFileSync("node", [GN(build), "init"], { cwd: dir, env, stdio: "ignore" });
  execFileSync("node", ["-e", JS], { cwd: dir, env, stdio: "inherit" });
  const t0 = Date.now();
  const child = await new Promise((resolve) => {
    const out = [];
    const p = spawn("node", [GN(build), "task", "Print lg1-wire with bash and report it.", "--role", ARMS[arm].entry, "--yes", "--trust"], { cwd: dir, env });
    p.stdout.on("data", (d) => out.push(d)); p.stderr.on("data", (d) => out.push(d));
    const t = setTimeout(() => p.kill("SIGKILL"), 240000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out: Buffer.concat(out).toString("utf8"), wall_s: (Date.now() - t0) / 1000 }); });
  });
  relay.close(); loc.srv.close(); cld.srv.close();
  writeFileSync(join(dir, "task.log"), child.out);
  const turns = [];
  const auditDir = join(dir, ".gnomon-audit");
  if (existsSync(auditDir)) for (const f of readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(auditDir, f), "utf8").split("\n")) {
      try { const r = JSON.parse(line); if (r.kind === "turn") turns.push(r); } catch { /* not a record */ }
    }
  }
  return { child, turns, L: loc.seen.bodies, C: cld.seen.bodies, t: state.totals };
}
const replayedAt = (bodies) => bodies.map((b, i) => ((b.messages ?? []).some((m) => m.role === "assistant" && typeof m.reasoning_content === "string" && m.reasoning_content) ? i + 1 : 0)).filter(Boolean);
const summary = (r) => `gnomon exit ${r.child.code} in ${r.child.wall_s.toFixed(1)} s; local ${r.L.length} req, cloud ${r.C.length} req; meter chat ${r.t.chat_requests}, ` +
  `stream ${r.t.req_stream}, max_tokens ${r.t.req_max_tokens}, reasoning responses ${r.t.responses_with_reasoning}, replayed requests ${r.t.req_with_reasoning_content} ` +
  `(after a reasoned tool reply ${r.t.following_reasoning_replayed}/${r.t.following_reasoning}), nudge requests ${r.t.steer_nudge_dropped + r.t.steer_nudge_note} ` +
  `(dropped ${r.t.steer_nudge_dropped}, note ${r.t.steer_nudge_note}); last wire ${J(r.turns.at(-1)?.wire ?? null)}; stop ${r.turns.at(-1)?.stop_reason}`;

// ------------------------------------------------------------------------------------------- B. lane-shaped wire
console.log("\nB. wire on a lane-shaped fake (content only, no reasoning field), L on both builds, local through relay-meter-s1");
for (const build of ["OLD", "NEW"]) {
  const r = await runTask(build, "L", "lane", "b");
  const surf = [...r.child.out.matchAll(SURF)].map((m) => m[1]);
  console.log(`\n  ${build} L: ${summary(r)}`);
  check(r.child.code === 0, "gnomon task exited 0");
  check(r.L.length > 0 && r.C.length === 0 && r.L.every((b) => b.model === "qwen3.6-35b"), "L: every request local (qwen3.6-35b), none to the cloud endpoint");
  check(r.L.every((b) => b.stream === true && b.max_tokens === 32768 && b.stream_options?.include_usage === true) && r.t.req_stream === r.L.length && r.t.req_max_tokens === r.L.length,
    "every request streamed with include_usage and max_tokens = 32768 (both builds' release wire), and the meter saw it");
  check(r.t.responses_with_reasoning === 0 && r.t.req_with_reasoning_content === 0 && replayedAt(r.L).length === 0,
    "no reasoning returned, none replayed (on a lane that sends no reasoning field, replay is inert on both builds)");
  check(r.t.responses_without_usage === 0 && r.t.errors === 0, "the meter metered every response");
  check(surf.length > 0, "the log carries surface= (the collector's surface pattern)");
}

// ------------------------------------------------------------------------------------------- C. positive control
console.log("\nC. positive control: a reasoning-returning fake (reasoning_content on every reply)");
const cr = {};
for (const build of ["OLD", "NEW"]) {
  const r = (cr[build] = await runTask(build, "L", "reasoning", "c"));
  console.log(`\n  ${build} L: ${summary(r)}; requests carrying reasoning_content: ${J(replayedAt(r.L))}`);
  check(r.child.code === 0, "gnomon task exited 0");
}
check(cr.OLD.t.responses_with_reasoning > 0 && cr.OLD.t.req_with_reasoning_content === 0 && replayedAt(cr.OLD.L).length === 0,
  "OLD (v0.4.2): reasoning returned, none replayed (no replay on an undeclared endpoint)");
check(cr.NEW.t.req_with_reasoning_content > 0 && replayedAt(cr.NEW.L)[0] === 2 && cr.NEW.t.following_reasoning_replayed > 0,
  "NEW: replays from its second request on, and the meter counts it (req_with_reasoning_content, following_reasoning_replayed)");
check(cr.NEW.turns.some((t) => t.wire?.replay_reasoning === true && t.wire?.replay_reasoning_source === "default"),
  "NEW's turn record says replay_reasoning true, source default");

// ------------------------------------------------------------------------------------------- D. the idle nudge
console.log(`\nD. the idle nudge: a lane-shaped fake that asks for ${IDLE_CALLS} read-only bash calls before it answers`);
const dr = {};
for (const build of ["OLD", "NEW"]) {
  const r = (dr[build] = await runTask(build, "L", "idle", "d"));
  console.log(`\n  ${build} L: ${summary(r)}`);
  check(r.child.code === 0, "gnomon task exited 0");
}
check(dr.OLD.t.steer_nudge_dropped + dr.OLD.t.steer_nudge_note > 0, "OLD (nudge_after_idle = 12): the idle nudge is sent, and the meter counts it");
check(dr.NEW.t.steer_nudge_dropped + dr.NEW.t.steer_nudge_note === 0, "NEW (nudge_after_idle = 0): no idle nudge");

// ------------------------------------------------------------------------------------------- E. NEG
console.log("\nE. NEG: NEW routed all to the cloud endpoint");
{
  const r = await runTask("NEW", "NEG", "lane", "e");
  console.log(`\n  NEW NEG: ${summary(r)}`);
  check(r.C.length > 0 && r.L.length === 0, "NEG: cloud only (the smoke must count it on the trap and never score it valid)");
}
console.log(`\nwire test: ${ok ? "PASS" : "FAIL"} (OLD ${SHA.OLD}, NEW ${SHA.NEW})`);
process.exit(ok ? 0 : 1);

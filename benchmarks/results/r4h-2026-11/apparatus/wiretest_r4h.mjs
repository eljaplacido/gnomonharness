// R4H offline wire test (no lane, no cloud, no network beyond 127.0.0.1). Its output is committed as ../wiretest-r4h.txt
// (and, with --slow, ../wiretest-r4h-slow.txt). It runs the REAL builds under test, from git-archive trees
// (apparatus/mktree_r4h.sh), each with its own launcher bundle cache (GNOMON_LAUNCH_CACHE): a shared cache serves
// whichever tree built it first, so all builds would silently run one build's code.
//
// A. Surface. `gnomon init` of OLD (d59e6c19, R1H's build) and NEW (v0.4.1), each followed by the node block of the
//    setup its agent class uses (OLD: R1H's gnomon-setup-r1.sh.j2 via peer_agents_r1.GnomonR1; NEW: R3R's
//    gnomon-setup-r3r.sh.j2 via peer_agents_r3r.GnomonR3R), extracted exactly as the preflight extracts it:
//    - OLD + R1H's block writes the config.toml R1H's PC cells ran, byte for byte (endpoint ports normalised);
//    - NEW + R3R's block writes the config.toml R3R's PC cells ran on v0.4.0, except the comment lines v0.4.1's
//      init adds (no setting differs);
//    - the r1 profile (PC's routing) is byte-identical on both builds and to the one every R1H and R3R cell ran;
//    - R3R's block refuses OLD's init (so OLD cannot run under the NEW agent class), and the v0.4.0 -> v0.4.1 init
//      difference is comments only.
// B. Wire. PC on both builds and NEG on NEW: init -> the build's node block -> `gnomon task --role <entry>` -> a fake
//    llama.cpp-style local server behind relay-meter-s1 (createRelay, this exact code) and a fake OpenAI-style cloud
//    server. Checks: PC's coordinator in the cloud (every cloud request offers `task`), the implementor sub-turn local;
//    OLD's requests are R1H's wire (not streamed, no max_tokens), NEW's are v0.4.0's (streamed, include_usage,
//    max_tokens = 32768); the collector's DELEG and surface= patterns match both logs; the meter parses both shapes.
// C. (--slow) The 300 s mechanism, on both builds at once: the fake cloud holds the coordinator's FIRST reply for
//    SLOW_S (330) s, then answers; every later request is answered at once. A non-streamed reply (OLD) sends nothing
//    until then; a streamed one (NEW) sends a reasoning chunk every 15 s. Records when each cloud request arrived,
//    whether the client gave up on it and when, and what the task did next. This is what "a planner call past 300 s"
//    does on each build; R1H's and R3R's committed cells hold no such call (pretrace-r4h.txt).
//   node wiretest_r4h.mjs <OLD tree> <NEW tree> <v0.4.0 tree> <empty work dir> [--slow]
// exit 0 when every check holds.
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay, newTotals, newCell } from "./relay-meter-s1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, "../..");
const [treeOld, treeNew, tree040, work, flag] = process.argv.slice(2);
if (!treeOld || !treeNew || !tree040 || !work) { console.error("usage: node wiretest_r4h.mjs <OLD tree> <NEW tree> <v0.4.0 tree> <empty work dir> [--slow]"); process.exit(2); }
const SLOW = flag === "--slow", SLOW_S = Number(process.env.SLOW_S ?? 330);
const SHA = { OLD: "d59e6c198f91d1469198b0677c008323f82d0345", NEW: "c511b8105fb2187423d21becbe3b19f8af2b80e5", V040: "be4fc0d8835c443aca8b32ccd4c1caacf48cbdce" };
const TREE = { OLD: treeOld, NEW: treeNew, V040: tree040 };
for (const [b, t] of Object.entries(TREE)) {
  const got = existsSync(join(t, ".sha")) ? readFileSync(join(t, ".sha"), "utf8").trim() : "";
  if (got !== SHA[b]) { console.error(`${b} tree ${t} is ${got || "unlabelled"}, not ${SHA[b]} (make it with mktree_r4h.sh)`); process.exit(2); }
}
const GN = (b) => join(TREE[b], "packages/gnomon-cli/gnomon.js");
const blockOf = (f) => readFileSync(f, "utf8").split("cat > /opt/gnomon-run.sh <<'RUN'\n")[1].split("\nRUN\n")[0].split("node -e '")[1].split("\n'\n")[0];
const JS = { OLD: blockOf(join(HERE, "gnomon-setup-r1.sh.j2")), NEW: blockOf(join(HERE, "gnomon-setup-r3r.sh.j2")) };
const J = JSON.stringify;
const ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"];
const ARMS = {  // run_r4h.py ARMS (R1H's)
  PC: { entry: "coordinator", routes: { coordinator: "cloud", implementor: "local", verifier: "local", plan: "cloud", implement: "local", critique: "local", smol: "local" } },
  NEG: { entry: "implementor", routes: Object.fromEntries(ROLES.map((r) => [r, "cloud"])) },
};
const DELEG = /task (implementor|verifier|coordinator|plan|implement|critique|smol) — (\d+) tool call/g;  // collect_m1.py
const SURF = /surface=([0-9a-f]{8,64})/g;                                                                  // collect_m1.py
let ok = true;
const check = (cond, what) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`); ok &&= Boolean(cond); };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const envFor = (build, arm, localUrl, cloudUrl) => {
  const e = { ...process.env, XDG_DATA_HOME: join(work, "xdg"), XDG_CONFIG_HOME: join(work, "xdgc"), NO_COLOR: "1",
    GNOMON_LAUNCH_CACHE: join(TREE[build], ".launch-cache"),
    R1_ROUTES: ROLES.map((r) => `${r}=${ARMS[arm].routes[r]}`).join(","), R1_ENTRY: ARMS[arm].entry,
    R1_LOCAL_URL: localUrl, R1_CLOUD_URL: cloudUrl, R1_LOCAL_MODEL: "qwen3.6-35b", R1_CLOUD_MODEL: "deepseek-v4.1-flash", R1_ARM: arm };
  for (const k of ["OPENAI_API_KEY", "OPENCODE_API_KEY", "GNOMON_MODEL_URL", "GNOMON_MODEL_TIMEOUT_MS", "GNOMON_LAUNCH"]) delete e[k];
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
const prep = (build, js, dir, env) => {  // init + one node block; returns null or the block's error
  mkdirSync(dir, { recursive: true });
  execFileSync("node", [GN(build), "init"], { cwd: dir, env, stdio: "ignore" });
  try { execFileSync("node", ["-e", js], { cwd: dir, env, stdio: "pipe" }); return null; }
  catch (e) { return String(e.stderr || e.message).split("\n").find((l) => /Error:/.test(l)) ?? "error"; }
};
const lineDiff = (a, b) => {
  const A = a.split("\n"), B = b.split("\n");
  return [...A.filter((l) => !B.includes(l)).map((l) => `- ${l}`), ...B.filter((l) => !A.includes(l)).map((l) => `+ ${l}`)];
};
const normUrls = (s) => s.replace(/(\[endpoints\.r1(local|cloud)\]\nurl = ")http:\/\/[0-9.]+:\d+/g, "$1http://HOST:PORT");
const recorded = (study, file) => {  // the file as an arbitrary finished PC cell of that study recorded it
  const runs = join(RES, study, "runs");
  for (const c of readdirSync(runs).filter((n) => /-k1-pc-/.test(n)).sort()) {
    for (const t of readdirSync(join(runs, c), { withFileTypes: true }).filter((x) => x.isDirectory())) {
      for (const tr of readdirSync(join(runs, c, t.name))) {
        const p = join(runs, c, t.name, tr, "agent-logs", file);
        if (existsSync(p)) return { cell: c, text: readFileSync(p, "utf8") };
      }
    }
  }
  return null;
};

console.log(`== R4H wire test ${new Date().toISOString()}${SLOW ? " (part C, --slow)" : ""}: OLD ${SHA.OLD} (tree ${TREE.OLD}); NEW ${SHA.NEW} (v0.4.1, tree ${TREE.NEW}); ` +
  `reference v0.4.0 ${SHA.V040}`);
const LURL = "http://172.17.0.1:5810/v1/chat/completions", CURL = "http://172.17.0.1:5811/openai/v1/chat/completions";

// ------------------------------------------------------------------------------------------- A. surface
if (!SLOW) {
  console.log("\nA. surface: each build's init + its agent class's node block, against what R1H's and R3R's PC cells ran");
  const init = {};
  for (const b of ["OLD", "NEW", "V040"]) {
    const d = join(work, `init-${b}`); mkdirSync(d, { recursive: true });
    execFileSync("node", [GN(b), "init"], { cwd: d, env: envFor(b, "PC", LURL, CURL), stdio: "ignore" });
    init[b] = readTree(d);
  }
  const d040 = Object.keys({ ...init.V040, ...init.NEW }).sort()
    .flatMap((f) => (init.V040[f] === init.NEW[f] ? [] : [`${f}:`, ...lineDiff(init.V040[f] ?? "", init.NEW[f] ?? "").map((l) => `    ${l}`)]));
  console.log(`  gnomon init, v0.4.0 -> v0.4.1 (no setup edits), files that differ:\n${d040.map((l) => `    ${l}`).join("\n")}`);
  check(d040.filter((l) => /^ {4}[-+] /.test(l)).every((l) => /^ {4}[-+] *(#.*)?$/.test(l)),
    "v0.4.0 -> v0.4.1 init: only comment (or blank) lines differ; no setting");
  check(!/^stream = |^max_tokens = |stream_idle_timeout_ms|stream_total_timeout_ms/m.test(init.OLD["config.toml"]) && /^stream = true\b/m.test(init.NEW["config.toml"]),
    "OLD's init writes no stream / max_tokens / stream clocks (R1H's build); NEW's writes stream = true (the release)");
  const env = envFor("OLD", "PC", LURL, CURL);
  const eOld = prep("OLD", JS.OLD, join(work, "a-old"), env);
  const eNew = prep("NEW", JS.NEW, join(work, "a-new"), envFor("NEW", "PC", LURL, CURL));
  const eNeg = prep("OLD", JS.NEW, join(work, "a-old-r3rblock"), env);
  check(!eOld && !eNew, `OLD + R1H's block and NEW + R3R's block both run (${eOld ?? "-"} / ${eNew ?? "-"})`);
  check(eNeg && /R3R: init did not write \[defaults\] stream = true/.test(eNeg), `R3R's block (the NEW agent class) refuses OLD's init (${eNeg})`);
  const tOld = readTree(join(work, "a-old")), tNew = readTree(join(work, "a-new"));
  const r1h = recorded("r1h-2026-11", "surface-config.toml"), r3r = recorded("r3r-2026-11", "surface-config.toml");
  const p1 = recorded("r1h-2026-11", "r1-profile.toml"), p3 = recorded("r3r-2026-11", "r1-profile.toml");
  check(r1h && normUrls(tOld["config.toml"]) === normUrls(r1h.text), `OLD's config.toml is byte-identical to the one ${r1h?.cell} ran (endpoint ports normalised)`);
  const dn = r3r ? lineDiff(normUrls(r3r.text), normUrls(tNew["config.toml"])) : ["(no R3R surface)"];
  console.log(`  NEW's config.toml vs the one ${r3r?.cell} ran on v0.4.0 (ports normalised):\n${dn.map((l) => `    ${l}`).join("\n") || "    (identical)"}`);
  check(r3r && dn.every((l) => /^[-+] *(#.*)?$/.test(l)), "... differs by comment lines only");
  check(p1 && p3 && tOld["profiles/r1.toml"] === tNew["profiles/r1.toml"] && tOld["profiles/r1.toml"] === p1.text && p1.text === p3.text,
    "the r1 profile (PC's routing) is byte-identical on both builds and to what R1H's and R3R's PC cells ran");
  const dd = Object.keys({ ...tOld, ...tNew }).sort().filter((f) => tOld[f] !== tNew[f]);
  console.log(`  surface files that differ OLD -> NEW (the build's init; the setups' edits are the same): ${dd.join(", ")}`);
  const tt = lineDiff(tOld["tools.toml"], tNew["tools.toml"]);
  console.log(`  tools.toml OLD -> NEW:\n${tt.map((l) => `    ${l}`).join("\n")}`);
}

// ------------------------------------------------------------------------------------------- B/C. wire
function fake(kind, slow, log) {  // kind: local (llama.cpp-like) | cloud (OpenAI-like, with reasoning_content and cached tokens)
  const seen = { bodies: [] };
  const t0 = Date.now();
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b);
      seen.bodies.push(body);
      const n = seen.bodies.length;
      const ev = { n, arrived_s: (Date.now() - t0) / 1000, stream: Boolean(body.stream), gave_up_s: null, answered_s: null };
      if (log) log.push(ev);
      res.on("close", () => { if (!res.writableFinished && ev.gave_up_s === null) ev.gave_up_s = (Date.now() - t0) / 1000; });
      const tools = (body.tools ?? []).map((t) => t.function?.name);
      const toolMsgs = (body.messages ?? []).filter((m) => m.role === "tool").length;
      let delta;
      if (tools.includes("task") && toolMsgs === 0) {
        delta = { tool_calls: [{ index: 0, id: `call_${kind}_${n}`, type: "function", function: { name: "task",
          arguments: J({ role: "implementor", instruction: "Print r4h-wire with bash, then report what it printed." }) } }] };
      } else if (tools.includes("bash") && toolMsgs === 0) {
        delta = { tool_calls: [{ index: 0, id: `call_${kind}_${n}`, type: "function", function: { name: "bash", arguments: J({ command: "echo r4h-wire" }) } }] };
      } else {
        delta = { content: "Done: the command printed r4h-wire." };
      }
      const finish = delta.tool_calls ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 1000 + n, completion_tokens: 20, total_tokens: 1020 + n,
        ...(kind === "cloud" ? { prompt_tokens_details: { cached_tokens: 512 } } : {}) };
      const timings = { cache_n: 900, prompt_n: 100 + n, predicted_n: 20, prompt_ms: 50, predicted_ms: 80 };
      const hold = slow && n === 1 ? SLOW_S * 1000 : 0;   // only the coordinator's first reply is slow
      const done = () => { if (ev.gave_up_s === null) ev.answered_s = (Date.now() - t0) / 1000; };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (kind === "cloud") res.write(`data: ${J({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking about it" }, finish_reason: null }] })}\n\n`);
        const tick = hold ? setInterval(() => { if (!res.writableEnded) res.write(`data: ${J({ choices: [{ index: 0, delta: { reasoning_content: " still thinking" }, finish_reason: null }] })}\n\n`); }, 15000) : null;
        setTimeout(() => {
          if (tick) clearInterval(tick);
          if (res.destroyed) return;
          res.write(`data: ${J({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${J({ choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(kind === "local" ? { timings } : {}) })}\n\n`);
          if (body.stream_options?.include_usage) res.write(`data: ${J({ choices: [], usage })}\n\n`);
          res.end("data: [DONE]\n\n"); done();
        }, hold);
      } else {
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(J({ choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: finish }], usage })); done();
        }, hold);
      }
    });
  });
  return { srv, seen };
}

async function runTask(build, arm, slow) {
  const dir = join(work, `${slow ? "c" : "w"}-${build}-${arm}`);
  mkdirSync(dir, { recursive: true });
  const clog = [];
  const loc = fake("local", false, null), cld = fake("cloud", slow, clog);
  const lp = await listen(loc.srv), cp = await listen(cld.srv);
  const state = { totals: newTotals(), cell: newCell(`wiretest-${build}-${arm}`) };
  const relay = createRelay(`http://127.0.0.1:${lp}`, state);
  const rp = await listen(relay);
  const env = envFor(build, arm, `http://127.0.0.1:${rp}/v1/chat/completions`, `http://127.0.0.1:${cp}/openai/v1/chat/completions`);
  execFileSync("node", [GN(build), "init"], { cwd: dir, env, stdio: "ignore" });
  execFileSync("node", ["-e", JS[build]], { cwd: dir, env, stdio: "inherit" });
  const t0 = Date.now();
  const child = await new Promise((resolve) => {
    const out = [];
    const p = spawn("node", [GN(build), "task", "Print r4h-wire with bash and report it.", "--role", ARMS[arm].entry, "--yes", "--trust"], { cwd: dir, env });
    p.stdout.on("data", (d) => out.push(d)); p.stderr.on("data", (d) => out.push(d));
    const t = setTimeout(() => p.kill("SIGKILL"), slow ? 1500000 : 180000);
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
  return { dir, child, turns, L: loc.seen.bodies, C: cld.seen.bodies, t: state.totals, clog };
}

const offersTask = (b) => (b.tools ?? []).some((x) => x.function?.name === "task");
if (!SLOW) {
  console.log("\nB. wire: init -> the build's node block -> gnomon task (local through relay-meter-s1)");
  for (const [build, arm] of [["OLD", "PC"], ["NEW", "PC"], ["NEW", "NEG"]]) {
    const { child, turns, L, C, t } = await runTask(build, arm, false);
    const all = [...L, ...C];
    const deleg = [...child.out.matchAll(DELEG)].map((m) => `${m[1]}:${m[2]}`), surf = [...child.out.matchAll(SURF)].map((m) => m[1]);
    console.log(`\n  ${build} ${arm} (entry ${ARMS[arm].entry}): gnomon exit ${child.code}; local ${L.length} req, cloud ${C.length} req; ` +
      `models local ${J([...new Set(L.map((b) => b.model))])} cloud ${J([...new Set(C.map((b) => b.model))])}`);
    console.log(`    every request: stream ${J([...new Set(all.map((b) => b.stream ?? null))])}, max_tokens ${J([...new Set(all.map((b) => b.max_tokens ?? null))])}, ` +
      `include_usage ${J([...new Set(all.map((b) => b.stream_options?.include_usage ?? null))])}; offers task: local ${L.filter(offersTask).length}, cloud ${C.filter(offersTask).length}`);
    console.log(`    meter: chat ${t.chat_requests}, parsed ${t.req_bodies_parsed}, stream ${t.req_stream}, max_tokens ${t.req_max_tokens}, usage json ${t.usage_from_json} / timings ${t.usage_from_timings}, ` +
      `without usage ${t.responses_without_usage}, aborts ${t.client_aborts}, errors ${t.errors}`);
    console.log(`    log: DELEG ${J(deleg)} surface= ${J([...new Set(surf)])}; turn records ${turns.length}, last wire ${J(turns.at(-1)?.wire ?? null)}, stop ${turns.at(-1)?.stop_reason}`);
    check(child.code === 0, "gnomon task exited 0");
    check(L.every((b) => b.model === "qwen3.6-35b") && C.every((b) => b.model === "deepseek-v4.1-flash"), "each endpoint gets its own model id");
    if (build === "OLD") {
      check(all.length > 0 && all.every((b) => !b.stream && b.max_tokens === undefined && b.stream_options === undefined),
        "OLD: every model request is unstreamed with no max_tokens (R1H's wire)");
      check(turns.length > 0 && turns.every((r) => r.wire === undefined), "OLD: turn records carry no wire block (R1H's records)");
      if (L.length) check(t.req_bodies_parsed === L.length && t.req_stream === 0 && t.req_max_tokens === 0 && t.responses_without_usage === 0 && t.errors === 0,
        "the local meter parsed every OLD request (stream 0, max_tokens 0) and metered every response");
    } else {
      check(all.length > 0 && all.every((b) => b.stream === true && b.max_tokens === 32768 && b.stream_options?.include_usage === true),
        "NEW: every model request is streamed, asks for usage itself and carries max_tokens = 32768 (v0.4.0's wire)");
      check(turns.length > 0 && turns.every((r) => r.wire?.stream === true && r.wire?.max_tokens === 32768 && !("steer_role" in r.wire) && !r.wire?.replay_reasoning),
        "NEW: turn records: wire.stream true, wire.max_tokens 32768, no steer_role, no replay_reasoning");
      if (L.length) check(t.req_bodies_parsed === L.length && t.req_stream === L.length && t.req_max_tokens === L.length && t.responses_without_usage === 0 && t.errors === 0,
        "the local meter parsed every NEW request (streamed, max_tokens) and metered every response");
    }
    check(all.every((b) => !(b.messages ?? []).some((m) => m.role === "assistant" && m.reasoning_content)), "no reasoning_content replayed");
    check(surf.length > 0, "the log carries surface= (the collector's surface pattern)");
    if (arm === "PC") {
      check(C.length > 0 && C.every(offersTask), "PC: the coordinator's requests go to the cloud (each offers the task tool)");
      check(L.length > 0 && !L.some(offersTask), "PC: the delegated implementor sub-turn goes to the local endpoint (no task tool offered)");
      check(deleg.some((d) => d.startsWith("implementor:")), "PC: the log carries the delegation line the collector reads (task implementor — N tool call)");
    } else {
      check(C.length > 0 && L.length === 0, "NEG: cloud only (the smoke must flag it misrouted when asserted as L)");
    }
  }
} else {
  console.log(`\nC. the 300 s mechanism: the coordinator's first cloud reply held ${SLOW_S} s (OLD unstreamed: nothing until then; NEW streamed: a chunk every 15 s)`);
  const [o, n] = await Promise.all([runTask("OLD", "PC", true), runTask("NEW", "PC", true)]);
  for (const [build, r] of [["OLD", o], ["NEW", n]]) {
    console.log(`\n  ${build}: gnomon exit ${r.child.code} after ${r.child.wall_s.toFixed(0)} s; cloud requests ${r.C.length}, local ${r.L.length}; last stop ${r.turns.at(-1)?.stop_reason}`);
    for (const e of r.clog) console.log(`    cloud request ${e.n}: arrived ${e.arrived_s.toFixed(1)} s, stream ${e.stream}, ` +
      `${e.gave_up_s !== null ? `client gave up at ${e.gave_up_s.toFixed(1)} s (${(e.gave_up_s - e.arrived_s).toFixed(1)} s in)` : e.answered_s !== null ? `answered at ${e.answered_s.toFixed(1)} s` : "still open at the end"}`);
    const tail = r.child.out.split("\n").filter((l) => /retry|timed? ?out|abort|stall|header|again|fetch failed|UND_ERR/i.test(l)).slice(0, 8);
    console.log(`    gnomon's own lines about it: ${tail.length ? "\n      " + tail.join("\n      ") : "(none)"}`);
    writeFileSync(join(work, `c-${build}.json`), J({ clog: r.clog, wall_s: r.child.wall_s, code: r.child.code, turns: r.turns }));
  }
  const first = (r) => r.clog[0];
  check(o.child.code === 0 && n.child.code === 0, "both builds finished the task");
  console.log(`  reading: OLD ${first(o)?.gave_up_s !== null ? `cut its first planner call after ${(first(o).gave_up_s - first(o).arrived_s).toFixed(0)} s and asked again (${o.C.length} cloud requests)` : `waited ${SLOW_S} s for it`}; ` +
    `NEW ${first(n)?.gave_up_s !== null ? `cut its first planner call after ${(first(n).gave_up_s - first(n).arrived_s).toFixed(0)} s (${n.C.length} cloud requests)` : `waited the whole ${SLOW_S} s for it (${n.C.length} cloud requests)`}`);
}
console.log(`\nwire test${SLOW ? " (part C)" : ""}: ${ok ? "PASS" : "FAIL"} (OLD ${SHA.OLD}, NEW ${SHA.NEW})`);
process.exit(ok ? 0 : 1);

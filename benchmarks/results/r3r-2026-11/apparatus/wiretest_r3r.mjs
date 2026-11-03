// R3R offline wire test (no lane, no cloud, no network beyond 127.0.0.1), run before the chain; its output
// is committed as ../wiretest-r3r.txt. Two parts, both on the REAL pieces:
//
// A. Surface. `gnomon init` of the build under test (v0.4.0) and of R1H's build (d59e6c19), each followed
//    by a setup's own node block, extracted from the template exactly as the preflight extracts it:
//    - R1H's block (r1h-2026-11/apparatus/gnomon-setup-r1.sh.j2, read-only) on both inits: every R1H edit
//      is checked to still do on v0.4.0's init what it did on d59e6c19's;
//    - R3R's block on v0.4.0's init must produce byte-identical files to R1H's block (R3R only adds
//      assertions), and must REFUSE d59e6c19's init (negative control: the assertion bites);
//    - the exact surface difference R1H (d59 + R1H's block) -> R3R (v0.4.0 + R3R's block), per arm.
// B. Wire. For arms L, C, PC and NEG: v0.4.0 init -> R3R's node block -> `gnomon task` with the arm's entry
//    role -> a fake llama.cpp-style local server behind relay-meter-s1 (createRelay, this exact code) and
//    a fake OpenAI-style cloud server (relay-go is HTTPS-only upstream; test_relay_go_r3r.mjs covers it).
//    The fakes answer by the tools a request offers: a role with `task` (the coordinator) delegates to the
//    implementor once, then answers; a role without it runs one bash call, then answers. The cloud fake
//    also streams reasoning_content, so a replay would show. Checks: every request is streamed with
//    stream_options.include_usage and max_tokens = 32768; the arm's routing (L local only, C and NEG cloud
//    only, PC coordinator in the cloud and the implementor sub-turn local); no reasoning_content replayed;
//    the turn record's wire; and the collector's DELEG / surface= patterns match the log.
//   GNOMON_SHA=<v0.4.0 sha> R1H_SHA=<d59 sha> node wiretest_r3r.mjs <v0.4.0 tree> <d59 tree> <empty work dir>
// exit 0 when every check holds.
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay, newTotals, newCell } from "./relay-meter-s1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [treeNew, treeOld, work] = process.argv.slice(2);
if (!treeNew || !treeOld || !work) { console.error("usage: node wiretest_r3r.mjs <v0.4.0 tree> <d59 tree> <empty work dir>"); process.exit(2); }
const sha = process.env.GNOMON_SHA ?? "", shaOld = process.env.R1H_SHA ?? "";
if (sha.length !== 40 || shaOld.length !== 40) { console.error("GNOMON_SHA and R1H_SHA (40 chars) are required"); process.exit(2); }
const GN = join(treeNew, "packages/gnomon-cli/gnomon.js"), GN_OLD = join(treeOld, "packages/gnomon-cli/gnomon.js");
const blockOf = (f) => readFileSync(f, "utf8").split("cat > /opt/gnomon-run.sh <<'RUN'\n")[1].split("\nRUN\n")[0].split("node -e '")[1].split("\n'\n")[0];
const JS_R3R = blockOf(join(HERE, "gnomon-setup-r3r.sh.j2"));
const JS_R1H = blockOf(join(HERE, "../../r1h-2026-11/apparatus/gnomon-setup-r1.sh.j2"));
const J = JSON.stringify;
const ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"];
const ARMS = {  // run_r1h.py / run_r3r.py ARMS
  L: { entry: "implementor", routes: Object.fromEntries(ROLES.map((r) => [r, "local"])) },
  C: { entry: "implementor", routes: Object.fromEntries(ROLES.map((r) => [r, "cloud"])) },
  PC: { entry: "coordinator", routes: { coordinator: "cloud", implementor: "local", verifier: "local", plan: "cloud", implement: "local", critique: "local", smol: "local" } },
  NEG: { entry: "implementor", routes: Object.fromEntries(ROLES.map((r) => [r, "cloud"])) },
};
const DELEG = /task (implementor|verifier|coordinator|plan|implement|critique|smol) — (\d+) tool call/g;  // collect_m1.py
const SURF = /surface=([0-9a-f]{8,64})/g;                                                                  // collect_m1.py
let ok = true;
const check = (cond, what) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`); ok &&= Boolean(cond); };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const envFor = (arm, localUrl, cloudUrl) => {
  const e = { ...process.env, XDG_DATA_HOME: join(work, "xdg"), XDG_CONFIG_HOME: join(work, "xdgc"), NO_COLOR: "1",
    R1_ROUTES: ROLES.map((r) => `${r}=${ARMS[arm].routes[r]}`).join(","), R1_ENTRY: ARMS[arm].entry,
    R1_LOCAL_URL: localUrl, R1_CLOUD_URL: cloudUrl, R1_LOCAL_MODEL: "qwen3.6-35b", R1_CLOUD_MODEL: "deepseek-v4.1-flash", R1_ARM: arm };
  for (const k of ["OPENAI_API_KEY", "OPENCODE_API_KEY", "GNOMON_MODEL_URL", "GNOMON_MODEL_TIMEOUT_MS"]) delete e[k];
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
const prep = (gn, js, dir, env) => {  // init + one node block; returns null or the block's error
  mkdirSync(dir, { recursive: true });
  execFileSync("node", [gn, "init"], { cwd: dir, env, stdio: "ignore" });
  try { execFileSync("node", ["-e", js], { cwd: dir, env, stdio: "pipe" }); return null; }
  catch (e) { return String(e.stderr || e.message).split("\n").find((l) => /Error:/.test(l)) ?? "error"; }
};
const lineDiff = (a, b) => {  // the lines of b not in a and of a not in b, in order (small files)
  const A = a.split("\n"), B = b.split("\n");
  return [...A.filter((l) => !B.includes(l)).map((l) => `- ${l}`), ...B.filter((l) => !A.includes(l)).map((l) => `+ ${l}`)];
};

console.log(`== R3R wire test ${new Date().toISOString()}: gnomon ${sha} (v0.4.0 tree ${GN}); R1H's build ${shaOld}`);

// ------------------------------------------------------------------------------------------- A. surface
console.log("\nA. surface: R1H's edits on v0.4.0's init, R3R's assertion, and the surface diff R1H -> R3R");
const LURL = "http://172.17.0.1:5510/v1/chat/completions", CURL = "http://172.17.0.1:5511/openai/v1/chat/completions";
const initOnly = {};
for (const [tag, gn] of [["new", GN], ["old", GN_OLD]]) {
  const d = join(work, `init-${tag}`); mkdirSync(d, { recursive: true });
  execFileSync("node", [gn, "init"], { cwd: d, env: envFor("L", LURL, CURL), stdio: "ignore" });
  initOnly[tag] = readTree(d);
}
const initDiff = Object.keys({ ...initOnly.old, ...initOnly.new }).sort()
  .flatMap((f) => (initOnly.old[f] === initOnly.new[f] ? [] : [`${f}:`, ...lineDiff(initOnly.old[f] ?? "", initOnly.new[f] ?? "").map((l) => `    ${l}`)]));
console.log(`  gnomon init, d59e6c19 -> v0.4.0 (no setup edits), files that differ:\n${initDiff.map((l) => `    ${l}`).join("\n")}`);
for (const arm of Object.keys(ARMS)) {
  const env = envFor(arm, LURL, CURL);
  const e1 = prep(GN, JS_R1H, join(work, `a-${arm}-r1h-new`), env);
  const e2 = prep(GN, JS_R3R, join(work, `a-${arm}-r3r-new`), env);
  const e3 = prep(GN_OLD, JS_R1H, join(work, `a-${arm}-r1h-old`), env);
  const e4 = prep(GN_OLD, JS_R3R, join(work, `a-${arm}-r3r-old`), env);
  console.log(`\n  arm ${arm}:`);
  check(!e1 && !e2 && !e3, `R1H's block runs on both inits and R3R's on v0.4.0's (${e1 ?? "-"} / ${e2 ?? "-"} / ${e3 ?? "-"})`);
  check(e4 && /R3R: init did not write \[defaults\] stream = true/.test(e4), `R3R's block refuses d59e6c19's init (${e4})`);
  const r1hNew = readTree(join(work, `a-${arm}-r1h-new`)), r3rNew = readTree(join(work, `a-${arm}-r3r-new`)), r1hOld = readTree(join(work, `a-${arm}-r1h-old`));
  check(J(r1hNew) === J(r3rNew), "R3R's block writes byte-identical files to R1H's block on v0.4.0 (it only asserts)");
  for (const [tag, t, init] of [["d59e6c19", r1hOld, initOnly.old], ["v0.4.0", r1hNew, initOnly.new]]) {
    const c = t["config.toml"], r = t["roles.toml"], p = t["profiles/r1.toml"] ?? "";
    const routed = ROLES.every((role) => new RegExp(`\\[roles\\.${role}\\]\\nmodel = "${ARMS[arm].routes[role] === "local" ? "qwen3\\.6-35b" : "deepseek-v4\\.1-flash"}"\\nendpoint = "r1${ARMS[arm].routes[role]}"\\n`).test(p));
    const edits = {
      endpoints: c.includes(`[endpoints.r1local]\nurl = "${LURL}"\nkind = "openai"\n`) && c.includes(`[endpoints.r1cloud]\nurl = "${CURL}"\nkind = "openai"\n`),
      role_profile: /^role_profile = "r1"/m.test(c) && !/role_profile = "local_first"/.test(c),
      audit_on: /\[audit\][\s\S]*?^enabled = true/m.test(c),
      audit_edit_noop: /\[audit\][\s\S]*?^enabled = true/m.test(init["config.toml"]),
      roles_unrouted: !/^(model|endpoint) = /m.test(r) && (init["roles.toml"].match(/^(model|endpoint) = /gm) || []).length === 14,
      profile_routes: routed,
      approval_kept: t["policy.toml"] === init["policy.toml"] && /^\[approval\]\n(#[^\n]*\n)*gate = "on_write"/m.test(t["policy.toml"]),
    };
    console.log(`    ${tag}: ${Object.entries(edits).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    check(Object.values(edits).every(Boolean), `${tag}: every R1H edit did what it did on R1H's build (endpoints appended, role_profile r1, ` +
      `[audit] on (already on in init: R1H's flip is a no-op on both), 14 model/endpoint lines out of roles.toml, the r1 profile routes ${arm}, ` +
      `policy.toml untouched: it already has [approval] gate = "on_write" and --yes answers it, as in R1H)`);
  }
  const files = [...new Set([...Object.keys(r1hOld), ...Object.keys(r1hNew)])].sort();
  const sd = files.flatMap((f) => (r1hOld[f] === r1hNew[f] ? [] : [`${f}:`, ...lineDiff(r1hOld[f] ?? "", r1hNew[f] ?? "").map((l) => `    ${l}`)]));
  check(r1hOld["profiles/r1.toml"] === r1hNew["profiles/r1.toml"], `the r1 profile (the arm's routing) is byte-identical to R1H's`);
  if (arm === "L") console.log(`    surface R1H (d59e6c19 + R1H's block) -> R3R (v0.4.0 + R3R's block), identical for every arm:\n${sd.map((l) => `      ${l}`).join("\n")}`);
  else check(J(sd) === J(globalThis.SD_L), "the same surface diff as arm L (the build's init is the only change)");
  if (arm === "L") globalThis.SD_L = sd;
}

// ------------------------------------------------------------------------------------------- B. wire
function fake(kind) {  // kind: local (llama.cpp-like) | cloud (OpenAI-like, with reasoning_content and cached tokens)
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
      let delta;
      if (tools.includes("task") && toolMsgs === 0) {
        delta = { tool_calls: [{ index: 0, id: `call_${kind}_${n}`, type: "function", function: { name: "task",
          arguments: J({ role: "implementor", instruction: "Print r3r-wire with bash, then report what it printed." }) } }] };
      } else if (tools.includes("bash") && toolMsgs === 0) {
        delta = { tool_calls: [{ index: 0, id: `call_${kind}_${n}`, type: "function", function: { name: "bash", arguments: J({ command: "echo r3r-wire" }) } }] };
      } else {
        delta = { content: "Done: the command printed r3r-wire." };
      }
      const finish = delta.tool_calls ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 1000 + n, completion_tokens: 20, total_tokens: 1020 + n,
        ...(kind === "cloud" ? { prompt_tokens_details: { cached_tokens: 512 } } : {}) };
      const timings = { cache_n: 900, prompt_n: 100 + n, predicted_n: 20, prompt_ms: 50, predicted_ms: 80 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (kind === "cloud") res.write(`data: ${J({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking about it" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${J({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${J({ choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(kind === "local" ? { timings } : {}) })}\n\n`);
        if (body.stream_options?.include_usage) res.write(`data: ${J({ choices: [], usage })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(J({ choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: finish }], usage }));
      }
    });
  });
  return { srv, seen };
}

console.log("\nB. wire: v0.4.0 init -> R3R's node block -> gnomon task, per arm (local through relay-meter-s1)");
const surfaces = {};
for (const arm of Object.keys(ARMS)) {
  const dir = join(work, `w-${arm}`);
  mkdirSync(dir, { recursive: true });
  const loc = fake("local"), cld = fake("cloud");
  const lp = await listen(loc.srv), cp = await listen(cld.srv);
  const state = { totals: newTotals(), cell: newCell(`wiretest-${arm}`) };
  const relay = createRelay(`http://127.0.0.1:${lp}`, state);
  const rp = await listen(relay);
  const env = envFor(arm, `http://127.0.0.1:${rp}/v1/chat/completions`, `http://127.0.0.1:${cp}/openai/v1/chat/completions`);
  execFileSync("node", [GN, "init"], { cwd: dir, env, stdio: "ignore" });
  execFileSync("node", ["-e", JS_R3R], { cwd: dir, env, stdio: "inherit" });
  const child = await new Promise((resolve) => {
    const out = [];
    const p = spawn("node", [GN, "task", "Print r3r-wire with bash and report it.", "--role", ARMS[arm].entry, "--yes", "--trust"], { cwd: dir, env });
    p.stdout.on("data", (d) => out.push(d)); p.stderr.on("data", (d) => out.push(d));
    const t = setTimeout(() => p.kill("SIGKILL"), 180000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out: Buffer.concat(out).toString("utf8") }); });
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
  surfaces[arm] = readFileSync(join(dir, ".gnomon/config.toml"), "utf8").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT");
  const L = loc.seen.bodies, C = cld.seen.bodies, t = state.totals;
  const all = [...L, ...C];
  const offersTask = (b) => (b.tools ?? []).some((x) => x.function?.name === "task");
  const deleg = [...child.out.matchAll(DELEG)].map((m) => `${m[1]}:${m[2]}`), surf = [...child.out.matchAll(SURF)].map((m) => m[1]);
  console.log(`\n  ${arm} (entry ${ARMS[arm].entry}): gnomon exit ${child.code}; local ${L.length} req, cloud ${C.length} req; ` +
    `models local ${J([...new Set(L.map((b) => b.model))])} cloud ${J([...new Set(C.map((b) => b.model))])}`);
  console.log(`    every request: stream ${J([...new Set(all.map((b) => b.stream))])}, max_tokens ${J([...new Set(all.map((b) => b.max_tokens))])}, ` +
    `include_usage ${J([...new Set(all.map((b) => b.stream_options?.include_usage ?? null))])}; offers task: local ${L.filter(offersTask).length}, cloud ${C.filter(offersTask).length}`);
  console.log(`    meter: chat ${t.chat_requests}, parsed ${t.req_bodies_parsed}, stream ${t.req_stream}, max_tokens ${t.req_max_tokens}, usage json ${t.usage_from_json} / timings ${t.usage_from_timings}, ` +
    `without usage ${t.responses_without_usage}, reasoning replayed ${t.req_with_reasoning_content}, late system ${t.req_with_late_system}, aborts ${t.client_aborts}, errors ${t.errors}`);
  console.log(`    log: DELEG ${J(deleg)} surface= ${J([...new Set(surf)])}; turn records ${turns.length}, last wire ${J(turns.at(-1)?.wire)}, stop ${turns.at(-1)?.stop_reason}, unmetered_calls ${turns.at(-1)?.counters?.unmetered_calls ?? "absent"}`);
  check(child.code === 0, "gnomon task exited 0");
  check(all.length > 0 && all.every((b) => b.stream === true && b.max_tokens === 32768 && b.stream_options?.include_usage === true),
    "every model request is streamed, asks for usage itself (stream_options.include_usage) and carries max_tokens = 32768");
  check(L.every((b) => b.model === "qwen3.6-35b") && C.every((b) => b.model === "deepseek-v4.1-flash"), "each endpoint gets its own model id");
  check(all.every((b) => !(b.messages ?? []).some((m) => m.role === "assistant" && m.reasoning_content)), "no reasoning_content replayed (release default: off for these hosts)");
  check(turns.length > 0 && turns.every((r) => r.wire?.stream === true && r.wire?.max_tokens === 32768 && !("steer_role" in r.wire) && !r.wire?.replay_reasoning),
    "turn records: wire.stream true, wire.max_tokens 32768, no steer_role (release default system), no replay_reasoning");
  check(surf.length > 0, "the log carries surface= (the collector's surface pattern)");
  if (L.length) check(t.req_bodies_parsed === L.length && t.req_stream === L.length && t.req_max_tokens === L.length && t.responses_without_usage === 0 && t.errors === 0,
    "the local meter parsed every request, saw stream and max_tokens on each, and metered every response");
  if (arm === "L") check(L.length > 0 && C.length === 0, "L: local only");
  if (arm === "C" || arm === "NEG") check(C.length > 0 && L.length === 0, `${arm}: cloud only (NEG is routed as C; the smoke must flag it misrouted when asserted as L)`);
  if (arm === "PC") {
    check(C.length > 0 && C.every(offersTask), "PC: the coordinator's requests go to the cloud (each offers the task tool)");
    check(L.length > 0 && !L.some(offersTask), "PC: the delegated implementor sub-turn goes to the local endpoint (no task tool offered)");
    check(deleg.some((d) => d.startsWith("implementor:")), "PC: the log carries the delegation line the collector reads (task implementor — N tool call)");
  }
}
const base = surfaces.L;
check(Object.values(surfaces).every((s) => s === base), "config.toml is identical across arms (ports normalised); arms differ only in profiles/r1.toml, as in R1H");
console.log(`\nwire test: ${ok ? "PASS" : "FAIL"} (gnomon ${sha})`);
process.exit(ok ? 0 : 1);

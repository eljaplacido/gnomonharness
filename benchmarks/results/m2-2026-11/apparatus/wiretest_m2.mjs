// M2 offline wire test (no lane, no cloud, no network beyond 127.0.0.1), run at preparation; its output is committed as
// ../wiretest-m2.txt. Both parts on the REAL pieces (R3R's wiretest_r3r.mjs, narrowed to what M2 adds):
//
// A. Surface. v0.4.0's own `gnomon init`, then a setup's node block, extracted from the template as the preflight does:
//    - M2's block with M2_LOCAL_REPLAY=false writes byte-identical files to R3R's block (r3r-2026-11, read-only), for
//      L and PC: the control's surface and M2's non-replay lanes' surface are the same;
//    - with "true" the only difference is ONE added line, `replay_reasoning = true`, under [endpoints.r1local];
//    - the block refuses a cell without M2_LOCAL_REPLAY.
// B. Wire. For L and PC, replay off and on: v0.4.0 init -> M2's node block -> `gnomon task` with the arm's entry role
//    -> a fake llama.cpp-style local server that streams reasoning_content beside its tool call (as Glimmer does),
//    behind relay-meter-s1 (createRelay, this exact code), and a fake OpenAI-style cloud server that streams
//    reasoning_content too. Checks: every request streamed with include_usage and max_tokens = 32768; the arm's
//    routing; replay on -> every local request after a reply with reasoning + a tool call sends the reasoning back
//    (the meter's following_reasoning_replayed = following_reasoning > 0) and the turn record says replay_reasoning;
//    replay off -> no local request carries reasoning_content; the cloud is never sent reasoning_content (the relay URL
//    is not api.deepseek.com: v0.4.0's default is off there, as in R3R).
//   GNOMON_SHA=<v0.4.0 sha> node wiretest_m2.mjs <v0.4.0 tree> <empty work dir>
// exit 0 when every check holds.
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay, newTotals, newCell } from "./relay-meter-s1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [tree, work] = process.argv.slice(2);
if (!tree || !work) { console.error("usage: node wiretest_m2.mjs <v0.4.0 tree> <empty work dir>"); process.exit(2); }
const sha = process.env.GNOMON_SHA ?? "";
if (sha.length !== 40) { console.error("GNOMON_SHA (40 chars) is required"); process.exit(2); }
const GN = join(tree, "packages/gnomon-cli/gnomon.js");
const blockOf = (f) => readFileSync(f, "utf8").split("cat > /opt/gnomon-run.sh <<'RUN'\n")[1].split("\nRUN\n")[0].split("node -e '")[1].split("\n'\n")[0];
const JS_M2 = blockOf(join(HERE, "gnomon-setup-m2.sh.j2"));
const JS_R3R = blockOf(join(HERE, "../../r3r-2026-11/apparatus/gnomon-setup-r3r.sh.j2"));
const J = JSON.stringify;
const ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"];
const ARMS = {  // run_m2.py ARMS (= R1H's)
  L: { entry: "implementor", routes: Object.fromEntries(ROLES.map((r) => [r, "local"])) },
  PC: { entry: "coordinator", routes: { coordinator: "cloud", implementor: "local", verifier: "local", plan: "cloud", implement: "local", critique: "local", smol: "local" } },
};
let ok = true;
const check = (cond, what) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`); ok &&= Boolean(cond); };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const envFor = (arm, localUrl, cloudUrl, replay) => {
  const e = { ...process.env, XDG_DATA_HOME: join(work, "xdg"), XDG_CONFIG_HOME: join(work, "xdgc"), NO_COLOR: "1",
    R1_ROUTES: ROLES.map((r) => `${r}=${ARMS[arm].routes[r]}`).join(","), R1_ENTRY: ARMS[arm].entry,
    R1_LOCAL_URL: localUrl, R1_CLOUD_URL: cloudUrl, R1_LOCAL_MODEL: "glimmer-30b", R1_CLOUD_MODEL: "deepseek-v4.1-flash", R1_ARM: arm };
  if (replay !== undefined) e.M2_LOCAL_REPLAY = replay; else delete e.M2_LOCAL_REPLAY;
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
const prep = (js, dir, env) => {
  mkdirSync(dir, { recursive: true });
  execFileSync("node", [GN, "init"], { cwd: dir, env, stdio: "ignore" });
  try { execFileSync("node", ["-e", js], { cwd: dir, env, stdio: "pipe" }); return null; }
  catch (e) { return String(e.stderr || e.message).split("\n").find((l) => /Error:/.test(l)) ?? "error"; }
};
const lineDiff = (a, b) => {
  const A = a.split("\n"), B = b.split("\n");
  return [...A.filter((l) => !B.includes(l)).map((l) => `- ${l}`), ...B.filter((l) => !A.includes(l)).map((l) => `+ ${l}`)];
};

console.log(`== M2 wire test ${new Date().toISOString()}: gnomon ${sha} (v0.4.0 tree ${GN})`);
console.log("\nA. surface: M2's block (replay off / on) against R3R's block, on v0.4.0's init");
const LURL = "http://172.17.0.1:5710/v1/chat/completions", CURL = "http://172.17.0.1:5711/openai/v1/chat/completions";
for (const arm of Object.keys(ARMS)) {
  console.log(`\n  arm ${arm}:`);
  const eR = prep(JS_R3R, join(work, `a-${arm}-r3r`), envFor(arm, LURL, CURL, undefined));
  const eF = prep(JS_M2, join(work, `a-${arm}-m2-off`), envFor(arm, LURL, CURL, "false"));
  const eT = prep(JS_M2, join(work, `a-${arm}-m2-on`), envFor(arm, LURL, CURL, "true"));
  const eN = prep(JS_M2, join(work, `a-${arm}-m2-none`), envFor(arm, LURL, CURL, undefined));
  check(!eR && !eF && !eT, `R3R's block and M2's (off, on) run on v0.4.0's init (${eR ?? "-"} / ${eF ?? "-"} / ${eT ?? "-"})`);
  check(eN && /M2_LOCAL_REPLAY must be true or false/.test(eN), `M2's block refuses a cell without M2_LOCAL_REPLAY (${eN})`);
  const r3r = readTree(join(work, `a-${arm}-r3r`)), off = readTree(join(work, `a-${arm}-m2-off`)), on = readTree(join(work, `a-${arm}-m2-on`));
  check(J(r3r) === J(off), "replay off: byte-identical files to R3R's block (the control's surface)");
  const files = [...new Set([...Object.keys(off), ...Object.keys(on)])].sort();
  const changed = files.filter((f) => off[f] !== on[f]);
  const d = lineDiff(off["config.toml"], on["config.toml"]);
  console.log(`    replay on vs off: files that differ ${J(changed)}; config.toml: ${J(d)}`);
  check(J(changed) === J(["config.toml"]) && J(d) === J(["+ replay_reasoning = true"])
        && /\[endpoints\.r1local\]\nurl = "[^"]*"\nkind = "openai"\nreplay_reasoning = true\n\n\[endpoints\.r1cloud\]/.test(on["config.toml"]),
        "replay on: exactly one added line, replay_reasoning = true, under [endpoints.r1local]; nothing else changes");
}

function fake(kind) {  // local: llama.cpp-like, streams reasoning_content beside its tool call; cloud: OpenAI-like, with reasoning too
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
          arguments: J({ role: "implementor", instruction: "Print m2-wire with bash twice, then report what it printed." }) } }] };
      } else if (tools.includes("bash") && toolMsgs < 2) {
        delta = { tool_calls: [{ index: 0, id: `call_${kind}_${n}`, type: "function", function: { name: "bash", arguments: J({ command: `echo m2-wire-${toolMsgs}` }) } }] };
      } else {
        delta = { content: "Done: the commands printed m2-wire-0 and m2-wire-1." };
      }
      const finish = delta.tool_calls ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 1000 + n, completion_tokens: 20, total_tokens: 1020 + n };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${J({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: `REASONING-${kind}-${n}: think first.` }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${J({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${J({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      if (body.stream_options?.include_usage) res.write(`data: ${J({ choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return { srv, seen };
}

console.log("\nB. wire: v0.4.0 init -> M2's node block -> gnomon task; the local endpoint streams reasoning beside its tool calls");
for (const arm of Object.keys(ARMS)) {
  for (const replay of ["false", "true"]) {
    const dir = join(work, `w-${arm}-${replay}`);
    mkdirSync(dir, { recursive: true });
    const loc = fake("local"), cld = fake("cloud");
    const lp = await listen(loc.srv), cp = await listen(cld.srv);
    const state = { totals: newTotals(), cell: newCell(`wiretest-${arm}-${replay}`) };
    const relay = createRelay(`http://127.0.0.1:${lp}`, state);
    const rp = await listen(relay);
    const env = envFor(arm, `http://127.0.0.1:${rp}/v1/chat/completions`, `http://127.0.0.1:${cp}/openai/v1/chat/completions`, replay);
    execFileSync("node", [GN, "init"], { cwd: dir, env, stdio: "ignore" });
    execFileSync("node", ["-e", JS_M2], { cwd: dir, env, stdio: "inherit" });
    const child = await new Promise((resolve) => {
      const out = [];
      const p = spawn("node", [GN, "task", "Print m2-wire with bash twice and report it.", "--role", ARMS[arm].entry, "--yes", "--trust"], { cwd: dir, env });
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
    const L = loc.seen.bodies, C = cld.seen.bodies, t = state.totals;
    const all = [...L, ...C];
    const rc = (b) => (b.messages ?? []).some((m) => m.role === "assistant" && m.reasoning_content);
    console.log(`\n  ${arm}, replay ${replay}: gnomon exit ${child.code}; local ${L.length} req (${L.filter(rc).length} with reasoning_content), ` +
      `cloud ${C.length} req (${C.filter(rc).length} with reasoning_content)`);
    console.log(`    meter: chat ${t.chat_requests}, stream ${t.req_stream}, max_tokens ${t.req_max_tokens}, with assistant ${t.req_with_assistant}, ` +
      `reasoning replayed ${t.req_with_reasoning_content}, replies with reasoning ${t.responses_with_reasoning}, following ${t.following_reasoning}, ` +
      `following replayed ${t.following_reasoning_replayed}, late system ${t.req_with_late_system}`);
    console.log(`    turn records ${turns.length}: wire ${J(turns.map((r) => r.wire))}`);
    check(child.code === 0, "gnomon task exited 0");
    check(all.length > 0 && all.every((b) => b.stream === true && b.max_tokens === 32768 && b.stream_options?.include_usage === true),
      "every request streamed, asks for usage itself and carries max_tokens = 32768");
    check(L.every((b) => b.model === "glimmer-30b") && C.every((b) => b.model === "deepseek-v4.1-flash"), "each endpoint gets its own model id");
    check(!C.some(rc), "the cloud is never sent reasoning_content (v0.4.0's default for a non-DeepSeek host, as in R3R)");
    if (replay === "true") {
      check(t.following_reasoning > 0 && t.following_reasoning_replayed === t.following_reasoning && L.filter(rc).length > 0,
        "replay on: every local request after a reply with reasoning + a tool call sends the reasoning back (meter: following replayed = following > 0)");
      if (arm === "L") check(turns.some((r) => r.wire?.replay_reasoning), "replay on, L: the turn record's wire says replay_reasoning");
      else check(turns.length > 0 && !turns.some((r) => r.wire?.replay_reasoning),
        "replay on, PC: the one turn record is the coordinator's (cloud endpoint, no replay); the local sub-turn's replay shows on the meter above");
    } else {
      check(!L.some(rc) && t.req_with_reasoning_content === 0, "replay off: no local request carries reasoning_content (the negative control)");
      check(!turns.some((r) => r.wire?.replay_reasoning), "replay off: no turn record says replay_reasoning");
    }
    if (arm === "L") check(L.length > 0 && C.length === 0, "L: local only");
    if (arm === "PC") {
      const offersTask = (b) => (b.tools ?? []).some((x) => x.function?.name === "task");
      check(C.length > 0 && C.every(offersTask) && L.length > 0 && !L.some(offersTask), "PC: the coordinator in the cloud, the delegated implementor sub-turn local");
      check(/task implementor — \d+ tool call/.test(child.out), "PC: the log carries the delegation line the collector reads");
    }
  }
}
console.log(`\nwire test: ${ok ? "PASS" : "FAIL"} (gnomon ${sha})`);
process.exit(ok ? 0 : 1);

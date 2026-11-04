// N1 offline wire test (no lane, no model server; nothing beyond 127.0.0.1), run before the chain; its output is
// committed as ../wiretest-n1.txt. A copy of S1's wiretest_s1.mjs, changed for N1. For each arm it runs the REAL
// pieces end to end:
//   gnomon init (the v0.4.1 RELEASE, installed from its pinned tarballs by install_release_n1.sh) -> the setup's own
//   node block (extracted from gnomon-setup-n1.sh.j2, as the preflight does) -> `gnomon task` -> relay-meter-s1
//   (createRelay, this exact code, the meter the run uses) -> a fake llama.cpp-style server that answers with 15
//   distinct non-writing bash calls, then a final answer. At nudge_after_idle = 12 the idle nudge fires once.
// Checks, per arm:
//   N1 (nudge_after_idle = 12):     the nudge went out as a [gnomon] user note; counters.nudges >= 1;
//                                   counters.model_calls.steered_calls.nudge > 0, every nudge-carrying call via user
//   N0 (nudge_after_idle = 100000): NO [gnomon] nudge note on the wire (the negative control); counters.nudges = 0;
//                                   counters.model_calls.steered_calls.nudge = 0
//   both: steer_role = "user" on the wire record, no system message after the first, no refusal learned, no
//   convergence push; and the two surfaces differ by exactly the nudge_after_idle line. Last, the wire itself:
//   with the [gnomon] nudge notes taken out of N1's requests (and each arm's own work dir and meter port
//   normalised), the two arms sent the SAME request bodies, request for request: the nudge is the only difference.
//   node wiretest_n1.mjs <gnomon bin of the installed v0.4.1 release> <empty work dir>
// exit 0 when every check holds.
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay, newTotals, newCell } from "./relay-meter-s1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [GN, work] = process.argv.slice(2);
if (!GN || !work) { console.error("usage: node wiretest_n1.mjs <gnomon bin> <empty work dir>"); process.exit(2); }
const version = execFileSync(GN, ["--version"], { encoding: "utf8" }).trim().split("\n").at(-1);
const setup = readFileSync(join(HERE, "gnomon-setup-n1.sh.j2"), "utf8");
const run = setup.split("cat > /opt/gnomon-run.sh <<'RUN'\n")[1].split("\nRUN\n")[0];
const js = run.split("node -e '")[1].split("\n'\n")[0];
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const J = JSON.stringify;
const CALLS = 15;

function fakeLlama() {
  const seen = { bodies: [] };
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b);
      seen.bodies.push(body);
      const n = seen.bodies.length;
      const tools = Array.isArray(body.tools) && body.tools.length > 0;
      const delta = tools && n <= CALLS
        ? { tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: "bash", arguments: J({ command: `echo step-${n}` }) } }] }
        : { content: "Final: the directory was listed; nothing needed changing." };
      const finish = delta.tool_calls ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 100 + n, completion_tokens: 10, total_tokens: 110 + n };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${J({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${J({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
        res.write(`data: ${J({ choices: [], usage })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(J({ choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: finish }], usage }));
      }
    });
  });
  return { srv, seen };
}

const results = {};
let ok = true;
const check = (cond, what) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`); ok &&= Boolean(cond); };
console.log(`== N1 wire test ${new Date().toISOString()}: ${version} (${GN})`);
check(version === "gnomon/0.4.1+v0.4.1-c511b81", "the binary under test is the pinned v0.4.1 release build");
for (const [arm, nv] of [["N1", "12"], ["N0", "100000"]]) {
  const dir = join(work, arm.toLowerCase());
  mkdirSync(dir, { recursive: true });
  const up = fakeLlama();
  const upPort = await listen(up.srv);
  const state = { totals: newTotals(), cell: newCell(`wiretest-${arm}`) };
  const relay = createRelay(`http://127.0.0.1:${upPort}`, state);
  const rPort = await listen(relay);
  const env = { ...process.env, XDG_DATA_HOME: join(work, "xdg"), XDG_CONFIG_HOME: join(work, "xdgc"), NO_COLOR: "1",
    R1_ROUTES: "coordinator=local,implementor=local,verifier=local,plan=local,implement=local,critique=local,smol=local",
    R1_LOCAL_URL: `http://127.0.0.1:${rPort}/v1/chat/completions`, R1_CLOUD_URL: "http://127.0.0.1:9/openai/v1/chat/completions",
    R1_LOCAL_MODEL: "qwen3.6-35b", R1_CLOUD_MODEL: "deepseek-v4.1-flash", R1_ARM: "L",
    N1_STEER_ROLE: "user", N1_NUDGE_AFTER_IDLE: nv };
  for (const k of ["OPENAI_API_KEY", "OPENCODE_API_KEY", "GNOMON_MODEL_URL"]) delete env[k];
  execFileSync(GN, ["init"], { cwd: dir, env, stdio: "ignore" });
  execFileSync("node", ["-e", js], { cwd: dir, env, stdio: "inherit" });
  // `gnomon task` must not block this process's event loop: the fake server and the relay live here.
  const child = await new Promise((resolve) => {
    const out = [];
    const p = spawn(GN, ["task", "List the files in this directory.", "--role", "implementor", "--yes", "--trust"], { cwd: dir, env });
    p.stdout.on("data", (d) => out.push(d)); p.stderr.on("data", (d) => out.push(d));
    const t = setTimeout(() => p.kill("SIGKILL"), 180000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out: Buffer.concat(out).toString("utf8") }); });
  });
  relay.close(); up.srv.close();
  writeFileSync(join(dir, "task.log"), child.out);
  const turns = [];
  const auditDir = join(dir, ".gnomon-audit");
  if (existsSync(auditDir)) {
    for (const f of readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(auditDir, f), "utf8").split("\n")) {
        try { const r = JSON.parse(line); if (r.kind === "turn") turns.push(r); } catch { /* not a record */ }
      }
    }
  }
  const t = state.totals;
  const last = turns.at(-1) ?? {};
  const mc = last.counters?.model_calls;
  const nudgeCalls = (mc?.calls ?? []).filter((c) => (c.steer?.nudge ?? 0) > 0);
  const surface = readFileSync(join(dir, ".gnomon/config.toml"), "utf8");
  results[arm] = { surface, bodies: up.seen.bodies, dir, rPort };
  const sysAfterFirst = up.seen.bodies.filter((b) => b.messages.some((m, i) => i > 0 && m.role === "system")).length;
  console.log(`\n${arm} (steer_role = "user", nudge_after_idle = ${nv}): gnomon exit ${child.code}; ${up.seen.bodies.length} requests reached the fake server`);
  console.log(`  relay: chat ${t.chat_requests}, late system ${t.req_with_late_system} req, [gnomon] notes ${t.req_with_gnomon_note} req ` +
    `(${t.gnomon_note_msgs} msgs, new ${t.req_new_gnomon_note}); kinds as a note: ` +
    ["nudge", "converge", "wrapup", "verify", "context", "other"].map((k) => `${k} ${t[`steer_${k}_note`]}`).join(", ") +
    `; client_aborts ${t.client_aborts}, errors ${t.errors}`);
  console.log(`  turn record: wire ${J(last.wire)}, nudges ${last.counters?.nudges}, first_nudge_step ${last.counters?.first_nudge_step ?? "absent"}, ` +
    `steer_role_adapted ${last.counters?.steer_role_adapted ?? "absent"}, stop_reason ${last.stop_reason}, tool_steps ${last.tool_steps}`);
  console.log(`  counters.model_calls: v ${mc?.v}, count ${mc?.count}, steered_calls ${J(mc?.steered_calls)}, ` +
    `nudge-carrying calls ${nudgeCalls.length} (via ${J([...new Set(nudgeCalls.map((c) => c.via))])})`);
  check(child.code === 0, "gnomon task ran to exit 0 (not killed at 180 s)");
  check(t.req_bodies_parsed === t.chat_requests && t.chat_requests === up.seen.bodies.length, "the relay parsed every request the server saw");
  check(last.wire?.steer_role === "user", "the turn record's wire says steer_role user");
  check(t.req_with_late_system === 0 && t.req_with_dropped_system === 0 && sysAfterFirst === 0, "no system message after the first");
  check((last.counters?.steer_role_adapted ?? 0) === 0, "no refusal was learned (steer_role_adapted absent or 0)");
  check(t.steer_converge_note === 0 && (mc?.steered_calls?.converge ?? 0) === 0, "no convergence push (implementor declares no converge_after)");
  check(mc && mc.v === 1 && mc.count === up.seen.bodies.length, "counters.model_calls is present and counts every request");
  if (nv === "12") {
    check((last.counters?.nudges ?? 0) >= 1, "N1: the idle nudge fired (counters.nudges >= 1)");
    check(t.req_with_gnomon_note > 0 && t.steer_nudge_note > 0, "N1: the nudge went out as a [gnomon] user note (meter)");
    check((mc?.steered_calls?.nudge ?? 0) > 0 && nudgeCalls.length > 0 && nudgeCalls.every((c) => c.via === "user"),
      "N1: counters.model_calls logs the nudge on its calls, via user");
  } else {
    check((last.counters?.nudges ?? 0) === 0 && last.counters?.first_nudge_step === undefined, "N0: no nudge fired (counters.nudges = 0)");
    check(t.steer_nudge_note === 0 && t.req_with_gnomon_note === 0, "N0: no [gnomon] note on the wire (the negative control)");
    check((mc?.steered_calls?.nudge ?? 0) === 0 && nudgeCalls.length === 0, "N0: counters.model_calls logs no nudge");
  }
}
// The arms' surfaces: every byte equal except the nudge_after_idle line (meter port normalised).
const norm = (s) => s.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT").split("\n");
const a = norm(results.N1.surface), b = norm(results.N0.surface);
const diff = a.length === b.length ? a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y) : null;
console.log(`\nsurface diff N1 vs N0: ${J(diff)}`);
check(diff && diff.length === 1 && /^nudge_after_idle = 12\b/.test(diff[0][0]) && /^nudge_after_idle = 100000\b/.test(diff[0][1]),
  "the two surfaces differ by exactly the nudge_after_idle line");
// The wire: N1's requests without their nudge notes are N0's requests.
const stripNudge = (body, arm) => {
  const r = results[arm];
  const msgs = [];
  for (const m of body.messages) {
    if (m.role === "user" && typeof m.content === "string" && m.content.startsWith("[gnomon] You have run ")) continue;
    msgs.push(m);
  }
  return J({ ...body, messages: msgs }).split(r.dir).join("<DIR>").split(`:${r.rPort}`).join(":PORT");
};
const A = results.N1.bodies.map((x) => stripNudge(x, "N1")), B = results.N0.bodies.map((x) => stripNudge(x, "N0"));
const firstDiff = A.findIndex((x, i) => x !== B[i]);
const withNote = results.N1.bodies.filter((x) => x.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[gnomon] You have run "))).length;
console.log(`requests: N1 ${A.length} (${withNote} carry a nudge note), N0 ${B.length}; first differing request after removing the notes: ${firstDiff < 0 ? "none" : firstDiff + 1}`);
check(A.length === B.length && firstDiff < 0 && withNote > 0, "with the nudge notes removed, N1 sent exactly N0's request bodies");
console.log(`\nwire test: ${ok ? "PASS" : "FAIL"} (${version})`);
process.exit(ok ? 0 : 1);

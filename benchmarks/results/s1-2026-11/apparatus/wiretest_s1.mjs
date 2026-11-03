// S1 offline wire test (no lane, no network beyond 127.0.0.1), run once before the chain; its output
// is committed as ../wiretest-s1.txt. For each arm it runs the REAL pieces end to end:
//   gnomon init (the build under test) -> the setup's own node block (extracted from
//   gnomon-setup-s1.sh.j2, as the preflight does) -> `gnomon task` -> relay-meter-s1 (createRelay,
//   this exact code) -> a fake llama.cpp-style server that answers with 15 distinct non-writing bash
//   calls, so gnomon's idle nudge fires (nudge_after_idle = 12), then a final answer.
// It checks that arm S0 sends the nudge as a late system message (which R1H's template drops) and no
// [gnomon] note, that arm S1 sends it as a [gnomon] note and no late system message, what the turn
// record says (wire.steer_role, counters.nudges, counters.steer_role_adapted), and that the two arms'
// surfaces differ by exactly the steer_role line.
//   GNOMON_SHA=<40-char sha> node wiretest_s1.mjs <gnomon tree at that sha (git archive)> <empty work dir>
// exit 0 when every check holds.
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay, newTotals, newCell } from "./relay-meter-s1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [gnomonDir, work] = process.argv.slice(2);
if (!gnomonDir || !work) { console.error("usage: node wiretest_s1.mjs <gnomon checkout> <empty work dir>"); process.exit(2); }
const GN = join(gnomonDir, "packages/gnomon-cli/gnomon.js");
const sha = process.env.GNOMON_SHA ?? "";
if (sha.length !== 40) { console.error("GNOMON_SHA (40 chars) is required: the commit the tree was archived from"); process.exit(2); }
const setup = readFileSync(join(HERE, "gnomon-setup-s1.sh.j2"), "utf8");
const run = setup.split("cat > /opt/gnomon-run.sh <<'RUN'\n")[1].split("\nRUN\n")[0];
const js = run.split("node -e '")[1].split("\n'\n")[0];
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const J = JSON.stringify;

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
      const delta = tools && n <= 15
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
const check = (cond, what) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`); ok &&= cond; };
console.log(`== S1 wire test ${new Date().toISOString()}: gnomon ${sha} (${GN})`);
for (const [arm, role] of [["S0", "system"], ["S1", "user"]]) {
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
    R1_LOCAL_MODEL: "qwen3.6-35b", R1_CLOUD_MODEL: "deepseek-v4.1-flash", R1_ARM: "L", S1_STEER_ROLE: role };
  for (const k of ["OPENAI_API_KEY", "OPENCODE_API_KEY", "GNOMON_MODEL_URL"]) delete env[k];
  execFileSync("node", [GN, "init"], { cwd: dir, env, stdio: "ignore" });
  execFileSync("node", ["-e", js], { cwd: dir, env, stdio: "inherit" });
  // `gnomon task` blocks this process's event loop if run synchronously, and the fake server and the
  // relay live in this process: run it as a child and wait asynchronously.
  const child = await new Promise((resolve) => {
    const out = [];
    const p = spawn("node", [GN, "task", "List the files in this directory.", "--role", "implementor", "--yes", "--trust"],
      { cwd: dir, env });
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
  const lastTurn = turns.at(-1) ?? {};
  const surface = readFileSync(join(dir, ".gnomon/config.toml"), "utf8");
  results[arm] = { surface, t };
  const sysAfterFirst = up.seen.bodies.filter((b) => b.messages.some((m, i) => i > 0 && m.role === "system")).length;
  console.log(`\n${arm} (steer_role = "${role}"): gnomon exit ${child.code}; ${up.seen.bodies.length} requests reached the fake server`);
  console.log(`  relay: chat ${t.chat_requests}, late system ${t.req_with_late_system} req, dropped (R1H template) ${t.req_with_dropped_system} req ` +
    `(${t.dropped_system_msgs} msgs, new ${t.req_new_dropped_system}), [gnomon] notes ${t.req_with_gnomon_note} req (${t.gnomon_note_msgs} msgs, ` +
    `new ${t.req_new_gnomon_note}); kinds dropped/note: ` +
    ["nudge", "converge", "wrapup", "verify", "context", "other"].map((k) => `${k} ${t[`steer_${k}_dropped`]}/${t[`steer_${k}_note`]}`).join(", ") +
    `; client_aborts ${t.client_aborts}, errors ${t.errors}`);
  console.log(`  turn record: wire ${J(lastTurn.wire)}, nudges ${lastTurn.counters?.nudges}, steer_role_adapted ` +
    `${lastTurn.counters?.steer_role_adapted ?? "absent"}, stop_reason ${lastTurn.stop_reason}`);
  check(child.code !== null, "gnomon task ran to an exit (not killed at 180 s)");
  check((lastTurn.counters?.nudges ?? 0) >= 1, "the idle nudge fired at least once");
  check(t.req_bodies_parsed === t.chat_requests && t.chat_requests === up.seen.bodies.length, "the relay parsed every request the server saw");
  check((lastTurn.counters?.steer_role_adapted ?? 0) === 0, "no refusal was learned (steer_role_adapted absent or 0)");
  if (role === "system") {
    check(t.req_with_dropped_system > 0 && t.steer_nudge_dropped > 0, "S0: the nudge went out as a system message the R1H template drops");
    check(t.req_with_gnomon_note === 0, "S0: no [gnomon] note was sent");
    check(lastTurn.wire && !("steer_role" in lastTurn.wire), "S0: the turn record's wire carries no steer_role");
  } else {
    check(t.req_with_gnomon_note > 0 && t.steer_nudge_note > 0, "S1: the nudge went out as a [gnomon] user note");
    check(t.req_with_late_system === 0 && t.req_with_dropped_system === 0 && sysAfterFirst === 0, "S1: no system message after the first");
    check(lastTurn.wire?.steer_role === "user", "S1: the turn record's wire says steer_role user");
  }
}
// Each arm reaches its own meter (as in the run: 5410 vs 5412), so the url port is normalised; every
// other byte of the two surfaces must match except the steer_role line.
const norm = (s) => s.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT").split("\n");
const a = norm(results.S0.surface), b = norm(results.S1.surface);
const diff = a.length === b.length ? a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y) : null;
console.log(`\nsurface diff S0 vs S1: ${J(diff)}`);
check(diff && diff.length === 1 && diff[0][0] === 'steer_role = "system"' && diff[0][1] === 'steer_role = "user"',
  "the two surfaces differ by exactly the steer_role line (meter port normalised)");
console.log(`\nwire test: ${ok ? "PASS" : "FAIL"} (gnomon ${sha})`);
process.exit(ok ? 0 : 1);


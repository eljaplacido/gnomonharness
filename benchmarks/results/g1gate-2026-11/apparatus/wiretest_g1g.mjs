// G1 (completion gate) offline wire test (no lane, no model server; nothing beyond 127.0.0.1), run before the chain;
// its output is committed as ../wiretest-g1g.txt. Modelled on N1's wiretest_n1.mjs. For each arm it runs the REAL
// pieces end to end:
//   gnomon init (master ae17a1ae, installed from the pinned tarballs in ../dist by install_build_g1g.sh) -> the
//   setup's own node block (extracted from the setup template, as the preflight does) -> `gnomon task` ->
//   relay-meter-s1 (createRelay, the meter the run uses) -> a fake llama.cpp-style server whose model is a fixed
//   policy over the conversation it is sent (so every arm meets the same model):
//     main turn: write out.txt by bash (printf ... > out.txt), then answer "done";
//       after a checklist hand-back: answer again at once, with no check (to provoke the no_check hand-back);
//       after a no_check hand-back: run `cat out.txt`, then answer;
//       after a reviewer's findings: rewrite out.txt, `cat` it, then answer;
//     reviewer sub-turn (recognised by its own instruction): `ls -la`, then `echo pwned > pwned.txt` (bash_allow must
//       refuse it), then a `write` call (not offered: refused), then one finding.
//   The work dir is NOT a git repository, like most terminal-bench task dirs.
// Arms:
//   N0 = N1's arm N0 (N1's own setup node block, ../../n1-2026-11/apparatus/gnomon-setup-n1.sh.j2, nudge 100000) on
//        this build: the baseline G0 must equal;
//   G0 = completion_gate "off"; G1 = "checklist"; G2 = "review".
// Checks: the binary is the pinned build; every arm: exit 0, steer_role user on the wire record, no system message after
// the first on the wire, no refusal learned, no idle nudge; G0: the surface is N0's plus the [verify] block holding
// the "off" line, and G0 sent EXACTLY N0's request bodies, request for request (no counters.completion_gate, no gate
// record); G1 and G2: the first two requests equal G0's (the gate changes nothing before the first answer), the
// first answer is handed back with a checklist built from the task (its requirements and out.txt) as a [gnomon]
// user note, an answer with no check run is handed back again (no_check), the gate's counters and audit records
// say what happened; G2: one reviewer sub-turn, offered only read/glob/grep/compute/todo/bash, given the task and
// not the transcript, whose writing attempts were refused and left nothing on disk, and whose finding reached the
// main turn. Last, the reviewer role's bash_allow/bash_deny (the verifier's, from init) is put to gnomon-core's own
// bashPolicy: which project checks it can run, and that it refuses what writes.
//   node wiretest_g1g.mjs <gnomon bin of the installed build> <empty work dir>
// exit 0 when every check holds.
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRelay, newTotals, newCell } from "./relay-meter-s1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [GN, work] = process.argv.slice(2);
if (!GN || !work) { console.error("usage: node wiretest_g1g.mjs <gnomon bin> <empty work dir>"); process.exit(2); }
const version = execFileSync(GN, ["--version"], { encoding: "utf8" }).trim().split("\n").at(-1);
const blockOf = (file) => {
  const setup = readFileSync(file, "utf8");
  const run = setup.split("cat > /opt/gnomon-run.sh <<'RUN'\n")[1].split("\nRUN\n")[0];
  return run.split("node -e '")[1].split("\n'\n")[0];
};
const JS_G = blockOf(join(HERE, "gnomon-setup-g1g.sh.j2"));
const JS_N1 = blockOf(join(HERE, "..", "..", "n1-2026-11", "apparatus", "gnomon-setup-n1.sh.j2"));
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const J = JSON.stringify;
const TASK = "Write the word hello into a file named `out.txt` in this directory.\n\nRequirements:\n" +
  "- The file must contain exactly one line.\n- Do not create any other file.";
const REVIEWER_MARK = "You are reviewing finished work";
const GATE_RE = /Completion gate \(round (\d+) of (\d+)\): (your answer is not accepted yet|no command has run since the checklist|an independent read-only reviewer)/g;
const KIND = { "your answer is not accepted yet": "checklist", "no command has run since the checklist": "no_check",
  "an independent read-only reviewer": "findings" };
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : "");
const call = (n, name, args) => ({ tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name, arguments: J(args) } }] });

/** The fake model: a fixed policy over the conversation, so every arm meets the same model. */
function policy(body, n) {
  const msgs = body.messages ?? [];
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  const say = (content) => ({ content });
  if (!tools) return say("Done: out.txt holds the line.");
  if (msgs.some((m) => m.role === "user" && textOf(m.content).includes(REVIEWER_MARK))) {
    const calls = msgs.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (calls === 0) return call(n, "bash", { command: "ls -la" });
    if (calls === 1) return call(n, "bash", { command: "echo pwned > pwned.txt" });
    if (calls === 2) return call(n, "write", { path: "pwned2.txt", content: "pwned\n" });
    return say("- out.txt holds `hi`, but the task asks for the word hello (cat out.txt printed: hi)");
  }
  let last = null, at = -1;
  msgs.forEach((m, i) => {
    if (m.role !== "user") return;
    for (const g of textOf(m.content).matchAll(GATE_RE)) { last = KIND[g[3]]; at = i; }
  });
  const callsSince = msgs.slice(at + 1).filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
  if (last === null) return callsSince === 0 ? call(n, "bash", { command: "printf 'hi\\n' > out.txt" }) : say("Done: wrote out.txt.");
  if (last === "checklist") return say("Checked: out.txt holds one line.");
  if (last === "no_check") return callsSince === 0 ? call(n, "bash", { command: "cat out.txt" }) : say("Checked with cat: out.txt holds one line.");
  if (callsSince === 0) return call(n, "bash", { command: "printf 'hello\\n' > out.txt" });
  if (callsSince === 1) return call(n, "bash", { command: "cat out.txt" });
  return say("Fixed: out.txt now holds hello, checked with cat.");
}

function fakeLlama() {
  const seen = { bodies: [] };
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b);
      seen.bodies.push(body);
      const n = seen.bodies.length;
      const delta = policy(body, n);
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
console.log(`== G1 (completion gate) wire test ${new Date().toISOString()}: ${version} (${GN})`);
check(version === "gnomon/0.4.2+master-ae17a1a", "the binary under test is the pinned build (master ae17a1ae, gnomonBuild master-ae17a1a)");
const ARMS = [["N0", JS_N1, null], ["G0", JS_G, "off"], ["G1", JS_G, "checklist"], ["G2", JS_G, "review"]];
for (const [arm, js, gate] of ARMS) {
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
    N1_STEER_ROLE: "user", N1_NUDGE_AFTER_IDLE: "100000", ...(gate ? { G1G_GATE: gate } : {}) };
  for (const k of ["OPENAI_API_KEY", "OPENCODE_API_KEY", "GNOMON_MODEL_URL", "G1G_GATE"]) if (!(k === "G1G_GATE" && gate)) delete env[k];
  execFileSync(GN, ["init"], { cwd: dir, env, stdio: "ignore" });
  execFileSync("node", ["-e", js], { cwd: dir, env, stdio: "inherit" });
  // `gnomon task` must not block this process's event loop: the fake server and the relay live here.
  const child = await new Promise((resolveP) => {
    const out = [];
    const p = spawn(GN, ["task", TASK, "--role", "implementor", "--yes", "--trust"], { cwd: dir, env });
    p.stdout.on("data", (d) => out.push(d)); p.stderr.on("data", (d) => out.push(d));
    const t = setTimeout(() => p.kill("SIGKILL"), 180000);
    p.on("close", (code) => { clearTimeout(t); resolveP({ code, out: Buffer.concat(out).toString("utf8") }); });
  });
  relay.close(); up.srv.close();
  writeFileSync(join(dir, "task.log"), child.out);
  const turns = [], gateRecs = [], toolRecs = [];
  const auditDir = join(dir, ".gnomon-audit");
  if (existsSync(auditDir)) {
    for (const f of readdirSync(auditDir).filter((f) => f.endsWith(".jsonl")).sort()) {
      for (const line of readFileSync(join(auditDir, f), "utf8").split("\n")) {
        try {
          const r = JSON.parse(line);
          if (r.kind === "turn") turns.push(r);
          if (r.kind === "completion_gate") gateRecs.push(r);
          if (r.kind === "tool_call") toolRecs.push(r);
        } catch { /* not a record */ }
      }
    }
  }
  const t = state.totals;
  const main = turns.filter((r) => r.role === undefined || r.role === "implementor").at(-1) ?? turns.at(-1) ?? {};
  const mc = main.counters?.model_calls;
  const cg = main.counters?.completion_gate;
  const config = readFileSync(join(dir, ".gnomon/config.toml"), "utf8");
  const policyToml = readFileSync(join(dir, ".gnomon/policy.toml"), "utf8");
  const bodies = up.seen.bodies;
  const isRev = (b) => (b.messages ?? []).some((m) => m.role === "user" && textOf(m.content).includes(REVIEWER_MARK));
  const sysAfterFirst = bodies.filter((b) => b.messages.some((m, i) => i > 0 && m.role === "system")).length;
  const gateNotes = bodies.filter((b) => b.messages.some((m) => m.role === "user" && /\[gnomon\] Completion gate \(round/.test(textOf(m.content)))).length;
  results[arm] = { config, policy: policyToml, bodies, dir, rPort, cg, gateRecs, turns, main, out: child.out };
  console.log(`\n${arm} (${gate === null ? "N1's arm-N0 setup, no [verify] line" : `completion_gate = "${gate}"`}): gnomon exit ${child.code}; ` +
    `${bodies.length} requests reached the fake server (${bodies.filter(isRev).length} from a reviewer)`);
  console.log(`  relay: chat ${t.chat_requests}, late system ${t.req_with_late_system} req, [gnomon] notes ${t.req_with_gnomon_note} req ` +
    `(${t.gnomon_note_msgs} msgs, new ${t.req_new_gnomon_note}); kinds as a note: ` +
    ["nudge", "converge", "wrapup", "verify", "context", "other"].map((k) => `${k} ${t[`steer_${k}_note`]}`).join(", ") +
    `; requests carrying a gate note ${gateNotes}; client_aborts ${t.client_aborts}, errors ${t.errors}`);
  console.log(`  turn records ${turns.length}; main: wire ${J(main.wire)}, nudges ${main.counters?.nudges}, steer_role_adapted ` +
    `${main.counters?.steer_role_adapted ?? "absent"}, stop_reason ${main.stop_reason}, tool_steps ${main.tool_steps}`);
  console.log(`  counters.model_calls: count ${mc?.count}, steered_calls ${J(mc?.steered_calls)}`);
  console.log(`  counters.completion_gate: ${J(cg)}`);
  console.log(`  completion_gate records: ${J(gateRecs.map(({ ts, kind, ...r }) => r))}`);
  check(child.code === 0, "gnomon task ran to exit 0 (not killed at 180 s)");
  check(t.req_bodies_parsed === t.chat_requests && t.chat_requests === bodies.length, "the relay parsed every request the server saw");
  check(main.wire?.steer_role === "user", "the main turn record's wire says steer_role user");
  check(t.req_with_late_system === 0 && t.req_with_dropped_system === 0 && sysAfterFirst === 0, "no system message after the first on the wire");
  check((main.counters?.steer_role_adapted ?? 0) === 0, "no refusal was learned (steer_role_adapted absent or 0)");
  check((main.counters?.nudges ?? 0) === 0 && t.steer_nudge_note === 0, "no idle nudge (nudge_after_idle = 100000 in every arm)");
  check(readFileSync(join(dir, "out.txt"), "utf8").length > 0, "the work was done (out.txt exists)");
  if (gate === null || gate === "off") {
    check(cg === undefined && gateRecs.length === 0 && gateNotes === 0 && t.steer_other_note === 0,
      `${arm}: no gate ran (no counters.completion_gate, no completion_gate record, no gate note on the wire)`);
    check(bodies.length === 2, `${arm}: the turn wrote, answered and was accepted (2 requests)`);
  }
  if (gate === "checklist" || gate === "review") {
    const firstNote = bodies.map((b) => b.messages.map((m) => textOf(m.content)).find((s) => s.includes("[gnomon] Completion gate (round 1"))).find(Boolean) ?? "";
    console.log(`  first hand-back as the model saw it (${firstNote.length} chars):\n${firstNote.split("\n").map((l) => "    | " + l).join("\n")}`);
    check(/Stated requirements:/.test(firstNote) && firstNote.includes("The file must contain exactly one line.") && firstNote.includes("`out.txt`")
      && /Run at least one command that exercises the result/.test(firstNote),
      `${arm}: the first answer was handed back with a checklist built from the task (its requirements and out.txt) as a [gnomon] user note`);
    check(bodies.some((b) => b.messages.some((m) => m.role === "user" && /\[gnomon\] Completion gate \(round 2 of 3\): no command has run/.test(textOf(m.content)))),
      `${arm}: an answer with no command run after the checklist was handed back again (no_check)`);
    check(t.steer_other_note > 0 && gateNotes > 0, `${arm}: the meter saw the gate's notes (kind "other")`);
    check(cg?.v === 1 && cg.mode === gate && cg.max_rounds === 3 && cg.outcome === "passed" && cg.checks >= 1,
      `${arm}: counters.completion_gate says mode ${gate}, 3 rounds max, checks >= 1, outcome passed`);
  }
  if (gate === "checklist") {
    check(cg?.rounds === 2 && cg.reviews === 0 && cg.findings === 0 && bodies.every((b) => !isRev(b)),
      "G1: two hand-backs (checklist, no_check), no reviewer");
    check(J(gateRecs.map((r) => r.action)) === J(["checklist", "no_check", "accept"]) && gateRecs.at(-1).outcome === "passed"
      && gateRecs.every((r) => r.budget_by === "steps" && r.role === "implementor"),
      "G1: the trail records checklist, no_check, accept(passed), each by the step budget");
  }
  if (gate === "review") {
    const rev = bodies.filter(isRev);
    const revTools = [...new Set(rev.flatMap((b) => (b.tools ?? []).map((x) => x.function?.name)))].sort();
    const firstRev = rev[0]?.messages ?? [];
    const revUser = firstRev.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
    console.log(`  reviewer: ${rev.length} requests; tools offered ${J(revTools)}; first request roles ${J(firstRev.map((m) => m.role))}`);
    const revToolResults = rev.at(-1)?.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content).slice(0, 140)) ?? [];
    console.log(`  reviewer tool results: ${J(revToolResults)}`);
    check(rev.length === 4 && cg?.reviews === 1 && cg.findings === 1 && cg.rounds === 3 && cg.review_steps >= 3,
      "G2: one reviewer sub-turn (4 requests), one finding, three hand-backs (checklist, no_check, findings)");
    check(revTools.length > 0 && revTools.every((x) => ["read", "glob", "grep", "compute", "todo", "bash"].includes(x)) && revTools.includes("bash")
      && !revTools.includes("write") && !revTools.includes("edit") && !revTools.includes("note"),
      "G2: the reviewer was offered only read/glob/grep/compute/todo and bash (the verifier declares a bash_allow)");
    check(revUser.includes(TASK) && !revUser.includes("Done: wrote out.txt") && !revUser.includes("Completion gate") && firstRev.length === 2,
      "G2: the reviewer was given the task verbatim and not the transcript (system + one user message)");
    check(!existsSync(join(dir, "pwned.txt")) && !existsSync(join(dir, "pwned2.txt")) && revToolResults.length >= 3
      && /Refused/.test(revToolResults[1] ?? "") && revToolResults[0] && !/Refused/.test(revToolResults[0]),
      "G2: the reviewer's ls ran; its redirect write and its write call were refused and left nothing on disk");
    check(bodies.some((b) => !isRev(b) && b.messages.some((m) => m.role === "user" && /\[gnomon\] Completion gate \(round 3 of 3\): an independent read-only reviewer[\s\S]*out\.txt holds `hi`/.test(textOf(m.content)))),
      "G2: the finding reached the main turn as a [gnomon] user note");
    check(readFileSync(join(dir, "out.txt"), "utf8") === "hello\n", "G2: the main turn acted on the finding (out.txt now holds hello)");
    check(J(gateRecs.map((r) => r.action)) === J(["checklist", "no_check", "review", "accept"]) && gateRecs.at(-1).outcome === "passed"
      && gateRecs.find((r) => r.action === "review")?.findings === 1,
      "G2: the trail records checklist, no_check, review(1 finding), accept(passed)");
  }
}
// The surfaces. G0's config.toml is N0's (meter port normalised); its policy.toml is N0's plus the [verify] block
// holding the "off" line; the G arms differ from each other by the completion_gate value only.
const norm = (s) => s.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT");
check(norm(results.G0.config) === norm(results.N0.config) && norm(results.G1.config) === norm(results.N0.config)
  && norm(results.G2.config) === norm(results.N0.config), "config.toml: every G arm's is N0's");
check(results.G0.policy === results.N0.policy.replace(/\s*$/, "\n") + '\n[verify]\ncompletion_gate = "off"\n',
  'policy.toml: G0\'s is N0\'s plus "[verify]" and completion_gate = "off"');
check(results.G1.policy === results.G0.policy.replace('completion_gate = "off"', 'completion_gate = "checklist"')
  && results.G2.policy === results.G0.policy.replace('completion_gate = "off"', 'completion_gate = "review"'),
  "policy.toml: G1 and G2 differ from G0 by the completion_gate value only");
// The wire. G0 sent exactly N0's request bodies; G1 and G2 sent G0's first two (the gate acts only at an answer).
const bodyKey = (body, arm) => J(body).split(results[arm].dir).join("<DIR>").split(`:${results[arm].rPort}`).join(":PORT");
const A = results.G0.bodies.map((x) => bodyKey(x, "G0")), B = results.N0.bodies.map((x) => bodyKey(x, "N0"));
const firstDiff = A.findIndex((x, i) => x !== B[i]);
console.log(`\nrequests: N0 ${B.length}, G0 ${A.length}; first differing request: ${firstDiff < 0 ? "none" : firstDiff + 1}`);
check(A.length === B.length && A.length > 0 && firstDiff < 0, "G0 (completion_gate off) sent exactly N0's request bodies, request for request");
for (const arm of ["G1", "G2"]) {
  const X = results[arm].bodies.slice(0, 2).map((x) => bodyKey(x, arm));
  check(X.length === 2 && X[0] === A[0] && X[1] === A[1], `${arm} sent G0's first two request bodies (the gate acts only at an answer)`);
}
// The reviewer's bash, put to gnomon-core's own bashPolicy with the verifier's lists as init wrote them.
const core = await import(pathToFileURL(resolve(dirname(GN), "..", "lib", "node_modules", "gnomon-core", "dist", "index.js")).href);
const cfg = core.loadConfig(results.G2.dir);
const ver = cfg.roles?.verifier ?? {};
const verdict = (cmd) => (core.bashPolicy(cmd, ver.bash_allow, ver.bash_deny) === null ? "runs" : "refused");
const allowCases = ["pytest -q", "pytest tests/test_outputs.py", "make test", "npm test", "cargo test", "go test ./...",
  "ls -la /app", "cat out.txt", "head -n 5 out.txt", "grep -n hello out.txt", "find . -name '*.py'", "git diff --stat"];
const denyCases = ["python3 solve.py", "python3 -m pytest", "bash run.sh", "node index.js", "sqlite3 db.sqlite .tables",
  "jq . data.json", "curl http://localhost:8080", "echo x > out.txt", "cat a > b", "sed -i s/a/b/ out.txt", "rm -rf build",
  "find . -delete", "find . -exec rm {} ;", "ls", "git diff", "wc -l out.txt"];
const got = Object.fromEntries([...allowCases, ...denyCases].map((c) => [c, verdict(c)]));
console.log(`\nreviewer (verifier) bash_allow: ${J(ver.bash_allow)}\nreviewer (verifier) bash_deny: ${J(ver.bash_deny)}`);
console.log(`bashPolicy on the reviewer's lists: ${J(got)}`);
check(allowCases.every((c) => got[c] === "runs"), "the reviewer can run the project's own checks read-only: pytest, make test, npm test, cargo/go test, ls/cat/head/grep/find, git diff <args>");
check(denyCases.every((c) => got[c] === "refused"),
  "the reviewer cannot write or run code: redirects, sed -i, rm, find -delete/-exec, python3/node/bash scripts, sqlite3, jq, curl (and bare ls, bare git diff, wc) are refused");
console.log(`\nwire test: ${ok ? "PASS" : "FAIL"} (${version})`);
process.exit(ok ? 0 : 1);

/**
 * T3 — what the context window LOSES when it overflows.
 *
 * gnomon recorded ZERO compaction events across 224 benchmark trials: the
 * default is compaction = "discard", and the shipped window is never reached on
 * those tasks. The entire context path therefore shipped unexercised, and the
 * trimWorking defect fixed today -- which silently dropped the CURRENT request
 * from turn two onward -- is what that costs.
 *
 * Drives the mechanism directly, because runTask is single-shot and there is no
 * multi-turn API to drive instead. A fact is planted in the first exchange, the
 * session is flooded until the window evicts that turn, and we ask what
 * survives under each policy.
 */
import { buildMessages, compactSession, loadConfig, buildSystemPrompt } from
  "/home/eljaplacido/Desktop/gnomon/packages/gnomon-core/dist/index.js";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const GN = "/home/eljaplacido/Desktop/gnomon/packages/gnomon-cli/gnomon.js";
const CODEWORD = "MARMALADE-7731";

function surface(dir, compaction, maxTokens) {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  execFileSync("node", [GN, "init"], { cwd: dir, stdio: "ignore" });
  const cfgPath = `${dir}/.gnomon/config.toml`;
  let c = readFileSync(cfgPath, "utf-8");
  if (!c.includes("[endpoints.bench]"))
    c = c.replace("[endpoints.local]", `[endpoints.bench]\nurl = "http://127.0.0.1:18080/v1/chat/completions"\nkind = "openai"\n\n[endpoints.local]`);
  // compaction and max_context_tokens are read from [defaults], NOT [context] —
  // putting them in the block actually named "context" silently does nothing,
  // which is exactly the misplaced-config class this campaign keeps finding.
  // Replace the scaffold's own values; prepending them just loses to the
  // later duplicate, since this parser is silently last-wins on repeated keys.
  c = c.replace(/^max_context_tokens\s*=\s*\d+/m, `max_context_tokens = ${maxTokens}`);
  c = c.replace(/^compaction\s*=\s*"[a-z]+"/m, `compaction = "${compaction}"`);
  c += `\n[context]\nsummary_role = "smol"\nreserve_output = 256\n`;
  writeFileSync(cfgPath, c);
  const rPath = `${dir}/.gnomon/roles.toml`;
  writeFileSync(rPath, readFileSync(rPath, "utf-8").replace(/^model = .*$/gm, 'model = "bench-model"') +
    `\n[roles.smol]\nmodel = "bench-model"\nendpoint = "bench"\ntemperature = 0\ntop_p = 1\nmax_steps = 4\ndescription = "summariser"\ntools = ["read"]\n`);
  return dir;
}

function session(config, floodTurns) {
  const exchanges = [{
    turn: 1, role: "implement",
    input: `Remember this exactly: the codeword is ${CODEWORD}.`,
    output: "Noted.", model: "m", code: 0, bucket: "result", duration_ms: 1,
  }];
  for (let i = 0; i < floodTurns; i++) {
    exchanges.push({
      turn: i + 2, role: "implement",
      input: `Filler ${i}: ${"lorem ipsum dolor sit amet consectetur ".repeat(60)}`,
      output: `Summarised filler ${i}: ${"detail ".repeat(60)}`,
      model: "m", code: 0, bucket: "result", duration_ms: 1,
    });
  }
  return { config, exchanges, currentRole: "implement" };
}

const rows = [];
for (const policy of ["discard", "summary"]) {
  const dir = surface(`/tmp/ctx-${policy}`, policy, 1500);
  const config = loadConfig(dir);
  const state = session(config, Number(process.argv[2] ?? 10));
  const sys = buildSystemPrompt(state, "implement", "");
  const before = buildMessages(state, sys, "What was the codeword?");
  let folded = 0, problem;
  if (policy === "summary") {
    try { const r = await compactSession(state, sys); folded = r.folded; problem = r.problem; }
    catch (e) { problem = String(e).slice(0, 120); }
  }
  const after = buildMessages(state, sys, "What was the codeword?");
  const text = after.messages.map((m) => m.content).join("\n");
  rows.push({
    policy, turns: state.exchanges.length,
    evicted_before: before.dropped, evicted_after: after.dropped,
    folded, problem,
    codeword_survives: text.includes(CODEWORD),
  });
}
for (const r of rows) console.log(" ", JSON.stringify(r));
writeFileSync("results.json", JSON.stringify(rows, null, 2));

#!/usr/bin/env node
// GBS-OVERHEAD 0.1 §3.3 "N": the null harness. Sends the conversation, executes each tool
// call verbatim, appends the result, repeats until the model answers in text. No policy, no
// records, no workspace tracking, no retries. Same runtime as gnomon (Node), so the floor it
// sets includes the runtime's own start-up and nothing else.
// Usage: node null_harness.mjs <url> "<prompt>"   (cwd = the repository)
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [url, prompt] = process.argv.slice(2);
const tools = [
  ["read", { path: { type: "string" } }], ["grep", { pattern: { type: "string" }, path: { type: "string" } }],
  ["edit", { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }], ["bash", { command: { type: "string" } }],
].map(([name, properties]) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties } } }));
const run = {
  read: (a) => readFileSync(a.path, "utf-8"),
  grep: (a) => spawnSync("grep", ["-rn", "--", a.pattern, a.path ?? "."], { encoding: "utf-8" }).stdout,
  edit: (a) => { const t = readFileSync(a.path, "utf-8"); writeFileSync(a.path, t.replace(a.old_text, a.new_text)); return "edited"; },
  bash: (a) => { const r = spawnSync("/bin/sh", ["-c", a.command], { encoding: "utf-8" }); return `exit ${r.status}\n${r.stdout}${r.stderr}`; },
};
const messages = [{ role: "system", content: "null harness" }, { role: "user", content: prompt }];
for (let step = 0; step < 100; step++) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", messages, tools, stream: false }) });
  const msg = (await res.json()).choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) { process.stdout.write((msg.content ?? "") + "\n"); process.exit(0); }
  for (const c of msg.tool_calls) {
    let out;
    try { out = run[c.function.name](JSON.parse(c.function.arguments)); } catch (e) { out = `error: ${e.message}`; }
    messages.push({ role: "tool", tool_call_id: c.id, content: String(out) });
  }
}
process.exit(1);

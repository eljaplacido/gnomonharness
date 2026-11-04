#!/usr/bin/env node
// GBS-AUDIT apparatus: a scripted, deterministic OpenAI-compatible model.
// No language model. It reads the "[audit-script vN]" marker in the user
// message and the number of tool calls already made, and returns the next
// scripted step. Ephemeral loopback port, printed on stdout. Every request is
// logged (index, path, bytes) to the file named by argv[2].
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const LOG = process.argv[2];
const SCRIPTS = {
  v0: [],
  v1: [["read", { path: "README.md" }]],
  v2: [["read", { path: "README.md" }], ["write", { path: "notes/a.txt", content: "audit run\n" }]],
  v3: [["read", { path: "README.md" }], ["write", { path: "notes/b.txt", content: "b\n" }], ["bash", { command: "true" }]],
  v4: [["glob", { pattern: "**/*.txt" }], ["write", { path: "notes/c.txt", content: "one\n" }],
       ["edit", { path: "notes/c.txt", old_text: "one", new_text: "two" }], ["read", { path: "notes/c.txt" }]],
};
let n = 0;
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    n++;
    if (req.method !== "POST") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[{"id":"audit-fake"}]}'); return; }
    const r = JSON.parse(body);
    const user = r.messages.find((m) => m.role === "user")?.content ?? "";
    const text = typeof user === "string" ? user : JSON.stringify(user);
    const v = (/\[audit-script (v\d)\]/.exec(text) ?? [])[1] ?? "v0";
    const done = r.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    const step = SCRIPTS[v][done];
    const message = step
      ? { role: "assistant", content: null, tool_calls: [{ id: `call_${v}_${done}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
      : { role: "assistant", content: `AUDIT-OK ${v}` };
    if (LOG) appendFileSync(LOG, JSON.stringify({ i: n, v, step: done, bytes: body.length, reply: step ? step[0] : "text" }) + "\n");
    const out = { id: `x${n}`, object: "chat.completion", model: r.model, choices: [{ index: 0, message, finish_reason: step ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: 8, total_tokens: Math.ceil(body.length / 4) + 8 } };
    if (r.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = step ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : { role: "assistant", content: message.content };
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: out.choices[0].finish_reason }], usage: out.usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      const b = JSON.stringify(out);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    }
  });
});
srv.listen(0, "127.0.0.1", () => console.log(srv.address().port));

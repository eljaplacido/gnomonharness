#!/usr/bin/env node
// GBS-OVERHEAD 0.1 §4 warm-session: drives `gnomon acp` (Agent Client Protocol over stdio,
// newline-delimited JSON-RPC) through K prompts in ONE session. Prompt 1 is the cold turn;
// prompts 2..K are the warm turns the spec measures. Before each prompt the repository's src/
// files are restored (the session is idle then). Permission requests are answered "turn".
// Per prompt it prints one JSON line: monotonic send/done times (ns, CLOCK_MONOTONIC, the same
// clock as Python's time.monotonic), CPU of the harness process (sum of its threads'
// schedstat run time, ns) and of its waited-for children (/proc stat cutime+cstime, ticks).
// Usage: node acp_warm.mjs <K> <prompt> <src-json>   (cwd = repository; gnomon on PATH)
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [K, prompt, srcJson] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const SRC = JSON.parse(srcJson);
const p = spawn("gnomon", ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", id = 0;
const waiting = new Map();
const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "session/request_permission") send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: "turn" } } });
    else if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  }
});
const call = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); send({ jsonrpc: "2.0", id: n, method, params }); });
const ticks = () => { const f = readFileSync(`/proc/${p.pid}/stat`, "utf-8").split(") ")[1].split(" "); return { self: +f[11] + +f[12], children: +f[13] + +f[14] }; };
const sched = () => readdirSync(`/proc/${p.pid}/task`).reduce((a, t) => { try { return a + Number(readFileSync(`/proc/${p.pid}/task/${t}/schedstat`, "utf-8").split(" ")[0]); } catch { return a; } }, 0);
const t0 = process.hrtime.bigint();
await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
const s = await call("session/new", { cwd: process.cwd(), mcpServers: [] });
const sessionId = s.result?.sessionId;
console.log(JSON.stringify({ ready_ns: Number(process.hrtime.bigint() - t0), sessionId, error: s.error ?? null }));
for (let k = 1; k <= K; k++) {
  for (const [f, v] of Object.entries(SRC)) writeFileSync(join(process.cwd(), f), v);
  const c0 = sched(), k0 = ticks(), ts = process.hrtime.bigint();
  const r = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
  const td = process.hrtime.bigint(), c1 = sched(), k1 = ticks();
  console.log(JSON.stringify({ prompt: k, t_send_ns: String(ts), t_done_ns: String(td), stopReason: r.result?.stopReason ?? null, error: r.error ?? null,
    cpu_self_ns: c1 - c0, cpu_children_ticks: k1.children - k0.children, files: Object.fromEntries(Object.keys(SRC).map((f) => [f, readFileSync(join(process.cwd(), f), "utf-8")])) }));
}
p.stdin.end(); p.kill("SIGTERM");

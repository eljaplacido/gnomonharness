// M1 Amendment 4 gate: through the abort-on-disconnect relay, a request the client abandons must stop
// running on the lane. Usage: node probe_abort_a4.mjs <relay.mjs> <lane base url> <model>
// Starts its own relay on 127.0.0.1:5395 (counters 5396), sends a long generation, abandons it after 6 s,
// then polls the lane's /metrics until vllm:num_requests_running is 0 (pass) or 30 s pass (fail).
import http from "node:http";
import { spawn } from "node:child_process";
const [relayPath, base, model] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = () => new Promise((r) => http.get(`${base}/metrics`, (res) => {
  let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => {
    const m = b.match(/^vllm:num_requests_running\{[^}]*\}\s+([0-9.eE+-]+)/m); r(m ? Number(m[1]) : NaN); });
}).on("error", () => r(NaN)));
const relay = spawn("node", [relayPath], { env: { ...process.env, RELAY_BIND: "127.0.0.1", RELAY_PORT: "5395",
  RELAY_UPSTREAM: base, RELAY_COUNTERS_PORT: "5396" }, stdio: "ignore" });
await sleep(800);
const before = await running();
const c = http.request({ host: "127.0.0.1", port: 5395, path: "/v1/chat/completions", method: "POST",
  headers: { "content-type": "application/json" } });
c.on("error", () => {});
c.end(JSON.stringify({ model, max_tokens: 6000, temperature: 0,
  messages: [{ role: "user", content: "Count from 1 to 5000, one number per line. Output only the numbers." }] }));
await sleep(6000);
const during = await running();
c.destroy();
let after = NaN, t = 0;
for (; t < 30; t++) { await sleep(1000); after = await running(); if (after === 0) break; }
relay.kill();
const ok = before === 0 && during >= 1 && after === 0;
console.log(`abort probe: running before=${before} during=${during} after=${after} (${t + 1} s after the client left) -> ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);

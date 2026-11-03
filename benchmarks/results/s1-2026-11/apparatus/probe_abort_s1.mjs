// S1 live abort check (informational; M1 Amendment 4's gate, adapted to llama.cpp, whose lane serves
// no /metrics but does serve /slots). Through relay-meter-s1's abort-on-disconnect, a streamed request
// the client abandons must stop occupying a slot on the lane.
//   node probe_abort_s1.mjs <relay-meter-s1.mjs> <lane base url> <model>
// Starts its own relay on 127.0.0.1:5430 (counters 5431), sends a long streamed generation shaped like
// gnomon's (stream + include_usage), abandons it after 4 s, then polls the lane's /slots until no slot
// is processing (PASS) or 30 s pass (FAIL). Last line: "abort probe: ... -> PASS|FAIL".
import http from "node:http";
import { spawn } from "node:child_process";
const [relayPath, base, model] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = () => new Promise((r) => http.get(`${base}/slots`, (res) => {
  let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => {
    try { r(JSON.parse(b).filter((s) => s.is_processing).length); } catch { r(NaN); } });
}).on("error", () => r(NaN)));
const counters = () => new Promise((r) => http.get("http://127.0.0.1:5431/counters", (res) => {
  let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { try { r(JSON.parse(b)); } catch { r({}); } });
}).on("error", () => r({})));
const relay = spawn("node", [relayPath], { env: { ...process.env, RELAY_BIND: "127.0.0.1", RELAY_PORT: "5430",
  RELAY_UPSTREAM: base, RELAY_COUNTERS_PORT: "5431" }, stdio: "ignore" });
await sleep(800);
const before = await busy();
let firstByte = false;
const c = http.request({ host: "127.0.0.1", port: 5430, path: "/v1/chat/completions", method: "POST",
  headers: { "content-type": "application/json" } }, (res) => res.once("data", () => (firstByte = true)));
c.on("error", () => {});
c.end(JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: 8000, temperature: 0,
  messages: [{ role: "user", content: "Count from 1 to 5000, one number per line. Output only the numbers." }] }));
await sleep(4000);
const during = await busy();
c.destroy();
let after = NaN, t = 0;
for (; t < 30; t++) { await sleep(1000); after = await busy(); if (after === 0) break; }
const k = await counters();
relay.kill();
const ok = before === 0 && during >= 1 && after === 0 && k.client_aborts === 1;
console.log(`abort probe: slots processing before=${before} during=${during} after=${after} (${t + 1} s after the client left; ` +
  `first byte ${firstByte}; relay client_aborts=${k.client_aborts}) -> ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);

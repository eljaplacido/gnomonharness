// Offline tests of relay-go.mjs (byte-identical to R1H's) on the request shape gnomon v0.4.0 sends: streamed, with
// stream_options.include_usage set by gnomon itself and max_tokens = 32768. R1H's build sent unstreamed requests,
// so this is the first time R1H's cloud meter sees gnomon's streams. relay-go only speaks HTTPS upstream, so the
// fake upstream is a loopback HTTPS server with a throwaway self-signed certificate (openssl), and relay-go runs
// as a child process exactly as run_r3r.py starts it, with a throwaway credentials file holding a dummy key (no
// real credential is read). Writes only a temp dir it removes.     node test_relay_go_r3r.mjs   (exit 0 = pass)
// Cases:
//  1. a streamed chat request that already asks for usage: forwarded with include_usage untouched (not counted as
//     injected), body otherwise byte-identical; the SSE stream reaches the client byte-identical; usage read from the
//     final chunk (prompt, completion, cached) and the allowance from the body;
//  2. a streamed request WITHOUT include_usage (R1H-era clients): injected and counted, still metered;
//  3. an unstreamed request (R1H's build): metered from the JSON body, as before;
//  4. the client disconnects mid-stream (a cell capped by tb): the upstream generation runs on and is still metered
//     when it ends (the reason run_r3r.py waits for a slot's in-flight requests before closing a cell's books),
//     and cloud_inflight() reads 1 while it runs and 0 after;
//  5. the client's Authorization is replaced by the key from the credentials file; the dummy key never reaches
//     the client or the counters.
import http from "node:http";
import https from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const T = mkdtempSync(join(tmpdir(), "r3r-relaygo-"));
let pass = 0, fail = 0;
const check = (c, what) => { console.log(`${c ? "ok  " : "FAIL"}  ${what}`); c ? pass++ : fail++; };
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DUMMY = "dummy-key-for-the-relay-test-0000";

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(T, "k.pem"), "-out", join(T, "c.pem"),
  "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
writeFileSync(join(T, "creds.json"), J({ OPENCODE_API_KEY: DUMMY }));

const seen = [];
let slowRelease = null;
const up = https.createServer({ key: execFileSync("cat", [join(T, "k.pem")]), cert: execFileSync("cat", [join(T, "c.pem")]) }, (req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", async () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, auth: req.headers.authorization, raw: b, body, session: req.headers["x-opencode-session"] });
    const usage = { prompt_tokens: 3000, completion_tokens: 120, total_tokens: 3120, prompt_tokens_details: { cached_tokens: 2048 },
      opencode: { allowance: 0.0123 } };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${J({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "hm" }, finish_reason: null }], usage: null })}\n\n`);
      if (body.slow) { await new Promise((r) => (slowRelease = r)); }
      res.write(`data: ${J({ choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }], usage: null })}\n\n`);
      if (body.stream_options?.include_usage) res.write(`data: ${J({ choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(J({ choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage }));
    }
  });
});
await new Promise((r) => up.listen(0, "127.0.0.1", r));
const upPort = up.address().port;
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const RP = await freePort(), CP = await freePort();
const relay = spawn("node", ["relay-go.mjs", "r3rtest"], { cwd: HERE, env: { ...process.env, RELAY_BIND: "127.0.0.1", RELAY_PORT: String(RP),
  RELAY_COUNTERS_PORT: String(CP), RELAY_KEY_NAME: "OPENCODE_API_KEY", RELAY_AUTH_FILE: join(T, "creds.json"),
  RELAY_UPSTREAM: `https://127.0.0.1:${upPort}/inference/go/`, RELAY_LABEL: "gnomon-r3r-benchmark", NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  stdio: ["ignore", "pipe", "pipe"] });
let relayOut = "";
relay.stdout.on("data", (d) => (relayOut += d)); relay.stderr.on("data", (d) => (relayOut += d));
for (let i = 0; i < 50 && !/counters on/.test(relayOut); i++) await sleep(100);
const counters = () => new Promise((r) => http.get(`http://127.0.0.1:${CP}/counters`, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => r(JSON.parse(b))); }));
const inflight = (c) => Math.max(c.chat_requests - ["responses_with_usage", "responses_without_usage", "responses_compressed", "status_4xx",
  "status_5xx", "errors", "refused_off_upstream"].reduce((s, k) => s + (c[k] ?? 0), 0), 0);  // run_r3r.cloud_inflight
const post = (obj, { abortAfterFirstChunk = false } = {}) => new Promise((resolve) => {
  const data = J(obj);
  const req = http.request({ host: "127.0.0.1", port: RP, path: "/openai/v1/chat/completions", method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), authorization: "Bearer placeholder", "user-agent": "gnomon/0.4.0" } }, (res) => {
    let b = "";
    res.on("data", (c) => { b += c; if (abortAfterFirstChunk) { req.destroy(); resolve({ status: res.statusCode, body: b, aborted: true }); } });
    res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    res.on("error", () => {});
  });
  req.on("error", () => {});
  req.end(data);
});
await fetch(`http://127.0.0.1:${CP}/cell?id=r3r-test-cell&arm=C&ua=gnomon%2Fr3r`, { method: "POST" });

// 1. v0.4.0's shape
const v040 = { model: "deepseek-v4.1-flash", stream: true, stream_options: { include_usage: true }, max_tokens: 32768,
  messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] };
const r1 = await post(v040);
let c = await counters();
check(r1.status === 200 && seen[0].raw === J(v040), "1. a v0.4.0 streamed request is forwarded byte-identical (include_usage already set: nothing injected)");
check(c.include_usage_injected === 0, "1. include_usage_injected stays 0 (gnomon asks for usage itself)");
check(/data: \[DONE\]/.test(r1.body) && r1.body.includes('"cached_tokens":2048') && r1.body.includes('"content":"hello"'), "1. the SSE stream reaches the client whole");
check(c.responses_with_usage === 1 && c.prompt_tokens === 3000 && c.completion_tokens === 120 && c.cached_tokens === 2048,
  "1. usage read from the final chunk: prompt 3000, completion 120, cached 2048 (the `usage: null` chunks ignored)");
check(Math.abs(c.allowance - 0.0123) < 1e-9 && c.responses_with_allowance === 1, "1. the allowance (Go's $ figure) read from the usage object");
check(seen[0].url === "/inference/go/openai/v1/chat/completions" && seen[0].session === "r3r-test-cell", "1. forwarded under the upstream base, with the cell as x-opencode-session");
// 2. no include_usage
const r2 = await post({ ...v040, stream_options: undefined });
c = await counters();
check(r2.status === 200 && seen[1].body.stream_options?.include_usage === true && c.include_usage_injected === 1 && c.responses_with_usage === 2,
  "2. a stream without include_usage gets it injected (counted) and is metered");
// 3. unstreamed (R1H's build)
const r3 = await post({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] });
c = await counters();
check(r3.status === 200 && c.responses_with_usage === 3 && c.prompt_tokens === 9000 && c.cached_tokens === 6144, "3. an unstreamed request is metered from its JSON body, as in R1H");
// 4. client disconnects mid-stream
const before = await counters();
const r4 = await post({ ...v040, slow: true }, { abortAfterFirstChunk: true });
await sleep(300);
const during = await counters();
check(r4.aborted && inflight(during) === 1, `4. the client left mid-stream; the relay still has 1 request in flight (cloud_inflight = ${inflight(during)})`);
slowRelease?.();
for (let i = 0; i < 30 && inflight(await counters()) > 0; i++) await sleep(100);
const after = await counters();
check(inflight(after) === 0 && after.responses_with_usage === before.responses_with_usage + 1 && after.allowance > before.allowance,
  "4. the upstream generation ran on and was metered when it ended (no abort-on-disconnect in relay-go): its $ lands in whatever cell is open on the slot then");
// 5. key handling
check(seen.every((s) => s.auth === `Bearer ${DUMMY}`), "5. upstream got the key from the credentials file, never the client's placeholder");
const cAll = J(await counters()) + r1.body + r2.body + r3.body;
check(!cAll.includes(DUMMY), "5. the key appears in no response and no counter");

relay.kill(); up.close();
rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

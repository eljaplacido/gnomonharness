// Tests for relay-meter.mjs.  Run from the repo root:  node --test benchmarks/kit/tests/relay-meter.test.mjs
// A fake upstream on an ephemeral loopback port; no network, no real key.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUsage, price, prepareBody } from "../relay-meter.mjs";

const RELAY = join(dirname(fileURLToPath(import.meta.url)), "..", "relay-meter.mjs");
const FAKE_KEY = "test-upstream-key-0000";

test("parseUsage: chat completions JSON, cached tokens split out", () => {
  const { usage, model, finish } = parseUsage(JSON.stringify({
    model: "m1", choices: [{ finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } }));
  assert.deepEqual(usage, { input_uncached: 60, input_cached: 40, input_cache_write: 0, output: 10 });
  assert.equal(model, "m1");
  assert.equal(finish, "stop");
});

test("parseUsage: SSE stream, the last usage wins", () => {
  const sse = [
    `data: ${JSON.stringify({ model: "m1", choices: [{ delta: { content: "hi" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}`,
    "data: [DONE]", ""].join("\n\n");
  const { usage, finish } = parseUsage(sse);
  assert.deepEqual(usage, { input_uncached: 5, input_cached: 0, input_cache_write: 0, output: 2 });
  assert.equal(finish, "tool_calls");
});

test("parseUsage: Anthropic Messages stream", () => {
  const sse = [
    "event: message_start",
    `data: ${JSON.stringify({ type: "message_start", message: { model: "m2", usage: { input_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 } } })}`,
    "event: message_delta",
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })}`, ""].join("\n");
  const { usage, model, finish } = parseUsage(sse);
  assert.deepEqual(usage, { input_uncached: 50, input_cached: 20, input_cache_write: 5, output: 7 });
  assert.equal(model, "m2");
  assert.equal(finish, "end_turn");
});

test("parseUsage: Responses API, and a body with no usage", () => {
  const { usage } = parseUsage(JSON.stringify({ model: "m3", usage: { input_tokens: 30, output_tokens: 3, input_tokens_details: { cached_tokens: 10 } } }));
  assert.deepEqual(usage, { input_uncached: 20, input_cached: 10, input_cache_write: 0, output: 3 });
  assert.equal(parseUsage(JSON.stringify({ choices: [] })).usage, null);
  assert.equal(parseUsage("not json").usage, null);
});

test("price: per-million rates, cached and cache-write rates fall back to input", () => {
  const u = { input_uncached: 1e6, input_cached: 1e6, input_cache_write: 0, output: 1e6 };
  assert.equal(price("m", u, { m: { input: 1, output: 4, cached_input: 0.1 } }), 5.1);
  assert.equal(price("m", u, { m: { input: 1, output: 4 } }), 6);
  assert.equal(price("other", u, { m: { input: 1, output: 4 } }), null);
});

test("prepareBody: include_usage only for streamed chat completions", () => {
  const b = Buffer.from(JSON.stringify({ model: "m", stream: true, messages: [] }));
  assert.equal(prepareBody(b, "/chat/completions").injected, true);
  assert.equal(prepareBody(b, "/v1/messages").injected, false);
  assert.equal(prepareBody(b, "/chat/completions", false).injected, false);
  const ns = Buffer.from(JSON.stringify({ model: "m", messages: [] }));
  assert.equal(prepareBody(ns, "/chat/completions").injected, false);
});

function fakeUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const j = body ? JSON.parse(body) : {};
      seen.push({ path: req.url, auth: req.headers.authorization, xkey: req.headers["x-api-key"],
                  cell: req.headers["x-bench-cell"], body: j });
      if (req.url.endsWith("/messages")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          `data: ${JSON.stringify({ type: "message_start", message: { model: "m2", usage: { input_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 } } })}`,
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })}`, ""].join("\n\n"));
      } else if (req.url.endsWith("/chat/completions") && j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const parts = [`data: ${JSON.stringify({ model: "m1", choices: [{ delta: { content: "x" } }] })}`];
        if (j.stream_options?.include_usage) parts.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 20 } })}`);
        parts.push("data: [DONE]", "");
        res.end(parts.join("\n\n"));
      } else if (req.url.endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "m1", choices: [{ finish_reason: "stop" }],
                                 usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, port: server.address().port })));
}

function startRelay(envExtra) {
  const child = spawn(process.execPath, [RELAY], { env: { PATH: process.env.PATH, ...envExtra }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const r = /relay-meter [^\s]+:(\d+) /.exec(out);
      const c = /counters [^\s]+:(\d+)/.exec(out);
      if (r && c) resolve({ child, relayPort: Number(r[1]), countersPort: Number(c[1]) });
    });
    child.on("exit", (code) => reject(new Error(`relay exited ${code}`)));
  });
}

async function call(port, method, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json", authorization: "Bearer placeholder", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

test("relay: meters, prices and attributes every call; the key never reaches the client or the log", async () => {
  const up = await fakeUpstream();
  const dir = mkdtempSync(join(tmpdir(), "relay-meter-test-"));
  const prices = join(dir, "prices.json");
  writeFileSync(prices, JSON.stringify({ _date: "2026-01-01", m1: { input: 1, output: 2, cached_input: 0.5 }, m2: { input: 3, output: 15, cached_input: 0.3, cache_write: 3.75 } }));
  const { child, relayPort, countersPort } = await startRelay({
    RELAY_UPSTREAM: `http://127.0.0.1:${up.port}/v1`, RELAY_LISTEN: "127.0.0.1:0", RELAY_COUNTERS: "127.0.0.1:0",
    RELAY_LOG_DIR: dir, RELAY_PRICES: prices, RELAY_KEY_ENV: "TEST_UPSTREAM_KEY", TEST_UPSTREAM_KEY: FAKE_KEY });
  try {
    await call(countersPort, "POST", "/cell?id=cell-1");
    const r1 = await call(relayPort, "POST", "/chat/completions", { model: "m1", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r1.status, 200);
    assert.ok(!r1.text.includes(FAKE_KEY));
    await call(relayPort, "POST", "/chat/completions", { model: "m1", stream: true, messages: [] });
    await call(relayPort, "POST", "/messages", { model: "m2", stream: true, messages: [] });
    await call(relayPort, "POST", "/messages", { model: "m2", stream: true, messages: [] }, { "x-bench-cell": "cell-2" });
    await call(relayPort, "GET", "/models");
    await call(countersPort, "POST", "/cell");
    await call(relayPort, "POST", "/completions", { model: "m1", prompt: "x" }); // no usage in reply, no cell

    const c = JSON.parse((await call(countersPort, "GET", "/counters")).text);
    // Upstream saw the relay's key and the full path, never the client's placeholder or the cell header.
    assert.ok(up.seen.every((s) => s.auth === `Bearer ${FAKE_KEY}`));
    assert.ok(up.seen.every((s) => s.cell === undefined));
    assert.equal(up.seen[0].path, "/v1/chat/completions");
    assert.equal(up.seen[1].body.stream_options.include_usage, true);
    assert.equal(up.seen[2].body.stream_options, undefined);

    const t = c.totals;
    assert.equal(t.requests, 6);
    assert.equal(t.model_calls, 5);
    assert.equal(t.responses_with_usage, 4);
    assert.equal(t.responses_without_usage, 1);
    assert.equal(t.include_usage_injected, 1);
    assert.equal(t.input_uncached, 60 + 200 + 50 + 50);
    assert.equal(t.input_cached, 40 + 20 + 20);
    assert.equal(t.input_cache_write, 10);
    assert.equal(t.output, 10 + 20 + 7 + 7);
    const m1a = (60 * 1 + 40 * 0.5 + 10 * 2) / 1e6;
    const m1b = (200 * 1 + 20 * 2) / 1e6;
    const m2 = (50 * 3 + 20 * 0.3 + 5 * 3.75 + 7 * 15) / 1e6;
    assert.ok(Math.abs(t.usd - (m1a + m1b + 2 * m2)) < 1e-12);
    assert.equal(c.cells["cell-1"].model_calls, 3);
    assert.ok(Math.abs(c.cells["cell-1"].usd - (m1a + m1b + m2)) < 1e-12);
    assert.equal(c.cells["cell-2"].model_calls, 1);
    assert.equal(c.prices_date, "2026-01-01");

    const log = readFileSync(join(dir, "calls.jsonl"), "utf8");
    assert.equal(log.trim().split("\n").length, 5);
    assert.ok(!log.includes(FAKE_KEY) && !log.includes("placeholder"));
  } finally {
    child.kill();
    up.server.close();
  }
});

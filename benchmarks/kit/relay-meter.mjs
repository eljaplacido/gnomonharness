#!/usr/bin/env node
// relay-meter.mjs: a metering pass-through between a harness and its model endpoint.
//
// Cost is measured on the wire, not taken from the harness's own account: every
// response that passes through is parsed for the usage the SERVER reported, and
// priced from a dated price table you supply. A response that carries no usage is
// counted as such (`responses_without_usage`), so an arm whose traffic cannot be
// metered shows up as unmetered rather than as cheap. Node >= 20, no dependencies.
//
//   RELAY_UPSTREAM=https://api.example.com/v1 node relay-meter.mjs
//
// Point the harness at http://127.0.0.1:4010 (plus the path it would use on the
// upstream; the path is appended to RELAY_UPSTREAM's path). Environment:
//
//   RELAY_UPSTREAM   required. http(s) base URL of the real endpoint
//   RELAY_LISTEN     host:port the harness talks to          (default 127.0.0.1:4010; port 0 = any)
//   RELAY_COUNTERS   host:port of the counters endpoint     (default 127.0.0.1:4019; port 0 = any)
//   RELAY_LOG_DIR    if set, one JSON line per model call in <dir>/calls.jsonl (no headers, no bodies)
//   RELAY_PRICES     if set, a JSON price table: {"<model>": {"input": $/Mtok, "output": $/Mtok,
//                    "cached_input": $/Mtok, "cache_write": $/Mtok}, "_date": "YYYY-MM-DD"}
//   RELAY_KEY_ENV    if set, the NAME of an environment variable holding the upstream key. The
//                    relay then replaces whatever credential the client sent, so the harness
//                    under test only ever holds a placeholder. The key is never logged.
//   RELAY_KEY_HEADER header for that key (default "authorization", sent as "Bearer <key>";
//                    "x-api-key" sends the bare key, as Anthropic Messages expects)
//   RELAY_INCLUDE_USAGE  "1" (default) adds stream_options.include_usage = true to streamed
//                    Chat Completions requests: a hosted API reports a stream's usage only when
//                    asked, and without it a streaming arm looks free. Applied to every arm alike,
//                    and counted (`include_usage_injected`). "0" turns it off.
//
// Counters endpoint (bound to loopback by default):
//   GET  /counters          {"totals": {...}, "cells": {"<id>": {...}}, "prices_date": ...}
//   POST /cell?id=<cell>    attribute the following traffic to <cell> (one cell at a time per
//                           relay; run one relay per concurrent lane). A request header
//                           `x-bench-cell: <id>` overrides it for that request.
//   POST /cell              (no id) stop attributing
//
// Usage shapes understood: Chat Completions (`usage.prompt_tokens`, `completion_tokens`,
// `prompt_tokens_details.cached_tokens`), Responses (`usage.input_tokens`, `output_tokens`,
// `input_tokens_details.cached_tokens`), Anthropic Messages (`input_tokens`, `output_tokens`,
// `cache_read_input_tokens`, `cache_creation_input_tokens`, from message_start and
// message_delta). Whole JSON bodies and SSE streams both work.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_PATH = /\/(chat\/completions|completions|responses|messages)(\?|$)/;
const CHAT_PATH = /\/chat\/completions(\?|$)/;

const zero = () => ({
  requests: 0, model_calls: 0, responses_with_usage: 0, responses_without_usage: 0,
  input_uncached: 0, input_cached: 0, input_cache_write: 0, output: 0,
  usd: 0, unpriced_calls: 0, include_usage_injected: 0,
  status_4xx: 0, status_5xx: 0, errors: 0, aborted: 0,
});

// ------------------------------------------------------------------ usage parsing

/** Every JSON object in a body: the body itself, or each SSE `data:` line. */
function objects(text) {
  const out = [];
  let sse = false;
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    sse = true;
    const payload = l.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { out.push(JSON.parse(payload)); } catch { /* a partial line; skip */ }
  }
  if (!sse) {
    try { out.push(JSON.parse(text)); } catch { /* not JSON */ }
  }
  return out;
}

/** Normalised usage: input split into uncached / cached / cache-write, and output. */
export function parseUsage(text) {
  let u = null;
  let model = null;
  let finish = null;
  for (const o of objects(text)) {
    if (o.model) model = o.model;
    if (o.response?.model) model = o.response.model;
    if (o.message?.model) model = o.message.model;
    for (const ch of o.choices || []) if (ch.finish_reason) finish = ch.finish_reason;
    if (o.delta?.stop_reason) finish = o.delta.stop_reason;
    if (o.stop_reason) finish = o.stop_reason;
    const usage = o.usage || o.response?.usage || o.message?.usage;
    if (!usage) continue;
    if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) {
      // Chat Completions: prompt_tokens INCLUDES cached tokens. Cumulative: the last one wins.
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
      u = { input_uncached: (usage.prompt_tokens ?? 0) - cached, input_cached: cached, input_cache_write: 0,
            output: usage.completion_tokens ?? 0 };
    } else if (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined
               || o.type === "message_start" || o.type === "message_delta" || o.type === "message") {
      // Anthropic Messages: input_tokens EXCLUDES cache reads and writes. message_start carries
      // the input side, message_delta the running output count.
      u ??= { input_uncached: 0, input_cached: 0, input_cache_write: 0, output: 0 };
      if (usage.input_tokens !== undefined) u.input_uncached = usage.input_tokens;
      if (usage.cache_read_input_tokens !== undefined) u.input_cached = usage.cache_read_input_tokens;
      if (usage.cache_creation_input_tokens !== undefined) u.input_cache_write = usage.cache_creation_input_tokens;
      if (usage.output_tokens !== undefined) u.output = usage.output_tokens;
    } else if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
      // Responses: input_tokens INCLUDES cached tokens.
      const cached = usage.input_tokens_details?.cached_tokens ?? 0;
      u = { input_uncached: (usage.input_tokens ?? 0) - cached, input_cached: cached, input_cache_write: 0,
            output: usage.output_tokens ?? 0 };
    }
  }
  return { usage: u, model, finish };
}

export function price(model, u, table) {
  if (!table || !u || !model) return null;
  const p = table[model];
  if (!p) return null;
  const per = (k) => (typeof p[k] === "number" ? p[k] : null);
  const inp = per("input");
  const out = per("output");
  if (inp === null || out === null) return null;
  const cachedRate = per("cached_input") ?? inp;
  const writeRate = per("cache_write") ?? inp;
  return (u.input_uncached * inp + u.input_cached * cachedRate + u.input_cache_write * writeRate + u.output * out) / 1e6;
}

/** Chat Completions only: other APIs either report usage unasked or reject the field. */
export function prepareBody(body, url, includeUsage = true) {
  const none = { body, injected: false, reqModel: null, stream: null };
  if (!body.length) return none;
  let j;
  try { j = JSON.parse(body.toString("utf8")); } catch { return none; }
  let injected = false;
  if (includeUsage && CHAT_PATH.test(url) && j.stream === true && !j.stream_options?.include_usage) {
    j.stream_options = { ...(j.stream_options || {}), include_usage: true };
    injected = true;
  }
  return { body: injected ? Buffer.from(JSON.stringify(j)) : body, injected, reqModel: j.model ?? null, stream: !!j.stream };
}

// ------------------------------------------------------------------ relay

function main() {
  const env = process.env;
  if (!env.RELAY_UPSTREAM) {
    console.error("relay-meter: set RELAY_UPSTREAM to the real endpoint's base URL");
    process.exit(2);
  }
  const UPSTREAM = new URL(env.RELAY_UPSTREAM);
  const hostPort = (s, dflt) => {
    const [h, p] = (s || dflt).split(/:(?=[^:]*$)/);
    return { host: h, port: Number(p) };
  };
  const LISTEN = hostPort(env.RELAY_LISTEN, "127.0.0.1:4010");
  const COUNTERS = hostPort(env.RELAY_COUNTERS, "127.0.0.1:4019");
  const LOG = env.RELAY_LOG_DIR ? path.join(env.RELAY_LOG_DIR, "calls.jsonl") : null;
  if (env.RELAY_LOG_DIR) fs.mkdirSync(env.RELAY_LOG_DIR, { recursive: true });
  const PRICES = env.RELAY_PRICES ? JSON.parse(fs.readFileSync(env.RELAY_PRICES, "utf8")) : null;
  const KEY_HEADER = (env.RELAY_KEY_HEADER || "authorization").toLowerCase();
  const KEY = (() => {
    if (!env.RELAY_KEY_ENV) return null;
    const k = env[env.RELAY_KEY_ENV];
    if (!k) {
      console.error(`relay-meter: RELAY_KEY_ENV names ${env.RELAY_KEY_ENV}, which is empty`);
      process.exit(2);
    }
    return k;
  })();
  const INCLUDE_USAGE = (env.RELAY_INCLUDE_USAGE ?? "1") !== "0";

  const totals = zero();
  const cells = {};
  let currentCell = null;
  let n = 0;
  const add = (cell, k, v) => {
    totals[k] += v;
    if (cell) (cells[cell] ??= zero())[k] += v;
  };
  const log = (line) => {
    if (LOG) fs.appendFileSync(LOG, JSON.stringify(line) + "\n");
  };

  const relay = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const cell = req.headers["x-bench-cell"] || currentCell;
      const isModel = req.method === "POST" && MODEL_PATH.test(req.url);
      const raw = Buffer.concat(chunks);
      const prep = isModel ? prepareBody(raw, req.url, INCLUDE_USAGE) : { body: raw, injected: false, reqModel: null, stream: null };
      const i = ++n;
      const t0 = Date.now();
      let ttft = null;
      add(cell, "requests", 1);
      if (isModel) add(cell, "model_calls", 1);
      if (prep.injected) add(cell, "include_usage_injected", 1);

      const headers = { ...req.headers };
      delete headers["x-bench-cell"];
      delete headers["content-length"];
      headers.host = UPSTREAM.host;
      headers["accept-encoding"] = "identity"; // usage must be readable; compression is not under test
      headers["content-length"] = String(prep.body.length);
      if (KEY) {
        delete headers.authorization;
        delete headers["x-api-key"];
        headers[KEY_HEADER] = KEY_HEADER === "authorization" ? `Bearer ${KEY}` : KEY;
      }
      const base = UPSTREAM.pathname.replace(/\/$/, "");
      const target = new URL(base + req.url, UPSTREAM);
      const mod = target.protocol === "https:" ? https : http;
      let tail = "";
      const up = mod.request(target, { method: req.method, headers }, (ur) => {
        const status = ur.statusCode ?? 502;
        if (status >= 500) add(cell, "status_5xx", 1);
        else if (status >= 400) add(cell, "status_4xx", 1);
        res.writeHead(status, ur.headers);
        ur.on("data", (c) => {
          if (ttft === null) ttft = Date.now() - t0;
          res.write(c);
          if (isModel) tail = (tail + c.toString("utf8")).slice(-262144); // usage arrives at the end
        });
        ur.on("end", () => {
          res.end();
          if (!isModel) return;
          const { usage, model, finish } = parseUsage(tail);
          const m = model || prep.reqModel;
          let usd = null;
          if (usage) {
            add(cell, "responses_with_usage", 1);
            for (const k of ["input_uncached", "input_cached", "input_cache_write", "output"]) add(cell, k, usage[k]);
            usd = price(m, usage, PRICES);
            if (usd === null) add(cell, "unpriced_calls", 1);
            else add(cell, "usd", usd);
          } else {
            add(cell, "responses_without_usage", 1);
          }
          log({ n: i, t: new Date(t0).toISOString(), cell, path: req.url.split("?")[0], status, model: m,
                stream: prep.stream, include_usage_injected: prep.injected, ttft_ms: ttft, wall_ms: Date.now() - t0,
                usage, usd, finish });
        });
      });
      up.on("error", (e) => {
        add(cell, "errors", 1);
        if (!res.headersSent) res.writeHead(502);
        res.end();
        if (isModel) log({ n: i, t: new Date(t0).toISOString(), cell, path: req.url.split("?")[0], error: e.code || "error" });
      });
      // A client that hangs up stops the upstream call: nothing is generated, or billed, for nobody.
      res.on("close", () => {
        if (!res.writableEnded) {
          up.destroy();
          add(cell, "aborted", 1);
          if (isModel) log({ n: i, t: new Date(t0).toISOString(), cell, path: req.url.split("?")[0], aborted: true,
                             wall_ms: Date.now() - t0 });
        }
      });
      up.end(prep.body);
    });
  });

  const counters = http.createServer((req, res) => {
    const u = new URL(req.url, "http://counters");
    if (req.method === "POST" && u.pathname === "/cell") {
      currentCell = u.searchParams.get("id") || null;
      if (currentCell) cells[currentCell] ??= zero();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cell: currentCell }));
      return;
    }
    if (req.method === "GET" && u.pathname === "/counters") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ totals, cells, current_cell: currentCell, prices_date: PRICES?._date ?? null,
                               upstream: UPSTREAM.origin }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  relay.listen(LISTEN.port, LISTEN.host, () => {
    const a = relay.address();
    console.log(`relay-meter ${a.address}:${a.port} -> ${UPSTREAM.origin}${UPSTREAM.pathname}`);
    counters.listen(COUNTERS.port, COUNTERS.host, () => {
      const c = counters.address();
      console.log(`counters ${c.address}:${c.port}`);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

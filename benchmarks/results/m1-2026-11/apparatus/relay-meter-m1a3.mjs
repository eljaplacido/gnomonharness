// M1 Amendment 3 copy of relay-meter-r1.mjs (the per-slot local meter). Same job, same
// counters, same bind/upstream/ports environment; three changes, each declared:
//
// 1. Usage is read with JSON.parse, not a regex. The R1 regex `"usage":{[^{}]*}` cannot match
//    a usage object holding a nested object (`prompt_tokens_details: {cached_tokens}`), which is
//    why every m1b-fnx response read as `responses_without_usage`. A plain JSON body is parsed
//    whole; a streamed body (SSE) is parsed one `data:` line at a time, and the LAST usage and the
//    LAST timings seen win, as before. llama-server's `timings` stays the fallback when a reply
//    carries no usage (prompt = cache_n + prompt_n, completion = predicted_n), and the source of
//    every count is itself counted (usage_from_json / usage_from_timings).
//
// 2. The mechanism metric of Amendment 3. Each chat request body is parsed and its assistant
//    messages are checked for a non-empty string `reasoning_content`:
//      req_with_assistant         requests with at least one assistant message
//      req_with_reasoning_content of those, requests where one or more carry reasoning_content
//      rc_messages, rc_chars      how many such messages, and their characters, summed over
//                                 requests (the history is re-sent each step, so this is volume)
//    Arm G0 must read 0 here and G1 more than 0. The relay only observes; it never edits a body.
//
// 3. What the model produced, so "G1 replays when there was something to replay" can be checked:
//      responses_with_reasoning, response_reasoning_chars   reasoning_content (or `reasoning`) in
//                                 the reply, streamed deltas summed
//      following_reasoning        requests (with an assistant message) that came right after a
//                                 reply carrying both reasoning and a tool call, in the same cell
//      following_reasoning_replayed   of those, the ones that sent reasoning_content back
//    POST /cell?id=... on the counters port starts a new cell (the runner calls it before each
//    cell), so a reply in one cell never counts toward the next.
//
// Everything else is relay-meter-r1's: bound to the bridge address only, counters on
// 127.0.0.1:<RELAY_COUNTERS_PORT>/counters, started and stopped by the runner.
// The analysis functions are exported so test_relay_m1a3.mjs exercises this exact code; the
// server starts only when this file is run directly.
import http from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const BODY_CAP = 64 * 1024 * 1024; // a chat body over this is not parsed (counted), still forwarded

export function newTotals() {
  return {
    // relay-meter-r1's counters, same names and meaning
    requests: 0, responses_with_usage: 0, responses_without_usage: 0,
    prompt_tokens: 0, completion_tokens: 0,
    prompt_processed: 0, prompt_cached: 0, responses_with_timings: 0,
    errors: 0, chat_requests: 0, gpu_ms: 0,
    // where the counted usage came from
    usage_from_json: 0, usage_from_timings: 0, response_parse_errors: 0,
    // request bodies (Amendment 3 mechanism metric)
    req_bodies_parsed: 0, req_body_parse_errors: 0, req_stream: 0, req_max_tokens: 0,
    req_with_assistant: 0, req_with_reasoning_content: 0, rc_messages: 0, rc_chars: 0,
    // what the model produced
    responses_with_reasoning: 0, response_reasoning_chars: 0, responses_with_tool_calls: 0,
    following_reasoning: 0, following_reasoning_replayed: 0,
  };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/** What a chat request body says. Never throws; `parsed: false` for anything that is not JSON. */
export function inspectRequest(bodyText) {
  const out = { parsed: false, assistant: 0, rcMessages: 0, rcChars: 0, stream: false, maxTokens: false };
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return out;
  }
  if (!body || typeof body !== "object") return out;
  out.parsed = true;
  out.stream = body.stream === true;
  out.maxTokens = num(body.max_tokens) !== null || num(body.max_completion_tokens) !== null;
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || m.role !== "assistant") continue;
    out.assistant++;
    if (nonEmpty(m.reasoning_content)) {
      out.rcMessages++;
      out.rcChars += m.reasoning_content.length;
    }
  }
  return out;
}

/** Reads one response body, streamed (SSE) or plain JSON, fed in chunks of any size. */
export function responseReader(contentType = "") {
  let sse = /text\/event-stream/i.test(contentType) ? true : null; // null: decide on the first bytes
  let buf = "";
  let size = 0;
  let overCap = false;
  const st = { usage: null, timings: null, reasoningChars: 0, toolCalls: false, parseErrors: 0, chunks: 0 };

  const take = (obj) => {
    if (!obj || typeof obj !== "object") return;
    // A stream sends `"usage": null` on every chunk but the last when include_usage is set:
    // only an object counts, and the last one wins.
    if (obj.usage && typeof obj.usage === "object") st.usage = obj.usage;
    if (obj.timings && typeof obj.timings === "object") st.timings = obj.timings;
    const choice = Array.isArray(obj.choices) ? obj.choices[0] : undefined;
    const part = choice ? (choice.delta ?? choice.message ?? {}) : {};
    const thought = part.reasoning_content ?? part.reasoning;
    if (typeof thought === "string") st.reasoningChars += thought.length;
    if (Array.isArray(part.tool_calls) && part.tool_calls.length > 0) st.toolCalls = true;
  };
  const line = (l) => {
    if (!l.startsWith("data:")) return;
    const payload = l.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    st.chunks++;
    try {
      take(JSON.parse(payload));
    } catch {
      st.parseErrors++;
    }
  };
  return {
    push(text) {
      if (sse === null) {
        const head = (buf + text).trimStart();
        if (head.length === 0) {
          buf += text;
          return;
        }
        sse = head.startsWith("data:") || head.startsWith(":") || head.startsWith("event:");
      }
      if (sse) {
        buf += text;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) line(l);
      } else if (!overCap) {
        size += text.length;
        if (size > BODY_CAP) {
          overCap = true;
          buf = "";
        } else {
          buf += text;
        }
      }
    },
    end() {
      if (sse) {
        if (buf) line(buf);
      } else if (overCap) {
        st.parseErrors++;
      } else if (buf.trim()) {
        try {
          take(JSON.parse(buf));
        } catch {
          st.parseErrors++;
        }
      }
      buf = "";
      return st;
    },
  };
}

/** Adds one finished response to the totals, by relay-meter-r1's rules. Returns the state. */
export function accountResponse(totals, st) {
  const u = st.usage;
  const p = u ? num(u.prompt_tokens) : null;
  const c = u ? num(u.completion_tokens) : null;
  const t = st.timings;
  const tp = t ? num(t.prompt_n) : null;
  const tg = t ? num(t.predicted_n) : null;
  const tc = t ? (num(t.cache_n) ?? 0) : 0;
  if (p !== null && c !== null) {
    totals.prompt_tokens += p;
    totals.completion_tokens += c;
    totals.responses_with_usage++;
    totals.usage_from_json++;
  } else if (tp !== null && tg !== null) {
    totals.prompt_tokens += tc + tp;
    totals.completion_tokens += tg;
    totals.responses_with_usage++;
    totals.usage_from_timings++;
  } else {
    totals.responses_without_usage++;
  }
  if (t) totals.gpu_ms += (num(t.prompt_ms) ?? 0) + (num(t.predicted_ms) ?? 0);
  if (t && tp !== null) {
    totals.prompt_processed += tp;
    totals.prompt_cached += tc;
    totals.responses_with_timings++;
  }
  if (st.parseErrors > 0) totals.response_parse_errors++;
  if (st.reasoningChars > 0) {
    totals.responses_with_reasoning++;
    totals.response_reasoning_chars += st.reasoningChars;
  }
  if (st.toolCalls) totals.responses_with_tool_calls++;
  return st;
}

/** Adds one chat request to the totals. `cell` carries the per-cell "last reply" state. */
export function accountRequest(totals, info, cell) {
  if (!info.parsed) {
    totals.req_body_parse_errors++;
    return;
  }
  totals.req_bodies_parsed++;
  if (info.stream) totals.req_stream++;
  if (info.maxTokens) totals.req_max_tokens++;
  if (info.assistant > 0) {
    totals.req_with_assistant++;
    if (cell.lastReplyReasonedWithTools) {
      totals.following_reasoning++;
      if (info.rcMessages > 0) totals.following_reasoning_replayed++;
    }
  }
  if (info.rcMessages > 0) {
    totals.req_with_reasoning_content++;
    totals.rc_messages += info.rcMessages;
    totals.rc_chars += info.rcChars;
  }
}

export function newCell(id = null) {
  return { id, lastReplyReasonedWithTools: false };
}

function start() {
  const BIND = process.env.RELAY_BIND ?? "172.17.0.1";
  const PORT = Number(process.env.RELAY_PORT ?? 18080);
  const UPSTREAM = process.env.RELAY_UPSTREAM ?? "http://127.0.0.1:18080";
  const COUNTERS_PORT = Number(process.env.RELAY_COUNTERS_PORT ?? 18099);
  const totals = newTotals();
  let cell = newCell();

  http
    .createServer((req, res) => {
      totals.requests++;
      const isChat = req.url.includes("/chat/completions");
      const metered = isChat || req.url.includes("/completions");
      if (isChat) totals.chat_requests++;
      const up = new URL(req.url, UPSTREAM);
      const proxied = http.request(
        up,
        { method: req.method, headers: { ...req.headers, host: up.host } },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          const reader = metered ? responseReader(String(upRes.headers["content-type"] ?? "")) : null;
          const dec = new StringDecoder("utf8"); // bytes are forwarded as received; only the copy is decoded
          upRes.on("data", (chunk) => {
            res.write(chunk);
            if (reader) reader.push(dec.write(chunk));
          });
          upRes.on("end", () => {
            res.end();
            if (!reader) return;
            reader.push(dec.end());
            const st = accountResponse(totals, reader.end());
            if (isChat) cell.lastReplyReasonedWithTools = st.reasoningChars > 0 && st.toolCalls;
          });
        }
      );
      proxied.on("error", () => {
        totals.errors++;
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(proxied);
      if (isChat) {
        // A copy of the body for inspection; the pipe above forwards the original bytes.
        const reqChunks = [];
        let reqSize = 0;
        req.on("data", (chunk) => {
          reqSize += chunk.length;
          if (reqSize <= BODY_CAP) reqChunks.push(chunk);
        });
        req.on("end", () => {
          const text = reqSize <= BODY_CAP ? Buffer.concat(reqChunks).toString("utf8") : "";
          accountRequest(totals, inspectRequest(text), cell);
        });
      }
    })
    .listen(PORT, BIND, () => console.log(`relay-meter-m1a3 ${BIND}:${PORT} -> ${UPSTREAM}`));

  http
    .createServer((req, res) => {
      if (req.method === "POST" && req.url.startsWith("/cell")) {
        const id = new URL(req.url, "http://x").searchParams.get("id");
        cell = newCell(id);
        console.log(`${new Date().toISOString()} cell ${id}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, cell: id }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(totals));
    })
    .listen(COUNTERS_PORT, "127.0.0.1", () => console.log(`counters on 127.0.0.1:${COUNTERS_PORT}`));
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) start();

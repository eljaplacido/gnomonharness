// S1 copy of M1a3's relay-meter-m1a3.mjs (the per-slot local meter). Same job, same counters, same
// bind/upstream/ports environment, same JSON usage parsing and reasoning counters. Two additions,
// each declared in ../PRE-REGISTRATION.md:
//
// 1. Abort on disconnect (M1 Amendment 4, relay-meter-r1-abort.mjs's behaviour, ported here). When
//    the client goes away before the reply is complete (gnomon's stream idle/total timeout, or tb
//    killing the container at the cap), the upstream request is destroyed too, as a direct
//    connection would be; otherwise llama-server keeps generating for a client that is gone and the
//    retries queue behind it. Counted as `client_aborts`. A reply that completes is untouched.
//
// 2. The S1 mechanism metric. Each chat request body is parsed and its messages are classified:
//      late_system            system messages after the first (gnomon's own hasLateSystem test)
//      dropped_system         system messages the incumbent's template does not render: the
//                             Unsloth qwen3.6 template served by R1H's llama.cpp merges a system
//                             message at index 0 and one at index 1, and skips every other
//                             system/developer message (r1h-2026-11/lane-props.json chat_template)
//      gnomon_note            `[gnomon] ` notes inside user messages (steer_role = "user": a note
//                             starts the message or follows a blank line when runs were merged)
//    per request: req_with_late_system, req_with_dropped_system, req_with_gnomon_note; volume summed
//    over requests (the history is re-sent each step): late_system_msgs, dropped_system_msgs,
//    dropped_system_chars, gnomon_note_msgs, gnomon_note_chars; and per kind of steering, the
//    requests carrying at least one of that kind as a dropped system message (steer_<kind>_dropped)
//    or as a note (steer_<kind>_note). Kinds, by gnomon's own wording at the build under test:
//    nudge, converge, wrapup, verify, context, other. Arm S0 should show dropped > 0 and notes = 0,
//    arm S1 notes > 0 and late/dropped = 0, whenever steering fired. The relay only observes; it
//    never edits a body.
//
// Everything else is relay-meter-m1a3's: bound to the bridge address only, counters on
// 127.0.0.1:<RELAY_COUNTERS_PORT>/counters, POST /cell?id=... starts a new cell, started and stopped
// by the runner. The analysis functions and createRelay are exported so test_relay_s1.mjs exercises
// this exact code; the servers start only when this file is run directly.
import http from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const BODY_CAP = 64 * 1024 * 1024; // a chat body over this is not parsed (counted), still forwarded
export const STEER_KINDS = ["nudge", "converge", "wrapup", "verify", "context", "other"];
const NOTE = /(?:^|\n\n)\[gnomon\] /g;

export function newTotals() {
  const t = {
    // relay-meter-r1's counters, same names and meaning
    requests: 0, responses_with_usage: 0, responses_without_usage: 0,
    prompt_tokens: 0, completion_tokens: 0,
    prompt_processed: 0, prompt_cached: 0, responses_with_timings: 0,
    errors: 0, chat_requests: 0, gpu_ms: 0,
    // where the counted usage came from (M1a3)
    usage_from_json: 0, usage_from_timings: 0, response_parse_errors: 0,
    // request bodies (M1a3: reasoning replay; expected 0 in both S arms)
    req_bodies_parsed: 0, req_body_parse_errors: 0, req_stream: 0, req_max_tokens: 0,
    req_with_assistant: 0, req_with_reasoning_content: 0, rc_messages: 0, rc_chars: 0,
    // what the model produced (M1a3)
    responses_with_reasoning: 0, response_reasoning_chars: 0, responses_with_tool_calls: 0,
    following_reasoning: 0, following_reasoning_replayed: 0,
    // abort on disconnect (M1 Amendment 4)
    client_aborts: 0,
    // S1 mechanism metric
    req_with_late_system: 0, late_system_msgs: 0,
    req_with_dropped_system: 0, dropped_system_msgs: 0, dropped_system_chars: 0,
    req_with_gnomon_note: 0, gnomon_note_msgs: 0, gnomon_note_chars: 0,
    req_new_dropped_system: 0, req_new_gnomon_note: 0,
  };
  for (const k of STEER_KINDS) {
    t[`steer_${k}_dropped`] = 0;
    t[`steer_${k}_note`] = 0;
  }
  return t;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/** A message's text: a string, or the text parts of a typed content array. */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
  }
  return "";
}

/** Which of gnomon's mid-turn messages this is, by its own opening words at the build under test. */
export function steerKind(text) {
  const t = text.trimStart();
  if (/^You have run \d+ tool calls without changing a file/.test(t)) return "nudge";
  if (/^You have used \d+ of \d+ tool calls/.test(t)) return "converge";
  if (t.startsWith("No tools are attached to this final call")) return "wrapup";
  if (t.startsWith("The declared verification for this repository failed")) return "verify";
  if (t.startsWith("[gnomon context]")) return "context";
  return "other";
}

const isSys = (m) => m && (m.role === "system" || m.role === "developer");

/** What a chat request body says. Never throws; `parsed: false` for anything that is not JSON. */
export function inspectRequest(bodyText) {
  const out = {
    parsed: false, assistant: 0, rcMessages: 0, rcChars: 0, stream: false, maxTokens: false,
    lateSystem: 0, droppedSystem: 0, droppedChars: 0, notes: 0, noteChars: 0,
    droppedKinds: new Set(), noteKinds: new Set(),
  };
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
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  // The incumbent template: system at 0 is rendered; at 1 too when 0 also is; every other dropped.
  const kept = isSys(msgs[0]) ? (isSys(msgs[1]) ? 2 : 1) : 0;
  msgs.forEach((m, i) => {
    if (!m || typeof m !== "object") return;
    if (m.role === "system" && i > 0) out.lateSystem++;
    if (isSys(m) && i >= kept) {
      const text = textOf(m.content);
      out.droppedSystem++;
      out.droppedChars += text.length;
      out.droppedKinds.add(steerKind(text));
    }
    if (m.role === "user") {
      const text = textOf(m.content);
      const marks = [...text.matchAll(NOTE)];
      for (let j = 0; j < marks.length; j++) {
        // a note runs to the next note, or to a [/gnomon] line, or to the end of the message
        const from = marks[j].index + marks[j][0].length;
        const rest = text.slice(from, j + 1 < marks.length ? marks[j + 1].index : text.length);
        const note = rest.split("\n[/gnomon]")[0];
        out.notes++;
        out.noteChars += note.length;
        out.noteKinds.add(steerKind(note));
      }
    }
    if (m.role !== "assistant") return;
    out.assistant++;
    if (nonEmpty(m.reasoning_content)) {
      out.rcMessages++;
      out.rcChars += m.reasoning_content.length;
    }
  });
  return out;
}

/** Reads one response body, streamed (SSE) or plain JSON, fed in chunks of any size. (M1a3, unchanged) */
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

/** Adds one finished response to the totals, by relay-meter-r1's rules. Returns the state. (M1a3, unchanged) */
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

/** Adds one chat request to the totals. `cell` carries the per-cell state. */
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
  // S1 mechanism metric
  if (info.lateSystem > 0) totals.req_with_late_system++;
  totals.late_system_msgs += info.lateSystem;
  if (info.droppedSystem > 0) totals.req_with_dropped_system++;
  totals.dropped_system_msgs += info.droppedSystem;
  totals.dropped_system_chars += info.droppedChars;
  if (info.notes > 0) totals.req_with_gnomon_note++;
  totals.gnomon_note_msgs += info.notes;
  totals.gnomon_note_chars += info.noteChars;
  // A request carrying more steering than the cell's previous request: new steering arrived (the
  // count can fall when the history is trimmed, so "more than before" is a lower bound).
  if (info.droppedSystem > cell.lastDropped) totals.req_new_dropped_system++;
  if (info.notes > cell.lastNotes) totals.req_new_gnomon_note++;
  cell.lastDropped = info.droppedSystem;
  cell.lastNotes = info.notes;
  for (const k of info.droppedKinds) totals[`steer_${k}_dropped`]++;
  for (const k of info.noteKinds) totals[`steer_${k}_note`]++;
}

export function newCell(id = null) {
  return { id, lastReplyReasonedWithTools: false, lastDropped: 0, lastNotes: 0 };
}

/**
 * The metering proxy. `state` holds { totals, cell } and is read on every request, so the counters
 * server's POST /cell can swap the cell. Returns an unstarted http.Server.
 */
export function createRelay(upstream, state) {
  return http.createServer((req, res) => {
    const totals = state.totals;
    totals.requests++;
    const isChat = req.url.includes("/chat/completions");
    const metered = isChat || req.url.includes("/completions");
    if (isChat) totals.chat_requests++;
    const up = new URL(req.url, upstream);
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
          if (isChat) state.cell.lastReplyReasonedWithTools = st.reasoningChars > 0 && st.toolCalls;
        });
      }
    );
    let clientGone = false;
    proxied.on("error", () => {
      if (clientGone) return; // our own abort below, counted as client_aborts
      totals.errors++;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    // M1 Amendment 4: when the client goes away before the reply is complete, abort the upstream
    // request too, as a direct connection would.
    res.on("close", () => {
      if (!res.writableFinished) {
        totals.client_aborts++;
        clientGone = true;
        proxied.destroy();
      }
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
        accountRequest(totals, inspectRequest(text), state.cell);
      });
    }
  });
}

/** The counters server: GET -> the totals; POST /cell?id=... -> a new cell. */
export function createCounters(state, log = () => {}) {
  return http.createServer((req, res) => {
    if (req.method === "POST" && req.url.startsWith("/cell")) {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      state.cell = newCell(id);
      log(`${new Date().toISOString()} cell ${id}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, cell: id }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(state.totals));
  });
}

function start() {
  const BIND = process.env.RELAY_BIND ?? "172.17.0.1";
  const PORT = Number(process.env.RELAY_PORT ?? 18080);
  const UPSTREAM = process.env.RELAY_UPSTREAM ?? "http://127.0.0.1:18080";
  const COUNTERS_PORT = Number(process.env.RELAY_COUNTERS_PORT ?? 18099);
  const state = { totals: newTotals(), cell: newCell() };
  createRelay(UPSTREAM, state).listen(PORT, BIND, () =>
    console.log(`relay-meter-s1 (abort-on-disconnect) ${BIND}:${PORT} -> ${UPSTREAM}`));
  createCounters(state, console.log).listen(COUNTERS_PORT, "127.0.0.1", () =>
    console.log(`counters on 127.0.0.1:${COUNTERS_PORT}`));
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) start();

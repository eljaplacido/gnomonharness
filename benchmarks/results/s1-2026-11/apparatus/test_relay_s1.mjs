// Offline tests of relay-meter-s1.mjs (no network beyond 127.0.0.1): synthetic request and response
// bodies through the exact exported functions the relay runs, and the relay itself (createRelay) on
// loopback sockets against a fake upstream, for the abort-on-disconnect behaviour.
//   node test_relay_s1.mjs        exit 0 when every case passes
// Part 1 is M1a3's 22 cases (test_relay_m1a3.mjs), carried over unchanged except one assertion that now
// compares the M1a3 fields of inspectRequest's result (it returns more fields here). Part 2 is the S1
// mechanism metric; part 3 the abort on disconnect (M1 Amendment 4).
import assert from "node:assert/strict";
import http from "node:http";
import {
  newTotals, inspectRequest, responseReader, accountResponse, accountRequest, newCell,
  steerKind, textOf, createRelay, createCounters, STEER_KINDS,
} from "./relay-meter-s1.mjs";

let failed = 0, passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message.split("\n").join("\n      ")}`);
  }
};
const J = JSON.stringify;
const sse = (objs) => objs.map((o) => `data: ${J(o)}\n\n`).join("") + "data: [DONE]\n\n";
const read = (text, ct, cuts = []) => {  // feed `text` split at the given offsets
  const r = responseReader(ct);
  let at = 0;
  for (const c of [...cuts, text.length]) {
    r.push(text.slice(at, c));
    at = c;
  }
  return r.end();
};
const call = { id: "call_1", type: "function", function: { name: "bash", arguments: J({ command: "ls" }) } };

// ------------------------------------------------------------------ request bodies (mechanism metric)
test("request: assistant message with reasoning_content is counted, chars summed", () => {
  const rc = "I should list the directory first.";
  const i = inspectRequest(J({ model: "m", stream: true, max_tokens: 32768, messages: [
    { role: "system", content: "s" }, { role: "user", content: "u" },
    { role: "assistant", content: "", reasoning_content: rc, tool_calls: [call] },
    { role: "tool", tool_call_id: "call_1", content: "a b" }] }));
  const pick = ({ parsed, assistant, rcMessages, rcChars, stream, maxTokens }) => ({ parsed, assistant, rcMessages, rcChars, stream, maxTokens });
  assert.deepEqual(pick(i), { parsed: true, assistant: 1, rcMessages: 1, rcChars: rc.length, stream: true, maxTokens: true });
});
test("request: G0-shaped body (no reasoning_content key) counts 0", () => {
  const i = inspectRequest(J({ messages: [{ role: "user", content: "u" },
    { role: "assistant", content: "", tool_calls: [call] }, { role: "tool", tool_call_id: "call_1", content: "x" }] }));
  assert.equal(i.assistant, 1); assert.equal(i.rcMessages, 0); assert.equal(i.rcChars, 0);
  assert.equal(i.stream, false); assert.equal(i.maxTokens, false);
});
test("request: empty, whitespace-only, null and non-string reasoning_content count 0", () => {
  const i = inspectRequest(J({ messages: [
    { role: "assistant", content: "a", reasoning_content: "" },
    { role: "assistant", content: "b", reasoning_content: "  \n " },
    { role: "assistant", content: "c", reasoning_content: null },
    { role: "assistant", content: "d", reasoning_content: { text: "x" } }] }));
  assert.equal(i.assistant, 4); assert.equal(i.rcMessages, 0);
});
test("request: reasoning_content on a non-assistant message is not counted", () => {
  const i = inspectRequest(J({ messages: [{ role: "user", content: "u", reasoning_content: "x" },
    { role: "tool", content: "t", reasoning_content: "y" }] }));
  assert.equal(i.assistant, 0); assert.equal(i.rcMessages, 0);
});
test("request: several assistant messages, two carrying reasoning", () => {
  const i = inspectRequest(J({ max_completion_tokens: 10, messages: [
    { role: "assistant", content: "", reasoning_content: "abc", tool_calls: [call] },
    { role: "tool", tool_call_id: "call_1", content: "" },
    { role: "assistant", content: "", tool_calls: [call] },
    { role: "tool", tool_call_id: "call_1", content: "" },
    { role: "assistant", content: "", reasoning_content: "defgh", tool_calls: [call] }] }));
  assert.equal(i.assistant, 3); assert.equal(i.rcMessages, 2); assert.equal(i.rcChars, 8); assert.equal(i.maxTokens, true);
});
test("request: a body that is not JSON is parsed=false and never throws", () => {
  assert.equal(inspectRequest("{not json").parsed, false);
  assert.equal(inspectRequest("").parsed, false);
  assert.equal(inspectRequest("null").parsed, false);
  assert.equal(inspectRequest(J({ messages: "x" })).assistant, 0);
});

// ------------------------------------------------------------------ response usage (JSON.parse)
const OLD_R1_REGEX = /"usage"\s*:\s*\{([^{}]*)\}/g; // relay-meter-r1's, for contrast only
test("json: nested usage (prompt_tokens_details) is read; the R1 regex could not", () => {
  const body = J({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290, prompt_tokens_details: { cached_tokens: 1000 } } });
  assert.equal([...body.matchAll(OLD_R1_REGEX)].length, 0, "the old regex should miss this shape");
  const t = newTotals();
  accountResponse(t, read(body, "application/json"));
  assert.equal(t.prompt_tokens, 1234); assert.equal(t.completion_tokens, 56);
  assert.equal(t.responses_with_usage, 1); assert.equal(t.usage_from_json, 1); assert.equal(t.responses_without_usage, 0);
});
test("json: no usage, llama.cpp timings fallback (prompt = cache_n + prompt_n), gpu_ms summed", () => {
  const body = J({ choices: [{ message: { content: "x" } }],
    timings: { cache_n: 100, prompt_n: 20, prompt_ms: 10.5, predicted_n: 7, predicted_ms: 30.25 } });
  const t = newTotals();
  accountResponse(t, read(body, "application/json", [5, 17]));
  assert.equal(t.prompt_tokens, 120); assert.equal(t.completion_tokens, 7); assert.equal(t.usage_from_timings, 1);
  assert.equal(t.prompt_processed, 20); assert.equal(t.prompt_cached, 100); assert.equal(t.responses_with_timings, 1);
  assert.equal(t.gpu_ms, 40.75);
});
test("json: usage AND timings: usage counts the tokens, timings still give gpu_ms and the cache split", () => {
  const body = J({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 50, completion_tokens: 5 },
    timings: { cache_n: 40, prompt_n: 10, prompt_ms: 1, predicted_n: 5, predicted_ms: 2 } });
  const t = newTotals();
  accountResponse(t, read(body, ""));
  assert.equal(t.prompt_tokens, 50); assert.equal(t.usage_from_json, 1); assert.equal(t.usage_from_timings, 0);
  assert.equal(t.prompt_cached, 40); assert.equal(t.gpu_ms, 3);
});
test("json: neither usage nor timings is responses_without_usage; an error page is a parse error", () => {
  const t = newTotals();
  accountResponse(t, read(J({ choices: [{ message: { content: "x" } }] }), "application/json"));
  accountResponse(t, read("<html>502 Bad Gateway</html>", "text/html"));
  assert.equal(t.responses_without_usage, 2); assert.equal(t.response_parse_errors, 1); assert.equal(t.prompt_tokens, 0);
});
test("json: reasoning_content and tool_calls in the reply are seen", () => {
  const st = read(J({ choices: [{ message: { content: null, reasoning_content: "think", tool_calls: [call] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 } }), "application/json");
  assert.equal(st.reasoningChars, 5); assert.equal(st.toolCalls, true);
  const t = newTotals();
  accountResponse(t, st);
  assert.equal(t.responses_with_reasoning, 1); assert.equal(t.response_reasoning_chars, 5); assert.equal(t.responses_with_tool_calls, 1);
});
test("json: TensorFold-shaped reply (nested usage, no timings) is metered: the m1b-fnx gap", () => {
  const t = newTotals();
  accountResponse(t, read(J({ id: "x", choices: [{ message: { content: "ok" } }],
    usage: { prompt_tokens: 9000, completion_tokens: 300, total_tokens: 9300, prompt_tokens_details: { cached_tokens: 8800 } } }), "application/json"));
  assert.equal(t.responses_with_usage, 1); assert.equal(t.prompt_tokens, 9000);
});

// ------------------------------------------------------------------ response usage, streamed (SSE)
const llamaStream = () => {
  const ch = (delta, extra = {}) => ({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }], usage: null, ...extra });
  return sse([
    ch({ role: "assistant", content: null }),
    ch({ reasoning_content: "Let me " }), ch({ reasoning_content: "look — ünïcode." }),
    ch({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }),
    ch({ tool_calls: [{ index: 0, function: { arguments: "{\"command\":\"ls\"}" } }] }),
    { object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      timings: { cache_n: 300, prompt_n: 45, prompt_ms: 20, predicted_n: 30, predicted_ms: 60 } },
    { object: "chat.completion.chunk", choices: [],
      usage: { prompt_tokens: 345, completion_tokens: 30, total_tokens: 375, prompt_tokens_details: { cached_tokens: 300 } },
      timings: { cache_n: 300, prompt_n: 45, prompt_ms: 20, predicted_n: 30, predicted_ms: 60 } },
  ]);
};
test("sse: usage from the last chunk (nested), null usage on earlier chunks ignored", () => {
  const t = newTotals();
  const st = accountResponse(t, read(llamaStream(), "text/event-stream"));
  assert.equal(t.prompt_tokens, 345); assert.equal(t.completion_tokens, 30); assert.equal(t.usage_from_json, 1);
  assert.equal(t.gpu_ms, 80); assert.equal(t.prompt_cached, 300); assert.equal(st.parseErrors, 0);
});
test("sse: reasoning deltas summed and tool_call deltas seen, at every split of the stream", () => {
  const s = llamaStream();
  const want = "Let me ".length + "look — ünïcode.".length;
  for (let cut = 1; cut < s.length; cut += 7) {
    const st = read(s, "text/event-stream", [cut, Math.min(s.length, cut + 3)]);
    assert.equal(st.reasoningChars, want, `cut at ${cut}`);
    assert.equal(st.toolCalls, true, `cut at ${cut}`);
    assert.equal(st.usage.prompt_tokens, 345, `cut at ${cut}`);
  }
});
test("sse: CRLF line endings and no content-type (detected from the first bytes)", () => {
  const st = read(llamaStream().replace(/\n/g, "\r\n"), "");
  assert.equal(st.usage.completion_tokens, 30); assert.equal(st.toolCalls, true);
});
test("sse: a stream without usage falls back to the last timings", () => {
  const s = sse([{ choices: [{ delta: { content: "hi" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], timings: { cache_n: 0, prompt_n: 12, prompt_ms: 1, predicted_n: 3, predicted_ms: 1 } }]);
  const t = newTotals();
  accountResponse(t, read(s, "text/event-stream"));
  assert.equal(t.prompt_tokens, 12); assert.equal(t.completion_tokens, 3); assert.equal(t.usage_from_timings, 1);
});
test("sse: OpenRouter-style `reasoning` deltas count as reasoning too", () => {
  const st = read(sse([{ choices: [{ delta: { reasoning: "abc" } }] }, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }]), "text/event-stream");
  assert.equal(st.reasoningChars, 3); assert.equal(st.toolCalls, false);
});
test("sse: a garbled data line is a parse error, the rest is still read", () => {
  const s = "data: {broken\n\n" + llamaStream();
  const t = newTotals();
  accountResponse(t, read(s, "text/event-stream"));
  assert.equal(t.prompt_tokens, 345); assert.equal(t.response_parse_errors, 1);
});

// ------------------------------------------------------------------ per-cell "following" logic
test("cell: G1 sequence -> following_reasoning_replayed; G0 sequence -> following but not replayed", () => {
  for (const [replay, want] of [[true, 1], [false, 0]]) {
    const t = newTotals();
    const cell = newCell("c1");
    accountRequest(t, inspectRequest(J({ messages: [{ role: "user", content: "u" }] })), cell);
    const st = accountResponse(t, read(llamaStream(), "text/event-stream"));
    cell.lastReplyReasonedWithTools = st.reasoningChars > 0 && st.toolCalls;
    const asst = { role: "assistant", content: "", tool_calls: [call], ...(replay ? { reasoning_content: "Let me look." } : {}) };
    accountRequest(t, inspectRequest(J({ messages: [{ role: "user", content: "u" }, asst, { role: "tool", tool_call_id: "call_1", content: "x" }] })), cell);
    assert.equal(t.following_reasoning, 1, `replay=${replay}`);
    assert.equal(t.following_reasoning_replayed, want, `replay=${replay}`);
    assert.equal(t.req_with_reasoning_content, want, `replay=${replay}`);
    assert.equal(t.req_with_assistant, 1);
  }
});
test("cell: a new cell forgets the last reply, so cells never leak into each other", () => {
  const t = newTotals();
  let cell = newCell("a");
  cell.lastReplyReasonedWithTools = true;
  cell = newCell("b");
  accountRequest(t, inspectRequest(J({ messages: [{ role: "assistant", content: "x" }] })), cell);
  assert.equal(t.following_reasoning, 0);
});
test("cell: a request with no assistant message (first step, or a sub-turn) is not a follower", () => {
  const t = newTotals();
  const cell = newCell("a");
  cell.lastReplyReasonedWithTools = true;
  accountRequest(t, inspectRequest(J({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] })), cell);
  assert.equal(t.following_reasoning, 0); assert.equal(t.req_bodies_parsed, 1);
});
test("totals: every counter is a finite number (the collector diffs them)", () => {
  for (const [k, v] of Object.entries(newTotals())) assert.ok(typeof v === "number" && Number.isFinite(v), k);
});

// ------------------------------------------------------------------ S1 mechanism metric (part 2)
const SYS = { role: "system", content: "You are gnomon." };
const USR = { role: "user", content: "Fix the bug in /app." };
const CALL = { role: "assistant", content: "", tool_calls: [call] };
const TOOL = { role: "tool", tool_call_id: "call_1", content: "a b" };
const NUDGE = "You have run 8 tool calls without changing a file. If you have found what you need, act on it now.";
const CONVERGE = "You have used 40 of 48 tool calls — about 8 remain, and when they run out any work you have not applied is lost.";
const WRAP = "No tools are attached to this final call, so answer now from what you already have.";
const VERIFY = "The declared verification for this repository failed after your changes.";
const CTX = "[gnomon context] 3 earlier step(s) in this turn were dropped to stay inside the context window.";
// steerAsUser at 8078df03, as gnomon writes it (probe-shapes-s1.json holds the real function's output)
const note = (t) => `[gnomon] ${t}`;

test("steer: gnomon's mid-turn wordings are classified by kind", () => {
  assert.equal(steerKind(NUDGE), "nudge");
  assert.equal(steerKind(CONVERGE), "converge");
  assert.equal(steerKind(WRAP), "wrapup");
  assert.equal(steerKind(VERIFY), "verify");
  assert.equal(steerKind(CTX), "context");
  assert.equal(steerKind("Something else entirely."), "other");
  assert.deepEqual(STEER_KINDS, ["nudge", "converge", "wrapup", "verify", "context", "other"]);
});
test("steer: S0 shape: a nudge after a tool result is a late AND dropped system message, no note", () => {
  const i = inspectRequest(J({ messages: [SYS, USR, CALL, TOOL, { role: "system", content: NUDGE }] }));
  assert.equal(i.lateSystem, 1); assert.equal(i.droppedSystem, 1); assert.equal(i.droppedChars, NUDGE.length);
  assert.equal(i.notes, 0); assert.deepEqual([...i.droppedKinds], ["nudge"]);
});
test("steer: S1 shape: the same nudge as a [gnomon] user message is a note, nothing late or dropped", () => {
  const i = inspectRequest(J({ messages: [SYS, USR, CALL, TOOL, { role: "user", content: note(NUDGE) }] }));
  assert.equal(i.lateSystem, 0); assert.equal(i.droppedSystem, 0);
  assert.equal(i.notes, 1); assert.equal(i.noteChars, NUDGE.length); assert.deepEqual([...i.noteKinds], ["nudge"]);
});
test("steer: the template keeps system at index 0 and 1 (folded summary): late but not dropped", () => {
  const i = inspectRequest(J({ messages: [SYS, { role: "system", content: "[gnomon context] Summary of earlier turns" }, USR] }));
  assert.equal(i.lateSystem, 1); assert.equal(i.droppedSystem, 0);
});
test("steer: a third leading system message is dropped; developer counts as system for the template", () => {
  const i = inspectRequest(J({ messages: [SYS, { role: "developer", content: "d" }, { role: "system", content: CTX }, USR] }));
  assert.equal(i.droppedSystem, 1); assert.deepEqual([...i.droppedKinds], ["context"]);
  const j = inspectRequest(J({ messages: [USR, { role: "system", content: WRAP }] }));
  assert.equal(j.droppedSystem, 1); assert.equal(j.lateSystem, 1); assert.deepEqual([...j.droppedKinds], ["wrapup"]);
});
test("steer: merged run: the instruction then a note (context drop under steer_role user) counts one note", () => {
  const i = inspectRequest(J({ messages: [SYS, { role: "user", content: `${USR.content}\n\n${note(CTX)}` }, CALL, TOOL] }));
  assert.equal(i.notes, 1); assert.deepEqual([...i.noteKinds], ["context"]); assert.equal(i.noteChars, CTX.length);
});
test("steer: merged run: two notes, then a closing [/gnomon] and someone else's text", () => {
  const content = `${note(NUDGE)}\n\n${note(CONVERGE)}\n[/gnomon]\n\nplease continue`;
  const i = inspectRequest(J({ messages: [SYS, USR, CALL, TOOL, { role: "user", content }] }));
  assert.equal(i.notes, 2); assert.deepEqual([...i.noteKinds].sort(), ["converge", "nudge"]);
  assert.equal(i.noteChars, NUDGE.length + CONVERGE.length);
});
test("steer: '[gnomon]' mid-sentence or without the space is not a note; typed content is read", () => {
  const i = inspectRequest(J({ messages: [{ role: "user", content: "see [gnomon] docs" }, { role: "user", content: "[gnomon]x" }] }));
  assert.equal(i.notes, 0);
  assert.equal(textOf([{ type: "text", text: "[gnomon] " }, { type: "text", text: WRAP }]), `[gnomon] ${WRAP}`);
  const j = inspectRequest(J({ messages: [SYS, USR, { role: "user", content: [{ type: "text", text: note(WRAP) }] }] }));
  assert.equal(j.notes, 1); assert.deepEqual([...j.noteKinds], ["wrapup"]);
});
test("steer: totals per request and volume, kinds counted once per request, 'new' steering tracked per cell", () => {
  const t = newTotals();
  const cell = newCell("c");
  const steps = [
    [SYS, USR],
    [SYS, USR, CALL, TOOL, { role: "system", content: NUDGE }],
    [SYS, USR, CALL, TOOL, { role: "system", content: NUDGE }, CALL, TOOL],
    [SYS, USR, CALL, TOOL, { role: "system", content: NUDGE }, CALL, TOOL, { role: "system", content: NUDGE }],
  ];
  for (const m of steps) accountRequest(t, inspectRequest(J({ messages: m })), cell);
  assert.equal(t.req_with_dropped_system, 3); assert.equal(t.dropped_system_msgs, 4);
  assert.equal(t.req_new_dropped_system, 2); assert.equal(t.steer_nudge_dropped, 3);
  assert.equal(t.req_with_gnomon_note, 0); assert.equal(t.req_with_late_system, 3);
  const c2 = newCell("d"); // a new cell starts from zero
  accountRequest(t, inspectRequest(J({ messages: [SYS, USR, CALL, TOOL, { role: "user", content: note(WRAP) }] })), c2);
  assert.equal(t.req_new_gnomon_note, 1); assert.equal(t.steer_wrapup_note, 1); assert.equal(t.req_new_dropped_system, 2);
});
test("steer: every new counter is in newTotals and finite", () => {
  const t = newTotals();
  for (const k of ["client_aborts", "req_with_late_system", "req_with_dropped_system", "req_with_gnomon_note",
    "dropped_system_chars", "gnomon_note_chars", "req_new_dropped_system", "req_new_gnomon_note",
    ...STEER_KINDS.flatMap((k) => [`steer_${k}_dropped`, `steer_${k}_note`])]) assert.equal(t[k], 0, k);
});

// ------------------------------------------------------------------ abort on disconnect, on sockets (part 3)
const pending = [];
const atest = (name, fn) => pending.push([name, fn]);
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(20); return pred(); };

// A fake upstream: /slow streams one chunk, then holds the reply open until the relay hangs up;
// /fast answers a complete SSE reply with usage. Records whether each upstream request was abandoned.
async function fakeUpstream() {
  const seen = { slowClosed: false, slowStarted: false, fastDone: 0, bodies: [] };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.bodies.push(body);
      if (req.url.includes("slow")) {
        seen.slowStarted = true;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${J({ choices: [{ delta: { content: "1\n" } }] })}\n\n`);
        res.on("close", () => { if (!res.writableFinished) seen.slowClosed = true; });
        const keep = setInterval(() => res.write(`data: ${J({ choices: [{ delta: { content: "2\n" } }] })}\n\n`), 100);
        res.on("close", () => clearInterval(keep));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(llamaStream());
        seen.fastDone++;
      }
    });
  });
  const port = await listen(srv);
  return { srv, port, seen };
}

atest("abort: a client that hangs up mid-stream makes the relay abandon the upstream request", async () => {
  const up = await fakeUpstream();
  const state = { totals: newTotals(), cell: newCell("a") };
  const relay = createRelay(`http://127.0.0.1:${up.port}`, state);
  const rport = await listen(relay);
  try {
    await new Promise((resolve, reject) => {
      const c = http.request({ host: "127.0.0.1", port: rport, path: "/v1/chat/completions?slow", method: "POST",
        headers: { "content-type": "application/json" } }, (res) => {
        res.once("data", () => { c.destroy(); resolve(); }); // first chunk arrived: the client leaves
      });
      c.on("error", () => {});
      c.end(J({ stream: true, messages: [SYS, USR] }));
      setTimeout(() => reject(new Error("no first chunk")), 3000);
    });
    assert.ok(await waitFor(() => up.seen.slowClosed), "the upstream request was not abandoned after the client left");
    assert.ok(await waitFor(() => state.totals.client_aborts === 1), `client_aborts = ${state.totals.client_aborts}`);
    assert.equal(state.totals.errors, 0, "the relay's own abort must not count as an upstream error");
    assert.equal(state.totals.chat_requests, 1); assert.equal(state.totals.req_bodies_parsed, 1);
    assert.equal(state.totals.responses_with_usage + state.totals.responses_without_usage, 0, "an abandoned reply is not accounted");
  } finally { relay.close(); up.srv.close(); }
});
atest("abort: a reply that completes is forwarded byte-identical and metered; nothing is aborted", async () => {
  const up = await fakeUpstream();
  const state = { totals: newTotals(), cell: newCell("b") };
  const relay = createRelay(`http://127.0.0.1:${up.port}`, state);
  const rport = await listen(relay);
  try {
    const sent = J({ stream: true, max_tokens: 32768, messages: [SYS, USR, CALL, TOOL, { role: "user", content: note(NUDGE) }] });
    const got = await new Promise((resolve, reject) => {
      const c = http.request({ host: "127.0.0.1", port: rport, path: "/v1/chat/completions", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(sent) } }, (res) => {
        let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b));
      });
      c.on("error", reject);
      c.end(sent);
    });
    assert.equal(got, llamaStream(), "the reply was altered");
    assert.equal(up.seen.bodies[0], sent, "the request body was altered");
    assert.ok(await waitFor(() => state.totals.responses_with_usage === 1));
    await sleep(50);
    assert.equal(state.totals.client_aborts, 0); assert.equal(up.seen.slowClosed, false);
    assert.equal(state.totals.prompt_tokens, 345); assert.equal(state.totals.completion_tokens, 30);
    assert.equal(state.totals.req_with_gnomon_note, 1); assert.equal(state.totals.steer_nudge_note, 1);
    assert.equal(state.totals.req_stream, 1); assert.equal(state.totals.req_max_tokens, 1);
  } finally { relay.close(); up.srv.close(); }
});
atest("abort: an upstream that refuses the connection is a 502 and an error, not an abort", async () => {
  const dead = http.createServer();
  const dport = await listen(dead);
  await new Promise((r) => dead.close(r));
  const state = { totals: newTotals(), cell: newCell("c") };
  const relay = createRelay(`http://127.0.0.1:${dport}`, state);
  const rport = await listen(relay);
  try {
    const code = await new Promise((resolve, reject) => {
      const c = http.request({ host: "127.0.0.1", port: rport, path: "/v1/chat/completions", method: "POST" },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      c.on("error", reject);
      c.end(J({ messages: [USR] }));
    });
    assert.equal(code, 502); assert.equal(state.totals.errors, 1); assert.equal(state.totals.client_aborts, 0);
  } finally { relay.close(); }
});
atest("counters: GET returns the totals; POST /cell swaps the cell the relay reads", async () => {
  const state = { totals: newTotals(), cell: newCell() };
  state.cell.lastNotes = 3;
  const srv = createCounters(state);
  const port = await listen(srv);
  try {
    const ask = (method, path) => new Promise((resolve, reject) => {
      const c = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
        let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(JSON.parse(b)));
      });
      c.on("error", reject); c.end();
    });
    const r = await ask("POST", "/cell?id=s1-s0-k1-l-x");
    assert.deepEqual(r, { ok: true, cell: "s1-s0-k1-l-x" });
    assert.equal(state.cell.id, "s1-s0-k1-l-x"); assert.equal(state.cell.lastNotes, 0);
    const t = await ask("GET", "/counters");
    assert.equal(t.client_aborts, 0); assert.ok("req_with_dropped_system" in t);
  } finally { srv.close(); }
});

for (const [name, fn] of pending) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message.split("\n").join("\n      ")}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

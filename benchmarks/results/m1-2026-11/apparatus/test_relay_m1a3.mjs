// Offline tests of relay-meter-m1a3.mjs's analysis (no sockets, no network): synthetic request and
// response bodies through the exact exported functions the relay runs.
//   node test_relay_m1a3.mjs        exit 0 when every case passes
import assert from "node:assert/strict";
import {
  newTotals, inspectRequest, responseReader, accountResponse, accountRequest, newCell,
} from "./relay-meter-m1a3.mjs";

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
  assert.deepEqual(i, { parsed: true, assistant: 1, rcMessages: 1, rcChars: rc.length, stream: true, maxTokens: true });
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// UX1's model: an OpenAI-compatible endpoint that answers every chat request at once
// with a fixed short reply, and logs what each harness sent. With the model's own
// time taken out (a fixed FAKE_LATENCY_MS, default 0), what is left of a run's wall
// clock is the harness: its startup, its per-request overhead, its exit.
//
// Logged per request (JSONL on stdout's sibling file, UX1_LOG): arrival time, path,
// bytes of the request body, number of messages, number of tools, bytes of the tool
// schemas -- "context on the wire", counted off the wire, not estimated.
import http from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.FAKE_PORT ?? 19700);
const LATENCY = Number(process.env.FAKE_LATENCY_MS ?? 0);
const LOG = process.env.UX1_LOG ?? "/dev/null";
// The minimal valid "done" in the harness's own protocol. Most end a turn on plain
// text; mini-swe-agent needs a bash block carrying its submit marker, and a plain
// "OK." would make it retry until a limit -- slow for a reason that is not the harness.
const REPLY = process.env.FAKE_REPLY ?? "OK.";
// FAKE_TOOL_CALL='{"name":"bash","arguments":{"command":"..."}}' answers with that one
// tool call instead (mini-swe-agent 2.4.6 ends a task only through a bash tool call).
const TOOL = process.env.FAKE_TOOL_CALL ? JSON.parse(process.env.FAKE_TOOL_CALL) : null;
const toolCall = (withIndex) => ({
  ...(withIndex ? { index: 0 } : {}), id: "call_fake_1", type: "function",
  function: { name: TOOL.name, arguments: JSON.stringify(TOOL.arguments) },
});

function chatResponse(model) {
  return {
    id: "fake-1", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{
      index: 0, finish_reason: TOOL ? "tool_calls" : "stop",
      message: TOOL ? { role: "assistant", content: "", tool_calls: [toolCall(false)] }
                    : { role: "assistant", content: REPLY },
    }],
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  };
}

http
  .createServer((req, res) => {
    const arrived = Date.now();
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let j = {};
      try { j = JSON.parse(body || "{}"); } catch { /* non-JSON probe */ }
      const tools = Array.isArray(j.tools) ? j.tools : [];
      appendFileSync(LOG, JSON.stringify({
        t: arrived, path: req.url, bytes: Buffer.byteLength(body),
        messages: Array.isArray(j.messages) ? j.messages.length : null,
        tools: tools.length, tool_bytes: Buffer.byteLength(JSON.stringify(tools)),
        stream: Boolean(j.stream),
      }) + "\n");
      setTimeout(() => {
        if (req.url.includes("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
          return;
        }
        const model = j.model ?? "fake-model";
        if (j.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const base = { id: "fake-1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
          const delta = TOOL ? { role: "assistant", tool_calls: [toolCall(true)] } : { role: "assistant", content: REPLY };
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: TOOL ? "tool_calls" : "stop" }], usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 } })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(chatResponse(model)));
        }
      }, LATENCY);
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake model on 127.0.0.1:${PORT}`));

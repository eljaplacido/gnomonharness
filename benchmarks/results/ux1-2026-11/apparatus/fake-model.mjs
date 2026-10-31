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
const REPLY = "OK.";

function chatResponse(model) {
  return {
    id: "fake-1", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: REPLY } }],
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
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: REPLY } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 } })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(chatResponse(model)));
        }
      }, LATENCY);
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake model on 127.0.0.1:${PORT}`));

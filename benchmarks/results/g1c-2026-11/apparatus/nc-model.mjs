// G1c negative-control "model": an OpenAI-compatible endpoint that plays a fixed
// script of tool calls, one per request, then ends with plain text. It lets a gate
// be fired at with exact, planted calls and the outcome read from real state.
//
//   NC_PORT        port (default 19800)
//   NC_SCRIPT      JSON array of {tool: <substring of the offered tool name>, args: {...}}
//   NC_LOG         JSONL: every request's offered tool names and the tool results it carried
// A request that offers no tools (title generation, summaries) gets plain text and
// does not advance the script. Requests to any other path are logged as "hits" (the
// exfiltration target of the script).
import http from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.NC_PORT ?? 19800);
const SCRIPT = JSON.parse(process.env.NC_SCRIPT ?? "[]");
const LOG = process.env.NC_LOG ?? "/dev/null";
let step = 0;

const log = (o) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + "\n");

function reply(res, body, stream) {
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(body));
  }
  // Minimal SSE: one chunk carrying the whole message, then [DONE].
  const m = body.choices[0].message;
  const delta = m.tool_calls
    ? { role: "assistant", tool_calls: m.tool_calls.map((c, i) => ({ index: i, ...c })) }
    : { role: "assistant", content: m.content };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ id: body.id, object: "chat.completion.chunk", created: 0, model: body.model,
    choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: body.id, object: "chat.completion.chunk", created: 0, model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: m.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (!req.url.includes("/chat/completions")) {
      log({ hit: req.url, method: req.method, body: raw.slice(0, 300) });
      res.writeHead(200);
      return res.end("ok");
    }
    let b = {};
    try { b = JSON.parse(raw); } catch {}
    const tools = (b.tools ?? []).map((t) => t.function?.name ?? t.name);
    const results = (b.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content).slice(0, 400));
    log({ path: req.url, tools, n_messages: (b.messages ?? []).length, last_tool_result: results.at(-1) ?? null,
          ...(process.env.NC_DUMP_TOOLS ? { schemas: b.tools } : {}) });
    const base = { id: "nc", object: "chat.completion", created: 0, model: b.model ?? "nc" };
    if (!tools.length || step >= SCRIPT.length) {
      return reply(res, { ...base, choices: [{ index: 0, finish_reason: "stop",
        message: { role: "assistant", content: "Done." } }] }, b.stream);
    }
    const s = SCRIPT[step++];
    const name = tools.find((n) => n === s.tool) ?? tools.find((n) => n.includes(s.tool)) ?? s.tool;
    reply(res, { ...base, choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: `call_${step}`, type: "function", function: { name, arguments: JSON.stringify(s.args) } }] } }] }, b.stream);
  });
}).listen(PORT, "127.0.0.1");

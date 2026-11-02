// Vendored from benchmarks/results/ux1-2026-11/apparatus/fake-model.mjs (peers
// branch) for `gnomon acp`'s end-to-end test, with two additions marked ACP
// below: FAKE_SCRIPT, and printing the port actually bound so FAKE_PORT=0 works.
// Nothing here reaches a real model or spends a token.
//
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
import { devNull } from "node:os";

const PORT = Number(process.env.FAKE_PORT ?? 19700);
const LATENCY = Number(process.env.FAKE_LATENCY_MS ?? 0);
// os.devNull, not "/dev/null": on Windows that names <drive>:\dev\null, the append
// throws, and the fake dies before it answers a single request.
const LOG = process.env.UX1_LOG ?? devNull;
// The minimal valid "done" in the harness's own protocol. Most end a turn on plain
// text; mini-swe-agent needs a bash block carrying its submit marker, and a plain
// "OK." would make it retry until a limit -- slow for a reason that is not the harness.
const REPLY = process.env.FAKE_REPLY ?? "OK.";
// FAKE_TOOL_CALL='{"name":"bash","arguments":{"command":"..."}}' answers with that one
// tool call instead (mini-swe-agent 2.4.6 ends a task only through a bash tool call).
const TOOL = process.env.FAKE_TOOL_CALL ? JSON.parse(process.env.FAKE_TOOL_CALL) : null;
// UX1b's scripted session: FAKE_SCRIPT_TURNS=N makes the "model" call the harness's
// own shell tool with `cat notes/chunk_<i>.txt` for i = 0..N-1, then end -- so every
// harness receives byte-identical tool results, and the only command ever run is a
// `cat` of a file the runner wrote. The turn is the number of tool results already
// in the conversation; a request that offers no shell tool (a title, a summary)
// gets plain text.
const SCRIPT_TURNS = Number(process.env.FAKE_SCRIPT_TURNS ?? 0);
const SHELL_NAMES = ["bash", "shell", "run_shell_command", "developer__shell"];
const SUBMIT = process.env.FAKE_SCRIPT_SUBMIT ?? "";  // mini ends only through a bash command
function shellTool(tools) {
  const byName = new Map(tools.map((t) => [t?.function?.name ?? t?.name, t?.function ?? t]));
  for (const n of SHELL_NAMES) if (byName.has(n)) return byName.get(n);
  return null;
}
function argsFor(tool, command) {
  const schema = tool.parameters ?? tool.input_schema ?? {};
  const props = schema.properties ?? {};
  const args = {};
  for (const [k, v] of Object.entries(props)) {
    if (/^(command|cmd)$/.test(k)) args[k] = command;
  }
  for (const k of schema.required ?? []) {
    if (k in args) continue;
    const t = props[k]?.type;
    args[k] = t === "number" || t === "integer" ? 60000 : t === "boolean" ? false : "read the next note";
  }
  if (!Object.keys(args).some((k) => /^(command|cmd)$/.test(k))) args.command = command;
  return args;
}
function toolResults(j) {
  return (j.messages ?? []).filter((m) => m.role === "tool" ||
    (Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_result"))).length;
}
// ACP: FAKE_SCRIPT='[{"tool":{"name":"write","arguments":{...}}},{"text":"Done."}]'
// answers step i with entry i, where i is the number of tool results already in
// the conversation -- so a granted call moves the script on and a refused one
// does too (a refusal is a tool result). Past the end, the last text entry. A
// request that offers no tools at all (a summary) gets plain "OK.".
const SCRIPT = process.env.FAKE_SCRIPT ? JSON.parse(process.env.FAKE_SCRIPT) : null;
function fromScript(j) {
  if (!SCRIPT) return null;
  if (!Array.isArray(j.tools) || j.tools.length === 0) return { text: "OK." };
  const i = toolResults(j);
  const step = SCRIPT[Math.min(i, SCRIPT.length - 1)];
  if (step.tool && i < SCRIPT.length) return { tool: step.tool, turn: i };
  return { text: step.text ?? "Done.", turn: i };
}

function scripted(j) {
  const fs = fromScript(j);
  if (fs) return fs;
  if (!SCRIPT_TURNS) return null;
  const tool = shellTool(Array.isArray(j.tools) ? j.tools : []);
  if (!tool) return { text: "OK." };
  const turn = toolResults(j);
  if (turn < SCRIPT_TURNS) return { tool: { name: tool.name, arguments: argsFor(tool, `cat notes/chunk_${turn}.txt`) }, turn };
  if (SUBMIT) return { tool: { name: tool.name, arguments: argsFor(tool, SUBMIT) }, turn };
  return { text: "Done.", turn };
}

const toolCall = (withIndex, call = TOOL, id = "call_fake_1") => ({
  ...(withIndex ? { index: 0 } : {}), id, type: "function",
  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
});

function reply(j) {
  // The scripted session decides first; otherwise the fixed reply or tool call.
  const sc = scripted(j);
  if (sc?.tool) return { call: sc.tool, id: `call_fake_${sc.turn}` };
  if (sc?.text) return { text: sc.text };
  return TOOL ? { call: TOOL, id: "call_fake_1" } : { text: REPLY };
}

function chatResponse(model, r) {
  return {
    id: "fake-1", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{
      index: 0, finish_reason: r.call ? "tool_calls" : "stop",
      message: r.call ? { role: "assistant", content: "", tool_calls: [toolCall(false, r.call, r.id)] }
                      : { role: "assistant", content: r.text },
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
      res.on("finish", () => appendFileSync(LOG, JSON.stringify({ t_done: Date.now(), arrived }) + "\n"));
      appendFileSync(LOG, JSON.stringify({
        t: arrived, turn_results: toolResults(j), path: req.url, bytes: Buffer.byteLength(body),
        messages: Array.isArray(j.messages) ? j.messages.length : null,
        tools: tools.length, tool_bytes: Buffer.byteLength(JSON.stringify(tools)),
        tool_names: tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean),
        stream: Boolean(j.stream),
      }) + "\n");
      setTimeout(() => {
        if (req.url.includes("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
          return;
        }
        const model = j.model ?? "fake-model";
        const r = reply(j);
        if (j.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const base = { id: "fake-1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
          const delta = r.call ? { role: "assistant", tool_calls: [toolCall(true, r.call, r.id)] } : { role: "assistant", content: r.text };
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: r.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 } })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(chatResponse(model, r)));
        }
      }, LATENCY);
    });
  })
  // ACP: the bound port, not the requested one, so FAKE_PORT=0 can be used.
  .listen(PORT, "127.0.0.1", function () {
    console.log(`fake model on 127.0.0.1:${this.address().port}`);
  });

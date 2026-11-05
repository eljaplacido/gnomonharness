// C2D logging relay: a pass-through in front of a P2G slot relay (relay-go.mjs).
//   node log-relay.mjs <listen host:port> <upstream http://host:port> <out dir>
// For each POST .../chat/completions it stores, under <out dir>:
//   req-NNNN.json.gz   the request body exactly as the agent sent it
//   resp-NNNN.sse.gz   the response bytes exactly as the slot relay returned them
//   calls.jsonl        one summary line per call (below), written when the reply ends
// The slot relay still meters and bills; this file only observes. On a client
// disconnect it aborts the upstream request, so nothing is generated for nobody.
// No credentials pass through here: the slot relay injects the key upstream of us.
import http from "node:http"; import fs from "node:fs"; import zlib from "node:zlib"; import path from "node:path";
const [listen, upstream, outDir] = process.argv.slice(2);
const [LHOST, LPORT] = listen.split(":"); const UP = new URL(upstream);
fs.mkdirSync(outDir, { recursive: true });
let n = 0;
const pad = (i) => String(i).padStart(4, "0");
function summarizeReq(b) {
  const msgs = b.messages || [];
  const asst = msgs.filter((m) => m.role === "assistant");
  return {
    model: b.model, stream: b.stream, temperature: b.temperature ?? null, top_p: b.top_p ?? null,
    max_tokens: b.max_tokens ?? null, max_completion_tokens: b.max_completion_tokens ?? null,
    other_keys: Object.keys(b).filter((k) => !["model", "messages", "tools", "stream", "stream_options", "temperature", "top_p", "max_tokens", "max_completion_tokens"].includes(k)),
    n_messages: msgs.length, roles: msgs.map((m) => m.role[0]).join(""),
    system_chars: msgs.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length)),
    late_system: msgs.slice(1).filter((m) => m.role === "system").length,
    assistant_with_reasoning: asst.filter((m) => m.reasoning_content || m.reasoning).length, assistant: asst.length,
    tools: (b.tools || []).map((t) => t.function?.name), tools_chars: JSON.stringify(b.tools || []).length,
    total_chars: JSON.stringify(msgs).length,
  };
}
function summarizeResp(text) {
  let rc = 0, cc = 0, fin = null, usage = null, calls = {}, objs = 0;
  for (const line of text.split("\n")) {
    const l = line.trim(); if (!l.startsWith("data:") || l === "data: [DONE]") continue;
    let o; try { o = JSON.parse(l.slice(5)); } catch { continue; } objs++;
    if (o.usage) usage = o.usage;
    for (const ch of o.choices || []) {
      const d = ch.delta || ch.message || {};
      rc += (d.reasoning_content || d.reasoning || "").length; cc += (typeof d.content === "string" ? d.content : "").length;
      for (const tc of d.tool_calls || []) { const k = tc.index ?? 0; calls[k] ??= { name: "", args_chars: 0 };
        if (tc.function?.name) calls[k].name = tc.function.name; calls[k].args_chars += (tc.function?.arguments || "").length; }
      if (ch.finish_reason) fin = ch.finish_reason;
    }
  }
  if (!objs) { try { const o = JSON.parse(text); usage = o.usage; const m = o.choices?.[0]?.message || {};
    rc = (m.reasoning_content || "").length; cc = (m.content || "").length; fin = o.choices?.[0]?.finish_reason;
    (m.tool_calls || []).forEach((tc, k) => calls[k] = { name: tc.function?.name, args_chars: (tc.function?.arguments || "").length }); } catch {} }
  return { reasoning_chars: rc, content_chars: cc, tool_calls: Object.values(calls), finish: fin, usage };
}
http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const body = Buffer.concat(chunks); const isChat = req.method === "POST" && /chat\/completions/.test(req.url);
    const i = isChat ? ++n : 0; const t0 = Date.now(); let first = null; const out = [];
    let reqSum = null;
    if (isChat) { fs.writeFileSync(path.join(outDir, `req-${pad(i)}.json.gz`), zlib.gzipSync(body));
      try { reqSum = summarizeReq(JSON.parse(body.toString("utf8"))); } catch (e) { reqSum = { parse_error: String(e) }; } }
    const up = http.request({ host: UP.hostname, port: UP.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: `${UP.hostname}:${UP.port}`, "content-length": String(body.length) } }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.on("data", (c) => { if (first === null) first = Date.now() - t0; if (isChat) out.push(c); res.write(c); });
      ur.on("end", () => { res.end(); if (!isChat) return; const buf = Buffer.concat(out);
        fs.writeFileSync(path.join(outDir, `resp-${pad(i)}.sse.gz`), zlib.gzipSync(buf));
        let enc = ur.headers["content-encoding"]; let text = buf.toString("utf8");
        try { if (enc === "gzip") text = zlib.gunzipSync(buf).toString("utf8"); else if (enc === "br") text = zlib.brotliDecompressSync(buf).toString("utf8"); } catch {}
        fs.appendFileSync(path.join(outDir, "calls.jsonl"), JSON.stringify({ n: i, t: new Date(t0).toISOString(), status: ur.statusCode,
          ttft_ms: first, wall_ms: Date.now() - t0, req: reqSum, resp: summarizeResp(text), aborted: false }) + "\n"); });
    });
    up.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end();
      if (isChat) fs.appendFileSync(path.join(outDir, "calls.jsonl"), JSON.stringify({ n: i, t: new Date(t0).toISOString(), error: String(e), req: reqSum }) + "\n"); });
    res.on("close", () => { if (!res.writableEnded) { up.destroy();
      if (isChat) fs.appendFileSync(path.join(outDir, "calls.jsonl"), JSON.stringify({ n: i, t: new Date(t0).toISOString(), aborted: true, wall_ms: Date.now() - t0, req: reqSum }) + "\n"); } });
    up.end(body);
  });
}).listen(Number(LPORT), LHOST, () => console.log(`log-relay ${LHOST}:${LPORT} -> ${UP.href} into ${outDir}`));

#!/usr/bin/env node
/**
 * canary — an OpenAI-compatible endpoint that answers nothing and records
 * everything.
 *
 * The measurement this exists for is "how much context does a harness put on
 * the wire", and the only honest place to read that is the wire. Every other
 * method is an estimate of somebody's estimate: the 2026-08-30 report derived a
 * cost figure from credit-delta arithmetic, recorded `spent = -$9.26` for one
 * arm, and its own verdict was "the method is broken, not merely coarse".
 *
 * Serves `/v1/models` and `/v1/chat/completions`, appends every request body to
 * a JSONL file, and returns a fixed short answer so that the RESPONSE side
 * contributes the same constant to every harness.
 *
 * Usage:  node canary.mjs <port> <out.jsonl>
 */
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 8099);
const out = process.argv[3] ?? "requests.jsonl";
writeFileSync(out, "");

const ANSWER = "Done.";

const MODELS = {
  object: "list",
  data: [{ id: "canary-model", object: "model", owned_by: "canary" }],
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(MODELS));
      return;
    }
    // Recorded before anything is answered, so a harness that gives up on the
    // response still leaves its request behind.
    appendFileSync(
      out,
      JSON.stringify({
        ts: Date.now(),
        url: req.url,
        bytes: Buffer.byteLength(body, "utf-8"),
        body: (() => {
          try {
            return JSON.parse(body);
          } catch {
            return { unparsed: body.slice(0, 2000) };
          }
        })(),
      }) + "\n"
    );

    const completion = {
      id: "canary-1",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "canary-model",
      choices: [
        { index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 2, total_tokens: 2 },
    };

    // Both shapes, because a streaming client asked for SSE and a
    // non-streaming one asked for JSON, and a harness that cannot parse the
    // reply abandons the turn before its SECOND request — which would measure
    // the wrong thing rather than nothing, and silently.
    if (JSON.parse(body || "{}")?.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: "canary-1",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "canary-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }));
      res.write(chunk({ content: ANSWER }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completion));
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`canary listening on 127.0.0.1:${port}, recording to ${out}\n`);
});

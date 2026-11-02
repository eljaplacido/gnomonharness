// The peer run's relay: exposes the agent model (llama-server :18080) on the docker
// bridge, as relay.mjs does, AND meters tokens. Every response passing through is
// scanned for the usage the server reports; the running totals are kept in memory
// and served on 127.0.0.1:18099/counters.
//
// Why this measures each arm exactly: peer trials run strictly one at a time and
// only container traffic goes through this relay, so the tokens counted between a
// cell's start and end are that cell's. run_peers.sh snapshots the counters around
// every cell.
//
// Usage is read from what the server says it served -- `usage.prompt_tokens` /
// `usage.completion_tokens` in a JSON body or in streamed (SSE) chunks -- never
// estimated from text. A response that carries no usage is counted as such
// (`responses_without_usage`), so an arm whose traffic cannot be metered shows up
// as unmetered rather than as cheap.
//
// Bound to the bridge address only, never 0.0.0.0, and started and stopped by
// run_peers.sh.
import http from "node:http";

const BIND = process.env.RELAY_BIND ?? "172.17.0.1";
const PORT = Number(process.env.RELAY_PORT ?? 18080);
const UPSTREAM = process.env.RELAY_UPSTREAM ?? "http://127.0.0.1:18080";
const COUNTERS_PORT = Number(process.env.RELAY_COUNTERS_PORT ?? 18099);

const totals = {
  requests: 0, responses_with_usage: 0, responses_without_usage: 0,
  prompt_tokens: 0, completion_tokens: 0,
  // From llama-server's `timings`: how much of the prompt was actually computed vs
  // served from the prompt cache. A harness whose prompt prefix stays stable pays
  // less of it -- the latency half of "lean".
  prompt_processed: 0, prompt_cached: 0, responses_with_timings: 0,
  errors: 0,
};

// The LAST object in a body wins: a stream may repeat cumulative usage.
const OBJ = (name) => new RegExp(`"${name}"\\s*:\\s*\\{([^{}]*)\\}`, "g");
const field = (body, key) => {
  const m = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(body);
  return m ? Number(m[1]) : null;
};
const last = (text, name) => {
  let found = null;
  for (const m of text.matchAll(OBJ(name))) found = m[1];
  return found;
};

function account(text) {
  const usage = last(text, "usage");
  const timings = last(text, "timings");
  const p = usage !== null ? field(usage, "prompt_tokens") : null;
  const c = usage !== null ? field(usage, "completion_tokens") : null;
  const t = timings !== null
    ? { cache: field(timings, "cache_n") ?? 0, processed: field(timings, "prompt_n"), gen: field(timings, "predicted_n") }
    : null;
  if (p !== null && c !== null) {
    totals.prompt_tokens += p;
    totals.completion_tokens += c;
    totals.responses_with_usage++;
  } else if (t && t.processed !== null && t.gen !== null) {
    // A stream without usage (the client did not ask for it): llama-server still
    // reports the same numbers in `timings`, prompt = cached + processed.
    totals.prompt_tokens += t.cache + t.processed;
    totals.completion_tokens += t.gen;
    totals.responses_with_usage++;
  } else {
    totals.responses_without_usage++;
  }
  if (t && t.processed !== null) {
    totals.prompt_processed += t.processed;
    totals.prompt_cached += t.cache;
    totals.responses_with_timings++;
  }
}

http
  .createServer((req, res) => {
    totals.requests++;
    const up = new URL(req.url, UPSTREAM);
    const proxied = http.request(
      up,
      { method: req.method, headers: { ...req.headers, host: up.host } },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        let tail = "";
        upRes.on("data", (chunk) => {
          res.write(chunk);
          // Keep a bounded tail: usage arrives in the last bytes of a stream or body.
          tail = (tail + chunk.toString("utf8")).slice(-65536);
        });
        upRes.on("end", () => {
          res.end();
          if (req.url.includes("/chat/completions") || req.url.includes("/completions")) account(tail);
        });
      }
    );
    proxied.on("error", () => {
      totals.errors++;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(proxied);
  })
  .listen(PORT, BIND, () => console.log(`relay-meter ${BIND}:${PORT} -> ${UPSTREAM}`));

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(totals));
  })
  .listen(COUNTERS_PORT, "127.0.0.1", () => console.log(`counters on 127.0.0.1:${COUNTERS_PORT}`));

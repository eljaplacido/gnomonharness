// G1 copy of P2's relay (benchmarks/results/p2-2026-11/apparatus/relay-go.mjs, working tree
// of 2026-10-31 incl. its RELAY_KEY_NAME change) with one guard added; see "G1 guard".
//
// P2's relay: every arm's model traffic to OpenCode Go passes through here, and is
// metered. A sibling of P1's relay-meter.mjs, changed where the upstream changed:
//
// - The upstream is HTTPS (https://opencode.ai/zen/go). The user's Go key is read
//   from opencode's own credential file (RELAY_AUTH_FILE, provider "opencode-go")
//   inside this process, replaces whatever Authorization the client sent, and is
//   never written anywhere. Clients are given a placeholder key.
// - Usage is parsed as JSON, not matched by regex: hosted usage objects nest
//   (`prompt_tokens_details.cached_tokens`).
// - A hosted API reports usage for a stream only when asked, so every streamed
//   chat request gets `stream_options.include_usage = true`. Without it an arm
//   that streams would look free. Applied to every arm alike, and recorded.
// - Go reports what each request counted against the plan as `opencode.allowance`.
//   It is captured from a response header or the JSON body, wherever it appears,
//   so the cost probe measures the allowance spent instead of estimating it.
//
// - Go's usage policy (opencode.ai/v2/docs/console/go, "Where can I use it"): it is
//   for coding agents; a client must send its OWN user agent, not a generic SDK
//   or HTTP-library name, and a stable `x-opencode-session` per conversation.
//   The runner names the current cell (POST /cell?id=&arm=&ua=). A request without
//   a session header gets the cell id (one cell = one conversation); a generic
//   user agent becomes `<arm ua> (gnomon-p2-benchmark)`, which says exactly what
//   this traffic is. A harness's own header or agent is kept. Both are counted:
//   which harnesses work with Go natively is itself a finding.
//
// Totals on 127.0.0.1:RELAY_COUNTERS_PORT/counters; the first few raw usage and
// allowance shapes on /samples, for checking the parser against reality.
// Trials run one at a time, so a cell's traffic is the counter delta around it.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

const BIND = process.env.RELAY_BIND ?? "127.0.0.1";
const PORT = Number(process.env.RELAY_PORT ?? 4002);
// Go's documented bases (opencode.ai/v2/docs/console/go, "Endpoints"): /openai/v1 for
// Chat Completions and Responses, /anthropic/v1 for Messages. Every text model works
// through all three; Go translates. Clients point at <relay>/openai/v1 or
// <relay>/anthropic, and the path is forwarded unchanged under this base.
const UPSTREAM = new URL(process.env.RELAY_UPSTREAM ?? "https://opencode.ai/inference/go/");
const COUNTERS_PORT = Number(process.env.RELAY_COUNTERS_PORT ?? 4099);
const PROVIDER = process.env.RELAY_PROVIDER ?? "opencode-go";

const KEY = (() => {
  const auth = JSON.parse(readFileSync(process.env.RELAY_AUTH_FILE, "utf8"));
  // opencode's auth.json nests {provider: {key}}; gnomon's credentials.json is flat
  // {NAME: key} (RELAY_KEY_NAME selects the entry).
  const k = process.env.RELAY_KEY_NAME ? auth?.[process.env.RELAY_KEY_NAME] : auth?.[PROVIDER]?.key;
  if (typeof k !== "string" || !k) throw new Error(`no key for provider ${PROVIDER} in RELAY_AUTH_FILE`);
  return k;
})();

const totals = {
  requests: 0, chat_requests: 0, /* any of the three model APIs */ responses_with_usage: 0, responses_without_usage: 0,
  prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0,
  allowance: 0, responses_with_allowance: 0,
  include_usage_injected: 0, status_4xx: 0, status_5xx: 0, errors: 0,
  session_native: 0, session_injected: 0, ua_native: 0, ua_replaced: 0, responses_compressed: 0,
};
let cell = { id: "no-cell", arm: "unknown", ua: "unknown-harness/0" };
const seenAgents = {};
const GENERIC_UA = /^$|^(node|undici|node-fetch|axios|got|python-requests|python-httpx|httpx|aiohttp|python-urllib|openai\/|asyncopenai\/|anthropic\/|litellm|go-http-client|curl|wget|okhttp|java|reqwest|bun)/i;
const samples = [];

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : null);

function allowanceOf(obj, headers) {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (/allowance/i.test(k)) {
      const n = num(Array.isArray(v) ? v[0] : v);
      if (n !== null) return { value: n, where: `header ${k}` };
    }
  }
  const a = obj?.opencode?.allowance ?? obj?.usage?.opencode?.allowance;
  if (a !== undefined) {
    const n = num(typeof a === "object" && a !== null ? (a.used ?? a.cost ?? a.amount) : a);
    if (n !== null) return { value: n, where: "body opencode.allowance" };
  }
  return null;
}

// Go's allowance can sit at any depth (usage.opencode.allowance in chat; elsewhere in
// the Responses and Messages shapes): the last `opencode.allowance` found wins.
function findAllowance(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 6) return null;
  if (o.opencode && typeof o.opencode === "object" && num(o.opencode.allowance) !== null) return num(o.opencode.allowance);
  let found = null;
  for (const v of Object.values(o)) { const f = findAllowance(v, depth + 1); if (f !== null) found = f; }
  return found;
}

// One response's tokens, from any of the three APIs. Chat: usage.prompt/completion.
// Responses: usage.input/output (in `response.completed` when streamed). Messages:
// input in `message_start`, output in the final `message_delta`. The last non-null
// value of each wins, which is what every one of those streams means.
function account(bodyText, headers, streamed) {
  let input = null, output = null, cached = null, allowance = null, lastObj = null, lastUsage = null;
  const objs = [];
  if (streamed) {
    for (const line of bodyText.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      try { objs.push(JSON.parse(d)); } catch { /* partial line at the tail cut */ }
    }
  } else {
    try { objs.push(JSON.parse(bodyText)); } catch { /* not JSON */ }
  }
  for (const o of objs) {
    for (const u of [o?.usage, o?.response?.usage, o?.message?.usage]) {
      if (!u || typeof u !== "object") continue;
      lastUsage = u;
      const i = num(u.prompt_tokens) ?? num(u.input_tokens);
      const out = num(u.completion_tokens) ?? num(u.output_tokens);
      const c = num(u.prompt_tokens_details?.cached_tokens) ?? num(u.input_tokens_details?.cached_tokens)
        ?? num(u.cache_read_input_tokens) ?? num(u.prompt_cache_hit_tokens);
      if (i !== null) input = i;
      if (out !== null) output = out;
      if (c !== null) cached = c;
    }
    const a = findAllowance(o);
    if (a !== null) allowance = a;
    lastObj = o;
  }
  const h = allowanceOf(null, headers);
  if (allowance === null && h) allowance = h.value;
  if (input !== null) {
    totals.prompt_tokens += input;
    totals.completion_tokens += output ?? 0;
    totals.cached_tokens += cached ?? 0;
    totals.responses_with_usage++;
  } else {
    totals.responses_without_usage++;
  }
  if (allowance !== null) {
    totals.allowance += allowance;
    totals.responses_with_allowance++;
  }
  if (samples.length < 8) {
    samples.push({ api: cell.api ?? null, usage: lastUsage, allowance,
      header_keys: Object.keys(headers ?? {}).filter((k) => /allow|usage|cost|limit|opencode/i.test(k)),
      body_keys: lastObj && typeof lastObj === "object" ? Object.keys(lastObj) : null });
  }
}

http
  .createServer((req, res) => {
    // G1 guard (the only change from P2's relay-go.mjs): G1's agents are deliberately
    // tempted to send data to URLs, and this process holds the real key. A request
    // target that is not a path under /openai/ or /anthropic/ (an absolute-form
    // `GET https://elsewhere/ HTTP/1.1`, or `//host/`) would make `new URL(req.url,
    // UPSTREAM)` resolve to another host and carry the key there. Refused, counted.
    if (!/^\/(openai|anthropic)\//.test(req.url ?? "")) {
      totals.refused_target = (totals.refused_target ?? 0) + 1;
      req.resume(); res.writeHead(403); res.end(); return;
    }
    totals.requests++;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      const isChat = req.url.includes("/chat/completions");
      const isModel = isChat || /\/responses(\?|$)/.test(req.url) || /\/messages(\?|$)/.test(req.url);
      let streamed = false;
      if (isModel) {
        totals.chat_requests++;
        try {
          const j = JSON.parse(body.toString("utf8"));
          streamed = Boolean(j.stream);
          if (isChat && streamed && !j.stream_options?.include_usage) {
            j.stream_options = { ...(j.stream_options ?? {}), include_usage: true };
            totals.include_usage_injected++;
            body = Buffer.from(JSON.stringify(j));
          }
        } catch { /* not JSON: forwarded untouched */ }
      }
      // /v1/... on this relay is <upstream>/v1/... upstream.
      const up = new URL(req.url.replace(/^\//, ""), UPSTREAM);
      const headers = { ...req.headers, host: up.host, authorization: `Bearer ${KEY}`, "content-length": String(body.length) };
      // Uncompressed upstream responses: a client that accepts gzip/br (gnomon's undici
      // does) got compressed bodies, which pass through fine but cannot be metered.
      // Found on the probe's first gnomon cell: 25 responses, no usage read. Every
      // client accepts identity, so this changes nothing a client sees.
      headers["accept-encoding"] = "identity";
      // Anthropic's API authenticates with x-api-key; the others with a bearer token.
      if (req.url.includes("/anthropic/")) headers["x-api-key"] = KEY;
      else delete headers["x-api-key"];
      if (headers["x-opencode-session"]) totals.session_native++;
      else { headers["x-opencode-session"] = cell.id; totals.session_injected++; }
      const ua = String(req.headers["user-agent"] ?? "");
      (seenAgents[cell.arm] ??= new Set()).add(ua.slice(0, 80));
      if (GENERIC_UA.test(ua)) { headers["user-agent"] = `${cell.ua} (gnomon-p2-benchmark)`; totals.ua_replaced++; }
      else totals.ua_native++;
      const proxied = https.request(up, { method: req.method, headers }, (upRes) => {
        const s = upRes.statusCode ?? 502;
        if (s >= 500) totals.status_5xx++; else if (s >= 400) totals.status_4xx++;
        res.writeHead(s, upRes.headers);
        let tail = "";
        upRes.on("data", (chunk) => {
          res.write(chunk);
          tail = (tail + chunk.toString("utf8")).slice(-262144);
        });
        upRes.on("end", () => {
          res.end();
          if (isModel && s < 400 && upRes.headers["content-encoding"] && upRes.headers["content-encoding"] !== "identity") {
            totals.responses_compressed++;  // upstream ignored identity: counted, never guessed
          } else if (isModel && s < 400) account(tail, upRes.headers, streamed || /event-stream/.test(String(upRes.headers["content-type"] ?? "")));
        });
      });
      proxied.on("error", () => {
        totals.errors++;
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      proxied.end(body);
    });
  })
  .listen(PORT, BIND, () => console.log(`relay-go ${BIND}:${PORT} -> ${UPSTREAM.href}`));

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "POST" && u.pathname === "/cell") {
      cell = { id: u.searchParams.get("id") || "no-cell", arm: u.searchParams.get("arm") || "unknown",
               ua: u.searchParams.get("ua") || "unknown-harness/0" };
    }
    res.writeHead(200, { "content-type": "application/json" });
    const agents = Object.fromEntries(Object.entries(seenAgents).map(([k, v]) => [k, [...v]]));
    res.end(JSON.stringify(u.pathname === "/samples" ? samples : u.pathname === "/agents" ? agents
      : u.pathname === "/cell" ? cell : totals));
  })
  .listen(COUNTERS_PORT, "127.0.0.1", () => console.log(`counters on 127.0.0.1:${COUNTERS_PORT}`));

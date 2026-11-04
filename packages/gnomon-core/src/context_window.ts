/**
 * The context window of the model behind an endpoint, read from the endpoint.
 *
 * C3 (2026-11-04, the root cause of P2G's input-token gap). `gnomon init`
 * writes `[defaults] max_context_tokens = 65536`, and that number also governed
 * hosted endpoints whose windows are far larger. At every leg checkpoint the
 * working context was trimmed to 0.6 x 65536 (about 39k tokens). On P2G
 * (deepseek-v4.1-flash on OpenCode Go, a 1,000,000-token window) 25 of 28 gnomon
 * cells crossed at least one leg, and gnomon's median total input was 1.56M
 * against opencode's 6.89M; opencode never trims a model it does not know.
 * `[endpoints.<name>] max_context_tokens = <n>` already fixed it for a surface
 * that declared the number, and nothing declared it.
 *
 * `max_context_tokens = "auto"` asks the endpoint instead, once per process for
 * each endpoint URL and model, and caches the answer. The listings that publish
 * a window, each a "shape":
 *
 *   opencode    GET <base>/models, data[id].limit.context        (OpenCode Zen, Go)
 *   openrouter  GET <base>/models, data[id].context_length        (OpenRouter)
 *               or data[id].top_provider.context_length
 *   vllm        GET <base>/models, data[id].max_model_len         (vLLM)
 *   llamacpp    GET <root>/props, default_generation_settings.n_ctx  (llama.cpp server)
 *   ollama      POST <root>/api/show, the num_ctx parameter, else model_info.<arch>.context_length
 *
 * Nothing found is not an error. The turn runs on `[defaults]
 * max_context_tokens`, exactly as it would with no declaration, and the caller
 * says so: a note, a `context_window_unresolved` degradation, and
 * `max_context_tokens_source: "default"` in the turn record's `wire`. A metering
 * relay in front of a provider commonly answers 404 to `/models` (P2G's did), so
 * that path is the one most likely to be taken and is tested as such.
 *
 * Runtime imports: none from config.ts. config.ts reads the cache below from
 * routeRole, so the dependency runs one way only.
 */

import type { EndpointKind } from "./config.js";

/** The value of `[endpoints.<name>] max_context_tokens` that asks the endpoint. */
export const AUTO_WINDOW = "auto";

/** The listings a window is read from. A shape names the fields, not the vendor. */
export const LISTING_SHAPES = ["opencode", "openrouter", "vllm", "llamacpp", "ollama"] as const;
export type ListingShape = (typeof LISTING_SHAPES)[number];

/**
 * Where the window a turn was trimmed to came from, as the turn record's
 * `wire.max_context_tokens_source` says it.
 *
 *   declared          `[endpoints.<name>] max_context_tokens = <n>`
 *   listing:<shape>   `"auto"`, read from the endpoint's listing
 *   default           `"auto"`, nothing found: `[defaults] max_context_tokens`
 *
 * An endpoint that declares nothing records neither key, as before the key
 * existed.
 */
export type ContextSource = "declared" | `listing:${ListingShape}` | "default";

/** Every value `max_context_tokens_source` takes, in a stable order. */
export const CONTEXT_SOURCES: readonly ContextSource[] = [
  "declared",
  ...LISTING_SHAPES.map((s) => `listing:${s}` as const),
  "default",
];

/** Each probe gets this long. Two probes at most, so a dead endpoint costs 10 s once. */
export const WINDOW_PROBE_TIMEOUT_MS = 5_000;

/** A window read from one listing. */
export interface WindowHit {
  tokens: number;
  shape: ListingShape;
  /** The field it came from, e.g. `limit.context` */
  field: string;
}

/** Why a listing gave no window. */
export interface WindowMiss {
  miss: string;
}

/** What resolving one endpoint and model found. */
export interface WindowResolution {
  /** The window in tokens. Absent when no listing gave one. */
  tokens?: number;
  source: ContextSource;
  /** Where it was read, e.g. `GET https://…/models → limit.context` */
  from?: string;
  /** Each probe that gave no window, and why, in the order they ran. */
  misses: string[];
}

/** A whole, positive number of tokens, or undefined. */
function tokensOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.floor(value);
  // Some servers quote numbers. A string of digits only, nothing looser.
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n >= 1 && Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

type Entry = Record<string, unknown>;
const obj = (v: unknown): Entry | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Entry) : undefined;

/**
 * The fields of one `/models` entry that state a window, in the order tried.
 * llama.cpp's own `/v1/models` carries `meta.n_ctx_train`, the length the model
 * was trained to rather than what the server was started with, so it is not
 * read: `/props` says what the server runs.
 */
const MODEL_FIELDS: Array<[ListingShape, string, (e: Entry) => unknown]> = [
  ["opencode", "limit.context", (e) => obj(e.limit)?.context],
  ["openrouter", "context_length", (e) => e.context_length],
  ["openrouter", "top_provider.context_length", (e) => obj(e.top_provider)?.context_length],
  ["vllm", "max_model_len", (e) => e.max_model_len],
];

/** The window for `model` in an OpenAI-shaped `/models` listing body. */
export function windowFromModelList(body: unknown, model: string): WindowHit | WindowMiss {
  const data = obj(body)?.data;
  if (!Array.isArray(data)) return { miss: "no data[] in the listing" };
  const entry = data.map(obj).find((e) => e?.id === model);
  if (!entry) return { miss: `${model} is not in the listing (${data.length} models)` };
  for (const [shape, field, read] of MODEL_FIELDS) {
    const tokens = tokensOf(read(entry));
    if (tokens) return { tokens, shape, field };
  }
  return { miss: `${model} is listed without a window` };
}

/** The window a llama.cpp server runs each slot with, from `/props`. */
export function windowFromLlamaProps(body: unknown): WindowHit | WindowMiss {
  const tokens = tokensOf(obj(obj(body)?.default_generation_settings)?.n_ctx);
  return tokens
    ? { tokens, shape: "llamacpp", field: "default_generation_settings.n_ctx" }
    : { miss: "no default_generation_settings.n_ctx" };
}

/**
 * The window for an Ollama model, from `/api/show`.
 *
 * A Modelfile's `num_ctx` is what Ollama actually runs the model with, so it
 * wins. Without one the model's own `<arch>.context_length` is all the listing
 * says, and Ollama may run with a smaller server default than that (see
 * docs/GUIDE.md): declare the number when it matters.
 */
export function windowFromOllamaShow(body: unknown): WindowHit | WindowMiss {
  const b = obj(body);
  const params = typeof b?.parameters === "string" ? b.parameters : "";
  const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(params);
  const numCtx = m ? tokensOf(m[1]) : undefined;
  if (numCtx) return { tokens: numCtx, shape: "ollama", field: "parameters num_ctx" };
  const info = obj(b?.model_info);
  if (info) {
    for (const key of Object.keys(info).sort()) {
      if (!key.endsWith(".context_length")) continue;
      const tokens = tokensOf(info[key]);
      if (tokens) return { tokens, shape: "ollama", field: `model_info.${key}` };
    }
  }
  return { miss: "no num_ctx parameter and no model_info.*.context_length" };
}

/** One request that may answer with a window. */
export interface WindowProbe {
  method: "GET" | "POST";
  url: string;
  body?: string;
  read: (json: unknown) => WindowHit | WindowMiss;
}

/** A URL without its query and fragment, for path surgery. */
function bare(url: string): string {
  return url.replace(/[?#].*$/, "");
}

/**
 * The requests that can say this target's window, in the order they are tried.
 *
 * OpenAI-shaped: the listing beside the chat route (`…/chat/completions` →
 * `…/models`), then llama.cpp's `/props` at the server root (the same path with
 * `/v1/chat/completions` removed). Ollama: `/api/show` beside `/api/chat`.
 */
export function windowProbes(target: { url: string; kind?: EndpointKind; model: string }): WindowProbe[] {
  const url = bare(target.url);
  if (target.kind === "ollama") {
    const origin = originOf(url);
    const show = /\/api\/chat\/?$/.test(url)
      ? url.replace(/\/api\/chat\/?$/, "/api/show")
      : origin
        ? `${origin}/api/show`
        : "";
    if (!show) return [];
    return [
      {
        method: "POST",
        url: show,
        // `name` is what Ollama before 0.4 read; both are accepted since.
        body: JSON.stringify({ model: target.model, name: target.model }),
        read: windowFromOllamaShow,
      },
    ];
  }
  const probes: WindowProbe[] = [];
  if (/\/chat\/completions\/?$/.test(url)) {
    const base = url.replace(/\/chat\/completions\/?$/, "");
    probes.push({ method: "GET", url: `${base}/models`, read: (j) => windowFromModelList(j, target.model) });
    probes.push({ method: "GET", url: `${base.replace(/\/v1$/, "")}/props`, read: windowFromLlamaProps });
  }
  return probes;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Run one probe. Never throws: every failure is a miss with its reason. */
async function runProbe(
  probe: WindowProbe,
  apiKey: string | undefined,
  timeoutMs: number
): Promise<WindowHit | WindowMiss> {
  const where = `${probe.method} ${probe.url}`;
  try {
    const res = await fetch(probe.url, {
      method: probe.method,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(probe.body ? { "content-type": "application/json" } : {}),
      },
      ...(probe.body ? { body: probe.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { miss: `${where} → ${res.status}${res.statusText ? ` ${res.statusText}` : ""}` };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { miss: `${where} → not JSON` };
    }
    const r = probe.read(json);
    return "miss" in r ? { miss: `${where} → ${r.miss}` } : r;
  } catch (err) {
    const why = err instanceof Error ? (err.name === "TimeoutError" ? `no answer in ${timeoutMs} ms` : err.message) : String(err);
    return { miss: `${where} → ${why}` };
  }
}

/** What a target needs for its window to be resolved. */
export interface WindowTarget {
  url: string;
  kind?: EndpointKind;
  model: string;
  apiKeyEnv?: string;
}

/**
 * Ask the endpoint for the model's window. Probes run in order and the first
 * window found wins. Uncached; see resolveContextWindow for the cached call.
 */
export async function probeContextWindow(
  target: WindowTarget,
  timeoutMs: number = WINDOW_PROBE_TIMEOUT_MS
): Promise<WindowResolution> {
  // The key is read for the request and goes nowhere else: not into a miss,
  // not into a note.
  const apiKey = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
  const misses: string[] = [];
  const probes = windowProbes(target);
  if (probes.length === 0) {
    return { source: "default", misses: [`no listing route can be derived from ${bare(target.url)}`] };
  }
  for (const probe of probes) {
    const r = await runProbe(probe, apiKey, timeoutMs);
    if ("miss" in r) {
      misses.push(r.miss);
      continue;
    }
    return {
      tokens: r.tokens,
      source: `listing:${r.shape}`,
      from: `${probe.method} ${probe.url} → ${r.field}`,
      misses,
    };
  }
  return { source: "default", misses };
}

// ---------------------------------------------------------------------------
// The cache: one resolution per endpoint URL and model, for the process.
//
// A process is a session for `gnomon task` and for an interactive session; an
// ACP server that holds several sessions shares the answer between them, which
// is the same answer. routeRole (config.ts) reads `rememberedWindow` so that a
// route built after resolution carries the window without asking again.
// ---------------------------------------------------------------------------

const settled = new Map<string, WindowResolution>();
const inflight = new Map<string, Promise<WindowResolution>>();

function keyOf(t: { url: string; kind?: EndpointKind; model: string }): string {
  return `${t.kind ?? ""}\u0000${t.url}\u0000${t.model}`;
}

/** The resolution already made for this target, if any. Synchronous. */
export function rememberedWindow(t: { url: string; kind?: EndpointKind; model: string }): WindowResolution | undefined {
  return settled.get(keyOf(t));
}

/**
 * Resolve once and remember. `fresh` is true only for the call that ran the
 * probes, so the note and the degradation record are made once, by that call.
 */
export async function resolveContextWindow(
  target: WindowTarget,
  timeoutMs: number = WINDOW_PROBE_TIMEOUT_MS
): Promise<{ resolution: WindowResolution; fresh: boolean }> {
  const key = keyOf(target);
  const known = settled.get(key);
  if (known) return { resolution: known, fresh: false };
  const pending = inflight.get(key);
  if (pending) return { resolution: await pending, fresh: false };
  const run = probeContextWindow(target, timeoutMs).then((r) => {
    settled.set(key, r);
    inflight.delete(key);
    return r;
  });
  inflight.set(key, run);
  return { resolution: await run, fresh: true };
}

/** Forget every resolution. For tests; a session never needs it. */
export function forgetContextWindows(): void {
  settled.clear();
  inflight.clear();
}

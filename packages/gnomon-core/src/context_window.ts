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
 *   anthropic   GET <base>/models/<id>, max_input_tokens           (Anthropic Models API, also in each
 *               GET <base>/models entry; asked first on api.anthropic.com)
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
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gnomonDataDir } from "./credentials.js";
import { knownHostedWindow } from "./known_windows.js";

/** The value of `[endpoints.<name>] max_context_tokens` that asks the endpoint. */
export const AUTO_WINDOW = "auto";

/** The listings a window is read from. A shape names the fields, not the vendor. */
export const LISTING_SHAPES = ["opencode", "openrouter", "vllm", "llamacpp", "ollama", "anthropic"] as const;
export type ListingShape = (typeof LISTING_SHAPES)[number];

/**
 * Where the window a turn was trimmed to came from, as the turn record's
 * `wire.max_context_tokens_source` says it.
 *
 *   declared          `[endpoints.<name>] max_context_tokens = <n>`
 *   listing:<shape>   `"auto"`, read from the endpoint's listing
 *   catalog           the listing gave none; the model is in gnomon's dated table of
 *                     known hosted windows (known_windows.ts)
 *   default           nothing found: `[defaults] max_context_tokens`
 *
 * An endpoint that declares nothing records neither key, as before the key
 * existed.
 */
export type ContextSource = "declared" | `listing:${ListingShape}` | "catalog" | "default";

/** Every value `max_context_tokens_source` takes, in a stable order. */
export const CONTEXT_SOURCES: readonly ContextSource[] = [
  "declared",
  ...LISTING_SHAPES.map((s) => `listing:${s}` as const),
  "catalog",
  "default",
];

/**
 * The ceiling of one probe. A lookup is bounded by the smaller
 * WINDOW_LOOKUP_DEADLINE_MS for all its probes together.
 */
export const WINDOW_PROBE_TIMEOUT_MS = 5_000;

/** A window read from one listing. */
export interface WindowHit {
  tokens: number;
  shape: ListingShape;
  /** The field it came from, e.g. `limit.context` */
  field: string;
  /** Ollama only, see ollamaShowExtras */
  trained?: number;
  modelfile?: true;
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
  /** Ollama only: the model's trained `context_length`, the most `num_ctx` can usefully be */
  trained?: number;
  /** Ollama only: `tokens` is a Modelfile `num_ctx`, what the model runs with */
  modelfile?: true;
  /** Each probe that gave no window, and why. */
  misses: string[];
  /** Read from the machine's cache of an earlier lookup, not asked this time */
  cached?: true;
  /** Cached: the last lookup found no window (it is not repeated for a day) */
  negative?: true;
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
  ["anthropic", "max_input_tokens", (e) => e.max_input_tokens],
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

/** The window of one model from the Anthropic Models API (`GET /v1/models/<id>`): `max_input_tokens`. */
export function windowFromAnthropicModel(body: unknown, model: string): WindowHit | WindowMiss {
  const b = obj(body);
  if (b?.id !== undefined && b.id !== model) return { miss: `answered for ${String(b.id)}, not ${model}` };
  const tokens = tokensOf(b?.max_input_tokens);
  return tokens ? { tokens, shape: "anthropic", field: "max_input_tokens" } : { miss: "no max_input_tokens" };
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

/**
 * What else /api/show says about the window, for the `num_ctx` an Ollama
 * request carries (B2): the model's trained length, and whether the window
 * windowFromOllamaShow read is the Modelfile's own `num_ctx`.
 */
export function ollamaShowExtras(body: unknown): { trained?: number; modelfile?: true } {
  const hit = windowFromOllamaShow(body);
  const info = obj(obj(body)?.model_info);
  let trained: number | undefined;
  for (const key of Object.keys(info ?? {}).sort()) {
    if (!key.endsWith(".context_length")) continue;
    trained = tokensOf(info![key]);
    if (trained) break;
  }
  return {
    ...(trained ? { trained } : {}),
    ...("miss" in hit || hit.field !== "parameters num_ctx" ? {} : { modelfile: true as const }),
  };
}

/** One request that may answer with a window. */
export interface WindowProbe {
  method: "GET" | "POST";
  url: string;
  body?: string;
  read: (json: unknown) => WindowHit | WindowMiss;
  /** Extra request headers (the Anthropic API reads its key from `x-api-key`) */
  headers?: (apiKey: string | undefined) => Record<string, string>;
  /** More the same body says, merged into the hit (Ollama's trained length) */
  extras?: (json: unknown) => { trained?: number; modelfile?: true };
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
        extras: ollamaShowExtras,
      },
    ];
  }
  const probes: WindowProbe[] = [];
  if (/\/chat\/completions\/?$/.test(url)) {
    const base = url.replace(/\/chat\/completions\/?$/, "");
    if (originOf(url) === "https://api.anthropic.com") {
      // The Models API states the window per model; the single-model route is
      // asked first because the list is paginated.
      const anthropicHeaders = (key: string | undefined): Record<string, string> => ({
        "anthropic-version": "2023-06-01",
        ...(key ? { "x-api-key": key } : {}),
      });
      probes.push({
        method: "GET",
        url: `${base}/models/${encodeURIComponent(target.model)}`,
        read: (j) => windowFromAnthropicModel(j, target.model),
        headers: anthropicHeaders,
      });
      probes.push({ method: "GET", url: `${base}/models`, read: (j) => windowFromModelList(j, target.model), headers: anthropicHeaders });
      return probes;
    }
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

/** The part of a Response a probe reads. */
interface ProbeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

const MAX_PROBE_BODY = 16 * 1024 * 1024;

/** One request over node:http (loaded here, not at startup). Rejects on a transport error or abort. */
async function httpGet(probe: WindowProbe, headers: Record<string, string>, signal: AbortSignal): Promise<ProbeResponse> {
  const { request } = await import("node:http");
  return new Promise<ProbeResponse>((resolve, reject) => {
    const req = request(probe.url, { method: probe.method, headers, signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_PROBE_BODY) req.destroy(new Error("listing too large"));
        else chunks.push(c);
      });
      res.on("error", reject);
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? "",
          json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
      });
    });
    req.on("error", reject);
    if (probe.body) req.write(probe.body);
    req.end();
  });
}

/** Run one probe. Never throws: every failure is a miss with its reason. */
async function runProbe(
  probe: WindowProbe,
  apiKey: string | undefined,
  timeoutMs: number,
  signal: AbortSignal
): Promise<WindowHit | WindowMiss> {
  const where = `${probe.method} ${probe.url}`;
  try {
    const headers = {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(probe.headers?.(apiKey) ?? {}),
      ...(probe.body ? { "content-type": "application/json" } : {}),
    };
    // A plain-http endpoint (this machine, the LAN, a tailnet) is asked over
    // node:http. The probe runs beside the first chat request, and fetch's
    // undici builds a whole new HTTP parser (a WebAssembly instance, ~20 MB and
    // ~70 ms of CPU, UX4 2026-11-22) for every connection that is open at the
    // same time; node:http costs a few ms. An https endpoint keeps fetch.
    const res = probe.url.startsWith("http:")
      ? await httpGet(probe, headers, signal)
      : await fetch(probe.url, {
          method: probe.method,
          headers,
          ...(probe.body ? { body: probe.body } : {}),
          signal,
        });
    if (!res.ok) return { miss: `${where} → ${res.status}${res.statusText ? ` ${res.statusText}` : ""}` };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { miss: `${where} → not JSON` };
    }
    const r = probe.read(json);
    return "miss" in r ? { miss: `${where} → ${r.miss}` } : { ...r, ...(probe.extras?.(json) ?? {}) };
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    const why = aborted ? `no answer in ${timeoutMs} ms` : err instanceof Error ? err.message : String(err);
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
 * One overall deadline for a whole lookup. The listing and `/props` are asked
 * at the same time, so a dead endpoint costs this once, not 5 s per probe.
 */
export const WINDOW_LOOKUP_DEADLINE_MS = 1_500;

/**
 * The second probe is asked this long after the first if the first has not
 * answered: a listing that answers quickly is the only request made, a slow
 * one does not hold `/props` back.
 */
export const WINDOW_HEDGE_MS = 100;

/** A window read from an endpoint is trusted for this long across processes. */
export const WINDOW_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A lookup that found no window (or never answered) is not repeated for this long. */
export const WINDOW_CACHE_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Ask the endpoint for the model's window. The probes run concurrently under
 * one deadline; the first that answers with a window wins and the rest are
 * cancelled. Uncached; see resolveContextWindow for the cached call.
 */
export async function probeContextWindow(
  target: WindowTarget,
  timeoutMs: number = WINDOW_LOOKUP_DEADLINE_MS,
  outerSignal?: AbortSignal
): Promise<WindowResolution> {
  // The key is read for the request and goes nowhere else: not into a miss,
  // not into a note.
  const apiKey = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
  const misses: string[] = [];
  // The test suite's switch (vitest.setup.ts) turns the network probes off; the table needs none.
  const probes = process.env.GNOMON_WINDOW_LOOKUP === "off" ? [] : windowProbes(target);
  if (probes.length === 0) {
    misses.push(`no listing route can be derived from ${bare(target.url)}`);
  }
  if (probes.length > 0) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    const onOuter = (): void => ctrl.abort();
    if (outerSignal) {
      if (outerSignal.aborted) ctrl.abort();
      else outerSignal.addEventListener("abort", onOuter, { once: true });
    }
    try {
      const results: Array<WindowHit | WindowMiss | undefined> = probes.map(() => undefined);
      const started: boolean[] = probes.map(() => false);
      const winner = await new Promise<{ i: number; hit: WindowHit } | undefined>((resolve) => {
        let left = probes.length;
        const start = (i: number): void => {
          if (started[i]) return;
          started[i] = true;
          void runProbe(probes[i]!, apiKey, timeoutMs, ctrl.signal).then((r) => {
            results[i] = r;
            if (!("miss" in r)) resolve({ i, hit: r });
            else {
              if (i + 1 < probes.length) start(i + 1); // the earlier one gave nothing: no reason to wait
              if (--left === 0) resolve(undefined);
            }
          });
        };
        start(0);
        // A hedge, not a sequence: when the first has not answered in a moment the
        // others are asked as well, and the first answer with a window wins.
        probes.forEach((_, i) => {
          if (i > 0) {
            const h = setTimeout(() => start(i), WINDOW_HEDGE_MS * i);
            h.unref?.();
            ctrl.signal.addEventListener("abort", () => clearTimeout(h), { once: true });
          }
        });
      });
      if (winner) ctrl.abort(); // the other probes are not wanted
      probes.forEach((_p, i) => {
        const r = results[i];
        if (r && "miss" in r && (!winner || i !== winner.i)) misses.push(r.miss);
      });
      if (winner) {
        const probe = probes[winner.i]!;
        const r = winner.hit;
        return {
          tokens: r.tokens,
          source: `listing:${r.shape}`,
          from: `${probe.method} ${probe.url} → ${r.field}`,
          ...(r.trained ? { trained: r.trained } : {}),
          ...(r.modelfile ? { modelfile: true as const } : {}),
          misses,
        };
      }
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuter);
    }
  }
  return fromTable(target, misses);
}

/** The listing said nothing: the catalog's window if it knows the model, else none. */
function fromTable(target: WindowTarget, misses: string[]): WindowResolution {
  // A model gnomon's table knows is better than the local-sized `[defaults]`
  // guess. A listing, when it answers, has won before this is asked.
  const known = knownHostedWindow(target);
  if (known) {
    return {
      tokens: known.tokens,
      source: "catalog",
      from: `gnomon's table of known hosted windows (${known.model}, ${known.as_of}; ${known.source})`,
      misses,
    };
  }
  return { source: "default", misses };
}

// ---------------------------------------------------------------------------
// The persistent cache: what an endpoint said, per machine.
//
// `<machine data dir>/window-cache.json` (the directory credentials.ts calls
// gnomonDataDir: XDG_DATA_HOME/gnomon, else ~/.local/share/gnomon). Keyed by
// endpoint URL, model and provider kind. A window is kept 7 days, a lookup
// that found none 1 day, so a dead endpoint costs one bounded wait a day. It
// is a record of what a listing said, so a cached window keeps its source
// label. Never read or written under GNOMON_WINDOW_LOOKUP=off. Corrupt,
// unreadable or unwritable is ignored: the cache is an optimisation.
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  /** Absent for a negative result */
  tokens?: number;
  source?: ContextSource;
  from?: string;
  trained?: number;
  modelfile?: true;
}

/** Where the cache lives. */
export function windowCachePath(): string {
  return join(gnomonDataDir(), "window-cache.json");
}

function cacheKey(t: { url: string; kind?: EndpointKind; model: string }): string {
  return `${t.url}\n${t.model}\n${t.kind ?? "openai"}`;
}

function readCacheFile(): Record<string, CacheEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(windowCachePath(), "utf-8"));
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {};
    const out: Record<string, CacheEntry> = {};
    for (const [k, v] of Object.entries(entries)) {
      const e = v as Partial<CacheEntry> | null;
      if (!e || typeof e !== "object" || typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
      if (e.tokens !== undefined && (typeof e.tokens !== "number" || !(e.tokens >= 1))) continue;
      if (e.tokens !== undefined && (typeof e.source !== "string" || !e.source.startsWith("listing:"))) continue;
      out[k] = e as CacheEntry;
    }
    return out;
  } catch {
    return {};
  }
}

function cachedResolution(target: WindowTarget, now: number = Date.now()): WindowResolution | undefined {
  if (process.env.GNOMON_WINDOW_LOOKUP === "off") return undefined;
  const e = readCacheFile()[cacheKey(target)];
  if (!e) return undefined;
  const age = now - e.at;
  if (age < 0) return undefined;
  if (e.tokens) {
    if (age > WINDOW_CACHE_TTL_MS) return undefined;
    return {
      tokens: e.tokens,
      source: e.source!,
      from: `${e.from ?? "listing"} (cached ${new Date(e.at).toISOString().slice(0, 10)})`,
      ...(e.trained ? { trained: e.trained } : {}),
      ...(e.modelfile ? { modelfile: true as const } : {}),
      misses: [],
      cached: true,
    };
  }
  if (age > WINDOW_CACHE_NEGATIVE_TTL_MS) return undefined;
  const r = fromTable(target, ["the endpoint gave no window when last asked (cached, retried after a day)"]);
  return { ...r, cached: true, negative: true };
}

function writeCache(target: WindowTarget, r: WindowResolution): void {
  if (process.env.GNOMON_WINDOW_LOOKUP === "off") return;
  // A window from the catalog is computed, not asked: only listings and
  // negative results are worth keeping.
  const listing = r.tokens !== undefined && r.source.startsWith("listing:");
  const entry: CacheEntry = listing
    ? {
        at: Date.now(),
        tokens: r.tokens,
        source: r.source,
        ...(r.from ? { from: r.from } : {}),
        ...(r.trained ? { trained: r.trained } : {}),
        ...(r.modelfile ? { modelfile: true as const } : {}),
      }
    : { at: Date.now() };
  try {
    const dir = gnomonDataDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entries = readCacheFile();
    const now = Date.now();
    for (const [k, e] of Object.entries(entries)) {
      if (now - e.at > WINDOW_CACHE_TTL_MS) delete entries[k];
    }
    entries[cacheKey(target)] = entry;
    const file = windowCachePath();
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // unwritable: the next process asks again
  }
}

// ---------------------------------------------------------------------------
// The in-process cache and the background lookup.
//
// A process is a session for `gnomon task` and for an interactive session; an
// ACP server that holds several sessions shares the answer between them, which
// is the same answer. routeRole (config.ts) reads `rememberedWindow` so that a
// route built after resolution carries the window without asking again.
//
// The lookup starts in the background (`startWindowLookup`) and a request is
// held for it only when the answer could change what that request does
// (resolveContextWindow's `early`).
// ---------------------------------------------------------------------------

const settled = new Map<string, WindowResolution>();
const inflight = new Map<string, { promise: Promise<WindowResolution>; ctrl: AbortController }>();
/** Keys whose answer a caller has already been told about (the note, the degradation) */
const announced = new Set<string>();

function keyOf(t: { url: string; kind?: EndpointKind; model: string }): string {
  return `${t.kind ?? ""}\u0000${t.url}\u0000${t.model}`;
}

/** The resolution already made for this target, if any. Synchronous. */
export function rememberedWindow(t: { url: string; kind?: EndpointKind; model: string }): WindowResolution | undefined {
  return settled.get(keyOf(t));
}

/**
 * Start resolving in the background and return at once. A cached answer on
 * disk settles synchronously; otherwise the probes run under the deadline and
 * the answer is remembered (in process and on disk) when they finish.
 */
export function startWindowLookup(target: WindowTarget, timeoutMs: number = WINDOW_LOOKUP_DEADLINE_MS): void {
  const key = keyOf(target);
  if (settled.has(key) || inflight.has(key)) return;
  const cached = cachedResolution(target);
  if (cached) {
    settled.set(key, cached);
    return;
  }
  const ctrl = new AbortController();
  const promise = probeContextWindow(target, timeoutMs, ctrl.signal).then((r) => {
    inflight.delete(key);
    if (!ctrl.signal.aborted || r.tokens !== undefined) {
      settled.set(key, r);
      writeCache(target, r);
    }
    return r;
  });
  inflight.set(key, { promise, ctrl });
}

/** Cancel lookups still in flight (a process that is ending must not wait for a dead endpoint). */
export function abortWindowLookups(): void {
  for (const { ctrl } of inflight.values()) ctrl.abort();
}

export interface ResolveOptions {
  timeoutMs?: number;
  /**
   * The request this resolution is for. When the lookup has not finished and
   * `estimate` is below half of `best`, nothing is awaited: the answer is
   * `early` and the caller sizes the request by `best`.
   */
  early?: { estimate: number; best: number };
}

/**
 * Resolve once and remember. `fresh` is true for the first call that sees the
 * answer, so the note and the degradation record are made once. `early` means
 * the lookup is still running and the request went on without it.
 */
export async function resolveContextWindow(
  target: WindowTarget,
  options: number | ResolveOptions = {}
): Promise<{ resolution?: WindowResolution; fresh: boolean; early?: true }> {
  const opts: ResolveOptions = typeof options === "number" ? { timeoutMs: options } : options;
  const key = keyOf(target);
  startWindowLookup(target, opts.timeoutMs);
  let known = settled.get(key);
  if (!known) {
    if (opts.early && opts.early.estimate < opts.early.best / 2) return { fresh: false, early: true };
    const run = inflight.get(key);
    if (run) await run.promise;
    known = settled.get(key) ?? (await inflight.get(key)?.promise);
  }
  if (!known) return { resolution: fromTable(target, []), fresh: false };
  const fresh = !announced.has(key);
  announced.add(key);
  return { resolution: known, fresh };
}

/**
 * Forget every resolution, and the cache file unless `keepFile`. For tests
 * (`keepFile` stands in for "a new process"); a session never needs it.
 */
export function forgetContextWindows(opts: { keepFile?: boolean } = {}): void {
  abortWindowLookups();
  settled.clear();
  inflight.clear();
  announced.clear();
  if (opts.keepFile) return;
  try {
    unlinkSync(windowCachePath());
  } catch {
    // none
  }
}

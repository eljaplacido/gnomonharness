/**
 * gnomon-cli: the real effects behind `gnomon setup` (SetupDeps).
 *
 * Kept apart from the flow so the flow's tests never reach any of it. Each one
 * runs only after the wizard has a yes for it:
 *
 *   pull         Ollama's own POST /api/pull on 127.0.0.1:11434 (what `ollama
 *                pull` does), streaming its progress lines;
 *   speedCheck   one chat request to a local model: temperature 0, at most 64
 *                output tokens, rates from the server's own timings;
 *   checkCloud   one token through a cloud endpoint (`endpoint test`'s probe);
 *   keys.store   the credential store `gnomon key set` writes.
 *
 * `diskFree`, `keys.held` and `listCloudModels` only read.
 */

import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  setCredential,
  listCredentials,
  credentialsPath,
  applyCredentials,
  probeEndpointAuth,
  causeCode,
  type EndpointConfig,
} from "gnomon-core";
import type { SpeedResult } from "./catalog.js";
import type { RuntimeId } from "./probe.js";
import type { PullProgress, PullResult, SpeedOutcome, SpeedRequest, SetupDeps } from "./setup_wizard.js";
import type { EndpointBlock } from "./setup_surface.js";

const OLLAMA = "http://127.0.0.1:11434";
/** A cold load of a 35B model takes tens of seconds; the check waits for it. */
export const SPEED_TIMEOUT_MS = 180_000;
export const SPEED_MAX_TOKENS = 64;
export const SPEED_PROMPT = "Reply with OK.";

/** The speed check's request body: the project's system prompt, a fixed question, temperature 0. */
export function speedRequestBody(req: SpeedRequest): Record<string, unknown> {
  const messages = [
    { role: "system", content: req.system },
    { role: "user", content: SPEED_PROMPT },
  ];
  return req.runtime === "ollama"
    ? { model: req.model, messages, stream: false, options: { temperature: 0, num_predict: SPEED_MAX_TOKENS } }
    : { model: req.model, messages, stream: false, temperature: 0, max_tokens: SPEED_MAX_TOKENS };
}

/**
 * Rates from a speed-check response. Ollama reports nanosecond durations
 * (`prompt_eval_*`, `eval_*`, `load_duration`); llama.cpp reports `timings`
 * in milliseconds. Anything else gets wall-clock rates, marked approximate.
 */
export function parseSpeed(runtime: RuntimeId, model: string, body: unknown, wallMs: number): SpeedResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const rate = (count?: number, ms?: number) => (count !== undefined && ms !== undefined && ms > 0 ? (count * 1000) / ms : undefined);
  if (runtime === "ollama" && n(b.eval_count) !== undefined) {
    const promptTokens = n(b.prompt_eval_count);
    const outputTokens = n(b.eval_count);
    const ns = (v: unknown) => (n(v) !== undefined ? n(v)! / 1e6 : undefined);
    return {
      model,
      runtime,
      prefillTps: rate(promptTokens, ns(b.prompt_eval_duration)),
      genTps: rate(outputTokens, ns(b.eval_duration)),
      loadS: n(b.load_duration) !== undefined ? n(b.load_duration)! / 1e9 : undefined,
      promptTokens,
      outputTokens,
      source: "server",
      wallMs,
    };
  }
  const t = b.timings as Record<string, unknown> | undefined;
  if (t && n(t.predicted_n) !== undefined) {
    return {
      model,
      runtime,
      prefillTps: n(t.prompt_per_second) ?? rate(n(t.prompt_n), n(t.prompt_ms)),
      genTps: n(t.predicted_per_second) ?? rate(n(t.predicted_n), n(t.predicted_ms)),
      promptTokens: n(t.prompt_n),
      outputTokens: n(t.predicted_n),
      source: "server",
      wallMs,
    };
  }
  const usage = (b.usage ?? {}) as Record<string, unknown>;
  const out = n(usage.completion_tokens);
  return {
    model,
    runtime,
    genTps: rate(out, wallMs),
    promptTokens: n(usage.prompt_tokens),
    outputTokens: out,
    source: "wall_clock",
    wallMs,
  };
}

/** Read Ollama's pull stream: one JSON object per line. */
export function readPullLine(line: string): PullProgress | { error: string } | undefined {
  const t = line.trim();
  if (!t) return undefined;
  try {
    const j = JSON.parse(t) as { status?: unknown; completed?: unknown; total?: unknown; error?: unknown };
    if (typeof j.error === "string") return { error: j.error };
    return {
      status: typeof j.status === "string" ? j.status : "",
      ...(typeof j.completed === "number" ? { completed: j.completed } : {}),
      ...(typeof j.total === "number" ? { total: j.total } : {}),
    };
  } catch {
    return undefined;
  }
}

function unreachable(err: unknown): boolean {
  const code = causeCode(err);
  return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH";
}

export async function ollamaPull(tag: string, onProgress: (p: PullProgress) => void, base = OLLAMA): Promise<PullResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: tag, stream: true }),
    });
  } catch (err) {
    return { ok: false, error: causeCode(err) ?? String(err), unreachable: unreachable(err) };
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `Ollama answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`, unreachable: false };
  }
  const decoder = new TextDecoder();
  let buf = "";
  let sawSuccess = false;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const p = readPullLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!p) continue;
        if ("error" in p) return { ok: false, error: p.error, unreachable: false };
        if (p.status === "success") sawSuccess = true;
        onProgress(p);
      }
    }
  } catch (err) {
    return { ok: false, error: causeCode(err) ?? String(err), unreachable: unreachable(err) };
  }
  const tail = readPullLine(buf);
  if (tail && "error" in tail) return { ok: false, error: tail.error, unreachable: false };
  if (tail && tail.status === "success") sawSuccess = true;
  return sawSuccess ? { ok: true } : { ok: false, error: "the pull ended without Ollama saying success", unreachable: false };
}

export async function speedCheck(req: SpeedRequest): Promise<SpeedOutcome> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(req.chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(speedRequestBody(req)),
      signal: AbortSignal.timeout(SPEED_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { error: `no answer within ${SPEED_TIMEOUT_MS / 1000} s`, unreachable: false };
    return { error: causeCode(err) ?? String(err), unreachable: unreachable(err) };
  }
  const wallMs = Date.now() - started;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: `${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`, unreachable: false };
  }
  const body = await res.json().catch(() => ({}));
  return parseSpeed(req.runtime, req.model, body, wallMs);
}

/** Where Ollama keeps models: OLLAMA_MODELS, or the platform's default, whichever exists. */
export function ollamaModelDirs(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string[] {
  const dirs: string[] = [];
  if (env.OLLAMA_MODELS) dirs.push(env.OLLAMA_MODELS);
  dirs.push(join(home, ".ollama", "models"));
  if (platform === "linux") dirs.push("/usr/share/ollama/.ollama/models");
  return dirs;
}

export function diskFree(): { path?: string; bytes?: number } {
  for (const dir of ollamaModelDirs()) {
    if (!existsSync(dir)) continue;
    try {
      const st = statfsSync(dir);
      return { path: dir, bytes: Number(st.bavail) * Number(st.bsize) };
    } catch {
      return { path: dir };
    }
  }
  return {};
}

function endpointConfig(block: EndpointBlock): EndpointConfig {
  return { url: block.url, kind: block.kind as EndpointConfig["kind"], ...(block.api_key_env ? { api_key_env: block.api_key_env } : {}), ...(block.provider ? { provider: block.provider } : {}) } as EndpointConfig;
}

async function listCloudModels(block: EndpointBlock): Promise<string[]> {
  if (block.api_key_env && !process.env[block.api_key_env]) applyCredentials(undefined, [block.api_key_env]);
  const key = block.api_key_env ? process.env[block.api_key_env] : undefined;
  const url = block.kind === "ollama" ? block.url.replace(/\/api\/chat\/?$/, "/api/tags") : block.url.replace(/\/chat\/completions\/?$/, "/models");
  try {
    const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
    return [...(j.data ?? []).map((d) => d.id ?? ""), ...(j.models ?? []).map((m) => m.name ?? "")].filter(Boolean).sort();
  } catch {
    return [];
  }
}

/** The real SetupDeps, less the host, IO and catalog the command supplies. */
export function systemSetupEffects(): Pick<SetupDeps, "pull" | "speedCheck" | "diskFree" | "keys" | "checkCloud" | "listCloudModels"> {
  return {
    pull: (tag, onProgress) => ollamaPull(tag, onProgress),
    speedCheck,
    diskFree,
    keys: {
      held: (v) => Boolean(process.env[v]) || listCredentials().includes(v),
      store: (v, value) => {
        setCredential(v, value);
        process.env[v] = value;
      },
      where: () => credentialsPath(),
    },
    checkCloud: async (block, model) => {
      if (block.api_key_env && !process.env[block.api_key_env]) applyCredentials(undefined, [block.api_key_env]);
      return probeEndpointAuth(endpointConfig(block), model);
    },
    listCloudModels,
  };
}

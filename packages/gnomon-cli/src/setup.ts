/**
 * gnomon-cli: First-run model setup — can this project reach a model yet?
 *
 * `gnomon launch` in a fresh repo with nothing running used to write generic
 * starter tags, call them "very likely wrong — edit them", and then start a
 * session that could not answer a single message. The first message then
 * knocked on a dead port for a minute. Nothing on the way mentioned the one
 * command that fixes it, `gnomon endpoint add`.
 *
 * This module answers the question launch has to ask before it starts a
 * session -- does the role it is about to use have a model that answers? --
 * and holds the pieces of the picker that are worth testing on their own. The
 * picker itself lives in index.ts, beside the `endpoint add` flow it reuses.
 */

import { routeRole, isLoopbackUrl, causeCode, type GnomonConfig } from "gnomon-core";

/** Whether a launch can expect its first message to be answered. */
export interface Readiness {
  ready: boolean;
  /** Why not, in a phrase that completes "No model answers yet: …". */
  why?: string;
}

/** `http://127.0.0.1:11434/api/chat` → `127.0.0.1:11434`. */
export function hostPort(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url;
  }
}

/**
 * Does `role`'s endpoint answer, and does it serve `role`'s model?
 *
 * One listing request, short deadline. Not a completion: that would load a
 * model before the user has typed anything, and on a 35B model that is the
 * better part of a minute. A listing answers "is anything there" and "is this
 * tag among what it serves", which are the two first-run failures.
 *
 * Deliberately generous on everything it cannot judge. A listing that comes
 * back 404 or 500 is not proof the endpoint cannot chat -- some providers
 * serve no listing at all -- so only a refused or silent socket, a missing
 * key, a rejected key, or a tag absent from a real listing count as "not
 * ready". A false "not ready" costs one picker the user can skip; a false
 * "ready" is the minute of retries this exists to prevent, so the line is
 * drawn where the evidence is unambiguous.
 */
export async function checkReadiness(
  config: GnomonConfig,
  role: string,
  timeoutMs = 3000
): Promise<Readiness> {
  let target;
  try {
    target = routeRole(config, role).target;
  } catch (err) {
    return { ready: false, why: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
  const where = target.endpoint ? `"${target.endpoint}" (${hostPort(target.url)})` : hostPort(target.url);

  const key = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
  if (target.apiKeyEnv && !key) {
    return { ready: false, why: `${where} needs $${target.apiKeyEnv}, and it is not set` };
  }

  const ollama = (target.kind ?? "ollama") === "ollama";
  const listUrl = ollama
    ? target.url.replace(/\/api\/chat\/?$/, "/api/tags")
    : target.url.replace(/\/chat\/completions\/?$/, "/models");

  let res: Response;
  try {
    res = await fetch(listUrl, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const errno = causeCode(err);
    if (errno === "ECONNREFUSED" && isLoopbackUrl(target.url)) {
      return { ready: false, why: `nothing is listening on ${hostPort(target.url)}` };
    }
    return { ready: false, why: `${where} did not answer (${errno ?? "no response"})` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ready: false, why: `${where} rejected the key ($${target.apiKeyEnv ?? "none"})` };
  }
  if (!res.ok) return { ready: true };

  let served: string[] = [];
  try {
    const json = (await res.json()) as {
      models?: Array<{ name?: string; model?: string }>;
      data?: Array<{ id?: string }>;
    };
    served = (json.models ?? [])
      .map((m) => m.name ?? m.model ?? "")
      .concat((json.data ?? []).map((m) => m.id ?? ""))
      .filter(Boolean);
  } catch {
    return { ready: true };
  }
  if (served.length === 0) {
    return ollama
      ? { ready: false, why: `Ollama at ${hostPort(target.url)} is running but serves no models` }
      : { ready: true };
  }
  // The same leniency checkRoleModels applies: `qwen3` is served as
  // `qwen3:latest`, and calling that missing would be a false alarm.
  const bare = target.model.split(":")[0]!;
  const has = served.some((m) => m === target.model || m === bare || m.startsWith(bare + ":"));
  if (!has) {
    return { ready: false, why: `${where} does not serve "${target.model}"` };
  }
  return { ready: true };
}

/** One row of the first-run picker. `preset` is a key of ENDPOINT_PRESETS. */
export interface SetupChoice {
  preset: string;
  label: string;
  note: string;
}

/**
 * What the picker offers, in order. Local first: it needs no account and no
 * key, and on a machine that has Ollama it is one keystroke from working.
 */
export const SETUP_CHOICES: SetupChoice[] = [
  { preset: "ollama", label: "Ollama", note: "local, on this machine — no key" },
  { preset: "openrouter", label: "OpenRouter", note: "many providers behind one key" },
  { preset: "opencode-go", label: "OpenCode Go", note: "the opencode.ai subscription" },
  { preset: "opencode-zen", label: "OpenCode Zen", note: "opencode.ai, pay-as-you-go" },
  { preset: "custom", label: "Custom", note: "any OpenAI- or Ollama-shaped URL" },
  { preset: "skip", label: "Skip", note: "start anyway; `gnomon endpoint add` later" },
];

/**
 * Read a picker answer: a number, or the start of a name or preset key.
 * Blank takes the fallback. Undefined means "that was not one of them".
 */
export function parseSetupPick(
  answer: string,
  choices: readonly SetupChoice[] = SETUP_CHOICES,
  fallback = choices[0]!.preset
): string | undefined {
  const a = answer.trim().toLowerCase();
  if (!a) return fallback;
  if (/^\d+$/.test(a)) return choices[Number(a) - 1]?.preset;
  const hit = choices.find(
    (c) => c.preset === a || c.label.toLowerCase() === a || c.label.toLowerCase().startsWith(a)
  );
  return hit?.preset;
}

/**
 * Read a model answer against a numbered list: a number picks from it,
 * anything else is taken as a tag, blank is the fallback.
 */
export function parseModelPick(answer: string, offered: readonly string[], fallback: string): string {
  const a = answer.trim();
  if (!a) return fallback;
  if (/^\d+$/.test(a)) return offered[Number(a) - 1] ?? a;
  return a;
}

/** What to tell someone whose Ollama is not running, as lines. */
export function ollamaNotRunning(url: string): string[] {
  return [
    `Nothing is listening on ${hostPort(url)} — Ollama is not running.`,
    "Start it in another terminal:   ollama serve",
    "(or open the Ollama app; get it from https://ollama.com if it is not installed)",
  ];
}

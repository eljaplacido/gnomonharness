/**
 * gnomon-cli: Model detection for `gnomon init`
 *
 * The starter templates named fixed model tags, which meant a machine with a
 * 35B model was scaffolded onto a 14B one — the template could not know, so it
 * guessed low, and the guess was wrong on the machine it was guessing for.
 *
 * Detection happens once, at scaffold time, and its result is written into
 * `roles.toml` as concrete tags. That keeps Rule 1 intact: the surface still
 * names exact models and is still hashed and portable. What changed is only
 * how the first draft of that file gets written.
 *
 * When nothing is reachable the generic defaults are used and init says so.
 */

import { causeCode } from "gnomon-core";

export interface DetectedModel {
  name: string;
  /** Parameters in billions, parsed from Ollama's metadata */
  billions: number;
  family: string;
}

export interface ModelChoice {
  /** Roles that do the reasoning */
  large: string;
  /** Summarisation, compaction, commit messages */
  small: string;
  /** What was found, for the note written into roles.toml */
  detected: DetectedModel[];
  /** Set when detection did not run or found nothing usable */
  fallback?: string;
}

/** Generic tags used when nothing can be detected. */
export const FALLBACK_LARGE = "qwen2.5:14b-instruct";
export const FALLBACK_SMALL = "qwen2.5:7b-instruct";

/**
 * Models that cannot hold a conversation.
 *
 * Embedding models answer /api/tags like any other and would otherwise be
 * ranked and possibly chosen — an embedding model as `smol` would fail on
 * every turn with an error that looks like a harness bug.
 */
const NOT_CHAT_FAMILIES = new Set(["bert", "nomic-bert"]);
const NOT_CHAT_NAMES = /(^|\/)(bge|nomic-embed|all-minilm|mxbai-embed)/i;

/**
 * Could this tag hold a conversation, judged by name alone?
 *
 * The name is all some callers have. `/v1/models` and `/api/tags` return tags
 * with no family and no parameter size, so `chooseModels` -- which needs both
 * -- cannot be used there, and `gnomon endpoint add` was picking the
 * alphabetically first tag instead. On a stock Ollama that is `bge-m3:latest`,
 * an embedding model, which then failed the probe with
 * `"bge-m3:latest" does not support chat` while the command blamed the URL.
 *
 * Exported so there is ONE list of what cannot chat. A second copy in the CLI
 * would be a list to keep in step by hand, which is how the four-way "only
 * surface, apply and session need the binaries" drift happened.
 *
 * Name-only, so it is a filter and not a verdict: it cannot see a chat model
 * with an unusual name, which is why callers fall back to the full list rather
 * than refusing when nothing matches.
 */
export function looksLikeChatModel(name: string): boolean {
  return !NOT_CHAT_NAMES.test(name);
}

/**
 * Which of these tags to offer as the default, given only their names.
 *
 * Callers have a sorted list from `/v1/models` or `/api/tags` and nothing else
 * -- no family, no parameter size -- so this is deliberately the weakest
 * possible choice: the first tag that does not look like an embedding model.
 * `gnomon endpoint add` took `offered[0]` instead, which is the ALPHABETICALLY
 * first tag, and on a stock Ollama that is `bge-m3:latest`.
 *
 * Falls back to the plain first tag when nothing looks chat-capable. A name
 * filter cannot recognise every chat model, and refusing to suggest anything
 * would be worse than suggesting the same tag as before.
 */
export function suggestChatModel(offered: readonly string[]): string | undefined {
  const chatty = offered.filter(looksLikeChatModel);
  return chatty.find((m) => !looksLikeTrialTier(m)) ?? chatty[0] ?? offered[0];
}

/**
 * A tag naming a free, preview or trial tier of a model.
 *
 * Not offered as the default when anything else chats. OpenCode Go lists 37
 * tags and the alphabetically first chat tag is `beam-free` -- a free tier
 * that answered every step of a 75-call audit with `content: null` and the
 * reasoning "No reasoning available.", then stopped with no answer. Setup
 * pointed every role at it, measured 2026-10-21. Still listed, and still
 * pickable; only the default moves.
 */
const TRIAL_TIER = /(^|[-_.:/])(free|preview|alpha|beta|exp|experimental|contributor)($|[-_.:/])/i;

export function looksLikeTrialTier(name: string): boolean {
  return TRIAL_TIER.test(name);
}

/**
 * Largest model to pick automatically.
 *
 * A 120B model is a poor first experience — minutes per turn on most
 * hardware — so it is not chosen for you. Naming it yourself is one edit.
 */
const AUTO_CEILING_B = 70;

/**
 * Smallest model to pick for the cheap tier.
 *
 * `smol` folds evicted turns into the running summary, so its quality decides
 * whether a long session keeps its decisions. A 4B summariser is a false
 * economy — it costs little and loses what the session was about.
 */
const SMALL_FLOOR_B = 6;

/** "36.0B" → 36, "566.70M" → 0.57 */
export function parseParameterSize(raw: string | undefined): number {
  if (!raw) return 0;
  const m = raw.trim().match(/^([\d.]+)\s*([BM])$/i);
  if (!m) return 0;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return 0;
  return m[2].toUpperCase() === "M" ? value / 1000 : value;
}

/** Rank and filter what an endpoint reported. */
export function chooseModels(models: DetectedModel[]): ModelChoice {
  const chat = models
    .filter((m) => !NOT_CHAT_FAMILIES.has(m.family) && looksLikeChatModel(m.name))
    .filter((m) => m.billions > 0)
    .sort((a, b) => a.billions - b.billions);

  if (chat.length === 0) {
    return {
      large: FALLBACK_LARGE,
      small: FALLBACK_SMALL,
      detected: [],
      fallback: "no chat models were found",
    };
  }

  const underCeiling = chat.filter((m) => m.billions <= AUTO_CEILING_B);
  const large = (underCeiling.length > 0 ? underCeiling : chat).slice(-1)[0];

  // Smallest at or above the floor; the outright smallest only if nothing
  // clears it. Never larger than the reasoning model — a cheap tier that costs
  // more than the expensive one is not a tier.
  const aboveFloor = chat.filter(
    (m) => m.billions >= SMALL_FLOOR_B && m.billions <= large.billions
  );
  const small = aboveFloor.length > 0 ? aboveFloor[0] : chat[0];

  return { large: large.name, small: small.name, detected: chat };
}

/**
 * Ask an Ollama-shaped endpoint what it has.
 *
 * Failure is not an error: init must work with nothing running.
 */
export async function detectModels(
  url = "http://127.0.0.1:11434/api/tags",
  timeoutMs = 3000
): Promise<ModelChoice> {
  const listing = await listOllama(url, timeoutMs);
  if (!listing.reachable) {
    return {
      large: FALLBACK_LARGE,
      small: FALLBACK_SMALL,
      detected: [],
      fallback:
        listing.status !== undefined
          ? `the model host answered ${listing.status}`
          : "no model host was reachable",
    };
  }
  return chooseModels(listing.models);
}

/** What an Ollama /api/tags request found, with the failure kept apart. */
export type OllamaListing =
  | { reachable: true; models: DetectedModel[] }
  | {
      reachable: false;
      /** The socket was refused: no process holds that port. */
      refused: boolean;
      /** The HTTP status, when something answered but not with a listing. */
      status?: number;
      why: string;
    };

/** `…/api/chat` → `…/api/tags`, the listing beside it. */
export function ollamaTagsUrl(chatUrl: string): string {
  return chatUrl.replace(/\/api\/chat\/?$/, "/api/tags");
}


/**
 * List what an Ollama-shaped endpoint serves, with sizes and families.
 *
 * Separate from detectModels because detection only needs a choice, and the
 * callers that offer a pick need the list -- and need "nothing is listening"
 * kept apart from "it answered with nothing". `gnomon endpoint add --preset
 * ollama` used to say `no list available… Pass --model` for both, which sent
 * someone who had simply not started Ollama off to find a tag.
 */
export async function listOllama(
  url = "http://127.0.0.1:11434/api/tags",
  timeoutMs = 3000
): Promise<OllamaListing> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return { reachable: false, refused: false, status: res.status, why: `answered ${res.status}` };
    }
    const json = (await res.json()) as {
      models?: Array<{ name?: string; details?: { parameter_size?: string; family?: string } }>;
    };
    return {
      reachable: true,
      models: (json.models ?? [])
        .map((m) => ({
          name: m.name ?? "",
          billions: parseParameterSize(m.details?.parameter_size),
          family: m.details?.family ?? "",
        }))
        .filter((m) => m.name),
    };
  } catch (err) {
    const errno = causeCode(err);
    return {
      reachable: false,
      refused: errno === "ECONNREFUSED",
      why: errno ?? (err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * The order to offer Ollama's models in, and which one is the default.
 *
 * The default is whatever `gnomon init` would have written -- chooseModels'
 * `large` -- so a pick made at setup and a project scaffolded with Ollama
 * running land on the same tag. After it: the other chat models, largest
 * first (the big one is usually the one you pulled on purpose), then any
 * whose size Ollama did not report, then the ones that cannot chat at all --
 * last, so they are visible but never the easy choice.
 */
export function orderForPicking(models: readonly DetectedModel[]): {
  ordered: DetectedModel[];
  suggested?: string;
  /** The `smol` tier init would choose, when there is one. */
  small?: string;
} {
  if (models.length === 0) return { ordered: [] };
  const choice = chooseModels([...models]);
  const canChat = (m: DetectedModel) =>
    !NOT_CHAT_FAMILIES.has(m.family) && looksLikeChatModel(m.name);
  const rank = (m: DetectedModel) => (!canChat(m) ? 2 : m.billions > 0 ? 0 : 1);
  const ordered = [...models].sort(
    (a, b) => rank(a) - rank(b) || b.billions - a.billions || a.name.localeCompare(b.name)
  );
  const suggested = choice.fallback ? ordered[0]!.name : choice.large;
  const at = ordered.findIndex((m) => m.name === suggested);
  if (at > 0) ordered.unshift(...ordered.splice(at, 1));
  return { ordered, suggested, small: choice.fallback ? undefined : choice.small };
}

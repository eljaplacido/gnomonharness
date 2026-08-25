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
    .filter((m) => !NOT_CHAT_FAMILIES.has(m.family) && !NOT_CHAT_NAMES.test(m.name))
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
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return {
        large: FALLBACK_LARGE,
        small: FALLBACK_SMALL,
        detected: [],
        fallback: `the model host answered ${res.status}`,
      };
    }
    const json = (await res.json()) as {
      models?: Array<{ name?: string; details?: { parameter_size?: string; family?: string } }>;
    };
    return chooseModels(
      (json.models ?? []).map((m) => ({
        name: m.name ?? "",
        billions: parseParameterSize(m.details?.parameter_size),
        family: m.details?.family ?? "",
      })).filter((m) => m.name)
    );
  } catch {
    return {
      large: FALLBACK_LARGE,
      small: FALLBACK_SMALL,
      detected: [],
      fallback: "no model host was reachable",
    };
  }
}

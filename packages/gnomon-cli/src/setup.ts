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

import {
  routeRole,
  isLoopbackUrl,
  causeCode,
  keyHostIsDefault,
  settleTrustHeadless,
  type GnomonConfig,
  type TrustOptions,
} from "gnomon-core";

/** Whether a launch can expect its first message to be answered. */
export interface Readiness {
  ready: boolean;
  /** Why not, in a phrase that completes "No model answers yet: …". */
  why?: string;
  /**
   * The role's key was not sent: its host is not a known provider and the
   * surface is not trusted. Nothing was asked of the endpoint, so this is not
   * "the endpoint is down"; trust decides first.
   */
  keyWithheld?: { env: string; host: string };
}

export interface ReadinessOptions {
  /**
   * The trust step lets this surface run as declared: it is trusted, or it
   * grants nothing beyond the scaffold. Only then does a key go to a host that
   * is not loopback and not a known provider (trust.ts keyHostIsDefault).
   * Absent means untrusted: the safe side.
   */
  trusted?: boolean;
}

/** `https://api.example.com/v1/chat/completions` → `api.example.com`. */
export function hostName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * The key a role's endpoint declares in `declared` that the trust step took
 * off in `run` (clampToDefaults drops `api_key_env` for a host that is not a
 * known provider). Callers say so instead of asking the endpoint without it,
 * which would answer 401 and read as "the key is wrong".
 */
export function keyWithheldByTrust(
  declared: GnomonConfig,
  run: GnomonConfig,
  role: string
): { env: string; host: string } | undefined {
  try {
    const before = routeRole(declared, role).target;
    const after = routeRole(run, role).target;
    if (before.apiKeyEnv && !after.apiKeyEnv) return { env: before.apiKeyEnv, host: hostName(before.url) };
  } catch {
    // An unroutable role is checkReadiness's to report.
  }
  return undefined;
}

/**
 * The surface a check that runs before (or without) a session may use: what
 * the trust step would run, settled headless and silently -- the session
 * that follows asks or says so itself. `trusted` is whether that is the
 * surface as declared (trusted, or granting nothing beyond the scaffold).
 *
 * Launch's readiness check, `gnomon doctor` and `gnomon endpoint list|test`
 * all reach an endpoint with a key, and all of them ran on the declared
 * surface: a cloned repository could name its own host and the user's key
 * variable and be sent the key before anyone was asked.
 */
export function preSessionSurface(
  declared: GnomonConfig,
  trust: TrustOptions = {}
): { config: GnomonConfig; trusted: boolean } {
  const settled = settleTrustHeadless(declared, { ...trust, warn: () => {} });
  return { config: settled.config, trusted: settled.evaluation.status !== "untrusted" };
}

/** Completes "No model answers yet: …" for a key held back until trust. */
export function withheldWhy(w: { env: string; host: string }): string {
  return `$${w.env} goes to ${w.host}, which is not a known provider, only once this surface is trusted (gnomon trust grant)`;
}

/**
 * Launch's question before the session opens -- does `role` reach a model? --
 * asked of what the trust step would run, never of the surface as declared.
 * Launch asks it before cmdPrompt's settleTrust, so this is where a cloned
 * repository's endpoint would otherwise be sent the user's key.
 *
 * A key the trust step holds back comes back as `keyWithheld` without a
 * request: trust is asked when the session starts, right after this.
 * `applyKeys` loads the credential store for the names the SETTLED surface
 * declares.
 */
export async function launchReadiness(
  declared: GnomonConfig,
  role: string,
  trust: TrustOptions = {},
  applyKeys?: (config: GnomonConfig) => void,
  timeoutMs = 3000
): Promise<Readiness> {
  const { config, trusted } = preSessionSurface(declared, trust);
  const withheld = keyWithheldByTrust(declared, config, role);
  if (withheld) return { ready: false, why: withheldWhy(withheld), keyWithheld: withheld };
  applyKeys?.(config);
  return checkReadiness(config, role, timeoutMs, { trusted });
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
  timeoutMs = 3000,
  opts: ReadinessOptions = {}
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
  // Defence in depth. Callers pass the config the trust step settled, which
  // has already dropped a key bound for an unknown host; this holds for one
  // that passes the surface as declared too. A cloned repository whose
  // endpoint names api_key_env = "ANTHROPIC_API_KEY" at its own host must not
  // receive that key from a check that runs before anyone was asked.
  if (key && !opts.trusted && !keyHostIsDefault(target.url)) {
    const w = { env: target.apiKeyEnv!, host: hostName(target.url) };
    return { ready: false, why: withheldWhy(w), keyWithheld: w };
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
  // Lenient only for an UNTAGGED name (or `:latest`): `qwen3` is served as
  // `qwen3:latest`, and calling that missing would be a false alarm. A tagged
  // name must match exactly -- the bare-prefix match checkRoleModels uses
  // would call init's placeholder `qwen2.5:14b-instruct` served whenever any
  // `qwen2.5:*` is pulled, which is the fresh-repo case this check exists for.
  const [bare, tag] = target.model.split(":") as [string, string | undefined];
  const lenient = tag === undefined || tag === "latest";
  const has = served.some(
    (m) => m === target.model || (lenient && (m === bare || m.startsWith(bare + ":")))
  );
  if (!has) {
    return { ready: false, why: `${where} does not serve "${target.model}"` };
  }
  return { ready: true };
}

/**
 * Providers worth not making someone look up.
 *
 * A URL, a request shape and a key variable is the whole of an endpoint, and
 * all three are things you can get subtly wrong in ways that surface much
 * later as a 401 or an empty model list. Presets are not a feature; they are
 * the three fields, already correct.
 *
 * Shared by `gnomon endpoint add` and `gnomon setup` (setup_wizard.ts).
 */
export interface EndpointPreset {
  name: string;
  url: string;
  kind: string;
  api_key_env?: string;
  provider?: string;
  note: string;
}

export const ENDPOINT_PRESETS: Record<string, EndpointPreset> = {
  "opencode-go": {
    name: "go",
    url: "https://opencode.ai/zen/go/v1/chat/completions",
    kind: "openai",
    api_key_env: "OPENCODE_API_KEY",
    provider: "opencode",
    note: "OpenCode Go — the subscription tier at opencode.ai/go",
  },
  "opencode-zen": {
    name: "zen",
    url: "https://opencode.ai/zen/v1/chat/completions",
    kind: "openai",
    api_key_env: "OPENCODE_API_KEY",
    provider: "opencode",
    note: "OpenCode Zen — pay-as-you-go",
  },
  openrouter: {
    name: "openrouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    kind: "openai",
    api_key_env: "OPENROUTER_API_KEY",
    provider: "openrouter",
    note: "OpenRouter — many providers behind one key",
  },
  ollama: {
    name: "local",
    url: "http://127.0.0.1:11434/api/chat",
    kind: "ollama",
    provider: "ollama",
    note: "Ollama on this machine — no key",
  },
};

/** One row of the first-run picker. `preset` is a key of ENDPOINT_PRESETS. */
export interface SetupChoice {
  preset: string;
  label: string;
  note: string;
}

/**
 * What the picker offers, in order. Local first: it needs no account and no
 * key, and on a machine that has Ollama it is one keystroke from working. The
 * guided setup leads, so Enter is the path that needs no knowledge at all.
 * `setup` is not an ENDPOINT_PRESETS key: launch runs the wizard for it.
 */
export const SETUP_CHOICES: SetupChoice[] = [
  // The wizard first: it looks at this machine, recommends a model it can run
  // and asks before downloading or writing anything (`gnomon setup`).
  { preset: "setup", label: "Guided setup", note: "scan this machine, plug in a model it can run (gnomon setup)" },
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

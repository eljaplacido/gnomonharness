/**
 * Prompt caching for Anthropic-family models reached over chat/completions.
 *
 * Anthropic caches a prompt prefix only up to a `cache_control` breakpoint the
 * request names; with none, every request is billed in full. gnomon reaches
 * Claude through OpenAI-shaped chat/completions, usually through a LiteLLM
 * proxy, and sent no breakpoint, so a cloud-only Claude Haiku arm read
 * `cache_read` 0 on every cell, and one cell sent 10.4M uncached prompt tokens.
 *
 * LiteLLM forwards a `cache_control` placed on an OpenAI content part (and on a
 * tool definition) to Anthropic unchanged. So, for an Anthropic-family target,
 * the request gets up to three `{"type": "ephemeral"}` breakpoints in that
 * form:
 *
 *   1. the last content part of the leading system message(s): the system
 *      prompt, which is stable for the session;
 *   2. the last tool definition: tools render before the system prompt on
 *      Anthropic's side, so with (1) the whole fixed prefix is cached;
 *   3. the last content part of the last non-system message: a rolling
 *      breakpoint, so each step of a tool loop reads everything the previous
 *      step wrote.
 *
 * Anthropic allows four per request; markers already present are counted and
 * the total never passes four. A string `content` becomes a one-part text
 * array only where a marker is placed, so everything else goes out as before.
 *
 * Never sent to a non-Anthropic endpoint: Ollama's /api/chat, OpenAI's and
 * DeepSeek's own APIs (both cache automatically and some strict servers refuse
 * the unknown field), or any target whose model id does not name Claude.
 * `[endpoints.<name>] prompt_cache = false` turns it off; `true` turns it on for
 * a gateway whose model id does not say Claude. An endpoint that refuses the
 * markers (400 naming `cache_control`) is sent the call again without them and
 * gets none for the rest of the process (prompt_loop.ts callEndpoint).
 */
import type { RouteTarget } from "./config.js";

/** Anthropic's limit on `cache_control` breakpoints in one request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** The marker, as Anthropic and LiteLLM spell it. Default (5 minute) TTL. */
export const CACHE_MARKER = Object.freeze({ type: "ephemeral" as const });

/**
 * A model id that names an Anthropic model: `claude-*`, `anthropic/*` (LiteLLM,
 * OpenRouter), `us.anthropic.*` / `anthropic.*` (Bedrock), with or without a
 * routing prefix (`bedrock/`, `vertex_ai/`, `openrouter/`).
 */
const ANTHROPIC_MODEL = /(^|[/:])claude[-_.]|(^|[/:.])anthropic[/.]/i;

/** Anthropic's own API. */
const ANTHROPIC_HOSTS = [/(^|\.)api\.anthropic\.com$/i];

/**
 * Hosts that are known not to be Anthropic, whatever the model id says: they
 * cache on their own, and a marker is at best a surplus field to them.
 */
const NON_ANTHROPIC_HOSTS = [/(^|\.)api\.openai\.com$/i, /(^|\.)api\.deepseek\.com$/i];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Whether a model id names an Anthropic model. */
export function isAnthropicModel(model: string | undefined): boolean {
  return typeof model === "string" && ANTHROPIC_MODEL.test(model);
}

/**
 * Whether a target is Anthropic-family: Anthropic's own host, or an
 * OpenAI-shaped endpoint (not one of the known non-Anthropic APIs) serving a
 * model whose id names Claude. Ollama's /api/chat never is.
 */
export function isAnthropicTarget(target: Pick<RouteTarget, "model" | "url" | "kind">): boolean {
  if ((target.kind ?? "ollama") === "ollama") return false;
  const host = hostOf(target.url);
  if (ANTHROPIC_HOSTS.some((re) => re.test(host))) return true;
  if (NON_ANTHROPIC_HOSTS.some((re) => re.test(host))) return false;
  return isAnthropicModel(target.model);
}

// ---------------------------------------------------------------------------
// Refusals, remembered for the process
// ---------------------------------------------------------------------------

/**
 * Endpoint+model pairs that refused a request for carrying `cache_control`.
 * They get no markers from then on. Kept for the process, which is the session
 * for `gnomon task` and the interactive loop alike: a refusal is a property of
 * the server, not of one conversation.
 */
const refused = new Set<string>();

const keyOf = (t: Pick<RouteTarget, "url" | "model">): string => `${t.url}|${t.model}`;

/** Remember that this endpoint+model refused the markers. */
export function refusePromptCache(target: Pick<RouteTarget, "url" | "model">): void {
  refused.add(keyOf(target));
}

/** Whether this endpoint+model refused the markers earlier in the process. */
export function promptCacheRefused(target: Pick<RouteTarget, "url" | "model">): boolean {
  return refused.has(keyOf(target));
}

/** Forget every refusal. For the tests. */
export function resetPromptCacheRefusals(): void {
  refused.clear();
}

/**
 * Whether a request to this target carries cache breakpoints.
 *
 * `prompt_cache = false` on the endpoint: never. A refusal this process: never.
 * Ollama's /api/chat: never. `prompt_cache = true`: yes. Undeclared: when the
 * target is Anthropic-family (isAnthropicTarget).
 */
export function promptCacheOn(target: RouteTarget): boolean {
  if (target.promptCache === false) return false;
  if ((target.kind ?? "ollama") === "ollama") return false;
  if (promptCacheRefused(target)) return false;
  if (target.promptCache === true) return true;
  return isAnthropicTarget(target);
}

/** A 400 body that refuses the markers by name. */
export function readCacheControlRefusal(status: number, detail: string): boolean {
  return status === 400 && /cache_control/i.test(detail);
}

// ---------------------------------------------------------------------------
// Placing the breakpoints
// ---------------------------------------------------------------------------

type WireMessage = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `cache_control` markers already in a request's messages and tools. */
export function countCacheBreakpoints(messages: ReadonlyArray<WireMessage>, tools: ReadonlyArray<unknown>): number {
  let n = 0;
  for (const m of messages) {
    if (isObject(m.cache_control)) n++;
    if (Array.isArray(m.content)) for (const p of m.content) if (isObject(p) && isObject(p.cache_control)) n++;
  }
  for (const t of tools) {
    if (!isObject(t)) continue;
    if (isObject(t.cache_control)) n++;
    if (isObject(t.function) && isObject(t.function.cache_control)) n++;
  }
  return n;
}

/**
 * The message's content with a marker on its last part, or undefined when it
 * has nothing a marker can go on (no content, an empty string, an empty array,
 * a last part that is not an object) or the last part already carries one.
 * A string becomes `[{type: "text", text, cache_control}]`.
 */
function markedContent(content: unknown): unknown[] | undefined {
  if (typeof content === "string") {
    return content === "" ? undefined : [{ type: "text", text: content, cache_control: { ...CACHE_MARKER } }];
  }
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const last = content[content.length - 1];
  if (!isObject(last) || isObject(last.cache_control)) return undefined;
  if (last.type === "text" && last.text === "") return undefined;
  return [...content.slice(0, -1), { ...last, cache_control: { ...CACHE_MARKER } }];
}

export interface CacheBreakpoints {
  messages: WireMessage[];
  tools: unknown[];
  /** Markers this added: 0 to 3 */
  added: number;
  /** Markers the request carried before */
  existing: number;
}

/**
 * The request's messages and tools with cache breakpoints placed, without
 * changing what it was given: a message or tool that gets a marker is copied,
 * every other one is the same object.
 *
 * Placed in order of value, while fewer than four markers are in the request:
 * the rolling one on the last non-system message (it caches everything before
 * it, the fixed prefix included), then the system prompt's, then the last
 * tool's (these two keep the fixed prefix cached when the history is trimmed
 * and the rolling one misses). Late system messages are skipped for the
 * rolling marker: a gateway may move them into the system block, where a
 * marker would cache nothing of the conversation.
 */
export function withCacheBreakpoints(
  messages: ReadonlyArray<WireMessage>,
  tools: ReadonlyArray<unknown>
): CacheBreakpoints {
  const outMessages = [...messages];
  const outTools = [...tools];
  const existing = countCacheBreakpoints(messages, tools);
  let room = Math.max(0, MAX_CACHE_BREAKPOINTS - existing);
  let added = 0;

  const markMessage = (i: number): boolean => {
    const content = markedContent(outMessages[i]!.content);
    if (!content) return false;
    outMessages[i] = { ...outMessages[i]!, content };
    added++;
    room--;
    return true;
  };

  // The rolling marker: the last non-system message that can take one.
  let leadEnd = 0;
  while (leadEnd < outMessages.length && outMessages[leadEnd]!.role === "system") leadEnd++;
  if (room > 0) {
    for (let i = outMessages.length - 1; i >= leadEnd; i--) {
      if (outMessages[i]!.role === "system") continue;
      if (markMessage(i)) break;
    }
  }

  // The system prompt: the last of the leading system messages.
  if (room > 0 && leadEnd > 0) markMessage(leadEnd - 1);

  // The tools: the last definition. A top-level field, as LiteLLM reads it.
  if (room > 0 && outTools.length > 0) {
    const last = outTools[outTools.length - 1];
    if (isObject(last) && !isObject(last.cache_control) && !(isObject(last.function) && isObject(last.function.cache_control))) {
      outTools[outTools.length - 1] = { ...last, cache_control: { ...CACHE_MARKER } };
      added++;
      room--;
    }
  }

  return { messages: outMessages, tools: outTools, added, existing };
}

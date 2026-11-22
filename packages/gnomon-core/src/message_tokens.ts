/**
 * The one token estimate every context decision uses.
 *
 * `estimateTokens` is ~4 characters a token (Rule 1: pure and the same on every
 * machine; no tokenizer to install). `messageTokens` applies it to everything
 * a message puts on the wire, not only `content`. Until 2026-11-22 the trims,
 * observation masking and the per-call record all measured `m.content` alone,
 * so an assistant message that called `write` (empty content, the whole file in
 * `tool_calls[].function.arguments`) cost nothing: a 60k-token working set
 * estimated at 12 tokens and was never trimmed.
 *
 * A leaf module, so prompt_loop.ts, context_hygiene.ts and mediators.ts can
 * all use it without an import cycle.
 */

/** ~4 characters a token. Deterministic, dependency-free. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The fields of a message that cost tokens. Structural, so any ChatMessage fits. */
export interface TokenBearing {
  content: string;
  tool_calls?: unknown[];
  reasoning_content?: string;
  reasoning_details?: unknown[];
  content_parts?: unknown[];
}

export interface MessageTokenOptions {
  /**
   * The endpoint this request goes to is sent the reasoning it stored
   * (`reasoning_content`, `reasoning_details`, `content_parts`): replay is on
   * for it. Off, those fields never leave the process and cost nothing.
   */
  reasoning?: boolean;
}

function jsonText(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * Estimated tokens of one message: its content, its tool calls (name and
 * arguments are sent on every request that carries the message), and, when the
 * target replays reasoning, the reasoning fields that go with it.
 */
export function messageTokens(m: TokenBearing, opts: MessageTokenOptions = {}): number {
  let chars = m.content.length;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) chars += jsonText(m.tool_calls).length;
  if (opts.reasoning) {
    if (typeof m.reasoning_content === "string") chars += m.reasoning_content.length;
    if (Array.isArray(m.reasoning_details) && m.reasoning_details.length > 0) {
      chars += jsonText(m.reasoning_details).length;
    }
    // Sent in place of `content`, so only what exceeds it is extra.
    if (Array.isArray(m.content_parts) && m.content_parts.length > 0) {
      chars += Math.max(0, jsonText(m.content_parts).length - m.content.length);
    }
  }
  return Math.ceil(chars / 4);
}

/** The estimate of a whole message list. */
export function messagesTokens(ms: readonly TokenBearing[], opts: MessageTokenOptions = {}): number {
  let n = 0;
  for (const m of ms) n += messageTokens(m, opts);
  return n;
}

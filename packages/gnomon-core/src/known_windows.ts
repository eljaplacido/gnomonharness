/**
 * Context windows of well-known hosted models: harness data, not surface.
 *
 * Some providers publish no window on their listing (a metering relay that
 * 404s its listing), so an endpoint that declares no
 * number fell back to `[defaults] max_context_tokens` (65,536, sized for a
 * local model) and, with the honest token estimate, trimmed a Claude run at
 * ~39k real tokens against a 200k window. This table is the resolution source
 * AFTER the endpoint's own listing and BEFORE that fallback (CONTRACTS.md
 * section 24): `max_context_tokens_source: "catalog"`.
 *
 * Rules the entries keep:
 *  - Data only, dated, each with the source it was taken from. Updated with
 *    releases, never fetched at run time; a table older than `KNOWN_WINDOWS_AS_OF`
 *    can be stale, which is why a number on the endpoint, and a listing, win.
 *  - The figure is the one the provider's models table states for the model.
 *    The live listing (`listing:anthropic`, `max_input_tokens`) is asked first
 *    and wins; this table is the fallback when it is unreachable.
 *  - A model whose window is not known with a source is left out.
 *
 * Lives in gnomon-core, not in gnomon-cli/catalog/models.toml: that file is the
 * CLI's (`gnomon setup`), and core, which resolves windows, cannot read it.
 */

/** One hosted model's window. */
export interface KnownWindow {
  /** The model id as the provider's API names it (a trailing `-YYYYMMDD` snapshot is matched too). */
  model: string;
  /** The standard window in tokens. */
  tokens: number;
  /** Where the figure comes from. */
  source: string;
  /** The day the figure was taken from that source (YYYY-MM-DD). */
  as_of: string;
}

/** The day the table below was last reviewed. */
export const KNOWN_WINDOWS_AS_OF = "2026-11-22";

const ANTHROPIC_MODELS =
  "https://platform.claude.com/docs/en/about-claude/models/overview (the models table's context window column, " +
  "as cached 2026-11-03)";

const CLAUDE_1M = [
  "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2", "claude-fable-5-1",
  "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
];

export const KNOWN_HOSTED_WINDOWS: readonly KnownWindow[] = [
  ...CLAUDE_1M.map((model) => ({ model, tokens: 1_000_000, source: ANTHROPIC_MODELS, as_of: "2026-11-03" })),
  { model: "claude-haiku-4-5", tokens: 200_000, source: ANTHROPIC_MODELS, as_of: "2026-11-03" },
  {
    model: "deepseek-v4.1-flash",
    tokens: 1_000_000,
    source:
      "GET https://opencode.ai/zen/go/v1/models -> data[id].limit.context, 2026-11-04 " +
      "(the opencode body kept in conformance/endpoint_window.json)",
    as_of: "2026-11-04",
  },
];

/** Hosts that are this machine: a local server that happens to serve a hosted id is not that hosted model. */
function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * The table's entry for this model on this endpoint, or undefined. The id is
 * matched whole (case-insensitively), after dropping a leading `anthropic/`,
 * and with an optional dated snapshot suffix (`-20261101`, `-latest`). An
 * endpoint on this machine never matches.
 */
export function knownHostedWindow(target: { url: string; model: string }): KnownWindow | undefined {
  if (isLocalHost(target.url)) return undefined;
  const id = target.model.trim().toLowerCase().replace(/^anthropic\//, "");
  return KNOWN_HOSTED_WINDOWS.find((k) => id === k.model || new RegExp(`^${k.model.replace(/[.]/g, "\\.")}-(\\d{8}|latest)$`).test(id));
}

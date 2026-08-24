/**
 * gnomon-core: Interactive prompt loop
 *
 * Reads user input from stdin, infers role, calls model API,
 * displays results with outcome buckets.
 *
 * Uses Ollama (localhost:11434) by default. Configurable via
 * GNOMON_MODEL_URL env var.
 */

import * as readline from "node:readline";
import { resolve } from "node:path";
import {
  GnomonConfig,
  RouteTarget,
  routeRole,
  listRoles,
  listProfiles,
  resolveContext,
  Compaction,
  resolveUi,
  resolveEndpoint,
  resolveRouting,
  recomputeManifest,
  routeInput,
  ResolvedRouting,
  RoutingMode,
  listEndpoints,
  parseMetaFields,
  ResolvedUi,
  MetaField,
  META_FIELDS,
} from "./config.js";
import { Progress, renderExchange, splitThinking, paint } from "./render.js";
import {
  buildToolSet,
  executeTool,
  needsApproval,
  ToolContext,
  ToolOutcome,
  ApprovalRequest,
  Approver,
  SandboxLevel,
  ApprovalGate,
} from "./tools.js";
import { mapBucket } from "./session.js";
import { loadSkills, loadProposedSkills, selectSkills, applySkills } from "./skills.js";
import { AuditTrail, resolveAudit } from "./audit.js";
import {
  resolveSessionStore,
  saveSession,
  loadSession,
  SESSION_FORMAT,
  SessionSnapshot,
} from "./session_store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single exchange: user input → model response → outcome */
export interface PromptExchange {
  turn: number;
  role: string;
  input: string;
  output: string;
  model: string;
  code: number;
  bucket: string;
  duration_ms: number;
  /** Prior turns carried into this call (excludes the current one) */
  context_turns?: number;
  /** Prior turns the window could not fit */
  context_dropped?: number;
  /** Estimated prompt tokens sent */
  context_tokens?: number;
  /** Tool calls executed during this turn */
  tool_steps?: number;
  /** One line per tool call, for the transcript */
  tool_log?: string[];
  /** Folded into the running summary; no longer replayed verbatim */
  folded?: boolean;
}

/** State for the interactive prompt loop */
export interface PromptState {
  config: GnomonConfig;
  exchanges: PromptExchange[];
  currentRole: string;
  /** Resolved `[ui]`; /meta and /think edit this copy for the session only */
  ui?: ResolvedUi;
  /** Resolved `[routing]`; /mode edits this copy for the session only */
  routing?: ResolvedRouting;
  /**
   * Running summary of turns evicted from the window under
   * `compaction = "summary"`. Replaces them in the prompt.
   */
  summary?: string;
  /** Identifier this conversation is saved under */
  sessionId?: string;
}

/** The id this session saves under, or a placeholder before one is assigned. */
function sessionIdOf(state: PromptState): string {
  return state.sessionId ?? "(not started)";
}

/** The session's UI settings, resolving from the surface on first use. */
function uiOf(state: PromptState): ResolvedUi {
  if (!state.ui) state.ui = resolveUi(state.config);
  return state.ui;
}

/** The session's routing policy, resolving from the surface on first use. */
function routingOf(state: PromptState): ResolvedRouting {
  if (!state.routing) state.routing = resolveRouting(state.config);
  return state.routing;
}

// ---------------------------------------------------------------------------
// Context window
// ---------------------------------------------------------------------------

/** One message in a chat-completions payload */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Echoed back verbatim on an assistant turn that called tools */
  tool_calls?: unknown[];
  /** Set on a tool result; both spellings, since backends differ */
  tool_call_id?: string;
  tool_name?: string;
}

/** One tool invocation requested by the model */
export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/** The messages for one call, plus what the window had to leave out */
export interface BuiltContext {
  messages: ChatMessage[];
  /** Prior turns carried into the call */
  included: number;
  /** Prior turns the window could not fit */
  dropped: number;
  /** Those turns themselves, so a compactor can fold them */
  evicted: PromptExchange[];
  /** Estimated prompt tokens */
  tokens: number;
  /** Tokens available for history after system prompt + current input */
  budget: number;
  /** Set when the surface asks for behaviour this build does not implement */
  notice?: string;
}

/**
 * Estimated token count: ~4 characters per token.
 *
 * Deliberately not a real tokenizer. A tokenizer is a per-model artifact that
 * would have to be installed and resolved per machine — exactly the
 * machine-scoped dependency Rule 1 forbids. This is pure, deterministic, and
 * has no dependencies: the same string always yields the same number, so the
 * window slides identically on every machine.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Token cost of replaying one exchange (its user turn + its reply). */
function exchangeCost(e: PromptExchange): number {
  return (
    estimateTokens(e.input) +
    estimateTokens(splitThinking(e.output).answer || e.output)
  );
}

/**
 * Build the message list for one call, honouring `[context]` in config.toml.
 *
 * `policy = "full"`           — replay every prior turn.
 * `policy = "sliding_window"` — keep `retain_after` tokens of the *oldest*
 *   turns (the original ask, which is what later turns refer back to) and fill
 *   the remaining budget from the newest turns backwards. The middle is what
 *   gives way, because that is the part neither end depends on.
 *
 * Turns that failed are never replayed: their `output` is a transport error
 * string, not something the model said. Feeding it back as an assistant
 * message would teach the model that it emits connection errors.
 *
 * Whatever does not fit is named in-band rather than silently vanishing —
 * the same rule system.md applies to unreachable tools.
 */
export function buildMessages(
  state: PromptState,
  systemPrompt: string,
  input: string
): BuiltContext {
  const ctx = resolveContext(state.config);
  const messages: ChatMessage[] = [];
  let notice: string | undefined;

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  // Folded turns live in the summary now; replaying them too would pay for
  // the same content twice.
  const usable = state.exchanges.filter((e) => e.code === 0 && !e.folded);

  if (state.summary) {
    messages.push({
      role: "system",
      content:
        `[gnomon context] Summary of earlier turns in this session, folded ` +
        `because they no longer fit the window:\n\n${state.summary}`,
    });
  }
  const budget = Math.max(
    0,
    ctx.max_context_tokens -
      estimateTokens(systemPrompt) -
      estimateTokens(input) -
      estimateTokens(state.summary ?? "")
  );

  // policy = "summary" windows exactly like sliding_window; what differs is
  // what happens to the evicted turns, which is compaction's job. Setting
  // policy = "summary" implies compaction = "summary".
  const compaction: Compaction =
    ctx.policy === "summary" ? "summary" : ctx.compaction;

  let head: PromptExchange[] = [];
  let tail: PromptExchange[] = [];
  let cursor = 0;

  if (ctx.policy === "full") {
    head = usable;
    cursor = usable.length;
  } else {
    const headLimit = Math.min(ctx.retain_after, budget);
    let used = 0;
    for (; cursor < usable.length; cursor++) {
      const cost = exchangeCost(usable[cursor]);
      if (used + cost > headLimit) break;
      used += cost;
      head.push(usable[cursor]);
    }
    for (let j = usable.length - 1; j >= cursor; j--) {
      const cost = exchangeCost(usable[j]);
      if (used + cost > budget) break;
      used += cost;
      tail.unshift(usable[j]);
    }
  }

  const dropped = usable.slice(cursor, usable.length - tail.length);
  // Replay the answer, never the scratchpad. A <think> block is the model's
  // working, not something it said — feeding it back costs tokens and invites
  // the model to keep reasoning about a question it already answered.
  const replay = (e: PromptExchange) => {
    messages.push({ role: "user", content: e.input });
    messages.push({
      role: "assistant",
      content: splitThinking(e.output).answer || e.output,
    });
  };

  head.forEach(replay);

  if (dropped.length > 0) {
    // Under compaction = "summary" these are about to be folded by
    // compactSession(); say they are pending rather than lost.
    const explain =
      compaction === "truncate"
        ? `[gnomon context] ${dropped.length} earlier turn(s) compacted to ` +
          `their prompts (compaction=truncate):\n` +
          dropped
            .map(
              (e) =>
                `- turn ${e.turn} (${e.role}): ` +
                `${e.input.slice(0, 120).replace(/\s+/g, " ")}`
            )
            .join("\n")
        : compaction === "summary"
          ? `[gnomon context] ${dropped.length} earlier turn(s) are being ` +
            `folded into the summary above.`
          : `[gnomon context] ${dropped.length} earlier turn(s) dropped to fit ` +
            `the window (policy=${ctx.policy}, compaction=discard).`;
    messages.push({ role: "system", content: explain });
  }

  tail.forEach(replay);
  messages.push({ role: "user", content: input });

  return {
    messages,
    evicted: dropped,
    included: head.length + tail.length,
    dropped: dropped.length,
    tokens: messages.reduce((n, m) => n + estimateTokens(m.content), 0),
    budget,
    notice,
  };
}

// ---------------------------------------------------------------------------
// Model inference
// ---------------------------------------------------------------------------

/** Model inference result from API call */
interface InferenceResult {
  content: string;
  code: number;
  /** Normalised tool calls the model asked for */
  toolCalls: ToolCall[];
  /** The backend's own representation, echoed back unchanged */
  rawToolCalls?: unknown[];
}

/** Tool arguments arrive as an object (Ollama) or a JSON string (OpenAI). */
function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Call one inference endpoint (Ollama /api/chat or any OpenAI-compatible
 * /chat/completions) with a hard timeout.
 *
 * Response parsing supports both shapes:
 * - Ollama:  { message: { content } } or { response }
 * - OpenAI:  { choices: [ { message: { content } } ] }
 */
async function callEndpoint(
  target: RouteTarget,
  messages: ChatMessage[],
  tools: unknown[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<InferenceResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Sampling params go top-level (OpenAI shape); Ollama reads the
  // nested `options` object — send both so either backend is happy.
  const payload: Record<string, unknown> = {
    model: target.model,
    messages,
    stream: false,
    temperature: target.temperature,
    top_p: target.top_p,
    options: {
      temperature: target.temperature,
      top_p: target.top_p,
    },
  };
  if (tools.length > 0) payload.tools = tools;

  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      // Either the request deadline or the user pressing Esc ends the call.
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
        : AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return {
        content: `Model API error: ${res.status} ${res.statusText}`,
        code: 10,
        toolCalls: [],
      };
    }

    const json = await res.json();
    const message = json.choices?.[0]?.message ?? json.message ?? {};
    const content = message.content ?? json.response ?? "";

    const raw: unknown[] = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    const toolCalls: ToolCall[] = raw.map((c) => {
      const call = c as {
        id?: string;
        name?: string;
        arguments?: unknown;
        function?: { name?: string; arguments?: unknown };
      };
      return {
        id: call.id,
        name: call.function?.name ?? call.name ?? "",
        args: parseToolArgs(call.function?.arguments ?? call.arguments),
      };
    });

    return { content, code: 0, toolCalls, rawToolCalls: raw };
  } catch (err) {
    if (signal?.aborted) {
      return { content: CANCELLED, code: 2, toolCalls: [] };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Model unavailable at ${target.url}: ${msg}`,
      code: 10,
      toolCalls: [],
    };
  }
}

/** Marker text for a turn the user stopped. Code 2 → bucket `refusal`. */
export const CANCELLED = "Cancelled.";

/** Default per-request timeout. Cold-loading large local models needs headroom. */
function modelTimeoutMs(): number {
  const raw = parseInt(process.env.GNOMON_MODEL_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

/** Print a styled header */
function printBanner(): void {
  console.log("\n");
  console.log(" ╔══════════════════════════════════════════╗");
  console.log(" ║          gnomon — interactive mode        ║");
  console.log(" ║   Deterministic coding agent harness      ║");
  console.log(" ╚══════════════════════════════════════════╝");
  console.log("");
  console.log("/help for commands · /meta and /think to change what you see");
  console.log("/context for the window · /role <name> to switch role");
  console.log("Esc cancels the turn.  /mode suggest|auto lets the harness route.");
  console.log("Type /quit or Ctrl+C to exit.");
  console.log("");
}

/** Print a styled exchange through the configurable renderer */
function printExchange(exchange: PromptExchange, ui: ResolvedUi): void {
  for (const line of renderExchange(exchange, ui)) {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Agentic turn
// ---------------------------------------------------------------------------

/** Everything one turn needs that is not in PromptState. */
export interface TurnDeps {
  approve: Approver;
  progress: Progress;
  ui: ResolvedUi;
  /** Emit a transcript line as work happens */
  say: (line: string) => void;
  /** Aborted when the user presses Esc (or Ctrl+C) mid-turn */
  signal?: AbortSignal;
  /** Append-only trail; a disabled one is a no-op */
  audit?: AuditTrail;
}

/** Result of one agentic turn, before it becomes a PromptExchange. */
export interface TurnResult {
  content: string;
  /** Worst outcome code seen — model transport or any tool */
  code: number;
  model: string;
  toolSteps: number;
  toolLog: string[];
}

/** Severity order, so the worst outcome in a turn is the one reported. */
function worse(a: number, b: number): number {
  const rank = (c: number) =>
    mapBucket(c) === "apparatus_failure" ? 2 : mapBucket(c) === "refusal" ? 1 : 0;
  return rank(b) > rank(a) ? b : a;
}

/**
 * Run one turn to completion: call the model, execute any tools it asks for,
 * feed the results back, repeat until it answers in prose.
 *
 * Stops at `max_steps` from roles.toml (default 12) and says so rather than
 * looping. Every tool call records an outcome code, so a turn where the user
 * declined a write reports `refusal` — the bucket that was unreachable while
 * outcomes were derived from HTTP status alone.
 */
export async function runAgenticTurn(
  state: PromptState,
  /** The role THIS turn runs as — a `/plan …` prefix differs from the
   *  session role, and it selects both the tool list and max_steps. */
  role: string,
  route: ReturnType<typeof routeRole>,
  messages: ChatMessage[],
  deps: TurnDeps
): Promise<TurnResult> {
  const config = state.config;
  const toolSet = buildToolSet(config, role);
  const offered = new Set(toolSet.schemas.map((t) => t.function.name));

  const defaults = config.config.defaults ?? {};
  const policy = config.policy ?? {};
  const gate = ((policy.approval as { gate?: string } | undefined)?.gate ??
    defaults.approval ??
    "on_write") as ApprovalGate;
  const sandbox = ((policy.sandbox as { level?: string } | undefined)?.level ??
    defaults.sandbox ??
    "confined") as SandboxLevel;

  const ctx: ToolContext = {
    config,
    bashAllow: config.roles[role]?.bash_allow,
    root: resolve(config.gnomonDir, ".."),
    sandbox,
    gate,
    approve: deps.approve,
    timeoutMs: toolTimeoutMs(config),
    maxOutputBytes: 32_000,
  };

  const roleDef = config.roles[role] ?? {};
  const maxSteps = typeof roleDef.max_steps === "number" ? roleDef.max_steps : 12;

  const working: ChatMessage[] = [...messages];
  const toolLog: string[] = [];
  let code = 0;
  let steps = 0;
  let usedModel = route.model;

  const cancelled = (): TurnResult => ({
    content: CANCELLED,
    code: worse(code, 2),
    model: usedModel,
    toolSteps: steps,
    toolLog,
  });

  for (;;) {
    if (deps.signal?.aborted) return cancelled();

    let result = await callEndpoint(
      route.target,
      working,
      toolSet.schemas,
      modelTimeoutMs(),
      deps.signal
    );
    usedModel = route.model;

    if (deps.signal?.aborted) return cancelled();

    if (result.code !== 0 && route.fallback) {
      deps.progress.update(
        `${route.fallback.model} — primary unavailable, falling back`
      );
      usedModel = route.fallback.model;
      result = await callEndpoint(
        route.fallback,
        working,
        toolSet.schemas,
        modelTimeoutMs(),
        deps.signal
      );
      if (deps.signal?.aborted) return cancelled();
    }

    code = worse(code, result.code);

    if (result.code !== 0 || result.toolCalls.length === 0) {
      return { content: result.content, code, model: usedModel, toolSteps: steps, toolLog };
    }

    if (steps + result.toolCalls.length > maxSteps) {
      const note =
        `Stopped: this turn reached max_steps (${maxSteps}) for role ` +
        `"${role}". ${steps} tool call(s) ran.`;
      deps.say(paint(deps.ui, "yellow", `  [tools] ${note}`));
      return {
        content: result.content || note,
        code: worse(code, 4),
        model: usedModel,
        toolSteps: steps,
        toolLog,
      };
    }

    // Echo the assistant turn back verbatim — some backends validate that a
    // tool result answers a tool call they can see.
    working.push({
      role: "assistant",
      content: result.content ?? "",
      tool_calls: result.rawToolCalls,
    });

    for (const call of result.toolCalls) {
      // Stop between tools rather than mid-write: a cancelled turn should
      // never leave a half-applied change.
      if (deps.signal?.aborted) {
        deps.progress.stop();
        return cancelled();
      }
      steps++;
      const gated = needsApproval(call.name, gate) && offered.has(call.name);
      deps.progress.stop();
      deps.say(
        paint(deps.ui, "cyan", `  ⚙ ${call.name}`) +
          paint(deps.ui, "gray", ` ${describeCall(call)}`)
      );

      const outcome: ToolOutcome = await executeTool(call.name, call.args, ctx, offered);
      code = worse(code, outcome.code);
      toolLog.push(outcome.summary);

      deps.audit?.write("tool_call", {
        role,
        tool: call.name,
        // The target is metadata; the content it carries is not.
        target: describeCall(call),
        gated,
        code: outcome.code,
        bucket: mapBucket(outcome.code),
        summary: outcome.summary,
        args: deps.audit.text(JSON.stringify(call.args)),
        result: deps.audit.text(outcome.content),
      });

      const bucket = mapBucket(outcome.code);
      deps.say(
        paint(
          deps.ui,
          bucket === "result" ? "green" : bucket === "refusal" ? "yellow" : "red",
          `    ${bucket === "result" ? "✓" : bucket === "refusal" ? "⚠" : "✗"} ${outcome.summary}`
        )
      );

      working.push({
        role: "tool",
        content: outcome.content,
        tool_call_id: call.id,
        tool_name: call.name,
      });
      if (!gated) {
        // keep the spinner honest about what is running next
        deps.progress.start(`${usedModel} — ${steps} tool call(s) so far`);
      } else {
        deps.progress.start(`${usedModel} — ${steps} tool call(s) so far`);
      }
    }
  }
}

/** A short, readable form of a tool call for the transcript. */
function describeCall(call: ToolCall): string {
  const a = call.args;
  if (typeof a.path === "string") return String(a.path);
  if (typeof a.command === "string") {
    const c = String(a.command).replace(/\s+/g, " ");
    return c.length > 70 ? `${c.slice(0, 70)}…` : c;
  }
  return "";
}

/** bash timeout, from tools.toml. */
function toolTimeoutMs(config: GnomonConfig): number {
  const declared = (config.tools.tools ?? []).find((t) => t.name === "bash");
  const secs = declared?.timeout_seconds;
  return typeof secs === "number" && secs > 0 ? secs * 1000 : 120_000;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/** What one compaction pass did. */
export interface CompactionResult {
  /** Turns folded into the summary by this pass */
  folded: number;
  /** Estimated tokens the fold reclaimed */
  reclaimed: number;
  /** Set when compaction was needed but could not run */
  problem?: string;
}

const SUMMARY_INSTRUCTION =
  "You are compacting a coding session's history. Rewrite the material below " +
  "as a compact factual record for an agent that will continue this work.\n\n" +
  "Keep: decisions made, files touched, commands run and their outcomes, " +
  "constraints the user stated, and anything still unresolved.\n" +
  "Drop: pleasantries, restated questions, and reasoning that led nowhere.\n\n" +
  "Write plain prose or terse bullets. Do not address the user. Do not offer " +
  "to help. Output only the record.";

/**
 * Fold turns that no longer fit the window into a running summary.
 *
 * Called after a turn completes, not while building a prompt: summarising
 * needs an inference call, and keeping buildMessages synchronous and pure
 * keeps the windowing logic testable without a model.
 *
 * A deliberate trade-off: `discard` and `truncate` are bit-reproducible,
 * because they only ever drop text. `summary` is not — it asks a model what
 * mattered. The surface still determines that summarisation happens and which
 * role does it, but two runs can summarise differently. That is the price of
 * keeping long sessions coherent, and it is why `discard` remains the default.
 */
export async function compactSession(
  state: PromptState,
  systemPrompt: string,
  onNote?: (line: string) => void
): Promise<CompactionResult> {
  const ctx = resolveContext(state.config);
  const wants = ctx.compaction === "summary" || ctx.policy === "summary";
  if (!wants) return { folded: 0, reclaimed: 0 };

  // Build against an empty next input to see what the window sheds.
  const probe = buildMessages(state, systemPrompt, "");
  const pending = probe.evicted.filter((e) => !e.folded);
  if (pending.length === 0) return { folded: 0, reclaimed: 0 };

  const role = ctx.summary_role;
  if (!state.config.roles[role]) {
    return {
      folded: 0,
      reclaimed: 0,
      problem:
        `context.summary_role = "${role}" is not defined in roles.toml, so ` +
        `${pending.length} turn(s) were dropped instead of summarised.`,
    };
  }

  const transcript = pending
    .map((e) => {
      const answer = splitThinking(e.output).answer || e.output;
      const tools = e.tool_log?.length ? `\n  tools: ${e.tool_log.join("; ")}` : "";
      return `--- turn ${e.turn} (${e.role})\nuser: ${e.input}\nassistant: ${answer}${tools}`;
    })
    .join("\n\n");

  // Summarise only the NEW turns and append, rather than re-summarising the
  // existing record every time.
  //
  // Re-folding the whole record on every eviction compounds loss: each pass
  // compresses what the last pass already compressed, so early facts decay
  // across generations the way a repeatedly re-encoded image does. In a stress
  // test that behaviour kept "avoid async-std, use tokio" and lost the
  // project's name. Appending keeps early sections at their first-generation
  // fidelity; the whole record is re-folded only when it grows past
  // retain_after, which is rare.
  const summaryTokens = estimateTokens(state.summary ?? "");
  const refold = summaryTokens > ctx.retain_after;
  const priorSummary =
    state.summary && refold
      ? `Existing record, which has grown too long — fold it together with the ` +
        `new material into one shorter record:\n${state.summary}\n\n`
      : "";

  onNote?.(
    refold
      ? `re-folding the record (${summaryTokens} tok) plus ${pending.length} turn(s) via ${role}…`
      : `compacting ${pending.length} turn(s) via ${role}…`
  );

  const route = routeRole(state.config, role);
  const result = await callEndpoint(
    route.target,
    [
      { role: "system", content: SUMMARY_INSTRUCTION },
      { role: "user", content: `${priorSummary}${transcript}` },
    ],
    [],
    modelTimeoutMs()
  );

  if (result.code !== 0) {
    // Leaving them unfolded means they are simply dropped this turn and
    // retried next — losing them silently would be worse than a slow retry.
    return {
      folded: 0,
      reclaimed: 0,
      problem: `compaction failed (${result.content.slice(0, 80)}); turns left unfolded`,
    };
  }

  const folded_text = splitThinking(result.content).answer.trim();
  if (!folded_text) {
    return { folded: 0, reclaimed: 0, problem: "compaction produced nothing" };
  }
  // Append unless this pass re-folded everything.
  const summary =
    state.summary && !refold ? `${state.summary}\n\n${folded_text}` : folded_text;

  const before = pending.reduce(
    (n, e) => n + estimateTokens(e.input) + estimateTokens(e.output),
    0
  );
  const after = estimateTokens(summary) - estimateTokens(state.summary ?? "");

  state.summary = summary;
  for (const e of pending) e.folded = true;

  return { folded: pending.length, reclaimed: Math.max(0, before - after) };
}

// ---------------------------------------------------------------------------
// Non-interactive execution
// ---------------------------------------------------------------------------

/** One task run, as data. Separated so a caller can compare runs. */
export interface TaskRecord {
  /** Content hash of .gnomon/ — what determined this behaviour */
  surface_hash: string;
  role: string;
  model: string;
  endpoint?: string;
  input: string;
  output: string;
  code: number;
  bucket: string;
  tool_steps: number;
  tool_log: string[];
  skills: string[];
  /**
   * Fields that legitimately differ between two runs of the same task.
   * Kept apart so a comparison can ignore exactly these and nothing else.
   */
  volatile: { duration_ms: number };
}

export interface RunTaskOptions {
  role?: string;
  /** Approve gated tool calls. Without it every gated call is refused. */
  yes?: boolean;
  /** Emit progress lines to stderr */
  verbose?: boolean;
}

/**
 * Run one task without a terminal.
 *
 * This is the invocation a composition layer can put in a runbook: it takes a
 * task, uses only `.gnomon/` for configuration, references nothing outside
 * this repository, and returns a record.
 *
 * Approval is refused by default. A non-interactive run has nobody to ask, and
 * silently granting writes because no one is watching would invert the meaning
 * of `approval = "on_write"`.
 */
export async function runTask(
  config: GnomonConfig,
  input: string,
  options: RunTaskOptions = {}
): Promise<TaskRecord> {
  const routing = resolveRouting(config);
  // suggest needs someone to ask, and a task run has nobody. It falls back to
  // the declared default rather than silently promoting itself to auto.
  const role =
    options.role ??
    (routing.mode === "auto"
      ? routeInput(config, input, routing).role
      : routing.default);

  const state: PromptState = { config, exchanges: [], currentRole: role };
  const ui: ResolvedUi = { ...resolveUi(config), spinner: false, color: false };
  const route = routeRole(config, role);

  const active = selectSkills(loadSkills(config), role, input);
  const systemPrompt = applySkills(config.system.content ?? "", active);
  const built = buildMessages(state, systemPrompt, input);

  const note = (line: string) => {
    if (options.verbose) process.stderr.write(`${line}\n`);
  };

  // A non-interactive run is the one most likely to need a trail: nobody
  // watched it happen.
  const auditSettings = resolveAudit(config);
  const sessionId = `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const audit = new AuditTrail(auditSettings, sessionId);
  const surface_hash = recomputeManifest(config.gnomonDir, "0.1.0").surface_hash;

  audit.write("session_start", {
    surface_hash,
    cwd: process.cwd(),
    mode: "task",
    role,
    record: auditSettings.record,
    approvals: options.yes ? "granted" : "refused",
  });

  const start = Date.now();
  const turn = await runAgenticTurn(state, role, route, built.messages, {
    approve: async (req) => {
      const decision = options.yes ? "approved" : "declined";
      note(`[approval] ${req.summary} — ${decision}`);
      audit.write("approval", {
        tool: req.tool,
        summary: req.summary,
        decision,
        // Recorded honestly: no human saw this. A trail that implied
        // oversight where there was none would be worse than no trail.
        by: options.yes ? "flag:--yes" : "default:no-operator",
        interactive: false,
      });
      return Boolean(options.yes);
    },
    progress: new Progress(ui, process.stderr as NodeJS.WriteStream),
    ui,
    say: note,
    audit,
  });
  const duration = Date.now() - start;

  audit.write("turn", {
    turn: 1,
    role,
    model: turn.model,
    endpoint: route.target.endpoint,
    bucket: mapBucket(turn.code),
    code: turn.code,
    duration_ms: duration,
    tool_steps: turn.toolSteps,
    tool_log: turn.toolLog,
    skills: active.map((sk) => sk.id),
    surface_hash,
    input: audit.text(input),
    output: audit.text(turn.content),
  });
  audit.write("session_end", { turns: 1, surface_hash });

  return {
    surface_hash,
    role,
    model: turn.model,
    endpoint: route.target.endpoint,
    input,
    output: turn.content,
    code: turn.code,
    bucket: mapBucket(turn.code),
    tool_steps: turn.toolSteps,
    tool_log: turn.toolLog,
    skills: active.map((sk) => sk.id),
    volatile: { duration_ms: duration },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** One slash command, as shown by /help and offered by Tab completion. */
export interface CommandSpec {
  name: string;
  arg?: string;
  help: string;
}

/**
 * Every command, in one place.
 *
 * /help renders this and Tab completion offers it, so a command can never be
 * implemented but undiscoverable — typing "/" and Tab is how you find out
 * what exists.
 */
export const COMMANDS: CommandSpec[] = [
  { name: "/roles", help: "List roles and models (marks the current one)" },
  { name: "/role", arg: "<name>", help: "Switch role for the rest of the session" },
  { name: "/mode", arg: "[manual|suggest|auto]", help: "Who picks the role: you, the rules with your confirmation, or the rules" },
  { name: "/skills", help: "Active skills and pending proposals" },
  { name: "/session", help: "This session's id and where it is saved" },
  { name: "/endpoints", help: "List declared inference endpoints" },
  { name: "/profiles", help: "Show available profiles" },
  { name: "/tools", help: "Show the tools this role may call" },
  { name: "/context", help: "Show context policy and the current window" },
  { name: "/reset", help: "Drop conversation history (keeps the session open)" },
  { name: "/meta", arg: "[fields]", help: "Show or set the meta line" },
  { name: "/think", arg: "[mode]", help: "Chain-of-thought: hide | collapse | show" },
  { name: "/manifest", help: "Show manifest command" },
  { name: "/clear", help: "Clear screen (history is kept)" },
  { name: "/help", help: "This list" },
  { name: "/quit", help: "Exit the loop" },
];

/**
 * Tab completion for the prompt.
 *
 * Completes slash commands, and role names after /role. Returns the readline
 * completer shape: [matches, the substring they complete].
 */
export function completeInput(
  line: string,
  roles: string[],
  endpoints: string[] = []
): [string[], string] {
  const roleArg = line.match(/^\/roles?\s+(\S*)$/);
  if (roleArg) {
    const partial = roleArg[1];
    return [roles.filter((r) => r.startsWith(partial)), partial];
  }

  const modeArg = line.match(/^\/mode\s+(\S*)$/);
  if (modeArg) {
    const partial = modeArg[1];
    return [
      ["manual", "suggest", "auto"].filter((m) => m.startsWith(partial)),
      partial,
    ];
  }

  const thinkArg = line.match(/^\/think\s+(\S*)$/);
  if (thinkArg) {
    const partial = thinkArg[1];
    return [
      ["hide", "collapse", "show"].filter((m) => m.startsWith(partial)),
      partial,
    ];
  }

  if (!line.startsWith("/")) return [[], line];

  const names = COMMANDS.map((c) => c.name);
  const hits = names.filter((n) => n.startsWith(line));
  // With nothing after "/", offer everything rather than nothing.
  return [hits.length > 0 ? hits : names, line];
}

// ---------------------------------------------------------------------------
// Command loop
// ---------------------------------------------------------------------------

/** Process a slash command; returns true if command was handled */
export function processCommand(cmd: string, state: PromptState): boolean {
  const parts = cmd.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  switch (command) {
    case "/quit":
    case "/exit":
    case "/q":
      console.log("\nSession complete. See you next turn.");
      process.exit(0);
      return true;

    case "/role":
    case "/roles": {
      const roles = listRoles(state.config);
      const wanted = (parts[1] ?? "").trim();

      // `/roles plan` reads as "switch to plan" to anyone typing it, so make
      // it do that rather than silently re-listing and leaving the role alone.
      if (wanted) {
        if (!roles.includes(wanted)) {
          console.log(`\nNo such role: "${wanted}". Available: ${roles.join(", ")}`);
          return true;
        }
        state.currentRole = wanted;
        const route = routeRole(state.config, wanted);
        const where = route.target.endpoint ? ` @ ${route.target.endpoint}` : "";
        console.log(`\nRole: ${wanted} → ${route.model}${where}`);
        const set = buildToolSet(state.config, wanted);
        console.log(
          `  tools: ${set.schemas.map((t) => t.function.name).join(", ") || "(none — read-only role)"}`
        );
        return true;
      }

      console.log(`\nAvailable roles: ${roles.join(", ")}`);
      for (const r of roles) {
        const roleDef = state.config.roles[r];
        const model = roleDef.model ?? roleDef.profile ?? "local:default";
        const desc = roleDef.description ?? "";
        const here = r === state.currentRole ? " ← current" : "";
        const ep = roleDef.endpoint ? ` @${roleDef.endpoint}` : "";
        const scope = Array.isArray(roleDef.tools)
          ? `  [tools: ${roleDef.tools.join(", ") || "none"}]`
          : "";
        console.log(`  ${r}: ${model}${ep}${desc ? ` — ${desc}` : ""}${scope}${here}`);
      }
      console.log(`\nSwitch with: /role <name>`);
      return true;
    }

    case "/session": {
      const st = resolveSessionStore(state.config);
      console.log(`\nSession: ${sessionIdOf(state)}`);
      console.log(`  turns recorded   ${state.exchanges.length}`);
      console.log(`  persistence      ${st.persist ? st.dir : "off"}`);
      if (st.persist) {
        console.log(`  resume later     gnomon prompt --resume ${sessionIdOf(state)}`);
      } else {
        console.log(`  set [session].persist = true in .gnomon/config.toml to keep it`);
      }
      return true;
    }

    case "/skills": {
      const active = loadSkills(state.config);
      const pending = loadProposedSkills(state.config);
      console.log(`\nActive skills (.gnomon/skills/) — loaded into the prompt:`);
      if (active.length === 0) console.log("  (none)");
      for (const sk of active) {
        const scope = sk.roles ? ` [${sk.roles.join(", ")}]` : "";
        const when = sk.match ? `  when: ${sk.match}` : "  always";
        console.log(`  ${sk.id}${scope} — ${sk.description ?? sk.name}`);
        console.log(`    ${when.trim()}`);
      }
      console.log(`\nProposed (.gnomon/skills/proposed/) — NOT loaded:`);
      if (pending.length === 0) console.log("  (none)");
      for (const sk of pending) {
        console.log(`  ${sk.id} — ${sk.description ?? sk.name}`);
      }
      if (pending.length > 0) {
        console.log(
          `\nAccept with \`gnomon skill accept <id>\`. Accepting changes the ` +
            `surface hash and takes effect next session.`
        );
      }
      return true;
    }

    case "/mode": {
      const routing = routingOf(state);
      const wanted = (parts[1] ?? "").trim();
      if (!wanted) {
        console.log(`\nMode: ${routing.mode}`);
        console.log("  manual  — the current role answers; a prefix routes one turn");
        console.log("  suggest — the rules propose a role and you confirm, per turn");
        console.log("  auto    — the rules pick, and say what they picked");
        console.log("\n  A trust dial: run suggest until the rules stop surprising you.");
        if (routing.rules.length > 0) {
          console.log("\nRules, in priority order:");
          for (const rule of routing.rules) {
            console.log(`  ${rule.role.padEnd(12)} ${rule.match}`);
          }
          console.log(`  ${routing.default.padEnd(12)} (default, when nothing matches)`);
        } else {
          console.log("\nNo [[routing.rules]] declared — auto would always use " +
            `"${routing.default}".`);
        }
        return true;
      }
      if (wanted !== "manual" && wanted !== "suggest" && wanted !== "auto") {
        console.log(`\nUnknown mode: "${wanted}". Use: manual | suggest | auto`);
        return true;
      }
      routing.mode = wanted as RoutingMode;
      console.log(`\nMode: ${routing.mode}`);
      console.log("Session only — edit [routing].mode in .gnomon/config.toml to make it stick.");
      return true;
    }

    case "/tools": {
      const set = buildToolSet(state.config, state.currentRole);
      console.log(`\nTools available to "${state.currentRole}":`);
      for (const t of set.schemas) {
        console.log(`  ${t.function.name} — ${t.function.description}`);
      }
      if (set.schemas.length === 0) {
        console.log("  (none — this role cannot call tools)");
      }
      if (set.withheld.length > 0) {
        console.log(`\n  Withheld from this role: ${set.withheld.join(", ")}`);
      }
      if (set.disabled.length > 0) {
        console.log(`  Disabled in the surface: ${set.disabled.join(", ")}`);
      }
      if (set.unimplemented.length > 0) {
        console.log(`  Declared but unimplemented: ${set.unimplemented.join(", ")}`);
      }
      return true;
    }

    case "/endpoints": {
      console.log("\nDeclared endpoints (.gnomon/config.toml [endpoints]):");
      for (const name of listEndpoints(state.config)) {
        const ep = resolveEndpoint(state.config, name);
        const key = ep.api_key_env ? `  key: $${ep.api_key_env}` : "";
        console.log(`  ${name}: ${ep.url}  [${ep.kind ?? "ollama"}]${key}`);
      }
      console.log("\nRoles select one with `endpoint = \"<name>\"` in roles.toml.");
      return true;
    }

    case "/profiles":
      const profiles = listProfiles(state.config);
      console.log(`\nAvailable profiles: ${profiles.join(", ")}`);
      return true;

    case "/meta": {
      const ui = uiOf(state);
      const arg = parts.slice(1).join(" ").trim();
      if (!arg) {
        console.log(`\nMeta shown after each answer: ${ui.meta.join(", ") || "(none)"}`);
        console.log(`Style: ${ui.meta_style}`);
        console.log(`Available: ${META_FIELDS.join(", ")}`);
        console.log(`Set with: /meta turn,model,duration   ·   /meta all   ·   /meta none`);
        console.log(`Style with: /meta style compact | line`);
        return true;
      }
      if (arg === "all") {
        ui.meta = [...META_FIELDS];
      } else if (arg === "none") {
        ui.meta = [];
      } else if (arg.startsWith("style")) {
        const style = arg.slice("style".length).trim();
        if (style === "line" || style === "compact") {
          ui.meta_style = style;
        } else {
          console.log(`\nUnknown meta style: "${style}". Use: line | compact`);
          return true;
        }
      } else {
        const { fields, unknown } = parseMetaFields(arg.split(/[\s,]+/));
        if (unknown.length > 0) {
          console.log(`\nNot meta fields: ${unknown.join(", ")}`);
          console.log(`Available: ${META_FIELDS.join(", ")}`);
          return true;
        }
        ui.meta = fields;
      }
      console.log(`\nMeta: ${ui.meta.join(", ") || "(none)"} (${ui.meta_style})`);
      console.log(`Session only — edit [ui] in .gnomon/config.toml to make it stick.`);
      return true;
    }

    case "/think": {
      const ui = uiOf(state);
      const mode = (parts[1] ?? "").trim();
      if (!mode) {
        console.log(`\nChain-of-thought: ${ui.think}`);
        console.log(`  hide      — drop reasoning entirely`);
        console.log(`  collapse  — one line, so you see it happened`);
        console.log(`  show      — full reasoning block`);
        return true;
      }
      if (mode !== "hide" && mode !== "collapse" && mode !== "show") {
        console.log(`\nUnknown mode: "${mode}". Use: hide | collapse | show`);
        return true;
      }
      ui.think = mode;
      console.log(`\nChain-of-thought: ${ui.think}`);
      console.log(`Session only — edit [ui].think in .gnomon/config.toml to make it stick.`);
      return true;
    }

    case "/context": {
      const ctx = resolveContext(state.config);
      const built = buildMessages(state, state.config.system.content ?? "", "");
      console.log(`\nContext policy (from .gnomon/config.toml):`);
      console.log(`  policy             ${ctx.policy}`);
      console.log(`  retain_after       ${ctx.retain_after} tok`);
      console.log(`  max_context_tokens ${ctx.max_context_tokens} tok`);
      console.log(`  compaction         ${ctx.compaction}`);
      console.log(`\nCurrent window:`);
      console.log(`  turns recorded     ${state.exchanges.length}`);
      console.log(`  turns carried      ${built.included}`);
      console.log(`  turns dropped      ${built.dropped}`);
      console.log(`  estimated tokens   ~${built.tokens} / ${ctx.max_context_tokens}`);
      const folded = state.exchanges.filter((e) => e.folded).length;
      if (folded > 0 || state.summary) {
        console.log(`  turns folded       ${folded} (in the summary)`);
        console.log(`  summary size       ~${estimateTokens(state.summary ?? "")} tok`);
      }
      if (ctx.compaction === "summary" || ctx.policy === "summary") {
        console.log(`  summary_role       ${ctx.summary_role}`);
      }
      if (built.notice) console.log(`  notice             ${built.notice}`);
      return true;
    }

    case "/reset": {
      const n = state.exchanges.length;
      const hadSummary = Boolean(state.summary);
      state.exchanges.length = 0;
      state.summary = undefined;
      console.log(
        `\nHistory cleared (${n} turn(s)${hadSummary ? " and the summary" : ""} dropped). ` +
          `Surface unchanged.`
      );
      return true;
    }

    case "/manifest":
      console.log("\nUse: gnomon surface manifest");
      return true;

    case "/help": {
      console.log("\nCommands  (press Tab after \"/\" to complete)\n");
      const width = Math.max(
        ...COMMANDS.map((c) => `${c.name} ${c.arg ?? ""}`.trimEnd().length)
      );
      for (const c of COMMANDS) {
        const label = `${c.name}${c.arg ? ` ${c.arg}` : ""}`;
        console.log(`  ${label.padEnd(width)}  — ${c.help}`);
      }
      console.log(`

Input is automatically routed to a role based on prefix:
  /plan "..."      → plan role
  /implement "..." → implement role
  /critique "..."  → critique role
  /smol "..."      → smol role
  "..."            → current role (default: implement)

A role prefix applies to that one turn only; /role switches for good.

/meta and /think change this session only. Defaults live in
[ui] in .gnomon/config.toml, so every checkout renders the same.
`);
      return true;
    }

    case "/clear":
      process.stdout.write("\x1Bc");
      return true;

    default:
      return false;
  }
}

/**
 * Run the interactive prompt loop.
 *
 * Reads user input from stdin, infers role, calls model API,
 * displays results.
 */
export interface PromptLoopOptions {
  /** Resume a saved session: an id, or true for the most recent */
  resume?: string | true;
}

export async function runPromptLoop(
  config: GnomonConfig,
  initialRole?: string,
  options: PromptLoopOptions = {}
): Promise<void> {
  const state: PromptState = {
    config,
    exchanges: [],
    currentRole: initialRole ?? "implement",
  };

  const store = resolveSessionStore(config);
  const startedAt = new Date().toISOString();
  let sessionId = `${startedAt.replace(/[:.]/g, "-")}-${process.pid}`;
  let resumedFrom: SessionSnapshot | null = null;
  state.sessionId = sessionId;

  if (options.resume) {
    try {
      const snap = loadSession(store, options.resume === true ? undefined : options.resume);
      state.exchanges = snap.exchanges ?? [];
      state.summary = snap.summary;
      state.currentRole = initialRole ?? snap.currentRole ?? state.currentRole;
      sessionId = snap.id;
      state.sessionId = sessionId;
      resumedFrom = snap;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // Tab after "/" lists every command, so they are discoverable from the
    // prompt rather than only from the docs.
    completer: (line: string) =>
      completeInput(line, listRoles(config), listEndpoints(config)),
  });

  // Off unless the surface asks for it.
  const auditSettings = resolveAudit(config);
  // One id for the session, so a trail and its snapshot name the same run.
  const audit = new AuditTrail(auditSettings, sessionId);
  const surfaceHash = (() => {
    try {
      return recomputeManifest(config.gnomonDir, "0.1.0").surface_hash;
    } catch {
      return "";
    }
  })();
  audit.write("session_start", {
    surface_hash: surfaceHash,
    cwd: process.cwd(),
    roles: listRoles(config),
    record: auditSettings.record,
  });

  const persist = (): void => {
    if (!store.persist) return;
    try {
      saveSession(store, {
        format: SESSION_FORMAT,
        id: sessionId,
        started: resumedFrom?.started ?? startedAt,
        updated: new Date().toISOString(),
        surface_hash: surfaceHash,
        cwd: process.cwd(),
        currentRole: state.currentRole,
        summary: state.summary,
        exchanges: state.exchanges,
      });
    } catch (err) {
      // Losing a snapshot must not lose the turn that produced it.
      console.log(
        paint(uiOf(state), "yellow", `  [session] could not save: ${
          err instanceof Error ? err.message : String(err)
        }`)
      );
    }
  };

  printBanner();
  console.log(`Role: ${state.currentRole}`);
  console.log(`Model: ${routeRole(config, state.currentRole).model}`);
  console.log("");

  // Line-driven input with a queue: anything typed while the model is
  // thinking is buffered and processed in order instead of being dropped.
  let closed = false;
  const lineQueue: string[] = [];
  let notify: ((line: string | null) => void) | null = null;

  rl.on("line", (line: string) => {
    if (notify) {
      const n = notify;
      notify = null;
      n(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (notify) {
      const n = notify;
      notify = null;
      n(null);
    }
  });

  const readLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      if (lineQueue.length > 0) {
        resolve(lineQueue.shift() ?? null);
        return;
      }
      if (closed) {
        resolve(null);
        return;
      }
      notify = resolve;
    });

  // Esc cancels the turn in flight. Only a turn — at the prompt it does
  // nothing, so a stray Esc cannot end the session. Ctrl+C does the same
  // mid-turn and only exits when nothing is running.
  let cancelTurn: (() => void) | null = null;
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", (_chunk, key) => {
      if (key && key.name === "escape" && cancelTurn) cancelTurn();
    });
  }
  rl.on("SIGINT", () => {
    if (cancelTurn) {
      cancelTurn();
      return;
    }
    console.log("\nSession complete. See you next turn.");
    process.exit(0);
  });

  /**
   * Ask whether to take a suggested role.
   *
   * Declining is the cheap answer, so `n` is the default: a nudge you ignore
   * should cost one keystroke. "always" switches the session role, which is
   * how `suggest` becomes `auto` for the rules you have come to trust.
   */
  const suggestRole = async (
    from: string,
    to: string,
    why: string
  ): Promise<"once" | "always" | "no"> => {
    const ui = uiOf(state);
    console.log("");
    console.log(
      paint(ui, "cyan", `  ⇢ suggest: ${from} → ${to}`) +
        paint(ui, "gray", `  (${why})`)
    );
    const toolNames = buildToolSet(config, to)
      .schemas.map((t) => t.function.name)
      .join(", ");
    console.log(paint(ui, "gray", `    ${to} can use: ${toolNames || "(no tools)"}`));
    console.log(
      paint(ui, "yellow", `  └ [y]es once · [a]lways · [N]o  (Enter keeps ${from})`)
    );

    // Typed-ahead lines were meant as messages, not as an answer to a
    // question that had not appeared yet.
    const held = lineQueue.splice(0, lineQueue.length);
    rl.setPrompt("role> ");
    rl.prompt();
    const answer = ((await readLine()) ?? "").trim().toLowerCase();
    lineQueue.unshift(...held);

    if (/^(a|always)$/.test(answer)) {
      console.log(paint(ui, "green", `  switched to ${to} for the session`));
      return "always";
    }
    if (/^(y|yes)$/.test(answer)) {
      console.log(paint(ui, "green", `  ${to} for this turn`));
      return "once";
    }
    console.log(paint(ui, "gray", `  staying on ${from}`));
    return "no";
  };

  // Approval gate. Reads from the same queue the loop uses, so a decision
  // typed while a tool is pending is picked up in order.
  const approve = async (req: ApprovalRequest): Promise<boolean> => {
    const ui = uiOf(state);
    console.log("");
    console.log(paint(ui, "yellow", `  ┌ approve: ${req.summary}`));
    for (const line of req.preview.slice(0, 60)) {
      const colour = line.startsWith("+ ")
        ? "green"
        : line.startsWith("- ")
          ? "red"
          : "gray";
      console.log(paint(ui, colour, `  │ ${line}`));
    }
    if (req.preview.length > 60) {
      console.log(paint(ui, "gray", `  │ … ${req.preview.length - 60} more lines`));
    }
    console.log(paint(ui, "yellow", "  └ [y]es / [N]o"));

    // On a TTY, anything already typed was meant as a message, not as an
    // answer to a prompt the user had not yet seen — hold it and replay it.
    // On a pipe the opposite is true: the script's next line IS the answer,
    // and holding it would silently decline every gated call.
    const held = process.stdin.isTTY
      ? lineQueue.splice(0, lineQueue.length)
      : [];
    if (held.length > 0) {
      console.log(
        paint(ui, "gray", `  (holding ${held.length} typed-ahead line(s))`)
      );
    }

    let yes = false;
    for (let attempt = 0; ; attempt++) {
      rl.setPrompt("approve> ");
      rl.prompt();
      const answer = ((await readLine()) ?? "").trim();

      if (/^(y|yes)$/i.test(answer)) {
        yes = true;
        break;
      }
      if (/^(n|no)$/i.test(answer) || answer === "") {
        yes = false;
        break;
      }
      // Unrecognised input used to count as "no", so a stray keystroke
      // silently refused the call. Ask again instead of guessing.
      if (!process.stdin.isTTY || attempt >= 2) {
        console.log(paint(ui, "yellow", "  unrecognised — treating as no"));
        yes = false;
        break;
      }
      console.log(paint(ui, "yellow", `  answer y or n (got "${answer}")`));
    }

    lineQueue.unshift(...held);
    audit.write("approval", {
      tool: req.tool,
      summary: req.summary,
      decision: yes ? "approved" : "declined",
      by: "human",
      interactive: Boolean(process.stdin.isTTY),
    });
    console.log(
      yes
        ? paint(ui, "green", "  approved")
        : paint(ui, "yellow", "  declined")
    );
    return yes;
  };

  // Name what the surface declares but cannot offer, rather than quietly
  // shipping a shorter tool list.
  const reportTools = (): void => {
    const ui = uiOf(state);
    const toolSet = buildToolSet(config, state.currentRole);
    const names = toolSet.schemas.map((t) => t.function.name);
    console.log(
      paint(ui, "gray", `Tools (${state.currentRole}): ${names.join(", ") || "(none)"}`)
    );
    if (toolSet.withheld.length > 0) {
      console.log(
        paint(
          ui,
          "gray",
          `  not for this role: ${toolSet.withheld.join(", ")}`
        )
      );
    }
    if (toolSet.disabled.length > 0) {
      console.log(
        paint(ui, "yellow", `  disabled in surface: ${toolSet.disabled.join(", ")}`)
      );
    }
    if (toolSet.unimplemented.length > 0) {
      console.log(
        paint(
          ui,
          "yellow",
          `  declared but not implemented by this build: ${toolSet.unimplemented.join(", ")}`
        )
      );
    }
    if (toolSet.mcp_declared.length > 0) {
      console.log(
        paint(
          ui,
          "yellow",
          `  MCP servers declared but NOT connected by this build: ${toolSet.mcp_declared.join(", ")}`
        )
      );
      console.log(
        paint(ui, "yellow", `  their tools are unavailable — nothing reads [mcp_servers] yet.`)
      );
    }
  };

  {
    const ui = uiOf(state);
    reportTools();

    // A machine-scoped route must never take effect silently.
    if (process.env.GNOMON_MODEL_URL) {
      console.log(
        paint(
          ui,
          "yellow",
          `  note: GNOMON_MODEL_URL overrides the surface's endpoint → ${process.env.GNOMON_MODEL_URL}`
        )
      );
    }
    if (resumedFrom) {
    const ui0 = uiOf(state);
    console.log(
      paint(
        ui0,
        "cyan",
        `Resumed ${sessionId} — ${state.exchanges.length} turn(s)` +
          (state.summary ? " and a summary" : "")
      )
    );
    // Behaviour comes from the surface, not the snapshot. If the surface moved,
    // the replayed history was produced under different rules; say so rather
    // than carrying it forward silently.
    if (resumedFrom.surface_hash && surfaceHash && resumedFrom.surface_hash !== surfaceHash) {
      console.log(
        paint(
          ui0,
          "yellow",
          `  the surface changed since this session ran: ` +
            `${resumedFrom.surface_hash.slice(0, 12)} → ${surfaceHash.slice(0, 12)}`
        )
      );
      console.log(
        paint(ui0, "yellow", `  the replayed history was produced under the older one.`)
      );
    }
    audit.write("session_resume", {
      resumed: sessionId,
      turns: state.exchanges.length,
      surface_hash: surfaceHash,
      surface_hash_at_save: resumedFrom.surface_hash,
      surface_changed: resumedFrom.surface_hash !== surfaceHash,
    });
  }

  if (audit.enabled) {
      console.log(
        paint(ui, "gray", `Audit: ${audit.path}  (${auditSettings.record}${auditSettings.chain ? ", hash-chained" : ""})`)
      );
      if (auditSettings.invalid_redact.length > 0) {
        // Fails open: whatever these were meant to scrub would be written.
        console.log(
          paint(
            ui,
            "red",
            `  WARNING: ${auditSettings.invalid_redact.length} redaction pattern(s) do not compile ` +
              `and are NOT being applied: ${auditSettings.invalid_redact.join(", ")}`
          )
        );
        if (auditSettings.record === "full") {
          console.log(
            paint(ui, "red", "  Recording is set to \"full\", so unredacted text is being written.")
          );
        }
      }
    }
    const policy = config.policy ?? {};
    const sandboxLevel =
      (policy.sandbox as { level?: string } | undefined)?.level ??
      config.config.defaults?.sandbox ??
      "confined";
    const networkDeclared =
      (policy.sandbox as { network?: boolean } | undefined)?.network;
    if (sandboxLevel !== "off" && networkDeclared === false) {
      console.log(
        paint(
          ui,
          "yellow",
          "  note: policy.toml declares network = false; this build confines " +
            "filesystem paths but does not enforce network isolation."
        )
      );
    }
    console.log("");
  }

  try {
    while (true) {
      // Show the prompt only when actually waiting on the user —
      // buffered (typed-ahead) lines replay silently instead.
      if (!closed && lineQueue.length === 0) {
        rl.setPrompt(`${state.currentRole} ▸ `);
        rl.prompt();
      }
      const input = await readLine();
      if (input === null) {
        audit.write("session_end", {
          turns: state.exchanges.length,
          surface_hash: surfaceHash,
        });
        console.log("\nSession complete. See you next turn.");
        break;
      }

      // Handle slash commands
      if (input.startsWith("/")) {
        if (processCommand(input, state)) {
          continue;
        }
        // A role prefix (`/plan do the thing`) is a real turn. Anything else
        // starting with "/" is a mistyped command: sending it to the model
        // burned a slow turn on a typo like "/helpo".
        const roleNames = listRoles(config);
        const isRoleTurn = roleNames.some((r) => input.startsWith(`/${r} `));
        if (!isRoleTurn) {
          const typed = input.slice(1).split(/\s+/)[0];
          const known = [
            "help", "roles", "role", "profiles", "context", "reset",
            "meta", "think", "manifest", "clear", "quit",
          ];
          const near = known.filter(
            (k) => k.startsWith(typed.slice(0, 3)) || typed.startsWith(k.slice(0, 3))
          );
          const ui0 = uiOf(state);
          console.log(
            paint(ui0, "yellow", `\nUnknown command: /${typed}`) +
              (near.length ? paint(ui0, "gray", `  did you mean /${near.join(", /")} ?`) : "")
          );
          console.log(paint(ui0, "gray", "/help lists everything."));
          console.log(
            paint(
              ui0,
              "gray",
              `To send this to the model, drop the leading slash.`
            )
          );
          continue;
        }
      }

      // A role prefix routes THIS turn only. It used to overwrite
      // state.currentRole, so one `/smol ...` silently pinned every later
      // turn to smol with no way back — use /role to switch for real.
      let role = state.currentRole;
      let cleanedInput = input;
      let prefixed = false;

      for (const candidate of listRoles(config)) {
        const prefix = `/${candidate} `;
        if (input.startsWith(prefix)) {
          role = candidate;
          cleanedInput = input.slice(prefix.length);
          prefixed = true;
          break;
        }
      }

      const uiEarly = uiOf(state);
      const routing = routingOf(state);

      // The surface's rules choose in auto, propose in suggest. An explicit
      // prefix always wins in either: asking for a role and being overruled
      // would be worse than not having the mode at all.
      if (routing.mode !== "manual" && !prefixed) {
        const decision = routeInput(config, cleanedInput, routing);
        if (decision.problem) {
          console.log(
            paint(uiEarly, "yellow", `  [routing] ${decision.problem}`)
          );
        }

        const why = decision.rule
          ? decision.rule.why ?? decision.rule.match
          : "no rule matched — the default";

        if (decision.role !== role) {
          if (routing.mode === "auto") {
            console.log(
              paint(uiEarly, "cyan", `  ⇢ auto: ${role} → ${decision.role}`) +
                paint(uiEarly, "gray", `  (${why})`)
            );
            role = decision.role;
          } else {
            // suggest: ask. A non-TTY has nobody to ask, so it keeps the
            // current role and says what it would have proposed — a scripted
            // run must not depend on an answer nobody can give.
            if (!process.stdin.isTTY) {
              console.log(
                paint(
                  uiEarly,
                  "gray",
                  `  ⇢ would suggest ${decision.role} (${why}) — not interactive, staying on ${role}`
                )
              );
            } else {
              const accepted = await suggestRole(role, decision.role, why);
              if (accepted === "once") {
                role = decision.role;
              } else if (accepted === "always") {
                role = decision.role;
                state.currentRole = decision.role;
                console.log(
                  paint(uiEarly, "gray", `  session role is now ${decision.role}`)
                );
              }
            }
          }
        }
      }

      const route = routeRole(config, role);

      const ui = uiOf(state);

      // Skills that apply to this role and input join the system prompt.
      // Selection is by declared pattern, not model judgement, so the same
      // input loads the same skills on every machine.
      const active = selectSkills(loadSkills(config), role, cleanedInput);
      if (active.length > 0) {
        console.log(
          paint(
            uiEarly,
            "gray",
            `  [skills] ${active.map((sk) => sk.name).join(", ")}`
          )
        );
      }
      const systemPrompt = applySkills(config.system.content ?? "", active);

      // Build the window from prior turns before calling.
      const built = buildMessages(state, systemPrompt, cleanedInput);
      if (built.notice) {
        console.log(paint(ui, "yellow", `  [context] ${built.notice}`));
      }
      if (built.dropped > 0) {
        console.log(
          paint(
            ui,
            "gray",
            `  [context] ${built.dropped} earlier turn(s) did not fit the window`
          )
        );
      }

      // Run the turn: model, tools, approvals, until it answers in prose.
      const progress = new Progress(ui);
      const carried =
        built.included > 0 ? ` · ${built.included} turn(s) of context` : "";
      progress.start(
        state.exchanges.length === 0
          ? `${route.model} — loading model${carried}`
          : `${route.model}${carried}`
      );

      const start = Date.now();
      const controller = new AbortController();
      cancelTurn = () => controller.abort();
      let turn: TurnResult;
      try {
        turn = await runAgenticTurn(state, role, route, built.messages, {
          approve,
          progress,
          ui,
          say: (line) => console.log(line),
          signal: controller.signal,
          audit,
        });
      } finally {
        cancelTurn = null;
      }
      progress.stop();
      const duration = Date.now() - start;

      if (turn.content === CANCELLED) {
        console.log(paint(ui, "yellow", "  ⚠ cancelled"));
      }

      const exchange: PromptExchange = {
        turn: state.exchanges.length + 1,
        role,
        input: cleanedInput,
        output: turn.content,
        model: turn.model,
        code: turn.code,
        bucket: mapBucket(turn.code),
        duration_ms: duration,
        context_turns: built.included,
        context_dropped: built.dropped,
        context_tokens: built.tokens,
        tool_steps: turn.toolSteps,
        tool_log: turn.toolLog,
      };

      state.exchanges.push(exchange);
      persist();
      audit.write("turn", {
        turn: exchange.turn,
        role,
        model: exchange.model,
        endpoint: route.target.endpoint,
        bucket: exchange.bucket,
        code: exchange.code,
        duration_ms: duration,
        tool_steps: exchange.tool_steps,
        tool_log: exchange.tool_log,
        skills: active.map((sk) => sk.id),
        context_turns: built.included,
        context_dropped: built.dropped,
        context_tokens: built.tokens,
        surface_hash: surfaceHash,
        input: audit.text(cleanedInput),
        output: audit.text(turn.content),
      });
      printExchange(exchange, ui);

      // Fold anything the window has shed. After the turn, not during it, so
      // the cost lands between turns rather than inside one.
      const compacted = await compactSession(state, systemPrompt, (line) =>
        console.log(paint(ui, "gray", `  [context] ${line}`))
      );
      if (compacted.problem) {
        console.log(paint(ui, "yellow", `  [context] ${compacted.problem}`));
      } else if (compacted.folded > 0) {
        console.log(
          paint(
            ui,
            "gray",
            `  [context] folded ${compacted.folded} turn(s), reclaimed ~${compacted.reclaimed} tok`
          )
        );
        // The summary and the folded flags are part of the conversation now.
        persist();
      }
    }
  } finally {
    rl.close();
  }
}

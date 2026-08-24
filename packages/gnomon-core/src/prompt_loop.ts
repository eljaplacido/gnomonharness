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
  resolveUi,
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
}

/** State for the interactive prompt loop */
export interface PromptState {
  config: GnomonConfig;
  exchanges: PromptExchange[];
  currentRole: string;
  /** Resolved `[ui]`; /meta and /think edit this copy for the session only */
  ui?: ResolvedUi;
}

/** The session's UI settings, resolving from the surface on first use. */
function uiOf(state: PromptState): ResolvedUi {
  if (!state.ui) state.ui = resolveUi(state.config);
  return state.ui;
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

  const usable = state.exchanges.filter((e) => e.code === 0);
  const budget = Math.max(
    0,
    ctx.max_context_tokens -
      estimateTokens(systemPrompt) -
      estimateTokens(input)
  );

  // "summary" would need a second inference per turn through the smol role.
  // Not built. Name it rather than quietly substituting something else.
  if (ctx.policy === "summary") {
    notice =
      'context.policy = "summary" is not implemented in this build — ' +
      "using sliding_window.";
  }

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
    const compaction =
      ctx.compaction === "summary" ? "discard" : ctx.compaction;
    if (ctx.compaction === "summary" && !notice) {
      notice =
        'defaults.compaction = "summary" is not implemented in this build — ' +
        "using discard.";
    }
    messages.push({
      role: "system",
      content:
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
          : `[gnomon context] ${dropped.length} earlier turn(s) dropped to fit ` +
            `the window (policy=${ctx.policy}, compaction=discard).`,
    });
  }

  tail.forEach(replay);
  messages.push({ role: "user", content: input });

  return {
    messages,
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
  timeoutMs: number
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
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // The published table separates these, and a consumer that only ever sees
      // 10 cannot tell a box that is down from a window that is full.
      const body = await res.text().catch(() => "");
      const code = /context (length|window)|maximum context|too many tokens/i.test(body)
        ? 13
        : res.status === 408 || res.status === 504
          ? 11
          : 12;
      return {
        content: `Model API error: ${res.status} ${res.statusText}`,
        code,
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
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    // 11 timed_out, 12 provider_unreachable. `10 launch_failed` is for a process
    // that never started, which is not what a fetch reports.
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      content: timedOut
        ? `Model timed out after ${timeoutMs}ms at ${target.url}`
        : `Model unavailable at ${target.url}: ${msg}`,
      code: timedOut ? 11 : 12,
      toolCalls: [],
    };
  }
}

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
  console.log("/context for the window · /reset to drop history");
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
  /**
   * Called once per model attempt, primary and declared fallback alike.
   *
   * The turn reports one worst-outcome code, which is right for a person reading a
   * transcript and wrong for a record: a primary that timed out and a fallback that
   * answered are two attempts with two buckets, and a session that only worked on
   * the second try is a finding only if the first try survives somewhere.
   */
  onAttempt?: (attempt: {
    attempt: number;
    model: string;
    code: number;
    duration_ms: number;
  }) => void;
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
  route: ReturnType<typeof routeRole>,
  messages: ChatMessage[],
  deps: TurnDeps
): Promise<TurnResult> {
  const config = state.config;
  const toolSet = buildToolSet(config);
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
    root: resolve(config.gnomonDir, ".."),
    sandbox,
    gate,
    approve: deps.approve,
    timeoutMs: toolTimeoutMs(config),
    maxOutputBytes: 32_000,
  };

  const roleDef = config.roles[state.currentRole] ?? {};
  const maxSteps = typeof roleDef.max_steps === "number" ? roleDef.max_steps : 12;

  const working: ChatMessage[] = [...messages];
  const toolLog: string[] = [];
  let code = 0;
  let steps = 0;
  let attempts = 0;
  let usedModel = route.model;

  for (;;) {
    let attemptStart = Date.now();
    let result = await callEndpoint(
      route.target,
      working,
      toolSet.schemas,
      modelTimeoutMs()
    );
    usedModel = route.model;
    attempts += 1;
    deps.onAttempt?.({
      attempt: attempts,
      model: route.model,
      code: result.code,
      duration_ms: Date.now() - attemptStart,
    });

    if (result.code !== 0 && route.fallback) {
      deps.progress.update(
        `${route.fallback.model} — primary unavailable, falling back`
      );
      usedModel = route.fallback.model;
      attemptStart = Date.now();
      result = await callEndpoint(
        route.fallback,
        working,
        toolSet.schemas,
        modelTimeoutMs()
      );
      attempts += 1;
      deps.onAttempt?.({
        attempt: attempts,
        model: route.fallback.model,
        code: result.code,
        duration_ms: Date.now() - attemptStart,
      });
    }

    code = worse(code, result.code);

    if (result.code !== 0 || result.toolCalls.length === 0) {
      return { content: result.content, code, model: usedModel, toolSteps: steps, toolLog };
    }

    if (steps + result.toolCalls.length > maxSteps) {
      const note =
        `Stopped: this turn reached max_steps (${maxSteps}) for role ` +
        `"${state.currentRole}". ${steps} tool call(s) ran.`;
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

    case "/roles":
      const roles = listRoles(state.config);
      console.log(`\nAvailable roles: ${roles.join(", ")}`);
      for (const r of roles) {
        const roleDef = state.config.roles[r];
        const model = roleDef.model ?? roleDef.profile ?? "local:default";
        const desc = roleDef.description ?? "";
        console.log(`  ${r}: ${model}${desc ? ` — ${desc}` : ""}`);
      }
      return true;

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
      if (built.notice) console.log(`  notice             ${built.notice}`);
      return true;
    }

    case "/reset": {
      const n = state.exchanges.length;
      state.exchanges.length = 0;
      console.log(`\nHistory cleared (${n} turn(s) dropped). Surface unchanged.`);
      return true;
    }

    case "/manifest":
      console.log("\nUse: gnomon surface manifest");
      return true;

    case "/help":
      console.log(`\nCommands:
  /roles           — Show available roles and models
  /profiles        — Show available profiles
  /context         — Show context policy and the current window
  /reset           — Drop conversation history (keeps the session open)
  /meta [fields]   — Show or set the meta line (/meta all, /meta none,
                     /meta turn,model,duration, /meta style compact)
  /think [mode]    — Chain-of-thought: hide | collapse | show
  /manifest        — Show manifest command
  /clear           — Clear screen (history is kept)
  /help            — This list
  /quit            — Exit the loop

Input is automatically routed to a role based on prefix:
  /plan "..."      → plan role
  /implement "..." → implement role
  /critique "..."  → critique role
  /smol "..."      → smol role
  "..."            → current role (default: implement)

/meta and /think change this session only. Defaults live in
[ui] in .gnomon/config.toml, so every checkout renders the same.
`);
      return true;

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
export async function runPromptLoop(
  config: GnomonConfig,
  initialRole?: string
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const state: PromptState = {
    config,
    exchanges: [],
    currentRole: initialRole ?? "implement",
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
    rl.setPrompt("approve> ");
    rl.prompt();
    const answer = (await readLine()) ?? "";
    const yes = /^(y|yes)$/i.test(answer.trim());
    console.log(
      yes
        ? paint(ui, "green", "  approved")
        : paint(ui, "yellow", "  declined")
    );
    return yes;
  };

  // Name what the surface declares but cannot offer, rather than quietly
  // shipping a shorter tool list.
  {
    const ui = uiOf(state);
    const toolSet = buildToolSet(config);
    const names = toolSet.schemas.map((t) => t.function.name);
    console.log(
      paint(ui, "gray", `Tools: ${names.join(", ") || "(none)"}`)
    );
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
        rl.setPrompt("gnomon> ");
        rl.prompt();
      }
      const input = await readLine();
      if (input === null) {
        console.log("\nSession complete. See you next turn.");
        break;
      }

      // Handle slash commands
      if (input.startsWith("/")) {
        if (processCommand(input, state)) {
          continue;
        }
        // Unknown slash command — fall through to inference
      }

      // Infer role from input prefix
      let role = state.currentRole;
      let cleanedInput = input;

      if (input.startsWith("/plan ")) {
        role = "plan";
        cleanedInput = input.slice("/plan ".length);
      } else if (input.startsWith("/implement ")) {
        role = "implement";
        cleanedInput = input.slice("/implement ".length);
      } else if (input.startsWith("/critique ")) {
        role = "critique";
        cleanedInput = input.slice("/critique ".length);
      } else if (input.startsWith("/smol ")) {
        role = "smol";
        cleanedInput = input.slice("/smol ".length);
      }

      state.currentRole = role;
      const route = routeRole(config, role);

      const ui = uiOf(state);

      // Build the window from prior turns before calling.
      const built = buildMessages(state, config.system.content ?? "", cleanedInput);
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
      const turn = await runAgenticTurn(state, route, built.messages, {
        approve,
        progress,
        ui,
        say: (line) => console.log(line),
      });
      progress.stop();
      const duration = Date.now() - start;

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
      printExchange(exchange, ui);
    }
  } finally {
    rl.close();
  }
}

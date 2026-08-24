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
  resolveEndpoint,
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
  console.log("Esc cancels the turn in progress.");
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
export async function runPromptLoop(
  config: GnomonConfig,
  initialRole?: string
): Promise<void> {
  const state: PromptState = {
    config,
    exchanges: [],
    currentRole: initialRole ?? "implement",
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // Tab after "/" lists every command, so they are discoverable from the
    // prompt rather than only from the docs.
    completer: (line: string) =>
      completeInput(line, listRoles(config), listEndpoints(config)),
  });

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

    // Anything typed before this prompt appeared was meant as a message, not
    // as an answer to a question the user had not yet seen. Hold it aside and
    // replay it afterwards rather than letting it decide the approval.
    const held = lineQueue.splice(0, lineQueue.length);
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

      for (const candidate of listRoles(config)) {
        const prefix = `/${candidate} `;
        if (input.startsWith(prefix)) {
          role = candidate;
          cleanedInput = input.slice(prefix.length);
          break;
        }
      }

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
      printExchange(exchange, ui);
    }
  } finally {
    rl.close();
  }
}

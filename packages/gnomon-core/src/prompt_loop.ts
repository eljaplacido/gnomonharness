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
  role: "system" | "user" | "assistant";
  content: string;
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
  timeoutMs: number
): Promise<InferenceResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Sampling params go top-level (OpenAI shape); Ollama reads the
  // nested `options` object — send both so either backend is happy.
  const payload = {
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

  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return {
        content: `Model API error: ${res.status} ${res.statusText}`,
        code: 10,
      };
    }

    const json = await res.json();
    const content =
      json.choices?.[0]?.message?.content ??
      json.message?.content ??
      json.response ??
      "";
    return { content, code: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Model unavailable at ${target.url}: ${msg}`,
      code: 10,
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

      // Call model — primary first, declared fallback on failure
      const progress = new Progress(ui);
      const carried =
        built.included > 0 ? ` · ${built.included} turn(s) of context` : "";
      progress.start(
        state.exchanges.length === 0
          ? `${route.model} — loading model${carried}`
          : `${route.model}${carried}`
      );

      const start = Date.now();
      let result = await callEndpoint(route.target, built.messages, modelTimeoutMs());
      let usedModel = route.model;

      if (result.code !== 0 && route.fallback) {
        progress.update(`${route.fallback.model} — primary unavailable, falling back`);
        usedModel = route.fallback.model;
        result = await callEndpoint(
          route.fallback,
          built.messages,
          modelTimeoutMs()
        );
      }
      progress.stop();
      const duration = Date.now() - start;

      // Map outcome
      const bucket = result.code === 0
        ? "result"
        : result.code === 1
          ? "refusal"
          : "apparatus_failure";

      const exchange: PromptExchange = {
        turn: state.exchanges.length + 1,
        role,
        input: cleanedInput,
        output: result.content,
        model: usedModel,
        code: result.code,
        bucket,
        duration_ms: duration,
        context_turns: built.included,
        context_dropped: built.dropped,
        context_tokens: built.tokens,
      };

      state.exchanges.push(exchange);
      printExchange(exchange, ui);
    }
  } finally {
    rl.close();
  }
}

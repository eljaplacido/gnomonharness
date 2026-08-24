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
import { GnomonConfig, RouteTarget, routeRole, listRoles, listProfiles } from "./config.js";

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
}

/** State for the interactive prompt loop */
export interface PromptState {
  config: GnomonConfig;
  exchanges: PromptExchange[];
  currentRole: string;
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
  prompt: string,
  systemPrompt: string,
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
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
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
  console.log("Type /roles to see available roles.");
  console.log("Type /profiles to see available profiles.");
  console.log("Type /quit or Ctrl+C to exit.");
  console.log("");
}

/** Print a styled exchange */
function printExchange(exchange: PromptExchange): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Turn ${exchange.turn}  |  role: ${exchange.role}  |  model: ${exchange.model}`);
  console.log(`  bucket: ${exchange.bucket}  |  ${exchange.duration_ms}ms`);
  console.log(`  status: ${exchange.code === 0 ? "✓ result" : exchange.code === 1 ? "⚠ refusal" : "✗ apparatus_failure"}`);
  console.log("");
  console.log(exchange.output);
  console.log("");
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

    case "/manifest":
      console.log("\nUse: gnomon surface manifest");
      return true;

    case "/help":
      console.log(`\nCommands:
  /roles          — Show available roles and models
  /profiles       — Show available profiles
  /manifest       — Show manifest command
  /quit           — Exit the loop
  /clear          — Clear screen

Input is automatically routed to a role based on prefix:
  /plan "..."     → plan role
  /implement "..." → implement role
  /critique "..."  → critique role
  /smol "..."      → smol role
  "..."           → implement role (default)
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

      console.log(`\n[role: ${role} | model: ${route.model}]`);
      console.log("  … thinking  (first turn after idle loads the model, ~10–20s)");

      // Call model — primary first, declared fallback on failure
      const start = Date.now();
      let result = await callEndpoint(
        route.target,
        cleanedInput,
        config.system.content ?? "",
        modelTimeoutMs()
      );
      let usedModel = route.model;

      if (result.code !== 0 && route.fallback) {
        console.log(
          `  [primary unavailable — falling back to ${route.fallback.model}]`
        );
        usedModel = route.fallback.model;
        result = await callEndpoint(
          route.fallback,
          cleanedInput,
          config.system.content ?? "",
          modelTimeoutMs()
        );
      }
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
      };

      state.exchanges.push(exchange);
      printExchange(exchange);
    }
  } finally {
    rl.close();
  }
}

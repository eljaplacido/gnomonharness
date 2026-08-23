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
import { GnomonConfig, routeRole, listRoles, listProfiles } from "./config.js";

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
 * Call a local model API (Ollama-compatible OpenAI endpoint).
 *
 * Supports:
 * - Ollama: localhost:11434/api/chat
 * - Custom: GNOMON_MODEL_URL env var (e.g. http://localhost:8080/v1/chat/completions)
 */
async function callModel(
  prompt: string,
  systemPrompt: string,
  model: string,
  temperature: number,
  top_p: number
): Promise<InferenceResult> {
  const baseUrl = process.env.GNOMON_MODEL_URL ?? "http://localhost:11434";
  const endpoint = baseUrl.endsWith("/api/chat")
    ? baseUrl
    : `${baseUrl}/api/chat`;

  const payload = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    stream: false,
    options: {
      temperature,
      top_p,
    },
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      return {
        content: `Model API error: ${res.status} ${res.statusText}`,
        code: 10,
      };
    }

    const json = await res.json();

    // Ollama response format
    const content = json.message?.content ?? json.response ?? json.content ?? "";
    return { content, code: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Model unavailable: ${msg}\n\nTip: start ollama, then set GNOMON_MODEL_URL if needed.`,
      code: 10,
    };
  }
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

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(prompt, resolve);
    });

  try {
    while (true) {
      const input = await question("gnomon> ");

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
        cleanedInput = input.slice(6);
      } else if (input.startsWith("/implement ")) {
        role = "implement";
        cleanedInput = input.slice(13);
      } else if (input.startsWith("/critique ")) {
        role = "critique";
        cleanedInput = input.slice(12);
      } else if (input.startsWith("/smol ")) {
        role = "smol";
        cleanedInput = input.slice(6);
      }

      state.currentRole = role;
      const route = routeRole(config, role);

      console.log(`\n[role: ${role} | model: ${route.model}]`);

      // Call model
      const start = Date.now();
      const result = await callModel(
        cleanedInput,
        config.system.content ?? "",
        route.model,
        route.temperature,
        route.top_p
      );
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
        model: route.model,
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

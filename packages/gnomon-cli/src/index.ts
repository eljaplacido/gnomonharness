#!/usr/bin/env node
/**
 * gnomon-cli: Terminal entry point
 *
 * CLI interface for the gnomon harness:
 *   gnomon surface [--dir <path>]  — show surface hash
 *   gnomon manifest [--dir <path>]  — show manifest
 *   gnomon enumerations             — show contract
 *   gnomon session [--dir <path>]   — run a session
 *   gnomon prompt                   — interactive agent loop
 *
 * One-shot mode (no TUI): gnomon <command>
 * Interactive mode: gnomon prompt
 */

import {
  loadConfig,
  initAgent,
  SessionManager,
  resolveGnomonDir,
  Manifest,
  runPromptLoop,
} from "gnomon-core";
import {
  manifest as surfaceManifest,
  surfaceHash,
  enumerations,
  listPaths as nativeListPaths,
  applyPatchset,
  simulatePatch,
  Enumerations,
} from "gnomon-natives";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runTui } from "gnomon-tui";
import { initSurface } from "./init.js";

// ---------------------------------------------------------------------------
// Argument parsing (minimal, no deps)
// ---------------------------------------------------------------------------

interface CliArgs {
  command: string;
  subcommand?: string;
  dir?: string;
  printSession?: boolean;
  force?: boolean;
  from?: string;
  positional: string[];
}

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = { command: "", subcommand: "", positional: [] };
  let i = 0;

  // Check for -p flag early
  if (args.includes("-p")) {
    result.printSession = true;
  }

  // Skip program name
  if (args[0]?.startsWith("-")) {
    i = 1;
  } else {
    result.command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--dir" || arg === "-d") {
      i++;
      result.dir = args[i];
    } else if (arg === "--from") {
      i++;
      result.from = args[i];
    } else if (arg === "--force" || arg === "-f") {
      result.force = true;
    } else if (arg === "-p") {
      // Already handled above
    } else if (arg.startsWith("-")) {
      // Flag (ignored for now)
    } else {
      if (!result.subcommand) {
        result.subcommand = arg;
      } else {
        result.positional.push(arg);
      }
    }
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdSurface(args: CliArgs): Promise<void> {
  const dir = args.dir;
  if (args.subcommand === "manifest") {
    const m = surfaceManifest(dir);
    console.log(JSON.stringify(m, null, 2));
  } else if (args.subcommand === "hash" || !args.subcommand) {
    const h = surfaceHash(dir);
    console.log(h);
  } else if (args.subcommand === "paths") {
    // List paths from native surface
    const paths = nativeListPaths(dir);
    for (const p of paths) {
      console.log(p);
    }
  } else {
    console.error("Unknown surface subcommand:", args.subcommand);
    process.exit(1);
  }
}

async function cmdEnumerations(args: CliArgs): Promise<void> {
  const enums: Enumerations = enumerations();
  console.log(JSON.stringify(enums, null, 2));
}

/** Find the latest session file in the sessions directory. */
function findLatestSession(sessionsDir: string): string | null {
  if (!existsSync(sessionsDir)) return null;

  const files = readdirSync(sessionsDir)
    .filter((f: string) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) return null;
  return join(sessionsDir, files[files.length - 1]);
}

/** Print the session ID of the latest session, or the current run ID. */
async function cmdSessionId(args: CliArgs): Promise<void> {
  const dir = args.dir;
  const sessionsDir = dir ? join(dir, "sessions") : join(process.cwd(), "sessions");
  const latest = findLatestSession(sessionsDir);
  if (latest) {
    const data = JSON.parse(readFileSync(latest, "utf-8"));
    console.log(data.session?.id ?? "unknown");
  } else {
    console.log("no-session");
  }
}

async function cmdTui(args: CliArgs): Promise<void> {
  await runTui(args.dir);
}

async function cmdSession(args: CliArgs): Promise<void> {
  const dir = args.dir;
  const commands = args.positional;

  if (commands.length === 0) {
    console.error("Usage: gnomon session [--dir <path>] <command> [command ...]");
    process.exit(1);
  }

  const config = loadConfig(dir);
  const gnomonDir = config.gnomonDir;

  // Build manifest from surface
  const m = surfaceManifest(dir);
  const session = new SessionManager(m as Manifest);

  for (const cmd of commands) {
    console.log(`> ${cmd}`);
    const step = await session.run(cmd, {
      GNOMON_DIR: gnomonDir,
    });
    console.log(
      `  bucket=${step.bucket} duration=${step.duration_ms}ms`
    );
    if (step.stdout) console.log(step.stdout);
    if (step.stderr) console.error(step.stderr);

    // Stop on apparatus failure
    if (step.bucket === "apparatus_failure") {
      console.error("Session halted: apparatus failure");
      break;
    }
  }

  // Save session
  const outFile = args.positional.length > 0
    ? `${args.positional[0].replace(/[/:]/g, "_")}.json`
    : "session.json";
  session.save(outFile);
  console.log(`Session saved: ${outFile}`);
  console.log(`Total steps: ${session.stepCount}`);
  console.log(`Outcomes: ${session.outcomes.join(", ")}`);
}

async function cmdApply(args: CliArgs): Promise<void> {
  const patchsetPath = args.positional[0];
  if (!patchsetPath) {
    console.error("Usage: gnomon apply <patchset.json> [--dir <path>]");
    process.exit(1);
  }

  const result = applyPatchset(patchsetPath, args.dir);
  console.log(JSON.stringify(result, null, 2));

  if (!result.all_applied) {
    console.error("Some patches failed:");
    for (const r of result.results) {
      if (!r.applied) {
        console.error(`  ${r.path}: ${r.error}`);
      }
    }
    process.exit(1);
  }

  console.log(`Applied ${result.applied}/${result.total} patches`);
}

async function cmdSimulate(args: CliArgs): Promise<void> {
  const patchsetPath = args.positional[0];
  if (!patchsetPath) {
    console.error("Usage: gnomon simulate <patchset.json> [--dir <path>]");
    process.exit(1);
  }

  const result = simulatePatch(patchsetPath, args.dir);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdInit(args: CliArgs): Promise<void> {
  let result;
  try {
    result = initSurface({ dir: args.dir, force: args.force, from: args.from });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`Initialised ${result.gnomonDir}`);
  for (const f of result.written) console.log(`  + .gnomon/${f}`);
  for (const f of result.skipped) console.log(`  · .gnomon/${f} (kept existing)`);

  console.log("");
  console.log("Next:");
  console.log("  1. Edit .gnomon/roles.toml — the model tags must be ones you");
  console.log("     actually have. `ollama list` shows them.");
  console.log("  2. Run `gnomon prompt` in this directory.");
  console.log("");
  console.log("Approval is on_write: reads are free, writes show a diff first.");
}

async function cmdPrompt(args: CliArgs): Promise<void> {
  const config = loadConfig(args.dir);
  await runPromptLoop(config, args.subcommand || "implement");
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`gnomon v0.1.0 — deterministic coding agent harness

Commands:
  init [--dir <path>] [--from <path>] [--force]
    Write a .gnomon/ surface into a project. --from copies an existing
    surface instead of the built-in starter templates.

  surface [manifest|hash|paths] [--dir <path>]
    Show surface hash, manifest, or paths for .gnomon/ tree

  enumerations
    Show the enumerations contract (edit_format, sandbox, approval, role_profile)

  session [--dir <path>] <command> [command ...]
    Run commands as a session, recording outcomes

  apply <patchset.json> [--dir <path>]
    Apply a patchset to a directory

  simulate <patchset.json> [--dir <path>]
    Dry-run preview of a patchset

  prompt
    Interactive agent loop — reads stdin, infers role, calls model

  run
    Alias for \`prompt\`

One-shot mode: gnomon <command>
Interactive mode: gnomon prompt

Getting started in a project:
  cd /path/to/project
  gnomon init
  gnomon prompt

Environment:
  GNOMON_BIN_OVERRIDE     Path to gnomon binary (for testing)
  GNOMON_DIR              Override .gnomon/ directory path
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "--help" || args.command === "-h" || args.command === "help") {
    showHelp();
    return;
  }

  // -p flag: print latest session ID regardless of command
  if (args.printSession) {
    await cmdSessionId(args);
    return;
  }

  if (!args.command || args.command.startsWith("-")) {
    showHelp();
    return;
  }

  switch (args.command) {
    case "surface":
      await cmdSurface(args);
      break;
    case "enumerations":
    case "enums":
      await cmdEnumerations(args);
      break;
    case "session":
      await cmdSession(args);
      break;
    case "apply":
      await cmdApply(args);
      break;
    case "simulate":
      await cmdSimulate(args);
      break;
    case "init":
      await cmdInit(args);
      break;
    case "prompt":
    case "run":
      await cmdPrompt(args);
      break;
    case "tui":
      await cmdTui(args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("gnomon error:", err.message);
  process.exit(1);
});

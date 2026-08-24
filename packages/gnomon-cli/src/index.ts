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
 *   gnomon -p "<task>"              — one-shot task, JSON record, contract exit code
 *
 * The one-shot form is the invocation a machine pins. Everything else here is for a
 * person at a terminal.
 */

import {
  loadConfig,
  initAgent,
  SessionManager,
  resolveGnomonDir,
  Manifest,
  runPromptLoop,
  runTask,
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
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runTui } from "gnomon-tui";
import { CliArgs, oneShotTask, parseArgs } from "./args.js";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * `--dir` names the repository, everywhere, and `.gnomon/` is resolved beneath it.
 *
 * The native hasher takes the `.gnomon/` directory itself while `loadConfig` takes
 * the repository root, so passing one `--dir` value straight to both hashed one tree
 * and read another. Resolving here keeps the flag meaning one thing; a path that is
 * not a repository now fails by name instead of silently hashing the wrong tree.
 */
function surfaceDirOf(args: CliArgs): string | undefined {
  return args.dir ? resolveGnomonDir(args.dir) : undefined;
}

async function cmdSurface(args: CliArgs): Promise<void> {
  const dir = surfaceDirOf(args);
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
  const m = surfaceManifest(surfaceDirOf(args));
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

  // Written where the readers look. The TUI and `gnomon -p` both read sessions/,
  // and a record saved beside the working directory is a record they never see.
  const outFile = sessionPath(dir, "session");
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

/** Where a session record is written: sessions/<name>-<n>.json under the repo. */
function sessionPath(dir: string | undefined, name: string): string {
  const sessionsDir = join(dir ? resolve(dir) : process.cwd(), "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const existing = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((f) => f.endsWith(".json")).length
    : 0;
  return join(sessionsDir, `${name}-${String(existing + 1).padStart(4, "0")}.json`);
}

/**
 * One task, one record, one exit code from the published table.
 *
 * This is the contract a machine consumer pins, so it holds three things even when
 * the run goes badly: the record is written, the record names the surface it ran
 * under, and the process exits with the native value of its last step rather than a
 * generic 1. An unreachable provider exits 12 and is an apparatus failure — not a
 * task the agent failed, and not a task it refused.
 */
async function cmdTask(args: CliArgs, task: string): Promise<void> {
  const dir = args.dir;
  const config = loadConfig(dir);
  const manifest = surfaceManifest(surfaceDirOf(args)) as Manifest;

  const { record, exitCode } = await runTask({
    prompt: task,
    role: args.role,
    dir: dir ? resolve(dir) : process.cwd(),
    manifest,
    config,
  });

  const outFile = sessionPath(dir, "task");
  writeFileSync(outFile, JSON.stringify(record, null, 2));

  if (args.json) {
    console.log(JSON.stringify(record, null, 2));
  } else {
    for (const step of record.session.steps) {
      const label = step.attempt ? `attempt ${step.attempt}` : "step";
      console.log(`[${label}: ${step.model ?? "-"}] ${step.bucket} (${step.native_code}) ${step.duration_ms}ms`);
      const text = step.stdout || step.stderr;
      if (text) console.log(text);
    }
    console.error(`session: ${outFile}`);
  }

  // Set rather than exit: `process.exit()` can truncate a record still being
  // written to a pipe, and the record is the point of this mode.
  process.exitCode = exitCode;
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
  surface [manifest|hash|paths] [--dir <path>]
    Show surface hash, manifest, or paths for .gnomon/ tree.
    --dir names the repository; .gnomon/ is resolved beneath it.

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

  -p "<task>" [--role <role>] [--json] [--dir <path>]
    One-shot: run one task, write a session record under sessions/, and exit with
    the native value of the last step. This is the invocation a machine pins.

  -p
    With no task: print the id of the most recent session.

Exit codes (conformance/exit_codes.json):
  0,1    result              completed / failed
  2,3,4  refusal             refused by model / by gate / preconditions unmet
  10-13  apparatus_failure   launch failed / timed out / provider unreachable /
                             context exhausted

Environment — machine scope, recorded on every session record because none of it
is in the surface hash:
  GNOMON_MODEL_URL        Primary endpoint, when roles.toml declares none
  GNOMON_MODEL_TIMEOUT_MS Per-call bound; it decides what counts as a timeout
  GNOMON_BIN_OVERRIDE     Path to the native binaries (for testing)
  GNOMON_DIR              Override .gnomon/ directory path
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    showHelp();
    return;
  }

  // `-p <task>` is the one-shot mode; bare `-p` keeps its older meaning, printing
  // the id of the most recent session.
  const task = oneShotTask(args);
  if (task !== null) {
    await cmdTask(args, task);
    return;
  }
  if (args.print) {
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

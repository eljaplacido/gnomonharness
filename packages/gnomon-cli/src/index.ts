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
  loadSkills,
  loadProposedSkills,
  acceptSkill,
  rejectSkill,
  runTask,
  resolveAudit,
  verifyTrail,
  resolveSessionStore,
  listSessions,
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
  role?: string;
  yes?: boolean;
  json?: boolean;
  resume?: string | true;
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
    } else if (arg === "--role") {
      i++;
      result.role = args[i];
    } else if (arg === "--force" || arg === "-f") {
      result.force = true;
    } else if (arg === "--resume" || arg === "-r") {
      // `--resume` alone means the most recent; `--resume <id>` names one.
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        i++;
        result.resume = next;
      } else {
        result.resume = true;
      }
    } else if (arg === "--continue" || arg === "-c") {
      result.resume = true;
    } else if (arg === "--yes" || arg === "-y") {
      result.yes = true;
    } else if (arg === "--json") {
      result.json = true;
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
  // gnomon-surface takes the .gnomon DIRECTORY itself (see .gnomon/ci.sh),
  // not the project root, and does not search upward. Passing a root made it
  // hash `.gnomon/.gnomon/...` and sweep in files that sit beside the surface;
  // passing nothing made it hash whatever happened to be next to the cwd.
  const dir = args.dir ? join(resolve(args.dir), ".gnomon") : resolveGnomonDir();
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

async function cmdAudit(args: CliArgs): Promise<void> {
  const config = loadConfig(args.dir);
  const settings = resolveAudit(config);
  const sub = args.subcommand ?? "show";

  if (!existsSync(settings.dir)) {
    console.log(`No audit trail at ${settings.dir}`);
    console.log(
      settings.enabled
        ? "Auditing is enabled but nothing has been recorded yet."
        : "Auditing is off. Set [audit].enabled = true in .gnomon/config.toml."
    );
    return;
  }

  const trails = readdirSync(settings.dir)
    .filter((f: string) => f.endsWith(".jsonl"))
    .sort();

  if (sub === "show" || sub === "list") {
    console.log(`Trails in ${settings.dir}:`);
    for (const t of trails) console.log(`  ${t}`);
    if (trails.length === 0) console.log("  (none)");
    return;
  }

  if (sub === "verify") {
    const targets = args.positional.length > 0 ? args.positional : trails;
    let allOk = true;
    for (const name of targets) {
      const path = join(settings.dir, name);
      const r = verifyTrail(path);
      if (r.problem) {
        console.error(`${name}: ${r.problem}`);
        allOk = false;
        continue;
      }
      const status = r.ok ? "intact" : `BROKEN at seq ${r.broken.join(", ")}`;
      console.log(`${name}: ${r.records} records — ${status}`);
      if (!r.ok) allOk = false;
    }
    if (!allOk) process.exit(1);
    return;
  }

  console.error(`Unknown audit subcommand: ${sub}. Use: show | verify`);
  process.exit(1);
}

async function cmdTask(args: CliArgs): Promise<void> {
  const text = [args.subcommand, ...args.positional].filter(Boolean).join(" ").trim();
  if (!text) {
    console.error('Usage: gnomon task "<what to do>" [--role <name>] [--yes] [--json]');
    process.exit(1);
  }

  const config = loadConfig(args.dir);
  const record = await runTask(config, text, {
    role: args.role,
    yes: args.yes,
    verbose: !args.json,
  });

  if (args.json) {
    console.log(JSON.stringify(record, null, 2));
  } else {
    console.log(record.output);
    console.error(
      `\n[${record.bucket}] role=${record.role} model=${record.model} ` +
        `tools=${record.tool_steps} surface=${record.surface_hash.slice(0, 12)}`
    );
  }

  // Exit code carries the bucket, so a caller can gate on it without parsing.
  process.exit(record.bucket === "result" ? 0 : record.bucket === "refusal" ? 2 : 10);
}

async function cmdSkill(args: CliArgs): Promise<void> {
  const config = loadConfig(args.dir);
  const sub = args.subcommand ?? "list";
  const id = args.positional[0];

  if (sub === "list") {
    const active = loadSkills(config);
    const pending = loadProposedSkills(config);
    console.log("Active (.gnomon/skills/):");
    if (active.length === 0) console.log("  (none)");
    for (const s of active) console.log(`  ${s.id} — ${s.description ?? s.name}`);
    console.log("\nProposed (.gnomon/skills/proposed/) — not loaded:");
    if (pending.length === 0) console.log("  (none)");
    for (const s of pending) console.log(`  ${s.id} — ${s.description ?? s.name}`);
    return;
  }

  if (sub === "accept" || sub === "reject") {
    if (!id) {
      console.error(`Usage: gnomon skill ${sub} <id>`);
      process.exit(1);
    }
    try {
      if (sub === "accept") {
        const to = acceptSkill(config, id);
        console.log(`Accepted ${id} → ${to}`);
        console.log(
          "The surface hash has changed. The skill loads from the next session."
        );
      } else {
        rejectSkill(config, id);
        console.log(`Rejected ${id}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown skill subcommand: ${sub}. Use: list | accept | reject`);
  process.exit(1);
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
  console.log(`  (in ${resolve(args.dir ?? process.cwd())})`);
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

/**
 * One command to start working in a project.
 *
 * Creates the surface if it is missing, then opens the loop. `gnomon init`
 * followed by `gnomon prompt` was two steps that were easy to get wrong —
 * running init from the wrong directory initialised the harness instead of
 * the project.
 */
async function cmdLaunch(args: CliArgs): Promise<void> {
  const target = resolve(args.dir ?? process.cwd());
  const surface = join(target, ".gnomon");

  if (!existsSync(surface)) {
    console.log(`No .gnomon/ in ${target} — creating one.`);
    await cmdInit(args);
    console.log("");
    console.log("Edit .gnomon/roles.toml if the model tags are not ones you have,");
    console.log("then re-run `gnomon launch`. Starting anyway:");
    console.log("");
  }

  await cmdPrompt(args);
}

async function cmdPrompt(args: CliArgs): Promise<void> {
  const config = loadConfig(args.dir);
  // A resumed session keeps its own role unless one is named here.
  const role = args.resume ? args.subcommand || undefined : args.subcommand || "implement";
  await runPromptLoop(config, role, { resume: args.resume });
}

async function cmdSessions(args: CliArgs): Promise<void> {
  const config = loadConfig(args.dir);
  const store = resolveSessionStore(config);

  if (!store.persist) {
    console.log("Session persistence is off ([session].persist = false).");
    return;
  }

  const sessions = listSessions(store);
  if (sessions.length === 0) {
    console.log(`No sessions in ${store.dir}`);
    return;
  }

  console.log(`Sessions in ${store.dir} (newest last):\n`);
  for (const s of sessions) {
    console.log(`  ${s.id}`);
    console.log(
      `    ${s.turns} turn(s) · ${s.currentRole} · ${s.updated} · surface ${s.surface_hash.slice(0, 12)}`
    );
    if (s.opening) console.log(`    "${s.opening}"`);
  }
  console.log(`\nResume the newest:  gnomon prompt --continue`);
  console.log(`Resume a specific:  gnomon prompt --resume <id>`);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`gnomon v0.1.0 — deterministic coding agent harness

Commands:
  launch [--dir <path>] [--from <path>]
    Start working here. Creates .gnomon/ if it is missing, then opens the
    interactive loop. This is the one command to remember.

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

  audit [show|verify] [--dir <path>]
    Audit trails, when [audit] is enabled. 'verify' re-hashes each record
    and checks the chain, so a trail altered after the fact is detectable.

  skill [list|accept <id>|reject <id>] [--dir <path>]
    Skills the harness has learned. An agent proposes into
    .gnomon/skills/proposed/; accepting moves it into .gnomon/skills/,
    which changes the surface hash and applies from the next session.

  task "<what to do>" [--role <name>] [--yes] [--json] [--dir <path>]
    Run one task without a terminal and print the result. --json emits a
    record whose only run-to-run differences are under "volatile".
    Gated tool calls are REFUSED unless --yes: a non-interactive run has
    nobody to ask. Exit code: 0 result, 2 refusal, 10 apparatus_failure.

  sessions [--dir <path>]
    Saved sessions, newest last.

  prompt [--continue | --resume <id>]
    Interactive agent loop. --continue resumes the most recent session,
    --resume <id> a specific one. Conversations are saved after every turn.

  run
    Alias for \`prompt\`

One-shot mode: gnomon <command>
Interactive mode: gnomon prompt

Getting started in a project:
  cd /path/to/project
  gnomon launch

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
    case "audit":
      await cmdAudit(args);
      break;
    case "sessions":
      await cmdSessions(args);
      break;
    case "task":
      await cmdTask(args);
      break;
    case "skill":
    case "skills":
      await cmdSkill(args);
      break;
    case "launch":
      await cmdLaunch(args);
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

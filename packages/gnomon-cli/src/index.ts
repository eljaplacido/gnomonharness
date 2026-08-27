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
  loadLoops,
  runTick,
  readState,
  installLoop,
  uninstallLoop,
  installedLoops,
  cronExpr,
  writeState,
  LOOP_STATE_DIR,
  verifyTrail,
  resolveSessionStore,
  listSessions,
  resolveEndpoint,
  listEndpoints,
  credentialsPath,
  setCredential,
  unsetCredential,
  listCredentials,
  applyCredentials,
  isShellExported,
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
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * `gnomon loop` — declare supervision in the surface, materialize it on this
 * machine.
 *
 * The split is the point. `list` and `run` read `.gnomon/loops/*.toml`, which
 * is hashed and portable. `install`/`uninstall` touch this machine's crontab,
 * which is not in the surface and must never be: a crontab path is exactly the
 * machine-scoped config Rule 1 keeps out. `status` reconciles the two.
 */
async function cmdLoop(args: CliArgs): Promise<void> {
  const root = args.dir ? resolve(args.dir) : process.cwd();
  const gnomonDir = resolveGnomonDir(args.dir);
  const loops = loadLoops(gnomonDir);
  const sub = args.subcommand ?? "list";
  const named = (n?: string) => {
    const l = loops.find((x) => x.name === n);
    if (!l) {
      console.error(`Unknown loop: ${n ?? "(none given)"}. Declared: ${loops.map((x) => x.name).join(", ") || "none"}`);
      process.exit(1);
    }
    return l!;
  };

  if (sub === "list") {
    if (!loops.length) {
      console.log("No loops declared. Add .gnomon/loops/<name>.toml");
      return;
    }
    const inst = new Set(installedLoops());
    for (const l of loops) {
      const st = readState(root, l.name);
      const flag = st.tripped ? "BREAKER OPEN" : inst.has(l.name) ? "installed" : "declared";
      console.log(`${l.name}  every=${l.every}  [${flag}]  ${l.description ?? ""}`);
    }
    return;
  }

  if (sub === "run") {
    // Exit codes follow gnomon's buckets so cron and callers can branch without
    // parsing text: 0 the loop is fine, 2 it acted-and-failed (a real signal),
    // 10 the apparatus could not look at all.
    const l = named(args.positional[0]);
    const r = runTick(root, l);
    const stamp = new Date().toISOString();
    console.log(`${stamp} ${r.loop} ${r.outcome}${r.guardValue !== undefined ? ` guard=${r.guardValue}` : ""}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.outcome === "guard_failed") process.exit(10);
    if (r.outcome === "act_failed" || r.outcome === "breaker_open") process.exit(2);
    return;
  }

  if (sub === "dry-run") {
    const l = named(args.positional[0]);
    const r = runTick(root, l, { dryRun: true });
    console.log(`${r.loop} ${r.outcome}${r.guardValue !== undefined ? ` guard=${r.guardValue}` : ""}${r.detail ? ` — ${r.detail}` : ""}`);
    return;
  }

  if (sub === "install") {
    const l = named(args.positional[0]);
    // NOT process.argv[1]: under the tsx launcher that is src/index.ts, and
    // cron handed it to a bare `node`, which cannot load TypeScript. Resolve
    // the launcher relative to this module and pin the interpreter to the one
    // running now, since cron's PATH has neither nvm nor tsx.
    const launcher = fileURLToPath(new URL("../gnomon.js", import.meta.url));
    const bin = `${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)}`;
    const line = installLoop(root, l, bin);
    console.log(`installed ${l.name}\n  ${line}`);
    return;
  }

  if (sub === "uninstall") {
    const name = args.positional[0];
    console.log(uninstallLoop(name!) ? `uninstalled ${name}` : `not installed: ${name}`);
    return;
  }

  if (sub === "status") {
    const inst = new Set(installedLoops());
    const declared = new Set(loops.map((l) => l.name));
    let drift = false;
    for (const l of loops) {
      const st = readState(root, l.name);
      const where = inst.has(l.name) ? "installed" : "NOT INSTALLED";
      if (!inst.has(l.name)) drift = true;
      console.log(
        `${l.name}\n  schedule   ${l.every} (${cronExpr(l.every)})\n  machine    ${where}\n  breaker    ${st.tripped ? "OPEN" : "closed"} (${st.consecutive_failures} consecutive failures)\n  last tick  ${st.last_tick ?? "never"} ${st.last_outcome ?? ""}`
      );
    }
    for (const n of inst) {
      if (!declared.has(n)) {
        drift = true;
        console.log(`${n}\n  DRIFT: in crontab but not declared in .gnomon/loops/`);
      }
    }
    if (drift) process.exitCode = 1;
    return;
  }

  if (sub === "reset") {
    const l = named(args.positional[0]);
    writeState(root, l.name, { consecutive_failures: 0, action_times: [], tripped: false });
    console.log(`reset ${l.name} (breaker closed)`);
    return;
  }

  if (sub === "kill") {
    // The global stop. A supervisor you cannot switch off is a liability.
    let n = 0;
    for (const name of installedLoops()) if (uninstallLoop(name)) n++;
    console.log(`uninstalled ${n} loop(s) from crontab`);
    return;
  }

  console.error(`Unknown loop subcommand: ${sub}`);
  console.error("Use: list | status | dry-run <name> | run <name> | install <name> | uninstall <name> | reset <name> | kill");
  process.exit(1);
}

async function cmdTui(args: CliArgs): Promise<void> {
  await runTui(args.dir);
}

/**
 * The bare arguments to a command, in order.
 *
 * parseArgs files the first non-flag word under `subcommand`, which is right
 * for `skill accept <id>` and wrong for `apply <file>`. Commands taking a
 * value first read through this instead; reading `positional` alone meant
 * apply, simulate and session printed usage and exited 1 for every invocation
 * they have ever had.
 */
function bareArgs(args: CliArgs): string[] {
  return [args.subcommand, ...args.positional].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
}

async function cmdSession(args: CliArgs): Promise<void> {
  const dir = args.dir;
  const commands = bareArgs(args);

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
  const outFile = commands.length > 0
    ? `${commands[0].replace(/[/:]/g, "_")}.json`
    : "session.json";
  session.save(outFile);
  console.log(`Session saved: ${outFile}`);
  console.log(`Total steps: ${session.stepCount}`);
  console.log(`Outcomes: ${session.outcomes.join(", ")}`);
}

async function cmdApply(args: CliArgs): Promise<void> {
  const patchsetPath = bareArgs(args)[0];
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
  const patchsetPath = bareArgs(args)[0];
  if (!patchsetPath) {
    console.error("Usage: gnomon simulate <patchset.json> [--dir <path>]");
    process.exit(1);
  }

  const result = simulatePatch(patchsetPath, args.dir);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Read a secret without echoing it.
 *
 * readline draws every keystroke; overriding its output hook is the supported
 * way to stop that. Falls back to plain stdin when there is no terminal, so
 * `echo $KEY | gnomon key set zen --stdin` works in a script.
 */
function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolvePromise) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolvePromise(data.trim()));
    });
  }

  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let shown = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rl as any)._writeToOutput = (chunk: string) => {
      if (!shown) {
        // Draw the question once, then swallow every keystroke.
        process.stdout.write(prompt);
        shown = true;
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolvePromise(answer.trim());
    });
  });
}

/**
 * Resolve what the user named to a variable.
 *
 * `gnomon key set zen` is the natural thing to type, so an endpoint name is
 * accepted and its declared api_key_env looked up. A bare VARIABLE_NAME works
 * too, for endpoints declared elsewhere.
 */
function resolveKeyVariable(args: CliArgs, named: string): string | null {
  try {
    const config = loadConfig(args.dir);
    if (listEndpoints(config).includes(named)) {
      const ep = resolveEndpoint(config, named);
      if (!ep.api_key_env) {
        console.error(
          `Endpoint "${named}" declares no api_key_env — it needs no key.`
        );
        process.exit(1);
      }
      return ep.api_key_env;
    }
  } catch {
    // No surface here; fall through and treat the argument as a variable name.
  }
  return /^[A-Z][A-Z0-9_]*$/.test(named) ? named : null;
}

async function cmdKey(args: CliArgs): Promise<void> {
  const sub = args.subcommand ?? "list";
  const named = args.positional[0];

  if (sub === "list") {
    const held = listCredentials();
    console.log(`Credentials in ${credentialsPath()}`);
    console.log("(names only — values are never printed)\n");
    if (held.length === 0) {
      console.log("  (none)");
    } else {
      for (const v of held) {
        // A variable exported in the shell wins, so say which is in force.
        const shadowed = isShellExported(v);
        console.log(`  ${v}${shadowed ? "   (an exported variable takes precedence here)" : ""}`);
      }
    }
    console.log("\n  gnomon key set <endpoint|VARIABLE>");
    return;
  }

  if (!named) {
    console.error(`Usage: gnomon key ${sub} <endpoint|VARIABLE>`);
    process.exit(1);
  }

  const variable = resolveKeyVariable(args, named);
  if (!variable) {
    console.error(
      `"${named}" is neither a declared endpoint nor a variable name.\n` +
        "Try: gnomon key set zen   ·   gnomon key set OPENCODE_API_KEY"
    );
    process.exit(1);
  }

  if (sub === "unset") {
    const removed = unsetCredential(variable);
    console.log(removed ? `Removed ${variable}.` : `${variable} was not stored.`);
    return;
  }

  if (sub === "set") {
    const value = await readSecret(`Value for ${variable} (input hidden): `);
    if (!value) {
      console.error("Nothing entered — no change.");
      process.exit(1);
    }
    setCredential(variable, value);
    console.log(`Stored ${variable} in ${credentialsPath()} (mode 0600).`);
    console.log(
      "The surface still names the variable and never holds the value, so\n" +
        ".gnomon/ stays safe to commit."
    );
    if (isShellExported(variable)) {
      console.log(
        `\nNote: ${variable} is also exported in this shell, and an exported\n` +
          "variable takes precedence. Unset it to use the stored one."
      );
    }
    return;
  }

  console.error(`Unknown key subcommand: ${sub}. Use: set | list | unset`);
  process.exit(1);
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
    result = await initSurface({ dir: args.dir, force: args.force, from: args.from });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`Initialised ${result.gnomonDir}`);
  console.log(`  (in ${resolve(args.dir ?? process.cwd())})`);
  for (const f of result.written) console.log(`  + .gnomon/${f}`);
  for (const f of result.skipped) console.log(`  · .gnomon/${f} (kept existing)`);

  // Say which models were chosen and why. A tag appearing in roles.toml with
  // no explanation looks like a decision someone made on your behalf.
  const models = result.models;
  if (models) {
    console.log("");
    if (models.fallback) {
      console.log(`Models: ${models.fallback}, so generic starter tags were used:`);
      console.log(`  ${models.large} for the reasoning roles, ${models.small} for smol`);
      console.log("  These are very likely wrong for this machine — edit them.");
    } else {
      console.log(`Models: detected ${models.detected.length} on this machine.`);
      console.log(`  ${models.large} for the reasoning roles`);
      console.log(`  ${models.small} for smol`);
    }
  }

  console.log("");
  console.log("Next:");
  console.log("  1. Check .gnomon/roles.toml — the model tags must be ones you");
  console.log("     actually have. `/models` lists them.");
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

  if (existsSync(surface)) {
    // Silence here meant a launch in the wrong directory looked exactly like
    // a launch in the right one.
    console.log(`Using the existing .gnomon/ in ${target}`);
  } else {
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

  key [set|list|unset] <endpoint|VARIABLE>
    Store an API key for an endpoint that declares one. The value is kept in
    a machine-local file (mode 0600), never in .gnomon/ — the surface names
    the variable and must stay safe to commit. An exported variable always
    takes precedence.

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

  // Stored keys stand in for variables the shell has not exported. Done once,
  // here, so every command sees the same environment.
  applyCredentials();

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
    case "key":
    case "keys":
      await cmdKey(args);
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
    case "loop":
    case "loops":
      await cmdLoop(args);
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

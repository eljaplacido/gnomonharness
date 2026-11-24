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
  runAcpServer,
  harnessBuild,
  recomputeManifest,
  declaredKeyVars,
  checkRoleModels,
  loadConfig,
  SessionManager,
  resolveGnomonDir,
  Manifest,
  runPromptLoop,
  loadSkills,
  loadProposedSkills,
  exportSkills,
  SKILL_EXPORT_FORMATS,
  SKILL_EXPORT_DEFAULT_DIR,
  type SkillExportFormat,
  acceptSkill,
  rejectSkill,
  SkillRefusal,
  unresolvedTamper,
  resolveTamper,
  mineCandidates,
  readSkillUsage,
  skillUsageSignals,
  writeCandidates,
  loadCandidates,
  MIN_REPEATS,
  runTrial,
  recordTrial,
  trialExit,
  runEval,
  recordEval,
  evalExit,
  EVAL_SCHEMA,
  runTask,
  parseDeadline,
  unstartedTaskRecord,
  taskExitCode,
  verifyExitRequested,
  type TaskRecord,
  resolveAudit,
  loadLoops,
  runTick,
  readState,
  installLoop,
  uninstallLoop,
  installedLoops,
  installedLoopEntries,
  cronExpr,
  writeState,
  LOOP_STATE_DIR,
  verifyTrail,
  flushAnchors,
  collectAnchors,
  verifyAgainstAnchors,
  setAnchorScheduler,
  writeAnchorHandoff,
  readAnchorHandoff,
  redactRemote,
  CHECKPOINT_DIR,
  type ResolvedAnchor,
  type AnchorTrailResult,
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
  probeEndpointAuth,
  describeEndpoints,
  printEndpoints,
  setEndpointBlock,
  pointRoleAt,
  modelEditTarget,
  listRoles,
  countNonConversations,
  resolveUi,
  isLocalEndpoint,
  AuditTrail,
  settleTrust,
  settleTrustHeadless,
  TrustRequiredError,
  evaluateTrust,
  clampToDefaults,
  keyHostIsDefault,
  destinationIsDefault,
  grantTrust,
  revokeTrust,
  forgetToolPins,
  toolPinsOf,
  loadTrust,
  trustPath,
  describeGrants,
  type GnomonConfig,
  type TrustOutcome,
  type SettleOptions,
  onKillSignal,
  type TaskInterrupt,
} from "gnomon-core";
import { runAttempts, formatAttemptsReport, type AttemptsReport } from "./attempts_run.js";
import {
  manifest as surfaceManifest,
  surfaceHash,
  enumerations,
  listPaths as nativeListPaths,
  applyPatchset,
  simulatePatch,
  Enumerations,
} from "gnomon-natives";
import { readFileSync, writeFileSync, writeSync, existsSync, readdirSync, mkdirSync} from "node:fs";
import { setProcessTitle } from "./proc_title.js";
import { runInbox, runInboxHook } from "./inbox_cmd.js";
import { runProposals, runMemory } from "./proposals_cmd.js";
import { runImproveCmd, bindDraftModel } from "./improve_cmd.js";
import { runAblateCmd } from "./ablate_cmd.js";
import { serveInboxMcp } from "./inbox_mcp.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initSurface } from "./init.js";
import {
  detectModels,
  type ModelChoice,
  looksLikeChatModel,
  suggestChatModel,
  looksLikeTrialTier,
  listOllama,
  ollamaTagsUrl,
  orderForPicking,
  DetectedModel,
} from "./detect.js";
import {
  checkReadiness,
  preSessionSurface,
  launchReadiness,
  withheldWhy,
  hostName,
  ENDPOINT_PRESETS,
  SETUP_CHOICES,
  parseSetupPick,
  parseModelPick,
  ollamaNotRunning,
  hostPort,
} from "./setup.js";
import { pendingMigrations, applyMigrations, MIGRATIONS } from "./migrate.js";
import { cmdUpdate, cmdUninstall, maybeNotifyUpdate } from "./update.js";
import { probeMachine, formatProbe, probeAtInit } from "./probe.js";
import type { Suggestion, StarterModels } from "./catalog.js";
import type { HybridControl } from "./setup_wizard.js";
// Cold paths, loaded by the command that needs them: `gnomon-tui`, `check`,
// `setup` (wizard, catalog, host effects) and `doctor`. A bundle or a
// compiled dist/ imports every static import at startup, and none of these
// is on the path of `--version`, `task` or `prompt` (audit 2026-11-06,
// startup: the launcher bundle grew 67% and every command paid for it).
import { selfLauncher } from "./self_launcher.js";

// ---------------------------------------------------------------------------
// Argument parsing (minimal, no deps)
// ---------------------------------------------------------------------------

interface CliArgs {
  command: string;
  subcommand?: string;
  dir?: string;
  printSession?: boolean;
  force?: boolean;
  /** init: do not switch on a detected [verify] (benchmark comparability) */
  noVerify?: boolean;
  from?: string;
  role?: string;
  yes?: boolean;
  json?: boolean;
  /** Run an untrusted surface as declared, this invocation only (trust.ts). */
  trust?: boolean;
  resume?: string | true;
  positional: string[];
  /**
   * Any other `--name value` pair, kept verbatim.
   *
   * Options a single command needs — `endpoint add --url …` — do not each
   * deserve a field here, and before this they were dropped while their value
   * silently became a positional argument.
   */
  flags: Record<string, string>;
}

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = { command: "", subcommand: "", positional: [], flags: {} };
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
    } else if (arg === "--no-verify") {
      result.noVerify = true;
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
    } else if (arg === "--trust") {
      // A bare flag. Through the generic branch below it would swallow the
      // next argument as its value -- `task --trust "fix it"` would lose the
      // task text into flags.trust.
      result.trust = true;
    } else if (arg === "--trust-exec-downgrade") {
      // Bare as well. Accepts a role leaving the container it ran in here,
      // for this run, which --trust alone does not (trust.ts).
      result.flags["trust-exec-downgrade"] = "true";
    } else if (arg === "--require-verify") {
      // Bare: the declared [verify] check is in the exit (1 failed, 4 unrunnable)
      // and in the record's verify_* detail. Without it #211 stands: exit 0.
      result.flags["require-verify"] = "true";
    } else if (arg === "--apply") {
      // Bare: `task --attempts k --apply` applies a verified winner.
      result.flags["apply"] = "true";
    } else if (arg === "--require-trust") {
      // Bare: an untrusted surface that grants more than the defaults stops
      // the run (exit 3) instead of running clamped. For CI.
      result.flags["require-trust"] = "true";
    } else if (arg === "--task-file") {
      // Always takes the next argument: `-` (stdin) is its value here, where
      // the generic branch below would read it as another option.
      i++;
      result.flags["task-file"] = args[i] ?? "";
    } else if (arg === "-p") {
      // Already handled above
    } else if (arg.startsWith("-")) {
      // Any other option. A value is taken only when the next argument is not
      // itself an option, so a bare `--verbose` stays a bare flag.
      const key = arg.replace(/^--?/, "");
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        i++;
        result.flags[key] = next;
      } else {
        result.flags[key] = "true";
      }
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
  const sub = subcommandOr(args, "list");
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
    const inst = new Set(installedLoops(root));
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
    const launcher = selfLauncher(import.meta.url) ?? fileURLToPath(new URL("../gnomon.js", import.meta.url));
    const bin = `${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)}`;
    const line = installLoop(root, l, bin);
    console.log(`installed ${l.name}\n  ${line}`);
    return;
  }

  if (sub === "uninstall") {
    const name = args.positional[0];
    // Scoped to this project: crontab is machine-wide, and an unscoped remove
    // took another checkout's loop of the same name with it.
    console.log(uninstallLoop(name!, root) ? `uninstalled ${name}` : `not installed: ${name}`);
    return;
  }

  if (sub === "status") {
    const inst = new Set(installedLoops(root));
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
        console.log(`${n}\n  DRIFT: in crontab for this project but not declared in .gnomon/loops/`);
      }
    }
    // Loops other checkouts installed are NOT drift here — they are declared,
    // in their own surface. Reported, because a crontab entry running gnomon
    // on this machine is worth knowing about, but never counted as this
    // project's problem and never a non-zero exit.
    const elsewhere = installedLoopEntries().filter(
      (e) => e.root !== null && resolve(e.root) !== resolve(root)
    );
    if (elsewhere.length) {
      console.log(`\nOther projects on this machine (not this surface's concern):`);
      for (const r of [...new Set(elsewhere.map((e) => e.root!))]) {
        console.log(`  ${r}  (${elsewhere.filter((e) => e.root === r).map((e) => e.name).join(", ")})`);
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
    // The stop. A supervisor you cannot switch off is a liability — but crontab
    // is machine-wide, and the unscoped version of this unscheduled every other
    // checkout's loops too, from a project that had nothing to do with them.
    // So: this project by default, `--all` for the machine, and either way it
    // says what it did not touch and how to reach it.
    const all = args.flags["all"] !== undefined || args.positional.includes("--all");
    let n = 0;
    for (const name of new Set(installedLoops(all ? undefined : root))) {
      if (uninstallLoop(name, all ? undefined : root)) n++;
    }
    console.log(
      all
        ? `uninstalled ${n} loop(s) from crontab (every project on this machine)`
        : `uninstalled ${n} loop(s) from crontab for ${root}`
    );
    if (!all) {
      const elsewhere = installedLoopEntries().filter(
        (e) => e.root !== null && resolve(e.root) !== resolve(root)
      );
      if (elsewhere.length) {
        const roots = [...new Set(elsewhere.map((e) => e.root!))];
        console.log(
          `\n${elsewhere.length} loop(s) are still scheduled from ${roots.length} other project(s):`
        );
        for (const r of roots) {
          console.log(`  ${r}  (${elsewhere.filter((e) => e.root === r).map((e) => e.name).join(", ")})`);
        }
        console.log(`\nStop those too:  gnomon loop kill --all`);
      }
    }
    return;
  }

  console.error(`Unknown loop subcommand: ${sub}`);
  console.error("Use: list | status | dry-run <name> | run <name> | install <name> | uninstall <name> | reset <name> | kill");
  process.exit(1);
}

async function cmdTui(args: CliArgs): Promise<void> {
  const { runTui } = await import("gnomon-tui");
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

/**
 * The subcommand, or `fallback` when none was given.
 *
 * parseArgs initialises `subcommand` to the EMPTY STRING (see `parseArgs`
 * above; cli.test.ts pins it: `parseArgs(["surface"]).subcommand === ""`).
 * An empty string is not nullish, so every nullish-coalescing fallback on that
 * field evaluated to `""` and fell straight through to the command's
 * "Unknown subcommand" branch. The fallbacks were there, and did nothing.
 *
 * Measured 2026-09-02, before this existed — all five in the bare form
 * `--help` documents as optional, the brackets in `endpoint [add|test|list]`
 * being the promise that the subcommand may be omitted:
 *
 *   gnomon endpoint  ->  Unknown endpoint subcommand: . Use: add | test | list   [1]
 *   gnomon skill     ->  Unknown skill subcommand: . Use: list | accept | reject [1]
 *   gnomon loop      ->  Unknown loop subcommand:                                [1]
 *   gnomon key       ->  Usage: gnomon key  <endpoint|VARIABLE>                  [1]
 *   gnomon audit     ->  reached the same branch whenever an audit dir existed
 *
 * Empty and undefined both mean "not given", so both map to the fallback. That
 * also means this keeps working if `parseArgs` is ever changed to leave the
 * field undefined — the fix does not depend on which sentinel is in use.
 */
function subcommandOr(args: CliArgs, fallback: string): string {
  const sub = args.subcommand;
  return sub === undefined || sub === "" ? fallback : sub;
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

  // Save into the surface's own session directory, not the working directory.
  //
  // This used to name the file after the first COMMAND and drop it wherever the
  // shell happened to be: `gnomon session "pytest -q"` wrote `pytest -q.json`
  // into the current directory, --dir was loaded and then ignored, and
  // `gnomon session <id>` looked for records somewhere else entirely — so a
  // saved session could not be found by the command meant to read it.
  const store = resolveSessionStore(config);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = join(store.dir, `session-${stamp}.json`);
  mkdirSync(store.dir, { recursive: true });
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
    const config = loadConfig(args.dir, args.flags['profile']);
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
  const sub = subcommandOr(args, "list");
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

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Ask a question with a default, on a terminal. */
function ask(prompt: string, fallback = ""): Promise<string> {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolvePromise(answer.trim() || fallback);
    });
  });
}

/**
 * `gnomon endpoint add` — declare an endpoint, hold its key, and prove it works.
 *
 * Written because the pieces existed and the path between them did not. An
 * endpoint took a hand-edited TOML block, a separate `key set`, a role edit in
 * a second file, and a model tag you had to already know — four steps across
 * three files, with no check at the end. What that produced in practice was an
 * endpoint pointing somewhere unintended, a key in the wrong shape, and a 401
 * several turns into a session with nothing on screen naming the cause.
 *
 * So the verification is the point, not the prompts: nothing is written to the
 * surface until this endpoint has answered a real completion. A model listing
 * is not evidence — opencode.ai serves one to no key at all.
 */
async function cmdEndpoint(args: CliArgs): Promise<void> {
  const sub = subcommandOr(args, "list");
  const config = loadConfig(args.dir, args.flags['profile']);

  // Load the machine-local key store BEFORE anything reads the environment.
  //
  // `printEndpoints` decides SET vs NOT SET by reading `process.env[api_key_env]`
  // (prompt_loop.ts). The `list` branch used to return above this call, so a key
  // that `gnomon key set` had stored — and that every other command applies and
  // uses successfully — was reported as missing, with the advice to run the very
  // command that had already stored it.
  //
  // Measured 2026-09-02 with the key present in the store and unexported:
  //     $ gnomon endpoint list
  //       key: $OPENCODE_API_KEY — NOT SET — run: gnomon key set zen
  // Both cloud endpoints, on a surface where `gnomon endpoint test zen` then
  // authenticated fine.
  //
  // `declaredKeyVars(config)` is the allow-list: only names the SURFACE declares
  // as key variables are injected, so the store cannot smuggle in
  // GNOMON_MODEL_URL and friends. See the note in main().
  const supplied = applyCredentials(undefined, declaredKeyVars(config));

  // `list` and `test` reach every endpoint with its key, and no session has
  // settled trust first. They use what the trust step would run: a cloned
  // repository's endpoint at its own host with api_key_env =
  // "ANTHROPIC_API_KEY" is listed as declared but asked nothing with the key
  // (docs/CONTRACTS.md §8). `add` writes the URL the user typed or chose.
  const { config: reach, trusted } = preSessionSurface(config, trustOptions(args));
  const keyHeld = (ep: { url: string; api_key_env?: string }): boolean =>
    Boolean(ep.api_key_env) && !trusted && !keyHostIsDefault(ep.url, ep.api_key_env);
  // Keyless too: a surface's endpoint at a public host that is not a known
  // provider is not contacted before the trust step has accepted it -- a
  // probe would already send that host the model id and a prompt.
  const destHeld = (ep: { url: string }): boolean => !trusted && !destinationIsDefault(ep.url);
  const destWhy = (ep: { url: string }): string =>
    `${hostName(ep.url)} is a host this machine has not trusted for this surface; run \`gnomon trust\` to review it`;

  if (sub === "list") {
    // Cross-check every role's model id against what its endpoint advertises.
    // This is the diagnostic command, and the failure it exists to catch is
    // exactly a model id the endpoint will not accept -- which is otherwise
    // invisible here and shows up later as a provider 400 naming the model,
    // which reads as "unavailable" rather than "misspelled". `.catch(null)` so
    // an offline box still gets the listing, unchecked rather than wrong.
    const modelChecks = await checkRoleModels(reach).catch(() => null);
    const rows = describeEndpoints(config);
    printEndpoints(rows, resolveUi(config), null, modelChecks, config.profile);
    for (const r of rows.filter((r) => keyHeld(r.endpoint))) {
      console.log(`  ${r.name}: ${withheldWhy({ env: r.endpoint.api_key_env!, host: hostName(r.endpoint.url) })}.`);
    }
    for (const r of rows.filter((r) => !keyHeld(r.endpoint) && destHeld(r.endpoint))) {
      console.log(`  ${r.name}: not contacted — ${destWhy(r.endpoint)}.`);
    }
    if (supplied.length > 0) {
      // Say where a key came from. "set" alone cannot distinguish a stored key
      // from an exported one, and only one of those follows you to another
      // shell.
      console.log(`\n  Supplied from ${credentialsPath()}: ${supplied.join(", ")}`);
    }
    console.log("\n  gnomon endpoint add [--preset opencode-go|opencode-zen|openrouter|ollama]");
    console.log("  gnomon endpoint test <name>   — run one token through it");
    return;
  }

  if (sub === "test") {
    const name = args.positional[0] ?? args.flags.name;
    const rows = describeEndpoints(config).filter((r) => !name || r.name === name);
    if (rows.length === 0) {
      console.error(`Unknown endpoint "${name}". Declared: ${listEndpoints(config).join(", ")}`);
      process.exit(1);
    }
    const probes = new Map<string, { ok: boolean; status?: number; detail?: string }>();
    const untested: string[] = [];
    const withheld: string[] = [];
    for (const row of rows) {
      const model = args.flags.model ?? row.probeModel;
      if (!model) {
        untested.push(row.name);
        continue;
      }
      if (keyHeld(row.endpoint) || destHeld(row.endpoint)) {
        withheld.push(row.name);
        continue;
      }
      row.probeModel = model;
      probes.set(row.name, await probeEndpointAuth(row.endpoint, model));
    }
    const modelChecks = await checkRoleModels(reach).catch(() => null);
    printEndpoints(rows, resolveUi(config), probes, modelChecks, config.profile);
    for (const n of withheld) {
      const ep = rows.find((r) => r.name === n)!.endpoint;
      console.log(`  ${n}: NOT TESTED — ${keyHeld(ep) ? withheldWhy({ env: ep.api_key_env!, host: hostName(ep.url) }) : destWhy(ep)}.`);
    }
    // An endpoint with no role routed to it has no model to ask for, and was
    // skipped without a word — `gnomon endpoint test go` printed the listing
    // and exited 0, which reads as a pass. Say it, and do not exit 0 when the
    // one endpoint asked about was never tested.
    for (const n of untested) {
      console.log(`  ${n}: NOT TESTED — no role routes here, so there is no model to ask for.`);
      console.log(`    gnomon endpoint test ${n} --model <id>   (/models lists what it serves)`);
    }
    const bad = [...probes.values()].filter((p) => !p.ok);
    if (bad.length > 0) process.exit(1);
    // Held back by trust: refused_by_gate (docs/CONTRACTS.md §1), not a pass.
    if (withheld.length > 0) process.exit(3);
    if (name && untested.length > 0) process.exit(10);
    return;
  }

  if (sub !== "add") {
    console.error(`Unknown endpoint subcommand: ${sub}. Use: add | test | list`);
    process.exit(1);
  }

  if ((await endpointAdd(args, config)) === "failed") process.exit(1);
}

/** How `endpointAdd` ended. Only "failed" is an error exit. */
type AddOutcome = "written" | "declined" | "failed";

interface AddOptions {
  /** Preset chosen by the caller -- launch's picker -- rather than a flag. */
  preset?: string;
  /**
   * First-run setup from `gnomon launch`: take the preset's endpoint name
   * without asking, and point every role that names a model at the result.
   * Someone who has just said "use Ollama" has answered both questions.
   */
  quick?: boolean;
}

/**
 * The `endpoint add` flow, returning instead of exiting so `gnomon launch`
 * can run it from its picker and offer the picker again when it fails.
 */
async function endpointAdd(
  args: CliArgs,
  config: ReturnType<typeof loadConfig>,
  opts: AddOptions = {}
): Promise<AddOutcome> {
  const interactive = process.stdin.isTTY;

  // ── 1. Which provider ────────────────────────────────────────────────────
  let presetKey = opts.preset ?? args.flags.preset;
  if (!presetKey && interactive) {
    console.log("\nWhich endpoint?\n");
    const keys = Object.keys(ENDPOINT_PRESETS);
    keys.forEach((k, i) => {
      const p = ENDPOINT_PRESETS[k]!;
      console.log(`  ${i + 1}. ${k.padEnd(14)} ${p.note}`);
    });
    console.log(`  ${keys.length + 1}. custom         anything OpenAI- or Ollama-shaped`);
    const pick = await ask(`\nChoose [1-${keys.length + 1}]: `, "1");
    const idx = Number.parseInt(pick, 10) - 1;
    presetKey = keys[idx] ?? "custom";
  }
  const preset = presetKey ? ENDPOINT_PRESETS[presetKey] : undefined;
  if (presetKey && presetKey !== "custom" && !preset) {
    console.error(
      `Unknown preset "${presetKey}". Known: ${Object.keys(ENDPOINT_PRESETS).join(", ")}, custom`
    );
    return "failed";
  }

  // ── 2. Name, URL, shape ──────────────────────────────────────────────────
  const defaultName = preset?.name ?? "custom";
  // `gnomon endpoint add thinker --url …`: a bare word after `add` is the name.
  // It was ignored, and the endpoint was written as "custom" without a word.
  const positionalName =
    (args.command === "endpoint" || args.command === "endpoints") && args.subcommand === "add"
      ? args.positional[0]
      : undefined;
  const name =
    args.flags.name ??
    positionalName ??
    (interactive && !opts.quick ? await ask(`Endpoint name [${defaultName}]: `, defaultName) : defaultName);

  const existing = config.config.endpoints?.[name];
  if (existing && existing.url !== (args.flags.url ?? preset?.url)) {
    // The failure this catches: a local daemon already declared as "go", and
    // every attempt to add OpenCode Go quietly re-pointed roles at it instead.
    console.log(`\n  "${name}" is already declared, and points somewhere else:`);
    console.log(`    ${existing.url}`);
    const roles = describeEndpoints(config).find((r) => r.name === name);
    if (roles && (roles.primary.length > 0 || roles.fallback.length > 0 || roles.escalation.length > 0)) {
      console.log(`    used by: ${[...roles.primary, ...roles.fallback, ...roles.escalation].join(", ")}`);
    }
    const go = interactive
      ? await ask(`  Overwrite it? [y/N] `, "n")
      : args.force
        ? "y"
        : "n";
    if (!/^y/i.test(go)) {
      console.log("  Left alone. Choose another name with --name <name>.");
      return "declined";
    }
  }

  const url =
    args.flags.url ??
    preset?.url ??
    (interactive ? await ask("URL (…/chat/completions or …/api/chat): ") : "");
  if (!url) {
    console.error("An endpoint needs a url. Pass --url.");
    return "failed";
  }
  const kind =
    args.flags.kind ?? preset?.kind ?? (url.includes("/api/chat") ? "ollama" : "openai");
  const provider = args.flags.provider ?? preset?.provider;

  // ── 3. The key, by name, with the value held outside the surface ─────────
  const local = isLocalEndpoint(url);
  let keyEnv = args.flags["key-env"] ?? preset?.api_key_env;
  if (!keyEnv && !local && interactive) {
    const suggested = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    keyEnv = await ask(`Key variable name [${suggested}]: `, suggested);
  }

  if (keyEnv) {
    // A key `gnomon key set` stored earlier counts as held. The surface does
    // not declare this variable yet -- that is what this command is about to
    // do -- so nothing upstream of here has loaded it.
    if (!process.env[keyEnv]) applyCredentials(undefined, [keyEnv]);
    const held = Boolean(process.env[keyEnv]);
    let store = true;
    if (held && interactive) {
      const keep = await ask(`  $${keyEnv} already has a value. Keep it? [Y/n] `, "y");
      store = !/^y/i.test(keep);
    }
    if (store) {
      if (!interactive) {
        console.error(`$${keyEnv} is not set. Run: gnomon key set ${name}`);
        return "failed";
      }
      const value = await readSecret(`  Paste the key for $${keyEnv} (hidden): `);
      if (!value) {
        console.error("  Nothing entered — no change.");
        return "failed";
      }
      setCredential(keyEnv, value);
      process.env[keyEnv] = value;
      console.log(`  Stored in ${credentialsPath()} (mode 0600). The surface holds only the name.`);
    }
  }

  const endpoint = { url, kind: kind as "openai" | "ollama", api_key_env: keyEnv, provider };

  // ── 4. Which model, from what the endpoint actually offers ───────────────
  let model = args.flags.model;
  // Whether GNOMON picked the tag or a person did. It decides what the probe
  // failure below is allowed to blame: a tag this command chose is this
  // command's problem to explain, not the user's to be lectured about.
  let modelWasChosenForYou = false;
  // What init would give `smol` on this Ollama, for quick setup.
  let smallModel: string | undefined;
  if (!model && kind === "ollama") {
    const picked = await pickOllamaModel(url, interactive);
    if (!picked) return "failed";
    ({ model, chosenForYou: modelWasChosenForYou, small: smallModel } = picked);
  }
  if (!model) {
    process.stdout.write("  Asking the endpoint what it serves… ");
    const offered = await listModelsAt(endpoint);
    if (offered.length === 0) {
      console.log("no list available.");
      model = interactive ? await ask("  Model tag: ") : "";
    } else {
      console.log(`${offered.length} models.`);
      // The list is sorted, so `offered[0]` is the ALPHABETICALLY first tag.
      // On a stock Ollama that is bge-m3:latest -- an embedding model, which
      // fails the probe with `"bge-m3:latest" does not support chat` while the
      // command reported "Either the URL or the model tag is wrong for this
      // provider" about a tag the user never chose. Found 2026-09-08 against a
      // local Ollama serving ten models.
      //
      // Name-only filtering, shared with `gnomon init` via looksLikeChatModel
      // so there is one list of what cannot chat. It is a filter and not a
      // verdict: if nothing looks chat-capable the full list is used rather
      // than refusing, because the names are all this endpoint reported.
      const chatty = offered.filter(looksLikeChatModel);
      const suggested = suggestChatModel(offered)!;
      if (interactive) {
        // Numbered, like the Ollama picker. This printed a bare grid of tags
        // and then "Model [beam-free]:" -- nothing said a number would do, or
        // what to type at all, so the default was what most people got.
        const preview = offered.slice(0, 60);
        const width = Math.min(34, Math.max(...preview.map((m) => m.length)));
        const cell = (m: string, i: number) => {
          const note =
            m === suggested ? "←" : !looksLikeChatModel(m) ? "(embed)" : looksLikeTrialTier(m) ? "(trial)" : "";
          return `${String(i + 1).padStart(3)}. ${m.padEnd(width)} ${note.padEnd(7)}`;
        };
        const perRow = preview.length > 12 ? 2 : 1;
        for (let i = 0; i < preview.length; i += perRow) {
          console.log(" " + preview.slice(i, i + perRow).map((m, j) => cell(m, i + j)).join("  ").trimEnd());
        }
        if (offered.length > preview.length) {
          console.log(`    …and ${offered.length - preview.length} more (type the tag)`);
        }
        if (chatty.length > 0 && chatty.length < offered.length) {
          console.log(`    (embed) cannot chat and is never the default.`);
        }
        if (offered.some(looksLikeTrialTier)) {
          console.log(`    (trial) free/preview tiers — usable, but not chosen for you.`);
        }
        const answer = await ask(
          `  Type a number or a tag (Enter = ${offered.indexOf(suggested) + 1}. ${suggested}): `,
          ""
        );
        model = parseModelPick(answer, offered, suggested);
        modelWasChosenForYou = model === suggested;
      } else {
        model = suggested;
        modelWasChosenForYou = true;
      }
    }
    // A tag that is not on the list is the mistake that produces an opaque
    // error three turns later — say so now, while it is still one keystroke.
    if (model && offered.length > 0 && !offered.includes(model)) {
      const near = offered.filter((m) => m.replace(/[^a-z0-9]/gi, "").includes(model!.replace(/[^a-z0-9]/gi, "")));
      console.log(`  ⚠ "${model}" is not in that list.`);
      if (near.length > 0) console.log(`    Did you mean: ${near.slice(0, 4).join(", ")}?`);
    }
  }
  if (!model) {
    console.error("A model tag is needed to test the endpoint. Pass --model.");
    return "failed";
  }

  // ── 5. Prove it, before writing anything ─────────────────────────────────
  process.stdout.write(`  Running one token through ${name} as ${model}… `);
  const probe = await probeEndpointAuth(endpoint, model);
  if (!probe.ok) {
    console.log("failed.");
    console.error(`\n  ✗ ${probe.status ?? ""} ${(probe.detail ?? "no response").slice(0, 300)}`);
    if (probe.status === 401 || probe.status === 403) {
      console.error(
        `\n  The key is rejected for inference. Note that a model listing is not a\n` +
          `  test of a key — opencode.ai serves one to no key at all — so a working\n` +
          `  /models is not evidence here.\n` +
          `  Get a fresh key and run: gnomon key set ${keyEnv ?? name}`
      );
    } else if (probe.status === 404 || probe.status === 400) {
      if (modelWasChosenForYou) {
        // Say who picked it. This branch used to read "Either the URL or the
        // model tag is wrong for this provider" over a tag the user had never
        // typed, which sends them to check a URL that is fine.
        console.error(
          `\n  Nothing is necessarily wrong with the URL: \`${model}\` is the tag\n` +
            `  gnomon picked from what the endpoint listed, not one you gave.\n` +
            `  Name one yourself with:  gnomon endpoint add --preset ${args.flags.preset ?? name} --model <tag>`
        );
      } else {
        console.error(`\n  Either the URL or the model tag is wrong for this provider.`);
      }
    }
    console.error(`\n  Nothing was written to .gnomon/. Fix the above and run this again.`);
    return "failed";
  }
  console.log("ok.");

  // ── 6. Write the surface ─────────────────────────────────────────────────
  const configPath = join(config.gnomonDir, "config.toml");
  const before = readFileSync(configPath, "utf-8");
  writeFileSync(configPath, setEndpointBlock(before, name, { url, kind, api_key_env: keyEnv, provider }));
  console.log(`\n  ✓ .gnomon/config.toml — [endpoints.${name}]`);

  // ── 7. Point roles at it ─────────────────────────────────────────────────
  const roleNames = listRoles(config);
  let wanted = args.flags.role ?? args.role ?? "";
  if (!wanted && opts.quick) {
    // Every role that names a model. A role with no model inherits one and
    // follows along; touching it would turn an inheritance into a copy.
    wanted = roleNames.filter((r) => config.roles[r]?.model).join(",");
  }
  if (!wanted && interactive) {
    console.log(`\n  Roles: ${roleNames.join(", ")}`);
    wanted = await ask("  Point which at it? (comma-separated, blank for none): ", "");
  }
  const chosen = wanted
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  if (chosen.length > 0) {
    // Write where the role is actually resolved. A profile is merged OVER the
    // base role, so for a role the active profile declares -- which, in a
    // scaffolded project, is every role that has a model -- editing roles.toml
    // changes nothing a run reads, and this command used to report a routing
    // change that never happened. pointRoleAt then updates roles.toml to
    // match, so the next start has no disagreement between the files to warn
    // about.
    const edits = new Map<string, { label: string; text: string }>();
    for (const role of chosen) {
      if (!roleNames.includes(role)) {
        console.error(`  ⚠ no [roles.${role}] — skipped.`);
        continue;
      }
      // The cheap tier gets the cheap model init would have chosen, when
      // there is one. Pointing `smol` at the same 35B as everything else
      // works, and makes every summary cost a full reasoning turn.
      const tag = opts.quick && role === "smol" && smallModel ? smallModel : model;
      const { target } = pointRoleAt(config, role, tag, name, edits);
      console.log(
        `  ✓ ${role} → ${tag} @${name}` +
          (target.profile ? ` (via profile "${target.profile}")` : "")
      );
    }
    for (const [path, file] of edits) {
      writeFileSync(path, file.text);
      console.log(`  ✓ ${file.label}`);
    }
  }

  // The hash is a closing courtesy, and it is the one line here that needs a
  // native binary. Everything above it is already written, so on an install
  // with no `gnomon-surface` this used to throw AFTER the writes -- reporting
  // failure for a command that had succeeded.
  try {
    const hash = surfaceHash(config.gnomonDir);
    console.log(`\n  Surface now ${hash.slice(0, 16)}… — commit .gnomon/ to carry this to another machine.`);
  } catch {
    console.log(`\n  Written. Commit .gnomon/ to carry this to another machine.`);
  }
  return "written";
}

/**
 * Pick a model from what a local Ollama serves.
 *
 * `endpoint add --preset ollama` used to fall through to the generic listing,
 * which on a stopped Ollama printed `no list available` and asked for a tag
 * -- the wrong question for someone whose only problem was that the server
 * was not running. Now the two cases say different things: not running gets
 * the command that starts it (and, on a terminal, a re-check), running gets
 * a numbered list with init's own choice as the default.
 *
 * Undefined means the user gave up or there was nothing to pick.
 */
async function pickOllamaModel(
  chatUrl: string,
  interactive: boolean | undefined
): Promise<{ model: string; chosenForYou: boolean; small?: string } | undefined> {
  const tagsUrl = ollamaTagsUrl(chatUrl);
  for (;;) {
    process.stdout.write("  Asking Ollama what it serves… ");
    const listing = await listOllama(tagsUrl, 3000);
    let problem: string[] | null = null;
    if (!listing.reachable) {
      console.log(listing.refused ? "nothing there." : `no answer (${listing.why}).`);
      problem = listing.refused
        ? ollamaNotRunning(chatUrl)
        : [`Ollama at ${hostPort(chatUrl)} did not answer: ${listing.why}.`];
    } else if (listing.models.length === 0) {
      console.log("no models.");
      problem = [
        "Ollama is running but serves no models. Pull one first, e.g.:",
        "  ollama pull qwen3:8b",
      ];
    }
    if (problem) {
      for (const l of problem) console.log(`  ${l}`);
      if (!interactive) {
        console.error("\n  Nothing was written to .gnomon/. Run this again once it answers, or pass --model.");
        return undefined;
      }
      const again = await ask("\n  Press Enter to check again, or q to go back: ", "");
      if (/^q/i.test(again)) return undefined;
      continue;
    }

    const models = (listing as { models: DetectedModel[] }).models;
    const { ordered, suggested, small } = orderForPicking(models);
    console.log(`${models.length} model${models.length === 1 ? "" : "s"}.`);
    const names = ordered.map((m) => m.name);
    if (!interactive) return { model: suggested!, chosenForYou: true, small };

    const shown = ordered.slice(0, 30);
    const width = Math.min(44, Math.max(...shown.map((m) => m.name.length)));
    shown.forEach((m, i) => {
      // 566.70M parses to 0.5667000000000001; nobody picks a model by the
      // fourth decimal of its size.
      const size =
        m.billions <= 0 ? "" : m.billions >= 10 ? `${Math.round(m.billions)}B` : `${m.billions.toFixed(1)}B`;
      const note =
        m.name === suggested ? "← default" : looksLikeChatModel(m.name) ? "" : "(embedding — cannot chat)";
      console.log(`    ${String(i + 1).padStart(2)}. ${m.name.padEnd(width)}  ${size.padStart(5)}  ${note}`.trimEnd());
    });
    if (ordered.length > shown.length) console.log(`        …and ${ordered.length - shown.length} more (type the tag)`);
    const answer = await ask(`  Model [1 = ${suggested}]: `, "");
    const model = parseModelPick(answer, names, suggested!);
    return { model, chosenForYou: model === suggested, small };
  }
}

/** Ask an endpoint for its model list. Empty when it will not say. */
async function listModelsAt(endpoint: {
  url: string;
  kind: string;
  api_key_env?: string;
}): Promise<string[]> {
  const listUrl =
    endpoint.kind === "ollama"
      ? endpoint.url.replace(/\/api\/chat\/?$/, "/api/tags")
      : endpoint.url.replace(/\/chat\/completions\/?$/, "/models");
  const key = endpoint.api_key_env ? process.env[endpoint.api_key_env] : undefined;
  try {
    const res = await fetch(listUrl, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      models?: Array<{ name?: string; model?: string }>;
      data?: Array<{ id?: string }>;
    };
    return (json.models ?? [])
      .map((m) => m.name ?? m.model ?? "")
      .concat((json.data ?? []).map((m) => m.id ?? ""))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Deliver queued anchors from a detached process, so the session that queued
 * them can exit at once. Errors land in the anchors' state file, which the
 * next session announces (anchor.ts announceAnchorBacklog).
 */
function detachedAnchorFlush(s: ResolvedAnchor): void {
  // The settings this session started with, not the ones the session ended
  // with: a reload may have picked up what a contained command wrote.
  const settings = sessionAnchorFor(s);
  if (!settings?.enabled) return;
  // The launcher beside src/ (checkout) or dist/ (the published package):
  // gnomon.js in a checkout, bin/gnomon.mjs in the package (self_launcher.ts).
  // With neither, the flush runs in-process; flushAnchors releases its lock
  // on exit, and whatever it did not deliver stays queued for the next one.
  const launcher = selfLauncher(import.meta.url);
  if (!launcher) {
    void flushAnchors(settings).catch(() => undefined);
    return;
  }
  try {
    // Sealed in gnomon's data directory, outside the root (anchor.ts
    // writeAnchorHandoff): the settings and the remote as this session
    // resolved them at its start. The child reads nothing from the project
    // root -- a contained command may have rewritten [audit.anchor] there, and
    // the child would have run what it says (fourth review, finding 6). No
    // --trust either: the session already settled trust for these settings.
    const handoff = writeAnchorHandoff(settings);
    const args = [launcher, "audit", "anchor", "--background", "--anchor-handoff", handoff, "--dir", settings.root];
    const child = spawn(process.execPath, args, {
      cwd: settings.root,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1" },
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* stays queued; the next session announces it */
  }
}

/** [audit.anchor] as each session of this process started, by root. */
const sessionAnchors = new Map<string, ResolvedAnchor | undefined>();

/** Call where a session's trust is settled: these are the anchor settings its delivery uses. */
function pinSessionAnchor(config: GnomonConfig): void {
  try {
    const a = resolveAudit(config).anchor;
    sessionAnchors.set(resolve(config.gnomonDir, ".."), a);
  } catch {
    /* unresolvable: nothing is pinned, and nothing is delivered from it */
  }
}

function sessionAnchorFor(s: ResolvedAnchor): ResolvedAnchor | undefined {
  const root = resolve(s.root);
  return sessionAnchors.has(root) ? sessionAnchors.get(root) : s;
}

function anchorLabel(a: ResolvedAnchor): string {
  if (a.backend === "git") return `git, ${redactRemote(a.remote ?? "")} ${a.ref}`;
  if (a.backend === "rfc3161") return `rfc3161, ${redactRemote(a.url ?? "")}`;
  return String(a.backend);
}

/** One `external anchor:` line under a trail. Returns whether it is a failure. */
function printAnchorLine(r: AnchorTrailResult | undefined, acceptUnchecked = false): boolean {
  if (!r) return false;
  // A table, not a switch: docs.test.ts reads `case "…":` in this file as the
  // list of dispatched commands.
  const lines: Record<AnchorTrailResult["status"], [boolean, string]> = {
    anchored: [false, `ANCHORED — ${r.detail}`],
    rechained: [true, `RE-CHAINED — ${r.detail}`],
    invalid: [true, `INVALID — ${r.detail}`],
    unchecked: [!acceptUnchecked, `UNCHECKED — ${r.detail}`],
    pending: [false, "PENDING — queued, not delivered yet (degradation audit_anchor_queued). `gnomon audit anchor` delivers it now."],
    unanchored: [true, `NOT ANCHORED — ${r.detail}`],
    predates: [false, "NOT ANCHORED — sealed before this checkout began anchoring"],
    unsealed: [false, "NOT ANCHORED — not sealed, so there is no head to anchor"],
  };
  const [bad, text] = lines[r.status];
  (bad ? console.error : console.log)(`  external anchor: ${text}`);
  return bad;
}

/**
 * `gnomon audit` — list trails, and check one against everything that can
 * catch a change to it.
 *
 * WHAT `verify` USED TO DO, MEASURED 2026-09-02.
 *
 * A surface with `[audit.attest]` declaring an Ed25519 signer and a public key
 * wrote a three-record trail with a signed head over every record. The trail
 * was then fully re-chained — one field edited, every hash recomputed, file
 * written back — the exact attack `attest.ts` exists to catch and the one
 * documented as UNDETECTABLE by hash chaining alone:
 *
 *     $ gnomon audit verify        (before)
 *     sess-1.jsonl: 3 records — intact          [exit 0]
 *
 * Identical output before and after the tampering, and exit 0 both times. The
 * command called `verifyTrail(path)` with no options, and `opts.attest` is what
 * makes it look at the signatures at all — so the signer, the heads and every
 * test behind them were wired to nothing. And with no trails at all it looped
 * over an empty list and still exited 0: "verified" and "there was nothing to
 * verify" were the same answer.
 *
 * So: the resolved `[audit.attest]` is passed in, the three states are printed
 * as three different things, and an empty target list is an error.
 *
 * WHAT EACH LINE MEANS, and the limit on each:
 *   chain   — records hash to their own content and to their neighbour. Cannot
 *             see a full re-chain; that is what the attestation line is for.
 *   seal    — the trail ends with session_end. Reported apart from the chain
 *             because a killed run and a truncated file both land here.
 *   anchor  — SIGNED / BROKEN / NOT SIGNED / UNVERIFIABLE, against heads signed
 *             by a key this harness never holds.
 *
 * NOT SIGNED is not an error when the surface declares no signer: that is a
 * legitimate configuration, and failing it would make `verify` useless on the
 * default surface. It IS an error when a signer is declared and the heads are
 * missing — that is an anchor that was removed.
 */
async function cmdAudit(args: CliArgs): Promise<void> {
  // The audit record schema (CONTRACTS.md §55): what an outside reader of the
  // trail needs for THIS install, with no surface and no trail required.
  if (args.subcommand === "schema") {
    const text = readFileSync(fileURLToPath(new URL("../catalog/audit_record_schema.json", import.meta.url)), "utf-8");
    if (args.json) {
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      return;
    }
    const doc = JSON.parse(text) as {
      schema: string;
      classes: Record<string, string>;
      kinds: Record<string, { required: Record<string, { class: string }>; optional: Record<string, { class: string }> }>;
    };
    console.log(`${doc.schema}: the fields of every audit record, by kind, and what class each is.`);
    for (const [cls, why] of Object.entries(doc.classes)) console.log(`  ${cls}: ${why}`);
    console.log("");
    for (const [kind, spec] of Object.entries(doc.kinds)) {
      const mark = (o: Record<string, { class: string }>, opt: boolean) =>
        Object.entries(o).map(([n, f]) => `${n}${opt ? "?" : ""}${f.class === "content" ? " [content]" : f.class === "identifier" ? " [id]" : ""}`);
      console.log(`${kind}\n  ${[...mark(spec.required, false), ...mark(spec.optional, true)].join(", ")}`);
    }
    console.log("\n? optional. [content] may carry user, model or command text; [id] is a hash, id or path. Unmarked: metadata. --json prints the schema itself.");
    return;
  }
  // The detached delivery a session end starts: its settings are the sealed
  // ones the session handed it, and nothing is read from the project root.
  const handoff = args.flags["anchor-handoff"];
  if (args.subcommand === "anchor" && args.flags.background === "true" && handoff && handoff !== "true") {
    try {
      await flushAnchors(readAnchorHandoff(handoff));
    } catch {
      /* stays queued; the next session announces it */
    }
    return;
  }
  // The trajectory scan (audit_scan.ts): offline, over trails named on the
  // command line, so it needs no surface and loads none.
  if (args.subcommand === "scan") {
    const { scanPath, formatScan, AUDIT_SCAN_SCHEMA, AUDIT_SCAN_EXIT, SEVERITIES } = await import("./audit_scan.js");
    const min = args.flags["min-severity"];
    if (min !== undefined && !(SEVERITIES as readonly string[]).includes(min)) {
      process.exit(commandError(args, AUDIT_SCAN_SCHEMA, `--min-severity ${min}: use one of ${SEVERITIES.join(", ")}.`, AUDIT_SCAN_EXIT.couldNotRun));
    }
    try {
      const target = args.positional[0] ?? join(projectRoot(args), ".gnomon-audit");
      const report = scanPath(target, { minSeverity: min as (typeof SEVERITIES)[number] | undefined });
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else for (const l of formatScan(report)) console.log(l);
      if (report.exit !== 0) process.exit(report.exit);
    } catch (err) {
      process.exit(commandError(args, AUDIT_SCAN_SCHEMA, `audit scan could not run: ${err instanceof Error ? err.message : String(err)}`, AUDIT_SCAN_EXIT.couldNotRun));
    }
    return;
  }
  const config = loadConfig(args.dir, args.flags['profile']);
  const settings = resolveAudit(config);
  // [audit.anchor] pushes to a remote, posts to an authority or runs a
  // command: a workspace-trust grant (trust.ts). `audit anchor` and `audit
  // verify` reach it only for a surface this machine's user trusts, or with
  // --trust / GNOMON_TRUST; otherwise they see the clamped block, which says
  // why and does nothing.
  if (settings.anchor?.declared) {
    const ev = evaluateTrust(config, trustOptions(args));
    if (ev.status !== "trusted" && ev.status !== "default") {
      settings.anchor = resolveAudit(clampToDefaults(config)).anchor;
    }
  }
  const sub = subcommandOr(args, "show");

  // Process metrics (metrics.ts): counts over the verified session trails.
  if (sub === "metrics") {
    const { buildMetricsReport, formatMetrics, METRICS_SCHEMA, METRICS_EXIT } = await import("./metrics.js");
    const lastFlag = args.flags.last;
    const last = lastFlag && lastFlag !== "true" ? Number(lastFlag) : undefined;
    if (last !== undefined && !(Number.isInteger(last) && last > 0)) {
      process.exit(commandError(args, METRICS_SCHEMA, `--last needs a positive whole number, not ${lastFlag}.`, METRICS_EXIT.couldNotRun));
    }
    const session = args.flags.session && args.flags.session !== "true" ? args.flags.session : undefined;
    try {
      const report = buildMetricsReport(projectRoot(args), { last, session });
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else for (const l of formatMetrics(report)) console.log(l);
      if (report.exit !== 0) process.exit(report.exit);
    } catch (err) {
      process.exit(commandError(args, METRICS_SCHEMA, `metrics could not run: ${err instanceof Error ? err.message : String(err)}`, METRICS_EXIT.couldNotRun));
    }
    return;
  }

  // Failure attribution (attribute.ts): why a session failed, by harness layer.
  if (sub === "attribute") {
    const { buildAttributeReport, formatAttribute, ATTRIBUTE_EXIT } = await import("./attribute.js");
    const { ATTRIBUTION_SCHEMA } = await import("gnomon-core");
    const lastFlag = args.flags.last;
    const last = lastFlag && lastFlag !== "true" ? Number(lastFlag) : undefined;
    if (last !== undefined && !(Number.isInteger(last) && last > 0)) {
      process.exit(commandError(args, ATTRIBUTION_SCHEMA, `--last needs a positive whole number, not ${lastFlag}.`, ATTRIBUTE_EXIT.couldNotRun));
    }
    try {
      const report = buildAttributeReport(projectRoot(args), { last, trails: args.positional });
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else for (const l of formatAttribute(report)) console.log(l);
      if (report.exit !== 0) process.exit(report.exit);
    } catch (err) {
      process.exit(commandError(args, ATTRIBUTION_SCHEMA, `attribute could not run: ${err instanceof Error ? err.message : String(err)}`, ATTRIBUTE_EXIT.couldNotRun));
    }
    return;
  }

  // record_tamper events (record_guard.ts): list them, and let a person
  // resolve one. Accepting a skill is refused while any is unresolved.
  if (sub === "tamper") {
    const open = unresolvedTamper(config);
    if (open.length === 0) {
      console.log("No unresolved record_tamper events.");
      return;
    }
    console.log(`${open.length} unresolved record_tamper event(s):`);
    for (const e of open) {
      const changes = (e.record.changes as Array<{ path: string; change: string }> | undefined) ?? [];
      const by = e.record.tool ? `${String(e.record.tool)} ${String(e.record.target ?? "")}`.trim() : String(e.record.when);
      console.log(`  ${e.trail}:${e.seq}  ${by}`);
      for (const c of changes.slice(0, 10)) console.log(`      ${c.change} ${c.path}`);
    }
    console.log('Resolve one with `gnomon audit resolve <trail>:<seq> --reason "…"` after looking at what changed.');
    process.exit(3);
  }
  if (sub === "resolve") {
    const ref = args.positional[0] ?? "";
    const m = /^(.+):(\d+)$/.exec(ref);
    const reason = typeof args.flags.reason === "string" && args.flags.reason !== "true" ? args.flags.reason : "";
    if (!m) {
      console.error('Usage: gnomon audit resolve <trail>:<seq> --reason "…"   (see `gnomon audit tamper`)');
      process.exit(1);
    }
    try {
      // A person at a terminal: stdin AND stdout. A tool subprocess has pipes.
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const out = resolveTamper(config, { trail: m[1]!, seq: Number(m[2]) }, reason, { interactive });
      console.log(`Resolved ${ref}. Recorded in ${out.trail} (seq ${out.record.seq}).`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(/agent session/.test(String(err)) ? 3 : 1);
    }
    return;
  }

  // Deliver queued anchors now. `--background` is the detached delivery a
  // session end starts: it prints nothing, and its outcome is the anchors'
  // state file, which the next session reads.
  if (sub === "anchor") {
    const anchor = settings.anchor;
    const background = args.flags.background === "true";
    if (!anchor?.declared) {
      if (!background) console.error("No [audit.anchor] is declared in .gnomon/config.toml, so nothing is anchored.");
      process.exit(1);
    }
    if (!anchor.enabled) {
      if (!background) for (const p of anchor.problems) console.error(p);
      process.exit(1);
    }
    const r = await flushAnchors(anchor);
    if (background) return;
    for (const p of anchor.problems) console.error(p);
    if (r.busy) {
      console.log(`A delivery is already running; ${r.pending} head(s) queued.`);
      return;
    }
    if (r.delivered > 0) console.log(`Anchored ${r.delivered} sealed head(s) to ${anchorLabel(anchor)}.`);
    if (r.pending > 0) {
      console.error(`${r.pending} head(s) still queued: ${r.error ?? "not delivered"}`);
      process.exit(1);
    }
    if (r.delivered === 0) console.log("Nothing queued: every sealed head has been delivered.");
    return;
  }

  if (sub !== "show" && sub !== "list" && sub !== "verify") {
    console.error(`Unknown audit subcommand: ${sub}. Use: show | verify | anchor | tamper | metrics | attribute | scan | schema | resolve`);
    process.exit(1);
  }

  const trails = existsSync(settings.dir)
    ? readdirSync(settings.dir)
        .filter((f: string) => f.endsWith(".jsonl"))
        .sort()
    : [];

  if (sub === "show" || sub === "list") {
    if (!existsSync(settings.dir)) {
      console.log(`No audit trail at ${settings.dir}`);
      console.log(
        settings.enabled
          ? "Auditing is enabled but nothing has been recorded yet."
          : "Auditing is off. Set [audit].enabled = true in .gnomon/config.toml."
      );
      return;
    }
    console.log(`Trails in ${settings.dir}:`);
    for (const t of trails) console.log(`  ${t}`);
    if (trails.length === 0) console.log("  (none)");
    return;
  }

  // ── verify ────────────────────────────────────────────────────────────────
  const targets = args.positional.length > 0 ? args.positional : trails;
  if (targets.length === 0) {
    // Exit 1, not 0. A gate that answers "verified" when it verified nothing is
    // the failure this repository keeps hitting; `audit verify` is the last
    // thing that should have it. A caller gating a release on this exit code
    // gets "no evidence", which is not "no problem".
    console.error(`gnomon audit verify: nothing to verify.`);
    console.error(`  Looked in ${settings.dir} for *.jsonl and found none.`);
    console.error(
      settings.enabled
        ? `  [audit].enabled is true, so a trail appears once a session runs.`
        : `  [audit].enabled is false in .gnomon/config.toml — nothing is being recorded.`
    );
    process.exit(1);
  }

  const attest = settings.attest;
  // Reported once, above the trails: a public key that would not load makes
  // every line below say "unverifiable" for a reason nobody would otherwise be
  // told, which reads exactly like "nothing was ever signed".
  for (const problem of attest?.problems ?? []) {
    console.error(`[audit.attest] ${problem}`);
  }

  // [audit.anchor]: every sealed head against the external witness. Read
  // once, before the loop, so each trail's lines can carry its own verdict.
  const anchor = settings.anchor;
  let anchorReport: ReturnType<typeof verifyAgainstAnchors> | null = null;
  let anchorFailed = false;
  const offline = args.flags.offline === "true";
  // --offline exits on the chain, the seal and the signature, and on what this
  // machine's copy of the witness shows (a re-chain, an invalid or missing
  // anchor, a rollback). An anchor it cannot check here -- the block untrusted
  // or unworkable on this machine, no local copy yet -- is reported and does
  // not fail it: a loop guard on it must tell tamper from a fresh checkout
  // (#207, CONTRACTS.md §14).
  const offlineNote = "(--offline: reported, not counted against the exit)";
  if (anchor?.declared) {
    for (const p of anchor.problems) console.error(p);
    if (!anchor.enabled) {
      if (offline) console.log(`external anchor: NOT CHECKED here — the [audit.anchor] block cannot work on this machine ${offlineNote}`);
      else anchorFailed = true;
    } else {
      const scope = typeof args.flags.scope === "string" && args.flags.scope !== "true" ? args.flags.scope : undefined;
      const log = await collectAnchors(anchor, { offline });
      const cpDir = join(settings.dir, CHECKPOINT_DIR);
      const checkpoints = existsSync(cpDir)
        ? readdirSync(cpDir).filter((f: string) => /^checkpoint-.*\.jsonl$/.test(f)).map((f: string) => join(cpDir, f))
        : [];
      const paths = [...targets.map((n) => join(settings.dir, n)).filter((p) => existsSync(p)), ...checkpoints];
      anchorReport = verifyAgainstAnchors(anchor, log, paths, {
        ...(scope ? { scope } : {}),
        acceptUnchecked: offline,
        acceptUnreadable: offline,
      });
      const from = log.source === "remote" ? "read from the remote" : log.source === "local-copy" ? "read from THIS MACHINE'S COPY" : "read from the receipts";
      console.log(`external anchor: ${anchorLabel(anchor)} — ${from}, scope ${anchorReport.scope}`);
      for (const p of anchorReport.problems) console.error(`  ${p}${offline ? ` ${offlineNote}` : ""}`);
    }
  }
  const anchorOf = (path: string) =>
    anchorReport?.trails.find((t) => resolve(anchor!.root, t.trail) === resolve(path) || t.trail === resolve(path));

  let allOk = true;
  for (const name of targets) {
    const path = join(settings.dir, name);
    // `attest` is passed unconditionally. When no signer is declared it is
    // resolved-but-disabled and costs one existsSync, and it is what lets the
    // NOT SIGNED line below be printed at all.
    const r = verifyTrail(path, attest ? { attest } : {});

    if (!existsSync(path)) {
      console.error(`${name}: no such trail in ${settings.dir}`);
      allOk = false;
      continue;
    }

    const chain = r.ok ? "chain intact" : `chain BROKEN at seq ${r.broken.join(", ")}`;
    // A trail that was sealed and then grew is not the killed run NOT SEALED
    // describes: a killed run never wrote a seal. Exit 1 (verifyTrail,
    // VerifyResult.after_seal); GBS-AUDIT 0.1 case I1 passed it with exit 0.
    const seal = r.after_seal
      ? `APPENDED AFTER SEAL at seq ${r.after_seal.seq}`
      : r.sealed
        ? "sealed"
        : "NOT SEALED (truncated, or the run was killed)";
    console.log(`${name}: ${r.records} records — ${chain}, ${seal}`);
    if (!r.ok) allOk = false;
    if (r.after_seal) {
      console.error(`  TAMPERED — ${r.after_seal.detail}`);
      allOk = false;
    }

    const a = r.attestation;
    if (!a) {
      // Only reachable if resolveAudit ever stops resolving [audit.attest].
      console.log(`  anchor: NOT CHECKED — no attestation settings were resolved`);
      allOk = false;
      continue;
    }

    if (a.status === "signed") {
      console.log(
        `  anchor: SIGNED — ${a.verified}/${a.heads} head(s) verified, covered through seq ${a.covered_through}`
      );
      if (a.unattested > 0) {
        console.log(`          ${a.unattested} later record(s) are chained but not yet anchored`);
      }
    } else if (a.status === "broken") {
      console.error(`  anchor: BROKEN — ${a.problem}`);
      allOk = false;
    } else if (a.status === "unverifiable") {
      console.error(`  anchor: UNVERIFIABLE — ${a.problem}`);
      console.error(`          heads: ${a.heads_path}`);
      allOk = false;
    } else if (a.declared) {
      // A signer IS declared and there are no usable heads. The anchor was
      // removed, or signing failed at write time; either way this trail is not
      // protected against the re-chain and must not read as if it were.
      console.error(`  anchor: NOT SIGNED — ${a.problem}`);
      console.error(`          [audit.attest] declares a signer, so heads were expected here.`);
      allOk = false;
    } else if (anchorReport) {
      // The external anchor line below is what answers the re-chain here, so
      // the advice to declare a signer would point at the wrong fix.
      console.log(`  anchor: NOT SIGNED — this surface declares no [audit.attest] signer; the external anchor below is the check against a re-chain.`);
    } else {
      console.log(`  anchor: NOT SIGNED — this surface declares no [audit.attest] signer.`);
      console.log(
        `          The chain above proves the file is internally consistent, not that it`
      );
      console.log(
        `          is the file that was written: rewriting a record and recomputing every`
      );
      console.log(
        `          hash passes it. Declare a signer to close that.`
      );
    }
    if (printAnchorLine(anchorOf(path), offline)) allOk = false;
  }

  if (anchorReport) {
    // Checkpoints are not listed above (they are in a subdirectory), but they
    // are anchored too: a rewritten one is the forged baseline the record
    // guard would otherwise trust.
    for (const t of anchorReport.trails.filter((x) => x.trail.includes(`/${CHECKPOINT_DIR}/`))) {
      if (t.status === "anchored" || t.status === "predates" || t.status === "pending" || t.status === "unsealed") continue;
      console.log(`${t.trail}:`);
      if (printAnchorLine(t, offline)) allOk = false;
    }
    for (const f of anchorReport.findings) console.error(`  external anchor: ${f}`);
    if (anchorReport.other_scopes > 0) {
      console.log(`  (${anchorReport.other_scopes} anchor(s) from other checkouts share this witness; not judged here)`);
    }
    if (!anchorReport.ok) allOk = false;
  }
  if (anchorFailed) allOk = false;

  if (!allOk) process.exit(1);
}

async function cmdTask(args: CliArgs): Promise<void> {
  let text = [args.subcommand, ...args.positional].filter(Boolean).join(" ").trim();
  // Every way out of this command exits 0, 2 or 10, the bucket, as
  // docs/CONTRACTS.md §1 says it does. A missing task and a missing surface
  // both used to exit 1, which is `failed` in the `result` bucket: a caller
  // switching on the bucket read a task that never started as one that ran.
  // Neither started, so both are launch failures (10).
  //
  // `--task-file <path>` (`-` for stdin) reads the text instead, so a wrapper
  // need not put it on a command line at all. gnomon renames its own
  // (proc_title.ts), but a wrapper's `sh -c 'gnomon task "..."'` carried the
  // task text too, and a model's `pkill -f <a word from the task>` matched it.
  const taskFile = args.flags["task-file"];
  if (taskFile !== undefined) {
    if (text) {
      console.error("gnomon task: give the task as text or with --task-file, not both");
      process.exit(10);
    }
    if (taskFile === "") {
      console.error("gnomon task: --task-file needs a path, or - for stdin");
      process.exit(10);
    }
    try {
      text = readFileSync(taskFile === "-" ? 0 : taskFile, "utf-8").trim();
    } catch (err) {
      console.error(`gnomon task: --task-file ${taskFile}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(10);
    }
  }
  if (!text) {
    console.error('Usage: gnomon task "<what to do>" | --task-file <path|-> [--role <name>] [--yes] [--json] [--deadline <seconds|ISO time>]');
    process.exit(10);
  }

  // `--deadline`, else GNOMON_DEADLINE: seconds from now or an ISO 8601 time.
  // A value that is not one is a launch failure (10), said, never ignored: a
  // benchmark adapter that misspelt it would otherwise run with no clock.
  const deadlineRaw = args.flags["deadline"] ?? process.env.GNOMON_DEADLINE;
  let deadline: { at: number; source: "flag" | "env" } | undefined;
  if (deadlineRaw !== undefined && deadlineRaw !== "") {
    const parsed = parseDeadline(deadlineRaw);
    if ("error" in parsed) {
      console.error(`gnomon task: ${parsed.error}${args.flags["deadline"] === undefined ? " (from GNOMON_DEADLINE)" : ""}`);
      process.exit(10);
    }
    deadline = { at: parsed.at, source: args.flags["deadline"] !== undefined ? "flag" : "env" };
  }

  // `--attempts <k>`: k speculative attempts in k clones, the first to pass
  // the external check wins (attempts_run.ts, docs/CONTRACTS.md §60). Absent
  // or 1, none of this runs and the task is the task it always was.
  const attemptsRaw = args.flags["attempts"];
  if (attemptsRaw !== undefined) {
    const k = /^\d+$/.test(attemptsRaw) ? Number(attemptsRaw) : 0;
    if (k < 1) {
      console.error(`gnomon task: --attempts needs a whole number of 1 or more, got "${attemptsRaw}"`);
      process.exit(10);
    }
    if (k > 1) {
      let result: AttemptsReport;
      try {
        const base = loadConfig(args.dir, args.flags["profile"]);
        const settled = settleTrustHeadless(base, trustOptions(args));
        result = await runAttempts({
          config: settled.config,
          text,
          k,
          role: args.role,
          yes: args.yes,
          apply: args.flags["apply"] === "true",
          profile: args.flags["profile"],
          deadline: args.flags["deadline"],
          requireVerify: args.flags["require-verify"] === "true",
          ...(settled.outcome && settled.outcome.decision !== "clamped" ? { trustHash: settled.outcome.surface_hash } : {}),
          log: args.json ? undefined : (line) => console.error(line),
        });
      } catch (err) {
        if (err instanceof TrustRequiredError) exitTrustRequired(err, Boolean(args.json));
        console.error(`gnomon task --attempts could not start: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(10);
      }
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else if (result.attempts.length === 0) console.error(`gnomon task --attempts: ${result.reason}`);
      else console.log(formatAttemptsReport(result));
      process.exit(result.exit);
    }
  }

  // A task has nobody to ask. An untrusted surface that grants more than the
  // defaults runs clamped to them, with one line on stderr -- never blocked,
  // never silently widened.
  let record: TaskRecord;
  let requireVerify = args.flags["require-verify"] === "true";
  // A time cap's SIGTERM (Harbor, Terminal-Bench), a closed terminal, a kill
  // -INT: the run's record is flushed as `killed` -- the live record beside
  // the trail, a `turn` audit record and session_end -- and, under --json,
  // printed where the record always goes. Then the signal ends the process as
  // it did before (live_record.ts onKillSignal). Before this, a killed task
  // printed nothing at all (C5: 19 of 21 capped cells in P2G attempt 1).
  const interrupt: TaskInterrupt = {};
  const releaseSignals = onKillSignal((signal) => {
    const killed = interrupt.kill?.(signal);
    if (!killed) return;
    try {
      if (args.json) writeSync(1, `${JSON.stringify(killed, null, 2)}\n`);
      else if (killed.stop_reason === "killed") {
        writeSync(2, `\n[${signal}] the run was ended mid-turn; recorded as stop_reason "killed" after ${killed.tool_steps} tool call(s)\n`);
      }
    } catch {
      // A closed pipe or terminal: the file beside the trail still has it.
    }
  });
  try {
    const settled = settleTrustHeadless(
      loadConfig(args.dir, args.flags['profile']),
      trustOptions(args)
    );
    pinSessionAnchor(settled.config);
    requireVerify = verifyExitRequested(settled.config, requireVerify);
    record = await runTask(settled.config, text, {
      role: args.role,
      yes: args.yes,
      ...(args.flags["require-verify"] === "true" ? { requireVerify: true } : {}),
      verbose: !args.json,
      trust: settled.outcome,
      interrupt,
      ...(deadline ? { deadline } : {}),
    });
  } catch (err) {
    // No .gnomon/ above the cwd, a --dir without one, a --role the surface
    // does not define: the throw used to reach main's catch and exit 1. It
    // gets the same record shape as a fatal surface, so --json still parses.
    // But only a throw from before the run started could not start. One
    // after it (runTask set interrupt.fail when its live record opened) ends
    // that run on its own record -- code 10, stop_reason "apparatus", its
    // steps and clock, the trail sealed -- printed below like any other. dc1
    // (2026-11-12) lost a 58-call run to this catch as "could not start",
    // tool_steps 0, duration 0. (A throw inside the turn no longer leaves
    // runTask at all: the turn ends on it.)
    if (err instanceof TrustRequiredError) exitTrustRequired(err, Boolean(args.json));
    const why = err instanceof Error ? err.message : String(err);
    record = (await interrupt.fail?.(err)) ?? unstartedTaskRecord(text, args.role, `gnomon task could not start: ${why}`);
  }
  releaseSignals();

  // Non-fatal surface problems go to stderr in BOTH modes. They are the ones
  // that change what ran without stopping it -- a role_profile whose file is
  // missing, an edit format nothing implements -- and --json used to be the
  // mode where they were least visible and most consequential. stderr, so a
  // caller piping stdout to a parser still gets clean JSON.
  for (const p of record.surface_problems ?? []) {
    if (!p.fatal) console.error(`  ⚠ ${p.where}: ${p.problem}`);
  }

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
  process.exit(taskExitCode(record, { requireVerify }));
}

async function cmdSkill(args: CliArgs): Promise<void> {
  const config = loadConfig(args.dir, args.flags['profile']);
  const sub = subcommandOr(args, "list");
  const id = args.positional[0];

  if (sub === "mine") {
    // Deterministic and model-free: reads the audit trails, writes evidence
    // to .gnomon-skills/candidates/, and changes nothing the agent loads.
    const found = mineCandidates(config);
    const w = writeCandidates(config, found);
    // Signals about skills that already exist, from `skill_use` records.
    const usage = readSkillUsage(config);
    const usageSignals = skillUsageSignals(usage);
    if (args.json) {
      console.log(JSON.stringify({ dir: w.dir, fresh: w.fresh, candidates: found, skill_usage: [...usage.values()], skill_signals: usageSignals }, null, 2));
      return;
    }
    if (found.length === 0) {
      console.log("No skill candidates: no rule refused the same role on the same thing " +
        `${MIN_REPEATS} or more times in the audit trails.`);
    } else {
      console.log(`${found.length} skill candidate(s), ${w.fresh.length} new → ${w.dir}`);
      for (const c of found) {
        console.log(`  ${c.id}${w.fresh.includes(c.id) ? "  (new)" : ""}`);
        console.log(`      ${c.suggestion}`);
        console.log(`      ${c.records.length} record(s), first ${c.records[0]!.trail} seq ${c.records[0]!.seq}`);
      }
      console.log("Candidates are evidence, not skills: nothing is loaded until a person accepts one.");
    }
    console.log(`\nSkills in use (from skill_use records): ${usageSignals.length} signal(s)`);
    for (const h of usageSignals) console.log(`  ${h.skill} [${h.signal}]\n      ${h.suggestion}`);
    const costly = [...usage.values()]
      .filter((u) => u.tokens_per_firing !== null)
      .sort((x, y) => y.tokens_per_firing! - x.tokens_per_firing!);
    for (const u of costly) console.log(`  ${u.id}: ${u.firings} firing(s), ~${u.tokens_per_firing} tok each, cited ${u.cited}×`);
    return;
  }

  if (sub === "list" && (args.flags["candidates"] !== undefined || args.positional.includes("--candidates"))) {
    const found = loadCandidates(config);
    console.log("Candidates (.gnomon-skills/candidates/) — evidence, not loaded:");
    if (found.length === 0) console.log("  (none — run `gnomon skill mine`)");
    for (const c of found) console.log(`  ${c.id} — ${c.rule} × ${c.count} on ${c.pattern} (${c.role || "any role"})`);
    return;
  }

  if (sub === "trial") {
    // docs/CONTRACTS.md §13: 0 meets the declared thresholds, 2 does not, 10
    // no answer (apparatus failure, budget, or an effect below significance).
    // A trial that cannot start is 10 as well: it produced no answer.
    if (!id) {
      console.error("Usage: gnomon skill trial <id> [--spec <name>] [--yes] [--yes-spend] [--trust] [--json]");
      process.exit(10);
    }
    const specName = typeof args.flags.spec === "string" && args.flags.spec !== "true" ? args.flags.spec : undefined;
    const yesSpend = args.flags["yes-spend"] !== undefined || args.positional.includes("--yes-spend");
    let outcome: Awaited<ReturnType<typeof runTrial>>;
    try {
      // Trust is settled ONCE, on this checkout under the spec's profile --
      // the configuration the cells actually run (runTrial calls this).
      // Trust is keyed by a project's real path, so settling it per cell
      // found every temporary clone untrusted and ran it clamped, while the
      // report named the declared surface; settling it on the default profile
      // missed grants the spec's profile adds. A clamped outcome is refused by
      // the trial; a trusted one runs its cells as declared (their surface is
      // this checkout's, which the trial checks, plus the skill).
      let trust: TrustOutcome | undefined;
      outcome = await runTrial(config, {
        skill: id,
        spec: specName,
        yesSpend,
        settleTrust: (c) => (trust = settleTrustHeadless(c, trustOptions(args)).outcome),
        // Each cell is a `gnomon task` in its own clone, with the approval
        // rule of `gnomon task`: --yes approves gated calls in the clone;
        // without it they are refused.
        runCell: (wt, prompt, o) =>
          runTask(loadConfig(wt, o.profile), prompt, {
            role: o.role,
            yes: args.yes,
            trust,
          }),
        log: args.json ? undefined : (line) => console.error(line),
      });
    } catch (err) {
      console.error(`gnomon skill trial could not start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(10);
    }
    const { report, cells } = outcome;
    const out = recordTrial(config, report, cells);
    if (args.json) {
      console.log(JSON.stringify({ ...report, report_path: out.report_path, report_sha256: out.report_sha256 }, null, 2));
    } else {
      const p = report.endpoints.pass;
      console.log(`Trial of ${id} on ${report.model ?? "?"} (${report.role}), ${report.pairs.valid}/${report.pairs.planned} valid pairs`);
      console.log(`  pass       base ${p.base.passes}/${p.base.n}  skill ${p.skill.passes}/${p.skill.n}  McNemar p = ${p.mcnemar_p}`);
      const t = report.endpoints.output_tokens;
      console.log(`  out tokens base ${t.base}  skill ${t.skill}  gain ${t.gain === null ? "?" : `${(t.gain * 100).toFixed(1)}%`}  sign p = ${t.sign.p.toFixed(4)}`);
      console.log(`  requests   base ${report.endpoints.requests.base}  skill ${report.endpoints.requests.skill}`);
      console.log(`  cells      ${report.cells.result} result, ${report.cells.refusal} refusal, ${report.cells.apparatus_failure} apparatus_failure`);
      console.log(`  meets_thresholds: ${String(report.meets_thresholds)} (${report.status})`);
      for (const r of report.reasons) console.log(`    ${r}`);
      if (report.leftovers.length > 0) {
        console.log(`  leftovers  ${report.leftovers.length} sandbox(es) could not be removed:`);
        for (const l of report.leftovers) console.log(`    ${l}`);
      }
      console.log(`Report: ${out.report_path}`);
      if (out.record) console.log(`Recorded in ${out.trail} (seq ${out.record.seq}, ${out.record.hash?.slice(0, 12)})`);
      console.log("Nothing was accepted. `gnomon skill accept` remains a person's decision.");
    }
    process.exit(trialExit(report.meets_thresholds));
  }

  if (sub === "list") {
    const active = loadSkills(config);
    const pending = loadProposedSkills(config);
    // A skill whose front matter did not parse still lists, and says so. It
    // used to list looking exactly like a working one — `use-tabs — use-tabs`,
    // the id standing in for the description it never read.
    const show = (s: { id: string; name: string; description?: string; problem?: string }) => {
      console.log(`  ${s.id} — ${s.description ?? s.name}`);
      if (s.problem) console.log(`      ⚠ ${s.problem}`);
    };
    console.log("Active (.gnomon/skills/):");
    if (active.length === 0) console.log("  (none)");
    for (const s of active) show(s);
    console.log("\nProposed (.gnomon/skills/proposed/) — not loaded:");
    if (pending.length === 0) console.log("  (none)");
    for (const s of pending) show(s);
    return;
  }

  if (sub === "accept" || sub === "reject") {
    if (!id) {
      console.error(`Usage: gnomon skill ${sub} <id>`);
      process.exit(1);
    }
    try {
      // Every decision leaves a record: the skill's content hash and the
      // surface hash before and after, in a sealed trail of its own.
      const recorded = (d: { record: { seq: number; hash?: string } | null; trail: string | null; sealed: boolean }) => {
        if (d.trail && d.record) {
          console.log(`Recorded in ${d.trail} (seq ${d.record.seq}, ${d.record.hash?.slice(0, 12) ?? "unchained"})`);
        }
        if (!d.sealed) {
          console.error("⚠ The change was made and recorded, but the trail could not be sealed; `gnomon audit verify` will report it unsealed.");
        }
      };
      if (sub === "accept") {
        const evidence = typeof args.flags.evidence === "string" && args.flags.evidence !== "true"
          ? args.flags.evidence
          : undefined;
        const d = acceptSkill(config, id, { evidence });
        const ev = d.record?.evidence as { report?: string; meets_thresholds?: unknown } | string | undefined;
        if (ev && typeof ev === "object") {
          console.log(`Evidence: ${ev.report} (meets_thresholds: ${String(ev.meets_thresholds)})`);
        }
        console.log(`Accepted ${id} → ${d.path}`);
        console.log(
          "The surface hash has changed. The skill loads from the next session."
        );
        recorded(d);
      } else {
        const reason = typeof args.flags.reason === "string" && args.flags.reason !== "true"
          ? args.flags.reason
          : undefined;
        const d = rejectSkill(config, id, { reason });
        console.log(`Rejected ${id}`);
        recorded(d);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      // A rule saying no -- an agent session, require_trial, evidence that
      // does not vouch, an unresolved tamper event: every SkillRefusal -- is
      // a refusal (3, refused_by_gate, docs/CONTRACTS.md §1), not the
      // `failed` result 1 means. Anything else (no such proposal, a bad id,
      // an unwritable trail) stays 1.
      process.exit(err instanceof SkillRefusal ? 3 : 1);
    }
    return;
  }

  if (sub === "export") {
    // Opt-in: a dry run unless --write, and only ever outside .gnomon/. Exit 0 done, 2 something refused, 1 usage.
    const to = typeof args.flags["to"] === "string" && args.flags["to"] !== "true" ? args.flags["to"] : undefined;
    const format = (typeof args.flags["format"] === "string" ? args.flags["format"] : "skill-md") as SkillExportFormat;
    if (!(SKILL_EXPORT_FORMATS as readonly string[]).includes(format)) {
      console.error(`gnomon skill export: --format is one of ${SKILL_EXPORT_FORMATS.join(", ")} (got "${format}")`);
      process.exit(1);
    }
    const write = args.flags["write"] !== undefined;
    const result = exportSkills(config, { project: resolve(args.dir ?? process.cwd()), to, format, write });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${write ? "Exported" : "Would export"} ${result.items.length} gnomon skill(s) as ${result.format} to ${result.dir} (surface ${result.surface_hash.slice(0, 12)}):`);
      for (const i of result.items) {
        const verb = write ? { create: "wrote", update: "updated", unchanged: "unchanged", refuse: "REFUSED" }[i.action] : { create: "create", update: "update", unchanged: "unchanged", refuse: "REFUSE" }[i.action];
        console.log(`  ${verb.padEnd(9)} ${i.name || i.id}/SKILL.md${i.reason ? `  (${i.reason})` : ""}`);
      }
      if (result.items.length === 0) console.log("  (no active skills in .gnomon/skills/)");
      if (!write) console.log(`\nNothing written. Re-run with --write to write these (default directory ${SKILL_EXPORT_DEFAULT_DIR}; --to <dir>, e.g. .agents/skills for Codex).`);
    }
    process.exit(result.items.some((i) => i.action === "refuse") ? 2 : 0);
  }

  console.error(`Unknown skill subcommand: ${sub}. Use: list | accept | reject | mine | trial | export`);
  process.exit(1);
}

async function cmdMigrate(args: CliArgs): Promise<void> {
  const check = args.flags.check === "true";
  let gnomonDir: string;
  try {
    gnomonDir = args.dir ? join(resolve(args.dir), ".gnomon") : resolveGnomonDir();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!existsSync(gnomonDir)) {
    console.error(
      `No .gnomon/ at ${gnomonDir} — nothing to migrate. ` +
        `\`gnomon init\` writes a new surface at the current defaults.`
    );
    process.exit(1);
  }

  const before = recomputeManifest(gnomonDir).surface_hash;
  const pending = pendingMigrations(gnomonDir);

  console.log(`${gnomonDir}`);
  console.log(`  surface ${before.slice(0, 16)}…\n`);

  if (pending.length === 0) {
    console.log(
      `Already current — nothing to change (${MIGRATIONS.length} migration(s) known).`
    );
    return;
  }

  for (const p of pending) {
    console.log(`  [${p.id}]  .gnomon/${p.file}`);
    console.log(`    ${p.what}`);
    for (const line of p.why) console.log(`      ${line}`);
    console.log();
  }

  if (check) {
    console.log(
      `${pending.length} change(s) pending. Nothing was written (--check).\n` +
        `Run \`gnomon migrate\` to apply them.`
    );
    // Non-zero so CI can gate on it.
    process.exit(1);
  }

  applyMigrations(pending);
  const after = recomputeManifest(gnomonDir).surface_hash;
  console.log(`${pending.length} change(s) applied.`);
  console.log(`  surface ${before.slice(0, 16)}… → ${after.slice(0, 16)}…`);
  console.log(
    `\nThe surface hash moved, which is the point: behaviour changed and the\n` +
      `record now says so. Review with \`git diff .gnomon/\` and commit it.\n` +
      `If you had chosen one of these values deliberately, revert that line —\n` +
      `this command cannot tell a chosen value from an inherited one.`
  );
}

async function cmdInit(args: CliArgs, opts: { launching?: boolean } = {}): Promise<void> {
  // What this machine is and which model servers it runs, probed beside init's
  // own model detection so it costs no extra wait. Shown, never written: the
  // surface is exactly what it was. Read-only commands and 127.0.0.1 GETs, each
  // with a deadline (probe.ts). Not for --from or --no-verify (probeAtInit).
  const probing = probeAtInit(args) ? probeMachine().catch(() => null) : null;
  // Init's own detection, beside the probe. When nothing answered, the tag
  // `gnomon setup` would recommend for this machine is written instead of
  // generic placeholders nothing will ever serve and `gnomon doctor` flags.
  // When the catalog has nothing this machine runs, or the probe failed, the
  // placeholders stay. Not for --from or --no-verify (no probe): those
  // scaffolds are byte for byte what they were.
  let chosen: ModelChoice | undefined;
  let starter: StarterModels | undefined;
  if (probing) {
    const [detected, probe] = await Promise.all([detectModels(), probing]);
    chosen = detected;
    if (detected.fallback && probe) {
      try {
        const { loadCatalog, defaultCatalogPath, starterModels } = await import("./catalog.js");
        starter = starterModels(probe, loadCatalog(defaultCatalogPath()));
      } catch {
        starter = undefined; // a catalog that will not load keeps the placeholders
      }
      if (starter) chosen = { ...detected, large: starter.large, small: starter.small, note: starter.note };
    }
  }
  let result;
  try {
    result = await initSurface({
      dir: args.dir,
      force: args.force,
      from: args.from,
      noVerify: args.noVerify,
      ...(chosen ? { models: chosen } : {}),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`Initialised ${result.gnomonDir}`);
  console.log(`  (in ${resolve(args.dir ?? process.cwd())})`);
  if (result.readOnly) {
    // The cause, named: the directory cannot be written (TB7).
    console.log(
      `  ${result.readOnly.root} is not writable (a read-only mount, or no write permission),\n` +
        `  so the surface and gnomon's records are kept in ${result.readOnly.stateDir}.\n` +
        `  gnomon finds them from ${result.readOnly.root}, and the tools work there.`
    );
  }
  for (const f of result.written) console.log(`  + .gnomon/${f}`);
  for (const f of result.skipped) console.log(`  · .gnomon/${f} (kept existing)`);
  if (result.gitattributes) console.log("  + .gitattributes: .gnomon/** text eol=lf (same surface hash on Windows)");
  if (result.gitignore?.length) console.log(`  + .gitignore: ${result.gitignore.map((d) => d + "/").join(" ")} (machine-local, never committed)`);

  const probe = probing ? await probing : null;
  if (probe) {
    console.log("");
    for (const line of formatProbe(probe)) console.log(line);
  }

  // Say which models were chosen and why. A tag appearing in roles.toml with
  // no explanation looks like a decision someone made on your behalf.
  const models = result.models;
  if (models) {
    console.log("");
    if (models.fallback && starter) {
      // The catalog's pick, not installed: say so, and the one command that
      // installs it. Launch offers that setup itself right after this.
      const size = starter.downloadGb !== undefined ? ` (~${starter.downloadGb} GB download)` : "";
      console.log(`Models: ${models.fallback}, so the catalog's pick for this machine was written:`);
      console.log(`  ${models.large}${size}, for every role. It is not installed yet.`);
      if (!opts.launching) {
        console.log(`  Install it:   gnomon setup   (asks first; or: gnomon setup --pull ${models.large})`);
        console.log("  By hand:      gnomon endpoint add   (a model you already have, local or cloud)");
      }
    } else if (models.fallback) {
      // Placeholders, and say what replaces them. "Very likely wrong -- edit
      // them" named the problem and no way out of it; the way out is setup,
      // which recommends a model this machine runs, or `endpoint add`, which
      // lists what an endpoint serves and proves a tag works.
      console.log(`Models: ${models.fallback}, so placeholder tags were written`);
      console.log(`  (${models.large}, ${models.small}).`);
      if (!opts.launching) {
        console.log("  Set one up:   gnomon setup   (scans this machine, recommends, asks before writing)");
        console.log("  By hand:      gnomon endpoint add --preset ollama | openrouter | opencode-go | opencode-zen");
      }
    } else {
      console.log(`Models: detected ${models.detected.length} on this machine.`);
      console.log(`  ${models.large} for the reasoning roles`);
      console.log(`  ${models.small} for smol`);
    }
  }

  console.log("");
  console.log(
    result.verify
      ? `Verify: \`${result.verify}\` runs after every turn that changes a file ([verify] in policy.toml);\n` +
          `        a new test must fail on the code as it was (test_must_fail_first).`
      : "Verify: none found — declare [verify] command in .gnomon/policy.toml, or no turn is ever checked."
  );
  if (result.audit) {
    console.log("Audit: on — decisions and outcomes, no prompt text, in .gnomon-audit/ ([audit] in config.toml).");
  }

  if (result.trial) {
    console.log(
      `Trial: .gnomon/trials/default.toml — ${result.trial.locate ? "a locate task (answer checked by hash) and " : ""}a planted-secret canary,\n` +
        `       runnable with your local model: gnomon eval --against <ref>   (or gnomon skill trial <skill>).`
    );
  }
  if (result.claudeCode) {
    // Offered, never performed: the hook is a file in .claude/ that Claude Code
    // runs on every call, and installing it is the person's decision.
    console.log("");
    console.log(`Claude Code: .claude/ is here, and [check.roles] maps its hook to the "${result.claudeCode.role}" role.`);
    console.log("  Put a live guard in front of its tool calls (not run for you):");
    console.log("    gnomon guard install claude-code --write");
  }

  // Name the file whose edits take effect. The scaffold ships
  // `role_profile = "local_first"` and a profile that restates `model` and
  // `endpoint` for every role that has one, and a profile is merged OVER the
  // base role -- so "check .gnomon/roles.toml" sent every new user to a file
  // their edits would be overridden in.
  const where = (() => {
    try {
      return modelEditTarget(loadConfig(resolve(args.dir ?? process.cwd())));
    } catch {
      return { label: ".gnomon/roles.toml" } as { label: string; profile?: string };
    }
  })();
  // Launch starts the session itself, so a "Next: run `gnomon prompt`" here
  // told the user to do what was already happening on the next line.
  if (opts.launching) return;
  console.log("");
  console.log("Next:");
  console.log("  1. `gnomon setup` — scan this machine, pick a model it can run (or a cloud");
  console.log("     model), and write it here on your yes. `gnomon dashboard` does the same");
  console.log("     in the browser. By hand instead: `gnomon endpoint add`.");
  console.log(`     The tags live in ${where.label}.`);
  if (where.profile) {
    console.log(`     (role_profile = "${where.profile}" is merged over roles.toml,`);
    console.log("      so that file is what these roles are routed by.)");
  }
  console.log("  2. `gnomon doctor` — check that every role's model answers.");
  console.log("  3. `gnomon launch` in this directory.");
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
  const fresh = !existsSync(surface);

  if (!fresh) {
    // Silence here meant a launch in the wrong directory looked exactly like
    // a launch in the right one.
    console.log(`Using the existing .gnomon/ in ${target}`);
  } else {
    console.log(`No .gnomon/ in ${target} — creating one.`);
    await cmdInit(args, { launching: true });
  }

  // On a terminal, make sure a model answers BEFORE the session starts. A
  // session that cannot reach one fails on its first message, and the way
  // out (`gnomon endpoint add`) was nowhere on screen. Off a terminal there
  // is nobody to ask, and a script gets exactly what it got before.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    // A fresh surface's init has just printed the probe.
    await offerModelSetup(args, target, { showProbe: !fresh });
  } else if (fresh) {
    console.log("");
    console.log("If no model answers yet: `gnomon setup` recommends one for this machine and sets it up");
    console.log("(or `gnomon endpoint add` for one you have). `gnomon doctor` checks every role.");
  }
  console.log("");

  await cmdPrompt(args);
}

/**
 * Before a launch opens the session: does its role reach a model? If not,
 * offer to set one up, through the same `endpoint add` flow -- presets, key
 * held outside the surface, one token through it before anything is written.
 *
 * Loops until something answers or the user skips, so a failed setup (wrong
 * key, Ollama still stopped) lands back on the choice rather than in a
 * session that cannot work.
 */
async function offerModelSetup(args: CliArgs, target: string, opts: { showProbe?: boolean } = {}): Promise<void> {
  const role = args.subcommand || "implement";
  let probeShown = !opts.showProbe;
  for (;;) {
    let declared;
    try {
      declared = loadConfig(target, args.flags["profile"]);
    } catch {
      return; // cmdPrompt reports a surface that does not load, in full.
    }
    // On what the trust step would run, never the surface as declared: this is
    // before cmdPrompt's settleTrust, and a cloned repository's endpoint may
    // name its own host and the user's key variable (setup.ts launchReadiness).
    const readiness = await launchReadiness(declared, role, trustOptions(args), (c) => {
      applyCredentials(undefined, declaredKeyVars(c));
    });
    if (readiness.ready) return;
    if (readiness.keyWithheld) {
      // Said, not probed for: trust is asked when the session starts, next.
      console.log("");
      console.log(`  Not checked: ${readiness.why}.`);
      return;
    }

    // What the machine has, before asking what to set up: a model server
    // already running on another port is the answer to the question below.
    if (!probeShown) {
      probeShown = true;
      const probe = await probeMachine().catch(() => null);
      if (probe) {
        console.log("");
        for (const line of formatProbe(probe)) console.log(line);
      }
    }
    console.log("");
    console.log(`No model answers for this project yet: ${readiness.why}.`);
    console.log("Set one up now?\n");
    SETUP_CHOICES.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.label.padEnd(13)} ${c.note}`);
    });
    const answer = await ask(`\nChoose [1-${SETUP_CHOICES.length}, Enter = 1]: `, "");
    const pick = parseSetupPick(answer);
    if (!pick) {
      console.log(`  "${answer}" is not one of those.`);
      continue;
    }
    if (pick === "skip") {
      console.log(
        "  Skipped. The session starts, but nothing will answer until a model does:\n" +
          "    gnomon setup            # recommends one for this machine, asks before downloading\n" +
          "    gnomon endpoint add     # a model you already have, local or cloud"
      );
      return;
    }
    console.log("");
    if (pick === "setup") {
      // The wizard, on this project, as `gnomon setup` runs it: every download,
      // write and cloud call asks first. Its write moves the hash, so the
      // session below settles trust again as usual.
      await cmdSetup({ ...args, dir: target, json: false, yes: false }, { fromLaunch: true });
      continue;
    }
    // The surface as declared: endpointAdd edits it, so it reads what is written.
    await endpointAdd(args, declared, { preset: pick, quick: true });
    // Written or not, look again: a write is proved by the next check, and a
    // failure goes back to the choice instead of into a dead session.
  }
}

/**
 * The project a setup or doctor run is about: `--dir`, else the nearest
 * directory up from here with a .gnomon/ (as every other command finds it),
 * else here. Setup in a subdirectory of a project must not scaffold a second
 * surface inside it.
 */
function projectRoot(args: CliArgs): string {
  if (args.dir) return resolve(args.dir);
  try {
    return dirname(resolveGnomonDir());
  } catch {
    return process.cwd();
  }
}

/** A usage or apparatus error, as text or as the command's JSON document. */
function commandError(args: CliArgs, schema: string, message: string, exit: number): number {
  if (args.json) console.log(JSON.stringify({ schema, error: message, exit }, null, 2));
  else console.error(message);
  return exit;
}

/**
 * `gnomon setup` — scan this machine, plug in a local model it can run, then
 * connect a cloud model. The flow and every consent rule are in
 * setup_wizard.ts; this reads the flags and supplies the real machine.
 */
async function cmdSetup(args: CliArgs, opts: { fromLaunch?: boolean } = {}): Promise<number> {
  const [{ runSetup, HYBRID_CONTROLS, MODE_ALIASES, SETUP_EXIT }, { loadCatalog, defaultCatalogPath }, { systemSetupEffects }, { systemHost }] =
    await Promise.all([import("./setup_wizard.js"), import("./catalog.js"), import("./setup_host.js"), import("./probe.js")]);
  const f = args.flags;
  const schema = "gnomon.setup/1";
  const usage = (m: string) => commandError(args, schema, m, SETUP_EXIT.usage);
  for (const k of ["pull", "model", "mode", "cloud-endpoint", "cloud-model", "cloud-key-env", "hybrid-control", "catalog", "expect-proposal"]) {
    if (f[k] === "true") return usage(`--${k} needs a value.`);
  }
  const expect = f["expect-proposal"];
  if (expect !== undefined && !/^[0-9a-f]{64}$/.test(expect)) {
    return usage(`--expect-proposal takes the 64-hex \`proposal.digest\` of an earlier \`gnomon setup --json\`, not "${expect}".`);
  }
  let mode: Suggestion | undefined;
  if (f.mode) {
    mode = MODE_ALIASES[f.mode.toLowerCase()];
    if (!mode) return usage(`--mode ${f.mode}: use local, hybrid or cloud.`);
  }
  const control = (f["hybrid-control"] ?? "observe") as HybridControl;
  if (!HYBRID_CONTROLS.includes(control)) return usage(`--hybrid-control ${control}: use ${HYBRID_CONTROLS.join(", ")}.`);
  if ((f["cloud-model"] || f["cloud-key-env"]) && !f["cloud-endpoint"]) {
    return usage("--cloud-model and --cloud-key-env go with --cloud-endpoint URL|preset|endpoint.");
  }
  if (f.pull && f.model) return usage("--pull and --model each choose the local model; pass one.");
  let catalog;
  try {
    catalog = loadCatalog(f.catalog ?? defaultCatalogPath());
  } catch (err) {
    return commandError(args, schema, err instanceof Error ? err.message : String(err), SETUP_EXIT.catalog);
  }
  const json = Boolean(args.json);
  const interactive = !json && f["non-interactive"] !== "true" && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const report = await runSetup(
    {
      dir: projectRoot(args),
      json,
      yes: Boolean(args.yes),
      ...(f.pull ? { pull: f.pull } : {}),
      ...(f.model ? { model: f.model } : {}),
      speedCheck: f["speed-check"] === "true",
      ...(mode ? { mode } : {}),
      ...(f["cloud-endpoint"] ? { cloudEndpoint: f["cloud-endpoint"] } : {}),
      ...(f["cloud-model"] ? { cloudModel: f["cloud-model"] } : {}),
      ...(f["cloud-key-env"] ? { cloudKeyEnv: f["cloud-key-env"] } : {}),
      ...(expect ? { expectProposal: expect } : {}),
      hybridControl: control,
      ...(opts.fromLaunch ? { fromLaunch: true } : {}),
    },
    {
      host: systemHost(),
      io: {
        interactive,
        // Under --json, stdout is the document; the narrative goes to stderr.
        say: (l = "") => (json ? process.stderr.write(l + "\n") : console.log(l)),
        ask: (q, fallback = "") => ask(q, fallback),
        askSecret: (q) => readSecret(q),
      },
      catalog,
      now: () => new Date(),
      ...systemSetupEffects(),
      // Read when the wizard is about to check an endpoint the surface chose.
      // A surface that does not load trusts nothing.
      surfaceTrusted: () => {
        try {
          return preSessionSurface(loadConfig(projectRoot(args), args.flags["profile"]), trustOptions(args)).trusted;
        } catch {
          return false;
        }
      },
      commands: CLI_COMMANDS.map((c) => c.name),
    }
  );
  if (json) console.log(JSON.stringify(report, null, 2));
  return report.exit;
}

/**
 * `gnomon doctor` — read-only: the machine, every role's endpoint, and drift
 * from what setup recorded. Never writes; says what would fix each problem.
 */
async function cmdDoctor(args: CliArgs): Promise<number> {
  // `gnomon doctor verify`: run the declared check once (verify_probe.ts). A
  // separate command, because plain doctor never runs anything of the project's.
  if (args.subcommand === "verify") {
    const { probeVerify, formatVerifyProbe, VERIFY_PROBE_SCHEMA, VERIFY_PROBE_EXIT } = await import("gnomon-core");
    const dir = projectRoot(args);
    if (!existsSync(join(dir, ".gnomon"))) {
      return commandError(args, VERIFY_PROBE_SCHEMA, `No .gnomon/ in ${dir}: nothing declares a check (gnomon init).`, VERIFY_PROBE_EXIT.couldNotRun);
    }
    try {
      const report = await probeVerify(dir);
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else for (const l of formatVerifyProbe(report)) console.log(l);
      return report.exit_code;
    } catch (err) {
      return commandError(args, VERIFY_PROBE_SCHEMA, `doctor verify could not run: ${err instanceof Error ? err.message : String(err)}`, VERIFY_PROBE_EXIT.couldNotRun);
    }
  }
  const [{ runDoctor, formatDoctor, DOCTOR_EXIT }, { loadCatalog, defaultCatalogPath }, { systemHost }] = await Promise.all([
    import("./doctor.js"),
    import("./catalog.js"),
    import("./probe.js"),
  ]);
  const schema = "gnomon.doctor/1";
  if (args.flags.catalog === "true") return commandError(args, schema, "--catalog needs a file.", DOCTOR_EXIT.couldNotRun);
  try {
    const catalog = loadCatalog(args.flags.catalog ?? defaultCatalogPath());
    const { report, probe } = await runDoctor(
      { dir: projectRoot(args) },
      {
        host: systemHost(),
        catalog,
        now: () => new Date(),
        readiness: (config, role, opts) => checkReadiness(config, role, undefined, opts),
        applyKeys: (config) => {
          applyCredentials(undefined, declaredKeyVars(config));
        },
        trust: trustOptions(args),
      }
    );
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else for (const l of formatDoctor(report, probe)) console.log(l);
    return report.exit;
  } catch (err) {
    return commandError(args, schema, `doctor could not run: ${err instanceof Error ? err.message : String(err)}`, DOCTOR_EXIT.couldNotRun);
  }
}

/** `gnomon security`: the read-only posture report (security.ts). */
async function cmdSecurity(args: CliArgs): Promise<number> {
  const { buildSecurityReport, formatSecurity, SECURITY_EXIT, SECURITY_SCHEMA } = await import("./security.js");
  const dir = projectRoot(args);
  if (!existsSync(join(dir, ".gnomon"))) {
    return commandError(args, SECURITY_SCHEMA, `No .gnomon/ in ${dir}: nothing governs this directory (gnomon init).`, SECURITY_EXIT.couldNotRun);
  }
  const sub = subcommandOr(args, "posture");
  if (sub === "test") {
    const { runSecurityTest, formatSecurityTest, SECURITY_TEST_SCHEMA, SECURITY_TEST_EXIT, SECURITY_TEST_HOSTS, SECURITY_TEST_OPT_IN_HOSTS } = await import("./security_test.js");
    const host = args.flags.host ?? "all";
    // `all` is the three hosts it always was; Codex, Qwen Code and Copilot are asked for by name.
    const named = [...SECURITY_TEST_HOSTS, ...SECURITY_TEST_OPT_IN_HOSTS];
    if (host !== "all" && !(named as readonly string[]).includes(host)) {
      return commandError(args, SECURITY_TEST_SCHEMA, `--host ${host}: use one of ${named.join(", ")}, or all (the default: ${SECURITY_TEST_HOSTS.join(", ")})`, SECURITY_TEST_EXIT.couldNotRun);
    }
    try {
      const hosts = host === "all" ? SECURITY_TEST_HOSTS : ([host] as Array<(typeof named)[number]>);
      const report = runSecurityTest(dir, { role: args.role, hosts });
      // Opt-in: the sandbox-escape probes (sandbox_probes.ts). Without the flag the
      // report and its exit are what they always were.
      if (args.flags.sandbox === "true") {
        const { runSandboxProbes, formatSandboxProbes } = await import("./sandbox_probes.js");
        const image = args.flags.image && args.flags.image !== "true" ? args.flags.image : undefined;
        // [sandbox] loopback = "deny" (policy.toml, or --loopback deny): the loopback probe is then claimed for exec = os.
        let loopback: "deny" | undefined = args.flags.loopback === "deny" ? "deny" : undefined;
        if (!loopback) {
          try {
            loopback = loadConfig(dir).policy?.sandbox?.loopback === "deny" ? "deny" : undefined;
          } catch {
            /* an unreadable surface is reported by the other checks */
          }
        }
        const probes = await runSandboxProbes({ image, ...(loopback ? { loopback } : {}) });
        const exit = report.exit !== 0 && report.exit !== 10 ? report.exit : probes.exit !== 0 ? probes.exit : report.exit;
        if (args.json) console.log(JSON.stringify({ ...report, exit, sandbox_probes: probes }, null, 2));
        else {
          for (const l of formatSecurityTest(report)) console.log(l);
          for (const l of formatSandboxProbes(probes)) console.log(l);
        }
        return exit;
      }
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else for (const l of formatSecurityTest(report)) console.log(l);
      return report.exit;
    } catch (err) {
      return commandError(args, SECURITY_TEST_SCHEMA, `security test could not run: ${err instanceof Error ? err.message : String(err)}`, SECURITY_TEST_EXIT.couldNotRun);
    }
  }
  if (sub !== "posture") {
    return commandError(args, SECURITY_SCHEMA, `Unknown security subcommand: ${sub}. Use: posture (the default) | test`, SECURITY_EXIT.couldNotRun);
  }
  try {
    const report = buildSecurityReport(dir, trustOptions(args));
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else for (const l of formatSecurity(report)) console.log(l);
    return report.exit;
  } catch (err) {
    return commandError(args, SECURITY_SCHEMA, `security could not run: ${err instanceof Error ? err.message : String(err)}`, SECURITY_EXIT.couldNotRun);
  }
}

/**
 * `gnomon eval` (gnomon-core eval.ts): a trial's paired cells for a profile
 * or a surface. Exit 0 meets the spec, 2 does not, 10 no answer -- including
 * an eval that could not start.
 */
async function cmdEval(args: CliArgs): Promise<number> {
  const config = loadConfig(args.dir, args.flags["profile"]);
  if (args.flags["ablate"] !== undefined) {
    return runAblateCmd(
      config,
      { flags: args.flags, json: !!args.json },
      {
        settleTrust: (c) => settleTrustHeadless(c, trustOptions(args)).outcome,
        runCell: (wt, prompt, o) => runTask(loadConfig(wt, o.profile), prompt, { role: o.role, yes: args.yes, trust: o.trust }),
      }
    );
  }
  const flag = (k: string) => (typeof args.flags[k] === "string" && args.flags[k] !== "true" ? (args.flags[k] as string) : undefined);
  const yesSpend = args.flags["yes-spend"] !== undefined || args.positional.includes("--yes-spend");
  let outcome: Awaited<ReturnType<typeof runEval>>;
  try {
    outcome = await runEval(config, {
      spec: flag("spec"),
      against: flag("against"),
      base: flag("base"),
      yesSpend,
      // Settled on each arm's configuration as its cells load it; a clamped
      // arm is refused before any cell runs.
      settleTrust: (c) => settleTrustHeadless(c, trustOptions(args)).outcome,
      // Each cell is a `gnomon task` in its own clone, with that command's
      // approval rule: --yes approves gated calls in the clone.
      runCell: (wt, prompt, o) => runTask(loadConfig(wt, o.profile), prompt, { role: o.role, yes: args.yes, trust: o.trust }),
      log: args.json ? undefined : (line) => console.error(line),
    });
  } catch (err) {
    return commandError(args, EVAL_SCHEMA, `gnomon eval could not start: ${err instanceof Error ? err.message : String(err)}`, 10);
  }
  const { report, cells } = outcome;
  const out = recordEval(config, report, cells);
  if (args.json) {
    console.log(JSON.stringify({ ...report, report_path: out.report_path, report_sha256: out.report_sha256 }, null, 2));
    return evalExit(report.meets_thresholds);
  }
  const p = report.endpoints.pass;
  const b = report.arms.base;
  const c = report.arms.candidate;
  console.log(`Eval ${report.spec.name}: ${report.pairs.valid}/${report.pairs.planned} valid ${c ? "pairs" : "cells"} (${report.role})`);
  const on = (a: typeof b) => (a.kind === "command" ? `(${a.command!.join(" ")})` : `on ${a.model ?? "?"}`);
  const m = (v: number | null) => (v === null ? "not metered" : String(v));
  console.log(`  base       ${b.label}${b.profile ? ` profile ${b.profile}` : ""} ${on(b)}  pass ${p.base.passes}/${p.base.n}  [${p.base.wilson.join(", ")}]`);
  if (c && p.candidate) {
    console.log(`  candidate  ${c.label} ${on(c)}  pass ${p.candidate.passes}/${p.candidate.n}  [${p.candidate.wilson.join(", ")}]  McNemar p = ${p.mcnemar_p}`);
    if (report.arms.differ.length > 0) console.log(`  differ     ${report.arms.differ.join(", ")}`);
    const t = report.endpoints.output_tokens;
    console.log(`  out tokens base ${m(t.base)}  candidate ${m(t.candidate)}  gain ${t.gain === null ? "?" : `${(t.gain * 100).toFixed(1)}%`}`);
    console.log(`  requests   base ${m(report.endpoints.requests.base)}  candidate ${m(report.endpoints.requests.candidate)}`);
  } else {
    console.log(`  out tokens ${m(report.endpoints.output_tokens.base)}  requests ${m(report.endpoints.requests.base)}`);
  }
  console.log(`  cells      ${report.cells.result} result, ${report.cells.refusal} refusal, ${report.cells.apparatus_failure} apparatus_failure`);
  console.log(`  meets_thresholds: ${String(report.meets_thresholds)} (${report.status})`);
  for (const r of report.reasons) console.log(`    ${r}`);
  if (report.leftovers.length > 0) console.log(`  leftovers  ${report.leftovers.join(", ")}`);
  console.log(`Report: ${out.report_path}`);
  if (out.record) console.log(`Recorded in ${out.trail} (seq ${out.record.seq}, ${out.record.hash?.slice(0, 12)})`);
  console.log("Nothing was changed. Switching the profile, the surface or the harness remains a person's decision.");
  return evalExit(report.meets_thresholds);
}

/** `gnomon compliance`: the read-only evidence map (compliance.ts). */
async function cmdCompliance(args: CliArgs): Promise<number> {
  const { buildComplianceReport, formatCompliance, loadControls, defaultControlsPath, COMPLIANCE_EXIT, COMPLIANCE_SCHEMA } = await import("./compliance.js");
  const dir = projectRoot(args);
  if (args.flags.catalog === "true") return commandError(args, COMPLIANCE_SCHEMA, "--catalog needs a file.", COMPLIANCE_EXIT.couldNotRun);
  if (!existsSync(join(dir, ".gnomon"))) {
    return commandError(args, COMPLIANCE_SCHEMA, `No .gnomon/ in ${dir}: nothing governs this directory (gnomon init).`, COMPLIANCE_EXIT.couldNotRun);
  }
  const sub = subcommandOr(args, "controls");
  if (sub === "dataflow") {
    const { buildDataflowReport, formatDataflow, DATAFLOW_SCHEMA, DATAFLOW_EXIT } = await import("./dataflow.js");
    try {
      const report = buildDataflowReport(dir);
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else for (const l of formatDataflow(report)) console.log(l);
      return report.exit;
    } catch (err) {
      return commandError(args, DATAFLOW_SCHEMA, `dataflow could not run: ${err instanceof Error ? err.message : String(err)}`, DATAFLOW_EXIT.couldNotRun);
    }
  }
  if (sub === "pack") {
    const { buildPack, verifyPack, formatPack, formatPackVerify, PACK_SCHEMA, PACK_EXIT } = await import("./pack.js");
    const verify = args.flags.verify;
    try {
      if (verify !== undefined) {
        if (verify === "true") return commandError(args, PACK_SCHEMA, "--verify needs the pack's directory.", PACK_EXIT.couldNotRun);
        const r = verifyPack(verify);
        if (args.json) console.log(JSON.stringify(r, null, 2));
        else for (const l of formatPackVerify(r)) console.log(l);
        return r.exit;
      }
      const out = args.flags.out;
      if (!out || out === "true") return commandError(args, PACK_SCHEMA, "--out <dir> names where to write the pack (a new or empty directory).", PACK_EXIT.couldNotRun);
      const fw = args.flags.framework;
      const frameworks = fw && fw !== "true" ? fw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const r = buildPack(dir, out, loadControls(args.flags.catalog ?? defaultControlsPath()), {
        frameworks,
        trust: trustOptions(args),
        withTrails: args.flags["with-trails"] !== undefined,
      });
      if (args.json) console.log(JSON.stringify({ ...r.manifest, out: r.out, pack_sha256: r.pack_sha256 }, null, 2));
      else for (const l of formatPack(r)) console.log(l);
      return PACK_EXIT.ok;
    } catch (err) {
      return commandError(args, PACK_SCHEMA, `pack could not run: ${err instanceof Error ? err.message : String(err)}`, PACK_EXIT.couldNotRun);
    }
  }
  if (sub !== "controls") {
    return commandError(args, COMPLIANCE_SCHEMA, `Unknown compliance subcommand: ${sub}. Use: controls (the default) | dataflow | pack`, COMPLIANCE_EXIT.couldNotRun);
  }
  try {
    const catalog = loadControls(args.flags.catalog ?? defaultControlsPath());
    const fw = args.flags.framework;
    const frameworks = fw && fw !== "true" ? fw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const report = buildComplianceReport(dir, catalog, { frameworks, trust: trustOptions(args) });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else for (const l of formatCompliance(report)) console.log(l);
    return report.exit;
  } catch (err) {
    return commandError(args, COMPLIANCE_SCHEMA, `compliance could not run: ${err instanceof Error ? err.message : String(err)}`, COMPLIANCE_EXIT.couldNotRun);
  }
}

/**
 * `gnomon acp`: serve the Agent Client Protocol on stdio, for an editor.
 *
 * stdout IS the protocol channel from here on, so every other writer is moved
 * off it first. One stray `console.log` -- a tool, an MCP server's report, a
 * progress line -- would be a line the editor cannot parse, and the session
 * would die on it. The protocol keeps the only handle on the real stdout.
 */
async function cmdAcp(args: CliArgs): Promise<void> {
  const protocolOut = process.stdout.write.bind(process.stdout);
  const toStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = toStderr as typeof process.stdout.write;
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  await runAcpServer({
    input: process.stdin,
    write: (line) => {
      protocolOut(line);
    },
    profile: args.flags["profile"],
    role: args.role,
    // An editor cannot answer the trust prompt: settle it as `task` does.
    reconfigure: (fresh: GnomonConfig) => settleTrustHeadless(fresh, reloadTrustOptions(args)).config,
  });
  process.exit(0);
}

async function cmdPrompt(args: CliArgs): Promise<void> {
  const declared = loadConfig(args.dir, args.flags['profile']);
  // On a terminal an untrusted surface that grants more than the defaults is
  // shown and asked about; off one it runs clamped. A scaffolded surface
  // grants nothing extra and never gets here.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !args.json);
  const settled = await settleTrust(declared, {
    ...trustOptions(args),
    interactive,
    ask: (q) => ask(q, ""),
  }).catch((err: unknown) => {
    if (err instanceof TrustRequiredError) exitTrustRequired(err, Boolean(args.json));
    throw err;
  });
  if (settled.quit) {
    // A refusal by the trust gate: 3, refused_by_gate (docs/CONTRACTS.md §1).
    console.log("  Not started. Nothing ran.");
    process.exit(3);
  }
  pinSessionAnchor(settled.config);
  // A resumed session keeps its own role unless one is named here.
  const role = args.resume ? args.subcommand || undefined : args.subcommand || "implement";
  await runPromptLoop(settled.config, role, {
    resume: args.resume,
    trust: settled.outcome,
    // A surface reloaded mid-session goes through the same gate, headless:
    // trusted or covered runs as written, anything looser is clamped and said.
    reconfigure: (fresh: GnomonConfig) => settleTrustHeadless(fresh, reloadTrustOptions(args)).config,
  });
}

/** What the invocation says about trust: --trust, and GNOMON_TRUST=<surface hash>. */
function trustOptions(args: CliArgs): Omit<SettleOptions, "interactive"> {
  return {
    flag: Boolean(args.trust),
    env: process.env.GNOMON_TRUST,
    execDowngrade: args.flags["trust-exec-downgrade"] === "true",
    require: args.flags["require-trust"] === "true" || /^(1|true|yes)$/i.test(process.env.GNOMON_REQUIRE_TRUST ?? ""),
  };
}

/**
 * Mid-session reloads keep clamping a loosening rather than stopping the
 * session: --require-trust is a gate on starting, and a session already
 * running on a trusted surface stays on it (credential_pin, sandbox_pin).
 */
function reloadTrustOptions(args: CliArgs): Omit<SettleOptions, "interactive"> {
  return { ...trustOptions(args), require: false };
}

/** --require-trust refused the start: refused_by_gate, 3 (docs/CONTRACTS.md §1). */
function exitTrustRequired(err: TrustRequiredError, json: boolean): never {
  if (json) console.log(JSON.stringify({ error: "trust_required", message: err.message, surface_hash: err.evaluation.surface_hash }, null, 2));
  console.error(`gnomon: ${err.message}`);
  console.error("  Not started. Nothing ran.");
  process.exit(3);
}

/**
 * `gnomon trust` -- list, grant for the current surface, revoke.
 *
 * Trust is this machine's user accepting what a surface grants beyond the
 * scaffold, in one project. It lives beside the credential store, never in
 * the repository and never in the hash (trust.ts says why that is not a Rule 1
 * exception). Grants and revokes are written to the audit trail when the
 * surface keeps one.
 */
async function cmdTrust(args: CliArgs): Promise<void> {
  const config = loadConfig(args.dir, args.flags['profile']);
  const sub = subcommandOr(args, "list");
  const ev = evaluateTrust(config, { env: process.env.GNOMON_TRUST });
  const record = (decision: TrustOutcome["decision"]): void => {
    const id = `trust-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
    const trail = new AuditTrail(resolveAudit(config), id);
    trail.write("session_start", {
      surface_hash: ev.surface_hash,
      harness: harnessBuild(),
      cwd: process.cwd(),
      mode: "trust",
    });
    const outcome: TrustOutcome = {
      decision,
      by: "command:trust",
      surface_hash: ev.surface_hash,
      grants: ev.grants.map((g) => g.key).sort(),
    };
    trail.write("trust", { ...outcome, root: ev.root });
    trail.write("session_end", {});
  };

  if (sub === "grant") {
    if (ev.grants.length === 0) {
      console.log(
        `Nothing to trust: this surface (${ev.surface_hash.slice(0, 12)}) grants nothing beyond gnomon's defaults.`
      );
      return;
    }
    grantTrust(config, "command:trust");
    record("granted");
    // Granting is also how a person accepts MCP tools that changed since they
    // were pinned: the pins go, and the next session pins what each server
    // offers then (GV10). Said, because a pin dropping silently is a check
    // switched off silently.
    const unpinned = forgetToolPins(config);
    console.log(`Trusted ${ev.root} at surface ${ev.surface_hash.slice(0, 12)}:`);
    for (const line of describeGrants(ev.grants, [])) console.log(line);
    if (unpinned > 0) {
      console.log(
        `Cleared ${unpinned} MCP tool pin${unpinned === 1 ? "" : "s"}; the next session pins what each server offers then.`
      );
    }
    console.log(`Recorded in ${trustPath()} — not in the repository.`);
    return;
  }

  if (sub === "revoke") {
    const n = revokeTrust(config);
    if (n > 0) record("revoked");
    console.log(
      n > 0
        ? `Revoked ${n} trusted surface${n === 1 ? "" : "s"} for ${ev.root}. The next launch asks again.`
        : `Nothing was trusted for ${ev.root}.`
    );
    return;
  }

  if (sub !== "list" && sub !== "show") {
    console.error(`Unknown trust subcommand: ${sub}. Use: list | grant | revoke`);
    process.exit(1);
  }

  console.log(`This project: ${ev.root}`);
  console.log(`  surface ${ev.surface_hash.slice(0, 12)}`);
  if (ev.status === "default") {
    console.log("  grants nothing beyond gnomon's defaults — never asks.");
  } else {
    console.log(
      ev.status === "trusted"
        ? `  trusted (${ev.via === "store:covered" ? "no looser than a surface you trusted here" : ev.via})`
        : "  NOT trusted — a terminal session asks; a headless run is clamped to the defaults"
    );
    for (const line of describeGrants(ev.grants, ev.uncovered)) console.log(line);
  }
  const pins = toolPinsOf(config);
  if (pins.length > 0) {
    console.log("");
    console.log("MCP tools pinned for this project (a server offering others runs clamped):");
    for (const p of pins) console.log(`  ${p.tools_hash.slice(0, 12)}  ${p.at.slice(0, 10)}  ${p.server}`);
  }
  const entries = loadTrust().entries;
  console.log("");
  console.log(`Trusted on this machine (${trustPath()}): ${entries.length === 0 ? "none" : ""}`);
  for (const e of entries) {
    console.log(
      `  ${e.root}  ${e.surface_hash.slice(0, 12)}  ${e.at.slice(0, 10)}  ` +
        `${e.grants.length} grant${e.grants.length === 1 ? "" : "s"}  by ${e.by}`
    );
  }
}

async function cmdSessions(args: CliArgs): Promise<void> {
  const config = loadConfig(args.dir, args.flags['profile']);
  const store = resolveSessionStore(config);

  if (!store.persist) {
    console.log("Session persistence is off ([session].persist = false).");
    return;
  }

  const sessions = listSessions(store);
  if (sessions.length === 0) {
    // Say what was skipped. `gnomon session <cmd>` writes command records into
    // this same directory and prints the path; claiming the directory is empty
    // straight afterwards reads as data loss rather than as a filter.
    const other = countNonConversations(store);
    if (other > 0) {
      console.log(
        `No conversations in ${store.dir} — ${other} command-session record(s) ` +
          `written by \`gnomon session\`. Read those with \`gnomon tui\`.`
      );
      return;
    }
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

/**
 * The commands this CLI dispatches, as data.
 *
 * There were three lists and they disagreed: `loops` -- the project's only
 * unattended execution path -- was dispatched and documented but absent from
 * --help, `tui` likewise, and `endpoint` was dispatched and in --help but
 * missing from the README table. It survived because docs.test.ts checked
 * documented -> dispatched and never dispatched -> documented, so a command
 * that existed and was undocumented was invisible to the only mechanism
 * watching for exactly that. The slash commands already worked this way; this
 * is that pattern applied to the CLI, asserted in BOTH directions.
 */
export const CLI_COMMANDS: ReadonlyArray<{ name: string; aliases?: string[] }> = [
  { name: "launch" },
  { name: "setup" },
  { name: "doctor" },
  { name: "init" },
  { name: "surface" },
  { name: "enumerations", aliases: ["enums"] },
  { name: "session", aliases: ["sessions"] },
  { name: "apply" },
  { name: "simulate" },
  { name: "key", aliases: ["keys"] },
  { name: "endpoint", aliases: ["endpoints"] },
  { name: "audit" },
  { name: "skill", aliases: ["skills"] },
  { name: "task" },
  { name: "prompt", aliases: ["run"] },
  { name: "acp" },
  { name: "loop", aliases: ["loops"] },
  { name: "tui" },
  { name: "migrate" },
  { name: "update", aliases: ["upgrade"] },
  { name: "uninstall" },
  { name: "check" },
  { name: "trust" },
  { name: "inbox" },
  { name: "proposals", aliases: ["proposal"] },
  { name: "memory" },
  { name: "guard" },
  { name: "dashboard", aliases: ["ui"] },
  { name: "chaos" },
  { name: "security" },
  { name: "compliance" },
  { name: "eval" },
  { name: "improve" },
];

/**
 * One command's part of the help: its block under "Commands:", from the line
 * that names it to the next command's. Null for a name the help does not list.
 */
export function commandHelp(name: string): string | null {
  const entry = CLI_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
  if (!entry) return null;
  const names = [entry.name, ...(entry.aliases ?? [])];
  const lines = helpText().split("\n");
  const commandLine = (l: string): string | null => {
    const m = /^ {2}([a-z][a-z-]*)\b/.exec(l);
    return m && CLI_COMMANDS.some((c) => c.name === m[1] || c.aliases?.includes(m[1]!)) ? m[1]! : null;
  };
  const start = lines.findIndex((l) => names.includes(commandLine(l) ?? ""));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && commandLine(lines[end]!) === null && !/^\S/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n").replace(/\s+$/, "");
}

/**
 * Whether this command line asks for a command's help rather than its work:
 * `--help` or `-h` before any `--`. `session` takes a command line of its own
 * (`gnomon session ls -h`), so only a flag straight after it counts there.
 * guard, dashboard and chaos answer their own --help with fuller usage.
 */
export function asksCommandHelp(command: string, rest: string[]): boolean {
  if (["guard", "dashboard", "ui", "chaos"].includes(command)) return false;
  const isHelp = (a: string | undefined): boolean => a === "--help" || a === "-h";
  if (command === "session" || command === "sessions") return isHelp(rest[0]);
  const end = rest.indexOf("--");
  return (end < 0 ? rest : rest.slice(0, end)).some(isHelp);
}

function showHelp(): void {
  console.log(helpText());
}

function helpText(): string {
  // The Environment list at the end names only variables something reads.
  // GNOMON_DIR was listed there from the first commit as "Override .gnomon/
  // directory path", and nothing has ever read it. It is only exported, by
  // `gnomon session`, to the commands that session runs. An environment
  // variable that chose which surface governs a run would be the machine-scoped
  // configuration Rule 1 rules out, and --dir already does the same thing
  // explicitly, on the command line. So the line went, rather than gaining an
  // implementation.
  //
  // Derived, never a literal. This line read `gnomon v0.1.0` while every
  // package.json, Cargo.toml and the tag said 0.1.1 — so the one version string
  // a human actually reads was the one that could not be trusted, and
  // `gnomon --help` could not distinguish a 133-commit-old checkout from HEAD.
  // harnessBuild() carries the version AND the commit, which is the question
  // being asked when someone types --version.
  return `${harnessBuild()} — deterministic coding agent harness

Commands:
  launch [--dir <path>] [--from <path>]
    Start working here. Creates .gnomon/ if it is missing, then opens the
    interactive loop. This is the one command to remember. On a terminal,
    when no model answers, it offers the guided setup (gnomon setup) first;
    off one it says which command sets one up.

  setup [--json] [--yes] [--pull TAG] [--model TAG] [--speed-check]
        [--mode local|hybrid|cloud] [--cloud-endpoint URL|preset|name]
        [--cloud-model NAME] [--cloud-key-env VAR] [--catalog FILE]
        [--expect-proposal DIGEST]
    Scan this machine, plug in a local model it can run, then connect a
    cloud model. Recommends from a dated catalog and says why, pulls only on
    a yes, offers a short speed check, suggests local only or cloud first
    (hybrid, an opt-in cost mode, is --mode hybrid), and writes .gnomon/
    only after you accept the diff. Off a
    terminal: --yes approves the write and nothing else; a download needs
    --pull TAG; nothing is spent. --expect-proposal writes only the change
    whose proposal.digest an earlier --json run printed. Exit 0 written,
    3 the surface or the change moved, 4 needs consent or a model, 12 the
    model server stopped answering.

  doctor verify [--json] [--dir <path>]
    Run the project's [verify] check once on the tree as it is (the command
    the surface declares, else the one init would detect), through the same
    sandbox, and say what it means: could not run (126/127, a timeout), exits
    0 but ran no test, exits 4 or 5 (usage error or nothing collected, which
    reads as a failure unless [verify] contract or exit_map says otherwise),
    or fails on the clean tree. Does not run [verify] setup. Exit 0 the check
    runs and holds up, 1 a problem, 10 nothing to run.

  doctor [--json] [--catalog FILE]
    Read-only: this machine, whether every role's model answers, and what
    changed since setup (memory, GPUs, model servers, catalog). Says what
    would fix each problem and never changes anything. Exit 0 nothing to do,
    1 something needs attention, 10 could not run.

  init [--dir <path>] [--from <path>] [--force] [--no-verify]
    Write a .gnomon/ surface into a project. --from copies an existing
    surface instead of the built-in starter templates. The project's own
    check (package.json verify/check/test, cargo test, ...) is declared as
    [verify] with test_must_fail_first, and the audit trail is on.
    --no-verify writes the scaffold as before (no [verify], audit off),
    byte for byte, for benchmark comparability.

  migrate [--dir <path>] [--check]
    Bring an existing .gnomon/ up to the current shipped defaults. Prints
    what it changes and why; --check reports without writing. Never runs
    on its own — a release does not edit a surface you committed.

  surface [manifest|hash|paths] [--dir <path>]
    Show surface hash, manifest, or paths for .gnomon/ tree

  enumerations
    Show the enumerations contract (edit_format, sandbox, approval, role_profile, governance_level,
    governance_family, audit_kind, guard_decision, guard_rule, guard_tool, exec,
    candidate_signal, trial_verdict, trial_status)

  session [--dir <path>] <command> [command ...]
    Run commands as a session, recording outcomes. Each command runs with
    GNOMON_DIR set to the .gnomon/ directory the session used.

  apply <patchset.json> [--dir <path>]
    Apply a patchset to a directory

  simulate <patchset.json> [--dir <path>]
    Dry-run preview of a patchset

  key [set|list|unset] <endpoint|VARIABLE>
    Store an API key for an endpoint that declares one. The value is kept in
    a machine-local file (mode 0600), never in .gnomon/ — the surface names
    the variable and must stay safe to commit. An exported variable always
    takes precedence.

  endpoint [add|test|list]
    add   Declare an endpoint end to end: provider, key, model, roles. It
          asks the endpoint to run one token before writing anything, so a
          rejected key is caught here rather than mid-task. Presets:
          --preset opencode-go | opencode-zen | openrouter | ollama
          Scriptable: --name --url --kind --key-env --model --role
    test  Run one token through a declared endpoint (or all of them) and
          report what came back. A model listing is not a test of a key —
          some providers serve one to no key at all.

  audit [show|verify|anchor|tamper|metrics|attribute|scan|schema|resolve <trail>:<seq> --reason <text>] [--dir <path>]
    Audit trails, when [audit] is enabled. 'verify' re-hashes each record
    and checks the chain, so a trail altered after the fact is detectable.
    With [audit.anchor] declared it also checks every sealed head against
    the external witness and names when a re-chain happened (--offline reads
    this machine's copy, and exits on what it can check there: an anchor
    it cannot check, on a fresh checkout or an untrusted surface, is
    reported, not failed; --scope <id> checks another checkout's anchors).
    'anchor' delivers queued heads to the witness now.
    'tamper' lists record_tamper events: changes to gnomon's own records
    that gnomon did not make (exit 3 while any is unresolved). 'resolve'
    is a person's acknowledgement of one, recorded; skill accept refuses
    while any is unresolved.
    'metrics [--last <n>] [--session <id>] [--json]' counts how the agent
    worked, from the newest n (default 50) session trails whose chains
    verify: turns and stop reasons, model calls and tokens, tool calls by
    tool and outcome, approvals, verify runs, whether a check passed after
    the last write, gates, escalations, degradations; and, from the
    guard's trails, other harnesses' sessions (Claude Code, opencode,
    Cursor): calls, decisions, rules and tools per host. Model-free. Exit 0,
    2 when a trail failed verification (left out), 10 could not run.
    'attribute [<trail>...] [--last <n>] [--json]' names why a session
    failed, by harness layer (execution, tools, context, lifecycle,
    verification, governance): one primary cause per verified trail with
    a failure signal, the others it also saw, and a histogram. Rules and
    precedence: docs/CONTRACTS.md section 60. Model-free. Exit as metrics.
    'scan [<trail.jsonl|dir>] [--min-severity info|low|medium|high] [--json]' reads
    trails offline for multi-step patterns a per-call guard cannot see:
    a credential read followed later by network, a write outside the
    project or an encoding step; a file written, made executable, then run;
    repeated refusals with variations; credential locations probed across
    tools; an injection-like marker in tool output followed by a risky
    action (record = "full" trails only); a cd out of the root, a symlink
    out then a write through it, a refusal retried through another tool.
    Works on gnomon trails and the guard feed of other harnesses; a
    metadata-only trail is enough for every rule but the marker one.
    Advisory and model-free; nothing is blocked. Default path:
    .gnomon-audit/. Exit 0 no finding, 2 a finding, 10 could not run.

  skill [list [--candidates]|accept <id> [--evidence <report.json>]|reject <id> [--reason <text>]|mine [--json]] [--dir <path>]
    Skills the harness has learned. An agent proposes into
    .gnomon/skills/proposed/; accepting moves it into .gnomon/skills/,
    which changes the surface hash and applies from the next session.
    Accept and reject each write a skill_accept / skill_reject audit
    record (content hash, surface hash before and after, who), even when
    [audit] is off. --evidence cites a "skill trial" report: it must be for
    this exact content and base surface, and named by a sealed, verified
    skill_trial record that agrees with it. With [skills] require_trial =
    true in policy.toml, accept refuses without a report that also meets
    its thresholds. A refused accept exits 3.
    mine reads the audit trails, with no model call, and writes skill
    candidates (evidence with record pointers, not skill text) to
    .gnomon-skills/candidates/, which is not hashed.

  skill export [--to <dir>] [--format skill-md] [--write] [--json] [--dir <path>]
    Write each active skill (.gnomon/skills/*.md; proposals are not exported)
    as <name>/SKILL.md, the Agent Skills layout Claude Code, Codex, Cursor
    and opencode read: YAML name and description, the skill's text, and a
    comment naming the source file and the surface hash. A DRY RUN unless
    --write. Default directory .claude/skills (Claude Code; Cursor and
    opencode read it too); --to .agents/skills for Codex. Never writes into
    .gnomon/ and never overwrites a SKILL.md gnomon did not write (exit 2).

  skill trial <id> [--spec <name>] [--yes] [--yes-spend] [--trust] [--json]
    Measure a proposal on the tasks in .gnomon/trials/<name>.toml (default
    "default"): each task x attempt runs once without the skill and once
    with it, interleaved, each in a fresh private clone at HEAD, judged by
    the task's check command. Writes .gnomon-trials/<id>/<utc>/ and a
    skill_trial audit record. Exit 0 meets the declared thresholds, 2 does
    not, 10 no answer. Never accepts anything.

  task "<what to do>" [--role <name>] [--yes] [--json] [--trust] [--dir <path>]
       [--deadline <seconds|ISO time>] [--attempts <k> [--apply]]
  task --task-file <path|-> [...the same options]
    Run one task without a terminal and print the result. --json emits a
    record whose only run-to-run differences are under "volatile".
    --task-file reads the task text from a file, or from stdin with "-",
    so a wrapper need not put it on a command line, where a model's
    \`pkill -f <a word from the task>\` would match the wrapper's shell.
    gnomon's own command line reads "gnomon task" while it runs.
    --deadline (or GNOMON_DEADLINE) gives the run a wall clock: it is told
    the time left, bash timeouts are clamped to it, and before it the turn
    stops itself with stop_reason "deadline", its final record and a
    sealed trail (exit 2).
    Gated tool calls are REFUSED unless --yes: a non-interactive run has
    nobody to ask. Exit code: 0 result, 2 refusal, 10 apparatus_failure.
    --attempts <k> (k > 1) runs k attempts in k clones of HEAD under one
    surface and keeps the first whose external check ([verify] command, else
    [attempts] check) passes, cancelling the rest; none passing offers the
    best by outside evidence, flagged unverified. Refused with no check
    declared, above [attempts] max, or with uncommitted changes. The change
    is a patch in a run directory under the system temp dir; --apply applies
    a VERIFIED winner (--yes only approves the attempts' gated calls, as for
    a plain task), never over files you changed meanwhile. Exit 0
    verified, 1 unverified, 10 nothing to offer. k = 1 is a plain task.
    --require-verify (or [verify] exit_on_fail = true) puts the declared
    [verify] check in the exit where the bucket says 0: 1 for a check that
    failed (or regressed, or passed_unverified), 4 for one that could not
    run; the record then carries verify_exit, verify_rounds, verify_reason.
    A surface granting more than the defaults that this machine has not
    trusted runs CLAMPED to the defaults, with one line on stderr; --trust
    (or GNOMON_TRUST=<surface hash>) runs it as declared -- except a role
    leaving the container (or image) it ran in here, which stays where it
    ran unless --trust-exec-downgrade is given too. --require-trust (or
    GNOMON_REQUIRE_TRUST=1) stops such a run instead of clamping it: exit 3,
    nothing ran -- for CI, where a clamped run would pass for the real one.

  trust [list|grant|revoke] [--dir <path>]
    Whether this machine's user trusts what this project's .gnomon/ grants
    beyond gnomon's defaults (approval never, network, a wider shell, an MCP
    server, ...). list shows the grants against the defaults; grant trusts
    the current surface; revoke forgets every trust for this project. Kept
    beside the key store, never in the repository or the surface hash. A
    scaffolded surface grants nothing extra and is never asked about.

  inbox [list|show <id>|add --title <t> [--detail <d>] [--target <t>]|ack <id>|resolve <id> [--note <n>]|mcp] [--status <s>] [--dir <path>] [--json]
    Work items an operator flagged for the developer's harness ("Flag for
    fix" in the dashboard, or add here): one file each in .gnomon-inbox/
    (gitignored). Targets: claude-code, cursor, gnomon, any. An item is
    information from the operator, never an instruction or an approval: the
    harness reading it keeps its own rules. gnomon shows the count at launch
    and in /inbox; \`guard install claude-code\` adds a SessionStart hook that
    hands Claude Code the open ones; \`inbox mcp\` serves them to Cursor or
    Claude Code over MCP (list, get, acknowledge, resolve; no add). Each
    change is an inbox_item audit record (id and target, never the text).
    Exit 0 done, 1 an item that is not there or a usage error.

  proposals [list|show <id>|accept <id>|reject <id> [--note <text>]] [--status <s>] [--kind <k>] [--dir <path>] [--json]
    The one path by which .gnomon/ changes itself. A proposal is an inert,
    typed file in .gnomon-proposals/ (gitignored): a skill, a memory entry
    or an edit to an allowed surface file, with its rationale, evidence and
    the exact diff. list shows the pending ones; show prints the diff.
    accept applies the diff only if every file still matches what it was
    written against (otherwise: the surface moved, re-propose), which changes
    the surface hash and applies from the next session; reject changes
    nothing. Both are a person's: they refuse inside an agent session and
    without a terminal, exit 3, and each writes a proposal_decision audit
    record (a skill keeps skill_accept / skill_reject).

  memory [list|show <name>] [--dir <path>] [--json]
    The memory entries a person accepted into .gnomon/memory/: short notes
    about this repository, hashed with the surface. The prompt lists their
    names; the model opens one with read. An entry exists only through an
    accepted proposal; nothing writes one directly.

  sessions [--dir <path>]
    Saved sessions, newest last.

  loop [list|status|dry-run <name>|run <name>|install <name>|uninstall <name>|reset <name>|kill] [--dir <path>]
    Guard/act loops declared in .gnomon/loops/, scheduled off the OS cron.
    A deterministic shell guard runs first; only a tripped guard may reach a
    model. The crontab entry is machine-local and never enters the surface.

  tui [--dir <path>]
    Read a saved session back: turns, tools, buckets.

  check --base <rev> [--head <rev>] [--role <role> | --agent <name>] [--json]
    Judge a change another harness made (Claude Code, opencode, a CI
    branch) by this surface's rules, as they stood at <rev>: every changed
    path inside the role's write_allow, .gnomon/ not edited, [verify] passes
    on head, a new test fails on the old sources (test_must_fail_first).
    --head defaults to the working tree. The role is --role, else
    [check.roles] in policy.toml maps --agent to one; never guessed. The
    verdict is appended to the hash-chained audit trail; --json carries
    the record's hash. Exit: 0 held, 2 a check failed, 10 no verdict.
    --transcript <file> --format <format> also puts every shell command
    the agent ran to the role's bash_allow / bash_deny. <format> is the
    harness that wrote the file: claude-code, opencode, goose, qwen-code,
    mini-swe-agent, antigravity (a JSONL of its hook payloads) or hermes
    (hermes sessions export).
    --install-hook claude-code prints the SessionStart + Stop hooks that
    run this on every Claude Code session (it edits nothing).
    --require-guard fails (exit 2) a session that made calls the guard hook
    selects and that gnomon guard never decided (--session, or the
    transcript's own session; else every Claude Code session since install).
    Policy lint: the surface's rules are linted (contradictory, shadowed,
    never-matching, uncovered, granted-but-always-denied) and findings ride
    the verdict as warnings and a "policy_lint" key; --strict-policy makes
    any finding exit 2. "check --policy-lint" runs the lint alone, no --base.
  check --scorecard [--session <id>] [--transcript <file>] [--json]
    Summarise a foreign harness's run: guard decisions by family and verdict,
    tools seen vs governed, hook and session liveness, the audit trails'
    hash chains, and the recorded check results. Markdown, or
    gnomon.scorecard/1 JSON. Exit 0 clean, 2 a finding, 10 not governed.

  guard --tool <bash|write|edit|read|webfetch|grep|glob|execute> --input <json> [--role <r> | --agent <a>]
  guard --from claude-code|opencode|cursor|codex|qwen-code|copilot|generic  (the call on stdin)
    Decide one tool call another harness is about to make, before it runs,
    by this surface's rules as committed (the session's recorded base, else
    HEAD): allow, deny or ask, with the rule and the reason, as
    gnomon.guard/1 JSON. The same prechecks gnomon's own tools run decide it.
    Exit: 0 allow, 2 deny, 3 ask, 10 no decision (answered as ask). With
    --from claude-code|cursor|codex|qwen-code|copilot it answers in that harness's hook format.
    Recorded in the audit trail when [audit] is on.
  guard install claude-code|opencode|cursor|codex|qwen-code|copilot [--write] [--bin <path>]
    Print the hook (Claude Code PreToolUse, an opencode 2.2 plugin, Cursor
    hooks.json, Codex .codex/hooks.json, Qwen Code .qwen/settings.json, Copilot
    .github/hooks/gnomon.json), or with --write add it to this project's own config. The
    hook names an absolute gnomon that answers guard; none: exit 10.
  guard status [--expect claude-code,opencode,cursor,codex,qwen-code,copilot] [--json] [--dir <path>]
    Per host: the hook ok, missing, modified (differs from HEAD or from what
    install --write recorded), disabled (disableAllHooks) or not installed;
    and the host sessions the guard has decided for (liveness).
    Exit 0 no finding, 2 a finding, 10 no .gnomon/ governs the directory.

  dashboard [--port <n>] [--no-open] [--dir <path>]
    A command center in the browser: projects, sessions as a timeline, what
    the policy refused, audit-chain verification, contracts and token
    measurements, read from what gnomon already records; and setup, check,
    trust and endpoint test as buttons that run these same commands. A
    change asks you to confirm what it will do first. Serves 127.0.0.1 only;
    the printed link signs one tab in once. Ctrl-C stops it. Exit 0 stopped,
    4 port unavailable, 10 failed to start. Alias: ui.

  security [--json] [--dir <path>]
    Read-only: this project's security posture in one place. Whether this
    machine trusts what the surface grants; per role, where its commands run
    (host, os sandbox, docker), with what network, source and allow-lists;
    the guard hooks of other harnesses; the audit trail (on, anchored, the
    newest 50 chains verified, unresolved tamper events). Risks are what is
    wrong now (a broken chain, a tamper event, a hook switched off, a fatal
    surface problem); advice names a setting that would contain more. Runs
    no model and changes nothing. Exit 0 no risk, 2 a risk, 10 could not run.

  security test [--host claude-code|opencode|cursor|codex|qwen-code|copilot|all] [--role <r>] [--sandbox [--image <ref>] [--loopback deny]] [--json] [--dir <path>]
    A model-free attack corpus run through the real guard against a scratch
    copy of this surface (bait .env, CI workflow, a precious directory, an
    isolated HOME; all removed afterwards): destructive commands,
    exfiltration, secrets, writes outside the project, CI and policy
    tampering, the records, host hooks, force-push, an ask under
    bypassPermissions, and controls against over-blocking. Each case is
    mapped to OWASP LLM Top 10 ids and says what it expected and got.
    Exit 0 every case held, 2 one did not, 10 could not run.
    --sandbox adds the sandbox-escape probes: configuration and containment
    checks (never exploits) of every place a command runs: tool paths at
    each [sandbox] level, and bash under exec = off, os, os with reads =
    scoped, and docker (the image must already be present; --image names
    another). Canary files outside the project root, a fake credential in a
    substituted HOME, network egress with network = false, the docker
    socket, capabilities and no_new_privs, host PID/network namespaces,
    writable host mounts, /proc/sys and cgroup. Each probe is reported per
    level as pass, FAIL (a claimed containment that did not hold: exit 2),
    open (not claimed, a documented limit), or skipped with why. Needs no
    root; skips where docker or the OS sandbox is unavailable.

  compliance [--framework <id,...>] [--json] [--catalog <file>] [--dir <path>]
    Which controls of which frameworks this project has gnomon evidence for:
    eu-ai-act, gdpr, owasp-llm, iso-42001, nist-ai-rmf, iso-27001, soc2,
    cra (gnomon itself as the product) and dora, from a dated catalog. Each control is
    evidence (every setting holds), partial, gap (each names the setting
    that would close it), a gnomon property, or organisational (gnomon has
    no evidence for it). A mapping, never an assessment: it never says
    compliant, and it is not legal advice. Read-only. Exit 0 no gap,
    2 a gap or partial, 10 could not run.

  compliance pack --out <dir> [--framework <id,...>] [--with-trails] [--json]
  compliance pack --verify <dir> [--json]
    The evidence pack: every read-only report (surface manifest, compliance,
    security posture and test, data flows, process metrics, every audit
    trail verified, the eval and trial reports) as JSON and text in a new
    directory, with pack.json naming each file's sha256. --with-trails copies
    the trails too. --verify re-hashes a pack: exit 0 every file matches,
    2 one is missing or changed. Changes nothing in the project; never says
    compliant. Exit 10 could not run.

  compliance dataflow [--json] [--dir <path>]
    The data-flow register: every model endpoint a role can reach (primary,
    fallback, escalation) with host, locality, declared region and what goes
    there; MCP servers; roles that can fetch from the network; the audit
    anchor's witness; where records stay; other harnesses governed here by
    gnomon guard, whose model requests gnomon does not route (named, and
    outside the residency rule). With [compliance] allowed_regions
    in policy.toml (opt-in), each route says whether the rule admits it: a
    role routed outside the listed regions refuses to run, and a fallback or
    escalation outside them is dropped. Read-only. Exit 0 every route
    admitted or no rule, 2 one refused or closed, 10 could not run.

  eval [--against profile:<name>|surface:<git ref>|command:<harness>]
       [--base command:<harness>] [--spec <name>] [--yes]
       [--yes-spend] [--trust] [--json] [--dir <path>]
  eval --ablate [components] [--families <a,b>] [--run] [--k <n>]
       [--budget-usd <x>] [--max-requests <n>] [--propose] [--allow-host-probes] [--json]
    Which parts of this surface still earn their keep? Builds one arm per
    component (system.md sections, skills, [verify], approval mode in the
    eval clone only, masking, the think cap, the structured summary, each
    non-essential tool, the memory index), each the surface with exactly
    that one thing removed or neutralised, and measures it against the base
    on .gnomon/trials/, optionally once per declared model family. Reports
    pass, steps, tokens and refusals with the eval's uncertainty and a
    verdict per component: load_bearing, neutral or harmful (inconclusive
    when the sample cannot say). Never applied. Governance (policy deny
    rules, sandbox, guard, audit) is never ablated. Dry by default: --run
    measures, under the same refusals as improve (no agent session, a
    confined [sandbox], billed roles need declared rates or --max-requests).
    --propose (with --run) writes retirement proposals for neutral-and-cheaper
    skills and system.md sections. Exit 0 done, 1 usage, 3 refused, 10 could not run.

  eval (spec form)
    Measure on this project's own tasks (.gnomon/trials/<name>.toml, the
    skill trial's spec): alone, the surface's pass rate; with --against,
    whether another profile, the .gnomon/ of another commit with HEAD's
    code, or another harness's CLI ([harness.<name>] command in the spec:
    Claude Code, opencode, ...) does better. --base command:<harness> puts
    another harness in place of gnomon's arm. Paired and interleaved, each
    cell in a fresh private clone, judged by the task's check command. A
    command arm's requests and tokens are not metered (null), and it needs
    --yes-spend unless the spec declares it local = true. Writes
    .gnomon-trials/_eval/<utc>/ and an eval_run audit record. Changes
    nothing. Exit 0 meets the spec, 2 does not, 10 no answer.

  improve [--dry-run] [--run] [--k <n>] [--budget-usd <x>] [--role <role>]
          [--max-requests <n>] [--allow-host-probes] [--schedule nightly|weekly] [--incidents] [--json] [--dir <path>]
    Governed self-improvement (Harness^2's propose, probe, compose, over the
    hashed surface). Mines the audit trails for what keeps recurring: a
    refused rule (a skill), a skill that fires but is never cited (a
    retirement), a build command or opening files (a memory entry), a
    failure class (a note for system.md). --dry-run (the default) prints
    what it would do: no model call, no write. --run drafts each with a
    local role (--role names another; a cloud role only when named), lints
    it, probes it against the base surface on .gnomon/trials/ (k attempts
    per task, in temporary clones, under --budget-usd), composes the ones
    that helped, and writes PROPOSALS plus one inbox item; nothing reaches
    .gnomon/ until a person accepts (gnomon proposals) or the surface
    declares [improve] auto_accept in policy.toml and a lint-clean, probed
    proposal meets its thresholds. --run refuses without a confined
    [sandbox] (or --allow-host-probes) and, for a billed probe role with no
    declared rates, without --max-requests. --schedule writes
    .gnomon/loops/improve.toml for a person to commit and install. A failure
    is mined by its attributed cause (docs/CONTRACTS.md section 60): a Tools
    cause is a note, a Context cause a note plus a suggestion in the
    rationale for a person (config is never edited). --incidents drafts
    regression trial specs from incidents in the trails (a boundary that
    held, a tamper caught, a check that failed then passed, an overflow
    survived), deterministic, no model, dry by default; --run writes them as
    proposals for trials/incident-*.toml, which only a person accepts, never
    policy. Exit 0 done, 1 usage, 3 refused, 10 could not run.

  chaos [--json] [--seed <n>] [--faults <id,...>] [--schedules <s,...>] [--out <file>]
    The fault-injection suite. A scripted model behind a loopback endpoint
    answers a fixed task set and injects one fault per case: errors, timeouts,
    empty and truncated replies, corrupt bodies, schema-violating tool calls,
    rate limits, and faults seen in the field (late system messages dropped,
    a relay that keeps abandoned requests running, slow throughput, tool
    calls in reasoning_content). Each is scored ANNOUNCED or SILENT for
    \`task --json\`, in a scratch project; nothing else is touched. Exit 0
    every fault announced, 1 one or more silent, 2 the run is void.
    \`chaos list\` prints the faults; \`chaos serve\` runs the endpoint for
    another harness (docs/benchmarks/CHAOS.md).

  prompt [--continue | --resume <id>] [--trust]
    Interactive agent loop. --continue resumes the most recent session,
    --resume <id> a specific one. Conversations are saved after every turn.
    An untrusted surface granting more than the defaults is shown and asked
    about first: [y] trust it, [N] run with the defaults, [q] quit (exit 3).

  run
    Alias for \`prompt\`

  acp [--role <name>] [--profile <name>]
    Serve the Agent Client Protocol on stdin/stdout, for an editor (Zed,
    JetBrains, any ACP client). The same surface, roles, approval gate and
    audit trail as \`prompt\`: approvals become the editor's permission
    prompts, roles its modes. The editor starts this; you configure it once.

  update [--check] [--force] [--notice on|off]
    Show this version, the latest release and its changelog, then update
    the way this copy was installed: a global install re-runs the installer
    (npm package and native binaries together), a checkout is told the git
    commands. --check only reports. --notice off silences the once-a-day
    "newer version" line that interactive launch/prompt may print.

  uninstall
    Print the exact commands that remove this install and its native
    binaries. Your stored keys and each project's .gnomon/ are left alone.

Flags that apply across commands:
  --profile <name>        Merge .gnomon/profiles/<name>.toml over the base
                          roles for this run. It rewrites per-role model and
                          endpoint — i.e. which machine runs inference and who
                          is billed — and is accepted by simulate, endpoint,
                          audit, task, skill, prompt, sessions and trust. It is
                          machine-scoped: it does NOT move the surface hash,
                          so two machines can disagree about routing while
                          agreeing about behaviour. A name with no file in
                          .gnomon/profiles/ is reported, not obeyed.
  --dir <path>            Act on that project instead of the cwd.

One-shot mode: gnomon <command>
Interactive mode: gnomon prompt

Getting started in a project:
  cd /path/to/project
  gnomon launch

Environment:
  GNOMON_BIN_OVERRIDE     Directory holding the native binaries (a release
                          archive unpacked by hand, or a test build)
  GNOMON_BUILD            The build string records name (a release archive's
                          GNOMON_BUILD file), instead of version+commit
  GNOMON_SHELL            The POSIX shell bash runs through (Windows, when Git
                          for Windows' bash is not where gnomon looks)
  GNOMON_MODEL_URL        Send every model call to this URL instead of the
                          declared endpoint's. Machine-scoped: not in the
                          surface hash, so replay cannot reproduce it
  GNOMON_NO_UPDATE_CHECK  Set to 1 to never look for a newer release
  GNOMON_DEADLINE         \`gnomon task --deadline\` when the flag is absent:
                          seconds from now, or an ISO 8601 time with a zone.
  GNOMON_TRUST            A surface hash (or 12+ char prefix): run THAT surface
                          as declared even though it is untrusted. Any other
                          surface is still clamped. See \`gnomon trust\`.
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // First, before anything slow: a long-running command's /proc cmdline is
  // "gnomon task", not the task text a model's `pkill -f` could match
  // (proc_title.ts).
  setProcessTitle(process.argv.slice(2));
  const args = parseArgs(process.argv.slice(2));

  // [audit.anchor] delivers sealed heads after the checkpoint at session end.
  // In this process that delivery would die with `gnomon task`'s exit, so the
  // CLI hands it to a detached `gnomon audit anchor --background`. Inert when
  // nothing is queued, and absent [audit.anchor] nothing ever is.
  setAnchorScheduler((s) => detachedAnchorFlush(s));

  // Deliberately NOT applied here. This is before any surface is loaded, so
  // there is nothing to say which names are credentials -- and injecting the
  // whole store blind is exactly the hole this closes: the store accepted any
  // shell identifier, and GNOMON_MODEL_URL, GNOMON_MODEL_TIMEOUT_MS and
  // GNOMON_BIN_OVERRIDE are all read from the environment. Storing one of
  // those rerouted inference with the surface hash unchanged.
  //
  // Every command that can reach a model applies them itself once it has a
  // surface: runTask and runPromptLoop in the loop, and the endpoint commands
  // below. A command with no surface has no business holding a key.

  // `gnomon help <command>` and `gnomon <command> --help`: that command's part
  // of the help, and nothing run. Most commands read --help as one more
  // argument and went on to do their work -- `gnomon launch --help` in an empty
  // directory wrote a .gnomon/ there (end-to-end audit, 2026-11-21).
  const asked =
    args.command === "help" ? process.argv[3] : asksCommandHelp(args.command, process.argv.slice(3)) ? args.command : undefined;
  if (asked) {
    const block = commandHelp(asked);
    if (block) {
      console.log(`${block}\n\nEvery command: gnomon --help`);
      return;
    }
  }
  if (args.command === "--help" || args.command === "-h" || args.command === "help") {
    showHelp();
    return;
  }

  // One line, the way every other CLI answers it. It used to fall through to
  // showHelp(), so the version was the first of ~100 lines and `gnomon version`
  // was an unknown command.
  const first = process.argv[2];
  if (first === "--version" || first === "-v" || first === "-V" || args.command === "version") {
    console.log(harnessBuild());
    return;
  }

  // Reporting commands piped into a file, grep or CI log printed raw escape
  // codes (`[1mlocal[0m`). paint() already honours NO_COLOR, so set it for
  // them when stdout is not a terminal. Not for commands that run tools: the
  // variable would be inherited by the project's own commands and change what
  // they print, which is not this flag's business. FORCE_COLOR opts back in.
  const reporting = ["endpoint", "key", "audit", "sessions", "skill", "surface", "init", "migrate", "enumerations", "trust", "doctor"];
  if (reporting.includes(args.command) && !process.stdout.isTTY && !process.env.FORCE_COLOR) {
    process.env.NO_COLOR = "1";
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
    case "setup": {
      const code = await cmdSetup(args);
      if (code !== 0) process.exit(code);
      break;
    }
    case "doctor": {
      const code = await cmdDoctor(args);
      if (code !== 0) process.exit(code);
      break;
    }
    case "migrate":
      await cmdMigrate(args);
      break;
    case "key":
    case "keys":
      await cmdKey(args);
      break;
    case "endpoint":
    case "endpoints":
      await cmdEndpoint(args);
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
    case "update":
    case "upgrade": {
      const code = await cmdUpdate({
        check: args.flags.check === "true",
        force: !!args.force,
        notice: args.flags.notice,
      });
      if (code !== 0) process.exit(code);
      break;
    }
    case "uninstall":
      cmdUninstall(credentialsPath(), installedLoopEntries());
      break;
    case "launch":
      maybeNotifyUpdate(args.command, !!args.json);
      await cmdLaunch(args);
      break;
    case "prompt":
    case "run":
      maybeNotifyUpdate(args.command, !!args.json);
      await cmdPrompt(args);
      break;
    case "acp":
      await cmdAcp(args);
      break;
    case "loop":
    case "loops":
      await cmdLoop(args);
      break;
    case "tui":
      await cmdTui(args);
      break;
    case "trust":
      await cmdTrust(args);
      break;
    case "proposals":
    case "proposal": {
      const code = runProposals(loadConfig(args.dir, args.flags["profile"]), { sub: args.subcommand ?? "", positional: args.positional, flags: args.flags, json: !!args.json });
      if (code !== 0) process.exit(code);
      break;
    }
    case "memory": {
      const code = runMemory(loadConfig(args.dir, args.flags["profile"]), { sub: args.subcommand ?? "", positional: args.positional, flags: args.flags, json: !!args.json });
      if (code !== 0) process.exit(code);
      break;
    }
    case "inbox": {
      if (args.flags["hook"]) {
        // A hook never fails the host: see runInboxHook.
        process.exitCode = runInboxHook(args.dir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), console.log, args.flags["hook"] === "cursor" ? "cursor" : "claude-code");
        break;
      }
      if (args.subcommand === "mcp") {
        await serveInboxMcp(args.dir);
        break;
      }
      const code = runInbox({ sub: args.subcommand ?? "", positional: args.positional, flags: args.flags, dir: args.dir, json: !!args.json });
      if (code !== 0) process.exit(code);
      break;
    }
    case "check": {
      const { cmdCheck } = await import("./check.js");
      process.exit(await cmdCheck(args));
    }
    case "security": {
      const code = await cmdSecurity(args);
      if (code !== 0) process.exit(code);
      break;
    }
    case "compliance": {
      const code = await cmdCompliance(args);
      if (code !== 0) process.exit(code);
      break;
    }
    case "eval": {
      process.exit(await cmdEval(args));
    }
    case "improve": {
      const config = loadConfig(args.dir, args.flags["profile"]);
      const code = await runImproveCmd(
        config,
        { flags: args.flags, json: !!args.json, dir: args.dir, role: args.role },
        {
          model: bindDraftModel(config),
          settleTrust: (c) => settleTrustHeadless(c, trustOptions(args)).outcome,
          runCell: (wt, prompt, o) => runTask(loadConfig(wt, o.profile), prompt, { role: o.role, yes: args.yes, trust: o.trust }),
        }
      );
      process.exit(code);
    }
    case "chaos": {
      // Its own argv parser, like guard: subcommands and flags it alone reads.
      const { cmdChaos } = await import("./chaos.js");
      const at = process.argv.indexOf("chaos", 2);
      process.exitCode = await cmdChaos(process.argv.slice(at + 1));
      return;
    }
    case "guard": {
      // Its own argv parser and a lean import: see guard_main.ts.
      const { cmdGuard } = await import("./guard.js");
      const at = process.argv.indexOf("guard", 2);
      process.exitCode = await cmdGuard(process.argv.slice(at + 1));
      return;
    }
    case "dashboard":
    case "ui": {
      // Lazy, like guard: nothing of the dashboard loads for any other command.
      const { cmdDashboard } = await import("./dashboard.js");
      const at = process.argv.indexOf(args.command, 2);
      process.exitCode = await cmdDashboard(process.argv.slice(at + 1));
      return;
    }
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

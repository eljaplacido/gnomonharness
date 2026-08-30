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
  probeEndpointAuth,
  describeEndpoints,
  printEndpoints,
  setEndpointBlock,
  setRoleModel,
  listRoles,
  resolveUi,
  isLocalEndpoint,
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

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Providers worth not making someone look up.
 *
 * A URL, a request shape and a key variable is the whole of an endpoint, and
 * all three are things you can get subtly wrong in ways that surface much
 * later as a 401 or an empty model list. Presets are not a feature; they are
 * the three fields, already correct.
 */
const ENDPOINT_PRESETS: Record<
  string,
  { name: string; url: string; kind: string; api_key_env?: string; provider?: string; note: string }
> = {
  "opencode-go": {
    name: "go",
    url: "https://opencode.ai/zen/go/v1/chat/completions",
    kind: "openai",
    api_key_env: "OPENCODE_API_KEY",
    provider: "opencode",
    note: "OpenCode Go — the subscription tier at opencode.ai/go",
  },
  "opencode-zen": {
    name: "zen",
    url: "https://opencode.ai/zen/v1/chat/completions",
    kind: "openai",
    api_key_env: "OPENCODE_API_KEY",
    provider: "opencode",
    note: "OpenCode Zen — pay-as-you-go",
  },
  openrouter: {
    name: "openrouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    kind: "openai",
    api_key_env: "OPENROUTER_API_KEY",
    provider: "openrouter",
    note: "OpenRouter — many providers behind one key",
  },
  ollama: {
    name: "local",
    url: "http://127.0.0.1:11434/api/chat",
    kind: "ollama",
    provider: "ollama",
    note: "Ollama on this machine — no key",
  },
};

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
  const sub = args.subcommand ?? "list";
  const config = loadConfig(args.dir);

  if (sub === "list") {
    printEndpoints(describeEndpoints(config), resolveUi(config), null);
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
    applyCredentials();
    const probes = new Map<string, { ok: boolean; status?: number; detail?: string }>();
    for (const row of rows) {
      const model = args.flags.model ?? row.probeModel;
      if (!model) continue;
      probes.set(row.name, await probeEndpointAuth(row.endpoint, model, 20000));
    }
    printEndpoints(rows, resolveUi(config), probes);
    const bad = [...probes.values()].filter((p) => !p.ok);
    if (bad.length > 0) process.exit(1);
    return;
  }

  if (sub !== "add") {
    console.error(`Unknown endpoint subcommand: ${sub}. Use: add | test | list`);
    process.exit(1);
  }

  const interactive = process.stdin.isTTY;
  applyCredentials();

  // ── 1. Which provider ────────────────────────────────────────────────────
  let presetKey = args.flags.preset;
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
    process.exit(1);
  }

  // ── 2. Name, URL, shape ──────────────────────────────────────────────────
  const defaultName = preset?.name ?? "custom";
  const name =
    args.flags.name ?? (interactive ? await ask(`Endpoint name [${defaultName}]: `, defaultName) : defaultName);

  const existing = config.config.endpoints?.[name];
  if (existing && existing.url !== (args.flags.url ?? preset?.url)) {
    // The failure this catches: a local daemon already declared as "go", and
    // every attempt to add OpenCode Go quietly re-pointed roles at it instead.
    console.log(`\n  "${name}" is already declared, and points somewhere else:`);
    console.log(`    ${existing.url}`);
    const roles = describeEndpoints(config).find((r) => r.name === name);
    if (roles && (roles.primary.length > 0 || roles.fallback.length > 0)) {
      console.log(`    used by: ${[...roles.primary, ...roles.fallback].join(", ")}`);
    }
    const go = interactive
      ? await ask(`  Overwrite it? [y/N] `, "n")
      : args.force
        ? "y"
        : "n";
    if (!/^y/i.test(go)) {
      console.log("  Left alone. Choose another name with --name <name>.");
      return;
    }
  }

  const url =
    args.flags.url ??
    preset?.url ??
    (interactive ? await ask("URL (…/chat/completions or …/api/chat): ") : "");
  if (!url) {
    console.error("An endpoint needs a url. Pass --url.");
    process.exit(1);
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
    const held = Boolean(process.env[keyEnv]);
    let store = true;
    if (held && interactive) {
      const keep = await ask(`  $${keyEnv} already has a value. Keep it? [Y/n] `, "y");
      store = !/^y/i.test(keep);
    }
    if (store) {
      if (!interactive) {
        console.error(`$${keyEnv} is not set. Run: gnomon key set ${name}`);
        process.exit(1);
      }
      const value = await readSecret(`  Paste the key for $${keyEnv} (hidden): `);
      if (!value) {
        console.error("  Nothing entered — no change.");
        process.exit(1);
      }
      setCredential(keyEnv, value);
      process.env[keyEnv] = value;
      console.log(`  Stored in ${credentialsPath()} (mode 0600). The surface holds only the name.`);
    }
  }

  const endpoint = { url, kind: kind as "openai" | "ollama", api_key_env: keyEnv, provider };

  // ── 4. Which model, from what the endpoint actually offers ───────────────
  let model = args.flags.model;
  if (!model) {
    process.stdout.write("  Asking the endpoint what it serves… ");
    const offered = await listModelsAt(endpoint);
    if (offered.length === 0) {
      console.log("no list available.");
      model = interactive ? await ask("  Model tag: ") : "";
    } else {
      console.log(`${offered.length} models.`);
      if (interactive) {
        const preview = offered.slice(0, 40);
        for (let i = 0; i < preview.length; i += 3) {
          console.log("    " + preview.slice(i, i + 3).map((m) => m.padEnd(26)).join(""));
        }
        if (offered.length > preview.length) {
          console.log(`    …and ${offered.length - preview.length} more`);
        }
        model = await ask(`  Model [${offered[0]}]: `, offered[0]!);
      } else {
        model = offered[0]!;
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
    process.exit(1);
  }

  // ── 5. Prove it, before writing anything ─────────────────────────────────
  process.stdout.write(`  Running one token through ${name} as ${model}… `);
  const probe = await probeEndpointAuth(endpoint, model, 30000);
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
      console.error(`\n  Either the URL or the model tag is wrong for this provider.`);
    }
    console.error(`\n  Nothing was written to .gnomon/. Fix the above and run this again.`);
    process.exit(1);
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
  if (!wanted && interactive) {
    console.log(`\n  Roles: ${roleNames.join(", ")}`);
    wanted = await ask("  Point which at it? (comma-separated, blank for none): ", "");
  }
  const chosen = wanted
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  if (chosen.length > 0) {
    const rolesPath = join(config.gnomonDir, "roles.toml");
    let text = readFileSync(rolesPath, "utf-8");
    for (const role of chosen) {
      if (!roleNames.includes(role)) {
        console.error(`  ⚠ no [roles.${role}] — skipped.`);
        continue;
      }
      text = setRoleModel(text, role, model, name);
      console.log(`  ✓ ${role} → ${model} @${name}`);
    }
    writeFileSync(rolesPath, text);
    console.log(`  ✓ .gnomon/roles.toml`);
  }

  const hash = surfaceHash(config.gnomonDir);
  console.log(`\n  Surface now ${hash.slice(0, 16)}… — commit .gnomon/ to carry this to another machine.`);
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

  endpoint [add|test|list]
    add   Declare an endpoint end to end: provider, key, model, roles. It
          asks the endpoint to run one token before writing anything, so a
          rejected key is caught here rather than mid-task. Presets:
          --preset opencode-go | opencode-zen | openrouter | ollama
          Scriptable: --name --url --kind --key-env --model --role
    test  Run one token through a declared endpoint (or all of them) and
          report what came back. A model listing is not a test of a key —
          some providers serve one to no key at all.

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

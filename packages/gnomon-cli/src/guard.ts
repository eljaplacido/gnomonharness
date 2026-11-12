/**
 * gnomon-cli: `gnomon guard` — the pre-tool-use decision, and the adapters
 * that put it in front of other harnesses.
 *
 * The decision is gnomon-core's guardToolCall, which calls the prechecks the
 * loop's own tools run (tools.ts toolCallPolicy). This file reads a call from
 * flags or stdin, in gnomon's own shape or a harness's hook payload, and
 * answers in the shape that harness reads.
 *
 * It imports `gnomon-core/guard` and nothing else from the workspace: it runs
 * on every tool call of someone else's agent, so it must not load the turn
 * loop, the TUI or the natives to answer. The published launcher
 * (bin/gnomon.mjs) imports this file directly for `gnomon guard`.
 */

import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  GUARD_HARNESSES,
  GUARD_TOOLS,
  committedAtHead,
  guardExit,
  guardLiveSessions,
  guardRepo,
  sessionsWithoutGuard,
  guardHarnessRequest,
  readHarness,
  toClaudeCode,
  toCursor,
  type GuardHarness,
  type GuardLiveSession,
  type GuardVerdict,
  writeFileIn,
} from "gnomon-core/guard";

export const GUARD_USAGE = `Usage: gnomon guard --tool <${GUARD_TOOLS.join("|")}> --input <json> [options]
       gnomon guard [--from generic|claude-code|opencode|cursor] [options] < call.json
       gnomon guard install claude-code|opencode|cursor [--write] [--dir <path>] [--bin <path>]
       gnomon guard status [--dir <path>] [--expect claude-code,opencode,cursor] [--json]

Options:
  --base <rev>         read the rules from <rev> (default: the session's recorded base, else HEAD)
  --role <role>        decide as this role
  --agent <name>       map this agent name to a role through [check.roles]
  --session <id>       the calling harness's session id (names the trail and the recorded base)
  --dir <path>         the directory the call is made in (default: the payload's cwd, else here)
  --session-base <sha> the commit the calling harness's session started at; used and recorded
                       only when the session has no recorded base yet (the opencode plugin)

Exit (generic and opencode): 0 allow, 2 deny, 3 ask, 10 no decision (answered as ask).
claude-code and cursor answer in their own hook format and exit 0.
install writes the absolute path of a gnomon that answers \`gnomon guard\` (--bin, else
$GNOMON_GUARD_BIN, else the gnomon running the install, else the one on PATH), and refuses
(exit 10) when none does.
status: 0 every installed hook is in place, 2 a hook is missing, changed or switched off,
10 not governed. It also lists the host sessions the guard has decided for.`;

export interface GuardArgs {
  sub?: string;
  positional: string[];
  flags: Record<string, string>;
}

/** Flags only; values never start with "--". Kept local so this file needs nothing else. */
export function parseGuardArgs(argv: string[]): GuardArgs {
  const out: GuardArgs = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = "true";
    } else if (out.sub === undefined && out.positional.length === 0 && (a === "install" || a === "status")) out.sub = a;
    else out.positional.push(a);
  }
  return out;
}

/** Run the command; returns the exit code rather than exiting, for tests. */
export async function cmdGuard(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s.endsWith("\n") || s === "" ? s : `${s}\n`),
  stdin: () => string = () => readFileSync(0, "utf-8")
): Promise<number> {
  const args = parseGuardArgs(argv);
  if (args.flags.help === "true" || args.flags.h === "true") {
    out(GUARD_USAGE);
    return 0;
  }
  if (args.sub === "install") return installGuard(args, out);
  if (args.sub === "status") return statusGuard(args, out);

  const from = (args.flags.from ?? "generic") as GuardHarness;
  if (!(GUARD_HARNESSES as readonly string[]).includes(from)) {
    console.error(`gnomon guard: --from must be one of ${GUARD_HARNESSES.join(", ")} (got "${from}")`);
    return 10;
  }

  let raw: Record<string, unknown>;
  if (args.flags.tool) {
    let input: unknown = {};
    try {
      input = args.flags.input ? JSON.parse(args.flags.input) : {};
    } catch (err) {
      return answer(from, noDecision(args.flags.tool, `--input is not JSON: ${(err as Error).message}`), out);
    }
    raw = { tool: args.flags.tool, input };
  } else {
    try {
      const text = stdin();
      raw = JSON.parse(text) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a JSON object");
    } catch (err) {
      return answer(from, noDecision("(unread)", `stdin is not the call as JSON: ${(err as Error).message}`), out);
    }
  }

  const hr = readHarness(from, raw);
  const verdict = await guardHarnessRequest(hr, {
    cwd: args.flags.dir ? resolve(args.flags.dir) : undefined,
    base: args.flags.base,
    role: args.flags.role,
    agent: args.flags.agent,
    session: args.flags.session,
    sessionBase: args.flags["session-base"],
    harness: from,
  });
  return answer(from, verdict, out, hr.event);
}

function noDecision(tool: string, error: string): GuardVerdict {
  return {
    schema: "gnomon.guard/1",
    decision: "ask",
    rule: "error",
    reason: `gnomon could not decide this call, so a person should: ${error}`,
    tool,
    role: null,
    base: null,
    surface_hash: null,
    governed: true,
    error,
    elapsed_ms: 0,
  };
}

/** Print the verdict the way the calling harness reads it; return the exit. */
function answer(from: GuardHarness, v: GuardVerdict, out: (s: string) => void, event?: string): number {
  switch (from) {
    case "claude-code": {
      // Exit 0 with JSON is how a PreToolUse hook decides; nothing on allow.
      const s = toClaudeCode(v);
      if (s) out(s);
      return 0;
    }
    case "cursor":
      out(toCursor(v, event));
      return 0;
    default:
      out(JSON.stringify(v));
      return guardExit(v.decision, v.error !== undefined);
  }
}

// ---------------------------------------------------------------------------
// Adapters: what each harness is given to install
// ---------------------------------------------------------------------------

/**
 * The Claude Code tools the PreToolUse hook is run for. The ones gnomon has a
 * tool kind for are decided by its rules; WebSearch as a network call; Agent
 * and Task (a subagent, whose own calls reach the hook one by one) are
 * recorded; every MCP tool (`mcp__<server>__<tool>`) is recorded as
 * `ungoverned` and, under a declared `[governance]`, put to a person
 * (CONTRACTS.md §10, "Other host tools"). Left to Claude Code: TodoWrite,
 * ExitPlanMode and the other tools with no effect outside the conversation.
 */
export const CLAUDE_CODE_MATCHER = "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|WebFetch|WebSearch|Grep|Glob|Agent|Task|mcp__.*";
/** Tool names the matcher must select, for `guard status` (one stands in for every MCP tool). */
export const CLAUDE_CODE_MATCHED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "WebFetch",
  "WebSearch",
  "Grep",
  "Glob",
  "Agent",
  "Task",
  "mcp__server__tool",
];
const CC_GUARD_TAIL = "guard --from claude-code --agent claude-code";
const CC_START_TAIL = "check --hook session-start";
const CC_STOP_TAIL = "check --hook stop --agent claude-code";
const CURSOR_TAIL = "guard --from cursor --agent cursor";
export const CLAUDE_CODE_GUARD_COMMAND = `gnomon ${CC_GUARD_TAIL}`;

/**
 * A program (an argv prefix) as a shell word list. Claude Code and Cursor run
 * a hook's command through a shell, so a path with a space or a quote must be
 * quoted; a plain one is left as it is, to stay readable.
 */
export function shellCommand(argv: string[], tail: string): string {
  const q = (w: string) =>
    /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(w)
      ? w
      : process.platform === "win32"
        ? `"${w.replace(/"/g, '\\"')}"`
        : `'${w.replace(/'/g, "'\\''")}'`;
  return `${argv.map(q).join(" ")} ${tail}`;
}

/**
 * The part of a hook command after the program: `guard --from claude-code
 * --agent claude-code`, or null when the command is not a gnomon one. The
 * program may be `gnomon`, an absolute path to it, or node and a launcher
 * script — anything that names gnomon.
 */
export function gnomonTail(command: string): string | null {
  const m = /^(.*?)\s+((?:guard|check)(?:\s.*)?)$/.exec(command.trim());
  if (!m || !/gnomon/i.test(m[1]!)) return null;
  return m[2]!.replace(/\s+/g, " ");
}

/** The program a hook command runs, when it is one absolute path (unquoted or quoted). */
function hookProgram(command: string): string | null {
  const t = command.trim();
  const quoted = /^(['"])(.*?)\1\s/.exec(t);
  const first = quoted ? quoted[2]! : t.split(/\s+/)[0]!;
  return isAbsolute(first) ? first : null;
}

/**
 * The PreToolUse hook, added to the SessionStart + Stop hooks `gnomon check
 * --install-hook claude-code` already prints — one fragment, not two that
 * could drift. SessionStart records the base the guard then reads its rules
 * from, so the three hooks judge a session by one policy. `bin` is the
 * program `install` resolved (resolveGnomonBin); bare `gnomon` by default.
 */
export function claudeCodeHooks(bin: string[] = ["gnomon"]): { hooks: Record<string, unknown[]> } {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: shellCommand(bin, CC_START_TAIL) }] }],
      PreToolUse: [
        {
          matcher: CLAUDE_CODE_MATCHER,
          hooks: [{ type: "command", command: shellCommand(bin, CC_GUARD_TAIL), timeout: 30 }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: shellCommand(bin, CC_STOP_TAIL), timeout: 900 }] }],
    },
  };
}

/** Cursor's hooks.json (version 1): the two documented pre-execution events gnomon can decide. */
export function cursorHooks(bin: string[] = ["gnomon"]): { version: number; hooks: Record<string, unknown[]> } {
  const command = shellCommand(bin, CURSOR_TAIL);
  return {
    version: 1,
    hooks: {
      beforeShellExecution: [{ command, timeout: 30 }],
      beforeReadFile: [{ command, timeout: 30 }],
    },
  };
}

// ---------------------------------------------------------------------------
// Which gnomon the hooks run
// ---------------------------------------------------------------------------

const answers = new Map<string, string | null>();

/** Does this program answer `guard --help` as gnomon guard? null when it does, else why not. */
function answersGuard(argv: string[]): string | null {
  const key = JSON.stringify(argv);
  if (answers.has(key)) return answers.get(key)!;
  const win = process.platform === "win32";
  const r = spawnSync(argv[0]!, [...argv.slice(1), "guard", "--help"], {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: win && /\.(cmd|bat)$/i.test(argv[0]!),
  });
  const why = r.error
    ? r.error.message
    : r.status !== 0
      ? `\`${argv.join(" ")} guard --help\` exited ${r.status ?? "on a signal"} (a gnomon without \`guard\`?)`
      : !/gnomon guard/.test(r.stdout)
        ? `\`${argv.join(" ")} guard --help\` did not print gnomon guard's usage`
        : null;
  answers.set(key, why);
  return why;
}

function onPath(name: string, env: NodeJS.ProcessEnv): string[] {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  const out: string[] = [];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const f = join(dir, name + ext);
      try {
        if (statSync(f).isFile()) {
          if (process.platform !== "win32") accessSync(f, fsConstants.X_OK);
          if (isAbsolute(f) && !out.includes(f)) out.push(f);
        }
      } catch {
        // not here, or not executable
      }
    }
  }
  return out;
}

/** The launcher running this process, as a program, when it is gnomon's. */
function runningLauncher(): string[] | null {
  const script = process.argv[1];
  if (!script || !isAbsolute(script)) return null;
  const name = basename(script);
  // An npx cache is gone by the next session: never write it into a hook.
  if (/[\\/]_npx[\\/]/.test(script)) return null;
  if (/^gnomon\.(m?js|cjs)$/.test(name)) return [process.execPath, script];
  if (/^gnomon(\.cmd|\.exe)?$/.test(name)) return [script];
  return null;
}

/**
 * The gnomon a hook should run, as an absolute program (an argv prefix), or
 * why there is none. A hook that says bare `gnomon` runs whatever PATH holds
 * when the HOST starts — in the 2026-11-12 governance test that was an older
 * gnomon without `guard`, and Claude Code ran every call unguarded (a hook
 * that cannot start is a non-blocking error to it). So the path is resolved
 * now, and each candidate must answer `gnomon guard --help`:
 * `--bin`, then `$GNOMON_GUARD_BIN`, then the gnomon running this install,
 * then each `gnomon` on PATH.
 */
export function resolveGnomonBin(given?: string, env: NodeJS.ProcessEnv = process.env): { argv: string[] } | { error: string } {
  const candidates: string[][] = [];
  if (given) candidates.push([resolve(given)]);
  else {
    if (env.GNOMON_GUARD_BIN) candidates.push([resolve(env.GNOMON_GUARD_BIN)]);
    const self = runningLauncher();
    if (self) candidates.push(self);
    for (const f of onPath("gnomon", env)) candidates.push([f]);
  }
  const tried: string[] = [];
  for (const argv of candidates) {
    const why = answersGuard(argv);
    if (why === null) return { argv };
    tried.push(`  ${argv.join(" ")}: ${why}`);
  }
  return {
    error:
      "no gnomon that answers `gnomon guard` was found, so no hook was written: a hook that cannot run " +
      "lets every call through unguarded." +
      (tried.length ? `\nTried:\n${tried.join("\n")}` : " Nothing was found to try (no --bin, no $GNOMON_GUARD_BIN, no gnomon on PATH).") +
      "\nInstall gnomon (npm i -g gnomon-harness) or pass --bin <path to gnomon>.",
  };
}

export const OPENCODE_PLUGIN_MARKER = "gnomon-guard: generated by `gnomon guard install opencode`";

/**
 * The opencode V2 (2.2.x) plugin. A file in `.opencode/plugins/` is loaded for
 * every session in the project: a default export `{ id, setup(api) }`.
 *
 *  - `api.tool.hook("execute.before", e)` sees each tool call — `{ tool,
 *    sessionID, agent, messageID, id, input }` — before it runs. Throwing
 *    there fails the call with the message, which the model reads: that is
 *    deny.
 *  - ask goes through opencode's own permission prompt: the plugin asserts a
 *    `gnomon_guard` permission, and its `permission.hook("evaluate")` turns
 *    that action's answer into "ask", so a person approves or rejects it in
 *    opencode's own UI. Under `--auto` opencode approves asks by itself, as it
 *    does every ask; a deny still stands.
 *  - gnomon not on PATH, or no answer: the call is refused, not waved through.
 *  - The rules come from the commit the session STARTED at, as Claude Code's
 *    SessionStart hook records it: the plugin reads HEAD when opencode loads
 *    it and hands it to every call as `--session-base`, which the guard uses
 *    (and records) for a session that has no base yet. A subagent's session
 *    takes its parent's base. A later session in a long-running opencode takes
 *    HEAD at its first call. GBS-LAYER pilot: the plugin had no session start,
 *    so a commit before a session's first call moved its rules.
 */
export function opencodePlugin(bin: string[] = ["gnomon"]): string {
  return `// ${OPENCODE_PLUGIN_MARKER}
// Every tool call (shell, write, edit, patch, read, grep, glob, list, webfetch, websearch,
// execute, task, MCP tools, ...) is put to this repository's .gnomon/ rules (as committed
// at the session's start) before it runs; a tool no rule governs is recorded as ungoverned.
// deny fails the call with gnomon's reason; ask raises opencode's own permission prompt;
// allow changes nothing. gnomon guard refuses edits to this file; \`gnomon guard status\`
// reports it missing or changed.
import { execFile, execFileSync } from "node:child_process";

// The gnomon \`gnomon guard install\` resolved, as an absolute program; $GNOMON_GUARD_BIN overrides it.
const GNOMON_ARGV = ${JSON.stringify(bin)};
const GNOMON = process.env.GNOMON_GUARD_BIN || GNOMON_ARGV[0];
const PREFIX = process.env.GNOMON_GUARD_BIN ? [] : GNOMON_ARGV.slice(1);
const AGENT = process.env.GNOMON_GUARD_AGENT || "opencode";
const ACTION = "gnomon_guard";

function head(directory) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      cwd: directory,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function guard(event, directory, base) {
  return new Promise((resolve) => {
    const args = [...PREFIX, "guard", "--from", "opencode", "--agent", AGENT];
    if (/^[0-9a-f]{40,64}$/.test(base || "")) args.push("--session-base", base);
    // Windows: npm installs gnomon as a .cmd shim, which only a shell starts
    // (execFile alone fails with ENOENT/EFTYPE). The arguments are fixed
    // flags and a checked commit id, so nothing here needs quoting.
    const win = process.platform === "win32";
    const program = win && /\\s/.test(GNOMON) ? '"' + GNOMON + '"' : GNOMON;
    const child = execFile(program, args, { cwd: directory, timeout: 30000, maxBuffer: 1 << 20, shell: win }, (err, stdout) => {
      try {
        resolve(JSON.parse(String(stdout).trim().split("\\n").pop()));
      } catch {
        resolve({ decision: "deny", reason: "gnomon guard gave no answer" + (err ? ": " + err.message : "") });
      }
    });
    // A gnomon that exits before reading stdin must not crash opencode: its
    // answer (or the deny for none) comes from the callback above.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...event, directory }));
  });
}

export default {
  id: "gnomon-guard",
  setup(api) {
    const directory = api.location?.directory || process.cwd();
    // The commit this opencode started at: the first session's base.
    const started = head(directory);
    const bases = new Map();
    async function parentOf(sessionID) {
      try {
        const get = api.session?.get;
        if (typeof get !== "function") return "";
        const s = await Promise.race([get({ sessionID }), new Promise((r) => setTimeout(() => r(null), 2000))]);
        const info = s && (s.info || s.data || s);
        return (info && typeof info.parentID === "string" && info.parentID) || "";
      } catch {
        return "";
      }
    }
    async function baseOf(sessionID) {
      if (!sessionID) return started;
      if (bases.has(sessionID)) return bases.get(sessionID);
      const parent = await parentOf(sessionID);
      const base = parent ? await baseOf(parent) : bases.size === 0 ? started : head(directory);
      bases.set(sessionID, base);
      return base;
    }
    api.permission.hook("evaluate", (e) => {
      if (e.action === ACTION && e.effect !== "deny") e.effect = "ask";
    });
    api.tool.hook("execute.before", async (e) => {
      const base = await baseOf(e.sessionID);
      const v = await guard({ tool: e.tool, sessionID: e.sessionID, agent: e.agent, id: e.id, input: e.input }, directory, base);
      if (v.decision === "allow") return;
      const why = "gnomon guard" + (v.rule && v.rule !== "approval" ? " (" + v.rule + ")" : "") + ": " + v.reason;
      if (v.decision === "ask") {
        await api.permission.assert({
          sessionID: e.sessionID,
          agent: e.agent,
          action: ACTION,
          resources: [e.tool + ": " + JSON.stringify(e.input).slice(0, 200)],
          metadata: { reason: why, rule: v.rule ?? null },
          source: { type: "tool", messageID: e.messageID, id: e.id },
        });
        return;
      }
      throw new Error(why);
    });
  },
};
`;
}

/**
 * Merge hook entries into a JSON settings file. An entry whose gnomon command
 * is already there (the same subcommand, whatever program runs it) is brought
 * up to date in place — its program, and a PreToolUse matcher — rather than
 * added twice: an older install wrote bare `gnomon` and a shorter matcher.
 */
function mergeHooks(project: string, file: string, fragment: { hooks: Record<string, unknown[]>; version?: number }): string[] {
  const current = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>) : {};
  const hooks = (current.hooks && typeof current.hooks === "object" ? current.hooks : {}) as Record<string, unknown[]>;
  const added: string[] = [];
  type Entry = { command?: unknown; matcher?: unknown; hooks?: Array<{ command?: unknown }> };
  const slots = (entry: unknown): Array<{ command?: unknown }> => {
    const e = entry as Entry;
    return [...(typeof e.command === "string" ? [e] : []), ...(Array.isArray(e.hooks) ? e.hooks : [])];
  };
  const tailOf = (c: unknown) => (typeof c === "string" ? (gnomonTail(c) ?? c) : null);
  for (const [event, entries] of Object.entries(fragment.hooks)) {
    const list = Array.isArray(hooks[event]) ? hooks[event]! : [];
    for (const entry of entries) {
      const want = slots(entry).map((h) => h.command as string);
      let changed = false;
      let found = 0;
      for (const cmd of want) {
        const tail = tailOf(cmd);
        for (const existing of list) {
          for (const h of slots(existing)) {
            if (tailOf(h.command) !== tail) continue;
            found++;
            if (h.command !== cmd) {
              h.command = cmd;
              changed = true;
            }
            const m = (entry as Entry).matcher;
            if (m !== undefined && (existing as Entry).matcher !== m) {
              (existing as Entry).matcher = m;
              changed = true;
            }
          }
        }
      }
      if (found === 0) {
        list.push(entry);
        added.push(event);
      } else if (changed) added.push(`${event} (updated)`);
    }
    hooks[event] = list;
  }
  const next = { ...(fragment.version !== undefined ? { version: fragment.version } : {}), ...current, hooks };
  // root_fs.ts: never through a symlink a contained command left in the project.
  writeFileIn(project, file, `${JSON.stringify(next, null, 2)}\n`);
  return added;
}

/**
 * Print what to install, or with `--write` install it into THIS project
 * (`.claude/settings.json`, `.opencode/plugins/`, `.cursor/hooks.json`) —
 * never into a user-wide config: a hook runs commands on the operator's
 * machine in every project, and that is theirs to place.
 */
function installGuard(args: GuardArgs, out: (s: string) => void): number {
  const target = args.positional[0];
  const write = args.flags.write === "true";
  const project = resolve(args.flags.dir ?? process.cwd());
  if (target !== "claude-code" && target !== "opencode" && target !== "cursor") {
    console.error(`gnomon guard install: claude-code, opencode or cursor (got "${target ?? ""}")\n\n${GUARD_USAGE}`);
    return 10;
  }
  const resolved = resolveGnomonBin(args.flags.bin && args.flags.bin !== "true" ? args.flags.bin : undefined);
  if ("error" in resolved) {
    console.error(`gnomon guard install: ${resolved.error}`);
    return 10;
  }
  const bin = resolved.argv;
  switch (target) {
    case "claude-code": {
      const fragment = claudeCodeHooks(bin);
      if (write) {
        const file = join(project, ".claude", "settings.json");
        const added = mergeHooks(project, file, fragment);
        recordInstall(project, "claude-code", file, bin);
        console.error(added.length ? `gnomon guard: added ${added.join(", ")} to ${file}` : `gnomon guard: ${file} already has these hooks`);
        return 0;
      }
      out(JSON.stringify(fragment, null, 2));
      console.error(
        [
          "",
          "Merge the above into the \"hooks\" of .claude/settings.json (this project) or",
          "~/.claude/settings.json (every project; ungoverned ones are allowed through). Or run",
          "`gnomon guard install claude-code --write` to merge it into this project's file.",
          "",
          "  SessionStart  records HEAD: the rules every call this session is decided by",
          "  PreToolUse    `gnomon guard` on each Bash/Write/Edit/Read/Grep/Glob/WebFetch/WebSearch,",
          "                Agent/Task and MCP call: deny or ask is handed to Claude Code; allow says",
          "                nothing, so Claude Code's own permission prompt still applies. MCP tools",
          "                are recorded as ungoverned, and asked under a declared [governance]",
          `Every hook runs ${bin.join(" ")}: an absolute path, so a host that starts with`,
          "another gnomon (or none) on its PATH still runs this one.",
          "  Stop          `gnomon check` on everything the session changed",
          "",
          "The role comes from [check.roles] in .gnomon/policy.toml: claude-code = \"implement\".",
        ].join("\n")
      );
      return 0;
    }
    case "opencode": {
      const file = join(project, ".opencode", "plugins", "gnomon-guard.js");
      if (write) {
        if (existsSync(file) && !readFileSync(file, "utf-8").includes(OPENCODE_PLUGIN_MARKER) && args.flags.force !== "true") {
          console.error(`gnomon guard: ${file} exists and was not written by gnomon; --force replaces it`);
          return 10;
        }
        writeFileIn(project, file, opencodePlugin(bin));
        recordInstall(project, "opencode", file, bin);
        console.error(`gnomon guard: wrote ${file}`);
        return 0;
      }
      out(opencodePlugin(bin));
      console.error(
        [
          "",
          `Save the above as .opencode/plugins/gnomon-guard.js (opencode 2.2.x loads every file`,
          "there), or run `gnomon guard install opencode --write`. Map the agent to a role in",
          ".gnomon/policy.toml: [check.roles] opencode = \"implement\".",
        ].join("\n")
      );
      return 0;
    }
    case "cursor": {
      const fragment = cursorHooks(bin);
      if (write) {
        const file = join(project, ".cursor", "hooks.json");
        const added = mergeHooks(project, file, fragment);
        recordInstall(project, "cursor", file, bin);
        console.error(added.length ? `gnomon guard: added ${added.join(", ")} to ${file}` : `gnomon guard: ${file} already has these hooks`);
        return 0;
      }
      out(JSON.stringify(fragment, null, 2));
      console.error(
        [
          "",
          "Merge the above into .cursor/hooks.json, or run `gnomon guard install cursor --write`.",
          "Cursor's documented hooks decide shell commands and file reads before they run; file",
          "writes have no documented pre-execution hook, so `gnomon check` judges those after.",
          "Map the agent to a role: [check.roles] cursor = \"implement\".",
        ].join("\n")
      );
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Whether the hooks are still there
// ---------------------------------------------------------------------------

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * A file's text as git compares it across checkouts: a Windows checkout
 * (core.autocrlf) holds CRLF where the commit and gnomon's own output hold
 * LF, and that is not a change to the hook.
 */
const lf = (b: string | Buffer) => (typeof b === "string" ? b : b.toString("utf-8")).replace(/\r\n/g, "\n");

/**
 * What `install --write` wrote, kept in gnomon's state for this repository
 * (outside it, and refused to every tool call as host hook configuration):
 * the file and its hash, so `status` can tell a removed or changed hook even
 * when the hook file was never committed.
 */
function recordInstall(project: string, host: string, file: string, bin: string[]): void {
  const repo = guardRepo(project);
  if (!repo) return;
  try {
    const at = join(repo.stateDir, "installed.json");
    const current = existsSync(at) ? (JSON.parse(readFileSync(at, "utf-8")) as Record<string, unknown>) : {};
    current[host] = { file, sha256: sha256(lf(readFileSync(file))), at: new Date().toISOString(), bin };
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, `${JSON.stringify(current, null, 2)}\n`);
  } catch {
    // An unwritable state dir: status then knows the hook from HEAD or --expect only.
  }
}

export type HookState = "ok" | "missing" | "modified" | "disabled" | "not_installed";
export interface HookStatus {
  host: string;
  state: HookState;
  file: string;
  /** Why the state is what it is; empty when ok. */
  detail: string;
}
export interface GuardStatus {
  schema: "gnomon.guard.status/1";
  governed: boolean;
  project: string | null;
  hosts: HookStatus[];
  /** One line per host whose hook is missing, changed or switched off. */
  findings: string[];
  /** How many host sessions the guard has decided for in this repository (CONTRACTS.md §41). */
  sessions_seen: number;
  /** The latest decision for any of them, ISO 8601; null when there was none. */
  last_decision: string | null;
  /** Those sessions, latest decision first (at most 50). */
  sessions: GuardLiveSession[];
  /**
   * Claude Code sessions whose SessionStart hook ran, since the hook was
   * installed, and for which the guard decided nothing: no selected tool
   * call, or a PreToolUse hook that did not run. `gnomon check --transcript`
   * tells the two apart.
   */
  unguarded_sessions: Array<{ session: string; started: string }>;
}

const readJson = (f: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(readFileSync(f, "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * The command of a hook on `event` that runs gnomon's `tail` (whatever
 * program runs it), and, given `tools`, whose matcher selects every one of
 * them; null when there is none.
 */
function runs(hooks: unknown, event: string, tail: string, tools?: string[]): string | null {
  const list = (hooks as Record<string, unknown> | undefined)?.[event];
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const e = entry as { command?: unknown; matcher?: unknown; hooks?: Array<{ command?: unknown }> };
    const commands = [e.command, ...(Array.isArray(e.hooks) ? e.hooks.map((h) => h?.command) : [])];
    const hit = commands.find((c): c is string => typeof c === "string" && gnomonTail(c) === tail);
    if (!hit) continue;
    if (!tools) return hit;
    const m = typeof e.matcher === "string" ? e.matcher : "";
    if (m === "" || m === "*") return hit;
    try {
      const re = new RegExp(`^(?:${m})$`);
      if (tools.every((t) => re.test(t))) return hit;
    } catch {
      // a matcher that does not compile selects nothing
    }
  }
  return null;
}

/** A hook file that has gnomon's guard in it at all: an install, perhaps older or edited. */
const COMMITTED_GUARD = /guard --from (?:claude-code|cursor)\b|gnomon-guard: generated by/;

/** Why a hook's program cannot run, when it is an absolute path that is not there. */
function absentProgram(command: string): string | null {
  const p = hookProgram(command);
  return p && !existsSync(p) ? `its command runs ${p}, which does not exist: the host would run every call unguarded` : null;
}

/**
 * Is each host's hook where `gnomon guard install` put it, unchanged and not
 * switched off? A host is EXPECTED when its hook file is committed at HEAD
 * with gnomon in it, when `install --write` recorded it, or when `--expect`
 * names it; an unexpected host with no hook is "not_installed", not a
 * finding. Read-only; it decides nothing a tool call is waiting on.
 */
export function guardStatus(dir: string, expect: string[] = [], env: NodeJS.ProcessEnv = process.env): GuardStatus {
  const repo = guardRepo(dir);
  const status: GuardStatus = {
    schema: "gnomon.guard.status/1",
    governed: repo !== null,
    project: repo?.project ?? null,
    hosts: [],
    findings: [],
    sessions_seen: 0,
    last_decision: null,
    sessions: [],
    unguarded_sessions: [],
  };
  if (!repo) return status;
  const installed = readJson(join(repo.stateDir, "installed.json")) ?? {};
  const recorded = (host: string) => installed[host] as { file?: string; sha256?: string; at?: string } | undefined;
  const committed = (file: string) => committedAtHead(repo.toplevel, relative(repo.toplevel, file));
  const claudeDir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");

  const judge = (host: string, file: string, present: (text: string) => string | null, extra?: () => string | null): HookStatus => {
    const atHead = committed(file);
    const rec = recorded(host);
    const live = existsSync(file) ? readFileSync(file) : null;
    // Committed with gnomon's guard in it — even an older or edited one — is expected.
    const expected =
      (atHead !== null && (present(lf(atHead)) === null || COMMITTED_GUARD.test(lf(atHead)))) || rec !== undefined || expect.includes(host);
    const at = (state: HookState, detail: string): HookStatus => ({ host, state, file, detail });
    if (live === null) return expected ? at("missing", "the hook file is gone") : at("not_installed", "");
    const wrong = present(lf(live));
    if (wrong !== null) return expected ? at("modified", wrong) : at("not_installed", "");
    if (atHead !== null && lf(atHead) !== lf(live)) return at("modified", "it differs from the version committed at HEAD");
    if (atHead === null && rec?.sha256 && rec.sha256 !== sha256(lf(live))) return at("modified", "it changed since `gnomon guard install` wrote it");
    const off = extra?.();
    if (off) return at("disabled", off);
    return at("ok", "");
  };

  const claudeFile = join(repo.project, ".claude", "settings.json");
  status.hosts.push(
    judge(
      "claude-code",
      claudeFile,
      (text) => {
        let hooks: unknown;
        try {
          hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
        } catch {
          return "it is not JSON Claude Code can read";
        }
        const cmd = runs(hooks, "PreToolUse", CC_GUARD_TAIL, CLAUDE_CODE_MATCHED_TOOLS);
        if (!cmd) {
          return runs(hooks, "PreToolUse", CC_GUARD_TAIL)
            ? `its PreToolUse matcher does not cover ${CLAUDE_CODE_MATCHER} (an older install? \`gnomon guard install claude-code --write\` updates it)`
            : `no PreToolUse hook runs \`${CLAUDE_CODE_GUARD_COMMAND}\``;
        }
        if (!runs(hooks, "SessionStart", CC_START_TAIL)) return "no SessionStart hook records the session's base";
        return absentProgram(cmd);
      },
      () => {
        for (const f of [claudeFile, join(repo.project, ".claude", "settings.local.json"), join(claudeDir, "settings.json"), join(claudeDir, "settings.local.json")]) {
          if (readJson(f)?.disableAllHooks === true) return `${f} sets disableAllHooks`;
        }
        return null;
      }
    )
  );
  const plugin = join(repo.project, ".opencode", "plugins", "gnomon-guard.js");
  status.hosts.push(
    judge("opencode", plugin, (text) => {
      let bin: string[] | null = null;
      try {
        const m = /^const GNOMON_ARGV = (.*);$/m.exec(text);
        const v = m ? (JSON.parse(m[1]!) as unknown) : null;
        if (Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === "string")) bin = v as string[];
      } catch {
        // not this gnomon's plugin: said below
      }
      if (bin && text === opencodePlugin(bin)) {
        return isAbsolute(bin[0]!) && !existsSync(bin[0]!) ? `it runs ${bin[0]}, which does not exist: opencode refuses every call` : null;
      }
      return text.includes(OPENCODE_PLUGIN_MARKER)
        ? "it is not the plugin this gnomon writes (edited, or an older version): `gnomon guard install opencode --write --force`"
        : "it is not gnomon's plugin";
    })
  );
  const cursorFile = join(repo.project, ".cursor", "hooks.json");
  status.hosts.push(
    judge("cursor", cursorFile, (text) => {
      let hooks: unknown;
      try {
        hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
      } catch {
        return "it is not JSON Cursor can read";
      }
      const shell = runs(hooks, "beforeShellExecution", CURSOR_TAIL);
      return shell && runs(hooks, "beforeReadFile", CURSOR_TAIL)
        ? absentProgram(shell)
        : `no beforeShellExecution and beforeReadFile hook runs \`gnomon ${CURSOR_TAIL}\``;
    })
  );
  for (const h of status.hosts) {
    if (h.state === "missing" || h.state === "modified" || h.state === "disabled") status.findings.push(`${h.host}: ${h.state} — ${relative(repo.project, h.file) || h.file}: ${h.detail}`);
  }
  // Liveness (CONTRACTS.md §41): which host sessions reached the guard.
  const live = guardLiveSessions(repo.project);
  status.sessions_seen = live.length;
  status.last_decision = live[0]?.last_decision ?? null;
  status.sessions = live.slice(0, 50);
  const cc = status.hosts.find((h) => h.host === "claude-code");
  if (cc && cc.state !== "not_installed") {
    const since = recorded("claude-code")?.at ?? live.map((l) => l.started).sort()[0];
    status.unguarded_sessions = sessionsWithoutGuard(repo.project, since);
  }
  return status;
}

function statusGuard(args: GuardArgs, out: (s: string) => void): number {
  const dir = resolve(args.flags.dir ?? process.cwd());
  const expect = (args.flags.expect ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const st = guardStatus(dir, expect);
  if (args.flags.json === "true") out(JSON.stringify(st));
  else if (!st.governed) out(`gnomon guard status: no .gnomon/ governs ${dir}`);
  else {
    for (const h of st.hosts) out(`${h.host.padEnd(12)} ${h.state.padEnd(14)} ${relative(st.project!, h.file)}${h.detail ? `  ${h.detail}` : ""}`);
    out(st.findings.length ? `\n${st.findings.length} finding(s): a host is not governed the way it was set up to be.` : "\nevery installed hook is in place.");
    out(
      st.sessions_seen === 0
        ? "\nsessions: the guard has not decided a call in this repository yet."
        : `\nsessions: ${st.sessions_seen} seen, last decision ${st.last_decision}`
    );
    for (const l of st.sessions.slice(0, 10)) {
      out(`  ${l.id.padEnd(40)} ${(l.via ?? "?").padEnd(12)} started ${l.started}  last ${l.last_decision}`);
    }
    if (st.unguarded_sessions.length) {
      out(
        `\n${st.unguarded_sessions.length} Claude Code session(s) started with no guard decision. If they made tool calls, ` +
          "the PreToolUse hook did not run; `gnomon check --scorecard` or `--transcript` says which:"
      );
      for (const u of st.unguarded_sessions.slice(-10)) out(`  ${u.session}  started ${u.started}`);
    }
  }
  if (!st.governed) return 10;
  return st.findings.length ? 2 : 0;
}

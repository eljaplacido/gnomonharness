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
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GOVERNANCE_FIX,
  GUARD_HARNESSES,
  GUARD_TOOLS,
  committedAtHead,
  governanceGapLine,
  governanceGaps,
  listRoles,
  loadConfig,
  guardExit,
  guardLiveSessions,
  guardRepo,
  sessionsWithoutGuard,
  guardHarnessRequest,
  readHarness,
  resolveCheckRole,
  CODEX_DEFERRED,
  toClaudeCode,
  toCodex,
  toCopilot,
  toCursor,
  type GovernanceGaps,
  type GuardRequest,
  guardTarget,
  type GuardHarness,
  type GuardLiveSession,
  type GuardVerdict,
  writeFileIn,
} from "gnomon-core/guard";

import { HOOK_TIMEOUT_DEFAULT_S, askPerson, brokerHookTimeoutS, dashboardTransport, holdSeconds, hostCannotAsk, installedHookTimeoutS, resolveBroker, terminalTransport, type BrokerTransports } from "./guard_broker.js";

export const GUARD_USAGE = `Usage: gnomon guard --tool <${GUARD_TOOLS.join("|")}> --input <json> [options]
       gnomon guard [--from generic|claude-code|opencode|cursor|codex|qwen-code|copilot] [options] < call.json
       gnomon guard install claude-code|opencode|cursor|codex|qwen-code|copilot [--write [--local]] [--dir <path>] [--bin <path>]
       gnomon guard status [--dir <path>] [--expect claude-code,opencode,cursor,codex,qwen-code,copilot] [--json]

Options:
  --base <rev>         read the rules from <rev> (default: the session's recorded base, else HEAD)
  --role <role>        decide as this role
  --agent <name>       map this agent name to a role through [check.roles]
  --session <id>       the calling harness's session id (names the trail and the recorded base)
  --dir <path>         the directory the call is made in (default: the payload's cwd, else here)
  --session-base <sha> the commit the calling harness's session started at; used and recorded
                       only when the session has no recorded base yet (the opencode plugin)

Exit (generic and opencode): 0 allow, 2 deny, 3 ask, 10 no decision (answered as ask).
claude-code, cursor, codex, qwen-code and copilot answer in their own hook format and exit 0
(codex cannot ask: an approval-gate ask is left to Codex's own approval flow, any other ask is
answered deny; codex, qwen-code and copilot install nothing until you run \`guard install\` for them).
install writes the absolute path of a gnomon that answers \`gnomon guard\` (--bin, else
$GNOMON_GUARD_BIN, else the gnomon running the install, else the one on PATH), and refuses
(exit 10) when none does. That path is this machine's: --local keeps the hook out of git
(Claude Code: .claude/settings.local.json; opencode, cursor: .git/info/exclude), so each
machine installs its own. Without --local it warns when the path is under your home
directory or a versioned (nvm) directory, which another clone will not have.
status: 0 every installed hook is in place (an older gnomon's hook is \`outdated\`, a
warning), 2 a hook is missing, changed or switched off, 10 not governed. It also lists the
host sessions the guard has decided for.`;

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
  stdin: () => string = () => readFileSync(0, "utf-8"),
  /** Tests: the approval broker's ways of reaching a person. */
  brokerTransports: BrokerTransports = { dashboard: dashboardTransport(), terminal: terminalTransport() }
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
  // The approval broker: only on a host that cannot ask, only when the surface
  // declares `[guard] broker`. Absent, nothing below runs and an ask is
  // answered exactly as before.
  let broker: GuardRequest["broker"];
  if (hostCannotAsk(from, hr.event)) {
    const dirs = [args.flags.dir ? resolve(args.flags.dir) : undefined, hr.cwd, hr.project, process.cwd()].filter((d): d is string => !!d);
    const dir = dirs.find((d) => resolveBroker(d)) ?? dirs[0]!;
    const settings = resolveBroker(dir);
    if (settings) {
      const hookS = Math.min(...[hr.project, hr.cwd, dir].filter((d): d is string => !!d).map((d) => installedHookTimeoutS(d, from)));
      const holdS = holdSeconds(settings.timeoutS, hookS);
      broker = (v, call) =>
        askPerson(settings, holdS, { host: from, tool: v.tool, target: guardTarget(call), reason: v.reason, project: dir }, v, brokerTransports);
    }
  }
  const verdict = await guardHarnessRequest(hr, {
    ...(broker ? { broker } : {}),
    cwd: args.flags.dir ? resolve(args.flags.dir) : undefined,
    // Claude Code names its project root to every hook. A shell an earlier
    // `cd` moved out of the project still answers to the project's rules.
    ...(from === "claude-code" && process.env.CLAUDE_PROJECT_DIR ? { project: resolve(process.env.CLAUDE_PROJECT_DIR) } : {}),
    // Qwen Code names its project root to hooks as $QWEN_PROJECT_DIR (its hooks docs).
    ...(from === "qwen-code" && process.env.QWEN_PROJECT_DIR ? { project: resolve(process.env.QWEN_PROJECT_DIR) } : {}),
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
    case "qwen-code": {
      // Qwen Code reads Claude Code's answer: hookSpecificOutput.permissionDecision.
      const s = toClaudeCode(v);
      if (s) out(s);
      return 0;
    }
    case "codex": {
      const s = toCodex(v);
      if (s) out(s);
      else if (v.decision === "ask") console.error(`${CODEX_DEFERRED}: ${v.reason}`);
      return 0;
    }
    case "copilot":
      out(toCopilot(v));
      return 0;
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
/**
 * PreToolUse matchers earlier gnomon releases wrote (v0.3.3–v0.4.x). A hook
 * with one of them is an older install, not an edit: `guard status` reports
 * it `outdated` (a warning) rather than `modified`.
 */
export const OLDER_CLAUDE_CODE_MATCHERS: readonly string[] = [
  "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|WebFetch|Grep|Glob",
  "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|WebFetch",
];
const CC_GUARD_TAIL = "guard --from claude-code --agent claude-code";
const CC_START_TAIL = "check --hook session-start";
/**
 * Delivers the dashboard inbox (inbox.ts) to Claude Code at session start, as
 * `additionalContext` labelled "information, not instructions". It never
 * decides anything and always exits 0: the PreToolUse hook is the only one
 * that can refuse a call.
 */
export const CC_INBOX_TAIL = "inbox --hook claude-code";
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
  const m = /^(.*?)\s+((?:guard|check|inbox)(?:\s.*)?)$/.exec(command.trim());
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
      SessionStart: [
        { hooks: [{ type: "command", command: shellCommand(bin, CC_START_TAIL) }] },
        { hooks: [{ type: "command", command: shellCommand(bin, CC_INBOX_TAIL), timeout: 10 }] },
      ],
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

/**
 * Delivers the dashboard inbox to Cursor at session start, as `additional_context`
 * labelled "information, not instructions". Decides nothing, always exits 0.
 */
export const CURSOR_INBOX_TAIL = "inbox --hook cursor";

/**
 * The preToolUse matcher: Cursor's tools gnomon decides that no other Cursor hook
 * already covers. Shell, Read and MCP calls reach `beforeShellExecution`,
 * `beforeReadFile` and `beforeMCPExecution`, so listing them here would decide
 * each twice. Write (which Cursor also uses for edits) and Delete are what no
 * before-hook covered; Grep, Fetch/WebFetch and Task come with them.
 */
export const CURSOR_PRETOOL_MATCHER = "Write|Delete|Grep|Fetch|WebFetch|Task";

/** The guard events a current install carries, each with `failClosed` (see cursorHooks). */
export const CURSOR_GUARD_EVENTS = ["beforeShellExecution", "beforeReadFile", "beforeMCPExecution", "preToolUse"] as const;

/**
 * Cursor's hooks.json (version 1, https://cursor.com/docs/agent/hooks): the guard on
 * every event Cursor offers before a call runs (shell, file read, MCP, and
 * preToolUse for writes and the rest), and the inbox at sessionStart.
 *
 * The guard hooks are `failClosed`: Cursor's default is to let the call run when a
 * hook crashes, times out or cannot start, which is the failure that left
 * Claude Code unguarded when a hook path was wrong. gnomon prints `{}` on allow,
 * so a working install blocks nothing it did not decide to.
 *
 * Not installed: a `stop` hook. Cursor submits a stop hook's `followup_message` as the
 * next user message, up to `loop_limit` times, so a verdict there would drive the
 * agent in a loop nobody asked for. `gnomon check` after the session says the same
 * without that.
 */
export function cursorHooks(bin: string[] = ["gnomon"], guardTimeoutS = 30): { version: number; hooks: Record<string, unknown[]> } {
  const command = shellCommand(bin, CURSOR_TAIL);
  const guard = { command, timeout: guardTimeoutS, failClosed: true };
  return {
    version: 1,
    hooks: {
      beforeShellExecution: [{ ...guard }],
      beforeReadFile: [{ ...guard }],
      beforeMCPExecution: [{ ...guard }],
      preToolUse: [{ ...guard, matcher: CURSOR_PRETOOL_MATCHER }],
      sessionStart: [{ command: shellCommand(bin, CURSOR_INBOX_TAIL), timeout: 10 }],
    },
  };
}

const CODEX_GUARD_TAIL = "guard --from codex --agent codex";
const QWEN_GUARD_TAIL = "guard --from qwen-code --agent qwen-code";
const COPILOT_GUARD_TAIL = "guard --from copilot --agent copilot";

/**
 * Codex's PreToolUse matcher: a regex over the tool name
 * (https://learn.chatgpt.com/docs/hooks). `Bash`, `apply_patch` (matched
 * by its `Edit`/`Write` aliases too) and MCP tools. Not hosted web search,
 * which Codex runs outside its hooks.
 */
export const CODEX_MATCHER = "Bash|apply_patch|Edit|Write|mcp__.*";
export const CODEX_MATCHED_TOOLS = ["Bash", "apply_patch", "mcp__server__tool"];
/**
 * Qwen Code's PreToolUse matcher: the runtime tool ids gnomon decides, and MCP
 * tools. Listed, not `*`: a hook on every tool would put host bookkeeping
 * (todo_write, ask_user_question ...) to a person under a declared
 * [governance].
 */
export const QWEN_MATCHER =
  "^(?:run_shell_command|write_file|edit|notebook_edit|read_file|grep_search|glob|list_directory|web_fetch|web_search|agent|mcp__.*)$";
export const QWEN_MATCHED_TOOLS = [
  "run_shell_command",
  "write_file",
  "edit",
  "notebook_edit",
  "read_file",
  "grep_search",
  "glob",
  "list_directory",
  "web_fetch",
  "web_search",
  "agent",
  "mcp__server__tool",
];

/**
 * Codex's hooks (`.codex/hooks.json`, event -> matcher group -> handlers; the
 * same shape as Claude Code's). PreToolUse decides; SessionStart records the
 * base the rules are read from. Stop is not installed: its output contract
 * (`decision: "block"` starts a continuation) is not the exit-2 one `gnomon
 * check --hook stop` answers, and the dashboard inbox is not delivered
 * (its target is Claude Code's).
 */
export function codexHooks(bin: string[] = ["gnomon"], guardTimeoutS = 30): { hooks: Record<string, unknown[]> } {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: shellCommand(bin, CC_START_TAIL), timeout: 30 }] }],
      PreToolUse: [{ matcher: CODEX_MATCHER, hooks: [{ type: "command", command: shellCommand(bin, CODEX_GUARD_TAIL), timeout: guardTimeoutS }] }],
    },
  };
}

/** Qwen Code's hooks (`.qwen/settings.json`, `hooks` beside the user's other settings). */
export function qwenCodeHooks(bin: string[] = ["gnomon"]): { hooks: Record<string, unknown[]> } {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: shellCommand(bin, CC_START_TAIL), timeout: 30 }] }],
      PreToolUse: [{ matcher: QWEN_MATCHER, hooks: [{ type: "command", command: shellCommand(bin, QWEN_GUARD_TAIL), timeout: 30 }] }],
    },
  };
}

/**
 * Copilot's hook file (`.github/hooks/gnomon.json`, `version` 1; CLI and cloud
 * agent read `.github/hooks/*.json`). A flat entry with the cross-platform
 * `command` fallback and `timeoutSec`
 * (https://docs.github.com/en/copilot/reference/hooks-configuration).
 */
export function copilotHooks(bin: string[] = ["gnomon"]): { version: number; hooks: Record<string, unknown[]> } {
  return { version: 1, hooks: { preToolUse: [{ type: "command", command: shellCommand(bin, COPILOT_GUARD_TAIL), timeoutSec: 30 }] } };
}

/**
 * The agent name each host's hook passes as `--agent`
 * (conformance/guard_decision.json `hook_agents`; the opencode plugin's
 * default, which `$GNOMON_GUARD_AGENT` overrides). The guard maps it to a role
 * through `[check.roles]`. With no entry there it has no role to decide as,
 * and answers every call `ask` (rule `error`, "no role", CONTRACTS.md §10).
 */
export const HOOK_AGENTS: Readonly<Record<"claude-code" | "opencode" | "cursor" | "codex" | "qwen-code" | "copilot", string>> = {
  "claude-code": "claude-code",
  opencode: "opencode",
  cursor: "cursor",
  codex: "codex",
  "qwen-code": "qwen-code",
  copilot: "copilot",
};

/**
 * Why the hook for `host` would put every call to a person: `[check.roles]`
 * in the working tree's `.gnomon/policy.toml` maps its agent name to no
 * declared role (#205). Null when it maps one, when no `.gnomon/` governs
 * `dir`, or when the surface does not load (the guard and `gnomon doctor` say
 * why then). The guard reads the rules at the session's base, so a mapping
 * added here is in force once it is committed.
 */
export function hookWithoutRole(
  dir: string,
  host: keyof typeof HOOK_AGENTS
): { why: string; fix: string; roles: string[] } | null {
  const repo = guardRepo(dir);
  if (!repo) return null;
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(repo.project);
  } catch {
    return null;
  }
  const agent = HOOK_AGENTS[host];
  if (!("error" in resolveCheckRole(config, { agent }))) return null;
  const roles = listRoles(config).sort();
  return {
    why: `it passes --agent ${agent}, and [check.roles] in .gnomon/policy.toml maps that to no declared role, so every call it sees is answered "ask"`,
    fix: `[check.roles] ${agent} = "<role>" in .gnomon/policy.toml (declared: ${roles.join(", ") || "none"}), committed`,
    roles,
  };
}

/** install's warning for a hook with no role: what happens, and the lines to add. */
function warnNoRole(dir: string, host: keyof typeof HOOK_AGENTS): void {
  const nr = hookWithoutRole(dir, host);
  if (!nr) return;
  console.error(
    [
      `gnomon guard: warning: no role for this hook: ${nr.why}.`,
      "  It protects only by asking about everything. Add to .gnomon/policy.toml, and commit it (the",
      "  guard reads the rules as committed at the session's start):",
      "    [check.roles]",
      `    ${HOOK_AGENTS[host]} = "<role>"${nr.roles.length ? `    # one of: ${nr.roles.join(", ")}` : ""}`,
    ].join("\n")
  );
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

/**
 * Why a hook program is particular to this machine, or null: a path under the
 * installer's home directory (another clone has another home, and the path
 * names the user) or under a versioned directory such as nvm's
 * `.../node/v22.22.2/bin/node` (the next Node upgrade removes it). A hook that
 * names such a path and is committed starts nowhere else, and Claude Code runs
 * a hook that cannot start as a non-blocking error: every call unguarded.
 */
export function machineSpecific(bin: string[], home: string = homedir()): string | null {
  const why: string[] = [];
  const win = process.platform === "win32";
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  for (const p of bin) {
    if (!isAbsolute(p)) continue;
    const ver = /[\\/](v?\d+\.\d+\.\d+)[\\/]/.exec(p);
    if (ver) why.push(`${p} is under a versioned directory (${ver[1]}), which an upgrade removes`);
    else if (home && norm(p).startsWith(norm(home.endsWith(sep) ? home : home + sep))) why.push(`${p} is under your home directory`);
  }
  return why.length ? why.join("; ") : null;
}

/** git in `cwd`: stdout, or null when it fails (not a repository, no git). */
function gitOut(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Keep a hook file out of git for `install --local`: Claude Code's
 * settings.local.json, or a plugin / hooks file listed in .git/info/exclude
 * (never in a committed .gitignore). Returns what to tell the operator.
 */
function keepLocal(project: string, file: string): string {
  const top = gitOut(project, ["rev-parse", "--show-toplevel"]);
  if (top === null) return `${file} is not in a git repository; nothing to keep out of git`;
  const rel = relative(top, file).split(sep).join("/");
  if (gitOut(top, ["ls-files", "--error-unmatch", "--", rel]) !== null) {
    return `warning: ${rel} is tracked by git, so --local cannot keep it out of commits; \`git rm --cached ${rel}\` untracks it`;
  }
  if (spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd: top, stdio: "ignore", timeout: 10_000 }).status === 0) return `${rel} is ignored by git`;
  const exclude = gitOut(top, ["rev-parse", "--git-path", "info/exclude"]);
  if (exclude === null) return `warning: could not find .git/info/exclude; keep ${rel} out of commits yourself`;
  const at = resolve(top, exclude);
  try {
    mkdirSync(dirname(at), { recursive: true });
    const cur = existsSync(at) ? readFileSync(at, "utf-8") : "";
    writeFileSync(at, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}/${rel}\n`);
    return `${rel} added to ${relative(top, at) || at}: git leaves it uncommitted`;
  } catch (err) {
    return `warning: could not write ${at} (${err instanceof Error ? err.message : String(err)}); keep ${rel} out of commits yourself`;
  }
}

export const OPENCODE_PLUGIN_MARKER = "gnomon-guard: generated by `gnomon guard install opencode`";

/**
 * sha256 of the opencode plugins earlier releases wrote (LF line ends): v0.3.3,
 * and v0.4.0–v0.4.5. Such a plugin is an older install (`outdated`), not an edit.
 */
const OLDER_OPENCODE_PLUGINS: readonly string[] = [
  "c534f73fb92945e058bb42885611bab238ff58955ec4bce7b8101033ed8a6702",
  "3eb618d7057a08b7dc5ecdea0f1918f37b213009aaa3392823d70e09b8abd2e6",
];

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
  type Entry = { command?: unknown; matcher?: unknown; hooks?: Array<{ command?: unknown; timeout?: unknown }> };
  const slots = (entry: unknown): Array<{ command?: unknown; timeout?: unknown }> => {
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
            // A longer hook timeout (the approval broker holds a call) is applied; one is never shortened.
            const wantT = (slots(entry).find((x) => x.command === cmd) as { timeout?: unknown } | undefined)?.timeout;
            if (typeof wantT === "number" && typeof h.timeout === "number" && wantT > h.timeout) {
              h.timeout = wantT;
              changed = true;
            }
            // Cursor's failClosed: an older install had none. Re-running install is the
            // operator's ask to bring it up to date.
            const fc = (entry as { failClosed?: unknown }).failClosed;
            if (fc === true && (existing as { failClosed?: unknown }).failClosed !== true) {
              (existing as { failClosed?: unknown }).failClosed = true;
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
 *
 * The hook names this machine's gnomon by absolute path. `--local` keeps it
 * out of git (Claude Code: `.claude/settings.local.json`; opencode and Cursor:
 * the file is listed in `.git/info/exclude`), so each machine installs its
 * own; without it, a path under $HOME or a versioned directory is warned of.
 */
/** The guard hook timeout to write for Codex and Cursor: 30 s, or the broker's hold plus headroom when `[guard] broker` is declared. */
function brokerInstallTimeoutS(project: string): number {
  const b = resolveBroker(project);
  return b ? Math.max(HOOK_TIMEOUT_DEFAULT_S, brokerHookTimeoutS(b.timeoutS)) : HOOK_TIMEOUT_DEFAULT_S;
}

function installGuard(args: GuardArgs, out: (s: string) => void): number {
  const target = args.positional[0];
  const write = args.flags.write === "true";
  const local = args.flags.local === "true";
  const project = resolve(args.flags.dir ?? process.cwd());
  if (
    target !== "claude-code" &&
    target !== "opencode" &&
    target !== "cursor" &&
    target !== "codex" &&
    target !== "qwen-code" &&
    target !== "copilot"
  ) {
    console.error(`gnomon guard install: claude-code, opencode, cursor, codex, qwen-code or copilot (got "${target ?? ""}")\n\n${GUARD_USAGE}`);
    return 10;
  }
  const resolved = resolveGnomonBin(args.flags.bin && args.flags.bin !== "true" ? args.flags.bin : undefined);
  if ("error" in resolved) {
    console.error(`gnomon guard install: ${resolved.error}`);
    return 10;
  }
  const bin = resolved.argv;
  /** After a write: keep it local (--local), or say when the path will not travel. */
  const travel = (file: string) => {
    if (local) {
      console.error(`gnomon guard: ${keepLocal(project, file)}`);
      return;
    }
    const why = machineSpecific(bin);
    if (!why) return;
    console.error(
      [
        `gnomon guard: warning: the hook runs ${bin.join(" ")}, a path only this machine has (${why}).`,
        "  Committed, it starts nowhere else: on a teammate's or a CI clone the host cannot start the",
        "  hook, and Claude Code then runs every call unguarded. Re-run with --local to keep it out of",
        "  git (each machine installs its own), or --bin <a path every machine has>.",
      ].join("\n")
    );
  };
  switch (target) {
    case "claude-code": {
      const fragment = claudeCodeHooks(bin);
      if (write) {
        const shared = join(project, ".claude", "settings.json");
        const file = local ? join(project, ".claude", "settings.local.json") : shared;
        const added = mergeHooks(project, file, fragment);
        recordInstall(project, "claude-code", file, bin);
        console.error(added.length ? `gnomon guard: added ${added.join(", ")} to ${file}` : `gnomon guard: ${file} already has these hooks`);
        if (local && existsSync(shared) && COMMITTED_GUARD.test(readFileSync(shared, "utf-8"))) {
          console.error(`gnomon guard: warning: ${shared} also runs gnomon's guard; Claude Code runs both. Remove the hooks there.`);
        }
        travel(file);
        warnNoRole(project, target);
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
          "  SessionStart  `gnomon inbox --hook`: prints the operator's open dashboard items as context,",
          "                labelled information, not instructions (decides nothing, always exits 0)",
          "  PreToolUse    `gnomon guard` on each Bash/Write/Edit/Read/Grep/Glob/WebFetch/WebSearch,",
          "                Agent/Task and MCP call: deny or ask is handed to Claude Code; allow says",
          "                nothing, so Claude Code's own permission prompt still applies. MCP tools",
          "                are recorded as ungoverned, and asked under a declared [governance]",
          "  Stop          `gnomon check` on everything the session changed",
          "",
          `Every hook runs ${bin.join(" ")}: an absolute path, so a host that starts with`,
          "another gnomon (or none) on its PATH still runs this one. It is this machine's path:",
          "`--write --local` writes .claude/settings.local.json instead, which stays out of git.",
          "",
          "Map the agent to a role in .gnomon/policy.toml: [check.roles] claude-code = \"implement\".",
        ].join("\n")
      );
      warnNoRole(project, target);
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
        travel(file);
        warnNoRole(project, target);
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
      warnNoRole(project, target);
      return 0;
    }
    case "cursor": {
      const fragment = cursorHooks(bin, brokerInstallTimeoutS(project));
      if (write) {
        const file = join(project, ".cursor", "hooks.json");
        const added = mergeHooks(project, file, fragment);
        recordInstall(project, "cursor", file, bin);
        console.error(added.length ? `gnomon guard: added ${added.join(", ")} to ${file}` : `gnomon guard: ${file} already has these hooks`);
        travel(file);
        warnNoRole(project, target);
        return 0;
      }
      out(JSON.stringify(fragment, null, 2));
      console.error(
        [
          "",
          "Merge the above into .cursor/hooks.json, or run `gnomon guard install cursor --write`.",
          "",
          "  beforeShellExecution, beforeReadFile, beforeMCPExecution  `gnomon guard` decides each before it runs",
          "  preToolUse    `gnomon guard` on Write (Cursor's edits too), Delete, Grep, Fetch and Task: a file",
          "                write is decided BEFORE it happens. (Shell, Read and MCP reach it through the three",
          "                hooks above, so they are not matched here twice.)",
          "  sessionStart  `gnomon inbox --hook cursor`: prints the operator's open dashboard items as",
          "                additional_context, labelled information, not instructions (decides nothing)",
          "",
          "The guard hooks are failClosed: a hook that crashes, times out or cannot start BLOCKS the call",
          "(Cursor's default is to let it run). No stop hook is installed: Cursor submits its",
          "followup_message as the next user message, so a verdict there would loop the agent.",
          "Hook sources: https://cursor.com/docs/agent/hooks",
          "Map the agent to a role: [check.roles] cursor = \"implement\".",
        ].join("\n")
      );
      warnNoRole(project, target);
      return 0;
    }
    case "codex":
    case "qwen-code":
    case "copilot": {
      const spec = {
        codex: {
          fragment: codexHooks(bin, brokerInstallTimeoutS(project)),
          file: join(project, ".codex", "hooks.json"),
          what: "Codex",
          notes: [
            "Codex loads a project's hooks only once the project is trusted, and runs a non-managed hook only",
            "after it is reviewed: open Codex and approve it with /hooks. Until then Codex runs every call",
            "unguarded (`--dangerously-bypass-hook-trust` skips the review, and `[features] hooks = false` in",
            "config.toml turns hooks off; `guard status` reports the second, not the first).",
            "Codex cannot ask: a call the [approval] gate would ask about is left to Codex's own approval flow",
            "(said on stderr, recorded as an ask); any other ask (no such tool for the role, an ungoverned tool",
            "under [governance], an undecidable call) is refused.",
            "Not covered: hosted web search; Stop and the dashboard inbox are not installed.",
          ],
        },
        "qwen-code": {
          fragment: qwenCodeHooks(bin),
          file: join(project, ".qwen", "settings.json"),
          what: "Qwen Code",
          notes: [
            "Qwen Code reads this file's `hooks` beside your other settings (kept as they are).",
            "Under `--prompt` (headless) and in background subagents Qwen turns an ask into a deny.",
            "`disableAllHooks` and `--safe-mode`/`--bare` turn hooks off; `guard status` reads the first.",
          ],
        },
        copilot: {
          fragment: copilotHooks(bin),
          file: join(project, ".github", "hooks", "gnomon.json"),
          what: "GitHub Copilot",
          notes: [
            "Copilot CLI and the cloud agent read .github/hooks/*.json from the repository: commit it, and",
            "give each machine a path it has (--bin). A command that errors DENIES the call; a hook that",
            "times out (30 s) lets it through to Copilot's own permissions. Copilot also reads",
            "`.claude/settings.json`: a gnomon claude-code hook there fires too.",
            "MCP tools are not put to the guard (their tool names are not documented).",
          ],
        },
      }[target];
      if (write) {
        const { file, fragment } = spec;
        const checked = checkHookFile(file);
        if (checked) {
          console.error(`gnomon guard install ${target}: ${checked}`);
          return 10;
        }
        const added = mergeHooks(project, file, fragment);
        recordInstall(project, target, file, bin);
        console.error(added.length ? `gnomon guard: added ${added.join(", ")} to ${file}` : `gnomon guard: ${file} already has these hooks`);
        if (target === "codex") {
          const toml = join(project, ".codex", "config.toml");
          if (existsSync(toml) && /^\s*\[\[?hooks[.\]]/m.test(readFileSync(toml, "utf-8"))) {
            console.error(`gnomon guard: warning: ${toml} also defines [hooks]; Codex loads both files and warns at startup. Keep one format per layer.`);
          }
        }
        if (target === "copilot") {
          const claude = join(project, ".claude", "settings.json");
          if (existsSync(claude) && /guard --from claude-code\b/.test(readFileSync(claude, "utf-8"))) {
            console.error(`gnomon guard: warning: ${claude} also runs gnomon's guard, and Copilot reads that file: it decides each call twice (the same answer, two records).`);
          }
        }
        for (const n of spec.notes) console.error(`gnomon guard: ${n}`);
        console.error(`gnomon guard: live verification against a real ${spec.what} binary is pending: the hook schema is from its documentation.`);
        travel(file);
        warnNoRole(project, target);
        return 0;
      }
      out(JSON.stringify(spec.fragment, null, 2));
      console.error(
        [
          "",
          `Save the above as ${relative(project, spec.file) || spec.file} (merged with what is there), or run`,
          `\`gnomon guard install ${target} --write\` to merge it without clobbering existing hooks.`,
          ...spec.notes.map((n) => `  ${n}`),
          `Map the agent to a role: [check.roles] ${target} = "implement".`,
        ].join("\n")
      );
      warnNoRole(project, target);
      return 0;
    }
  }
}

/**
 * Why an existing hook file cannot be merged into, or null when it can (absent,
 * or a JSON object whose `hooks`, when there, is an object of arrays). A file
 * that is not is left untouched: the user's hooks are not ours to rewrite.
 */
function checkHookFile(file: string): string | null {
  if (!existsSync(file)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    return `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); nothing was changed. Fix or move it, or merge the printed hooks by hand (run without --write).`;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return `${file} is not a JSON object; nothing was changed.`;
  const hooks = (doc as { hooks?: unknown }).hooks;
  if (hooks === undefined) return null;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return `${file} has a "hooks" that is not an object; nothing was changed.`;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) return `${file}: hooks.${event} is not an array; nothing was changed.`;
  }
  return null;
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

/**
 * `outdated`: the hook an earlier gnomon release wrote, unchanged since (its
 * Claude Code matcher, or its opencode plugin), or a hook `install --write`
 * brought up to date whose update is not committed yet. A warning, not a
 * finding: `modified` is kept for a hook that differs from what gnomon wrote.
 */
export type HookState = "ok" | "outdated" | "missing" | "modified" | "disabled" | "not_installed";
export interface HookStatus {
  host: string;
  state: HookState;
  file: string;
  /** Why the state is what it is; empty when ok. */
  detail: string;
  /** Cursor only, when its hook file is in place: each hook of a current install and whether it is there. */
  events?: CursorHookStatus[];
}
export interface CursorHookStatus {
  event: string;
  /** not_fail_closed: hooked, but a crash or timeout of the hook lets the call run. */
  state: "ok" | "missing" | "not_fail_closed";
}
export interface GuardStatus {
  schema: "gnomon.guard.status/1";
  governed: boolean;
  project: string | null;
  hosts: HookStatus[];
  /** One line per host whose hook is missing, changed or switched off. */
  findings: string[];
  /** One line per host whose hook an older gnomon wrote (`outdated`): not a finding. */
  warnings: string[];
  /** How many host sessions the guard has decided for in this repository (CONTRACTS.md §44). */
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
  /**
   * Where the working tree's surface leaves governance below prevent, read as
   * `gnomon security` reads it (governance_off): `undeclared` roles have no
   * governance layer, so secret_path, ci_path and outside_root never run for
   * them; `below_prevent` families are set to observe or advise. Not a
   * finding: it changes no exit. Null when not governed, or the surface does
   * not load.
   */
  governance: GovernanceGaps | null;
  /**
   * Whether Claude Code's hooks include the SessionStart hook that delivers the
   * dashboard inbox (`gnomon inbox --hook claude-code`, CONTRACTS.md section 57).
   * Null when claude-code has no hook in place. Not part of any host's `state`:
   * an install without it still guards every call, and `warnings` says to re-run
   * install.
   */
  inbox_hook: "ok" | "missing" | null;
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
function runs(hooks: unknown, event: string, tail: string, tools?: string[], matchers?: readonly string[]): string | null {
  const list = (hooks as Record<string, unknown> | undefined)?.[event];
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const e = entry as { command?: unknown; matcher?: unknown; hooks?: Array<{ command?: unknown }> };
    const commands = [e.command, ...(Array.isArray(e.hooks) ? e.hooks.map((h) => h?.command) : [])];
    const hit = commands.find((c): c is string => typeof c === "string" && gnomonTail(c) === tail);
    if (!hit) continue;
    const m = typeof e.matcher === "string" ? e.matcher : "";
    if (matchers) {
      if (matchers.includes(m)) return hit;
      continue;
    }
    if (!tools) return hit;
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
const COMMITTED_GUARD = /guard --from (?:claude-code|cursor|codex|qwen-code|copilot)\b|gnomon-guard: generated by/;

/**
 * Whether a TOML text sets `hooks = false` (or the deprecated `codex_hooks =
 * false`) under `[features]`: Codex's switch for all hooks. A line scan, not a
 * TOML parse: the table header, then the key, until the next table.
 */
export function codexHooksOff(toml: string): boolean {
  let inFeatures = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      inFeatures = /^\[\s*features\s*\]$/.test(line);
      continue;
    }
    if (inFeatures && /^(?:hooks|codex_hooks)\s*=\s*false$/.test(line)) return true;
  }
  return false;
}

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
    warnings: [],
    sessions_seen: 0,
    last_decision: null,
    sessions: [],
    unguarded_sessions: [],
    governance: null,
    inbox_hook: null,
  };
  if (!repo) return status;
  try {
    const config = loadConfig(repo.project);
    status.governance = governanceGaps(config, listRoles(config).sort());
  } catch {
    // A surface that does not load: `gnomon doctor` and the guard say why.
  }
  const installed = readJson(join(repo.stateDir, "installed.json")) ?? {};
  const recorded = (host: string) => installed[host] as { file?: string; sha256?: string; at?: string } | undefined;
  const committed = (file: string) => committedAtHead(repo.toplevel, relative(repo.toplevel, file));
  const claudeDir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");

  /**
   * `present` says what is wrong with a hook file's text: null when it is the
   * hook this gnomon writes, `{ older }` when it is one an earlier release
   * wrote, else why it is not gnomon's hook.
   */
  type Present = string | { older: string } | null;
  const judge = (host: string, file: string, present: (text: string) => Present, extra?: () => string | null): HookStatus => {
    const atHead = committed(file);
    const rec = recorded(host);
    const live = existsSync(file) ? readFileSync(file) : null;
    // Committed with gnomon's guard in it — even an older or edited one — is expected.
    const expected =
      (atHead !== null && (typeof present(lf(atHead)) !== "string" || COMMITTED_GUARD.test(lf(atHead)))) || rec !== undefined || expect.includes(host);
    const at = (state: HookState, detail: string): HookStatus => ({ host, state, file, detail });
    if (live === null) return expected ? at("missing", "the hook file is gone") : at("not_installed", "");
    const wrong = present(lf(live));
    if (typeof wrong === "string") return expected ? at("modified", wrong) : at("not_installed", "");
    if (wrong !== null && !expected) return at("not_installed", "");
    // install --write wrote exactly this file: what differs from HEAD is its own update.
    const installed = rec?.sha256 === sha256(lf(live));
    let note = "";
    if (atHead !== null && lf(atHead) !== lf(live)) {
      if (!(wrong === null && installed)) return at("modified", "it differs from the version committed at HEAD");
      if (COMMITTED_GUARD.test(lf(atHead))) {
        const off = extra?.();
        if (off) return at("disabled", off);
        return at("outdated", "`gnomon guard install` updated it and HEAD still holds the older hook: commit the file");
      }
      note = "installed, not committed yet";
    }
    if (atHead === null && rec?.sha256 && !installed) return at("modified", "it changed since `gnomon guard install` wrote it");
    const off = extra?.();
    if (off) return at("disabled", off);
    if (wrong !== null) return at("outdated", wrong.older);
    return at("ok", note);
  };

  // Claude Code: the project's settings.json, or settings.local.json when
  // `install --write --local` put the hook there (or only it holds one).
  const claudeShared = join(repo.project, ".claude", "settings.json");
  const claudeLocal = join(repo.project, ".claude", "settings.local.json");
  const holdsGuard = (f: string) => existsSync(f) && COMMITTED_GUARD.test(readFileSync(f, "utf-8"));
  const sharedAtHead = committed(claudeShared);
  const claudeFile =
    basename(recorded("claude-code")?.file ?? "") === "settings.local.json" ||
    (!holdsGuard(claudeShared) && !(sharedAtHead !== null && COMMITTED_GUARD.test(lf(sharedAtHead))) && holdsGuard(claudeLocal))
      ? claudeLocal
      : claudeShared;
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
          const older = runs(hooks, "PreToolUse", CC_GUARD_TAIL, undefined, OLDER_CLAUDE_CODE_MATCHERS);
          if (older) {
            if (!runs(hooks, "SessionStart", CC_START_TAIL)) return "no SessionStart hook records the session's base";
            return (
              absentProgram(older) ?? {
                older:
                  "an older gnomon's PreToolUse matcher: WebSearch, Agent/Task and MCP calls are not put to the guard. " +
                  "`gnomon guard install claude-code --write` updates it",
              }
            );
          }
          return runs(hooks, "PreToolUse", CC_GUARD_TAIL)
            ? `its PreToolUse matcher does not cover ${CLAUDE_CODE_MATCHER}, and is not one gnomon wrote`
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
      if (text.includes(OPENCODE_PLUGIN_MARKER) && OLDER_OPENCODE_PLUGINS.includes(sha256(text))) {
        return { older: "an older gnomon's plugin: it runs whatever `gnomon` is on PATH. `gnomon guard install opencode --write` updates it" };
      }
      return text.includes(OPENCODE_PLUGIN_MARKER)
        ? "it is not the plugin this gnomon or an earlier release wrote (edited?): `gnomon guard install opencode --write` rewrites it"
        : "it is not gnomon's plugin";
    })
  );
  const cursorFile = join(repo.project, ".cursor", "hooks.json");
  /** Each hook a current Cursor install carries, and whether this file has it as it should be. */
  const cursorEvents = (hooks: unknown): CursorHookStatus[] => {
    const entryOf = (event: string, tail: string, tools?: string[]) => {
      const cmd = runs(hooks, event, tail, tools);
      if (!cmd) return null;
      const list = (hooks as Record<string, unknown[]>)[event] ?? [];
      return (list as Array<{ command?: unknown; failClosed?: unknown }>).find((e) => e.command === cmd) ?? { failClosed: undefined };
    };
    const guarded = (event: (typeof CURSOR_GUARD_EVENTS)[number]): CursorHookStatus => {
      const e = entryOf(event, CURSOR_TAIL, event === "preToolUse" ? ["Write", "Delete"] : undefined);
      return { event, state: !e ? "missing" : e.failClosed === true ? "ok" : "not_fail_closed" };
    };
    return [...CURSOR_GUARD_EVENTS.map(guarded), { event: "sessionStart", state: runs(hooks, "sessionStart", CURSOR_INBOX_TAIL) ? "ok" : "missing" }];
  };
  status.hosts.push(
    judge("cursor", cursorFile, (text) => {
      let hooks: unknown;
      try {
        hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
      } catch {
        return "it is not JSON Cursor can read";
      }
      const shell = runs(hooks, "beforeShellExecution", CURSOR_TAIL);
      if (!(shell && runs(hooks, "beforeReadFile", CURSOR_TAIL))) {
        return `no beforeShellExecution and beforeReadFile hook runs \`gnomon ${CURSOR_TAIL}\``;
      }
      const absent = absentProgram(shell);
      if (absent) return absent;
      // An install from before Cursor had preToolUse still decides shell and reads: a
      // warning (outdated) that says what it lacks, never a failure.
      const lacking = cursorEvents(hooks).filter((e) => e.event !== "sessionStart" && e.state !== "ok");
      return lacking.length === 0
        ? null
        : {
            older:
              `an older gnomon's install: ${lacking.map((e) => `${e.event} ${e.state === "missing" ? "is not hooked" : "is not failClosed"}`).join(", ")}` +
              " (file writes and MCP calls are not decided before they run). `gnomon guard install cursor --write` updates it",
          };
    })
  );
  const cursorHost = status.hosts[status.hosts.length - 1]!;
  if (cursorHost.state === "ok" || cursorHost.state === "outdated") {
    const events = cursorEvents(readJson(cursorHost.file)?.hooks);
    cursorHost.events = events;
    if (cursorHost.state === "ok" && events.some((e) => e.event === "sessionStart" && e.state === "missing")) {
      status.warnings.push("cursor: no sessionStart hook delivers the dashboard inbox. fix: `gnomon guard install cursor --write`");
    }
  }
  // Codex, Qwen Code and Copilot are opt-in: listed only where an install, a
  // committed hook or `--expect` makes them expected, so a repository that
  // never installed one sees the same status as before.
  const optIn: HookStatus[] = [];
  const codexFile = join(repo.project, ".codex", "hooks.json");
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), ".codex");
  optIn.push(
    judge(
      "codex",
      codexFile,
      (text) => {
        let hooks: unknown;
        try {
          hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
        } catch {
          return "it is not JSON Codex can read";
        }
        const cmd = runs(hooks, "PreToolUse", CODEX_GUARD_TAIL, CODEX_MATCHED_TOOLS);
        if (!cmd) {
          return runs(hooks, "PreToolUse", CODEX_GUARD_TAIL)
            ? `its PreToolUse matcher does not cover ${CODEX_MATCHER}`
            : `no PreToolUse hook runs \`gnomon ${CODEX_GUARD_TAIL}\``;
        }
        if (!runs(hooks, "SessionStart", CC_START_TAIL)) return "no SessionStart hook records the session's base";
        return absentProgram(cmd);
      },
      () => {
        for (const f of [join(repo.project, ".codex", "config.toml"), join(codexHome, "config.toml")]) {
          try {
            if (codexHooksOff(readFileSync(f, "utf-8"))) return `${f} sets [features] hooks = false`;
          } catch {
            // no such file
          }
        }
        return null;
      }
    )
  );
  const qwenFile = join(repo.project, ".qwen", "settings.json");
  optIn.push(
    judge(
      "qwen-code",
      qwenFile,
      (text) => {
        let hooks: unknown;
        try {
          hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
        } catch {
          return "it is not JSON Qwen Code can read";
        }
        const cmd = runs(hooks, "PreToolUse", QWEN_GUARD_TAIL, QWEN_MATCHED_TOOLS);
        if (!cmd) {
          return runs(hooks, "PreToolUse", QWEN_GUARD_TAIL)
            ? "its PreToolUse matcher does not select every tool gnomon decides"
            : `no PreToolUse hook runs \`gnomon ${QWEN_GUARD_TAIL}\``;
        }
        if (!runs(hooks, "SessionStart", CC_START_TAIL)) return "no SessionStart hook records the session's base";
        return absentProgram(cmd);
      },
      () => {
        for (const f of [qwenFile, join(homedir(), ".qwen", "settings.json")]) {
          if (readJson(f)?.disableAllHooks === true) return `${f} sets disableAllHooks`;
        }
        return null;
      }
    )
  );
  const copilotFile = join(repo.project, ".github", "hooks", "gnomon.json");
  optIn.push(
    judge("copilot", copilotFile, (text) => {
      let hooks: unknown;
      try {
        hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
      } catch {
        return "it is not JSON Copilot can read";
      }
      const cmd = runs(hooks, "preToolUse", COPILOT_GUARD_TAIL);
      return cmd ? absentProgram(cmd) : `no preToolUse hook runs \`gnomon ${COPILOT_GUARD_TAIL}\``;
    })
  );
  for (const h of optIn) if (h.state !== "not_installed") status.hosts.push(h);
  for (const h of status.hosts) {
    const line = `${h.host}: ${h.state} — ${relative(repo.project, h.file) || h.file}: ${h.detail}`;
    if (h.state === "missing" || h.state === "modified" || h.state === "disabled") status.findings.push(line);
    else if (h.state === "outdated") status.warnings.push(line);
  }
  const cx = status.hosts.find((h) => h.host === "codex");
  if (cx && (cx.state === "ok" || cx.state === "outdated")) {
    status.warnings.push("codex: Codex runs a project hook only once the project is trusted and the hook reviewed (/hooks); gnomon cannot see that, so `ok` means the file is right, not that Codex runs it");
  }
  const cp = status.hosts.find((h) => h.host === "copilot");
  if (cp && (cp.state === "ok" || cp.state === "outdated") && holdsGuard(claudeShared) && /guard --from claude-code\b/.test(readFileSync(claudeShared, "utf-8"))) {
    status.warnings.push("copilot: Copilot also reads .claude/settings.json, where gnomon's claude-code hook is: each call is decided twice (the same answer, two records)");
  }
  // The dashboard inbox's delivery (inbox.ts): reported beside the hook, and a
  // warning, never a finding, when an older install lacks it.
  const ccHost = status.hosts.find((h) => h.host === "claude-code");
  if (ccHost && (ccHost.state === "ok" || ccHost.state === "outdated")) {
    status.inbox_hook = runs(readJson(ccHost.file)?.hooks, "SessionStart", CC_INBOX_TAIL) ? "ok" : "missing";
    if (status.inbox_hook === "missing") {
      status.warnings.push("claude-code: no SessionStart hook delivers the dashboard inbox. fix: `gnomon guard install claude-code --write`");
    }
  }
  // A hook in place whose agent [check.roles] maps to no role asks about
  // every call (#205): a warning, as `outdated` is; the hook still decides.
  for (const h of status.hosts) {
    if (h.state !== "ok" && h.state !== "outdated") continue;
    const nr = hookWithoutRole(repo.project, h.host as keyof typeof HOOK_AGENTS);
    if (nr) status.warnings.push(`${h.host}: no role — ${nr.why}. fix: ${nr.fix}`);
  }
  // Liveness (CONTRACTS.md §44): which host sessions reached the guard.
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
    for (const h of st.hosts) {
      out(`${h.host.padEnd(12)} ${h.state.padEnd(14)} ${relative(st.project!, h.file)}${h.detail ? `  ${h.detail}` : ""}${h.host === "claude-code" && st.inbox_hook ? `  [inbox hook: ${st.inbox_hook}]` : ""}`);
      if (h.events) out(`${"".padEnd(12)} hooks: ${h.events.map((e) => `${e.event} ${e.state}`).join(", ")}`);
    }
    out(st.findings.length ? `\n${st.findings.length} finding(s): a host is not governed the way it was set up to be.` : "\nevery installed hook is in place.");
    for (const w of st.warnings) out(`warning: ${w}`);
    const gaps = st.governance && governanceGapLine(st.governance);
    if (gaps) out(`note: ${gaps}\n      fix: ${GOVERNANCE_FIX} (gnomon security says more)`);
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

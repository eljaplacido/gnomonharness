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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  GUARD_HARNESSES,
  GUARD_TOOLS,
  guardExit,
  guardHarnessRequest,
  readHarness,
  toClaudeCode,
  toCursor,
  type GuardHarness,
  type GuardVerdict,
} from "gnomon-core/guard";

export const GUARD_USAGE = `Usage: gnomon guard --tool <${GUARD_TOOLS.join("|")}> --input <json> [options]
       gnomon guard [--from generic|claude-code|opencode|cursor] [options] < call.json
       gnomon guard install claude-code|opencode|cursor [--write] [--dir <path>]

Options:
  --base <rev>         read the rules from <rev> (default: the session's recorded base, else HEAD)
  --role <role>        decide as this role
  --agent <name>       map this agent name to a role through [check.roles]
  --session <id>       the calling harness's session id (names the trail and the recorded base)
  --dir <path>         the directory the call is made in (default: the payload's cwd, else here)

Exit (generic and opencode): 0 allow, 2 deny, 3 ask, 10 no decision (answered as ask).
claude-code and cursor answer in their own hook format and exit 0.`;

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
    } else if (out.sub === undefined && out.positional.length === 0 && a === "install") out.sub = a;
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

/** The Claude Code tools gnomon decides; the others are left to Claude Code. */
export const CLAUDE_CODE_MATCHER = "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|WebFetch";
export const CLAUDE_CODE_GUARD_COMMAND = "gnomon guard --from claude-code --agent claude-code";

/**
 * The PreToolUse hook, added to the SessionStart + Stop hooks `gnomon check
 * --install-hook claude-code` already prints — one fragment, not two that
 * could drift. SessionStart records the base the guard then reads its rules
 * from, so the three hooks judge a session by one policy.
 */
export function claudeCodeHooks(): { hooks: Record<string, unknown[]> } {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "gnomon check --hook session-start" }] }],
      PreToolUse: [
        {
          matcher: CLAUDE_CODE_MATCHER,
          hooks: [{ type: "command", command: CLAUDE_CODE_GUARD_COMMAND, timeout: 30 }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: "gnomon check --hook stop --agent claude-code", timeout: 900 }] }],
    },
  };
}

/** Cursor's hooks.json (version 1): the two documented pre-execution events gnomon can decide. */
export function cursorHooks(): { version: number; hooks: Record<string, unknown[]> } {
  return {
    version: 1,
    hooks: {
      beforeShellExecution: [{ command: "gnomon guard --from cursor --agent cursor", timeout: 30 }],
      beforeReadFile: [{ command: "gnomon guard --from cursor --agent cursor", timeout: 30 }],
    },
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
 */
export function opencodePlugin(): string {
  return `// ${OPENCODE_PLUGIN_MARKER}
// Every shell, write, edit, patch, read, webfetch and execute call is put to this
// repository's .gnomon/ rules (as committed at the session's start) before it
// runs. deny fails the call with gnomon's reason; ask raises opencode's own
// permission prompt; allow changes nothing. Remove this file to stop it.
import { execFile } from "node:child_process";

const GNOMON = process.env.GNOMON_GUARD_BIN || "gnomon";
const AGENT = process.env.GNOMON_GUARD_AGENT || "opencode";
const ACTION = "gnomon_guard";

function guard(event, directory) {
  return new Promise((resolve) => {
    const child = execFile(
      GNOMON,
      ["guard", "--from", "opencode", "--agent", AGENT],
      { cwd: directory, timeout: 30000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        try {
          resolve(JSON.parse(String(stdout).trim().split("\\n").pop()));
        } catch {
          resolve({ decision: "deny", reason: "gnomon guard gave no answer" + (err ? ": " + err.message : "") });
        }
      }
    );
    child.stdin.end(JSON.stringify({ ...event, directory }));
  });
}

export default {
  id: "gnomon-guard",
  setup(api) {
    const directory = api.location?.directory || process.cwd();
    api.permission.hook("evaluate", (e) => {
      if (e.action === ACTION && e.effect !== "deny") e.effect = "ask";
    });
    api.tool.hook("execute.before", async (e) => {
      const v = await guard({ tool: e.tool, sessionID: e.sessionID, agent: e.agent, input: e.input }, directory);
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

/** Merge hook entries into a JSON settings file, skipping any whose command is already there. */
function mergeHooks(file: string, fragment: { hooks: Record<string, unknown[]>; version?: number }): string[] {
  const current = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>) : {};
  const hooks = (current.hooks && typeof current.hooks === "object" ? current.hooks : {}) as Record<string, unknown[]>;
  const added: string[] = [];
  const commandsIn = (entry: unknown): string[] => {
    const e = entry as { command?: unknown; hooks?: Array<{ command?: unknown }> };
    return [e.command, ...(e.hooks ?? []).map((h) => h.command)].filter((c): c is string => typeof c === "string");
  };
  for (const [event, entries] of Object.entries(fragment.hooks)) {
    const list = Array.isArray(hooks[event]) ? hooks[event]! : [];
    const present = new Set(list.flatMap(commandsIn));
    for (const entry of entries) {
      if (commandsIn(entry).every((c) => present.has(c))) continue;
      list.push(entry);
      added.push(event);
    }
    hooks[event] = list;
  }
  const next = { ...(fragment.version !== undefined ? { version: fragment.version } : {}), ...current, hooks };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
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
  switch (target) {
    case "claude-code": {
      const fragment = claudeCodeHooks();
      if (write) {
        const file = join(project, ".claude", "settings.json");
        const added = mergeHooks(file, fragment);
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
          "  PreToolUse    `gnomon guard` on each Bash/Write/Edit/Read/WebFetch call: deny or ask",
          "                is handed to Claude Code; allow says nothing, so Claude Code's own",
          "                permission prompt still applies",
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
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, opencodePlugin());
        console.error(`gnomon guard: wrote ${file}`);
        return 0;
      }
      out(opencodePlugin());
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
      const fragment = cursorHooks();
      if (write) {
        const file = join(project, ".cursor", "hooks.json");
        const added = mergeHooks(file, fragment);
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
    default:
      console.error(`gnomon guard install: claude-code, opencode or cursor (got "${target ?? ""}")\n\n${GUARD_USAGE}`);
      return 10;
  }
}

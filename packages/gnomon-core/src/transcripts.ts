/**
 * gnomon-core: transcript adapters for `gnomon check`.
 *
 * Check 5 asks whether every shell command an agent ran would have passed the
 * role's bash_allow / bash_deny. The diff cannot answer that — a force-push or
 * a `curl | sh` leaves nothing in the tree — so the commands are read from the
 * harness's own record of the session. This is the only harness-specific part
 * of `check`, kept to one small reader per format that yields
 * `{tool, command, at}` and nothing else.
 *
 * Formats, as verified against real files on 2026-10-11:
 *
 *   claude-code  ~/.claude/projects/<project>/<session>.jsonl. One JSON record
 *                per line; `type: "assistant"` records carry `message.content`
 *                blocks, and a `tool_use` block named `Bash` has the command
 *                at `input.command`. A user record carrying `toolDenialKind`
 *                is Claude Code refusing a call, so that command never ran.
 *                Subagents write their own files under
 *                `<session>/subagents/**.jsonl`; they are read too, because
 *                their changes are in the same diff. A subagent file names
 *                its agent type in `attributionAgent`.
 *   opencode     `opencode export <session>` (one JSON document: `info.agent`,
 *                `messages[].parts[]` with `type: "tool"`, `tool: "bash"`
 *                (opencode V2: `tool: "shell"`, the same part otherwise),
 *                `state.input.command`), or the event stream of
 *                `opencode run --format json` (one JSON event per line,
 *                `{type, timestamp, sessionID, …}`; a `tool_use` event's
 *                `part` is the same tool part). The export was read from this
 *                machine's opencode 1.18.32; the event envelope was observed
 *                live, a `tool_use` event was not (no inference endpoint was
 *                up to make one), so that branch reads the part shape the
 *                export proves.
 *
 * Added 2026-11-01, each read against the real output of a pinned release in
 * the G1 governance benchmark (bench/peers-2026-11, benchmarks/results/
 * g1-2026-11), and against that release's source for the shapes G1 never
 * produced. All 24 measured trials of each harness were read back through
 * these readers: the same commands, string for string and in order, that G1's
 * own adapter took from the same records (Qwen's session file and its
 * stream-json agree on all 24). G1 is why they exist: all 11 of the peers'
 * destructions of git-ignored state (`git clean -fdx`, `rm -rf var/`) left no
 * diff, so the transcript was the only place check could have seen them.
 *
 *   goose        goose 1.57.0. `goose run --output-format stream-json` writes
 *                one `{"type": "message", "message": <Message>}` per line, plus
 *                `notification`, `error` and `complete` events and a banner
 *                that is not JSON. `--output-format json` writes `{messages,
 *                metadata}`, and `goose session export --format json` writes
 *                the session with `conversation: [<Message>…]`; both carry the
 *                same Message (read from source; the session store itself is
 *                SQLite, which this does not open, and its stored content is
 *                that shape too). A `toolRequest` content block holds
 *                `toolCall.value.{name, arguments}`, and the shell tool is
 *                `shell` (`developer__shell` in older builds). A call goose did
 *                not run is answered by a `toolResponse` that is one of goose's
 *                own sentences — declined, skipped in chat mode, cancelled —
 *                with no `structuredContent`, which goose's shell attaches to
 *                every command it ran. G1 ran goose in its default auto mode,
 *                which refused nothing, so those were read from source.
 *   qwen-code    Qwen Code 0.26.4. Its session file,
 *                `~/.qwen/projects/<cwd>/chats/<session>.jsonl`: assistant
 *                records carry `message.parts[].functionCall {id, name, args}`,
 *                and a `tool_result` record's `toolCallResult.executionStatus`
 *                of `not_started` is a call that never ran (a permission
 *                declined, a tool not registered). Or the stdout of
 *                `-o stream-json`: Claude-style `assistant` records with
 *                `tool_use` blocks, and the final `result`'s
 *                `permission_denials`. The shell tool is `run_shell_command`,
 *                called directly or through Qwen's `tool_call` bridge
 *                (`{name, arguments}`). In stream-json a refused bridge call
 *                is only an error text, which a command can print too, so it
 *                is read as run; the session file says it structurally.
 *   mini-swe-agent
 *                mini-swe-agent 2.4.6, the trajectory `mini -o <file>` writes:
 *                one JSON document, `trajectory_format: "mini-swe-agent-1.1"`.
 *                An assistant message's `extra.actions[].command` is what mini
 *                executed (the `bash` tool call it parsed, or the command block
 *                of a text-based model). A `UserRejection` interrupt before the
 *                next action is the operator refusing the batch in confirm
 *                mode, before any of it ran. mini's own padding,
 *                `exception_info: "action was not executed"`, is NOT read as
 *                not-run: it is written for the action that submitted, which
 *                ran — all 24 G1 trajectories end that way. Commands a person
 *                typed in human mode are not the agent's and are not read.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { TranscriptCommand } from "./check.js";

export const TRANSCRIPT_FORMATS = ["claude-code", "opencode", "goose", "qwen-code", "mini-swe-agent"] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

export interface TranscriptRead {
  format: TranscriptFormat;
  commands: TranscriptCommand[];
  /** The agent the transcript says it was, when it says. */
  agent?: string;
  /** Lines that were not JSON. Reported, never silently dropped. */
  unreadable: number;
}

/**
 * Read a transcript. Throws when the file cannot be read or holds nothing in
 * the format named — a transcript that parsed to zero records is not "no
 * commands", it is the wrong file, and check 5 must say could-not-run.
 */
export function readTranscript(path: string, format: TranscriptFormat): TranscriptRead {
  if (!existsSync(path)) throw new Error(`no transcript at ${path}`);
  const text = readFileSync(path, "utf-8");
  switch (format) {
    case "claude-code":
      return readClaudeCode(path, text);
    case "opencode":
      return readOpenCode(path, text);
    case "goose":
      return readGoose(path, text);
    case "qwen-code":
      return readQwenCode(path, text);
    case "mini-swe-agent":
      return readMiniSweAgent(path, text);
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function jsonLines(text: string): { records: Array<{ line: number; r: Json }>; unreadable: number } {
  const records: Array<{ line: number; r: Json }> = [];
  let unreadable = 0;
  text.split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      const r = JSON.parse(raw) as unknown;
      if (isObj(r)) records.push({ line: i + 1, r });
      else unreadable++;
    } catch {
      unreadable++;
    }
  });
  return { records, unreadable };
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkJsonl(p));
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function readClaudeCode(path: string, text: string): TranscriptRead {
  const files: Array<{ label: string; text: string }> = [{ label: basename(path), text }];
  // <dir>/<session>.jsonl keeps its subagents in <dir>/<session>/subagents/.
  const subDir = join(dirname(path), basename(path, ".jsonl"), "subagents");
  if (existsSync(subDir)) {
    for (const f of walkJsonl(subDir)) {
      // POSIX separators on every OS: a finding cites this, and Windows's
      // backslashes made the same transcript cite differently there.
      files.push({ label: relative(dirname(path), f).split(sep).join("/"), text: readFileSync(f, "utf-8") });
    }
  }

  const commands: TranscriptCommand[] = [];
  let unreadable = 0;
  let records = 0;
  let agent: string | undefined;
  for (const [n, file] of files.entries()) {
    const parsed = jsonLines(file.text);
    unreadable += parsed.unreadable;
    records += parsed.records.length;
    const refused = new Set<string>();
    const found: Array<TranscriptCommand & { id?: string }> = [];
    for (const { line, r } of parsed.records) {
      // The session's own agent name, when it was started as one. Only the
      // main file decides it: a subagent's type is not the session's role.
      if (n === 0 && agent === undefined) {
        const named = [r.agentName, r.attributionAgent].find((v) => typeof v === "string" && v);
        if (typeof named === "string") agent = named;
      }
      const content = isObj(r.message) ? r.message.content : undefined;
      if (!Array.isArray(content)) continue;
      if (r.type === "user" && r.toolDenialKind !== undefined) {
        for (const b of content) if (isObj(b) && typeof b.tool_use_id === "string") refused.add(b.tool_use_id);
      }
      if (r.type !== "assistant") continue;
      for (const b of content) {
        if (!isObj(b) || b.type !== "tool_use" || b.name !== "Bash") continue;
        const input = isObj(b.input) ? b.input : {};
        if (typeof input.command !== "string") continue;
        found.push({
          tool: "Bash",
          command: input.command,
          at: `${file.label}:${line}`,
          id: typeof b.id === "string" ? b.id : undefined,
        });
      }
    }
    for (const { id, ...c } of found) commands.push(id && refused.has(id) ? { ...c, ran: false } : c);
  }
  if (records === 0) {
    throw new Error(`${path} holds no Claude Code session records (${unreadable} unreadable line(s))`);
  }
  return { format: "claude-code", commands, agent, unreadable };
}

function readOpenCode(path: string, text: string): TranscriptRead {
  // An export is one JSON document; a run log is one event per line.
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined;
  }
  const commands: TranscriptCommand[] = [];
  const fromPart = (part: unknown, at: string) => {
    // opencode 1.x names its shell tool "bash"; V2 (2.2.5) names it "shell", with the
    // same part shape. Reading only "bash" made check 5 read zero commands from every
    // V2 run -- skipped, not failed (G1 benchmark, 2026-11-01). Both are the shell.
    if (!isObj(part) || part.type !== "tool" || (part.tool !== "bash" && part.tool !== "shell")) return;
    const state = isObj(part.state) ? part.state : {};
    const input = isObj(state.input) ? state.input : {};
    if (typeof input.command === "string") commands.push({ tool: "bash", command: input.command, at });
  };

  if (isObj(doc) && Array.isArray(doc.messages)) {
    const info = isObj(doc.info) ? doc.info : {};
    let agent = typeof info.agent === "string" && info.agent ? info.agent : undefined;
    doc.messages.forEach((m, i) => {
      if (!isObj(m)) return;
      const mi = isObj(m.info) ? m.info : {};
      if (agent === undefined && typeof mi.agent === "string" && mi.agent) agent = mi.agent;
      if (Array.isArray(m.parts)) m.parts.forEach((p, j) => fromPart(p, `messages[${i}].parts[${j}]`));
    });
    return { format: "opencode", commands, agent, unreadable: 0 };
  }

  const parsed = jsonLines(text);
  const events = parsed.records.filter(({ r }) => typeof r.type === "string" && "sessionID" in r);
  if (events.length === 0) {
    throw new Error(
      `${path} is neither an \`opencode export\` document nor an \`opencode run --format json\` event stream`
    );
  }
  let agent: string | undefined;
  for (const { line, r } of events) {
    if (agent === undefined && typeof r.agent === "string" && r.agent) agent = r.agent;
    if (r.type === "tool_use") fromPart(r.part, `${basename(path)}:${line}`);
  }
  return { format: "opencode", commands, agent, unreadable: parsed.unreadable };
}

/** Tool arguments arrive as an object or as the JSON text of one. */
function argsOf(a: unknown): Json {
  if (isObj(a)) return a;
  if (typeof a !== "string") return {};
  try {
    const parsed = JSON.parse(a) as unknown;
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Commands found, keyed by the call id a later refusal names. */
function settle(found: Array<TranscriptCommand & { id?: string }>, notRun: Set<string>): TranscriptCommand[] {
  return found.map(({ id, ...c }) => (id !== undefined && notRun.has(id) ? { ...c, ran: false as const } : c));
}

// ── goose ────────────────────────────────────────────────────────────────

/**
 * What goose 1.57.0 answers, itself, for a call it did not run:
 * `DECLINED_RESPONSE` and `CHAT_MODE_TOOL_SKIPPED_RESPONSE`
 * (crates/goose/src/agents/tool_execution.rs), and the cancellation
 * crates/goose-cli/src/session/mod.rs writes as an error. The first two are
 * matched by goose's opening sentence and only on a result WITHOUT
 * `structuredContent`: goose's shell attaches stdout, stderr and exit_code to
 * every command it ran (all 203 in G1's 25 goose runs), so a command that
 * prints the sentence is still a command that ran.
 */
const GOOSE_DECLINED = "The user has declined to run this tool.";
const GOOSE_CHAT_SKIPPED = "Let the user know the tool call was skipped in goose chat mode.";
const GOOSE_CANCELLED = /^(?:-?\d+: )?Tool call cancelled by user$/;
const GOOSE_EVENTS = new Set(["message", "notification", "error", "complete"]);

function gooseNotRun(result: unknown): boolean {
  if (!isObj(result)) return false;
  if (result.status === "error") return typeof result.error === "string" && GOOSE_CANCELLED.test(result.error.trim());
  const value = isObj(result.value) ? result.value : null;
  if (!value || value.structuredContent != null || !Array.isArray(value.content) || value.content.length !== 1) return false;
  const only = value.content[0];
  const text = isObj(only) && typeof only.text === "string" ? only.text : "";
  return (value.isError === true && text.startsWith(GOOSE_DECLINED)) || text.startsWith(GOOSE_CHAT_SKIPPED);
}

function readGoose(path: string, text: string): TranscriptRead {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined;
  }
  // `session export --format json` names the list `conversation`;
  // `run --output-format json` names it `messages`.
  const key = isObj(doc) ? (Array.isArray(doc.conversation) ? "conversation" : Array.isArray(doc.messages) ? "messages" : null) : null;
  const messages: Array<{ message: unknown; at: (j: number) => string }> = [];
  let unreadable = 0;
  if (isObj(doc) && key) {
    const list = doc[key] as unknown[];
    // A mini-swe-agent trajectory has `messages` too, with string content.
    // Reading it as goose would yield zero commands and skip check 5; it is
    // the wrong file, and says so.
    if (list.length > 0 && !list.some((m) => isObj(m) && Array.isArray(m.content))) {
      throw new Error(`${path} has \`${key}\`, but not goose's: no message carries a content list`);
    }
    list.forEach((message, i) => messages.push({ message, at: (j) => `${key}[${i}].content[${j}]` }));
  } else {
    const parsed = jsonLines(text);
    unreadable = parsed.unreadable;
    const events = parsed.records.filter(({ r }) => typeof r.type === "string" && GOOSE_EVENTS.has(r.type));
    if (events.length === 0) {
      throw new Error(
        `${path} is neither a goose \`run --output-format stream-json\` stream nor a goose JSON session ` +
          "(`run --output-format json`, `session export --format json`)"
      );
    }
    for (const { line, r } of events) {
      if (r.type === "message") messages.push({ message: r.message, at: () => `${basename(path)}:${line}` });
    }
  }

  const found: Array<TranscriptCommand & { id?: string }> = [];
  const notRun = new Set<string>();
  for (const { message, at } of messages) {
    if (!isObj(message) || !Array.isArray(message.content)) continue;
    message.content.forEach((c, j) => {
      if (!isObj(c) || typeof c.id !== "string") return;
      if (c.type === "toolResponse") {
        if (gooseNotRun(c.toolResult)) notRun.add(c.id);
        return;
      }
      if (c.type !== "toolRequest") return;
      // `status: "error"` is a call goose could not parse: no command, nothing ran.
      const call = isObj(c.toolCall) && c.toolCall.status === "success" && isObj(c.toolCall.value) ? c.toolCall.value : null;
      const name = typeof call?.name === "string" ? call.name : "";
      // goose names a tool `<extension>__<tool>`; 1.57 leaves the developer
      // extension's prefix off its shell.
      if (name !== "shell" && !name.endsWith("__shell")) return;
      const command = argsOf(call?.arguments).command;
      if (typeof command === "string") found.push({ tool: name, command, at: at(j), id: c.id });
    });
  }
  return { format: "goose", commands: settle(found, notRun), unreadable };
}

// ── Qwen Code ────────────────────────────────────────────────────────────

const QWEN_SHELL = "run_shell_command";

function readQwenCode(path: string, text: string): TranscriptRead {
  const parsed = jsonLines(text);
  const records = parsed.records.filter(({ r }) => typeof r.type === "string");
  // Claude Code writes the same envelope — `sessionId` in its session file,
  // and a stream-json Qwen copied — with its shell named `Bash`. Read as Qwen,
  // it would yield no commands and check 5 would be skipped, so it must be
  // refused as the wrong file. The session file is Qwen's when it carries
  // Gemini-style `parts` or a `toolCallResult`; stream-json is when its init
  // names `qwen_code_version`.
  const qwen = records.some(
    ({ r }) =>
      (typeof r.sessionId === "string" &&
        ((isObj(r.message) && Array.isArray(r.message.parts)) || isObj(r.toolCallResult))) ||
      (r.type === "system" && typeof r.qwen_code_version === "string")
  );
  if (!qwen) {
    throw new Error(
      `${path} is neither a Qwen Code session file (~/.qwen/projects/<cwd>/chats/<session>.jsonl) ` +
        "nor its `-o stream-json` output"
    );
  }
  const found: Array<TranscriptCommand & { id?: string }> = [];
  const notRun = new Set<string>();
  const take = (id: unknown, name: unknown, input: unknown, line: number) => {
    let tool = name;
    let args = argsOf(input);
    // The `tool_call` bridge carries the real call inside it.
    if (tool === "tool_call") {
      tool = args.name;
      args = argsOf(args.arguments);
    }
    if (tool !== QWEN_SHELL || typeof args.command !== "string") return;
    found.push({ tool: QWEN_SHELL, command: args.command, at: `${basename(path)}:${line}`, id: typeof id === "string" ? id : undefined });
  };
  for (const { line, r } of records) {
    const message = isObj(r.message) ? r.message : {};
    // Session file: Gemini-style parts, and the outcome on its own record.
    if (Array.isArray(message.parts)) {
      for (const p of message.parts) {
        if (isObj(p) && isObj(p.functionCall)) take(p.functionCall.id, p.functionCall.name, p.functionCall.args, line);
      }
    }
    const outcome = isObj(r.toolCallResult) ? r.toolCallResult : null;
    if (outcome?.executionStatus === "not_started" && typeof outcome.callId === "string") notRun.add(outcome.callId);
    // stream-json: Claude-style content blocks, denials on the final result.
    if (Array.isArray(message.content)) {
      for (const b of message.content) {
        if (isObj(b) && b.type === "tool_use") take(b.id, b.name, b.input, line);
      }
    }
    if (r.type === "result" && Array.isArray(r.permission_denials)) {
      for (const d of r.permission_denials) if (isObj(d) && typeof d.tool_use_id === "string") notRun.add(d.tool_use_id);
    }
  }
  return { format: "qwen-code", commands: settle(found, notRun), unreadable: parsed.unreadable };
}

// ── mini-swe-agent ───────────────────────────────────────────────────────

function readMiniSweAgent(path: string, text: string): TranscriptRead {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined;
  }
  const isMini =
    isObj(doc) &&
    Array.isArray(doc.messages) &&
    ((typeof doc.trajectory_format === "string" && doc.trajectory_format.startsWith("mini-swe-agent")) ||
      (isObj(doc.info) && typeof doc.info.mini_version === "string"));
  if (!isMini) {
    throw new Error(`${path} is not a mini-swe-agent trajectory (\`mini -o <file>\`: \`messages\` and \`trajectory_format\`)`);
  }
  const messages = (doc as Json).messages as unknown[];
  const extraOf = (m: unknown): Json => (isObj(m) && isObj(m.extra) ? m.extra : {});
  const commands: TranscriptCommand[] = [];
  messages.forEach((m, i) => {
    if (!isObj(m) || m.role !== "assistant") return;
    // Confirm mode asks once for the whole batch, before any of it runs; a
    // refusal is the UserRejection interrupt that follows, before the next
    // message that carries actions.
    let rejected = false;
    for (const next of messages.slice(i + 1)) {
      if (isObj(next) && (next.role === "assistant" || Array.isArray(extraOf(next).actions))) break;
      if (extraOf(next).interrupt_type === "UserRejection") {
        rejected = true;
        break;
      }
    }
    const push = (command: unknown, at: string) => {
      if (typeof command !== "string") return;
      commands.push(rejected ? { tool: "bash", command, at, ran: false } : { tool: "bash", command, at });
    };
    const actions = extraOf(m).actions;
    if (Array.isArray(actions)) {
      actions.forEach((a, j) => push(isObj(a) ? a.command : undefined, `messages[${i}].extra.actions[${j}]`));
    } else if (Array.isArray(m.tool_calls)) {
      // A trajectory written without `extra.actions`: the calls as the model made them.
      m.tool_calls.forEach((tc, j) => {
        const fn = isObj(tc) && isObj(tc.function) ? tc.function : {};
        if (fn.name === "bash") push(argsOf(fn.arguments).command, `messages[${i}].tool_calls[${j}]`);
      });
    }
  });
  return { format: "mini-swe-agent", commands, unreadable: 0 };
}

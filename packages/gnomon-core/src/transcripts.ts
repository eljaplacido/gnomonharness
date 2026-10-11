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
 *                `messages[].parts[]` with `type: "tool"`, `tool: "bash"`,
 *                `state.input.command`), or the event stream of
 *                `opencode run --format json` (one JSON event per line,
 *                `{type, timestamp, sessionID, …}`; a `tool_use` event's
 *                `part` is the same tool part). The export was read from this
 *                machine's opencode 1.18.32; the event envelope was observed
 *                live, a `tool_use` event was not (no inference endpoint was
 *                up to make one), so that branch reads the part shape the
 *                export proves.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { TranscriptCommand } from "./check.js";

export const TRANSCRIPT_FORMATS = ["claude-code", "opencode"] as const;
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
  return format === "claude-code" ? readClaudeCode(path, text) : readOpenCode(path, text);
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
      files.push({ label: relative(dirname(path), f), text: readFileSync(f, "utf-8") });
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
    if (!isObj(part) || part.type !== "tool" || part.tool !== "bash") return;
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

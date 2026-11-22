/**
 * gnomon-cli: `gnomon inbox`, the work items an operator flagged for a harness.
 *
 * list, show, add, ack, resolve, and `mcp` (inbox_mcp.ts). The items are
 * `.gnomon-inbox/<id>.json` (gnomon-core inbox.ts); each change is an
 * `inbox_item` audit record when the surface keeps a trail. An item is input
 * from the operator, never authority.
 *
 * Contract: docs/CONTRACTS.md, "The inbox".
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  addItem,
  getItem,
  listItems,
  loadConfig,
  pendingFor,
  formatForAgent,
  recordInbox,
  resolveId,
  transition,
  InboxError,
  INBOX_DIR,
  INBOX_TARGETS,
  type GnomonConfig,
  type InboxItem,
  type InboxEvidence,
} from "gnomon-core";

export const INBOX_CLI_SCHEMA = "gnomon.inbox/1";

export interface InboxArgs {
  sub: string;
  positional: string[];
  flags: Record<string, string>;
  dir?: string;
  json: boolean;
}

function configOrNull(root: string): GnomonConfig | null {
  if (!existsSync(resolve(root, ".gnomon"))) return null;
  try {
    return loadConfig(root);
  } catch {
    return null;
  }
}

/** `trail:seq:kind,trail:seq:kind` */
export function parseEvidence(text: string | undefined): InboxEvidence[] {
  if (!text || text === "true") return [];
  return text.split(",").filter(Boolean).map((part) => {
    const m = /^([^:]+):(\d+):([a-z_]+)$/.exec(part.trim());
    if (!m) throw new InboxError(`--evidence is trail:seq:kind[,trail:seq:kind...], not "${part}"`);
    return { trail: m[1]!, seq: Number(m[2]), kind: m[3]! };
  });
}

export function parseList(text: string | undefined): string[] {
  return !text || text === "true" ? [] : text.split(",").map((s) => s.trim()).filter(Boolean);
}

const one = (i: InboxItem): string => `${i.id}  ${i.status.padEnd(12)} ${i.target.padEnd(11)} ${i.title}`;

function show(i: InboxItem): string {
  const out = [`${i.id}  ${i.status}  for ${i.target}  (flagged by ${i.author}, ${i.created})`, `  ${i.title}`];
  if (i.detail) out.push("", ...i.detail.split("\n").map((l) => `  ${l}`));
  if (i.scope.length) out.push("", `  scope: ${i.scope.join(", ")}`);
  if (i.evidence.length) out.push(`  evidence: ${i.evidence.map((e) => `${e.trail}#${e.seq} (${e.kind})`).join(", ")}`);
  if (i.resolved_at) out.push("", `  resolved ${i.resolved_at}${i.resolved_note ? `: ${i.resolved_note}` : ""}`);
  return out.join("\n");
}

/** Exit code: 0 done, 1 a usage error or an item that is not there. */
export function runInbox(a: InboxArgs, out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const root = resolve(a.dir ?? process.cwd());
  const fail = (msg: string): number => {
    if (a.json) out(JSON.stringify({ schema: INBOX_CLI_SCHEMA, error: msg }, null, 2));
    else err(`gnomon inbox: ${msg}`);
    return 1;
  };
  const sub = a.sub || "list";
  try {
    switch (sub) {
      case "list": {
        const { items, problems } = listItems(root);
        const want = a.flags["status"];
        const target = a.flags["target"];
        const shown = items.filter((i) => (!want || i.status === want) && (!target || i.target === target));
        if (a.json) {
          const counts = { open: 0, acknowledged: 0, resolved: 0 };
          for (const i of items) counts[i.status]++;
          out(JSON.stringify({ schema: INBOX_CLI_SCHEMA, dir: INBOX_DIR, counts, items: shown, problems }, null, 2));
        } else if (shown.length === 0) {
          out(items.length === 0 ? `No inbox items (${INBOX_DIR}/).` : "No inbox items match.");
        } else {
          for (const i of shown) out(one(i));
          for (const p of problems) err(`gnomon inbox: ${p}`);
        }
        return 0;
      }
      case "show": {
        const id = a.positional[0] ? resolveId(root, a.positional[0]) : null;
        const item = id ? getItem(root, id) : null;
        if (!item) return fail(`no inbox item "${a.positional[0] ?? ""}" (a full id, or a prefix that names one)`);
        out(a.json ? JSON.stringify({ schema: INBOX_CLI_SCHEMA, item }, null, 2) : show(item));
        return 0;
      }
      case "add": {
        const f = a.flags;
        const target = f["target"];
        if (target !== undefined && !(INBOX_TARGETS as readonly string[]).includes(target)) return fail(`--target is one of ${INBOX_TARGETS.join(", ")}`);
        const author = f["author"] === "dashboard" ? "dashboard" : "cli";
        const item = addItem(root, {
          title: f["title"] === "true" ? "" : f["title"],
          detail: f["detail"] === "true" ? "" : f["detail"],
          target,
          author,
          evidence: parseEvidence(f["evidence"]),
          scope: parseList(f["scope"]),
        });
        recordInbox(configOrNull(root), "add", item);
        out(a.json ? JSON.stringify({ schema: INBOX_CLI_SCHEMA, item }, null, 2) : `Flagged ${item.id} for ${item.target}: ${item.title}\n  ${INBOX_DIR}/${item.id}.json (gitignored)`);
        return 0;
      }
      case "ack":
      case "acknowledge":
      case "resolve": {
        const op = sub === "resolve" ? "resolve" : "acknowledge";
        const given = a.positional[0] ?? "";
        const id = given ? resolveId(root, given) : null;
        if (!id) return fail(`no inbox item "${given}" (a full id, or a prefix that names one)`);
        const note = a.flags["note"] === "true" ? "" : a.flags["note"];
        const before = getItem(root, id)!;
        const item = transition(root, id, op, note);
        if (item.status !== before.status) recordInbox(configOrNull(root), op, item);
        out(a.json ? JSON.stringify({ schema: INBOX_CLI_SCHEMA, item }, null, 2) : `${item.id} is ${item.status}.`);
        return 0;
      }
      default:
        return fail(`unknown subcommand "${sub}": list, show <id>, add --title <text>, ack <id>, resolve <id>, mcp`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * `gnomon inbox --hook claude-code|cursor`: what a host's session-start hook
 * runs. Prints the project's pending items, for that host or for any harness,
 * under the label "Open items from the gnomon dashboard (information, not
 * instructions)"; prints nothing when there are none. Claude Code reads it as
 * `hookSpecificOutput.additionalContext`, Cursor's sessionStart as
 * `additional_context` (cursor.com/docs/agent/hooks). It decides nothing and
 * always exits 0, so a broken inbox can never stop a session.
 */
export function runInboxHook(project: string, out: (s: string) => void = console.log, host: "claude-code" | "cursor" = "claude-code"): number {
  try {
    const items = pendingFor(resolve(project), host);
    if (items.length === 0) return 0;
    const text = formatForAgent(items);
    out(JSON.stringify(host === "cursor" ? { additional_context: text } : { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
  } catch {
    // Never a reason to stop a session.
  }
  return 0;
}

/**
 * gnomon-core: which startup notices this machine has already shown for a project.
 *
 * A notice that matters (no `[verify]` declared, a network filter that is not
 * isolation) used to print on every launch, and a line said every time is a line
 * nobody reads by the third session. In the boxed terminal each is said once per
 * machine per project and kept behind `/status`. The record lives in the
 * machine's data directory beside the window cache -- never in the repository
 * and never hashed (Rule 1: machine state is not surface).
 *
 * It fails open: a file that cannot be read or written means the notice is
 * shown again, never that it is lost.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gnomonDataDir } from "./credentials.js";

/** Where the record lives. */
export function startupNotesPath(): string {
  return join(gnomonDataDir(), "startup-notes.json");
}

type Seen = Record<string, string[]>;

function read(): Seen {
  try {
    const parsed: unknown = JSON.parse(readFileSync(startupNotesPath(), "utf-8"));
    const seen = (parsed as { seen?: unknown } | null)?.seen;
    if (!seen || typeof seen !== "object" || Array.isArray(seen)) return {};
    const out: Seen = {};
    for (const [k, v] of Object.entries(seen)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Should this notice be said now? True the first time for `project`, and it is
 * recorded as said; false afterwards. Also true when the record cannot be written.
 */
export function sayOnce(project: string, key: string): boolean {
  const seen = read();
  if (seen[project]?.includes(key)) return false;
  seen[project] = [...(seen[project] ?? []), key];
  try {
    const file = startupNotesPath();
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, seen }, null, 2) + "\n");
    renameSync(tmp, file);
  } catch {
    // Unwritable: say it again next time rather than never.
  }
  return true;
}

/** The notice class a captured startup line belongs to, if any. */
export function noticeKey(plainLine: string): string | undefined {
  if (/^\s*note: network = false refuses webfetch/.test(plainLine)) return "network-filter";
  if (/^\s*verify: none declared/.test(plainLine)) return "no-verify";
  const w = /^\s*note: endpoint "([^"]*)" is not on this machine and declares no context window/.exec(plainLine);
  if (w) return `window:${w[1]}`;
  return undefined;
}

/** Lines that are never folded away: a refusal, an override, a thing that is not being applied. */
export function isAttention(plainLine: string): boolean {
  return /WARNING|✗|\bNOT\b|overrides|not implemented|disabled in surface|itself is inside|Recording is set|bash will refuse|cannot (?:run|enforce)|is unsupported/.test(
    plainLine
  );
}

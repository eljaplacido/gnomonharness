/**
 * gnomon-cli: migrate
 *
 * Bring an existing `.gnomon/` up to the current shipped defaults.
 *
 * Why this command exists
 * -----------------------
 * `gnomon init` writes every default into `config.toml` explicitly, and the
 * code default only applies when a key is ABSENT. So changing a default in the
 * source changes it for new projects and for nobody else: an existing surface
 * keeps the old value, silently, until a human edits the line. That is correct
 * — `.gnomon/` is content-hashed and human-owned, and a release that rewrites a
 * committed surface moves the hash under someone who did not ask — but it
 * leaves the person who already adopted gnomon on the worse setting with
 * nothing telling them so.
 *
 * This is the honest middle: never automatic, one command, and it says what it
 * changed and why.
 *
 * What it will not do
 * -------------------
 * It rewrites one LINE at a time with a targeted match, never by parsing the
 * TOML and re-serialising it. A round trip through a parser would drop every
 * comment in the file, and the scaffold's comments are most of what makes the
 * surface readable — losing them to a "migration" would be a bad trade the
 * user never agreed to.
 *
 * It also only ever rewrites a value that WAS the old default. A value that is
 * neither the old default nor the new one was chosen by somebody, and this
 * command has no way to distinguish a deliberate choice from an inherited one,
 * so it does not try.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { detectVerifyCommand } from "gnomon-core";

export interface Migration {
  id: string;
  /** Surface file it edits, relative to `.gnomon/` */
  file: string;
  /** One line: what changes */
  what: string;
  /** Why, naming the evidence rather than asserting it */
  why: string[];
  /**
   * Rewrite the file text, or return null when there is nothing to do.
   * Must be a no-op for any value other than the old default.
   */
  apply(text: string, ctx: { root: string }): string | null;
}

/**
 * Rewrite `key = <old>` to `key = <new>` inside one TOML section, keeping the
 * line's indentation and its trailing comment.
 */
function retypeKey(
  text: string,
  section: string,
  key: string,
  oldValue: string,
  newValue: string
): string | null {
  const lines = text.split("\n");
  let inSection = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inSection = header[1].trim() === section;
      continue;
    }
    if (!inSection) continue;
    const m = lines[i].match(
      new RegExp(`^(\\s*${key}\\s*=\\s*)"${oldValue}"(\\s*(?:#.*)?)$`)
    );
    if (!m) continue;
    lines[i] = `${m[1]}"${newValue}"${m[2]}`;
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "compaction-summary",
    file: "config.toml",
    what: `[defaults] compaction = "discard"  →  "summary"`,
    why: [
      "`discard` measured 0/9 on context retention against 9/9 for `summary`",
      "(benchmarks/results/context-2026-08-31). It was the shipped default",
      "until 2026-09-04, so a surface scaffolded before then still carries it.",
      "A session under `discard` forgets an evicted turn outright and then",
      "answers as though it never knew.",
    ],
    apply: (text) => retypeKey(text, "defaults", "compaction", "discard", "summary"),
  },
  {
    id: "system-md-second-turn",
    file: "system.md",
    what: `system.md: "there is no second turn" → only for unattended runs`,
    why: [
      "The scaffold told every session there is no second turn, and the",
      "interactive loop sent that to a person who was sitting right there.",
      "Measured 2026-09-29: asked for a recap, a turn ran 112+ tool calls of",
      "implementation. Only the exact scaffold sentence is replaced.",
    ],
    apply: (text) => {
      const old =
        "- A reply with no tool call ends the turn. Never send a plan and wait for a\n" +
        "  go-ahead — there is no second turn. Execute, then report.";
      if (!text.includes(old)) return null;
      return text.replace(
        old,
        () =>
          "- A reply with no tool call ends the turn. When you were asked to do\n" +
          "  something, do not send a plan and wait for a go-ahead — execute, then\n" +
          "  report. Whether anyone can answer a question is stated under \"This\n" +
          "  session\" at the end of this prompt."
      );
    },
  },
  {
    id: "verify-declared",
    file: "policy.toml",
    what: `policy.toml: no [verify]  →  the check this project already declares`,
    why: [
      "With no [verify], no turn is ever checked: \"done\" is the model's",
      "belief. Until 2026-09-29 the scaffold shipped the block commented out.",
      "Only a command the project itself declares is added (package.json",
      "verify/check/test, Cargo.toml, go.mod, pytest, make test) — nothing",
      "is invented, and a surface with any [verify] block is left alone.",
    ],
    apply: (text, ctx) => {
      if (/^\s*\[verify\]\s*$/m.test(text)) return null;
      const command = detectVerifyCommand(ctx.root);
      if (!command) return null;
      return (
        text.replace(/\n*$/, "\n") +
        `\n# Added by 'gnomon migrate' from this project's own files.\n` +
        `[verify]\ncommand = ${JSON.stringify(command)}\n` +
        `after = "change"         # any turn that changed a file, by write/edit or the shell\n` +
        `max_rounds = 1\n`
      );
    },
  },
];

export interface MigrationResult {
  id: string;
  file: string;
  what: string;
  why: string[];
  /** The rewritten text, held rather than written when checking only */
  next: string;
  path: string;
}

/** Everything this surface is behind on. Reads only. */
export function pendingMigrations(gnomonDir: string): MigrationResult[] {
  const out: MigrationResult[] = [];
  for (const m of MIGRATIONS) {
    const path = join(gnomonDir, m.file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf-8");
    const next = m.apply(text, { root: dirname(gnomonDir) });
    if (next === null || next === text) continue;
    out.push({ id: m.id, file: m.file, what: m.what, why: m.why, next, path });
  }
  return out;
}

/** Write the pending migrations. Returns how many were applied. */
export function applyMigrations(pending: MigrationResult[]): number {
  for (const p of pending) writeFileSync(p.path, p.next, "utf-8");
  return pending.length;
}

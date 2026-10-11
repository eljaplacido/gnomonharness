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
        `max_rounds = 1\n` +
        `test_must_fail_first = true  # a new test must fail on the code as it was\n`
      );
    },
  },
  {
    id: "verify-must-fail-first",
    file: "policy.toml",
    what: `policy.toml [verify]: test_must_fail_first absent  →  true`,
    why: [
      "A passing check is only evidence if the tests it runs pin something.",
      "T8 measured a model writing a test that does 1 time in 9, three of the",
      "nine asserting the bug. With this on, a new test that passes against the",
      "code as it was is handed back; `gnomon check` applies the same rule to",
      "other harnesses. Scaffolded on since 2026-10. Only a [verify] block with",
      "no test_must_fail_first line at all is touched — `= false` is a choice.",
    ],
    apply: (text) => addKeyToSection(text, "verify", "test_must_fail_first", "true  # a new test must fail on the code as it was"),
  },
  {
    id: "audit-enabled",
    file: "config.toml",
    what: `[audit] enabled = false  →  true`,
    why: [
      "A governance layer that keeps no record cannot show afterwards what it",
      "governed: a 48-task campaign run with the trail off answered none of",
      "its own questions (docs/BENCHMARK-POSTMORTEM.md). `record` is left as it",
      "is — the scaffold's \"metadata\" writes no prompt or response text.",
      "Scaffolded on since 2026-10. Trails land in [audit] dir, outside .gnomon/.",
    ],
    apply: (text) => retypeBool(text, "audit", "enabled", false, true),
  },
];

/** `key = <old bool>` → `key = <new bool>` inside one section, comment kept. */
function retypeBool(text: string, section: string, key: string, oldValue: boolean, newValue: boolean): string | null {
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
    const m = lines[i].match(new RegExp(`^(\\s*${key}\\s*=\\s*)${oldValue}(\\s*(?:#.*)?)$`));
    if (!m) continue;
    lines[i] = `${m[1]}${newValue}${m[2]}`;
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}

/**
 * Add `key = value` to a section that does not mention the key at all, right
 * after the section's last key line. A section that names it in any form —
 * true, false, or a value this code does not recognise — was written by
 * somebody and is left alone. A commented-out `# key = …` is not a mention.
 */
function addKeyToSection(text: string, section: string, key: string, value: string): string | null {
  const lines = text.split("\n");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (!header) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (header[1].trim() === section) start = i;
  }
  if (start < 0) return null;
  let last = start;
  for (let i = start + 1; i < end; i++) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) return null;
    if (/^\s*[A-Za-z0-9_"'-]+\s*=/.test(lines[i])) last = i;
  }
  lines.splice(last + 1, 0, `${key} = ${value}`);
  return lines.join("\n");
}

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
  // Each migration reads the file as the ones before it left it. Two that
  // edit the same file (verify-declared and verify-must-fail-first both edit
  // policy.toml) used to each start from the original, and applying both
  // wrote the second over the first.
  const current = new Map<string, string>();
  for (const m of MIGRATIONS) {
    const path = join(gnomonDir, m.file);
    if (!existsSync(path)) continue;
    const text = current.get(path) ?? readFileSync(path, "utf-8");
    const next = m.apply(text, { root: dirname(gnomonDir) });
    if (next === null || next === text) continue;
    current.set(path, next);
    out.push({ id: m.id, file: m.file, what: m.what, why: m.why, next, path });
  }
  return out;
}

/**
 * Write the pending migrations. Returns how many were applied. In order: a
 * later entry for the same file carries the earlier ones' changes.
 */
export function applyMigrations(pending: MigrationResult[]): number {
  for (const p of pending) writeFileSync(p.path, p.next, "utf-8");
  return pending.length;
}

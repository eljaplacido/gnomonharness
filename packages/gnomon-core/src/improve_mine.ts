/**
 * gnomon-core: what `gnomon improve` mines from the record.
 *
 * Deterministic and free: the same trails give the same candidates, in the
 * same order, with no model and no clock. A candidate is a signal, its counts
 * and pointers to the records it came from (`{trail, seq}`), plus a
 * deterministic template for the text a proposal would carry. A model may
 * rewrite that text (improve.ts), and every proposal is linted, probed and
 * decided whatever wrote it.
 *
 * Four families, each from fields an audit trail already holds under either
 * `[audit] record` setting (a command is an action, recorded as such):
 *  - skill    the same rule refusing the same role in three or more sessions
 *             (skill_mine.ts `mineCandidates`, unchanged)
 *  - retire   a skill that fires often and is never named in the reasoning
 *             (skill_mine.ts `skillUsageSignals`, Hermes's retire as a proposal)
 *  - memory   what sessions keep rediscovering: a build or test command that
 *             succeeded in three or more sessions, the files sessions open
 *             first, an approval the operator declined in three or more sessions
 *  - harness  a failure class that ended turns in three or more sessions
 *             (stall, step wall, malformed calls, truncation, a failed check)
 *             becomes one short note for `system.md`
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { AuditRecord } from "./audit.js";
import { resolveAudit } from "./audit.js";
import type { GnomonConfig } from "./config.js";
import { attributeTrail, layerOf, type FailureTag } from "./failure_attribution.js";
import { loadMemory } from "./memory.js";
import type { ProposalEvidence } from "./proposals.js";
import { MIN_REPEATS, mineCandidates, readRecords, readSkillUsage, skillUsageSignals } from "./skill_mine.js";
import { loadSkills } from "./skills.js";

export const MINE_FAMILIES = ["skill", "retire", "memory", "harness"] as const;
export type MineFamily = (typeof MINE_FAMILIES)[number];

/** The text a candidate would propose, before a model or a person touches it. */
export interface Draft {
  name: string;
  description: string;
  body: string;
  /** Skills only: when it applies, and for whom. */
  match?: string;
  roles?: string[];
}

export interface MinedCandidate {
  family: MineFamily;
  signal: string;
  /** Stable across runs: what a rerun uses to skip what it already proposed. */
  signature: string;
  title: string;
  counts: Record<string, number | string>;
  evidence: ProposalEvidence[];
  /** What a drafting model is given: facts from the record, never prose from it. */
  facts: string[];
  /** The deterministic text. Absent for a retirement. */
  template?: Draft;
  /** A retirement: the skill id. A harness note: the note, for `system.md`. */
  target?: string;
  note?: string;
}

export interface MineResult {
  candidates: MinedCandidate[];
  /** Why nothing was mined, or what was skipped: for the dry run to say. */
  notes: string[];
  trails: number;
  records: number;
}

const MAX_POINTERS = 5;
const MAX_PATH = 120;

const ptr = (file: string, seq: number): ProposalEvidence => ({ trail: basename(file).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200), seq });

const BUILD_TEST =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|ci)\b|(?:npx\s+)?(?:vitest|jest|tsc|eslint|pytest|ruff|mypy)\b|python3?\s+-m\s+(?:pytest|unittest|mypy|ruff)\b|cargo\s+(?:test|build|check|clippy|fmt)\b|go\s+(?:test|build|vet)\b|make(?:\s+[A-Za-z][\w-]*)?$|(?:\.\/)?gradlew?\s+\S+|mvn\s+\S+|dotnet\s+(?:test|build)\b|bash\s+\S*ci\.sh$)/;

/** A command as sessions repeat it: one line, no leading `cd x &&`, whitespace collapsed. */
export function normalizeMinedCommand(raw: string): string {
  let c = raw.replace(/\s+/g, " ").trim();
  c = c.replace(/^cd\s+\S+\s*&&\s*/, "");
  return c.length > 160 ? "" : c;
}

function slug(text: string, max = 40): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "x";
}

/**
 * What an attributed failure (failure_attribution.ts) is mined into. The
 * attribution picks the candidate kind: a Tools failure is a note the agent
 * reads, a Verification failure is a note about the check, a Context failure
 * is a note plus a `suggest` for a PERSON. `suggest` goes in the proposal's
 * rationale only: `[context]` is config, and no proposal reaches config.
 * Only tags that no stop-reason class above already covers are listed, so a
 * run that mined before mines the same candidates now.
 */
const ATTRIBUTED_CLASSES: Partial<Record<FailureTag, { name: string; description: string; note: string; suggest?: string }>> = {
  edit_failed: {
    name: "edit that did not match",
    description: "Turns ended after edits that did not match the file.",
    note: "Read the file again just before editing it and copy the exact lines to replace, because an edit whose text no longer matches changes nothing.",
  },
  tool_timeout: {
    name: "command timeouts",
    description: "Turns ended after commands that hit the timeout.",
    note: "Run a command that may take long in the background or with a narrower scope, because a command that hits the timeout returns nothing and costs a step.",
  },
  tool_error: {
    name: "rejected tool calls",
    description: "Turns ended after a tool kept rejecting its calls.",
    note: "When a tool reports an error, read it and change the call, because repeating a call the tool rejects never succeeds.",
  },
  wrong_thing_verified: {
    name: "check edited to pass",
    description: "A check or test file was edited after it failed, and then passed with no other change.",
    note: "Do not edit a check or test to make it pass. Change the code it checks, because a check changed to agree with the code proves nothing.",
  },
  unverified_finish: {
    name: "finished without a check",
    description: "Turns ended with a change that no command ran after.",
    note: "Run the project's check after the last change and read its output before finishing, because a change made after the last check is untested.",
  },
  context_overflow: {
    name: "context too long",
    description: "Turns ended because the context could not be fitted.",
    note: "Keep tool output small: read file ranges, and filter and limit command output, because a request that is too long is refused.",
    suggest: "For a person to consider, not applied: [context] in config.toml (a smaller window estimate, or summary_style) controls when the context is trimmed. gnomon improve never edits config.",
  },
  context_loss: {
    name: "context trimmed",
    description: "Turns survived a context overflow only by dropping half of the conversation.",
    note: "Keep tool output small: read file ranges, and filter and limit command output, because a request that is too long is refused and the conversation is cut.",
    suggest: "For a person to consider, not applied: [context] in config.toml (a smaller window estimate, or summary_style) controls when the context is trimmed. gnomon improve never edits config.",
  },
};

const FAILURE_CLASSES: Record<string, { name: string; description: string; note: string; suggest?: string; layer?: string }> = {
  stall: {
    name: "repeated steps",
    description: "Turns ended in a stall: the same step repeated without progress.",
    note: "When two steps in a row repeat the same call or give the same output, stop and change approach (read the error, narrow the problem), because repeating an identical step never converges.",
  },
  step_wall: {
    name: "step limit",
    description: "Turns ran into the step limit before finishing.",
    note: "Break a large task into steps that each end with the project's check passing, so that work done before the step limit is already verified and not lost.",
  },
  malformed: {
    name: "tool call shape",
    description: "Turns ended on malformed tool calls.",
    note: "Give every tool call all of its required arguments in the documented shape, because a malformed call costs a step and is refused.",
  },
  truncated: {
    name: "reply length",
    description: "Turns ended because the reply was cut off.",
    note: "Keep replies and tool output short and write long content to a file, because a reply that is cut off loses its end.",
  },
  verify_failed: {
    name: "check before done",
    description: "The project's check failed after a change in several sessions.",
    note: "Run the project's own check after a change and read its output before calling the work done, because the check failed after changes in several sessions.",
  },
};

for (const [tag, def] of Object.entries(ATTRIBUTED_CLASSES)) FAILURE_CLASSES[tag] = { ...def!, layer: layerOf(tag as FailureTag) ?? undefined };

interface Pool {
  files: string[];
  /** command -> {trails, pointers} */
  commands: Map<string, { trails: Set<string>; ptrs: ProposalEvidence[] }>;
  reads: Map<string, { trails: Set<string>; ptrs: ProposalEvidence[] }>;
  declined: Map<string, { tool: string; summary: string; trails: Set<string>; ptrs: ProposalEvidence[] }>;
  stops: Map<string, { trails: Set<string>; ptrs: ProposalEvidence[] }>;
  skillUse: Map<string, ProposalEvidence[]>;
  records: number;
}

function bucket<T extends { trails: Set<string>; ptrs: ProposalEvidence[] }>(m: Map<string, T>, key: string, make: () => T, trail: string, p: ProposalEvidence): void {
  let g = m.get(key);
  if (!g) {
    g = make();
    m.set(key, g);
  }
  g.trails.add(trail);
  if (g.ptrs.length < MAX_POINTERS && !g.ptrs.some((x) => x.trail === p.trail)) g.ptrs.push(p);
}

function scanTrails(config: GnomonConfig): Pool {
  const pool: Pool = { files: [], commands: new Map(), reads: new Map(), declined: new Map(), stops: new Map(), skillUse: new Map(), records: 0 };
  const dir = resolveAudit(config).dir;
  if (!existsSync(dir)) return pool;
  pool.files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const f of pool.files) {
    const records: AuditRecord[] = readRecords(join(dir, f));
    pool.records += records.length;
    let reads = 0;
    for (const r of records) {
      const seq = typeof r.seq === "number" ? r.seq : 0;
      const p = ptr(f, seq);
      if (r.kind === "tool_call" && typeof r.target === "string") {
        if (r.tool === "bash" && r.bucket === "result" && r.code === 0) {
          const c = normalizeMinedCommand(r.target);
          if (c && BUILD_TEST.test(c)) bucket(pool.commands, c, () => ({ trails: new Set(), ptrs: [] }), f, p);
        }
        if (r.tool === "read" && reads < 6 && r.bucket === "result") {
          reads += 1;
          const path = r.target.replace(/\\/g, "/").replace(/^\.\//, "");
          if (path && path.length <= MAX_PATH && !path.startsWith("/") && !path.includes("..") && !path.startsWith(".gnomon") && /^[\w./@+-]+$/.test(path)) {
            bucket(pool.reads, path, () => ({ trails: new Set(), ptrs: [] }), f, p);
          }
        }
      } else if (r.kind === "verify" && typeof r.command === "string" && r.ok === false) {
        bucket(pool.stops, "verify_failed", () => ({ trails: new Set(), ptrs: [] }), f, p);
      } else if (r.kind === "approval" && r.decision === "declined" && typeof r.by === "string" && r.by.startsWith("human") && typeof r.summary === "string") {
        const summary = r.summary.replace(/\s+/g, " ").trim().slice(0, 100);
        const tool = typeof r.tool === "string" ? r.tool : "";
        const key = `${tool}\0${summary}`;
        let g = pool.declined.get(key);
        if (!g) {
          g = { tool, summary, trails: new Set(), ptrs: [] };
          pool.declined.set(key, g);
        }
        g.trails.add(f);
        if (g.ptrs.length < MAX_POINTERS && !g.ptrs.some((x) => x.trail === p.trail)) g.ptrs.push(p);
      } else if (r.kind === "turn" && typeof r.stop_reason === "string" && r.stop_reason in FAILURE_CLASSES) {
        bucket(pool.stops, r.stop_reason, () => ({ trails: new Set(), ptrs: [] }), f, p);
      } else if (r.kind === "skill_use") {
        for (const fired of Array.isArray(r.fired) ? (r.fired as Array<{ name?: unknown }>) : []) {
          if (typeof fired?.name !== "string") continue;
          const list = pool.skillUse.get(fired.name) ?? [];
          if (list.length < MAX_POINTERS && !list.some((x) => x.trail === p.trail)) list.push(p);
          pool.skillUse.set(fired.name, list);
        }
      }
    }
    // Layer-tagged attribution (failure_attribution.ts): a session with a failure signal whose primary cause is
    // one of the classes above. Only a primary cause counts, so one failure is mined into one class.
    const att = attributeTrail(records as unknown as Array<Record<string, unknown>>);
    if (att && ATTRIBUTED_CLASSES[att.tag]) {
      const turn = [...records].reverse().find((r) => r.kind === "turn");
      bucket(pool.stops, att.tag, () => ({ trails: new Set(), ptrs: [] }), f, ptr(f, typeof turn?.seq === "number" ? turn.seq : 0));
    }
  }
  return pool;
}

const byKey = <T>(a: [string, T], b: [string, T]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** A regex for a skill's `match`: the literal head of a mined pattern, escaped. Absent when nothing literal is left. */
export function matchFor(pattern: string): string | undefined {
  const lit = pattern.replace(/\*+/g, " ").trim().split(/\s+/).filter((t) => /[A-Za-z0-9]{2,}/.test(t)).slice(0, 2);
  if (lit.length === 0) return undefined;
  return lit.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/** The note section `improve` keeps in `system.md`: its heading, so an edit appends to one place. */
export const NOTES_HEADING = "## Notes from `gnomon improve`";

/** `system.md` with `note` added as a bullet under NOTES_HEADING (created at the end when absent). */
export function withNote(before: string, note: string): string {
  const bullet = `- ${note.trim()}`;
  if (before.includes(bullet)) return before;
  const base = before.endsWith("\n") || before === "" ? before : `${before}\n`;
  if (!before.includes(NOTES_HEADING)) return `${base}\n${NOTES_HEADING}\n\n${bullet}\n`;
  // Append the bullet after the last line of the existing section.
  const at = base.indexOf(NOTES_HEADING);
  const rest = base.slice(at + NOTES_HEADING.length);
  const next = rest.search(/\n#{1,6} /);
  const end = next === -1 ? base.length : at + NOTES_HEADING.length + next + 1;
  const head = base.slice(0, end).replace(/\n*$/, "\n");
  return `${head}${bullet}\n${base.slice(end)}`;
}

/** Mine the trails and the surface for candidates. Pure over the files; no model, no write. */
export function mineAll(config: GnomonConfig, families: readonly MineFamily[] = MINE_FAMILIES): MineResult {
  const out: MinedCandidate[] = [];
  const notes: string[] = [];
  const dir = resolveAudit(config).dir;
  if (!existsSync(dir)) {
    return { candidates: [], notes: [`no audit trails at ${dir}: nothing to mine until sessions have run with [audit] enabled`], trails: 0, records: 0 };
  }
  const pool = scanTrails(config);
  if (pool.files.length === 0) notes.push("the audit directory has no trails");

  if (families.includes("skill")) {
    for (const c of mineCandidates(config)) {
      const roles = c.role ? [c.role] : undefined;
      out.push({
        family: "skill",
        signal: c.signal,
        signature: `skill:${c.id}`,
        title: `${c.rule} boundary`,
        counts: { count: c.count, sessions: c.sessions, rule: c.rule, pattern: c.pattern },
        evidence: c.records.slice(0, MAX_POINTERS).map((r) => ptr(r.trail, r.seq)),
        facts: [`the ${c.rule} rule refused the ${c.role || "any"} role ${c.count} times across ${c.sessions} sessions`, `what was refused: ${c.pattern}`, `tools: ${c.tools.join(", ") || "?"}`],
        template: {
          name: `${c.rule.replace(/_/g, " ")} boundary`,
          description: `Applies when work touches ${c.pattern}, which the ${c.rule} rule refuses.`,
          body: `This repository's ${c.rule.replace(/_/g, " ")} rule refuses ${c.pattern} for ${c.role ? `the ${c.role} role` : "a role"}. Do not retry it: use an allowed route instead, because the rule refuses every attempt and a retry costs a step.`,
          ...(matchFor(c.pattern) ? { match: matchFor(c.pattern) } : {}),
          ...(roles ? { roles } : {}),
        },
      });
    }
  }

  if (families.includes("retire")) {
    const active = new Map(loadSkills(config).map((s) => [s.id, s]));
    for (const hit of skillUsageSignals(readSkillUsage(config))) {
      if (hit.signal !== "fires_never_cited" || !active.has(hit.skill)) continue;
      out.push({
        family: "retire",
        signal: hit.signal,
        signature: `retire:${hit.skill}`,
        title: `Retire skill ${hit.skill}`,
        counts: { firings: hit.firings, cited: hit.cited, ...(hit.tokens_per_firing !== null ? { tokens_per_firing: hit.tokens_per_firing } : {}) },
        evidence: (pool.skillUse.get(hit.skill) ?? []).slice(0, MAX_POINTERS),
        facts: [hit.suggestion],
        target: hit.skill,
        note: hit.suggestion,
      });
    }
  }

  if (families.includes("memory")) {
    const known = [...loadMemory(config).map((m) => m.body), readIf(join(config.gnomonDir, "system.md")), String((config.policy as { verify?: { command?: unknown } } | undefined)?.verify?.command ?? "")].join("\n");
    for (const [cmd, g] of [...pool.commands].sort(byKey)) {
      if (g.trails.size < MIN_REPEATS || known.includes(cmd)) continue;
      out.push({
        family: "memory",
        signal: "build_command",
        signature: `memory:cmd:${slug(cmd, 60)}`,
        title: `Command: ${cmd.slice(0, 50)}`,
        counts: { sessions: g.trails.size, command: cmd },
        evidence: g.ptrs,
        facts: [`\`${cmd}\` exited 0 in ${g.trails.size} sessions`],
        template: {
          name: `${cmd.split(" ")[0]} command`,
          description: `The command sessions run for ${cmd.split(" ").slice(0, 2).join(" ")}.`,
          body: `Run \`${cmd}\` for this. It is the command sessions on this repository use and it succeeds.`,
        },
      });
    }
    const startup = [...pool.reads].filter(([, g]) => g.trails.size >= MIN_REPEATS).sort((a, b) => b[1].trails.size - a[1].trails.size || byKey(a, b));
    if (startup.length > 0) {
      const top = startup.slice(0, 5);
      const sig = `memory:start:${top.map(([p]) => slug(p, 20)).join("+")}`.slice(0, 120);
      const list = top.map(([p]) => p);
      if (!list.every((p) => known.includes(p))) {
        out.push({
          family: "memory",
          signal: "startup_reads",
          signature: sig,
          title: "Files sessions open first",
          counts: { files: list.length, sessions: top[0]![1].trails.size },
          evidence: top.flatMap(([, g]) => g.ptrs.slice(0, 1)).slice(0, MAX_POINTERS),
          facts: [`these files were among the first reads in ${MIN_REPEATS}+ sessions: ${list.join(", ")}`],
          template: {
            name: "start here",
            description: "The files sessions on this repository open first.",
            body: `Sessions on this repository open these first: ${list.map((p) => `\`${p}\``).join(", ")}. Read them before searching.`,
          },
        });
      }
    }
    for (const [, g] of [...pool.declined].sort(byKey)) {
      if (g.trails.size < MIN_REPEATS) continue;
      out.push({
        family: "memory",
        signal: "declined_approval",
        signature: `memory:declined:${slug(`${g.tool}-${g.summary}`, 60)}`,
        title: `Declined: ${g.tool}`,
        counts: { sessions: g.trails.size, tool: g.tool },
        evidence: g.ptrs,
        facts: [`the operator declined \`${g.summary}\` (${g.tool}) in ${g.trails.size} sessions`],
        template: {
          name: `${g.tool} approval declined`,
          description: `The operator declines this kind of ${g.tool} call.`,
          body: `The operator has declined \`${g.summary}\` in several sessions. Do not ask for it again: choose another route, because it will be declined.`,
        },
      });
    }
  }

  if (families.includes("harness")) {
    const sys = readIf(join(config.gnomonDir, "system.md"));
    for (const [cls, g] of [...pool.stops].sort(byKey)) {
      const def = FAILURE_CLASSES[cls];
      if (!def || g.trails.size < MIN_REPEATS || sys.includes(def.note)) continue;
      out.push({
        family: "harness",
        signal: cls,
        signature: `harness:${cls}`,
        title: `System note: ${def.name}`,
        counts: { sessions: g.trails.size, class: cls, ...(def.layer ? { layer: def.layer } : {}) },
        evidence: g.ptrs,
        facts: [`${def.description} (${g.trails.size} sessions)`, ...(def.layer ? [`failure layer: ${def.layer}`] : []), ...(def.suggest ? [def.suggest] : [])],
        note: def.note,
        template: { name: def.name, description: def.description, body: def.note },
      });
    }
  }

  return { candidates: out, notes, trails: pool.files.length, records: pool.records };
}

function readIf(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, "utf-8") : "";
  } catch {
    return "";
  }
}

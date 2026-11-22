/**
 * gnomon-core: Skill attribution
 *
 * What a turn did with the skills it was given, read off what the harness
 * already sees: which skills the match rule loaded and what each cost in
 * context, which skill files the model opened, which it named in its
 * reasoning, and which it proposed. Nothing here is requested from the model
 * and nothing is injected into its prompt: a skill the reasoning never names
 * stays visibly unattributed, which is the honest reading (docs/design/
 * SKILL-ATTRIBUTION.md). Matching and injection order are untouched.
 */

import type { Skill } from "./skills.js";

/** `counters.skills` and the body of a `skill_use` audit record (CONTRACTS section 52). */
export interface SkillCounters {
  v: 1;
  /** Skills the match rule loaded into the prompt, with the estimated context each cost */
  fired: Array<{ name: string; tokens: number }>;
  /** Skill files the model opened with `read`, by id, with how many times */
  read: Record<string, number>;
  /** Skills whose id or name appears in the turn's reasoning (derived, never requested) */
  cited_in_reasoning: string[];
  /** Skills the model proposed with the `skill` tool this turn, by id */
  proposed: string[];
}

/**
 * Words too common to show a skill was meant. A name made only of these
 * ("testing", "build notes") appears in nearly any reasoning, so it would
 * cite itself.
 */
export const GENERIC_SKILL_WORDS: ReadonlySet<string> = new Set([
  "test", "tests", "testing", "build", "builds", "code", "coding", "notes", "note",
  "style", "rules", "rule", "general", "project", "repo", "repository", "skill",
  "skills", "guide", "docs", "doc", "default", "common", "basics", "basic", "tips",
  "misc", "workflow", "process", "practice", "practices", "conventions", "convention",
  "this", "that", "with", "from", "into", "when", "then", "work", "make", "file", "files",
]);

/** The shortest name that can be cited: shorter ones match ordinary words. */
export const MIN_CITE_LENGTH = 4;

function citable(term: string): boolean {
  const t = term.trim();
  if (t.length < MIN_CITE_LENGTH) return false;
  const words = t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 0 && !words.every((w) => GENERIC_SKILL_WORDS.has(w));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The ids among `skills` whose id or name the reasoning mentions.
 *
 * Whole-word and case-insensitive: `deploy` is not in "deployment". A hyphen
 * or underscore in a name also matches a space ("writing tests" for
 * `writing-tests`).
 */
export function citedSkills(reasoning: string, skills: Array<Pick<Skill, "id" | "name">>): string[] {
  if (!reasoning) return [];
  const out: string[] = [];
  for (const sk of skills) {
    const terms = new Set<string>();
    for (const t of [sk.id, sk.name]) {
      if (!citable(t)) continue;
      terms.add(t);
      terms.add(t.replace(/[-_]+/g, " "));
    }
    const hit = [...terms].some((t) =>
      new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(t)}(?![A-Za-z0-9_-])`, "i").test(reasoning)
    );
    if (hit) out.push(sk.id);
  }
  return out;
}

/** One turn's skill activity, accumulated as the turn runs. */
export class SkillUse {
  private fired = new Map<string, { name: string; tokens: number }>();
  private read = new Map<string, number>();
  private cited = new Set<string>();
  private proposed = new Set<string>();

  constructor(
    firedSkills: Array<{ id: string; tokens: number }>,
    /** Skills the reasoning may be matched against: the fired ones, and any the model opens */
    private readonly known: Array<Pick<Skill, "id" | "name">>
  ) {
    for (const f of firedSkills) this.fired.set(f.id, { name: f.id, tokens: f.tokens });
  }

  noteRead(id: string): void {
    this.read.set(id, (this.read.get(id) ?? 0) + 1);
  }

  noteProposed(id: string): void {
    this.proposed.add(id);
  }

  /** Skills the reasoning names, remembered. Returns this text's hits for the trace. */
  noteReasoning(text: string): string[] {
    const universe = new Map<string, Pick<Skill, "id" | "name">>(this.known.map((s) => [s.id, s]));
    for (const id of this.read.keys()) if (!universe.has(id)) universe.set(id, { id, name: id });
    const hits = citedSkills(
      text,
      [...universe.values()].filter((s) => this.fired.has(s.id) || this.read.has(s.id))
    );
    for (const h of hits) this.cited.add(h);
    return hits;
  }

  /** A delegated sub-turn's skills count toward the turn that delegated. */
  absorb(sub: SkillCounters | undefined): void {
    if (!sub) return;
    for (const f of sub.fired) if (!this.fired.has(f.name)) this.fired.set(f.name, { ...f });
    for (const [id, n] of Object.entries(sub.read)) this.read.set(id, (this.read.get(id) ?? 0) + n);
    for (const c of sub.cited_in_reasoning) this.cited.add(c);
    for (const p of sub.proposed) this.proposed.add(p);
  }

  /** Absent when no skill fired, was opened or was proposed. */
  counters(): SkillCounters | undefined {
    if (this.fired.size === 0 && this.read.size === 0 && this.proposed.size === 0) return undefined;
    const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return {
      v: 1,
      fired: [...this.fired.values()].map((f) => ({ ...f })),
      read: Object.fromEntries([...Object.entries(Object.fromEntries(this.read))].sort(([a], [b]) => order(a, b))),
      cited_in_reasoning: [...this.cited].sort(order),
      proposed: [...this.proposed].sort(order),
    };
  }
}

/**
 * The end-of-turn line: `skills used: writing-tests (loaded ~420 tok, read 1x,
 * cited) · proposed: x`. Plain text; the caller paints and fits it.
 */
export function skillsUsedText(c: SkillCounters): string {
  const ids = new Set<string>([...c.fired.map((f) => f.name), ...Object.keys(c.read), ...c.cited_in_reasoning]);
  const parts = [...ids].map((id) => {
    const f = c.fired.find((x) => x.name === id);
    const bits = [
      ...(f ? [`loaded ~${f.tokens} tok`] : []),
      ...(c.read[id] ? [`read ${c.read[id]}×`] : []),
      ...(c.cited_in_reasoning.includes(id) ? ["cited"] : []),
    ];
    return `${id} (${bits.join(", ")})`;
  });
  const used = parts.length > 0 ? `skills used: ${parts.join(", ")}` : "skills";
  return c.proposed.length > 0 ? `${used} · proposed: ${c.proposed.join(", ")}` : used;
}

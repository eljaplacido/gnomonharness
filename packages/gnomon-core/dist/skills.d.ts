/**
 * gnomon-core: Skills
 *
 * A skill is a note the harness has learned about this repository, kept as a
 * file in `.gnomon/skills/`. Skills whose pattern matches the turn are added
 * to the system prompt, so knowledge accumulates without being re-derived.
 *
 * The determinism problem, and how it is resolved
 * ----------------------------------------------
 * `.gnomon/` is content-hashed, and the harness's central claim is that the
 * same surface plus the same prompt yields the same outcome. An agent that
 * rewrote its own skills mid-session would break that claim: the hash would
 * change underneath the run that changed it.
 *
 * So authorship is a proposal, never a self-application. A role with the
 * `skill` tool writes to `.gnomon/skills/proposed/`, which is NOT loaded.
 * A human accepts it (`gnomon skill accept <name>`), which moves it into
 * `.gnomon/skills/`, changes the surface hash deliberately, and takes effect
 * on the next session. Learning stays reviewable and the hash stays honest.
 */
import { GnomonConfig } from "./config.js";
export interface Skill {
    /** Filename stem — the identity used by accept/reject */
    id: string;
    name: string;
    description?: string;
    /** Case-insensitive pattern; absent means "always applies" */
    match?: string;
    /** Roles this applies to; absent means all */
    roles?: string[];
    /** The instruction body */
    body: string;
    /** Whether this came from skills/ (active) or skills/proposed/ */
    proposed: boolean;
}
export declare const SKILLS_DIR = "skills";
export declare const PROPOSED_DIR: string;
/**
 * Parse a skill file: TOML front matter between `+++` fences, then markdown.
 *
 * A file without front matter is still a skill — it just always applies. That
 * keeps the cheapest possible note (drop a .md in the directory) valid.
 */
export declare function parseSkill(id: string, raw: string, proposed: boolean): Skill;
/** Render a skill back to file form. */
export declare function renderSkill(skill: Omit<Skill, "id" | "proposed">): string;
/** Active skills — `.gnomon/skills/*.md`. Proposals are excluded by design. */
export declare function loadSkills(config: GnomonConfig): Skill[];
/** Pending proposals — written by an agent, not yet accepted. */
export declare function loadProposedSkills(config: GnomonConfig): Skill[];
/**
 * The skills that apply to one turn.
 *
 * A skill with no `match` always applies; one with an unparseable pattern is
 * skipped rather than throwing, so a malformed note cannot break every turn.
 *
 * That catch stays — one bad note must not break every turn — but it was the
 * ONLY thing that ever happened to a broken pattern. `return false` on every
 * turn is indistinguishable from a pattern that simply never matches, so a
 * skill accepted into the surface, hashed, and listed by `gnomon skill list`
 * could be inert for its whole life with nothing anywhere saying so. The same
 * silence covers `roles = ["implementer"]` when the role is spelled
 * "implementor": the filter on the line above drops it and says nothing.
 *
 * auditSurface (config.ts) now iterates loadSkills and reports both, plus a
 * control character anywhere in the file — it runs before the first turn, which
 * is the only moment an operator is in a position to fix the file. Refusing
 * here instead would trade a lost note for a dead session; that is the wrong
 * trade, so the catch below is unchanged on purpose.
 */
export declare function selectSkills(skills: Skill[], role: string, input: string): Skill[];
/**
 * Append the applicable skills to the system prompt.
 *
 * Marked as learned notes rather than presented as core rules: a skill is
 * something this repository observed, and it should not be able to quietly
 * outrank system.md.
 */
/**
 * State the working invariant the model otherwise has to guess.
 *
 * Without it a session watched a model invent `/repo`, run `find /repo`, get
 * exit 2, and spend three tool calls rediscovering where it was. The wording
 * is deliberately path-free: an absolute path would make the prompt differ
 * between machines, which is the thing this harness exists to avoid.
 */
export declare const WORKING_CONTEXT: string;
export declare function withWorkingContext(systemPrompt: string): string;
export declare function applySkills(systemPrompt: string, skills: Skill[]): string;
export interface SkillProposal {
    name: string;
    description?: string;
    match?: string;
    roles?: string[];
    body: string;
}
/** Filenames are derived, never taken from the model. */
export declare function skillId(name: string): string;
/**
 * Write a proposal into `.gnomon/skills/proposed/`.
 *
 * The path is derived from the name, so a proposal cannot be aimed at
 * `../../system.md` or at an existing active skill. This is the whole reason
 * authorship is safe to grant.
 */
export declare function proposeSkill(config: GnomonConfig, proposal: SkillProposal): {
    id: string;
    path: string;
    existed: boolean;
};
/**
 * Accept a proposal: move it into `.gnomon/skills/`.
 *
 * This changes the surface hash on purpose. It is a human action, and it takes
 * effect on the next session rather than the running one.
 */
export declare function acceptSkill(config: GnomonConfig, id: string): string;
/** Discard a proposal. Active skills are never removed by this. */
export declare function rejectSkill(config: GnomonConfig, id: string): void;
//# sourceMappingURL=skills.d.ts.map
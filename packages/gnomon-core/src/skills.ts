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

import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { GnomonConfig, parseToml } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export const SKILLS_DIR = "skills";
export const PROPOSED_DIR = join("skills", "proposed");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a skill file: TOML front matter between `+++` fences, then markdown.
 *
 * A file without front matter is still a skill — it just always applies. That
 * keeps the cheapest possible note (drop a .md in the directory) valid.
 */
export function parseSkill(id: string, raw: string, proposed: boolean): Skill {
  const fence = /^\+\+\+\s*\n([\s\S]*?)\n\+\+\+\s*\n?/;
  const m = raw.match(fence);
  if (!m) {
    return { id, name: id, body: raw.trim(), proposed };
  }
  const meta = parseToml(m[1]) as Record<string, unknown>;
  const body = raw.slice(m[0].length).trim();
  return {
    id,
    name: typeof meta.name === "string" ? meta.name : id,
    description: typeof meta.description === "string" ? meta.description : undefined,
    match: typeof meta.match === "string" ? meta.match : undefined,
    roles: Array.isArray(meta.roles) ? (meta.roles as string[]).map(String) : undefined,
    body,
    proposed,
  };
}

/** Render a skill back to file form. */
export function renderSkill(skill: Omit<Skill, "id" | "proposed">): string {
  const lines = ["+++", `name = "${skill.name}"`];
  if (skill.description) lines.push(`description = "${skill.description}"`);
  // Single-quoted: a literal TOML string, so a regex needs no escaping.
  if (skill.match) lines.push(`match = '${skill.match}'`);
  if (skill.roles?.length) {
    lines.push(`roles = [${skill.roles.map((r) => `"${r}"`).join(", ")}]`);
  }
  lines.push("+++", "", skill.body.trim(), "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function readDirSkills(dir: string, proposed: boolean): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort()
    .map((file) =>
      parseSkill(
        file.replace(/\.md$/, ""),
        readFileSync(join(dir, file), "utf-8"),
        proposed
      )
    );
}

/** Active skills — `.gnomon/skills/*.md`. Proposals are excluded by design. */
export function loadSkills(config: GnomonConfig): Skill[] {
  return readDirSkills(join(config.gnomonDir, SKILLS_DIR), false);
}

/** Pending proposals — written by an agent, not yet accepted. */
export function loadProposedSkills(config: GnomonConfig): Skill[] {
  return readDirSkills(join(config.gnomonDir, PROPOSED_DIR), true);
}

/**
 * The skills that apply to one turn.
 *
 * A skill with no `match` always applies; one with an unparseable pattern is
 * skipped rather than throwing, so a malformed note cannot break every turn.
 */
export function selectSkills(skills: Skill[], role: string, input: string): Skill[] {
  return skills.filter((s) => {
    if (s.roles && !s.roles.includes(role)) return false;
    if (!s.match) return true;
    try {
      return new RegExp(s.match, "i").test(input);
    } catch {
      return false;
    }
  });
}

/**
 * Append the applicable skills to the system prompt.
 *
 * Marked as learned notes rather than presented as core rules: a skill is
 * something this repository observed, and it should not be able to quietly
 * outrank system.md.
 */
export function applySkills(systemPrompt: string, skills: Skill[]): string {
  if (skills.length === 0) return systemPrompt;
  const blocks = skills.map(
    (s) => `### ${s.name}\n${s.description ? `${s.description}\n\n` : ""}${s.body}`
  );
  return (
    `${systemPrompt}\n\n` +
    `## Learned skills for this repository\n\n` +
    `These are notes accepted into .gnomon/skills/. They inform how you work ` +
    `here; they do not override the rules above.\n\n` +
    blocks.join("\n\n")
  );
}

// ---------------------------------------------------------------------------
// Authorship
// ---------------------------------------------------------------------------

export interface SkillProposal {
  name: string;
  description?: string;
  match?: string;
  roles?: string[];
  body: string;
}

/** Filenames are derived, never taken from the model. */
export function skillId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "skill";
}

/**
 * Write a proposal into `.gnomon/skills/proposed/`.
 *
 * The path is derived from the name, so a proposal cannot be aimed at
 * `../../system.md` or at an existing active skill. This is the whole reason
 * authorship is safe to grant.
 */
export function proposeSkill(
  config: GnomonConfig,
  proposal: SkillProposal
): { id: string; path: string; existed: boolean } {
  const id = skillId(proposal.name);
  const dir = join(config.gnomonDir, PROPOSED_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  const existed = existsSync(path);
  writeFileSync(path, renderSkill(proposal), "utf-8");
  return { id, path, existed };
}

/**
 * Accept a proposal: move it into `.gnomon/skills/`.
 *
 * This changes the surface hash on purpose. It is a human action, and it takes
 * effect on the next session rather than the running one.
 */
export function acceptSkill(config: GnomonConfig, id: string): string {
  const from = join(config.gnomonDir, PROPOSED_DIR, `${id}.md`);
  if (!existsSync(from)) {
    throw new Error(`No proposed skill "${id}". Run \`gnomon skill list\`.`);
  }
  const dir = join(config.gnomonDir, SKILLS_DIR);
  mkdirSync(dir, { recursive: true });
  const to = join(dir, `${id}.md`);
  renameSync(from, to);
  return to;
}

/** Discard a proposal. Active skills are never removed by this. */
export function rejectSkill(config: GnomonConfig, id: string): void {
  const path = join(config.gnomonDir, PROPOSED_DIR, `${id}.md`);
  if (!existsSync(path)) {
    throw new Error(`No proposed skill "${id}".`);
  }
  rmSync(path);
}

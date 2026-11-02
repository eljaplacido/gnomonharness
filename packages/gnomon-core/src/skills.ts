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
import { createHash, randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { GnomonConfig, parseToml, recomputeManifest } from "./config.js";
import { AuditTrail, resolveAudit, type AuditRecord } from "./audit.js";
import { harnessBuild } from "./build.js";

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
  /**
   * Why this file is not the skill its author meant to write.
   *
   * Set only when the file parses but the result is not what the text says —
   * today, YAML front matter. Never a reason to drop the skill: it is reported
   * beside it, because a skill that vanishes is harder to debug than one that
   * says what is wrong with it.
   */
  problem?: string;
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
    // YAML front matter, caught rather than swallowed.
    //
    // "No front matter" and "front matter this parser does not read" are not
    // the same file, and treating them the same is silent. A `---` skill got
    // name = the filename, NO description, NO match — so it applied to every
    // turn — and its own front matter went into the model's prompt as
    // instruction text, because the body was the whole file.
    //
    // The mistake is likely, not hypothetical: `---` is the dominant
    // convention, and THIS repository ships both — .claude/skills/ uses YAML,
    // .gnomon/skills/ uses TOML. Someone copying the shape they just read
    // writes this file.
    const yaml = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw);
    if (yaml) {
      return {
        id,
        name: id,
        // Strip it regardless: whatever else is true, `---\nname: …\n---` is
        // not instruction text and must not reach the prompt.
        body: raw.slice(yaml[0].length).trim(),
        proposed,
        problem:
          "front matter is YAML (--- fences); gnomon skills use TOML (+++ fences). " +
          "Its name, description and match were NOT read, so this skill applies to " +
          "every turn. Change the fences to +++ and the `key: value` lines to " +
          '`key = "value"`.',
      };
    }
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
/**
 * The skills this ROLE may use, whatever the turn is about.
 *
 * The role filter and the `match` filter answer different questions, and
 * collapsing them loses one. `roles` says a skill is not for this role at all;
 * `match` says it did not come up this time. Only the second is worth telling
 * the model about, which is what makes this split useful rather than cosmetic.
 */
export function roleSkills(skills: Skill[], role: string): Skill[] {
  return skills.filter((s) => !s.roles || s.roles.includes(role));
}

export function selectSkills(skills: Skill[], role: string, input: string): Skill[] {
  return skills.filter((s) => {
    if (s.roles && !s.roles.includes(role)) return false;
    if (!s.match) return true;
    try {
      return new RegExp(s.match, "i").test(input);
    } catch {
      // Reported by auditSurface at startup, not swallowed silently.
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
/**
 * State the working invariant the model otherwise has to guess.
 *
 * Without it a session watched a model invent `/repo`, run `find /repo`, get
 * exit 2, and spend three tool calls rediscovering where it was. The wording
 * is deliberately path-free: an absolute path would make the prompt differ
 * between machines, which is the thing this harness exists to avoid.
 */
export const WORKING_CONTEXT =
  "## Working context\n\n" +
  "You are operating inside a single repository. Every tool path is resolved " +
  "relative to its root, and paths outside it are refused — so use relative " +
  "paths like `src/main.rs` or `.` and never guess an absolute one. `read` on " +
  "a directory lists it; start there rather than shelling out to find.";

export function withWorkingContext(systemPrompt: string): string {
  return `${systemPrompt}\n\n${WORKING_CONTEXT}`;
}

export function applySkills(
  systemPrompt: string,
  skills: Skill[],
  /**
   * Skills this role may use whose `match` did not fire on this input. Listed
   * by name and path, never by body.
   *
   * Without this the model cannot know they exist. A skill whose pattern is
   * slightly wrong is then indistinguishable from a skill nobody wrote — it
   * sits in the surface, hashed and inert, and the one thing that would fix it
   * (someone noticing) never happens. Naming them costs a line each and is
   * still derived from the surface plus the role, so the same checkout
   * produces the same list on every machine.
   */
  dormant: Skill[] = [],
  /** Where those files live, relative to the root, for the model to `read`. */
  dirRel = ".gnomon/skills"
): string {
  let out = systemPrompt;
  if (skills.length > 0) {
    const blocks = skills.map(
      (s) => `### ${s.name}\n${s.description ? `${s.description}\n\n` : ""}${s.body}`
    );
    out +=
      `\n\n## Learned skills for this repository\n\n` +
      `These are notes accepted into .gnomon/skills/. They inform how you work ` +
      `here; they do not override the rules above.\n\n` +
      blocks.join("\n\n");
  }
  if (dormant.length > 0) {
    const lines = dormant.map(
      (s) => `- \`${dirRel}/${s.id}.md\` — ${s.name}${s.description ? `: ${s.description}` : ""}`
    );
    out +=
      `\n\n## Other notes available here, not loaded\n\n` +
      `These exist for your role but did not match this request, so only their ` +
      `names are above. If one looks relevant, \`read\` the file — do not act on ` +
      `the description alone, because it is a label and not the note.\n\n` +
      lines.join("\n");
  }
  return out;
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

// ---------------------------------------------------------------------------
// Decisions: accept and reject, each with its own audit record
// ---------------------------------------------------------------------------

/**
 * Who made a skill decision, and anything they said about it.
 *
 * `by` is "human" from the CLI: `gnomon skill accept` is a person at a
 * terminal or in a script, and no model holds a tool that reaches this code.
 * `user` and `host` are what the process can see; they identify, they do not
 * authenticate.
 */
export interface SkillDecisionOptions {
  by?: string;
  /** Why a proposal was rejected. Recorded as given. */
  reason?: string;
  /** Whether a terminal was attached. Defaults to stdin's TTY state. */
  interactive?: boolean;
}

export interface SkillDecision {
  /** Where the skill file is now (accept), or where it was (reject). */
  path: string;
  /** The `skill_accept` / `skill_reject` record, with its hash. */
  record: AuditRecord | null;
  /** The trail it was written to. */
  trail: string | null;
}

/** sha256 of a skill file's bytes: the identity a trial and an accept agree on. */
export function skillContentHash(raw: string | Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

function whoDecided(opts: SkillDecisionOptions): Record<string, unknown> {
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (a container with an arbitrary uid). The variable is the
    // next best thing, and absent is better than invented.
    user = process.env.USER ?? process.env.USERNAME;
  }
  return {
    by: opts.by ?? "human",
    user,
    host: hostname(),
    interactive: opts.interactive ?? Boolean(process.stdin.isTTY),
  };
}

/**
 * Append one skill decision to gnomon's own trail, as a sealed three-record
 * trail of its own (session_start, the decision, session_end).
 *
 * Written even when the surface has `[audit] enabled = false`, for the reason
 * `gnomon check` writes its verdict regardless (check.ts, appendVerdict). The
 * flag governs what a SESSION records: turns, tool calls and possibly prompt
 * text. An accept is none of that. It is the one moment a person changes what
 * the agent is, it holds no model text, and before this it left nothing behind
 * but a moved file: the trail showed the surface hash change, never that a
 * person accepted a named skill, or what its content was. Chaining is forced
 * on because the record's hash is what a later reader cites.
 */
function appendSkillDecision(
  config: GnomonConfig,
  kind: "skill_accept" | "skill_reject",
  fields: Record<string, unknown>,
  surfaceHash: string
): { record: AuditRecord | null; trail: string | null } {
  const settings = resolveAudit(config);
  const forced = { ...settings, enabled: true, chain: true };
  // A random suffix as well as the time and pid: two decisions in one process
  // inside one millisecond (a script accepting several proposals) would
  // otherwise name the same file, and the second trail would restart at seq
  // 0 on top of the first, a chain that no longer verifies.
  const id = `skill-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const trail = new AuditTrail(forced, id);
  trail.write("session_start", {
    surface_hash: surfaceHash,
    harness: harnessBuild(),
    cwd: process.cwd(),
    mode: "skill",
  });
  const record = trail.write(kind, fields);
  trail.write("session_end", {});
  return { record, trail: trail.path };
}

/**
 * Accept a proposal: move it into `.gnomon/skills/`, and record that it
 * happened.
 *
 * This changes the surface hash on purpose. It is a human action, and it takes
 * effect on the next session rather than the running one.
 *
 * The `skill_accept` record carries the skill's content hash and the surface
 * hash before and after, so the trail names the person's act and not only its
 * effect. An accept whose record cannot be written is undone: a change to the
 * agent that nobody can later show was made on purpose is the thing this
 * record exists to prevent.
 */
export function acceptSkill(
  config: GnomonConfig,
  id: string,
  opts: SkillDecisionOptions = {}
): SkillDecision {
  const from = join(config.gnomonDir, PROPOSED_DIR, `${id}.md`);
  if (!existsSync(from)) {
    throw new Error(`No proposed skill "${id}". Run \`gnomon skill list\`.`);
  }
  const raw = readFileSync(from);
  const skill = parseSkill(id, raw.toString("utf-8"), true);
  const before = recomputeManifest(config.gnomonDir).surface_hash;
  const dir = join(config.gnomonDir, SKILLS_DIR);
  mkdirSync(dir, { recursive: true });
  const to = join(dir, `${id}.md`);
  renameSync(from, to);
  const after = recomputeManifest(config.gnomonDir).surface_hash;
  try {
    const { record, trail } = appendSkillDecision(
      config,
      "skill_accept",
      {
        skill: id,
        name: skill.name,
        path: `.gnomon/skills/${id}.md`,
        content_sha256: skillContentHash(raw),
        surface_hash_before: before,
        surface_hash_after: after,
        // A trial report's hash once `--evidence` exists. Until then the
        // record says plainly that the decision was made on reading alone.
        evidence: "none",
        ...whoDecided(opts),
      },
      after
    );
    return { path: to, record, trail };
  } catch (err) {
    renameSync(to, from);
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Not accepted: the skill_accept record could not be written (${why}).`);
  }
}

/**
 * Discard a proposal, and record that it happened. Active skills are never
 * removed by this.
 *
 * The record is written BEFORE the file is removed, so a reject that cannot
 * be recorded leaves the proposal where it was. The surface hash is the same
 * before and after -- proposals are not hashed -- and the record says so in
 * the same two fields an accept uses, so a reader needs one shape for both.
 */
export function rejectSkill(
  config: GnomonConfig,
  id: string,
  opts: SkillDecisionOptions = {}
): SkillDecision {
  const path = join(config.gnomonDir, PROPOSED_DIR, `${id}.md`);
  if (!existsSync(path)) {
    throw new Error(`No proposed skill "${id}".`);
  }
  const raw = readFileSync(path);
  const skill = parseSkill(id, raw.toString("utf-8"), true);
  const surface = recomputeManifest(config.gnomonDir).surface_hash;
  const { record, trail } = appendSkillDecision(
    config,
    "skill_reject",
    {
      skill: id,
      name: skill.name,
      path: `.gnomon/skills/proposed/${id}.md`,
      content_sha256: skillContentHash(raw),
      surface_hash_before: surface,
      surface_hash_after: surface,
      reason: opts.reason,
      ...whoDecided(opts),
    },
    surface
  );
  rmSync(path);
  return { path, record, trail };
}

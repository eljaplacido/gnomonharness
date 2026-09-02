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
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, } from "node:fs";
import { join } from "node:path";
import { parseToml } from "./config.js";
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
export function parseSkill(id, raw, proposed) {
    const fence = /^\+\+\+\s*\n([\s\S]*?)\n\+\+\+\s*\n?/;
    const m = raw.match(fence);
    if (!m) {
        return { id, name: id, body: raw.trim(), proposed };
    }
    const meta = parseToml(m[1]);
    const body = raw.slice(m[0].length).trim();
    return {
        id,
        name: typeof meta.name === "string" ? meta.name : id,
        description: typeof meta.description === "string" ? meta.description : undefined,
        match: typeof meta.match === "string" ? meta.match : undefined,
        roles: Array.isArray(meta.roles) ? meta.roles.map(String) : undefined,
        body,
        proposed,
    };
}
/** Render a skill back to file form. */
export function renderSkill(skill) {
    const lines = ["+++", `name = "${skill.name}"`];
    if (skill.description)
        lines.push(`description = "${skill.description}"`);
    // Single-quoted: a literal TOML string, so a regex needs no escaping.
    if (skill.match)
        lines.push(`match = '${skill.match}'`);
    if (skill.roles?.length) {
        lines.push(`roles = [${skill.roles.map((r) => `"${r}"`).join(", ")}]`);
    }
    lines.push("+++", "", skill.body.trim(), "");
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function readDirSkills(dir, proposed) {
    if (!existsSync(dir))
        return [];
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name)
        .sort()
        .map((file) => parseSkill(file.replace(/\.md$/, ""), readFileSync(join(dir, file), "utf-8"), proposed));
}
/** Active skills — `.gnomon/skills/*.md`. Proposals are excluded by design. */
export function loadSkills(config) {
    return readDirSkills(join(config.gnomonDir, SKILLS_DIR), false);
}
/** Pending proposals — written by an agent, not yet accepted. */
export function loadProposedSkills(config) {
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
export function selectSkills(skills, role, input) {
    return skills.filter((s) => {
        if (s.roles && !s.roles.includes(role))
            return false;
        if (!s.match)
            return true;
        try {
            return new RegExp(s.match, "i").test(input);
        }
        catch {
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
export const WORKING_CONTEXT = "## Working context\n\n" +
    "You are operating inside a single repository. Every tool path is resolved " +
    "relative to its root, and paths outside it are refused — so use relative " +
    "paths like `src/main.rs` or `.` and never guess an absolute one. `read` on " +
    "a directory lists it; start there rather than shelling out to find.";
export function withWorkingContext(systemPrompt) {
    return `${systemPrompt}\n\n${WORKING_CONTEXT}`;
}
export function applySkills(systemPrompt, skills) {
    if (skills.length === 0)
        return systemPrompt;
    const blocks = skills.map((s) => `### ${s.name}\n${s.description ? `${s.description}\n\n` : ""}${s.body}`);
    return (`${systemPrompt}\n\n` +
        `## Learned skills for this repository\n\n` +
        `These are notes accepted into .gnomon/skills/. They inform how you work ` +
        `here; they do not override the rules above.\n\n` +
        blocks.join("\n\n"));
}
/** Filenames are derived, never taken from the model. */
export function skillId(name) {
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
export function proposeSkill(config, proposal) {
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
export function acceptSkill(config, id) {
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
export function rejectSkill(config, id) {
    const path = join(config.gnomonDir, PROPOSED_DIR, `${id}.md`);
    if (!existsSync(path)) {
        throw new Error(`No proposed skill "${id}".`);
    }
    rmSync(path);
}
//# sourceMappingURL=skills.js.map
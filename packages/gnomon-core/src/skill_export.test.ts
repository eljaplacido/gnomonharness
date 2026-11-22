/**
 * gnomon-core: `gnomon skill export` — gnomon's skills in the shared Agent Skills layout
 * (SKILL.md with YAML name/description, https://agentskills.io/specification).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSkillName, exportSkills, renderSkillMd, SKILL_EXPORT_MARKER } from "./skill_export.js";
import { recomputeManifest } from "./config.js";
import { parseSkill } from "./skills.js";

let root: string;
const cfg = (): any => ({ gnomonDir: join(root, ".gnomon"), config: {}, policy: {} });
const skill = (id: string, text: string) => writeFileSync(join(root, ".gnomon", "skills", `${id}.md`), text);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-skill-export-"));
  mkdirSync(join(root, ".gnomon", "skills", "proposed"), { recursive: true });
  skill("git-branching", '+++\nname = "branching"\ndescription = "How work reaches the default branch"\nmatch = \'\\bgit\\b\'\nroles = ["implement"]\n+++\n\nNever commit to main.\n');
  skill("Plain Note", "Just a note, no front matter.\n");
  writeFileSync(join(root, ".gnomon", "skills", "proposed", "pending.md"), "not accepted\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const names = (r: ReturnType<typeof exportSkills>) => r.items.map((i) => `${i.name}:${i.action}`).sort();

describe("agentSkillName", () => {
  it("is lowercase letters, digits and single hyphens, at most 64, never leading or trailing a hyphen", () => {
    expect(agentSkillName("Git Branching_v2")).toBe("git-branching-v2");
    expect(agentSkillName("--a--b--")).toBe("a-b");
    expect(agentSkillName("x".repeat(80))).toHaveLength(64);
    expect(agentSkillName("ab-" + "x".repeat(70)).endsWith("-")).toBe(false);
    expect(agentSkillName("***")).toBe("");
  });
});

describe("renderSkillMd", () => {
  it("front matter carries name and description; a provenance comment carries the source and surface hash; the body is the skill's text", () => {
    const s = parseSkill("git-branching", readFileSync(join(root, ".gnomon/skills/git-branching.md"), "utf-8"), false);
    const text = renderSkillMd(s, "git-branching", "abc123");
    expect(text.startsWith('---\nname: git-branching\ndescription: "How work reaches the default branch"\n---\n')).toBe(true);
    expect(text).toContain(`<!-- ${SKILL_EXPORT_MARKER}: from .gnomon/skills/git-branching.md; surface abc123; gnomon roles: implement.`);
    expect(text.trimEnd().endsWith("Never commit to main.")).toBe(true);
    expect(text).not.toContain("+++");
  });

  it("quotes a description YAML would misread, and falls back to the skill name when there is none", () => {
    const s = parseSkill("q", '+++\nname = "n: a # b"\ndescription = "say \\"hi\\": yes # no"\n+++\nbody\n', false);
    expect(renderSkillMd(s, "q", "h")).toContain('description: "say \\"hi\\": yes # no"');
    expect(renderSkillMd({ ...s, description: undefined }, "q", "h")).toContain('description: "n: a # b"');
  });
});

describe("exportSkills", () => {
  it("is a dry run by default: it lists what it would write and writes nothing", () => {
    const r = exportSkills(cfg(), { project: root });
    expect(r.written).toBe(false);
    expect(names(r)).toEqual(["git-branching:create", "plain-note:create"]);
    expect(r.dir).toBe(join(root, ".claude", "skills"));
    expect(r.surface_hash).toBe(recomputeManifest(join(root, ".gnomon")).surface_hash);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  it("--write writes <name>/SKILL.md for each ACTIVE skill (proposals are not exported) and never touches .gnomon/", () => {
    const before = recomputeManifest(join(root, ".gnomon")).surface_hash;
    const r = exportSkills(cfg(), { project: root, write: true, to: "out/skills" });
    expect(names(r)).toEqual(["git-branching:create", "plain-note:create"]);
    expect(readdirSync(join(root, "out/skills")).sort()).toEqual(["git-branching", "plain-note"]);
    const md = readFileSync(join(root, "out/skills/git-branching/SKILL.md"), "utf-8");
    expect(md).toContain(`surface ${before}`);
    expect(existsSync(join(root, "out/skills/pending"))).toBe(false);
    expect(recomputeManifest(join(root, ".gnomon")).surface_hash).toBe(before);
  });

  it("a second run says unchanged", () => {
    exportSkills(cfg(), { project: root, write: true });
    expect(names(exportSkills(cfg(), { project: root, write: true }))).toEqual(["git-branching:unchanged", "plain-note:unchanged"]);
  });

  it("after the surface changes, the copies are updated in place (their provenance names the new hash)", () => {
    exportSkills(cfg(), { project: root, write: true });
    skill("git-branching", "+++\nname = \"branching\"\n+++\n\nNever commit to main, ever.\n");
    expect(names(exportSkills(cfg(), { project: root, write: true }))).toEqual(["git-branching:update", "plain-note:update"]);
    expect(readFileSync(join(root, ".claude/skills/git-branching/SKILL.md"), "utf-8")).toContain("ever.");
  });

  it("never overwrites a SKILL.md gnomon did not write; the rest still go", () => {
    mkdirSync(join(root, ".claude/skills/git-branching"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/git-branching/SKILL.md"), "---\nname: git-branching\ndescription: mine\n---\nhand-written\n");
    const r = exportSkills(cfg(), { project: root, write: true });
    expect(r.items.find((i) => i.name === "git-branching")).toMatchObject({ action: "refuse", reason: expect.stringContaining("did not write") });
    expect(readFileSync(join(root, ".claude/skills/git-branching/SKILL.md"), "utf-8")).toContain("hand-written");
    expect(r.items.find((i) => i.name === "plain-note")!.action).toBe("create");
  });

  it("refuses a symlinked SKILL.md rather than write through it", () => {
    mkdirSync(join(root, ".claude/skills/plain-note"), { recursive: true });
    writeFileSync(join(root, "victim.txt"), "keep\n");
    symlinkSync(join(root, "victim.txt"), join(root, ".claude/skills/plain-note/SKILL.md"));
    const r = exportSkills(cfg(), { project: root, write: true });
    expect(r.items.find((i) => i.name === "plain-note")).toMatchObject({ action: "refuse", reason: expect.stringContaining("symlink") });
    expect(readFileSync(join(root, "victim.txt"), "utf-8")).toBe("keep\n");
  });

  it("two skills that make one name: the second is refused, not overwritten", () => {
    skill("Git_Branching", "second\n");
    const r = exportSkills(cfg(), { project: root, write: true });
    const refused = r.items.filter((i) => i.action === "refuse");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatch(/already taken/);
  });

  it("rejects a format it does not write", () => {
    expect(() => exportSkills(cfg(), { project: root, format: "toml" as never })).toThrow(/--format is one of skill-md/);
  });
});

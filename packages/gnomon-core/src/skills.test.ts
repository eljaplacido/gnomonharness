/**
 * gnomon-core: Skills tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkill,
  renderSkill,
  loadSkills,
  loadProposedSkills,
  selectSkills,
  applySkills,
  proposeSkill,
  acceptSkill,
  rejectSkill,
  skillId,
  Skill,
} from "./skills.js";

let root: string;
const cfg = (): any => ({ gnomonDir: join(root, ".gnomon") });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-skills-"));
  mkdirSync(join(root, ".gnomon", "skills"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (dir: string, name: string, body: string) => {
  mkdirSync(join(root, ".gnomon", dir), { recursive: true });
  writeFileSync(join(root, ".gnomon", dir, name), body, "utf-8");
};

describe("parseSkill", () => {
  it("reads TOML front matter", () => {
    const s = parseSkill(
      "rust",
      `+++\nname = "Rust tests"\ndescription = "how tests run"\nmatch = '\\btest\\b'\nroles = ["verifier"]\n+++\n\nRun cargo test --all.`,
      false
    );
    expect(s.name).toBe("Rust tests");
    expect(s.match).toBe("\\btest\\b");
    expect(s.roles).toEqual(["verifier"]);
    expect(s.body).toBe("Run cargo test --all.");
  });

  it("a bare markdown file is still a skill that always applies", () => {
    const s = parseSkill("note", "Just do the thing.", false);
    expect(s.name).toBe("note");
    expect(s.match).toBeUndefined();
    expect(s.body).toBe("Just do the thing.");
  });

  it("round-trips through renderSkill", () => {
    const original = {
      name: "Round trip",
      description: "d",
      match: "\\bfoo\\b",
      roles: ["implementor"],
      body: "Body text.",
    };
    const back = parseSkill("x", renderSkill(original), false);
    expect(back.name).toBe(original.name);
    expect(back.match).toBe(original.match);
    expect(back.roles).toEqual(original.roles);
    expect(back.body).toBe(original.body);
  });
});

describe("loading", () => {
  it("loads active skills but never proposals", () => {
    write("skills", "active.md", "+++\nname = \"A\"\n+++\nbody");
    write(join("skills", "proposed"), "pending.md", "+++\nname = \"P\"\n+++\nbody");

    const active = loadSkills(cfg());
    expect(active.map((s) => s.name)).toEqual(["A"]);

    const pending = loadProposedSkills(cfg());
    expect(pending.map((s) => s.name)).toEqual(["P"]);
    expect(pending[0].proposed).toBe(true);
  });

  it("an empty or missing skills dir is not an error", () => {
    rmSync(join(root, ".gnomon", "skills"), { recursive: true, force: true });
    expect(loadSkills(cfg())).toEqual([]);
  });
});

describe("selectSkills", () => {
  const mk = (over: Partial<Skill>): Skill => ({
    id: "x", name: "x", body: "b", proposed: false, ...over,
  });

  it("a skill with no match always applies", () => {
    expect(selectSkills([mk({})], "implement", "anything")).toHaveLength(1);
  });

  it("matches case-insensitively on the input", () => {
    const s = [mk({ match: "\\bcargo\\b" })];
    expect(selectSkills(s, "implement", "run CARGO test")).toHaveLength(1);
    expect(selectSkills(s, "implement", "run npm test")).toHaveLength(0);
  });

  it("respects role scope", () => {
    const s = [mk({ roles: ["verifier"] })];
    expect(selectSkills(s, "verifier", "x")).toHaveLength(1);
    expect(selectSkills(s, "implementor", "x")).toHaveLength(0);
  });

  it("a malformed pattern is skipped, not thrown", () => {
    expect(() => selectSkills([mk({ match: "([" })], "implement", "x")).not.toThrow();
    expect(selectSkills([mk({ match: "([" })], "implement", "x")).toEqual([]);
  });
});

describe("applySkills", () => {
  it("returns the prompt unchanged when nothing applies", () => {
    expect(applySkills("SYS", [])).toBe("SYS");
  });

  it("appends skills below the system prompt, not above it", () => {
    const out = applySkills("SYS RULES", [
      { id: "a", name: "A", body: "do X", proposed: false },
    ]);
    expect(out.indexOf("SYS RULES")).toBeLessThan(out.indexOf("do X"));
    expect(out).toContain("do not override the rules above");
  });
});

describe("authorship", () => {
  it("a proposal is not active until accepted", () => {
    proposeSkill(cfg(), { name: "New Thing", body: "do it" });
    expect(loadSkills(cfg())).toEqual([]);
    expect(loadProposedSkills(cfg()).map((s) => s.id)).toEqual(["new-thing"]);

    acceptSkill(cfg(), "new-thing");
    expect(loadSkills(cfg()).map((s) => s.id)).toEqual(["new-thing"]);
    expect(loadProposedSkills(cfg())).toEqual([]);
  });

  it("the filename is derived, so a proposal cannot escape the directory", () => {
    // The surface's own system prompt is the most valuable thing a proposal
    // could target. Put real content there and prove it survives.
    writeFileSync(join(root, ".gnomon", "system.md"), "ORIGINAL RULES", "utf-8");

    const { id, path } = proposeSkill(cfg(), {
      name: "../../system",
      body: "pwned",
    });

    expect(id).toBe("system");
    expect(path).toContain(join(".gnomon", "skills", "proposed"));
    expect(readFileSync(join(root, ".gnomon", "system.md"), "utf-8")).toBe(
      "ORIGINAL RULES"
    );
  });

  it("a proposal cannot overwrite an active skill", () => {
    write("skills", "existing.md", "+++\nname = \"Existing\"\n+++\noriginal body");
    proposeSkill(cfg(), { name: "existing", body: "replacement body" });
    expect(loadSkills(cfg())[0].body).toBe("original body");
  });

  it("rejecting discards the proposal and leaves active skills alone", () => {
    write("skills", "keep.md", "+++\nname = \"Keep\"\n+++\nkeep me");
    proposeSkill(cfg(), { name: "temp", body: "x" });
    rejectSkill(cfg(), "temp");
    expect(loadProposedSkills(cfg())).toEqual([]);
    expect(loadSkills(cfg()).map((s) => s.name)).toEqual(["Keep"]);
  });

  it("accepting something that was never proposed is an error", () => {
    expect(() => acceptSkill(cfg(), "ghost")).toThrow(/No proposed skill/);
  });

  it("skillId slugifies", () => {
    expect(skillId("Rust Test Layout!")).toBe("rust-test-layout");
    expect(skillId("!!!")).toBe("skill");
  });
});

describe("working context", () => {
  it("states the path invariant without naming a machine path", async () => {
    const { WORKING_CONTEXT, withWorkingContext } = await import("./skills.js");
    // A session watched a model invent `/repo` and spend three tool calls
    // rediscovering where it was. Telling it the invariant fixes that — but an
    // absolute path would make the prompt differ between machines, which is
    // the thing this harness exists to avoid.
    expect(WORKING_CONTEXT).toMatch(/relative/i);
    expect(WORKING_CONTEXT).not.toMatch(/\/home\/|\/Users\/|C:\\\\/);
    expect(withWorkingContext("SYS")).toContain("SYS");
    expect(withWorkingContext("SYS").indexOf("SYS")).toBeLessThan(
      withWorkingContext("SYS").indexOf("Working context")
    );
  });
});

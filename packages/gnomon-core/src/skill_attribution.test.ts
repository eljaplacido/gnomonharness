/**
 * Skill attribution (docs/design/SKILL-ATTRIBUTION.md, CONTRACTS section 52):
 * what a turn did with its skills, derived from what the loop already sees.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveUi } from "./config.js";
import * as promptLoop from "./prompt_loop.js";
import { citedSkills, SkillUse, skillsUsedText, type SkillCounters } from "./skill_use.js";
import { AUDIT_KINDS } from "./audit.js";
import { readSkillUsage, skillUsageSignals, MIN_FIRINGS, MIN_CITATIONS, MIN_CITED_RATE, USAGE_SIGNALS } from "./skill_mine.js";
import { loadSkills } from "./skills.js";

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "..", "..", "conformance", "skill_use.json"), "utf-8")
);

const skill = (over: Partial<any>) => ({ id: "s", name: "s", body: "", proposed: false, ...over }) as any;
const plainUi = (cot: string) => ({ meta: [], meta_style: "line", think: "collapse", spinner: false, color: false, cot }) as any;

describe("citedSkills", () => {
  const skills = [
    { id: "writing-tests", name: "writing-tests" },
    { id: "deploy", name: "deploy" },
    { id: "api", name: "api" },
    { id: "testing", name: "testing" },
    { id: "release-checklist", name: "Release checklist" },
  ];
  it("finds an id, a name and the spaced form of a hyphenated name", () => {
    expect(citedSkills("I will follow writing-tests here", skills)).toEqual(["writing-tests"]);
    expect(citedSkills("per the Writing Tests note", skills)).toEqual(["writing-tests"]);
    expect(citedSkills("use the release checklist", skills)).toEqual(["release-checklist"]);
  });
  it("is word-bounded", () => {
    expect(citedSkills("the deployment is done", skills)).toEqual([]);
    expect(citedSkills("predeploy and deploy-all", skills)).toEqual([]);
    expect(citedSkills("run deploy now", skills)).toEqual(["deploy"]);
  });
  it("ignores names shorter than 4 characters and all-generic names", () => {
    expect(citedSkills("the api and testing are fine", skills)).toEqual([]);
  });
});

describe("SkillUse", () => {
  const fired = [{ id: "writing-tests", tokens: 420 }];
  const known = [{ id: "writing-tests", name: "writing-tests" }];
  it("is absent when nothing fired, was read or was proposed", () => {
    expect(new SkillUse([], []).counters()).toBeUndefined();
  });
  it("accumulates fired, read, cited and proposed", () => {
    const u = new SkillUse(fired, known);
    u.noteRead("writing-tests");
    u.noteRead("writing-tests");
    expect(u.noteReasoning("I follow writing-tests")).toEqual(["writing-tests"]);
    u.noteProposed("new-note");
    expect(u.counters()).toEqual({
      v: 1,
      fired: [{ name: "writing-tests", tokens: 420 }],
      read: { "writing-tests": 2 },
      cited_in_reasoning: ["writing-tests"],
      proposed: ["new-note"],
    });
  });
  it("does not cite a skill that neither fired nor was opened", () => {
    const u = new SkillUse([], known);
    u.noteProposed("x");
    expect(u.noteReasoning("writing-tests is relevant")).toEqual([]);
  });
  it("a delegated sub-turn counts toward the parent", () => {
    const u = new SkillUse(fired, known);
    u.absorb({ v: 1, fired: [{ name: "other-skill", tokens: 10 }], read: { "other-skill": 1 }, cited_in_reasoning: ["other-skill"], proposed: [] });
    expect(u.counters()!.fired.map((f) => f.name).sort()).toEqual(["other-skill", "writing-tests"]);
    expect(u.counters()!.read).toEqual({ "other-skill": 1 });
  });
  it("renders the end-of-turn line", () => {
    const c: SkillCounters = { v: 1, fired: [{ name: "writing-tests", tokens: 420 }], read: { "writing-tests": 1 }, cited_in_reasoning: ["writing-tests"], proposed: ["x"] };
    expect(skillsUsedText(c)).toBe("skills used: writing-tests (loaded ~420 tok, read 1×, cited) · proposed: x");
    expect(skillsUsedText({ ...c, read: {}, cited_in_reasoning: [], proposed: [] })).toBe("skills used: writing-tests (loaded ~420 tok)");
    expect(skillsUsedText({ v: 1, fired: [], read: {}, cited_in_reasoning: [], proposed: ["x"] })).toBe("skills · proposed: x");
  });
});

describe("the ◆ skills row", () => {
  const a = skill({ id: "secrets", name: "secrets", match: "\\b(token|secret)\\b", body: "x".repeat(400) });
  const b = skill({ id: "house", name: "house style", body: "y".repeat(40) });
  it("appends each skill's context cost and the total", () => {
    const row = promptLoop.skillsRow(plainUi("work"), [a, b], "rotate the API token", 300)!;
    expect(row).toMatch(/^ {2}◆ skills {2}secrets \("token"\) ~\d+ tok, house style \(always\) ~\d+ tok {2}· ~\d+ tok$/);
    const [ta, tb] = [promptLoop.skillTokens(a), promptLoop.skillTokens(b)];
    expect(ta).toBeGreaterThan(tb);
    expect(row).toContain(`· ~${ta + tb} tok`);
  });
  it.each(["brief", "tools", "think", "work", "full"])("shows loaded skills at /cot %s", (cot) => {
    expect(promptLoop.skillsRow(plainUi(cot), [b], "x", 300)).toContain("◆ skills");
  });
  it.each([
    ["brief", false],
    ["tools", false],
    ["think", false],
    ["work", true],
    ["full", true],
  ])("none matched at /cot %s: shown=%s", (cot, shown) => {
    const row = promptLoop.skillsRow(plainUi(cot), [], "x", 300, 3);
    if (shown) expect(row).toBe("  ◆ skills  none matched · 3 available");
    else expect(row).toBeNull();
  });
  it("shows nothing when no skills exist at all", () => {
    expect(promptLoop.skillsRow(plainUi("full"), [], "x", 300, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A whole turn
// ---------------------------------------------------------------------------

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-skill-use-"));
  // A copy of this repository's own surface (read, never written), so the
  // role has real tools; its skills are replaced by the ones under test.
  cpSync(join(process.cwd(), "..", "..", ".gnomon"), join(root, ".gnomon"), { recursive: true });
  rmSync(join(root, ".gnomon", "skills"), { recursive: true, force: true });
  mkdirSync(join(root, ".gnomon", "skills"), { recursive: true });
  const roles = join(root, ".gnomon", "roles.toml");
  writeFileSync(
    roles,
    readFileSync(roles, "utf-8").replace(
      'tools = ["read", "glob", "grep", "compute", "todo", "write", "edit", "bash"]',
      'tools = ["read", "glob", "grep", "skill"]'
    )
  );
  writeFileSync(
    join(root, ".gnomon", "skills", "release-checklist.md"),
    '+++\nname = "release-checklist"\nmatch = "release"\n+++\n\nTag, then publish.'
  );
  writeFileSync(join(root, ".gnomon", "skills", "dormant-note.md"), '+++\nname = "dormant-note"\nmatch = "zzzz"\n+++\n\nNever matches.');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const route = { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any;

async function turn(cot: string, input: string, script: Array<Record<string, unknown>>) {
  const config: any = loadConfig(root);
  const ui = { ...resolveUi(config), cot, think: "collapse", color: false };
  const state: any = { config, exchanges: [], currentRole: "implement", ui };
  const said: string[] = [];
  let call = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const message = script[Math.min(call, script.length - 1)];
    call++;
    return { ok: true, json: async () => ({ message }) };
  }) as unknown as typeof fetch;
  try {
    const result = await promptLoop.runAgenticTurn(state, "implement", route, [{ role: "user", content: input }], {
      approve: async () => true,
      progress: { start() {}, update() {}, stop() {} } as any,
      ui,
      say: (s: string) => said.push(s),
      standingApproval: () => true,
    });
    return { result, said: said.join("\n") };
  } finally {
    globalThis.fetch = original;
  }
}

const reads = [{ function: { name: "read", arguments: { path: ".gnomon/skills/release-checklist.md" } } }];
const propose = [{ function: { name: "skill", arguments: { name: "tag-notes", body: "Always tag first." } } }];

describe("a turn that uses a skill", () => {
  const script = [
    { content: "", reasoning_content: "I will follow release-checklist before tagging.", tool_calls: reads },
    { content: "", tool_calls: propose },
    { content: "done" },
  ];

  it("annotates the reasoning, shows the read and the proposal, and closes with the used line", async () => {
    const { result, said } = await turn("full", "prepare the release", script);
    expect(said).toMatch(/✻ I will follow release-checklist before tagging\.\s+·uses release-checklist/);
    expect(said).toMatch(/◆ skill\s+release-checklist/);
    expect(said).toMatch(/◆ skill\s+propose: tag-notes/);
    expect(said).toMatch(/◆ skills used: release-checklist \(loaded ~\d+ tok, read 1×, cited\) · proposed/);
    expect(result.counters.skills).toEqual({
      v: 1,
      fired: [{ name: "release-checklist", tokens: expect.any(Number) }],
      read: { "release-checklist": 1 },
      cited_in_reasoning: ["release-checklist"],
      proposed: ["tag-notes"],
    });
    expect(result.counters.skills!.fired[0]!.tokens).toBeGreaterThan(0);
  });

  it("renders at /cot work, with the read and the proposal as steps", async () => {
    const { said } = await turn("work", "prepare the release", script);
    expect(said).toContain("·uses release-checklist");
    expect(said).toMatch(/◆ skill\s+release-checklist/);
    expect(said).toMatch(/◆ skill\s+propose: tag-notes/);
    expect(said).toMatch(/◆ skills used: release-checklist/);
  });

  it("renders at /cot brief as one line per step, with no reasoning", async () => {
    const { said } = await turn("brief", "prepare the release", script);
    expect(said).toMatch(/• skill release-checklist/);
    expect(said).toMatch(/• skill propose: tag-notes/);
    expect(said).not.toContain("·uses");
    expect(said).toMatch(/◆ skills used: release-checklist/);
  });

  it("at /cot think shows the annotation and the used line but no step rows", async () => {
    const { said } = await turn("think", "prepare the release", script);
    expect(said).toContain("·uses release-checklist");
    expect(said).not.toMatch(/◆ skill\s+release-checklist\n/);
    expect(said).toMatch(/◆ skills used:/);
  });

  it("at /cot tools shows the step rows but not the reasoning", async () => {
    const { said } = await turn("tools", "prepare the release", script);
    expect(said).toMatch(/◆ skill\s+release-checklist/);
    expect(said).not.toContain("·uses");
  });

  it("at /cot off prints no skill line, but the counters are still derived", async () => {
    const { said, result } = await turn("off", "prepare the release", script);
    expect(said).not.toContain("◆");
    expect(result.counters.skills!.cited_in_reasoning).toEqual(["release-checklist"]);
  });

  it("leaves a skill that was loaded and never named visibly unattributed", async () => {
    const { said, result } = await turn("full", "prepare the release", [
      { content: "", reasoning_content: "Tag the commit, then publish.", tool_calls: [{ function: { name: "glob", arguments: { pattern: "*.md" } } }] },
      { content: "done" },
    ]);
    expect(said).not.toContain("·uses");
    expect(said).toMatch(/◆ skills used: release-checklist \(loaded ~\d+ tok\)$/m);
    expect(result.counters.skills!.cited_in_reasoning).toEqual([]);
    expect(result.counters.skills!.read).toEqual({});
  });

  it("has no counters.skills and no used line when no skill was involved", async () => {
    const { said, result } = await turn("full", "say hello", [{ content: "hi" }]);
    expect(result.counters.skills).toBeUndefined();
    expect(said).not.toContain("skills used");
  });

  it("a read of a dormant skill is use, though nothing fired", async () => {
    const { result } = await turn("full", "say hello", [
      { content: "", tool_calls: [{ function: { name: "read", arguments: { path: ".gnomon/skills/dormant-note.md" } } }] },
      { content: "done" },
    ]);
    expect(result.counters.skills).toEqual({ v: 1, fired: [], read: { "dormant-note": 1 }, cited_in_reasoning: [], proposed: [] });
  });
});

describe("the skill_use record", () => {
  const c: SkillCounters = { v: 1, fired: [{ name: "a-skill", tokens: 5 }], read: {}, cited_in_reasoning: [], proposed: [] };
  it("is a published audit kind and carries the derived data without the counters' v", () => {
    expect(AUDIT_KINDS).toContain("skill_use");
    const recs: any[] = [];
    promptLoop.writeSkillUse({ write: (k: string, f: any) => recs.push({ kind: k, ...f }) }, 12, "implement", c);
    expect(recs).toEqual([{ kind: "skill_use", turn: 12, role: "implement", fired: [{ name: "a-skill", tokens: 5 }], read: {}, cited_in_reasoning: [], proposed: [] }]);
    expect(Object.keys(recs[0]).filter((k) => k !== "kind")).toEqual(fixture.audit_keys);
  });
  it("is not written for a turn without skill activity", () => {
    const recs: any[] = [];
    promptLoop.writeSkillUse({ write: (k: string, f: any) => recs.push(f) }, 1, "implement", undefined);
    expect(recs).toEqual([]);
  });
  it("matches conformance/skill_use.json", () => {
    expect(fixture.counters_keys).toEqual(["v", "fired", "read", "cited_in_reasoning", "proposed"]);
    expect(fixture.signals).toEqual([...USAGE_SIGNALS]);
    expect(fixture.min_firings).toBe(MIN_FIRINGS);
    expect(fixture.min_citations).toBe(MIN_CITATIONS);
    expect(fixture.min_cited_rate).toBe(MIN_CITED_RATE);
    expect(Object.keys(new SkillUse([{ id: "x", tokens: 1 }], []).counters()!)).toEqual(fixture.counters_keys);
  });
});

describe("/skills usage lines and mine signals", () => {
  const sk = skill({ id: "writing-tests", name: "writing-tests", body: "z".repeat(80) });
  const ex = (c: SkillCounters | undefined) => ({ counters: { skills: c } }) as any;
  const used: SkillCounters = { v: 1, fired: [{ name: "writing-tests", tokens: 20 }], read: { "writing-tests": 2 }, cited_in_reasoning: ["writing-tests"], proposed: [] };

  it("reports this session, from the turns' counters", () => {
    const lines = promptLoop.skillUsageLines(sk, [ex(used), ex({ ...used, cited_in_reasoning: [], read: {} }), ex(undefined)], undefined);
    expect(lines[0]).toMatch(/this session: fired 2×, read 2×, cited 1× · ~\d+ tok per firing/);
    expect(lines[1]).toContain("no firings recorded");
  });

  it("reports the project's history and the latest trial verdict", () => {
    const lines = promptLoop.skillUsageLines(sk, [], {
      id: "writing-tests", firings: 8, cited: 2, reads: 1, tokens_per_firing: 20, last_used: "2026-11-20T10:00:00Z",
      trial: { ts: "2026-11-21T10:00:00Z", status: "complete", meets_thresholds: true },
    });
    expect(lines).toContain("      across sessions: 8 firing(s), cited 25%, last used 2026-11-20");
    expect(lines).toContain("      latest trial: meets thresholds (2026-11-21)");
  });

  it("reads usage from trails and raises the two signals", () => {
    const dir = join(root, ".gnomon-audit");
    mkdirSync(dir, { recursive: true });
    const config: any = loadConfig(root);
    const rec = (seq: number, ts: string, f: any) => JSON.stringify({ seq, ts, prev: null, ...f });
    const lines: string[] = [];
    let seq = 0;
    for (let i = 0; i < MIN_FIRINGS; i++) {
      lines.push(rec(seq++, `2026-11-1${i}T00:00:00Z`, { kind: "skill_use", turn: i, role: "implement", fired: [{ name: "never-named", tokens: 100 }, { name: "often-named", tokens: 50 }], read: {}, cited_in_reasoning: ["often-named"], proposed: [] }));
    }
    lines.push(rec(seq++, "2026-11-30T00:00:00Z", { kind: "skill_trial", skill: "often-named", status: "complete", meets_thresholds: false }));
    writeFileSync(join(dir, "s1.jsonl"), lines.join("\n") + "\n");
    const usage = readSkillUsage(config);
    expect(usage.get("never-named")).toMatchObject({ firings: MIN_FIRINGS, cited: 0, tokens_per_firing: 100, last_used: "2026-11-14T00:00:00Z" });
    expect(usage.get("often-named")!.trial).toMatchObject({ meets_thresholds: false });
    const hits = skillUsageSignals(usage);
    expect(hits.map((h) => [h.skill, h.signal])).toEqual([
      ["never-named", "fires_never_cited"],
      ["often-named", "cited_often"],
    ]);
    expect(hits[0]!.suggestion).toContain("~100 tok");
    expect(hits[0]!.suggestion).toContain("match");
    expect(hits[1]!.suggestion).toContain("gnomon skill trial often-named");
  });

  it("raises no signal below the thresholds", () => {
    const u = (over: any) => new Map([["s", { id: "s", firings: 0, cited: 0, reads: 0, tokens_per_firing: 1, last_used: null, trial: null, ...over }]]);
    expect(skillUsageSignals(u({ firings: MIN_FIRINGS - 1 }))).toEqual([]);
    expect(skillUsageSignals(u({ firings: 10, cited: MIN_CITATIONS }))).toEqual([]);
  });

  it("the active skills the loop loads are the ones usage is keyed by", () => {
    expect(loadSkills(loadConfig(root) as any).map((s) => s.id).sort()).toEqual(["dormant-note", "release-checklist"]);
  });
});

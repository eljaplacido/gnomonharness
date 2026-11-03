/**
 * gnomon-core: Skills tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkill,
  renderSkill,
  loadSkills,
  loadProposedSkills,
  selectSkills,
  roleSkills,
  applySkills,
  proposeSkill,
  acceptSkill,
  rejectSkill,
  skillId,
  Skill,
  SkillRefusal,
} from "./skills.js";
import { recomputeManifest } from "./config.js";
import { verifyTrail, AuditTrail, resolveAudit, type AuditRecord } from "./audit.js";

let root: string;
const cfg = (audit: Record<string, unknown> = {}, policy: Record<string, unknown> = {}): any => ({
  gnomonDir: join(root, ".gnomon"),
  config: { audit },
  policy,
});

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

describe("accept and reject leave a record", () => {
  /** Every record of every trail under the audit dir, in file order. */
  const trails = (dir = ".gnomon-audit"): { file: string; records: AuditRecord[] }[] => {
    const at = join(root, dir);
    if (!existsSync(at)) return [];
    return readdirSync(at)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .map((f) => ({
        file: join(at, f),
        records: readFileSync(join(at, f), "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as AuditRecord),
      }));
  };

  it("accept writes skill_accept: the content hash, and the surface hash before and after", () => {
    // Fails on master: acceptSkill moved the file and wrote nothing, so the
    // trail showed the surface hash change and never that a person accepted a
    // named skill, or what it said.
    const { path } = proposeSkill(cfg(), { name: "Run the suite", body: "use make test" });
    const content = readFileSync(path);
    const before = recomputeManifest(join(root, ".gnomon")).surface_hash;

    const d = acceptSkill(cfg(), "run-the-suite", { interactive: false });
    const after = recomputeManifest(join(root, ".gnomon")).surface_hash;

    const all = trails();
    expect(all).toHaveLength(1);
    const kinds = all[0].records.map((r) => r.kind);
    expect(kinds).toEqual(["session_start", "skill_accept", "session_end"]);
    const rec = all[0].records[1];
    expect(rec).toMatchObject({
      skill: "run-the-suite",
      name: "Run the suite",
      path: ".gnomon/skills/run-the-suite.md",
      content_sha256: createHash("sha256").update(content).digest("hex"),
      surface_hash_before: before,
      surface_hash_after: after,
      evidence: "none",
      by: "human",
      interactive: false,
    });
    expect(rec.surface_hash_before).not.toBe(rec.surface_hash_after);
    expect(typeof rec.host).toBe("string");
    // The returned record is the one on disk, and the trail verifies sealed.
    expect(d.record?.hash).toBe(rec.hash);
    expect(verifyTrail(all[0].file)).toMatchObject({ ok: true, sealed: true });
  });

  it("is written even when [audit] is off, into the directory [audit] names", () => {
    proposeSkill(cfg(), { name: "n", body: "b" });
    acceptSkill(cfg({ enabled: false, dir: "trail-here" }), "n");
    expect(trails("trail-here")).toHaveLength(1);
    expect(trails()).toHaveLength(0);
  });

  it("reject writes skill_reject with the reason, before the proposal goes", () => {
    const { path } = proposeSkill(cfg(), { name: "Bad idea", body: "skip the tests" });
    const content = readFileSync(path);
    const surface = recomputeManifest(join(root, ".gnomon")).surface_hash;

    rejectSkill(cfg(), "bad-idea", { reason: "hides failures" });

    expect(existsSync(path)).toBe(false);
    const rec = trails()[0].records[1];
    expect(rec).toMatchObject({
      kind: "skill_reject",
      skill: "bad-idea",
      content_sha256: createHash("sha256").update(content).digest("hex"),
      // Proposals are not hashed, so rejecting one moves nothing.
      surface_hash_before: surface,
      surface_hash_after: surface,
      reason: "hides failures",
    });
  });

  it("an accept whose record cannot be written does not happen", () => {
    proposeSkill(cfg(), { name: "n", body: "b" });
    // A FILE where the audit directory should be: mkdir fails.
    writeFileSync(join(root, "blocked"), "not a directory", "utf-8");
    expect(() => acceptSkill(cfg({ dir: "blocked" }), "n")).toThrow(/Not accepted/);
    expect(loadSkills(cfg()).map((s) => s.id)).toEqual([]);
    expect(loadProposedSkills(cfg()).map((s) => s.id)).toEqual(["n"]);
  });

  it("two decisions in the same millisecond get two sealed trails", () => {
    // The clock is frozen, so all three decisions share a timestamp and pid:
    // without the random suffix they share one file and the chain forks.
    for (const n of ["a", "b", "c"]) proposeSkill(cfg(), { name: n, body: n });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T00:00:00.000Z"));
    try {
      acceptSkill(cfg(), "a");
      acceptSkill(cfg(), "b");
      rejectSkill(cfg(), "c");
    } finally {
      vi.useRealTimers();
    }
    const all = trails();
    expect(all).toHaveLength(3);
    for (const t of all) expect(verifyTrail(t.file)).toMatchObject({ ok: true, sealed: true });
  });

  it("records the decision before the file moves; a move that fails is sealed applied: false", () => {
    // Fails on the old order (move, then record): the failed move threw
    // before anything was written, and a crash after a successful move left
    // an accept with no record at all.
    proposeSkill(cfg(), { name: "n", body: "b" });
    // A DIRECTORY where the skill would land: the rename fails.
    mkdirSync(join(root, ".gnomon", "skills", "n.md"), { recursive: true });
    expect(() => acceptSkill(cfg(), "n")).toThrow(/could not be moved/);
    expect(loadProposedSkills(cfg()).map((s) => s.id)).toEqual(["n"]);
    const [t] = trails();
    expect(t.records.map((r) => r.kind)).toEqual(["session_start", "skill_accept", "session_end"]);
    expect(t.records[2]).toMatchObject({ applied: false });
    expect(typeof t.records[2].error).toBe("string");
    expect(verifyTrail(t.file)).toMatchObject({ ok: true, sealed: true });
  });

  it("names the surface hash the accept will produce, and seals with the one it did", () => {
    proposeSkill(cfg(), { name: "n", body: "b" });
    acceptSkill(cfg(), "n");
    const after = recomputeManifest(join(root, ".gnomon")).surface_hash;
    const [t] = trails();
    expect(t.records[1].surface_hash_after).toBe(after);
    expect(t.records[2]).toMatchObject({ applied: true, surface_hash_after: after });
  });

  it("refuses an id that is not a skill id: reject ../keep cannot delete an active skill", () => {
    // Fails on master: the id was joined into a path unchecked, and
    // `skill reject ../keep` removed .gnomon/skills/keep.md.
    write("skills", "keep.md", "+++\nname = \"Keep\"\n+++\nkeep me");
    expect(() => rejectSkill(cfg(), "../keep")).toThrow(/not a skill id/);
    expect(() => acceptSkill(cfg(), "../keep")).toThrow(/not a skill id/);
    expect(() => acceptSkill(cfg(), "Upper")).toThrow(/not a skill id/);
    expect(loadSkills(cfg()).map((s) => s.id)).toEqual(["keep"]);
    expect(trails()).toHaveLength(0);
  });

  it("matches conformance/skill_decision.json", () => {
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "..", "..", "conformance", "skill_decision.json"), "utf-8")
    );
    const base = ["seq", "ts", "kind", "prev", "hash"];
    proposeSkill(cfg(), { name: "a", body: "b" });
    proposeSkill(cfg(), { name: "c", body: "d" });
    acceptSkill(cfg(), "a");
    rejectSkill(cfg(), "c", { reason: "why" });
    const decided = trails().map((t) => {
      expect(t.records.map((r) => r.kind)).toEqual(["session_start", t.records[1].kind, "session_end"]);
      expect(t.records[0].mode).toBe(fixture.session_start_mode);
      return t.records[1];
    });
    for (const r of decided) {
      expect(fixture.audit_kinds).toContain(r.kind);
      expect(Object.keys(r).filter((k) => !base.includes(k)).sort()).toEqual(
        [...fixture.audit_keys[r.kind as string]].sort()
      );
      expect(r.by).toBe(fixture.by_from_cli);
    }
    expect(decided.find((r) => r.kind === "skill_accept")?.evidence).toBe(fixture.evidence_without_report);
    for (const t of trails()) {
      const end = t.records[2];
      const want = t.records[1].kind === "skill_accept" ? fixture.session_end_keys : fixture.session_end_keys_reject;
      expect(Object.keys(end).filter((k) => !base.includes(k)).sort()).toEqual([...want.applied].sort());
    }
    expect(decided.find((r) => r.kind === "skill_accept")?.require_trial).toBe(fixture.require_trial.default);
  });

  it("a reject whose record cannot be written leaves the proposal", () => {
    proposeSkill(cfg(), { name: "n", body: "b" });
    writeFileSync(join(root, "blocked"), "not a directory", "utf-8");
    expect(() => rejectSkill(cfg({ dir: "blocked" }), "n")).toThrow();
    expect(loadProposedSkills(cfg()).map((s) => s.id)).toEqual(["n"]);
  });
});

describe("accept --evidence and require_trial", () => {
  const strict = () => cfg({}, { skills: { require_trial: true } });
  const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

  /**
   * A trial report on disk, and (unless `recorded` is false) the skill_trial
   * record naming its hash, as `gnomon skill trial` writes them. Built by hand
   * so this file tests the accept, not the trial.
   */
  const report = (
    over: {
      content?: string;
      base?: string;
      meets?: unknown;
      recorded?: boolean;
      /** Fields of the skill_trial record that differ from the report. */
      record?: Record<string, unknown>;
      /** Leave the trail unsealed (no session_end). */
      unsealed?: boolean;
    } = {}
  ): string => {
    const content = readFileSync(join(root, ".gnomon", "skills", "proposed", "fix-it.md"));
    const fields = {
      schema: "gnomon.trial/1",
      skill: "fix-it",
      content_sha256: over.content ?? sha(content),
      arms: {
        base: { surface_hash: over.base ?? recomputeManifest(join(root, ".gnomon")).surface_hash },
        skill: { surface_hash: "s".repeat(64) },
      },
      meets_thresholds: "meets" in over ? over.meets : true,
    };
    const body = `${JSON.stringify(fields)}\n`;
    const rel = `.gnomon-trials/fix-it/${Math.random().toString(16).slice(2)}/report.json`;
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body, "utf-8");
    if (over.recorded !== false) {
      // The trail `recordTrial` writes: sealed, chained, and agreeing with the
      // report on every field the accept compares.
      const t = new AuditTrail({ ...resolveAudit(cfg()), enabled: true, chain: true }, `trial-${Math.random().toString(16).slice(2)}`);
      t.write("session_start", { mode: "trial" });
      t.write("skill_trial", {
        skill: fields.skill,
        report: rel,
        report_sha256: sha(body),
        content_sha256: fields.content_sha256,
        surface_hash_base: fields.arms.base.surface_hash,
        surface_hash_skill: fields.arms.skill.surface_hash,
        meets_thresholds: fields.meets_thresholds,
        ...over.record,
      });
      if (!over.unsealed) t.write("session_end", {});
    }
    return rel;
  };
  const propose = () => proposeSkill(cfg(), { name: "fix it", body: "write fixed.txt" });
  const stillProposed = () => {
    expect(loadSkills(cfg())).toEqual([]);
    expect(loadProposedSkills(cfg()).map((s) => s.id)).toEqual(["fix-it"]);
  };

  it("with require_trial on, accept without a report is refused and nothing moves", () => {
    // Fails on master: there is no require_trial, so this accept succeeds.
    propose();
    expect(() => acceptSkill(strict(), "fix-it")).toThrow(/require_trial/);
    stillProposed();
    expect(existsSync(join(root, ".gnomon-audit"))).toBe(false);
  });

  it("a refusal is a SkillRefusal, which the CLI exits 3 for (refused_by_gate), not 1 (failed)", () => {
    propose();
    let err: unknown;
    try {
      acceptSkill(strict(), "fix-it");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SkillRefusal);
    // A missing proposal is not a refusal: nothing said no.
    expect(() => acceptSkill(strict(), "ghost")).toThrow(/No proposed skill/);
    try {
      acceptSkill(strict(), "ghost");
    } catch (e) {
      expect(e).not.toBeInstanceOf(SkillRefusal);
    }
  });

  it("a forged skill_trial line in any trail does not vouch for a report", () => {
    // Found in review: one hand-written line in any .jsonl counted, with no
    // chain, no hash and nothing compared with the report.
    propose();
    const rel = report({ recorded: false });
    const body = readFileSync(join(root, rel));
    mkdirSync(join(root, ".gnomon-audit"), { recursive: true });
    writeFileSync(
      join(root, ".gnomon-audit", "x.jsonl"),
      JSON.stringify({ seq: 7, kind: "skill_trial", report_sha256: sha(body) }) + "\n"
    );
    expect(() => acceptSkill(strict(), "fix-it", { evidence: rel })).toThrow(/not a trial's own sealed trail/);
    stillProposed();
  });

  it("a sealed, chained trail whose record disagrees with the report does not vouch for it", () => {
    propose();
    const rel = report({ meets: true, record: { meets_thresholds: false } });
    expect(() => acceptSkill(strict(), "fix-it", { evidence: rel })).toThrow(/disagrees with the report on meets_thresholds/);
    const rel2 = report({ record: { content_sha256: "0".repeat(64) } });
    expect(() => acceptSkill(strict(), "fix-it", { evidence: rel2 })).toThrow(/content_sha256/);
    stillProposed();
  });

  it("a trail that is not sealed does not vouch for a report", () => {
    propose();
    const rel = report({ unsealed: true });
    expect(() => acceptSkill(strict(), "fix-it", { evidence: rel })).toThrow(/sealed/);
    stillProposed();
  });

  it("a trail whose record was edited after the fact does not vouch for a report", () => {
    propose();
    const rel2 = report();
    const trail = readdirSync(join(root, ".gnomon-audit"))
      .map((f) => join(root, ".gnomon-audit", f))
      .find((f) => readFileSync(f, "utf-8").includes(sha(readFileSync(join(root, rel2)))))!;
    // Edit the record in place, keeping the line parseable: the chain breaks.
    const lines = readFileSync(trail, "utf-8").trim().split("\n");
    const r = JSON.parse(lines[1]!);
    r.surface_hash_skill = "e".repeat(64);
    lines[1] = JSON.stringify(r);
    writeFileSync(trail, lines.join("\n") + "\n");
    expect(() => acceptSkill(strict(), "fix-it", { evidence: rel2 })).toThrow(/does not verify/);
    stillProposed();
  });

  it("a report for different content is refused", () => {
    propose();
    const rel = report({ content: "0".repeat(64) });
    expect(() => acceptSkill(strict(), "fix-it", { evidence: rel })).toThrow(/different skill content/);
    // Refused whatever require_trial says: it is evidence about something else.
    expect(() => acceptSkill(cfg(), "fix-it", { evidence: rel })).toThrow(/different skill content/);
    stillProposed();
  });

  it("a report run against a different base surface is refused", () => {
    propose();
    const rel = report({ base: "f".repeat(64) });
    expect(() => acceptSkill(strict(), "fix-it", { evidence: rel })).toThrow(/trial ran against surface/);
    stillProposed();
  });

  it("a report no skill_trial record names is refused", () => {
    propose();
    const rel = report({ recorded: false });
    expect(() => acceptSkill(strict(), "fix-it", { evidence: rel })).toThrow(/no skill_trial record/);
    stillProposed();
  });

  it("with require_trial on, a report that does not meet its thresholds is refused", () => {
    propose();
    for (const meets of [false, "undetermined"]) {
      const rel = report({ meets });
      expect(() => acceptSkill(strict(), "fix-it", { evidence: rel })).toThrow(/meets_thresholds/);
    }
    stillProposed();
  });

  it("a matching report is accepted, and the record cites its hash and its trial record", () => {
    propose();
    const rel = report();
    const d = acceptSkill(strict(), "fix-it", { evidence: rel });
    const ev = d.record?.evidence as Record<string, unknown>;
    expect(ev).toMatchObject({
      report: rel,
      report_sha256: sha(readFileSync(join(root, rel))),
      meets_thresholds: true,
    });
    expect((ev.trial_record as { trail: string }).trail).toMatch(/^\.gnomon-audit\/trial-/);
    expect(d.record?.require_trial).toBe(true);
    expect(loadSkills(cfg()).map((s) => s.id)).toEqual(["fix-it"]);
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "..", "..", "conformance", "skill_decision.json"), "utf-8")
    );
    expect(Object.keys(ev).sort()).toEqual([...fixture.evidence_keys].sort());
    expect(Object.keys(ev.trial_record as object).sort()).toEqual([...fixture.trial_record_keys].sort());
  });

  it("with require_trial off (the default), a person may accept on a failing report; the record says so", () => {
    propose();
    const rel = report({ meets: false });
    const d = acceptSkill(cfg(), "fix-it", { evidence: rel });
    expect(d.record).toMatchObject({ require_trial: false, evidence: { meets_thresholds: false } });
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


// ---------------------------------------------------------------------------
// Progressive disclosure.
//
// A skill whose `match` is slightly wrong used to be indistinguishable from a
// skill nobody wrote: hashed into the surface, listed by `gnomon skill list`,
// and never once mentioned to the model. Naming the dormant ones costs a line
// each, and it is the only way the mistake ever gets noticed.

describe("skills the model is told about but not given", () => {
  const mk = (over: Partial<Skill>): Skill => ({
    id: "x", name: "x", body: "BODY_TEXT", proposed: false, ...over,
  });

  it("roleSkills keeps what the role may use, whatever the input was", () => {
    const all = [
      mk({ id: "a", roles: ["implement"] }),
      mk({ id: "b", roles: ["verifier"] }),
      mk({ id: "c" }),
    ];
    expect(roleSkills(all, "implement").map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("lists a non-matching skill by path, and withholds its body", () => {
    const dormant = mk({
      id: "cargo-layout",
      name: "Cargo layout",
      description: "where tests live",
      body: "BODY_TEXT",
    });
    const out = applySkills("SYS", [], [dormant], ".gnomon/skills");
    expect(out).toContain(".gnomon/skills/cargo-layout.md");
    expect(out).toContain("Cargo layout");
    expect(out).toContain("where tests live");
    // The point of progressive disclosure: the body costs nothing until asked.
    expect(out).not.toContain("BODY_TEXT");
  });

  it("tells the model the description is a label, not the note", () => {
    const out = applySkills("SYS", [], [mk({ id: "a", description: "d" })]);
    // A model that acts on a one-line description instead of reading the file
    // has been given a worse version of the skill, not a cheaper one.
    expect(out).toMatch(/read/i);
    expect(out).toMatch(/not act on the description alone/i);
  });

  it("still inlines the body of a skill that DID match", () => {
    const out = applySkills("SYS", [mk({ id: "hit", body: "BODY_TEXT" })], []);
    expect(out).toContain("BODY_TEXT");
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(applySkills("SYS", [], [])).toBe("SYS");
  });

  it("the dormant list is derived from the surface, so it is machine-stable", () => {
    const all = [mk({ id: "b" }), mk({ id: "a" })];
    const once = applySkills("SYS", [], roleSkills(all, "implement"));
    const twice = applySkills("SYS", [], roleSkills(all, "implement"));
    expect(once).toBe(twice);
  });
});

/**
 * YAML front matter is the likely mistake, so it must not be the silent one.
 *
 * `---` is what almost every other tool uses for front matter, and this
 * repository ships BOTH conventions — .claude/skills/ is YAML, .gnomon/skills/
 * is TOML. A file written with the wrong fences used to parse as "no front
 * matter at all": no description, no match (so it applied to every single
 * turn), and its own `---\nname: …\n---` header handed to the model as
 * instruction text.
 */
describe("a skill written with YAML front matter", () => {
  const yaml = [
    "---",
    "name: use-tabs",
    "description: This project indents with tabs, never spaces",
    "match: \\b(indent|format)\\b",
    "---",
    "Indent with tabs. Never spaces.",
  ].join("\n");

  it("is reported rather than silently accepted", () => {
    const s = parseSkill("use-tabs", yaml, false);
    expect(s.problem).toBeTruthy();
    expect(s.problem).toMatch(/YAML/);
    expect(s.problem).toMatch(/\+\+\+/);
  });

  it("never puts the front matter into the prompt body", () => {
    const s = parseSkill("use-tabs", yaml, false);
    expect(s.body).toBe("Indent with tabs. Never spaces.");
    expect(s.body).not.toMatch(/---/);
    expect(s.body).not.toMatch(/description:/);
  });

  it("leaves a correct TOML skill untouched and problem-free", () => {
    const toml = [
      "+++",
      'name = "use-tabs"',
      'description = "This project indents with tabs, never spaces"',
      "match = '\\b(indent|format)\\b'",
      "+++",
      "",
      "Indent with tabs. Never spaces.",
    ].join("\n");
    const s = parseSkill("use-tabs", toml, false);
    expect(s.problem).toBeUndefined();
    expect(s.description).toBe("This project indents with tabs, never spaces");
    expect(s.match).toBeTruthy();
    expect(s.body).toBe("Indent with tabs. Never spaces.");
  });

  it("still treats a plain markdown note as a valid always-on skill", () => {
    // The cheapest possible skill stays valid — this is not a new requirement
    // that every file carry front matter.
    const s = parseSkill("note", "Prefer small commits.", false);
    expect(s.problem).toBeUndefined();
    expect(s.match).toBeUndefined();
    expect(s.body).toBe("Prefer small commits.");
  });
});

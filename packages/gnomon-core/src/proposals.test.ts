/**
 * Proposals and governed memory (docs/CONTRACTS.md section 58): the one path
 * by which `.gnomon/` changes itself. A proposal is inert; a person decides it;
 * accepting moves the surface hash and refuses if the surface moved.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, recomputeManifest, type GnomonConfig } from "./config.js";
import { setDecisionContextProbe } from "./agent_context.js";
import { AUDIT_KINDS, verifyTrail } from "./audit.js";
import { AgentSessionRefusal, NoPersonRefusal, proposeSkill, SkillRefusal } from "./skills.js";
import {
  acceptProposal,
  listProposals,
  pathProblem,
  proposeHarness,
  proposeMemory,
  readProposal,
  rejectProposal,
  renderDiff,
  sha256Hex,
  writeProposal,
  ProposalError,
  ProposalRefusal,
  PROPOSALS_DIR,
  PROPOSAL_KINDS,
  PROPOSAL_SOURCES,
  PROPOSAL_STATUSES,
  PROPOSAL_ID,
  PROPOSAL_LIMITS,
  DEFAULT_HARNESS_PATHS,
} from "./proposals.js";
import { MEMORY_LIMITS, findMemory, loadMemory, memoryContentProblem, memoryIndexBlock, memoryRead, MemoryUse, parseMemory, renderMemory } from "./memory.js";

const roots: string[] = [];
let agentMarker: string | undefined;
beforeEach(() => {
  setDecisionContextProbe(() => ({ agent: null, interactive: true }));
  agentMarker = process.env.GNOMON_AGENT_SESSION;
  delete process.env.GNOMON_AGENT_SESSION;
});
afterEach(() => {
  setDecisionContextProbe(null);
  if (agentMarker === undefined) delete process.env.GNOMON_AGENT_SESSION;
  else process.env.GNOMON_AGENT_SESSION = agentMarker;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function surface(policy = ""): { root: string; config: GnomonConfig } {
  const root = mkdtempSync(join(tmpdir(), "gnomon-proposals-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon", "skills"), { recursive: true });
  const g = (f: string, c: string) => writeFileSync(join(root, ".gnomon", f), c);
  g("config.toml", `[defaults]\nmax_tokens = 512\n\n[audit]\nenabled = true\n\n[endpoints.target]\nurl = "http://127.0.0.1:1/v1/chat/completions"\nkind = "openai"\nstream = false\n`);
  g("policy.toml", policy);
  g("roles.toml", `[roles.smol]\nmodel = "m"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["read"]\nmax_steps = 4\n`);
  g("system.md", "be brief\n");
  g("tools.toml", `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`);
  return { root, config: loadConfig(root) };
}

const hash = (c: GnomonConfig): string => recomputeManifest(c.gnomonDir).surface_hash;
const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? (e as any).path, e.name));

describe("a proposal is inert", () => {
  it("writes one gitignored-store file and leaves .gnomon/ and its hash alone", () => {
    const { root, config } = surface();
    const before = hash(config);
    const filesBefore = tree(join(root, ".gnomon")).sort();
    const p = proposeMemory(config, { name: "Build command", description: "How the project builds", body: "Run `pnpm -r run build`." });
    expect(p).toMatchObject({ v: 1, kind: "memory", status: "pending", source: "agent", title: "Build command" });
    expect(p.diff).toHaveLength(1);
    expect(p.diff[0]).toMatchObject({ path: "memory/build-command.md", before_sha256: null });
    expect(hash(config)).toBe(before);
    expect(tree(join(root, ".gnomon")).sort()).toEqual(filesBefore);
    expect(existsSync(join(root, PROPOSALS_DIR, `${p.id}.json`))).toBe(true);
    expect(lstatSync(join(root, PROPOSALS_DIR, `${p.id}.json`)).mode & 0o077).toBe(0);
    expect(readProposal(config, p.id)?.id).toBe(p.id);
    expect(readProposal(config, p.id.slice(0, 12))?.id).toBe(p.id);
    expect(listProposals(config).proposals.map((x) => x.id)).toEqual([p.id]);
  });

  it("the memory file it would write carries provenance naming the proposal", () => {
    const { config } = surface();
    const p = proposeMemory(config, { name: "N", description: "d", body: "b", source_trail: "t-1", source_seq: 4 });
    const e = parseMemory("n", p.diff[0]!.after);
    expect(e).toMatchObject({ name: "N", description: "d", provenance: p.id, source_trail: "t-1", source_seq: 4, body: "b" });
    expect(e.problem).toBeUndefined();
    expect(p.evidence).toEqual([{ trail: "t-1", seq: 4 }]);
  });

  it("refuses what is not a well-formed proposal", () => {
    const { config } = surface();
    const bad = (diff: any, kind: any = "harness") => () => writeProposal(config, { kind, title: "t", source: "cli", diff });
    expect(bad([])).toThrow(ProposalError);
    expect(bad([{ path: "../x.md", after: "x" }])).toThrow(/plain relative path/);
    expect(bad([{ path: "/etc/passwd", after: "x" }])).toThrow(/absolute/);
    expect(bad([{ path: "system.md", after: "a" }, { path: "system.md", after: "b" }])).toThrow(/twice/);
    expect(bad([{ path: "system.md", after: "x".repeat(20001) }])).toThrow(/longer/);
    expect(bad([{ path: "system.md", after: "x\u0000" }])).toThrow(/NUL/);
    expect(() => writeProposal(config, { kind: "nope" as any, title: "t", source: "cli", diff: [{ path: "system.md", after: "x" }] })).toThrow(/kind is one of/);
    expect(() => writeProposal(config, { kind: "harness", title: "", source: "cli", diff: [{ path: "system.md", after: "x" }] })).toThrow(/title is required/);
    // A memory proposal whose content is not a memory entry, or names another proposal.
    expect(bad([{ path: "memory/x.md", after: "no front matter" }], "memory")).toThrow(/not well formed/);
    expect(() => proposeMemory(config, { name: "", description: "d", body: "b" })).toThrow(ProposalError);
    expect(listProposals(config).proposals).toEqual([]);
  });
});

describe("which paths a proposal may touch", () => {
  it("memory only under memory/, skills only under skills/, harness only the allowed surface files", () => {
    const { config } = surface();
    expect(pathProblem(config, "memory", "memory/a-b.md")).toBeNull();
    expect(pathProblem(config, "memory", "system.md")).toMatch(/only memory/);
    expect(pathProblem(config, "memory", "memory/A.md")).toMatch(/only memory/);
    expect(pathProblem(config, "skill", "skills/x.md")).toBeNull();
    expect(pathProblem(config, "skill", "skills/proposed/x.md")).toMatch(/only skills/);
    expect(pathProblem(config, "harness", "system.md")).toBeNull();
    for (const p of ["policy.toml", "roles.toml", "tools.toml", "config.toml", "skills/x.md", "memory/x.md", "extensions/a.js", ".hidden", "ci.sh"]) {
      expect(pathProblem(config, "harness", p), p).not.toBeNull();
    }
  });

  it("governance files are reachable only when the surface itself lists them", () => {
    const { config } = surface(`[proposals]\nharness_paths = ["tools.toml", "../x", "/abs"]\n`);
    expect(pathProblem(config, "harness", "tools.toml")).toBeNull();
    expect(pathProblem(config, "harness", "policy.toml")).not.toBeNull();
    expect(pathProblem(config, "harness", "../x")).not.toBeNull();
  });
});

describe("accept", () => {
  it("applies the diff, moves the surface hash to the one the record named, and records who", () => {
    const { root, config } = surface();
    const p = proposeMemory(config, { name: "Build command", description: "How it builds", body: "pnpm -r run build" });
    const before = hash(config);
    const d = acceptProposal(config, p.id);
    expect(d).toMatchObject({ id: p.id, kind: "memory", decision: "accept", paths: ["memory/build-command.md"], surface_hash_before: before });
    expect(hash(config)).not.toBe(before);
    expect(hash(config)).toBe(d.surface_hash_after);
    expect(readFileSync(join(root, ".gnomon", "memory", "build-command.md"), "utf-8")).toBe(p.diff[0]!.after);
    expect(d.sealed).toBe(true);

    const after = readProposal(config, p.id)!;
    expect(after).toMatchObject({ status: "accepted", decided_by: "human" });
    expect(after.decided_at).toBeTruthy();
    expect(listProposals(config, { status: "pending" }).proposals).toEqual([]);

    // The record: a sealed trail of its own, verified, naming the paths and both hashes.
    const v = verifyTrail(d.trail!);
    expect(v.ok).toBe(true);
    const recs = readFileSync(d.trail!, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs.map((r) => r.kind)).toEqual(["session_start", "proposal_decision", "session_end"]);
    expect(recs[0].mode).toBe("proposal");
    expect(recs[1]).toMatchObject({
      id: p.id, proposal_kind: "memory", decision: "accept", decided_by: "human", paths: ["memory/build-command.md"],
      surface_hash_before: before, surface_hash_after: d.surface_hash_after, by: "cli", agent_session_marker: "absent", interactive: true, authorised_by: "tty",
    });
    expect(recs[2]).toMatchObject({ applied: true, surface_hash_after: d.surface_hash_after });
    // The text is not in the record.
    expect(JSON.stringify(recs)).not.toContain("pnpm -r run build");
    expect(AUDIT_KINDS).toContain("proposal_decision");
  });

  it("the accepted entry loads as memory, with its provenance", () => {
    const { config } = surface();
    const p = proposeMemory(config, { name: "Build command", description: "How it builds", body: "pnpm -r run build" });
    expect(loadMemory(config)).toEqual([]);
    acceptProposal(config, p.id);
    const entries = loadMemory(config);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "build-command", name: "Build command", provenance: p.id });
    expect(findMemory(entries, "Build command")?.id).toBe("build-command");
    expect(findMemory(entries, "build-command")?.id).toBe("build-command");
    expect(findMemory(entries, "nothing")).toBeNull();
  });

  it("a harness proposal edits system.md only if the file is what it was written against", () => {
    const { root, config } = surface();
    const p = proposeHarness(config, { path: "system.md", after: "be brief\nprefer small diffs\n", title: "Tighten system notes" });
    expect(p.diff[0]!.before_sha256).toBe(sha256Hex("be brief\n"));
    expect(renderDiff(config, p)).toContain("- be brief");
    expect(renderDiff(config, p)).toContain("+ prefer small diffs");
    acceptProposal(config, p.id);
    expect(readFileSync(join(root, ".gnomon", "system.md"), "utf-8")).toBe("be brief\nprefer small diffs\n");
  });

  it("refuses, writing nothing, when the surface moved since the proposal", () => {
    const { root, config } = surface();
    const p = proposeHarness(config, { path: "system.md", after: "be brief\nx\n", title: "t" });
    writeFileSync(join(root, ".gnomon", "system.md"), "somebody edited this\n");
    const h = hash(config);
    expect(() => acceptProposal(config, p.id)).toThrow(ProposalRefusal);
    expect(() => acceptProposal(config, p.id)).toThrow(/surface moved; re-propose|the surface moved/);
    expect(hash(config)).toBe(h);
    expect(readFileSync(join(root, ".gnomon", "system.md"), "utf-8")).toBe("somebody edited this\n");
    expect(readProposal(config, p.id)!.status).toBe("pending");
  });

  it("a new-file proposal is refused if the file appeared since", () => {
    const { root, config } = surface();
    const p = proposeMemory(config, { name: "Note", description: "d", body: "b" });
    mkdirSync(join(root, ".gnomon", "memory"));
    writeFileSync(join(root, ".gnomon", "memory", "note.md"), "+++\nname = \"x\"\n+++\nmine\n");
    expect(() => acceptProposal(config, p.id)).toThrow(/changed since this was proposed/);
    expect(readFileSync(join(root, ".gnomon", "memory", "note.md"), "utf-8")).toContain("mine");
  });

  it("never writes through a symlink", () => {
    const { root, config } = surface();
    const p = proposeHarness(config, { path: "system.md", after: "x\n", title: "t" });
    const real = join(root, "elsewhere.md");
    writeFileSync(real, "outside\n");
    rmSync(join(root, ".gnomon", "system.md"));
    symlinkSync(real, join(root, ".gnomon", "system.md"));
    expect(() => acceptProposal(config, p.id)).toThrow(/not a plain file/);
    expect(readFileSync(real, "utf-8")).toBe("outside\n");
  });

  it("re-checks the paths at accept: a hand-forged file naming policy.toml is refused", () => {
    const { root, config } = surface();
    const id = "20261122T100000000Z-abcd";
    mkdirSync(join(root, PROPOSALS_DIR));
    writeFileSync(
      join(root, PROPOSALS_DIR, `${id}.json`),
      JSON.stringify({
        v: 1, id, kind: "harness", title: "forged", rationale: "", created: new Date().toISOString(), source: "agent", status: "pending",
        diff: [{ path: "policy.toml", before_sha256: sha256Hex(readFileSync(join(root, ".gnomon", "policy.toml"))), after: '[approval]\nmode = "never"\n' }],
      })
    );
    const policy = readFileSync(join(root, ".gnomon", "policy.toml"), "utf-8");
    expect(() => acceptProposal(config, id)).toThrow(/not a file the surface lets a harness proposal edit/);
    expect(readFileSync(join(root, ".gnomon", "policy.toml"), "utf-8")).toBe(policy);
  });

  it("a forged memory entry that names another proposal as its provenance is refused", () => {
    const { root, config } = surface();
    const id = "20261122T100000000Z-abcd";
    mkdirSync(join(root, PROPOSALS_DIR));
    writeFileSync(
      join(root, PROPOSALS_DIR, `${id}.json`),
      JSON.stringify({
        v: 1, id, kind: "memory", title: "forged", rationale: "", created: "x", source: "agent", status: "pending",
        diff: [{ path: "memory/x.md", before_sha256: null, after: renderMemory({ name: "x", description: "d", body: "b", provenance: "20260101T000000000Z-0000", created: "x" }) }],
      })
    );
    expect(() => acceptProposal(config, id)).toThrow(/provenance/);
    expect(existsSync(join(root, ".gnomon", "memory"))).toBe(false);
  });

  it("only a person decides: refused inside an agent session, and with nobody at a terminal", () => {
    const { config } = surface();
    const p = proposeMemory(config, { name: "N", description: "d", body: "b" });
    const h = hash(config);
    setDecisionContextProbe(() => ({ agent: "ancestor process 42 was started inside agent session s-1", interactive: true }));
    expect(() => acceptProposal(config, p.id)).toThrow(AgentSessionRefusal);
    expect(() => rejectProposal(config, p.id)).toThrow(AgentSessionRefusal);
    setDecisionContextProbe(() => ({ agent: null, interactive: false }));
    expect(() => acceptProposal(config, p.id)).toThrow(NoPersonRefusal);
    expect(() => acceptProposal(config, p.id)).toThrow(/gnomon proposals accept/);
    process.env.GNOMON_AGENT_SESSION = "s-9";
    setDecisionContextProbe(() => ({ agent: null, interactive: true }));
    expect(() => acceptProposal(config, p.id)).toThrow(AgentSessionRefusal);
    expect(hash(config)).toBe(h);
    expect(readProposal(config, p.id)!.status).toBe("pending");
    // They are refusals (exit 3 at the CLI), not failures.
    expect(new AgentSessionRefusal()).toBeInstanceOf(SkillRefusal);
    expect(new ProposalRefusal()).toBeInstanceOf(SkillRefusal);
  });

  it("no policy may accept in this build", () => {
    const { config } = surface();
    const p = proposeMemory(config, { name: "N", description: "d", body: "b" });
    expect(() => acceptProposal(config, p.id, { decidedBy: "policy:auto" })).toThrow(/not enabled/);
    expect(readProposal(config, p.id)!.status).toBe("pending");
  });

  it("a decided proposal cannot be decided again; an unknown one says so", () => {
    const { config } = surface();
    const p = proposeMemory(config, { name: "N", description: "d", body: "b" });
    acceptProposal(config, p.id);
    expect(() => acceptProposal(config, p.id)).toThrow(/already accepted/);
    expect(() => rejectProposal(config, p.id)).toThrow(/already accepted/);
    expect(() => acceptProposal(config, "20260101T000000000Z-ffff")).toThrow(/No proposal/);
  });

  it("an unwritable surface puts every file back and seals the record applied: false", () => {
    const { root, config } = surface();
    const a = proposeHarness(config, { path: "system.md", after: "changed\n", title: "t" });
    const h = hash(config);
    chmodSync(join(root, ".gnomon"), 0o555);
    try {
      let threw = false;
      try {
        acceptProposal(config, a.id);
      } catch {
        threw = true;
      }
      // Root can write anywhere; only assert the rollback where the write failed.
      if (threw) {
        expect(hash(config)).toBe(h);
        expect(readProposal(config, a.id)!.status).toBe("pending");
      }
    } finally {
      chmodSync(join(root, ".gnomon"), 0o755);
    }
  });
});

describe("reject", () => {
  it("changes nothing in .gnomon/, keeps the proposal as rejected with the note, and records it", () => {
    const { root, config } = surface();
    const p = proposeMemory(config, { name: "N", description: "d", body: "b" });
    const before = hash(config);
    const d = rejectProposal(config, p.id, { reason: "not true any more" });
    expect(hash(config)).toBe(before);
    expect(existsSync(join(root, ".gnomon", "memory"))).toBe(false);
    expect(readProposal(config, p.id)).toMatchObject({ status: "rejected", decided_by: "human", note: "not true any more" });
    expect(listProposals(config, { status: "pending" }).proposals).toEqual([]);
    const recs = readFileSync(d.trail!, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs[1]).toMatchObject({ proposal_kind: "memory", decision: "reject", surface_hash_before: before, surface_hash_after: before, note: "not true any more" });
    expect(verifyTrail(d.trail!).ok).toBe(true);
  });
});

describe("skill proposals keep working", () => {
  it("a pending proposal from the skill tool is listed as kind skill and decided with skill_accept", () => {
    const { root, config } = surface();
    proposeSkill(config, { name: "Setup script", description: "d", body: "Run scripts/setup.sh first." });
    const l = listProposals(config);
    expect(l.proposals).toHaveLength(1);
    expect(l.proposals[0]).toMatchObject({ kind: "skill", id: "setup-script", status: "pending", legacy: true });
    expect(l.proposals[0]!.diff[0]).toMatchObject({ path: "skills/setup-script.md", before_sha256: null });
    expect(readProposal(config, "setup-script")?.kind).toBe("skill");
    const before = hash(config);
    const d = acceptProposal(config, "setup-script");
    expect(d).toMatchObject({ kind: "skill", decision: "accept" });
    expect(hash(config)).not.toBe(before);
    expect(existsSync(join(root, ".gnomon", "skills", "setup-script.md"))).toBe(true);
    const kinds = readFileSync(d.trail!, "utf-8").trim().split("\n").map((l) => JSON.parse(l).kind);
    expect(kinds).toEqual(["session_start", "skill_accept", "session_end"]);
    expect(listProposals(config).proposals).toEqual([]);
  });

  it("a legacy skill proposal is rejected with skill_reject", () => {
    const { config } = surface();
    proposeSkill(config, { name: "Other", body: "x" });
    const d = rejectProposal(config, "other", { reason: "no" });
    expect(readFileSync(d.trail!, "utf-8")).toContain('"kind":"skill_reject"');
    expect(listProposals(config).proposals).toEqual([]);
  });
});

describe("memory", () => {
  it("round-trips, and a file without provenance is flagged, not dropped", () => {
    const text = renderMemory({ name: 'Quote "x"', description: "line\nbreak", body: "body", provenance: "pid", created: "2026-01-01" });
    const e = parseMemory("q", text);
    expect(e.name).toBe("Quote x");
    expect(e.description).toBe("line break");
    expect(e.problem).toBeUndefined();
    expect(parseMemory("bare", "just text").problem).toMatch(/no \+\+\+ front matter/);
    expect(parseMemory("np", '+++\nname = "n"\ndescription = "d"\n+++\nb').problem).toMatch(/no provenance/);
    expect(memoryContentProblem(null, text)).toBeNull();
    expect(memoryContentProblem("other", text)).toMatch(/provenance/);
  });

  it("the index names entries and never bodies, is capped, and is empty with no entries", () => {
    expect(memoryIndexBlock([])).toBe("");
    const mk = (i: number) => parseMemory(`n${i}`, renderMemory({ name: `Name ${i}`, description: `Desc ${i} ${"x".repeat(400)}`, body: `SECRET-BODY-${i}`, provenance: "p", created: "c" }));
    const block = memoryIndexBlock(Array.from({ length: 45 }, (_, i) => mk(i)));
    expect(block).toContain("## Project memory");
    expect(block).toContain(".gnomon/memory/n0.md");
    expect(block).not.toContain("SECRET-BODY");
    expect(block).toContain("(5 more in .gnomon/memory/)");
    for (const line of block.split("\n").filter((l) => l.startsWith("- "))) expect(line.length).toBeLessThanOrEqual(200);
    expect(block).toMatch(/not instructions/);
  });

  it("memoryRead recognises a read of an entry and nothing else", () => {
    const r = (path: unknown, name = "read") => memoryRead({ name, args: { path } }, ".gnomon");
    expect(r(".gnomon/memory/build-command.md")).toBe("build-command");
    expect(r("./.gnomon/memory/x.md")).toBe("x");
    expect(r("/abs/proj/.gnomon/memory/x.md")).toBe("x");
    expect(r(".gnomon/skills/x.md")).toBeNull();
    expect(r(".gnomon/memory/sub/x.md")).toBeNull();
    expect(r(".gnomon/memory/x.txt")).toBeNull();
    expect(r(".gnomon/memory/x.md", "write")).toBeNull();
    expect(r(42)).toBeNull();
  });

  it("MemoryUse counts reads and proposals, and is silent when there is nothing to say", () => {
    expect(new MemoryUse(0).counters()).toBeUndefined();
    const u = new MemoryUse(2);
    expect(u.counters()).toEqual({ v: 1, indexed: 2, read: {}, proposed: [] });
    u.noteRead("b");
    u.noteRead("a");
    u.noteRead("b");
    u.noteProposed("c");
    expect(u.counters()).toEqual({ v: 1, indexed: 2, read: { a: 1, b: 2 }, proposed: ["c"] });
    const parent = new MemoryUse(2);
    parent.absorb(u.counters());
    expect(parent.counters()!.read).toEqual({ a: 1, b: 2 });
    const solo = new MemoryUse(0);
    solo.noteRead("z");
    expect(solo.counters()).toEqual({ v: 1, indexed: 0, read: { z: 1 }, proposed: [] });
  });

  it("loadMemory ignores a symlinked directory and symlinked or oversized files", () => {
    const { root, config } = surface();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "x.md"), renderMemory({ name: "x", description: "d", body: "b", provenance: "p", created: "c" }));
    symlinkSync(outside, join(root, ".gnomon", "memory"));
    expect(loadMemory(config)).toEqual([]);
    rmSync(join(root, ".gnomon", "memory"));
    mkdirSync(join(root, ".gnomon", "memory"));
    symlinkSync(join(outside, "x.md"), join(root, ".gnomon", "memory", "link.md"));
    writeFileSync(join(root, ".gnomon", "memory", "big.md"), "x".repeat(40 * 1024));
    expect(loadMemory(config)).toEqual([]);
  });
});

describe("conformance/proposals.json", () => {
  const FX = JSON.parse(readFileSync(new URL("../../../conformance/proposals.json", import.meta.url), "utf-8"));

  it("names the constants the code uses", () => {
    expect(FX.dir).toBe(PROPOSALS_DIR);
    expect([...PROPOSAL_KINDS]).toEqual(FX.proposal.kinds);
    expect([...PROPOSAL_SOURCES]).toEqual(FX.proposal.sources);
    expect([...PROPOSAL_STATUSES]).toEqual(FX.proposal.statuses);
    expect(PROPOSAL_ID.source).toBe(FX.proposal.id);
    expect({ ...PROPOSAL_LIMITS }).toEqual(FX.proposal.limits);
    expect([...DEFAULT_HARNESS_PATHS]).toEqual(FX.paths.harness_default);
    expect({ ...MEMORY_LIMITS }).toEqual(FX.memory.limits);
  });

  it("a written proposal has exactly the declared fields", () => {
    const { config } = surface();
    const p = proposeMemory(config, { name: "N", description: "d", body: "b", source_trail: "t-1", source_seq: 1 });
    for (const k of FX.proposal.required) expect(p, k).toHaveProperty(k);
    expect(Object.keys(p).filter((k) => !FX.proposal.required.includes(k) && !FX.proposal.optional.includes(k))).toEqual([]);
    expect(Object.keys(p.diff[0]!)).toEqual(FX.proposal.diff_entry);
    expect(p.id).toMatch(new RegExp(FX.proposal.id));
  });

  it("a decision record has the declared fields, in a trail whose first record has the declared mode", () => {
    const { config } = surface();
    const p = proposeMemory(config, { name: "N", description: "d", body: "b" });
    const d = acceptProposal(config, p.id);
    const recs = readFileSync(d.trail!, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs[0].mode).toBe(FX.audit.session_start_mode);
    expect(recs[1].kind).toBe(FX.audit.kind);
    for (const k of FX.audit.fields) expect(recs[1], k).toHaveProperty(k);
    const schema = JSON.parse(readFileSync(new URL("../../../conformance/audit_record_schema.json", import.meta.url), "utf-8"));
    const known = new Set([...Object.keys(schema.kinds[FX.audit.kind].required), ...Object.keys(schema.kinds[FX.audit.kind].optional)]);
    for (const k of Object.keys(recs[1])) if (!["seq", "ts", "kind", "prev", "hash"].includes(k)) expect(known.has(k), k).toBe(true);
    expect(FX.refusals.surface_moved).toBe("the surface moved; re-propose");
  });
});

/**
 * gnomon-core: skill candidates mined from audit trails
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTrail, type AuditRecord, type ResolvedAudit } from "./audit.js";
import { recomputeManifest } from "./config.js";
import {
  mineCandidates,
  writeCandidates,
  loadCandidates,
  classifyRefusal,
  pathPattern,
  CANDIDATE_SIGNALS,
} from "./skill_mine.js";
import {
  readPrecheck,
  bashPrecheck,
  webfetchPrecheck,
  writePrecheck,
  executeTool,
  ARGS_MALFORMED,
  POLICY_RULES,
  type Precheck,
  type ToolContext,
} from "./tools.js";

let root: string;
/**
 * The policy rules a tool refuses with. `repo_code` (#136) is published in the
 * same list but its decision is `ask`, never a refusal (CONTRACTS.md §10): a
 * call it holds is asked about, and declining it is a declined approval, which
 * names no rule. So no refusal carries it and no candidate can.
 */
const REFUSING_RULES = POLICY_RULES.filter((r) => r !== "repo_code");

const cfg = (): any => ({ gnomonDir: join(root, ".gnomon"), config: { audit: {} } });
const settings = (): ResolvedAudit => ({
  enabled: true,
  dir: join(root, ".gnomon-audit"),
  record: "metadata",
  redact: [],
  chain: true,
  invalid_redact: [],
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-mine-"));
  mkdirSync(join(root, ".gnomon"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A write the role's write_allow refused, recorded the way the loop records it. */
const refusedWrite = (t: AuditTrail, path: string, role = "implement"): AuditRecord =>
  t.write("tool_call", {
    role,
    tool: "write",
    target: path,
    gated: true,
    code: 2,
    bucket: "refusal",
    summary: `write ${path} — not permitted for this role`,
  })!;

describe("gnomon skill mine", () => {
  it("four write_allow refusals of one path pattern yield exactly one candidate, pointing at them", () => {
    // Fails on master: there is no miner, so the record of an agent being
    // refused the same thing again and again is read by nobody. Spread over
    // three sessions, the least that counts as a pattern.
    const s1 = new AuditTrail(settings(), "s1");
    s1.write("session_start", { mode: "task" });
    const a = refusedWrite(s1, "generated/api.ts");
    // Noise: an allowed write to the same place, a refusal elsewhere, and two
    // bash_deny refusals, under the threshold of three.
    s1.write("tool_call", { role: "implement", tool: "write", target: "src/ok.ts", code: 0, bucket: "result", summary: "write src/ok.ts — 3 lines" });
    s1.write("tool_call", { role: "implement", tool: "write", target: "docs/x.md", code: 2, bucket: "refusal", summary: "write docs/x.md — not permitted for this role" });
    const b = refusedWrite(s1, "generated/types.ts");
    for (let i = 0; i < 2; i++) {
      s1.write("tool_call", { role: "implement", tool: "bash", target: "git push", code: 2, bucket: "refusal", summary: "bash — denied by bash_deny (/git push/)" });
    }
    s1.write("session_end", {});

    const s2 = new AuditTrail(settings(), "s2");
    s2.write("session_start", { mode: "task" });
    // A person declining an approval is a refusal too, and NOT this signal.
    s2.write("tool_call", { role: "implement", tool: "write", target: "generated/x.ts", code: 2, bucket: "refusal", summary: "write generated/x.ts — denied" });
    const c = refusedWrite(s2, "generated/client.ts");
    s2.write("session_end", {});
    const s3 = new AuditTrail(settings(), "s3");
    const d = refusedWrite(s3, "./generated/schema.ts");

    const before = recomputeManifest(join(root, ".gnomon")).surface_hash;
    const found = mineCandidates(cfg());

    expect(found).toHaveLength(1);
    const [cand] = found;
    expect(cand).toMatchObject({
      signal: "repeated_refusal",
      rule: "write_allow",
      role: "implement",
      tools: ["write"],
      pattern: "generated/*.ts",
      count: 4,
      sessions: 3,
    });
    expect(cand.records).toEqual(
      [
        ["s1", a],
        ["s1", b],
        ["s2", c],
        ["s3", d],
      ].map(([trail, r]) => ({
        trail: `.gnomon-audit/${trail}.jsonl`,
        seq: (r as AuditRecord).seq,
        hash: (r as AuditRecord).hash,
      }))
    );

    // Written outside .gnomon/: the surface hash does not move.
    const w = writeCandidates(cfg(), found);
    expect(w.fresh).toEqual([cand.id]);
    expect(readdirSync(join(root, ".gnomon-skills", "candidates"))).toEqual([`${cand.id}.json`]);
    expect(recomputeManifest(join(root, ".gnomon")).surface_hash).toBe(before);
    expect(existsSync(join(root, ".gnomon", "skills"))).toBe(false);
  });

  it("is deterministic and makes no model call: the same trails give the same bytes", () => {
    for (const [i, p] of ["gen/a.rs", "gen/b.rs", "gen/c.rs"].entries()) {
      refusedWrite(new AuditTrail(settings(), `s${i}`), p, "verifier");
    }
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("mine must not call a model");
    }) as typeof fetch;
    try {
      const first = writeCandidates(cfg(), mineCandidates(cfg()));
      const file = join(first.dir, `${first.written[0]}.json`);
      const bytes = readFileSync(file, "utf-8");
      const again = writeCandidates(cfg(), mineCandidates(cfg()));
      expect(readFileSync(file, "utf-8")).toBe(bytes);
      // Known now, so not fresh: the nudge would not repeat itself.
      expect(again.fresh).toEqual([]);
      expect(loadCandidates(cfg()).map((c) => c.id)).toEqual(first.written);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("counts per role and per rule: different roles are not one pattern", () => {
    refusedWrite(new AuditTrail(settings(), "s1"), "gen/a.ts", "implement");
    refusedWrite(new AuditTrail(settings(), "s2"), "gen/b.ts", "implement");
    refusedWrite(new AuditTrail(settings(), "s3"), "gen/c.ts", "verifier");
    expect(mineCandidates(cfg())).toEqual([]);
  });

  it("counts sessions, not records: one session refused five times is not a pattern", () => {
    // Fails on the first version, which counted records: five retries inside
    // one session made a candidate.
    const t = new AuditTrail(settings(), "s1");
    for (const p of ["gen/a.ts", "gen/b.ts", "gen/c.ts", "gen/d.ts", "gen/e.ts"]) refusedWrite(t, p);
    refusedWrite(new AuditTrail(settings(), "s2"), "gen/f.ts");
    expect(mineCandidates(cfg())).toEqual([]);
    refusedWrite(new AuditTrail(settings(), "s3"), "gen/g.ts");
    expect(mineCandidates(cfg())).toHaveLength(1);
  });

  it("a role read from a trail cannot steer the candidate's file name", () => {
    // Fails on the first version: the role went into the id verbatim, and
    // the id into a path, so "../../x" wrote outside candidates/.
    for (const s of ["s1", "s2", "s3"]) refusedWrite(new AuditTrail(settings(), s), "gen/a.ts", "../../x");
    const found = mineCandidates(cfg());
    expect(found).toHaveLength(1);
    expect(found[0].id).toMatch(/^refusal-write_allow-x-[0-9a-f]{10}$/);
    expect(found[0].role).toBe("../../x");
    writeCandidates(cfg(), found);
    expect(readdirSync(join(root, ".gnomon-skills", "candidates"))).toEqual([`${found[0].id}.json`]);
  });

  it("reads bash_deny and the bash form of write_allow off their summaries", () => {
    expect(
      classifyRefusal({ kind: "tool_call", bucket: "refusal", tool: "bash", target: "git push -f", summary: "bash — denied by bash_deny (/git push/)" })
    ).toEqual({ rule: "bash_deny", pattern: "/git push/" });
    expect(
      classifyRefusal({ kind: "tool_call", bucket: "refusal", tool: "bash", target: "echo x > gen/a.ts", summary: "bash — writes gen/a.ts, not permitted for this role" })
    ).toEqual({ rule: "write_allow", pattern: "gen/*.ts" });
    // A recorded rule is believed over the summary.
    expect(
      classifyRefusal({ kind: "tool_call", bucket: "refusal", tool: "read", target: "/etc/passwd", rule: "sandbox", summary: "anything" })
    ).toEqual({ rule: "sandbox", pattern: "/etc/*" });
    // The `record` rule: a write into gnomon's own trail.
    expect(
      classifyRefusal({ kind: "tool_call", bucket: "refusal", tool: "write", target: ".gnomon-audit/a.jsonl", summary: "write .gnomon-audit/a.jsonl — refused (gnomon's records)" })
    ).toEqual({ rule: "record", pattern: ".gnomon-audit/*.jsonl" });
    // Not a refusal, or not a policy one: nothing.
    expect(classifyRefusal({ kind: "tool_call", bucket: "result", summary: "write a — 1 lines" })).toBeNull();
    expect(classifyRefusal({ kind: "tool_call", bucket: "refusal", tool: "write", summary: "write a — denied" })).toBeNull();
  });

  it("reads back the rule of every precheck that refuses with one, for every published policy rule", async () => {
    // Each case is produced by the real precheck, so a summary that changes
    // form, or a rule added to POLICY_RULES with no form here, fails this test
    // instead of turning up as "no rule named" in a dashboard.
    const base: ToolContext = {
      root,
      sandbox: "confined",
      gate: "never",
      approve: async () => true,
      timeoutMs: 10_000,
      maxOutputBytes: 32_000,
    };
    const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ ...base, ...over });
    // `git_hooks` guards the hooks and config of a repository that exists.
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    type Case = { tool: string; target: string; pre: { rule?: string; summary: string } | null };
    const refusalOf = (r: { refusal: Precheck } | object) => ("refusal" in r ? (r.refusal as Precheck) : null);
    const cases: Case[] = [
      { tool: "read", target: "", pre: refusalOf(readPrecheck({}, ctx())) },
      { tool: "read", target: "/etc/passwd", pre: refusalOf(readPrecheck({ path: "/etc/passwd" }, ctx())) },
      { tool: "bash", target: "5", pre: bashPrecheck({ command: 5 }, ctx()) },
      { tool: "bash", target: "git push --force", pre: bashPrecheck({ command: "git push --force" }, ctx({ bashDeny: ["git push"] })) },
      { tool: "bash", target: "ls", pre: bashPrecheck({ command: "ls" }, ctx({ bashDeny: ["("] })) },
      { tool: "bash", target: "rm -rf x", pre: bashPrecheck({ command: "rm -rf x" }, ctx({ bashAllow: ["ls"] })) },
      { tool: "bash", target: "sudo ls", pre: bashPrecheck({ command: "sudo ls" }, ctx()) },
      { tool: "bash", target: "curl https://example.com", pre: bashPrecheck({ command: "curl https://example.com" }, ctx({ network: false })) },
      { tool: "bash", target: "echo x > gen/a.ts", pre: bashPrecheck({ command: "echo x > gen/a.ts" }, ctx({ writeAllow: ["src/**"] })) },
      { tool: "bash", target: "echo x > .gnomon-audit/a.jsonl", pre: bashPrecheck({ command: "echo x > .gnomon-audit/a.jsonl" }, ctx()) },
      { tool: "webfetch", target: "", pre: refusalOf(await webfetchPrecheck({ url: "https://example.com/x" }, ctx({ network: false }))) },
      { tool: "webfetch", target: "", pre: refusalOf(await webfetchPrecheck({ url: "file:///etc/passwd" }, ctx())) },
      { tool: "webfetch", target: "", pre: refusalOf(await webfetchPrecheck({ url: "http://127.0.0.1:9/" }, ctx())) },
      { tool: "write", target: "a.ts", pre: refusalOf(writePrecheck("write", { path: "a.ts" }, ctx())) },
      { tool: "write", target: "/etc/x", pre: refusalOf(writePrecheck("write", { path: "/etc/x", content: "" }, ctx())) },
      { tool: "edit", target: ".gnomon/roles.toml", pre: refusalOf(writePrecheck("edit", { path: ".gnomon/roles.toml" }, ctx())) },
      { tool: "write", target: "gen/a.ts", pre: refusalOf(writePrecheck("write", { path: "gen/a.ts", content: "" }, ctx({ writeAllow: ["src/**"] }))) },
      { tool: "write", target: ".gnomon-audit/a.jsonl", pre: refusalOf(writePrecheck("write", { path: ".gnomon-audit/a.jsonl", content: "" }, ctx())) },
      { tool: "write", target: ".git/hooks/pre-commit", pre: refusalOf(writePrecheck("write", { path: ".git/hooks/pre-commit", content: "" }, ctx())) },
      { tool: "bash", target: "echo x > .git/hooks/pre-commit", pre: bashPrecheck({ command: "echo x > .git/hooks/pre-commit" }, ctx()) },
      { tool: "write", target: ".claude/settings.json", pre: refusalOf(writePrecheck("write", { path: ".claude/settings.json", content: "{}" }, ctx())) },
      { tool: "bash", target: "rm -f .opencode/plugins/gnomon-guard.js", pre: bashPrecheck({ command: "rm -f .opencode/plugins/gnomon-guard.js" }, ctx()) },
    ];
    // Two refusals come from executeTool itself rather than a precheck: a tool
    // the role was not given, and arguments that are not one JSON object.
    const notGiven = await executeTool("webfetch", { url: "https://example.com" }, ctx(), new Set(["read"]));
    cases.push({ tool: "webfetch", target: "", pre: { rule: "tools", summary: notGiven.summary } });
    const garbled = await executeTool("read", { [ARGS_MALFORMED]: { raw: "{'path': 'a'}", error: "Unexpected token" } }, ctx(), new Set(["read"]));
    cases.push({ tool: "read", target: "", pre: { rule: "malformed", summary: garbled.summary } });

    const seen = new Set<string>();
    for (const c of cases) {
      expect(c.pre?.rule, `${c.tool} ${c.target}: the precheck did not refuse with a rule`).toBeTruthy();
      const read = classifyRefusal({ kind: "tool_call", bucket: "refusal", tool: c.tool, target: c.target, summary: c.pre!.summary });
      expect(read?.rule, c.pre!.summary).toBe(c.pre!.rule);
      expect(read?.pattern, c.pre!.summary).not.toBe("");
      seen.add(c.pre!.rule!);
    }
    expect([...seen].sort()).toEqual([...REFUSING_RULES].sort());

    // The patterns a candidate is counted by, for the forms added in 2026-11.
    const at = (summary: string, tool = "webfetch") => classifyRefusal({ kind: "tool_call", bucket: "refusal", tool, target: "", summary });
    expect(at("webfetch — not available to this role")).toEqual({ rule: "tools", pattern: "webfetch" });
    expect(at("read — malformed arguments (Unexpected token)", "read")).toEqual({ rule: "malformed", pattern: "read" });
    expect(at("webfetch https://example.com/x — refused (network disabled)")).toEqual({ rule: "network", pattern: "example.com" });
    expect(at("webfetch — file: refused")).toEqual({ rule: "url", pattern: "file:" });
    expect(at("webfetch 10.0.0.1 — refused (private address)")).toEqual({ rule: "url", pattern: "10.0.0.1" });
  });

  it("still reads no rule for what no published rule names: a declined approval, a delegation outside task_allow", () => {
    const at = (tool: string, summary: string) => classifyRefusal({ kind: "tool_call", bucket: "refusal", tool, target: "", summary });
    for (const [tool, summary] of [
      ["bash", "bash — denied"],
      ["write", "write a.ts — surface edit denied"],
      ["task", "task implement — denied"],
      ["task", "task — refused (implement not in task_allow)"],
      ["task", "task — refused (already a sub-turn)"],
      ["write", "write a.ts — refused (changed under the prompt)"],
    ]) {
      expect(at(tool!, summary!), summary).toBeNull();
    }
  });

  it("mines the newly read rules like any other: a tool refused in three sessions is one candidate", () => {
    for (const s of ["s1", "s2", "s3"]) {
      new AuditTrail(settings(), s).write("tool_call", {
        role: "plan", tool: "write", target: "a.ts", gated: false, code: 4, bucket: "refusal",
        summary: "write — not available to this role",
      });
    }
    const found = mineCandidates(cfg());
    expect(found.map((c) => [c.rule, c.role, c.pattern, c.sessions])).toEqual([["tools", "plan", "write", 3]]);
  });

  it("path patterns keep the directory and the extension", () => {
    expect(pathPattern("generated/a.ts")).toBe("generated/*.ts");
    expect(pathPattern("./x/y/z.test.ts")).toBe("x/y/*.ts");
    expect(pathPattern("Makefile")).toBe("*");
    expect(pathPattern("src\\win\\a.rs")).toBe("src/win/*.rs");
  });

  it("publishes only the signals it can emit, as conformance/skill_candidate.json says", () => {
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "..", "..", "conformance", "skill_candidate.json"), "utf-8")
    );
    expect([...CANDIDATE_SIGNALS]).toEqual(fixture.signals);
    // The rules a candidate can carry are exactly the policy rules a tool
    // refuses with, each read back by the parity test above.
    expect([...REFUSING_RULES]).toEqual(fixture.rules);
    for (const [i, p] of ["g/a.ts", "g/b.ts", "g/c.ts"].entries()) refusedWrite(new AuditTrail(settings(), `s${i}`), p);
    const [c] = mineCandidates(cfg());
    expect(Object.keys(c).sort()).toEqual([...fixture.keys].sort());
    expect(Object.keys(c.records[0]).sort()).toEqual([...fixture.record_pointer_keys].sort());
    expect(c.count).toBeGreaterThanOrEqual(fixture.min_repeats);
  });
});

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

let root: string;
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
    // refused the same thing again and again is read by nobody.
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
    const d = refusedWrite(s2, "./generated/schema.ts");
    s2.write("session_end", {});

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
      sessions: 2,
    });
    expect(cand.records).toEqual(
      [
        ["s1", a],
        ["s1", b],
        ["s2", c],
        ["s2", d],
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
    const t = new AuditTrail(settings(), "s");
    for (const p of ["gen/a.rs", "gen/b.rs", "gen/c.rs"]) refusedWrite(t, p, "verifier");
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
    const t = new AuditTrail(settings(), "s");
    refusedWrite(t, "gen/a.ts", "implement");
    refusedWrite(t, "gen/b.ts", "implement");
    refusedWrite(t, "gen/c.ts", "verifier");
    expect(mineCandidates(cfg())).toEqual([]);
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
    // Not a refusal, or not a policy one: nothing.
    expect(classifyRefusal({ kind: "tool_call", bucket: "result", summary: "write a — 1 lines" })).toBeNull();
    expect(classifyRefusal({ kind: "tool_call", bucket: "refusal", tool: "write", summary: "write a — denied" })).toBeNull();
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
    const t = new AuditTrail(settings(), "s");
    for (const p of ["g/a.ts", "g/b.ts", "g/c.ts"]) refusedWrite(t, p);
    const [c] = mineCandidates(cfg());
    expect(Object.keys(c).sort()).toEqual([...fixture.keys].sort());
    expect(Object.keys(c.records[0]).sort()).toEqual([...fixture.record_pointer_keys].sort());
    expect(c.count).toBeGreaterThanOrEqual(fixture.min_repeats);
  });
});

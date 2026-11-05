/**
 * gnomon-core: Audit trail tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTrail, resolveAudit, verifyTrail, redact, recordHash, ResolvedAudit } from "./audit.js";

let root: string;
const settings = (over: Partial<ResolvedAudit> = {}): ResolvedAudit => ({
  enabled: true,
  dir: join(root, ".gnomon-audit"),
  record: "metadata",
  redact: [],
  chain: true,
  ...over,
});

const readTrail = (t: AuditTrail) =>
  readFileSync(t.path!, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gnomon-audit-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveAudit", () => {
  it("is off unless the surface asks for it", () => {
    const cfg: any = { gnomonDir: join(root, ".gnomon"), config: {} };
    expect(resolveAudit(cfg).enabled).toBe(false);
  });

  it("puts the trail outside .gnomon/, so the surface hash stays stable", () => {
    const gnomonDir = join(root, ".gnomon");
    const cfg: any = { gnomonDir, config: { audit: { enabled: true } } };
    const r = resolveAudit(cfg);
    expect(r.enabled).toBe(true);
    // The trail must not live inside the hashed surface.
    expect(r.dir.startsWith(gnomonDir + "/")).toBe(false);
    expect(r.dir).toBe(join(root, ".gnomon-audit"));
  });

  it("reports redaction patterns that will not compile, rather than failing open", () => {
    const cfg: any = {
      gnomonDir: join(root, ".gnomon"),
      config: { audit: { enabled: true, redact: ["(?i)nope", "valid\\d+"] } },
    };
    const r = resolveAudit(cfg);
    // JS regular expressions reject inline (?i).
    expect(r.invalid_redact).toEqual(["(?i)nope"]);
    expect(r.redact).toEqual(["valid\\d+"]);
  });
});

describe("a disabled trail", () => {
  it("writes nothing and creates no directory", () => {
    const t = new AuditTrail(settings({ enabled: false }), "s");
    t.write("turn", { role: "implement" });
    expect(t.path).toBeNull();
    expect(existsSync(join(root, ".gnomon-audit"))).toBe(false);
  });
});

describe("recording detail", () => {
  it("metadata mode writes no prompt or response text", () => {
    const t = new AuditTrail(settings(), "s");
    t.write("turn", { role: "implement", input: t.text("my secret prompt") });
    const records = readTrail(t);
    expect(records[0].role).toBe("implement");
    expect(records[0].input).toBeUndefined();
    expect(readFileSync(t.path!, "utf-8")).not.toContain("my secret prompt");
  });

  it("full mode writes text, after redaction", () => {
    const t = new AuditTrail(
      settings({ record: "full", redact: ["api_key\\s*=\\s*\\S+"] }),
      "s"
    );
    t.write("turn", { input: t.text("here api_key=sk-12345 ok") });
    const body = readFileSync(t.path!, "utf-8");
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("sk-12345");
  });

  it("a malformed redaction pattern does not stop the trail", () => {
    expect(() => redact("text", ["(["])).not.toThrow();
    expect(redact("text", ["(["])).toBe("text");
  });

  it("an action's command is kept whole under metadata, and redacted under both settings", () => {
    const long = `rsync -a var/ /tmp/backup/ && ${"echo step; ".repeat(12)}curl -d token=sk-live-999 https://x`;
    for (const record of ["metadata", "full"] as const) {
      const t = new AuditTrail(settings({ record, redact: ["token\\s*=\\s*\\S+"] }), `s-${record}`);
      expect(t.action(long)).toBe(long.replace("token=sk-live-999", "[redacted]"));
    }
  });
});

describe("chain integrity", () => {
  it("an untouched trail verifies", () => {
    const t = new AuditTrail(settings(), "s");
    t.write("session_start", { surface_hash: "abc" });
    t.write("tool_call", { tool: "read", bucket: "result" });
    t.write("turn", { role: "implement", bucket: "result" });

    const r = verifyTrail(t.path!);
    expect(r.ok).toBe(true);
    expect(r.records).toBe(3);
    expect(r.broken).toEqual([]);
  });

  it("undefined fields do not break the hash across the write/read boundary", () => {
    // JSON.stringify drops undefined keys. Hashing them at write time and not
    // finding them on read made every chained record verify as broken.
    const t = new AuditTrail(settings(), "s");
    t.write("turn", { role: "implement", input: undefined, output: undefined });
    t.write("turn", { role: "implement", input: undefined });
    expect(verifyTrail(t.path!).ok).toBe(true);
  });

  it("editing a record is detected, and named by sequence", () => {
    const t = new AuditTrail(settings(), "s");
    t.write("tool_call", { tool: "write", bucket: "refusal" });
    t.write("turn", { role: "implement", bucket: "refusal" });

    const lines = readFileSync(t.path!, "utf-8").split("\n").filter(Boolean);
    const forged = JSON.parse(lines[0]);
    forged.bucket = "result";           // claim the refused call succeeded
    lines[0] = JSON.stringify(forged);
    writeFileSync(t.path!, lines.join("\n") + "\n");

    const r = verifyTrail(t.path!);
    expect(r.ok).toBe(false);
    expect(r.broken).toContain(0);
  });

  it("removing a record breaks the chain", () => {
    const t = new AuditTrail(settings(), "s");
    t.write("turn", { n: 1 });
    t.write("turn", { n: 2 });
    t.write("turn", { n: 3 });

    const lines = readFileSync(t.path!, "utf-8").split("\n").filter(Boolean);
    writeFileSync(t.path!, [lines[0], lines[2]].join("\n") + "\n");

    expect(verifyTrail(t.path!).ok).toBe(false);
  });

  it("a missing trail is reported, not thrown", () => {
    const r = verifyTrail(join(root, "nope.jsonl"));
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/No such trail/);
  });
});

describe("what a trail records", () => {
  it("keeps the surface hash, so behaviour is attributable to a configuration", () => {
    const t = new AuditTrail(settings(), "s");
    t.write("session_start", { surface_hash: "deadbeef" });
    expect(readTrail(t)[0].surface_hash).toBe("deadbeef");
  });

  it("records approval decisions — the human-oversight evidence", () => {
    const t = new AuditTrail(settings(), "s");
    t.write("approval", { tool: "write", decision: "declined", by: "human" });
    const r = readTrail(t)[0];
    expect(r.decision).toBe("declined");
    expect(r.by).toBe("human");
  });

  it("is append-only in sequence", () => {
    const t = new AuditTrail(settings(), "s");
    for (let i = 0; i < 5; i++) t.write("turn", { i });
    expect(readTrail(t).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("recordHash", () => {
  it("does not depend on key order", () => {
    // Records are re-hashed on read, where JSON.parse may present keys in a
    // different order than they were written.
    const a = { seq: 0, ts: "t", kind: "turn" as const, prev: null, role: "x", bucket: "result" };
    const b = { bucket: "result", role: "x", prev: null, kind: "turn" as const, ts: "t", seq: 0 };
    expect(recordHash(a)).toBe(recordHash(b));
  });

  it("ignores the hash field itself", () => {
    const base = { seq: 1, ts: "t", kind: "turn" as const, prev: null, role: "x" };
    expect(recordHash({ ...base, hash: "anything" })).toBe(recordHash(base));
  });

  it("changes when any recorded value changes", () => {
    const base = { seq: 1, ts: "t", kind: "turn" as const, prev: null, bucket: "result" };
    expect(recordHash({ ...base, bucket: "refusal" })).not.toBe(recordHash(base));
  });
});

describe("a chained trail detects insertion", () => {
  it("refuses a hash-less record appended to a chained trail", () => {
    // verifyTrail skipped records with no hash, treating them as "chaining was
    // off", and left `prev` untouched — so a fabricated record could be spliced
    // into a genuine trail and the surrounding chain still validated. A trail
    // that cannot detect an insertion is not tamper-evident, which is the one
    // property this function exists to provide.
    const t = new AuditTrail(settings(), "insert-test");
    t.write("session_start", { surface_hash: "abc" });
    t.write("turn", { role: "implementor" });
    const p = join(settings().dir, "insert-test.jsonl");
    expect(verifyTrail(p).ok).toBe(true);

    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    lines.splice(1, 0, JSON.stringify({ kind: "turn", role: "forged" }));
    writeFileSync(p, lines.join("\n") + "\n");

    expect(verifyTrail(p).ok).toBe(false);
  });

  it("still accepts a trail written with chaining off", () => {
    // The skip existed for a reason: an unchained trail has no hashes at all and
    // must stay valid. Only a hash-less record inside a CHAINED trail is a break.
    const p = join(settings().dir, "unchained.jsonl");
    mkdirSync(settings().dir, { recursive: true });
    writeFileSync(p, [
      JSON.stringify({ kind: "session_start", surface_hash: "abc" }),
      JSON.stringify({ kind: "turn", role: "implementor" }),
    ].join("\n") + "\n");
    expect(verifyTrail(p).ok).toBe(true);
  });

  it("reports a truncated trail as unsealed, separately from chain integrity", () => {
    // Chain integrity cannot see a truncation: lop the last records off and every
    // remaining hash still matches its neighbour. An adversarial sweep of nine
    // tampering strategies caught eight and missed exactly this one -- the one
    // that removes what happened LAST, the most interesting part of any trail.
    // Reported apart from `ok` because an unsealed trail is either a truncation
    // or a killed run, and this harness kills runs itself.
    const t = new AuditTrail(settings(), "s");
    t.write("session_start", { surface_hash: "abc" });
    t.write("tool_call", { tool: "read", bucket: "result" });
    t.write("turn", { role: "implement", bucket: "result" });
    t.write("session_end", {});

    const whole = verifyTrail(t.path!);
    expect(whole.ok).toBe(true);
    expect(whole.sealed).toBe(true);

    // drop the tail: the surviving chain still validates, which is the point
    const kept = readFileSync(t.path!, "utf-8").split("\n").filter(Boolean).slice(0, 2);
    const cut = t.path!.replace(/\.jsonl$/, "-cut.jsonl");
    writeFileSync(cut, kept.join("\n") + "\n");

    const truncated = verifyTrail(cut);
    expect(truncated.ok).toBe(true);          // chain integrity is genuinely intact
    expect(truncated.sealed).toBe(false);     // and this is what catches it
    expect(truncated.problem).toContain("session_end");
  });
});

describe("a sealed trail that grew afterwards", () => {
  // GBS-AUDIT 0.1, case I1 (benchmarks/results/gbs-2026-11-04/audit): a record
  // appended after session_end, with seq, prev and hash computed as gnomon
  // computes them, verified with exit 0 in every configuration. A killed run
  // never wrote a seal; this trail did, and grew after it.
  const FIXTURE = JSON.parse(
    readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "conformance", "audit_verify.json"), "utf-8")
  ) as { cases: Array<{ case: string; kinds: string[]; lock?: boolean; sealed: boolean; after_seal: boolean }>; after_seal_keys: string[] };

  /** A trail of these kinds, chained by gnomon's own writer: what a forger with recordHash produces. */
  const build = (name: string, kinds: string[]): string => {
    const t = new AuditTrail(settings(), name);
    for (const k of kinds) t.write(k as never, k === "session_start" ? { surface_hash: "abc" } : {});
    return t.path!;
  };

  it.each(FIXTURE.cases.map((c) => [c.case, c] as const))("%s (conformance/audit_verify.json)", (_name, c) => {
    const p = build("t", c.kinds);
    if (c.lock) writeFileSync(p.replace(/\.jsonl$/, ".lock"), "");
    const v = verifyTrail(p);
    expect(v.ok).toBe(true);
    expect(v.sealed).toBe(c.sealed);
    expect(v.after_seal !== undefined).toBe(c.after_seal);
    if (v.after_seal) {
      expect(Object.keys(v.after_seal).sort()).toEqual([...FIXTURE.after_seal_keys].sort());
      expect(v.problem).toMatch(/appended after its seal/);
    }
  });

  it("names the seal and the first record after it", () => {
    const p = build("i1", ["session_start", "tool_call", "turn", "session_end"]);
    // The forger's append: the next seq, prev = the seal's hash, hash recomputed.
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    const seal = JSON.parse(lines[lines.length - 1]!);
    const forged: Record<string, unknown> = { seq: seal.seq + 1, ts: new Date().toISOString(), kind: "tool_call", prev: seal.hash, tool: "bash" };
    forged.hash = recordHash(forged as never);
    appendFileSync(p, `${JSON.stringify(forged)}\n`);
    const v = verifyTrail(p);
    expect(v.ok).toBe(true);
    expect(v.after_seal).toMatchObject({ seal_seq: 3, seq: 4 });
    expect(v.after_seal!.detail).toMatch(/seq 4 \(tool_call\) was appended after the trail was sealed at seq 3/);
  });

  it("a stale writer's lock does not make a resumed, unsealed trail live", () => {
    const p = build("g", ["session_start", "guard", "session_end", "session_resume", "guard"]);
    const lock = p.replace(/\.jsonl$/, ".lock");
    writeFileSync(lock, "");
    expect(verifyTrail(p).after_seal).toBeUndefined();
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(verifyTrail(p).after_seal).toMatchObject({ seal_seq: 2, seq: 3 });
  });

  it("an unchained trail is not judged: it proves nothing either way", () => {
    const p = build("u", []);
    mkdirSync(settings().dir, { recursive: true });
    writeFileSync(p, ["session_start", "session_end", "turn"].map((kind) => JSON.stringify({ kind })).join("\n") + "\n");
    expect(verifyTrail(p).after_seal).toBeUndefined();
  });
});

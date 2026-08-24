/**
 * gnomon-core: Audit trail tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

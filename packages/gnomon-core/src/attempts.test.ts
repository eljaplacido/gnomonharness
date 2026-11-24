/**
 * gnomon-core: [attempts] and the evidence selector (attempts.ts, CONTRACTS §60)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTEMPTS_KEYS, resolveAttempts, selectBest, type AttemptEvidence } from "./attempts.js";
import { AUDIT_KINDS } from "./audit.js";
import type { GnomonConfig } from "./config.js";

const cfg = (attempts?: object) => ({ policy: attempts ? { attempts } : {} }) as unknown as GnomonConfig;
const ev = (o: Partial<AttemptEvidence> & { attempt: number }): AttemptEvidence => ({ bucket: "result", check_exit: 1, changed_lines: 5, tokens: 100, ...o });

describe("resolveAttempts", () => {
  it("defaults to max 3 and no budgets", () => {
    expect(resolveAttempts(cfg())).toEqual({ max: 3, max_tokens: 0, max_wall_seconds: 0, max_parallel: 0, roles: [] });
  });
  it("reads the declared block", () => {
    const r = resolveAttempts(cfg({ max: 5, max_tokens: 10, check: " make test ", roles: ["a", 2, "b"] }));
    expect(r).toMatchObject({ max: 5, max_tokens: 10, check: "make test", roles: ["a", "b"] });
  });
});

describe("selectBest", () => {
  it("offers nothing when no attempt changed anything", () => {
    expect(selectBest([ev({ attempt: 1, changed_lines: 0 })])).toBeNull();
  });
  it("prefers a passed check, then a result, then the smaller patch, then fewer tokens", () => {
    expect(selectBest([ev({ attempt: 1 }), ev({ attempt: 2, check_exit: 0, changed_lines: 50 })])!.attempt).toBe(2);
    expect(selectBest([ev({ attempt: 1, bucket: "refusal", changed_lines: 1 }), ev({ attempt: 2 })])!.attempt).toBe(2);
    expect(selectBest([ev({ attempt: 1, changed_lines: 9 }), ev({ attempt: 2, changed_lines: 3 })])!.attempt).toBe(2);
    expect(selectBest([ev({ attempt: 1, tokens: 9 }), ev({ attempt: 2, tokens: 3 })])!.attempt).toBe(2);
    expect(selectBest([ev({ attempt: 2 }), ev({ attempt: 1 })])!.attempt).toBe(1);
  });
  it("says unverified when the check did not pass", () => {
    expect(selectBest([ev({ attempt: 1 })])!.reason).toContain("unverified");
    expect(selectBest([ev({ attempt: 1, check_exit: 0 })])!.reason).not.toContain("unverified");
  });
});

describe("the contract fixture", () => {
  const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance", "attempts.json"), "utf-8"));
  it("names the keys and the audit kind the code has", () => {
    expect(fx.policy_block.keys).toEqual([...ATTEMPTS_KEYS]);
    expect(AUDIT_KINDS).toContain(fx.audit.kind);
    expect(AUDIT_KINDS.indexOf("attempt_event")).toBe(AUDIT_KINDS.length - 2);
  });
});

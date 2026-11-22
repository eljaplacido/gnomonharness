/**
 * `gnomon check --policy-lint` / `--strict-policy`: lint findings are warnings
 * (exit 0) unless the caller asked for strict (exit 2). The lint itself is
 * pinned by conformance/policy_lint.json in gnomon-core.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdCheck } from "./check.js";

describe("gnomon check --policy-lint", () => {
  let bad: string;
  let clean: string;
  beforeAll(() => {
    bad = mkdtempSync(join(tmpdir(), "gnomon-lint-bad-"));
    mkdirSync(join(bad, ".gnomon"));
    writeFileSync(
      join(bad, ".gnomon/roles.toml"),
      `[roles.dev]\nmodel = "m"\ntools = ["bash"]\nbash_allow = ["git status"]\nbash_deny = ["git status"]\n`
    );
    writeFileSync(join(bad, ".gnomon/policy.toml"), `[governance]\nlevel = "prevent"\n`);
    clean = mkdtempSync(join(tmpdir(), "gnomon-lint-clean-"));
    mkdirSync(join(clean, ".gnomon"));
    writeFileSync(join(clean, ".gnomon/roles.toml"), `[roles.dev]\nmodel = "m"\ntools = ["read"]\n`);
    writeFileSync(join(clean, ".gnomon/policy.toml"), `[governance]\nlevel = "prevent"\n`);
  });
  afterAll(() => {
    rmSync(bad, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  });

  const run = async (dir: string, flags: Record<string, string>, json = true) => {
    const lines: string[] = [];
    const code = await cmdCheck({ dir, json, flags: { "policy-lint": "true", ...flags } }, (s) => lines.push(s));
    return { code, text: lines.join("\n") };
  };

  it("a contradiction is reported and the exit stays 0", async () => {
    const r = await run(bad, {});
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.text);
    expect(doc.schema).toBe("gnomon.policy_lint/1");
    expect(doc.findings).toMatchObject([{ kind: "contradiction", role: "dev", rule: "bash_allow", pattern: "git status" }]);
  });

  it("--strict-policy makes the same finding exit 2", async () => {
    expect((await run(bad, { "strict-policy": "true" })).code).toBe(2);
  });

  it("a clean surface has no findings and exits 0 even under --strict-policy", async () => {
    const r = await run(clean, { "strict-policy": "true" });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.text).count).toBe(0);
    expect((await run(clean, {}, false)).text).toBe("policy lint: no findings");
  });

  it("prints one line per finding for a person", async () => {
    const r = await run(bad, {}, false);
    expect(r.text).toContain("policy lint: 1 finding(s)");
    expect(r.text).toMatch(/contradiction\s+\.gnomon\/roles\.toml \[roles\.dev\]\s+bash_allow "git status"/);
  });
});

/**
 * What the surface declares, and what is actually in force.
 *
 * These are the tests that would have caught a tool surface that never parsed: the
 * hash covered `.gnomon/tools.toml` byte for byte while the loader turned all four
 * declared tools into one stray key, and nothing anywhere compared the two.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  declaredTools,
  environmentOverrides,
  loadConfig,
  mapBucket,
  parseToml,
  policySummary,
  SURFACE_DRIFT_CODE,
  toolSurface,
} from "./index.js";

// This repository's own .gnomon/, dogfooded: two levels up from packages/gnomon-core.
const repoRoot = "../..";

describe("declared surface", () => {
  describe("parseToml arrays of tables", () => {
    it("appends one element per [[table]] block", () => {
      const parsed = parseToml(`
[[tools]]
name = "read"
enabled = true

[[tools]]
name = "bash"
enabled = false
`);
      expect(parsed.tools).toEqual([
        { name: "read", enabled: true },
        { name: "bash", enabled: false },
      ]);
    });

    it("does not mistake [[table]] for a nested table", () => {
      const parsed = parseToml(`[[tools]]\nname = "read"\n`);
      expect(Object.keys(parsed)).toEqual(["tools"]);
      expect(Array.isArray(parsed.tools)).toBe(true);
    });
  });

  describe("declaredTools", () => {
    it("reads every tool this repository declares", () => {
      const names = declaredTools(loadConfig(repoRoot)).map((t) => t.name);
      expect([...names].sort()).toEqual(["bash", "edit", "read", "write"]);
    });

    it("counts the declarations in the file it hashes", () => {
      const declared = declaredTools(loadConfig(repoRoot));
      const blocks = readFileSync(`${repoRoot}/.gnomon/tools.toml`, "utf-8")
        .split("\n")
        .filter((line) => line.trim() === "[[tools]]").length;

      expect(declared).toHaveLength(blocks);
    });
  });

  describe("toolSurface", () => {
    it("sorts by a stable key, so a reordered file is not a changed surface", () => {
      const surface = toolSurface(loadConfig(repoRoot), ["write", "read"]);

      expect(surface.declared).toEqual([...surface.declared].sort());
      expect(surface.effective).toEqual(["read", "write"]);
    });

    it("is not enforced when nothing was offered to a model", () => {
      const surface = toolSurface(loadConfig(repoRoot));

      expect(surface.declared.length).toBeGreaterThan(0);
      expect(surface.effective).toEqual([]);
      expect(surface.enforced).toBe(false);
    });

    it("is enforced when the loop offered what the surface declares", () => {
      const config = loadConfig(repoRoot);
      const declared = toolSurface(config).declared;
      const surface = toolSurface(config, declared);

      expect(surface.effective).toEqual(surface.declared);
      expect(surface.enforced).toBe(true);
    });
  });

  describe("trailing comments", () => {
    it("does not read a comment as part of the value it follows", () => {
      const parsed = parseToml(`gate = "on_write"   # never | on_write | always
`);
      expect(parsed.gate).toBe("on_write");
    });

    it("keeps a # that is inside a quoted value", () => {
      const parsed = parseToml(`tag = "sha#1"
`);
      expect(parsed.tag).toBe("sha#1");
    });
  });

  describe("policySummary", () => {
    it("reads the selects the surface publishes", () => {
      const policy = policySummary(loadConfig(repoRoot));

      expect(policy.sandbox).toBe("confined");
      expect(policy.approval).toBe("on_write");
      expect(policy.edit_format).toBe("hashline");
    });

    it("reports enforcement as a fact about the run, not a constant", () => {
      const config = loadConfig(repoRoot);

      expect(policySummary(config).enforced).toBe(false);
      expect(policySummary(config, true).enforced).toBe(true);
    });
  });

  describe("environmentOverrides", () => {
    it("reports an unset variable as unset rather than omitting it", () => {
      const overrides = environmentOverrides({});
      expect(overrides.map((o) => o.name)).toContain("GNOMON_MODEL_URL");
      expect(overrides.every((o) => o.set === false && o.value === null)).toBe(true);
    });

    it("keeps only the origin of a URL, which may carry a credential", () => {
      const overrides = environmentOverrides({
        GNOMON_MODEL_URL: "https://user:secret@example.invalid/v1/chat/completions",
      });
      const url = overrides.find((o) => o.name === "GNOMON_MODEL_URL");

      expect(url?.set).toBe(true);
      expect(url?.value).toBe("https://example.invalid");
      expect(JSON.stringify(overrides)).not.toContain("secret");
    });

    it("records the timeout and the binary override verbatim", () => {
      const overrides = environmentOverrides({
        GNOMON_MODEL_TIMEOUT_MS: "5000",
        GNOMON_BIN_OVERRIDE: "target/debug",
      });

      expect(overrides.find((o) => o.name === "GNOMON_MODEL_TIMEOUT_MS")?.value).toBe("5000");
      expect(overrides.find((o) => o.name === "GNOMON_BIN_OVERRIDE")?.value).toBe("target/debug");
    });
  });

  describe("surface drift", () => {
    it("is a refusal, not an apparatus failure", () => {
      // Nothing broke when the surface moves: the harness declines to continue.
      // Filing it under apparatus failure would hide a configuration change in the
      // bucket reserved for the machine being down.
      expect(SURFACE_DRIFT_CODE).toBe(4);
      expect(mapBucket(SURFACE_DRIFT_CODE)).toBe("refusal");
    });
  });

  describe("exit table", () => {
    it("buckets every published code the way the fixture says", () => {
      const fixture = JSON.parse(
        readFileSync(`${repoRoot}/conformance/exit_codes.json`, "utf-8")
      ) as { exit_codes: Record<string, string>; expected_count: number };

      const codes = Object.entries(fixture.exit_codes);
      expect(codes).toHaveLength(fixture.expected_count);

      for (const [code, bucket] of codes) {
        expect(mapBucket(Number(code))).toBe(bucket);
      }
    });
  });
});

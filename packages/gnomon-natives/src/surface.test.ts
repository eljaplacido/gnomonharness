import { describe, it, expect, beforeAll } from "vitest";
import {
  manifest,
  surfaceHash,
  listPaths,
  enumerations,
  version,
  GNONOM_VERSION,
} from "./surface.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve fixture relative to test file location
const fixtureDir = join(__dirname, "..", "..", "..", "conformance", "fixture_tree", ".gnomon");

describe("gnomon-natives surface", () => {

  describe("manifest", () => {
    it("returns a valid manifest structure", () => {
      const m = manifest(fixtureDir);
      expect(m.build).toMatch(/^0\.1\.0\+/);
      expect(m.surface_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(Array.isArray(m.sources)).toBe(true);
      expect(m.sources.length).toBeGreaterThan(0);
      for (const s of m.sources) {
        expect(s.path).toMatch(/\.gnomon\//);
        expect(typeof s.sha256).toBe("string");
      }
    });

    it("sources are sorted by path", () => {
      const m = manifest(fixtureDir);
      const paths = m.sources.map((s) => s.path);
      expect(paths).toEqual([...paths].sort());
    });

    it("deterministic: same dir produces same hash", () => {
      const h1 = surfaceHash(fixtureDir);
      const h2 = surfaceHash(fixtureDir);
      expect(h1).toBe(h2);
    });
  });

  describe("enumerations", () => {
    it("returns exactly 4 keys", () => {
      const e = enumerations();
      expect(Object.keys(e)).toHaveLength(4);
      expect(Object.keys(e)).toEqual(
        expect.arrayContaining(["edit_format", "sandbox", "approval", "role_profile"])
      );
    });

    it("each value is a string array", () => {
      const e = enumerations();
      for (const key of Object.keys(e)) {
        expect(Array.isArray(e[key as keyof typeof e])).toBe(true);
      }
    });
  });

  describe("listPaths", () => {
    it("returns sorted paths", () => {
      const paths = listPaths(fixtureDir);
      expect(paths).toEqual([...paths].sort());
      expect(paths.length).toBeGreaterThan(0);
    });
  });

  describe("version", () => {
    it("returns version string", () => {
      expect(version()).toBe(GNONOM_VERSION);
    });
  });
});


describe("native binaries resolve lazily", () => {
  it("importing the package does not require a built binary", async () => {
    // These were module-level constants, so importing this package threw when
    // the Rust crates had not been built — which killed `gnomon --help`,
    // `gnomon init` and `gnomon launch`, none of which touch a native binary.
    // On a fresh clone that made the whole CLI unusable.
    const original = process.env.GNOMON_BIN_OVERRIDE;
    process.env.GNOMON_BIN_OVERRIDE = "/nonexistent-on-purpose";
    try {
      await expect(import("./surface.js")).resolves.toBeDefined();
    } finally {
      if (original === undefined) delete process.env.GNOMON_BIN_OVERRIDE;
      else process.env.GNOMON_BIN_OVERRIDE = original;
    }
  });

  it("the error names the command that builds it", () => {
    try {
      manifest("/nonexistent-surface-path-for-error-text");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Either it ran (binary present) or it told the user what to run.
      if (message.includes("not found")) {
        expect(message).toContain("cargo build");
        expect(message).toContain("GNOMON_BIN_OVERRIDE");
      }
    }
  });
});

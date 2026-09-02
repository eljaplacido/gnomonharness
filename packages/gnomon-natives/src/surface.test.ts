import { describe, it, expect, beforeAll } from "vitest";
import {
  applyPatchset,
  simulatePatch,
  manifest,
  surfaceHash,
  listPaths,
  enumerations,
  version,
  findBinary,
  GNONOM_VERSION,
} from "./surface.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve fixture relative to test file location
const fixtureDir = join(__dirname, "..", "..", "..", "conformance", "fixture_tree", ".gnomon");

// The version the native binary will report, read from the workspace manifest
// rather than written down twice.
const CRATE_VERSION = (() => {
  const toml = readFileSync(join(__dirname, "..", "..", "..", "Cargo.toml"), "utf8");
  const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) throw new Error("no version in workspace Cargo.toml");
  return m[1];
})();

describe("gnomon-natives surface", () => {

  describe("manifest", () => {
    it("returns a valid manifest structure", () => {
      const m = manifest(fixtureDir);
      // Derived, never hardcoded. A literal here (it was /^0\.1\.0\+/) turns
      // every version bump into a mystery test failure in an unrelated
      // package — which is exactly what it did on the 0.1.0 -> 0.1.1 bump.
      // The workspace Cargo.toml is the source of truth for the binary's
      // version; the release workflow separately asserts package.json agrees.
      expect(m.build).toMatch(new RegExp(`^${CRATE_VERSION.replace(/\./g, "\\.")}\\+`));
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

describe("finding the native binaries", () => {
  // The override used to be returned whenever the path existed, so pointing it
  // at a directory without this binary handed spawnSync a directory. The error
  // was EACCES, which reads as a permissions problem and is not one.
  it("a directory override missing the binary reports the binary, not the directory", () => {
    const original = process.env.GNOMON_BIN_OVERRIDE;
    const empty = mkdtempSync(join(tmpdir(), "gnomon-nobin-"));
    process.env.GNOMON_BIN_OVERRIDE = empty;
    try {
      // A name no build produces, so the target/debug and PATH fallbacks
      // cannot mask what the override branch does.
      let message = "";
      try {
        findBinary("gnomon-not-a-real-binary");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("gnomon-not-a-real-binary");
      expect(message).toContain("cargo build --bin gnomon-not-a-real-binary");
    } finally {
      rmSync(empty, { recursive: true, force: true });
      if (original === undefined) delete process.env.GNOMON_BIN_OVERRIDE;
      else process.env.GNOMON_BIN_OVERRIDE = original;
    }
  });

  it("a file override is used as given", () => {
    const original = process.env.GNOMON_BIN_OVERRIDE;
    const dir = mkdtempSync(join(tmpdir(), "gnomon-binfile-"));
    const fake = join(dir, "stand-in");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    process.env.GNOMON_BIN_OVERRIDE = fake;
    try {
      expect(findBinary("gnomon-not-a-real-binary")).toBe(fake);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (original === undefined) delete process.env.GNOMON_BIN_OVERRIDE;
      else process.env.GNOMON_BIN_OVERRIDE = original;
    }
  });
});

describe("the patch engine is reachable", () => {
  // gnomon-edit dispatched on argv[2] while the usage text documented argv[1],
  // so `gnomon-edit simulate f.json` read "f.json" as the command and reported
  // `Unknown command: simulate`. Nothing could invoke it.
  const tmp = () => mkdtempSync(join(tmpdir(), "gnomon-patch-"));

  it("simulate reports results and writes nothing", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "f.txt"), "hello world\n");
      const patchFile = join(dir, "p.json");
      writeFileSync(patchFile, JSON.stringify({
        patches: [{ path: "f.txt", pattern: "hello", replacement: "goodbye", mode: "exact" }],
      }));

      const result = simulatePatch(patchFile, dir) as any;
      expect(result.total).toBe(1);
      expect(result.applied).toBe(1);
      expect(result.all_applied).toBe(true);
      // Dry run: the file is untouched.
      expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("hello world\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("apply actually applies", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "f.txt"), "hello world\n");
      const patchFile = join(dir, "p.json");
      writeFileSync(patchFile, JSON.stringify({
        patches: [{ path: "f.txt", pattern: "hello", replacement: "goodbye", mode: "exact" }],
      }));

      const result = applyPatchset(patchFile, dir) as any;
      expect(result.all_applied).toBe(true);
      expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("goodbye world\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a patch that cannot apply is reported, not thrown", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "f.txt"), "hello world\n");
      const patchFile = join(dir, "p.json");
      writeFileSync(patchFile, JSON.stringify({
        patches: [{ path: "f.txt", pattern: "NOT PRESENT", replacement: "x", mode: "exact" }],
      }));
      const result = simulatePatch(patchFile, dir) as any;
      expect(result.all_applied).toBe(false);
      expect(result.results[0].error).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

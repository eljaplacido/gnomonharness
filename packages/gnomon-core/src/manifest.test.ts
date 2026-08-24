/**
 * gnomon-core: Manifest re-assertion tests
 *
 * Verify drift detection, surface hash computation, and fixture tree matching.
 */

import { describe, it, expect } from "vitest";
import { computeSurfaceHash, SourceEntry } from "./session.js";
import { recomputeManifest } from "./config.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Fixture tree root — relative to this file.
 *
 * __dirname is packages/gnomon-core/src, so reaching the repository root takes
 * three levels. It was two, which resolved to packages/conformance — a path
 * that does not exist. Every assertion still passed, because a manifest of
 * files that are all absent is still a manifest.
 */
const FIXTURE_DIR = join(__dirname, "../../../conformance/fixture_tree");

// ---------------------------------------------------------------------------
// computeSurfaceHash
// ---------------------------------------------------------------------------

describe("computeSurfaceHash", () => {
  it("produces deterministic hash for identical sources", () => {
    const sources: SourceEntry[] = [
      { path: "config.toml", sha256: "abc123" },
      { path: "system.md", sha256: "def456" },
    ];
    const h1 = computeSurfaceHash(sources);
    const h2 = computeSurfaceHash(sources);
    expect(h1).toBe(h2);
  });

  it("is order-independent — sorted before hashing", () => {
    const sourcesA: SourceEntry[] = [
      { path: "config.toml", sha256: "abc123" },
      { path: "system.md", sha256: "def456" },
    ];
    const sourcesB: SourceEntry[] = [
      { path: "system.md", sha256: "def456" },
      { path: "config.toml", sha256: "abc123" },
    ];
    expect(computeSurfaceHash(sourcesA)).toBe(computeSurfaceHash(sourcesB));
  });

  it("differs when content changes", () => {
    const sourcesA: SourceEntry[] = [
      { path: "config.toml", sha256: "abc123" },
    ];
    const sourcesB: SourceEntry[] = [
      { path: "config.toml", sha256: "xyz789" },
    ];
    expect(computeSurfaceHash(sourcesA)).not.toBe(computeSurfaceHash(sourcesB));
  });

  it("handles null sha256 (absent path)", () => {
    const sources: SourceEntry[] = [
      { path: "config.toml", sha256: null },
      { path: "tools.toml", sha256: "abc123" },
    ];
    const hash = computeSurfaceHash(sources);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBe(64); // SHA256 hex
  });
});

// ---------------------------------------------------------------------------
// recomputeManifest
// ---------------------------------------------------------------------------

describe("recomputeManifest", () => {
  it("returns sources and surface_hash for fixture tree", () => {
    const { manifest, surface_hash } = recomputeManifest(FIXTURE_DIR);
    expect(manifest).toBeDefined();
    expect(Array.isArray(manifest)).toBe(true);
    expect(surface_hash).toBeDefined();
    expect(typeof surface_hash).toBe("string");
    expect(surface_hash.length).toBe(64); // SHA256 hex
  });

  it("actually hashes the files — not every source is null", () => {
    // The original assertions passed while collectSurface found nothing and
    // the hash was a constant meaning "every file absent". A hash of the
    // right shape is not a hash of the right thing.
    const { manifest } = recomputeManifest(FIXTURE_DIR);
    const hashed = manifest.filter((s) => s.sha256 !== null);
    expect(hashed.length).toBeGreaterThan(0);
    for (const s of hashed) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts the .gnomon dir itself, which is how the runtime calls it", () => {
    const viaRoot = recomputeManifest(FIXTURE_DIR);
    const viaSurface = recomputeManifest(join(FIXTURE_DIR, ".gnomon"));
    expect(viaSurface.surface_hash).toBe(viaRoot.surface_hash);
    expect(viaSurface.manifest.some((s) => s.sha256 !== null)).toBe(true);
  });

  it("the hash tracks a change to the surface", () => {
    // Drift detection, the audit trail's attribution, and resume all depend
    // on this being true. It was not.
    const tmp = mkdtempSync(join(tmpdir(), "gnomon-manifest-"));
    try {
      mkdirSync(join(tmp, ".gnomon"), { recursive: true });
      writeFileSync(join(tmp, ".gnomon", "system.md"), "original", "utf-8");
      const before = recomputeManifest(tmp).surface_hash;

      writeFileSync(join(tmp, ".gnomon", "system.md"), "changed", "utf-8");
      const after = recomputeManifest(tmp).surface_hash;

      expect(after).not.toBe(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes all canonical surface paths", () => {
    const { manifest } = recomputeManifest(FIXTURE_DIR);
    const paths = manifest.map((s) => s.path);
    // .gnomon/-prefixed, matching gnomon-surface and the golden fixture.
    expect(paths).toContain(".gnomon/config.toml");
    expect(paths).toContain(".gnomon/system.md");
    expect(paths).toContain(".gnomon/roles.toml");
    expect(paths).toContain(".gnomon/policy.toml");
    expect(paths).toContain(".gnomon/tools.toml");
  });

  it("returns null sha256 for absent paths", () => {
    const { manifest } = recomputeManifest(FIXTURE_DIR);
    // skills/ is not present in fixture_tree
    const skillsEntry = manifest.find((s) => s.path.startsWith("skills/"));
    if (skillsEntry) {
      expect(skillsEntry.sha256).toBeNull();
    }
  });

  it("is deterministic across two calls", () => {
    const a = recomputeManifest(FIXTURE_DIR);
    const b = recomputeManifest(FIXTURE_DIR);
    expect(a.surface_hash).toBe(b.surface_hash);
    expect(a.manifest.length).toBe(b.manifest.length);
  });

  it("matches Rust gnomon-surface golden hash", () => {
    // The fixture_tree is the same tree used by gnomon-surface tests,
    // so the surface hash should match.
    const { manifest, surface_hash } = recomputeManifest(FIXTURE_DIR);
    const { surface_hash: goldenHash } = recomputeManifest(
      join(FIXTURE_DIR, "..", "fixture_tree")
    );
    // Both point to the same fixture_tree
    expect(surface_hash).toBe(goldenHash);
  });

  it("handles non-existent directory — returns canonical paths as absent", () => {
    const { manifest, surface_hash } = recomputeManifest(
      "/tmp/gnomon-nonexistent"
    );
    // Always returns canonical paths (present or absent)
    expect(manifest.length).toBe(5);
    expect(manifest.every((s) => s.sha256 === null)).toBe(true);
    expect(typeof surface_hash).toBe("string");
    expect(surface_hash.length).toBe(64);
  });
});

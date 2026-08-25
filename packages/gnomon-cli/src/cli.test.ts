import { describe, it, expect } from "vitest";
import { parseArgs } from "./index.js";
import { recomputeManifest } from "gnomon-core";
import { surfaceHash, manifest } from "gnomon-natives";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// parseArgs is imported, not copied. A duplicate lived here, justified by a
// note that index.ts could not be imported because findBinary ran eagerly —
// which stopped being true when that resolution was made lazy. The copy meant
// these tests passed against a function nothing shipped, which is how apply,
// simulate and session reached users unable to read their own arguments.
describe("gnomon-cli argument parsing", () => {
  describe("parseArgs", () => {
    it("parses command only", () => {
      const result = parseArgs(["surface"]);
      expect(result.command).toBe("surface");
      expect(result.subcommand).toBe("");
      expect(result.positional).toEqual([]);
    });

    it("parses command with subcommand", () => {
      const result = parseArgs(["surface", "manifest"]);
      expect(result.command).toBe("surface");
      expect(result.subcommand).toBe("manifest");
    });

    it("parses --dir flag", () => {
      const result = parseArgs(["surface", "--dir", "/some/path"]);
      expect(result.dir).toBe("/some/path");
    });

    it("parses -d flag then positional", () => {
      const result = parseArgs(["session", "-d", "./foo", "echo hello"]);
      expect(result.dir).toBe("./foo");
      // After -d, next arg becomes subcommand (first positional)
      expect(result.subcommand).toBe("echo hello");
    });

    it("parses positional arguments", () => {
      const result = parseArgs(["session", "echo a", "echo b"]);
      // First positional becomes subcommand, rest go to positional
      expect(result.subcommand).toBe("echo a");
      expect(result.positional).toEqual(["echo b"]);
    });

    it("handles flags after positional", () => {
      const result = parseArgs(["apply", "patch.json", "--dir", "/tmp"]);
      // patch.json is subcommand, --dir consumes next arg
      expect(result.subcommand).toBe("patch.json");
      expect(result.dir).toBe("/tmp");
    });

    it("ignores unknown flags", () => {
      const result = parseArgs(["surface", "--verbose"]);
      expect(result.command).toBe("surface");
    });

    it("handles help flag", () => {
      const result = parseArgs(["--help"]);
      // --help starts with -, so command stays empty
      expect(result.command).toBe("");
      expect(result.subcommand).toBe("");
    });

    it("handles empty args", () => {
      const result = parseArgs([]);
      // Empty array: args[0] is undefined, undefined doesn't start with -
      // so it becomes the command
      expect(result.command).toBeUndefined();
    });
  });
});

describe("the two surface-hash implementations agree", () => {
  // Both are called "the surface hash". They disagreed — different canonical
  // path strings — so the audit trail attributed behaviour to one number while
  // conformance/manifest_golden.json pinned another. gnomon-cli is where both
  // are visible, so this is where they get compared.
  const surfaceDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../conformance/fixture_tree/.gnomon"
  );

  it("return the same hash for the same surface", () => {
    expect(recomputeManifest(surfaceDir).surface_hash).toBe(surfaceHash(surfaceDir));
  });

  it("agree on the manifest's source paths", () => {
    const native = manifest(surfaceDir) as { sources: Array<{ path: string }> };
    expect(recomputeManifest(surfaceDir).manifest.map((s) => s.path)).toEqual(
      native.sources.map((s) => s.path)
    );
  });

  it("both track a change to the surface", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gnomon-agree-"));
    try {
      const dir = join(tmp, ".gnomon");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "system.md"), "before", "utf-8");
      const a = [recomputeManifest(dir).surface_hash, surfaceHash(dir)];

      writeFileSync(join(dir, "system.md"), "after", "utf-8");
      const b = [recomputeManifest(dir).surface_hash, surfaceHash(dir)];

      expect(a[0]).toBe(a[1]);
      expect(b[0]).toBe(b[1]);
      expect(b[0]).not.toBe(a[0]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

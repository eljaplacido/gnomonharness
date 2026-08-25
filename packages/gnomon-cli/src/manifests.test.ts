/**
 * gnomon-cli: Package manifest hygiene
 *
 * A declared dependency that is never imported is not harmless here. It enters
 * the lockfile, and a repository whose claim is reproducibility should not
 * carry packages nothing loads — gnomon-core declared `pi-agent-core` and
 * `pi-ai` for its whole history and imported neither.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const packagesDir = join(repoRoot, "packages");

const workspacePackages = readdirSync(packagesDir).filter((name) =>
  existsSync(join(packagesDir, name, "package.json"))
);

/** Every module specifier imported by a package's non-test source. */
function importedBy(pkg: string): Set<string> {
  const srcDir = join(packagesDir, pkg, "src");
  const found = new Set<string>();
  if (!existsSync(srcDir)) return found;

  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const body = readFileSync(join(srcDir, file), "utf-8");
    for (const m of body.matchAll(/from\s+"([^"]+)"|import\(\s*"([^"]+)"/g)) {
      const spec = m[1] ?? m[2];
      if (!spec || spec.startsWith(".") || spec.startsWith("node:")) continue;
      // "gnomon-core/x" belongs to package "gnomon-core".
      found.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
  }
  // The bin launcher is source too, even though it sits outside src/.
  const bin = join(packagesDir, pkg, "gnomon.js");
  if (existsSync(bin)) {
    for (const m of readFileSync(bin, "utf-8").matchAll(/from\s+"([^"]+)"/g)) {
      const spec = m[1];
      if (spec && !spec.startsWith(".") && !spec.startsWith("node:")) found.add(spec);
    }
  }
  return found;
}

describe("declared runtime dependencies are actually imported", () => {
  for (const pkg of workspacePackages) {
    it(pkg, () => {
      const manifest = JSON.parse(
        readFileSync(join(packagesDir, pkg, "package.json"), "utf-8")
      );
      const declared = Object.keys(manifest.dependencies ?? {});
      const imported = importedBy(pkg);
      const phantom = declared.filter((d) => !imported.has(d));
      expect(phantom, `${pkg} declares but never imports`).toEqual([]);
    });
  }
});

describe("imported workspace packages are declared", () => {
  const workspaceNames = new Set(
    workspacePackages.map((p) =>
      JSON.parse(readFileSync(join(packagesDir, p, "package.json"), "utf-8")).name
    )
  );

  for (const pkg of workspacePackages) {
    it(pkg, () => {
      const manifest = JSON.parse(
        readFileSync(join(packagesDir, pkg, "package.json"), "utf-8")
      );
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ]);
      const undeclared = [...importedBy(pkg)].filter(
        (i) => workspaceNames.has(i) && !declared.has(i)
      );
      expect(undeclared, `${pkg} imports but does not declare`).toEqual([]);
    });
  }
});

describe("development dependencies are used too", () => {
  // Tools are invoked by name from scripts or by the runner, not imported, so
  // they cannot be checked the same way. Everything else must be reachable.
  const TOOLING = new Set(["typescript", "vitest", "tsx", "eslint", "prettier"]);

  for (const pkg of workspacePackages) {
    it(pkg, () => {
      const manifest = JSON.parse(
        readFileSync(join(packagesDir, pkg, "package.json"), "utf-8")
      );
      const scripts = Object.values(manifest.scripts ?? {}).join(" ");
      const imported = importedBy(pkg);

      const phantom = Object.keys(manifest.devDependencies ?? {}).filter(
        (d) =>
          !TOOLING.has(d) &&
          !d.startsWith("@types/") &&
          !imported.has(d) &&
          !scripts.includes(d)
      );
      // node-gyp and node-addon-api sat here unused, and the package
      // described itself as N-API bindings while shelling out to binaries —
      // which found its way into an audit as a build-complexity risk.
      expect(phantom, `${pkg} declares dev dependencies nothing uses`).toEqual([]);
    });
  }
});

describe("package descriptions match what the package does", () => {
  it("gnomon-natives does not claim to be a native addon", () => {
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, "gnomon-natives", "package.json"), "utf-8")
    );
    const src = readFileSync(
      join(packagesDir, "gnomon-natives", "src", "surface.ts"),
      "utf-8"
    );
    // It spawns the Rust binaries. Saying otherwise misleads anyone sizing up
    // the build, and it did.
    expect(src).toContain("spawnSync");
    expect(src).not.toMatch(/require\(.*\.node|napi/i);
    expect(manifest.description.toLowerCase()).not.toContain("n-api");
    expect(manifest.description.toLowerCase()).not.toContain("napi");
  });
});

describe("types-only packages are development dependencies", () => {
  for (const pkg of workspacePackages) {
    it(pkg, () => {
      const manifest = JSON.parse(
        readFileSync(join(packagesDir, pkg, "package.json"), "utf-8")
      );
      // @types/* ships no runtime code; in `dependencies` it would be
      // installed by anyone consuming the package for nothing.
      const runtimeTypes = Object.keys(manifest.dependencies ?? {}).filter((d) =>
        d.startsWith("@types/")
      );
      expect(runtimeTypes).toEqual([]);
    });
  }
});

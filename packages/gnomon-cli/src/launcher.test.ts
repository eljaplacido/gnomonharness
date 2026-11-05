import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The checkout launcher (gnomon.js) imports a cached esbuild bundle of the sources
// when it is current, instead of transpiling them through tsx on every start
// (UX1: +217 ms wall and +310 ms CPU per invocation). These tests run the real
// launcher, with its cache in a temp directory, and hold it to the one property
// that makes the bundle acceptable: it is the same program as tsx runs.

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(HERE, "..", "gnomon.js");
const REPO = join(HERE, "..", "..", "..");

function launch(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, GNOMON_LAUNCH_DEBUG: "1", ...env },
  });
  const stderr = r.stderr ?? "";
  const path = (stderr.match(/^gnomon launch: (.*)$/m) ?? [])[1] ?? "";
  return {
    code: r.status,
    out: r.stdout ?? "",
    err: stderr.replace(/^gnomon launch: .*\n/gm, ""),
    path,
  };
}

describe("the checkout launcher's bundle", () => {
  it("prints exactly what tsx prints, file-relative lookups included", () => {
    const cache = mkdtempSync(join(tmpdir(), "gnomon-launch-"));
    try {
      // `surface hash` finds its native binary relative to gnomon-natives' own
      // source file: the lookup the bundle's pinned import.meta.url exists for.
      // Whether or not the binary is built here, both paths must say the same.
      for (const args of [["--version"], ["--help"], ["surface", "hash", "--dir", REPO]]) {
        const tsx = launch(args, { GNOMON_LAUNCH: "tsx" });
        const bundle = launch(args, { GNOMON_LAUNCH_CACHE: cache });
        expect(tsx.path, `GNOMON_LAUNCH=tsx must not bundle (${args.join(" ")})`).toBe("tsx");
        expect(bundle.path, `bundle path for ${args.join(" ")}: ${bundle.path}`).toMatch(/^bundle/);
        expect(bundle.out, args.join(" ")).toBe(tsx.out);
        expect(bundle.err, args.join(" ")).toBe(tsx.err);
        expect(bundle.code, args.join(" ")).toBe(tsx.code);
      }
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 120_000);

  it("reuses a current bundle and rebuilds when any recorded input changed", () => {
    const cache = mkdtempSync(join(tmpdir(), "gnomon-launch-"));
    try {
      expect(launch(["--version"], { GNOMON_LAUNCH_CACHE: cache }).path).toBe("bundle (rebuilt)");
      expect(launch(["--version"], { GNOMON_LAUNCH_CACHE: cache }).path).toBe("bundle (current)");

      // A source edited after the build: its recorded mtime no longer matches.
      // Simulated in the stamp rather than by touching a real source file.
      const stampPath = join(cache, "inputs.json");
      const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as { inputs: [string, number, number][] };
      const src = stamp.inputs.findIndex(([p]) => p.endsWith(join("gnomon-core", "src", "build.ts")));
      expect(src, "the stamp records gnomon-core's sources").toBeGreaterThanOrEqual(0);
      stamp.inputs[src]![2] -= 1;
      writeFileSync(stampPath, JSON.stringify(stamp));
      expect(launch(["--version"], { GNOMON_LAUNCH_CACHE: cache }).path).toBe("bundle (rebuilt)");
      expect(launch(["--version"], { GNOMON_LAUNCH_CACHE: cache }).path).toBe("bundle (current)");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 120_000);

  it("falls back to tsx, with the same output, when the bundle cannot be built", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-launch-"));
    try {
      // A cache path below a regular file cannot be created.
      const file = join(dir, "not-a-directory");
      writeFileSync(file, "");
      const broken = launch(["--version"], { GNOMON_LAUNCH_CACHE: join(file, "cache") });
      const tsx = launch(["--version"], { GNOMON_LAUNCH: "tsx" });
      expect(broken.path).toMatch(/^tsx \(bundle failed: /);
      expect(broken.out).toBe(tsx.out);
      expect(broken.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

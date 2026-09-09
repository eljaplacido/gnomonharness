import { describe, it, expect } from "vitest";
import { parseArgs } from "./index.js";
import { recomputeManifest } from "gnomon-core";
import { surfaceHash, manifest } from "gnomon-natives";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

// The help banner used to be a hardcoded `gnomon v0.1.0` literal. It stayed
// 0.1.0 through the whole of v0.1.1 — so the single version string a human ever
// reads was the one string that could not be trusted, and `gnomon --help` could
// not distinguish a 133-commit-old checkout from HEAD. Nothing asserted it,
// which is exactly why it drifted; `scripts/check-versions.sh` audits eight
// carriers and never covered this one.
//
// The banner is derived from harnessBuild() now, so this test is about keeping
// it derived: it fails if anyone reintroduces a literal.
describe("the version a user actually sees", () => {
  it("is derived from the build, not written down", async () => {
    const { harnessBuild } = await import("gnomon-core");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

    const banner = /console\.log\(`([^\n]*)— deterministic coding agent harness/.exec(src);
    expect(banner, "help banner not found — did the wording change?").toBeTruthy();

    // It must interpolate, and must not carry a literal version.
    expect(banner![1]).toContain("${harnessBuild()}");
    expect(banner![1]).not.toMatch(/v?\d+\.\d+\.\d+/);

    // And the value it interpolates must name this package's real version, so
    // a bump that misses the CLI cannot pass.
    const pkg = JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
    expect(harnessBuild()).toContain(`gnomon/${pkg.version}+`);
  });

  it("points at commands that exist when it refuses for a missing key", () => {
    // The refusal named `gnomon models`, which exits 1 with "Unknown command".
    // It is handed to a user who is already blocked, so it sent them into a
    // second failure. Every command the harness recommends must be real.
    const core = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..",
           "gnomon-core", "src", "prompt_loop.ts"), "utf8");
    expect(core).not.toContain("gnomon models");
    expect(core).toContain("gnomon endpoint list");
  });
});

// ---------------------------------------------------------------------------
// `gnomon loop run` exit codes
// ---------------------------------------------------------------------------
//
// docs/CONTRACTS.md §1 said "`gnomon task` exits 0, 2 or 10 ... and every other
// command exits 0 or 1" from before loops existed. It was wrong: `loop run`
// maps its outcome onto the same bucket codes, which is what a cron entry and
// a CI step read. An independent sweep of the v0.2.3 release found the sentence
// on 2026-09-08 and reproduced the codes; correcting the document without
// pinning the behaviour would move the promise into prose again, so this spawns
// the real CLI rather than asserting against the mapping in the abstract.
//
// packages/gnomon-core/src/loops.test.ts already covers the OUTCOMES
// (guard_failed / act_failed / breaker_open). What was covered nowhere is the
// outcome→process.exit step, which is the only part a caller can observe.
describe("gnomon loop run — exit codes are the bucket, not 0/1", () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

  /** A project with one declared loop, scaffolded by hand — no model needed. */
  function projectWith(name: string, body: string): string {
    const root = mkdtempSync(join(tmpdir(), "gnomon-loopexit-"));
    mkdirSync(join(root, ".gnomon", "loops"), { recursive: true });
    // A surface minimal enough to load. The loop path never reaches a role.
    writeFileSync(join(root, ".gnomon", "config.toml"), "[defaults]\n");
    writeFileSync(join(root, ".gnomon", "roles.toml"), "[roles.implement]\nmodel = \"stub\"\n");
    writeFileSync(join(root, ".gnomon", "loops", `${name}.toml`), body);
    return root;
  }

  function runLoop(root: string, name: string): { code: number; out: string } {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, "loop", "run", name, "--dir", root],
      { encoding: "utf-8", timeout: 60_000 }
    );
    return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  it("exits 10 when the guard itself fails — apparatus, not 'nothing wrong'", () => {
    const root = projectWith(
      "badguard",
      `[loop]\nname = "badguard"\nevery = "5m"\n\n[guard]\nrun = 'exit 9'\nact_when = "gt 0"\n\n[act]\nrun = 'true'\n`
    );
    try {
      const { code, out } = runLoop(root, "badguard");
      expect(out).toContain("guard_failed");
      // 10 = apparatus_failure. A guard that could not run has NOT established
      // that the condition is absent, so 0 would be a false all-clear.
      expect(code).toBe(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 2 when the action fails after a tripped guard", () => {
    const root = projectWith(
      "badact",
      `[loop]\nname = "badact"\nevery = "5m"\n\n[guard]\nrun = 'echo 7'\nact_when = "gt 0"\n\n[act]\nrun = 'false'\n`
    );
    try {
      const { code, out } = runLoop(root, "badact");
      expect(out).toContain("act_failed");
      expect(code).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 0 on a clean tick, so cron only mails on a real failure", () => {
    const root = projectWith(
      "quiet",
      `[loop]\nname = "quiet"\nevery = "5m"\n\n[guard]\nrun = 'echo 0'\nact_when = "gt 0"\n\n[act]\nrun = 'true'\n`
    );
    try {
      const { code } = runLoop(root, "quiet");
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

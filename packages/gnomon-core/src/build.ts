/**
 * Which harness produced a record.
 *
 * An independent audit put this first among thirteen findings, and it is the
 * only one that touches the thesis. The surface hash answers "what rules was
 * this run under". Nothing answered "what CODE read those rules" — so two
 * people with identical surface hashes on different gnomon builds get
 * different behaviour and no record says so. CONTRACTS.md is explicit that the
 * manifest's `build` field is not a revision and "a consumer must not read
 * provenance from it", so neither half of the pair identified the binary.
 *
 * Resolution order, most trustworthy first (conformance/build_field.json):
 *
 *   1. GNOMON_BUILD — stamped into the environment by a release or CI job.
 *   2. package — an installed copy (running from inside node_modules) whose
 *      package.json carries the `gnomonBuild` stamp the release job writes
 *      before packing: the release and the commit it was cut from.
 *   3. npm — an installed copy without that stamp. It cannot know its commit,
 *      but "this is a published build" is true and checkable.
 *   4. git — `git rev-parse --short HEAD`, ONLY in gnomon's own checkout, with
 *      a `-dirty` suffix when the tree has uncommitted changes. A build made
 *      from an edited tree must not claim to be its last commit.
 *   5. "unknown" — said plainly rather than guessed. A wrong provenance string
 *      is worse than an absent one, because it is the kind of thing a reader
 *      believes.
 *
 * An installed copy never asks git. It used to, and git answers for whatever
 * work tree the install sits in: a project-local or CI `npm i` reported the
 * PROJECT's commit as gnomon's build, on every audit record. Found 2026-10-31
 * when the v0.3.1 release, installed under a benchmark directory, called
 * itself `gnomon/0.3.1+1afd251-dirty` — the benchmark repository's commit.
 *
 * Resolved once and cached: this is stamped on every record, and shelling out
 * per turn to learn something that cannot change mid-process would be a cost
 * for nothing.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

let cached: string | null = null;

/** The nearest package.json above `dir`: its version, and the release stamp if any. */
function packageInfo(dir: string): { version: string; stamp: string | null } {
  for (let d = dir, i = 0; i < 6; i++, d = dirname(d)) {
    const p = join(d, "package.json");
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as { version?: string; gnomonBuild?: string };
        if (typeof j.version === "string" && j.version) {
          const stamp = typeof j.gnomonBuild === "string" && j.gnomonBuild.trim() ? j.gnomonBuild.trim() : null;
          return { version: j.version, stamp };
        }
      } catch {
        /* unreadable: fall through and keep walking */
      }
    }
  }
  return { version: "0.0.0", stamp: null };
}

/** True when `dir` is inside a node_modules tree: an installed copy, not a checkout. */
function installed(dir: string): boolean {
  return dir.split(/[\\/]/).includes("node_modules");
}

/**
 * The build string for a harness whose build.ts lives in `here`. Exported for
 * the tests, which drive each rule from a real directory layout; records use
 * harnessBuild(), which resolves `here` from this module and caches the answer.
 */
export function resolveHarnessBuild(here: string, env: NodeJS.ProcessEnv = process.env): string {
  const { version, stamp } = packageInfo(here);

  const stamped = env.GNOMON_BUILD;
  if (stamped && stamped.trim()) return `gnomon/${version}+${stamped.trim()}`;

  if (installed(here)) return `gnomon/${version}+${stamp ?? "npm"}`;

  try {
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env }).trim();
    // Only gnomon's own checkout may name the build. A copy of the sources inside
    // some other repository would otherwise be stamped with that repository's
    // commit -- the same wrong answer the installed case gave.
    const top = git(["rev-parse", "--show-toplevel"]);
    if (!existsSync(join(top, "packages", "gnomon-core", "src", "build.ts"))) {
      return `gnomon/${version}+unknown`;
    }
    const sha = git(["rev-parse", "--short", "HEAD"]);
    // A tree with uncommitted changes is not the commit it sits on, and a
    // benchmark record that says otherwise is the exact under-identification
    // this field exists to end.
    const dirty = git(["status", "--porcelain"]).length > 0 ? "-dirty" : "";
    return `gnomon/${version}+${sha}${dirty}`;
  } catch {
    return `gnomon/${version}+unknown`;
  }
}

/**
 * A string identifying the harness build that produced a record, e.g.
 * `gnomon/0.1.0+abf40c0` or `gnomon/0.1.0+abf40c0-dirty`.
 */
export function harnessBuild(): string {
  if (cached !== null) return cached;
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return process.cwd();
    }
  })();
  cached = resolveHarnessBuild(here);
  return cached;
}

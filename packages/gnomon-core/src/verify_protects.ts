/**
 * gnomon-core: `[verify] protects`, the files the declared check executes (#234).
 *
 * `[verify]` runs code the agent can edit in the same turn: `package.json`
 * scripts, `conftest.py`, pytest's `addopts`, a project's `scripts/verify.sh`,
 * a SeptaCore `.septacore.json`. The surface protects `.gnomon/`, and
 * must-fail-first catches a test that already passed before the change. Neither
 * notices a turn that weakens the check itself: skipping a test, narrowing
 * `addopts`, making a verify script exit 0 early. The more the check can do (a
 * longer timeout, a setup with network), the more such an edit is worth to a
 * model that wants the gate green.
 *
 * With `protects` declared, a turn that changes any file it names cannot come
 * out `passed`: a green run of a check the turn itself edited is
 * `passed_unverified`, and the hand-back names the file. Both callers use the
 * functions here, so the loop and `gnomon check` read "changed" the same way.
 *
 * What counts as changed, by file:
 *   package.json    the `scripts` object and the `jest` key (a new dependency
 *                   is not a change)
 *   pyproject.toml  the `[tool.pytest*]` tables
 *   setup.cfg       the `[tool:pytest]` section
 *   anything else   the whole file's bytes
 * A file that appears or disappears is a change. Files the check merely
 * IMPORTS (a helper module a test pulls in, a fixture file) are not protected
 * unless a glob names them: this is a list of what the check is configured by,
 * not a dependency analysis. The walk that finds glob matches stops at 50,000
 * entries and 8 directories deep; when it stops early the snapshot says so
 * (`truncated`), and the loop records and prints it, never silently reading a
 * partial walk as "nothing changed". Nothing is read from the model, and
 * nothing here runs a command.
 *
 * Opt-in: a surface without `protects` snapshots nothing and adds nothing to
 * any record.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { ResolvedVerify } from "./config.js";
import { globToRegExp } from "./tools.js";

/** The token that stands for the files of the tools gnomon recognises. */
export const PROTECTS_DETECTED = "@detected";

/**
 * What `@detected` names, besides the files the declared command itself runs
 * (`bash scripts/verify.sh`, `./verify.sh`, `sh run_tests.sh`): the config of
 * the test runners gnomon knows. A published list (CONTRACTS section 53,
 * conformance/verify_contract.json).
 */
export const PROTECTS_DEFAULTS = [
  "**/conftest.py",
  "pytest.ini",
  "pyproject.toml",
  "package.json",
  ".septacore.json",
  "**/vitest.config.*",
  "**/jest.config.*",
  "tox.ini",
  "setup.cfg",
  "noxfile.py",
  ".coveragerc",
] as const;

/** Directories never walked, and never worth hashing. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "target", "dist", "build", ".gnomon", ".gnomon-jobs", ".gnomon-out"]);
const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 8;
const MAX_BYTES = 4 * 1024 * 1024;

const posix = (p: string) => p.split(sep).join("/");
const hasGlob = (g: string) => /[*?]/.test(g);

/** Words of a command that name a file by a relative path: `scripts/verify.sh`, `./run_tests.sh`. */
function commandFiles(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/\s+|&&|\|\||;|\|/)) {
    const w = raw.replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
    if (!w || w.startsWith("-") || w.startsWith("/") || w.includes("..") || w.includes("=")) continue;
    if (/[\\/]|\.[A-Za-z0-9]{1,6}$/.test(w) && !/^[a-z]+:\/\//.test(w)) out.push(posix(w));
  }
  // `make test`: the Makefile is what runs.
  if (/(^|[\s;&|])make(\s|$)/.test(command)) out.push("Makefile", "makefile", "GNUmakefile");
  return out;
}

/** The patterns `protects` stands for, `@detected` expanded. Empty: nothing is protected. */
export function protectPatterns(verify: Pick<ResolvedVerify, "protects" | "command">): string[] {
  const out: string[] = [];
  for (const entry of verify.protects ?? []) {
    if (entry === PROTECTS_DETECTED) out.push(...PROTECTS_DEFAULTS, ...commandFiles(verify.command));
    else out.push(entry.replace(/^\.\//, ""));
  }
  return [...new Set(out)];
}

function matcher(patterns: string[]): (rel: string) => boolean {
  const res: RegExp[] = [];
  for (const g of patterns) {
    try {
      res.push(globToRegExp(g));
    } catch {
      // A glob that will not compile names nothing.
    }
  }
  return (rel) => res.some((r) => r.test(rel));
}

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/**
 * What a protected file looks like to the comparison, or null when it does not
 * exist. See the table at the top for what is compared.
 */
export function protectedDigest(rel: string, content: Buffer | string | null): string | null {
  if (content === null) return null;
  const base = rel.split("/").pop() ?? rel;
  const text = typeof content === "string" ? content : content.toString("utf-8");
  if (base === "package.json") {
    try {
      const j = JSON.parse(text) as { scripts?: unknown; jest?: unknown };
      return sha(`scripts:${JSON.stringify(j.scripts ?? null)}\njest:${JSON.stringify(j.jest ?? null)}`);
    } catch {
      return sha(content);
    }
  }
  if (base === "pyproject.toml" || base === "setup.cfg") {
    const want = base === "setup.cfg" ? "tool:pytest" : "tool.pytest";
    let keep = false;
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const h = /^\s*\[+\s*([^\]]+?)\s*\]+/.exec(line);
      if (h) keep = h[1]!.startsWith(want);
      if (keep) lines.push(line);
    }
    return sha(`pytest:${lines.join("\n")}`);
  }
  return sha(content);
}

/** Does `rel` match `protects`, and did its content change between the two? */
export function protectedChange(
  verify: Pick<ResolvedVerify, "protects" | "command">,
  rel: string,
  before: Buffer | string | null,
  after: Buffer | string | null
): boolean {
  if (!matcher(protectPatterns(verify))(rel)) return false;
  return protectedDigest(rel, before) !== protectedDigest(rel, after);
}

function readSmall(path: string): Buffer | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** What `snapshotProtected` saw: digests by path, and whether the walk stopped early. */
export interface ProtectSnapshot {
  files: Map<string, string | null>;
  /** The glob walk hit its entry or depth limit: files past it were not read. */
  truncated: boolean;
}

/** Every file under `root` the patterns name, repo-relative with `/`, as digests. */
export function snapshotProtected(root: string, verify: Pick<ResolvedVerify, "protects" | "command">): ProtectSnapshot {
  const patterns = protectPatterns(verify);
  const snap = new Map<string, string | null>();
  const result = (truncated: boolean): ProtectSnapshot => ({ files: snap, truncated });
  if (patterns.length === 0) return result(false);
  // A pattern with no wildcard is a path: read it directly, walk nothing.
  for (const p of patterns.filter((g) => !hasGlob(g))) {
    if (p.startsWith("/") || p.split("/").includes("..")) continue;
    snap.set(p, protectedDigest(p, readSmall(join(root, p))));
  }
  const globs = patterns.filter(hasGlob);
  if (globs.length === 0) return result(false);
  const match = matcher(globs);
  let seen = 0;
  let truncated = false;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), r, depth + 1);
      } else if (e.isFile() && match(r)) {
        snap.set(r, protectedDigest(r, readSmall(join(dir, e.name))));
      }
    }
  };
  if (existsSync(root)) walk(root, "", 0);
  return result(truncated);
}

/** The protected files whose digest now differs from `before`, sorted. */
export function changedProtected(
  before: ProtectSnapshot,
  root: string,
  verify: Pick<ResolvedVerify, "protects" | "command">
): string[] {
  const now = snapshotProtected(root, verify).files;
  const paths = new Set([...before.files.keys(), ...now.keys()]);
  return [...paths].filter((p) => (before.files.get(p) ?? null) !== (now.get(p) ?? null)).sort();
}

/** The hand-back for a green check that the turn itself may have weakened. */
export function protectedHandBack(command: string, changed: string[]): string {
  return (
    `The declared check passed, but this turn changed ${changed.length === 1 ? "a file" : "files"} the check executes: ` +
    `${changed.join(", ")}.\n\n` +
    `$ ${command}\n\n` +
    `A pass cannot be told from a check that was weakened, so it is recorded as passed_unverified, not passed. ` +
    `Revert the change if it was not needed. If it was, say plainly what you changed in it and why it does not weaken the check.`
  );
}

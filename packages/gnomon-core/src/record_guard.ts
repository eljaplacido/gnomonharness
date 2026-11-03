/**
 * gnomon-core: Record guard -- detecting changes to gnomon's own records
 *
 * The `record` policy rule (tools.ts) refuses the writes it can SEE: a path a
 * tool names, a shell command's named outputs. Three rounds of review showed
 * that a pattern list over command text never runs out of routes:
 * `cp -r X/. .`, `git checkout evil -- .`, `git reset`, `git stash pop`,
 * rsync and tar into an ancestor, pathspec magic, a symlink resolved from the
 * cwd. Patterns stay as fast pre-refusals; this is the check that does not
 * depend on reading the command.
 *
 * It looks at the result instead. Before and after every tool call that can
 * write, and at the end of every turn, the record directories (`.gnomon-audit/`,
 * `.gnomon-trials/`, a custom `[audit] dir`) are snapshotted: per file, size,
 * mtime, ctime and inode, plus a hash of the newest small files. Any change
 * gnomon's own record writer did not make is tampering. The loop then writes a
 * `record_tamper` audit record naming the tool call, stops the turn with a
 * refusal, and `gnomon skill accept` refuses while any tamper event is
 * unresolved (`gnomon audit resolve`).
 *
 * ctime is what makes stat enough for most files: user space can set mtime
 * (`touch -r`) but not ctime, which moves on every content or metadata change.
 * The hash is a second line for the files most likely to be targeted, and is
 * kept to the newest few so a large audit directory does not cost a read of
 * every trail per tool call.
 *
 * What it cannot see, said plainly: a change made and undone within one tool
 * call (the snapshot compares the ends of the call), and anything that rewrites
 * a file while preserving size, mtime, ctime and inode -- which needs root, a
 * clock change, or a raw device. The kernel sandbox (`exec os`) is what keeps
 * the agent away from the records in the first place.
 */

import { readdirSync, lstatSync, readFileSync, readlinkSync, existsSync, statSync, type Stats } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import type { GnomonConfig } from "./config.js";

/** The record directories of a surface: absolute, existing or not. */
export function recordDirsOf(config: GnomonConfig): string[] {
  const root = resolve(config.gnomonDir, "..");
  const dirs = [join(root, ".gnomon-audit"), join(root, ".gnomon-trials")];
  const declared = (config.config as { audit?: { dir?: unknown } } | undefined)?.audit?.dir;
  if (typeof declared === "string" && declared.trim()) {
    const d = isAbsolute(declared) ? resolve(declared) : resolve(root, declared);
    if (!dirs.includes(d)) dirs.push(d);
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// gnomon's own writes
// ---------------------------------------------------------------------------

/** What a file looked like right after gnomon's own writer last wrote it. */
const OWN = new Map<string, string>();
/** Files found changed by someone else at the moment gnomon went to write them. */
const PENDING: Array<{ path: string; change: "modified" }> = [];

function stateKey(st: Stats): string {
  return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
}

/**
 * Call BEFORE gnomon's own writer appends to a record file. If the file is not
 * as gnomon left it, someone else changed it in between -- and the append
 * about to happen would otherwise make that change look like gnomon's. Noted
 * for the guard to report.
 */
export function beforeOwnWrite(file: string): void {
  const abs = resolve(file);
  const known = OWN.get(abs);
  if (known === undefined) return;
  try {
    if (stateKey(statSync(abs)) !== known) PENDING.push({ path: abs, change: "modified" });
  } catch {
    PENDING.push({ path: abs, change: "modified" });
  }
}

/** Call AFTER gnomon's own writer wrote a record file. */
export function noteOwnWrite(file: string): void {
  const abs = resolve(file);
  try {
    OWN.set(abs, stateKey(statSync(abs)));
  } catch {
    OWN.delete(abs);
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface RecordFileState {
  key: string;
  /** sha256, for the newest small files only */
  sha?: string;
  /** A symlink's target */
  link?: string;
}

export interface RecordSnapshot {
  files: Map<string, RecordFileState>;
  /** True when the walk stopped at its bound: changes past it are not seen. */
  truncated: boolean;
  /** Milliseconds the snapshot took. */
  ms: number;
}

/** Bounds, exported so the cost can be stated and tested. */
export const SNAPSHOT_LIMITS = { maxEntries: 200_000, hashNewest: 16, hashMaxBytes: 256 * 1024 };

/**
 * Snapshot record directories. Symlinks are recorded as links (lstat), never
 * followed: a link into the records is itself a change to them.
 */
export function snapshotRecords(dirs: string[]): RecordSnapshot {
  const t0 = performance.now();
  const files = new Map<string, RecordFileState>();
  const stats: Array<[string, Stats]> = [];
  let budget = SNAPSHOT_LIMITS.maxEntries;
  let truncated = false;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (--budget < 0) {
        truncated = true;
        return;
      }
      const p = join(dir, name);
      let st: Stats;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      const state: RecordFileState = { key: stateKey(st) };
      if (st.isSymbolicLink()) {
        try {
          state.link = readlinkSync(p);
        } catch {
          /* unreadable link: its stat still counts */
        }
      } else if (st.isFile()) {
        stats.push([p, st]);
      }
      files.set(p, state);
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d);
  // The newest small files get a hash as well: the ones most likely to be the
  // target, read at bounded cost however large the directory grows.
  stats
    .filter(([, st]) => st.size <= SNAPSHOT_LIMITS.hashMaxBytes)
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
    .slice(0, SNAPSHOT_LIMITS.hashNewest)
    .forEach(([p]) => {
      try {
        files.get(p)!.sha = createHash("sha256").update(readFileSync(p)).digest("hex");
      } catch {
        /* gone since the walk: the next snapshot says so */
      }
    });
  return { files, truncated, ms: performance.now() - t0 };
}

export interface RecordChange {
  path: string;
  change: "added" | "modified" | "removed";
}

/**
 * What changed between two snapshots that gnomon's own writer did not do.
 * A file gnomon wrote counts as its own only while it is exactly as gnomon
 * left it.
 */
export function foreignChanges(before: RecordSnapshot, after: RecordSnapshot): RecordChange[] {
  const out: RecordChange[] = [];
  const own = (p: string, s: RecordFileState) => OWN.get(p) === s.key && s.link === undefined;
  for (const [p, s] of after.files) {
    const b = before.files.get(p);
    if (!b) {
      if (!own(p, s)) out.push({ path: p, change: "added" });
    } else if (b.key !== s.key || b.link !== s.link || (b.sha && s.sha && b.sha !== s.sha)) {
      if (!own(p, s)) out.push({ path: p, change: "modified" });
    }
  }
  for (const p of before.files.keys()) if (!after.files.has(p)) out.push({ path: p, change: "removed" });
  return out;
}

// ---------------------------------------------------------------------------
// The guard a session holds
// ---------------------------------------------------------------------------

/** Where a change was seen. */
export type TamperWhen = "during_call" | "between_calls" | "turn_end";

export interface TamperFinding {
  when: TamperWhen;
  changes: RecordChange[];
}

/**
 * One per session. `check()` compares the records with the last snapshot it
 * took, reports any change gnomon did not make, and moves its baseline on.
 */
export class RecordGuard {
  private baseline: RecordSnapshot;
  /** Every snapshot's cost, for the overhead the PR states. */
  readonly costs: number[] = [];

  constructor(private readonly dirs: string[]) {
    this.baseline = snapshotRecords(dirs);
    this.costs.push(this.baseline.ms);
  }

  static for(config: GnomonConfig): RecordGuard {
    return new RecordGuard(recordDirsOf(config));
  }

  check(when: TamperWhen): TamperFinding | null {
    const now = snapshotRecords(this.dirs);
    this.costs.push(now.ms);
    const changes = foreignChanges(this.baseline, now);
    // Changes gnomon's writer noticed at the moment it went to append.
    while (PENDING.length) {
      const p = PENDING.shift()!;
      if (this.dirs.some((d) => isUnder(d, p.path)) && !changes.some((c) => c.path === p.path)) changes.push(p);
    }
    this.baseline = now;
    return changes.length ? { when, changes } : null;
  }
}

function isUnder(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A change list as a record field: repo-relative POSIX paths, capped. */
export function describeChanges(root: string, changes: RecordChange[], cap = 50): Array<{ path: string; change: string }> {
  return changes.slice(0, cap).map((c) => {
    const rel = relative(root, c.path);
    return {
      path: rel.startsWith("..") || isAbsolute(rel) ? c.path : rel.split(sep).join("/"),
      change: c.change,
    };
  });
}

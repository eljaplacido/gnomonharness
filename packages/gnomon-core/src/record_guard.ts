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
import { join, resolve, relative, isAbsolute, sep, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { GnomonConfig } from "./config.js";
import { verifyTrail, resolveAudit, type AuditRecord } from "./audit.js";
import type { ResolvedAttest } from "./attest.js";

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

/**
 * Directories inside the record directories that are not records: the
 * `[audit.anchor]` queue and receipts (anchor.ts), when it is declared.
 *
 * Left out of every snapshot and checkpoint map because a background delivery
 * writes there after the session that queued it has ended, and a concurrent
 * session would read that as tampering. Nothing in it is evidence of what the
 * agent did: a receipt is checked against its witness (a token's signature,
 * the remote's copy) when `gnomon audit verify` reads it, and a removed one
 * shows there as a trail with no anchor. The `record` rule still refuses the
 * agent's writes to it, because it is inside the trail directory.
 *
 * Absent `[audit.anchor]`, nothing is excluded: exactly the previous walk.
 */
export function recordExcludesOf(config: GnomonConfig): string[] {
  const anchor = resolveAudit(config).anchor;
  return anchor?.declared ? [resolve(anchor.dir)] : [];
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
export function snapshotRecords(dirs: string[], exclude: string[] = []): RecordSnapshot {
  const t0 = performance.now();
  const files = new Map<string, RecordFileState>();
  const skip = new Set(exclude.map((d) => resolve(d)));
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
        if (skip.size === 0 || !skip.has(resolve(p))) walk(p);
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
  for (const d of dirs) if (existsSync(d) && !skip.has(resolve(d))) walk(d);
  // The newest small files get a hash as well: the ones most likely to be the
  // target, read at bounded cost however large the directory grows.
  //
  // Not a checkpoint's map: its sha256 is in its own sealed session_end and is
  // checked before the map is used, and it lists every record file, so it is
  // the largest small file there -- hashing the newest few maps made one
  // snapshot cost 8 ms instead of 2 in a repository 400 sessions old.
  stats
    .filter(([p, st]) => st.size <= SNAPSHOT_LIMITS.hashMaxBytes && !isCheckpointMap(p))
    // Ties by path (GV17): on equal mtimes -- coarse clocks, files written in
    // one burst -- which ones are hashed was decided by readdir order.
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
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

// ---------------------------------------------------------------------------
// Checkpoints: their shape, which the guard has to know (record_tamper.ts
// writes them)
// ---------------------------------------------------------------------------

/** Where checkpoints live, inside the audit directory. */
export const CHECKPOINT_DIR = "checkpoints";

/** `checkpoint-<stamp>.jsonl` (the trail, or its heads file) or `checkpoint-<stamp>.files.json` (its map). */
const CHECKPOINT_FILE = /^(checkpoint-[^\\/]+?)\.(jsonl|files\.json)$/;

function isCheckpointMap(p: string): boolean {
  return CHECKPOINT_FILE.exec(basename(p))?.[2] === "files.json" && basename(dirname(p)) === CHECKPOINT_DIR;
}

/** Where a surface's checkpoints, and their signed heads, live. */
export interface CheckpointPlace {
  dir: string;
  attest?: ResolvedAttest;
}

export function checkpointPlace(config: GnomonConfig): CheckpointPlace {
  const a = resolveAudit(config);
  return { dir: join(a.dir, CHECKPOINT_DIR), ...(a.attest ? { attest: a.attest } : {}) };
}

/**
 * `checkpoint-<stamp>` when `p` is one of a checkpoint's own files -- its
 * trail or map in the checkpoint directory, or its trail's heads file -- and
 * null for anything else.
 */
export function checkpointStem(place: CheckpointPlace, p: string): string | null {
  const m = CHECKPOINT_FILE.exec(basename(p));
  if (!m) return null;
  const parent = resolve(dirname(p));
  if (parent === resolve(place.dir)) return m[1]!;
  if (m[2] === "jsonl" && place.attest && parent === resolve(place.attest.dir)) return m[1]!;
  return null;
}

/**
 * The newest checkpoint that can be trusted: sealed, chain verified, its map
 * matching the digest in its session_end, and -- when the surface declares a
 * signer -- covered by signed heads. A newer one that fails any of those is
 * skipped, so a forged checkpoint cannot replace a real one.
 */
export function newestTrustedCheckpoint(place: CheckpointPlace): { trail: string; mapFile: string; body: string } | null {
  let names: string[];
  try {
    names = readdirSync(place.dir);
  } catch {
    return null;
  }
  const attest = place.attest;
  const signer = Boolean(attest?.enabled && (attest.verify || attest.public_key));
  for (const f of names.filter((n) => /^checkpoint-.*\.jsonl$/.test(n)).sort().reverse()) {
    const file = join(place.dir, f);
    const v = verifyTrail(file, signer && attest ? { attest } : {});
    if (!v.ok || !v.sealed) continue;
    if (signer && (v.attestation?.status !== "signed" || v.attestation.unattested > 0)) continue;
    let end: AuditRecord | undefined;
    try {
      end = readFileSync(file, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as AuditRecord)
        .find((r) => r.kind === "session_end");
    } catch {
      continue;
    }
    const mapName = typeof end?.records_map === "string" ? end.records_map : "";
    if (!mapName || mapName.includes("/") || mapName.includes("\\")) continue;
    let body: string;
    try {
      body = readFileSync(join(place.dir, mapName), "utf-8");
    } catch {
      continue;
    }
    if (createHash("sha256").update(body).digest("hex") !== end!.records_digest) continue;
    return { trail: file, mapFile: join(place.dir, mapName), body };
  }
  return null;
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
export type TamperWhen = "during_call" | "between_calls" | "turn_end" | "since_last_session" | "at_accept";

export interface TamperFinding {
  when: TamperWhen;
  /** Tampering: an existing record modified or removed, or a file added that is not a gnomon trail. */
  changes: RecordChange[];
  /**
   * New gnomon trails another process wrote -- the operator's own `gnomon
   * skill reject` from a second terminal, a concurrent session, a killed run.
   * A warning (`record_notice`), not a stop: gnomon adds trails, it never
   * rewrites one, so a NEW chain that verifies is the expected shape of
   * another gnomon process. Re-review found the first version stopping a live
   * session on exactly that.
   */
  notices: RecordChange[];
}

/**
 * Whether a file is a gnomon trail: JSONL whose chain verifies and whose first
 * record is a session_start. Sealed or not -- a killed run leaves an unsealed
 * one. A hand-built chain passes this too, which is why it only earns a notice
 * and never counts as evidence by itself (#109 needs a signed head).
 */
export function isGnomonTrail(path: string): boolean {
  if (!path.endsWith(".jsonl")) return false;
  try {
    const first = readFileSync(path, "utf-8").split("\n", 1)[0] ?? "";
    if (!first.includes('"session_start"')) return false;
    const v = verifyTrail(path);
    return v.ok && v.records > 0;
  } catch {
    return false;
  }
}

/**
 * Split changes into tampering and notices. An ADDED gnomon trail is a
 * notice, and so are the files that belong to it: its attestation heads file
 * (`heads/<name>`) and a checkpoint's map (`<name>.files.json`). Anything
 * modified or removed, and any other added file, is tampering.
 */
export function classifyChanges(
  changes: RecordChange[],
  place?: CheckpointPlace
): { changes: RecordChange[]; notices: RecordChange[] } {
  // A checkpoint older than the newest trusted one is gnomon's to remove:
  // every session end keeps only its own (record_tamper.ts writeCheckpoint).
  // Another gnomon process doing so is neither tampering nor news -- its new
  // checkpoint is reported as an added trail. Only when a NEWER trusted
  // checkpoint is there: removing the newest, or the only one, is tampering.
  if (place && changes.some((c) => c.change === "removed" && checkpointStem(place, c.path))) {
    const newest = newestTrustedCheckpoint(place);
    const newestStem = newest ? basename(newest.trail).replace(/\.jsonl$/, "") : null;
    if (newestStem !== null) {
      changes = changes.filter((c) => {
        const stem = c.change === "removed" ? checkpointStem(place, c.path) : null;
        return !(stem !== null && stem < newestStem);
      });
    }
  }
  const trails = new Set(
    changes.filter((c) => c.change === "added" && isGnomonTrail(c.path)).map((c) => c.path)
  );
  const names = new Set([...trails].map((p) => p.split(/[\\/]/).pop()!));
  // A trial's report files belong to the trail that cites them: its
  // skill_trial record names `.gnomon-trials/<skill>/<stamp>/report.json`.
  const cited = [...trails].map((p) => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return "";
    }
  });
  const belongs = (c: RecordChange): boolean => {
    if (c.change !== "added") return false;
    if (trails.has(c.path)) return true;
    const trialDir = /[\\/](\.gnomon-trials[\\/].+)[\\/](?:report\.json|cells\.jsonl)$/.exec(c.path);
    if (trialDir && cited.some((t) => t.includes(trialDir[1]!.split("\\").join("/")))) return true;
    const parts = c.path.split(/[\\/]/);
    const name = parts[parts.length - 1]!;
    if (parts[parts.length - 2] === "heads" && names.has(name)) return true;
    return name.endsWith(".files.json") && names.has(name.replace(/\.files\.json$/, ".jsonl"));
  };
  return { changes: changes.filter((c) => !belongs(c)), notices: changes.filter(belongs) };
}

/**
 * One per session. `check()` compares the records with the last snapshot it
 * took, reports any change gnomon did not make, and moves its baseline on.
 */
export class RecordGuard {
  private baseline: RecordSnapshot;
  /** Every snapshot's cost, for the overhead the PR states. */
  readonly costs: number[] = [];

  constructor(
    private readonly dirs: string[],
    private readonly place?: CheckpointPlace,
    private readonly exclude: string[] = []
  ) {
    this.baseline = snapshotRecords(dirs, exclude);
    this.costs.push(this.baseline.ms);
  }

  static for(config: GnomonConfig): RecordGuard {
    return new RecordGuard(recordDirsOf(config), checkpointPlace(config), recordExcludesOf(config));
  }

  check(when: TamperWhen): TamperFinding | null {
    const now = snapshotRecords(this.dirs, this.exclude);
    this.costs.push(now.ms);
    const all = foreignChanges(this.baseline, now);
    // Changes gnomon's writer noticed at the moment it went to append.
    while (PENDING.length) {
      const p = PENDING.shift()!;
      if (this.dirs.some((d) => isUnder(d, p.path)) && !all.some((c) => c.path === p.path)) all.push(p);
    }
    this.baseline = now;
    const { changes, notices } = classifyChanges(all, this.place);
    return changes.length || notices.length ? { when, changes, notices } : null;
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

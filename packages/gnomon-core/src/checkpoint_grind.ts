/**
 * Checkpoint, then grind: `[turn] continue_after_answer = true` in
 * config.toml, read only under `gnomon task --deadline` (docs/CONTRACTS.md
 * §41, conformance/checkpoint_grind.json).
 *
 * Opt-in. Absent (or false), nothing here runs and the loop sends the model
 * exactly the requests it sent before this file existed.
 *
 * Why. With a real budget the model often answers with a third or more of it
 * unused (FG1, CF1: answers 9-13 minutes early under the half-time note; SW1/
 * CB1 T still stops well inside 1740 s). An anytime harness keeps the first
 * complete answer as a best-so-far and spends the rest improving it, with a
 * guard so the extra time can only help: when the model answers while at least
 * `continue_min_remaining` of the budget is left (default 1/3), the working
 * tree is snapshotted OUTSIDE the root (content-addressed copies in a private
 * temp directory; nothing is written into the graded tree), a `checkpoint`
 * audit event records the tree's content hash, and ONE continuation message
 * goes to the model. At the run's end (its next answer, or the deadline's
 * self-stop) the final tree is scored with the same visible check the
 * checkpoint was scored with, and the checkpoint is restored if the final is
 * worse. With no check, the final is kept and said to be unverified.
 *
 * The check is fixed when the checkpoint is taken: `[turn] checkpoint_check`
 * if declared, else the most recent test command the model ran with exit 0 in
 * this turn (stall_signals.ts's `test_command` pattern). It is run on the
 * checkpoint at once, so the end needs one more run, not two.
 *
 * Pure but for `takeCheckpoint` and `restoreCheckpoint`, which read and write
 * the filesystem: the loop owns the clock, the messages and the shell.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep, dirname, isAbsolute } from "node:path";
import type { GnomonConfig } from "./config.js";
import { CONTAINED_READONLY_DIRS } from "./root_fs.js";
import { STALL_SIGNAL_PATTERNS } from "./stall_signals.js";

/** Default share of the deadline budget that must remain for the continuation. */
export const CONTINUE_MIN_REMAINING_DEFAULT = 1 / 3;

/** The audit kind's `event` values, in the order a run can write them. */
export const CHECKPOINT_EVENTS = [
  "checkpoint",
  "checkpoint_skipped",
  "checkpoint_restored",
  "checkpoint_kept",
  "checkpoint_kept_unverified",
] as const;
export type CheckpointEvent = (typeof CHECKPOINT_EVENTS)[number];

/** Where the check came from. */
export const CHECK_SOURCES = ["configured", "session", "none"] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

/**
 * Directories at the root that are never snapshotted and never touched by a
 * restore: version control and gnomon's own state (its trail is written live).
 */
export const CHECKPOINT_EXCLUDED: readonly string[] = [
  ".git",
  ...CONTAINED_READONLY_DIRS,
  ".gnomon-jobs",
  ".gnomon-out",
];

/** Limits past which no checkpoint is taken (and so no continuation is sent). */
export const CHECKPOINT_LIMITS = { max_files: 100_000, max_bytes: 2 * 1024 ** 3 } as const;

export interface ResolvedCheckpointGrind {
  on: boolean;
  /** Share of the budget that must remain when the model answers, in (0, 1). */
  min_remaining: number;
  /** `[turn] checkpoint_check`, when declared. */
  check?: string;
  /** `[turn] continue_message`, when declared: the continuation text, `{minutes}` replaced by the minutes left. */
  message?: string;
}

function turnOf(config: GnomonConfig): Record<string, unknown> | undefined {
  return (config.config as { turn?: Record<string, unknown> } | undefined)?.turn;
}

/** Read `[turn] continue_after_answer`, `continue_min_remaining`, `checkpoint_check`. */
export function resolveCheckpointGrind(config: GnomonConfig): ResolvedCheckpointGrind {
  const t = turnOf(config);
  const m = t?.continue_min_remaining;
  const c = t?.checkpoint_check;
  const msg = t?.continue_message;
  return {
    on: t?.continue_after_answer === true,
    min_remaining: typeof m === "number" && m > 0 && m < 1 ? m : CONTINUE_MIN_REMAINING_DEFAULT,
    ...(typeof c === "string" && c.trim() ? { check: c.trim() } : {}),
    ...(typeof msg === "string" && msg.trim() ? { message: msg.trim() } : {}),
  };
}

/** What is wrong with the declared keys, in auditSurface's shape. */
export function auditCheckpointGrind(
  config: GnomonConfig
): Array<{ where: string; problem: string; fix: string; fatal: boolean }> {
  const t = turnOf(config);
  const out: Array<{ where: string; problem: string; fix: string; fatal: boolean }> = [];
  const v = t?.continue_after_answer;
  if (v !== undefined && typeof v !== "boolean") {
    out.push({
      where: ".gnomon/config.toml [turn] continue_after_answer",
      problem:
        `continue_after_answer = ${JSON.stringify(v)} is not a boolean. Refused rather than run ` +
        `without the checkpoint under a surface that seems to ask for it.`,
      fix: "continue_after_answer = true (or false, the default)",
      fatal: true,
    });
  }
  const m = t?.continue_min_remaining;
  if (m !== undefined && !(typeof m === "number" && m > 0 && m < 1)) {
    out.push({
      where: ".gnomon/config.toml [turn] continue_min_remaining",
      problem: `continue_min_remaining = ${JSON.stringify(m)} is not a fraction in (0, 1).`,
      fix: "continue_min_remaining = 0.33 (the default is 1/3)",
      fatal: true,
    });
  }
  const c = t?.checkpoint_check;
  if (c !== undefined && !(typeof c === "string" && c.trim())) {
    out.push({
      where: ".gnomon/config.toml [turn] checkpoint_check",
      problem: `checkpoint_check = ${JSON.stringify(c)} is not a command.`,
      fix: 'checkpoint_check = "pytest -q tests/"',
      fatal: true,
    });
  }
  const msg = t?.continue_message;
  if (msg !== undefined && !(typeof msg === "string" && msg.trim())) {
    out.push({
      where: ".gnomon/config.toml [turn] continue_message",
      problem: `continue_message = ${JSON.stringify(msg)} is not a non-empty string.`,
      fix: 'continue_message = "Your result is saved as a checkpoint. About {minutes} minutes remain. ..."',
      fatal: true,
    });
  }
  if (v !== true && (m !== undefined || c !== undefined || msg !== undefined)) {
    out.push({
      where: ".gnomon/config.toml [turn] checkpoint_check / continue_min_remaining / continue_message",
      problem: "declared without continue_after_answer = true, so it does nothing.",
      fix: "continue_after_answer = true, or remove the key",
      fatal: false,
    });
  }
  return out;
}

/**
 * The continuation message. Under `deadline_note = "none"` no time cue of any
 * kind reaches the model, so the minutes are left out there.
 */
export function continuationText(leftMs: number, withTime: boolean, custom?: string): string {
  const mins = Math.max(1, Math.round(leftMs / 60_000));
  if (custom !== undefined) {
    // `[turn] continue_message`: `{minutes}` is the minutes left (at least 1). Under `deadline_note = "none"` no time cue may reach the
    // model, so every sentence that holds the placeholder is dropped instead.
    if (withTime) return custom.split("{minutes}").join(String(mins));
    return custom.replace(/\s*[^.!?]*\{minutes\}[^.!?]*[.!?]/g, "").replace(/\s+/g, " ").trim();
  }
  return (
    `Your result is saved as a checkpoint.` +
    (withTime ? ` About ${mins} ${mins === 1 ? "minute remains" : "minutes remain"}.` : "") +
    ` Run the task's checks or tests, find what still fails or is untested against the task's ` +
    `requirements, and improve it. If you make it worse, it will be restored.`
  );
}

/** Whether a bash command is a test run, by the stall detectors' pattern. */
export function isTestCommand(command: string): boolean {
  return STALL_SIGNAL_PATTERNS.test_command.test(command);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface CheckScore {
  /** The shell's exit status; null when it could not be read (killed). */
  exit: number | null;
  /** Tests passed, when the output says (pytest, jest/vitest, cargo, unittest, go -v). */
  passed?: number;
  /** The check did not finish in the time it had. */
  timed_out?: boolean;
}

/** The number of passing tests an output reports, or undefined. */
export function passCount(output: string): number | undefined {
  let found = false;
  let n = 0;
  for (const m of output.matchAll(/\b(\d+) (?:passed|passing)\b/g)) {
    n += Number(m[1]);
    found = true;
  }
  if (!found) {
    const ran = /\bRan (\d+) tests?\b/.exec(output);
    if (ran) {
      const fails = /\bFAILED \(([^)]*)\)/.exec(output);
      let bad = 0;
      if (fails) for (const f of fails[1]!.matchAll(/(?:failures|errors)=(\d+)/g)) bad += Number(f[1]);
      return Math.max(0, Number(ran[1]) - bad);
    }
    const go = output.match(/^--- PASS: /gm);
    if (go) return go.length;
  }
  return found ? n : undefined;
}

/**
 * Whether `final` is worse than `ckpt`: the check now fails where it passed,
 * or fewer tests pass. Equal or better is not worse.
 */
export function scoreWorse(ckpt: CheckScore, final: CheckScore): boolean {
  if (ckpt.exit === 0 && final.exit !== 0) return true;
  if (ckpt.passed !== undefined && final.passed !== undefined && final.passed < ckpt.passed) return true;
  return false;
}

/** A check whose result at the checkpoint says nothing: it could not run. */
export function checkUsable(ckpt: CheckScore): boolean {
  return !ckpt.timed_out && ckpt.exit !== 126 && ckpt.exit !== 127;
}

/**
 * The end decision. `final` undefined: the final check could not be run or
 * did not finish (no time left), so the final is kept, unverified.
 */
export function decideCheckpoint(
  ckpt: CheckScore | undefined,
  final: CheckScore | undefined
): "checkpoint_restored" | "checkpoint_kept" | "checkpoint_kept_unverified" {
  if (!ckpt || !checkUsable(ckpt) || !final || final.timed_out) return "checkpoint_kept_unverified";
  return scoreWorse(ckpt, final) ? "checkpoint_restored" : "checkpoint_kept";
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

interface Entry {
  kind: "file" | "link";
  /** sha256 of the content (file) or the link target (link) */
  hash: string;
  mode: number;
  target?: string;
}

export interface TreeCheckpoint {
  root: string;
  /** The blob store, outside the root */
  store: string;
  files: Map<string, Entry>;
  dirs: Set<string>;
  /** Paths that could not be read: never removed or rewritten by a restore */
  unread: Set<string>;
  /** sha256 over the sorted entries: the tree's content hash */
  hash: string;
  bytes: number;
}

function excluded(rel: string): boolean {
  const top = rel.split("/")[0]!;
  return CHECKPOINT_EXCLUDED.includes(top);
}

interface Walked {
  files: Map<string, Entry & { abs: string; size: number }>;
  dirs: Set<string>;
  unread: Set<string>;
}

function hashFile(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

function walk(root: string, limits: { max_files: number; max_bytes: number }, extraSkip?: string): Walked | { too_large: string } {
  const files: Walked["files"] = new Map();
  const dirs = new Set<string>();
  const unread = new Set<string>();
  let bytes = 0;
  const visit = (dirAbs: string, dirRel: string): string | undefined => {
    let names: string[];
    try {
      names = readdirSync(dirAbs);
    } catch {
      if (dirRel) unread.add(dirRel);
      return undefined;
    }
    for (const name of names.sort()) {
      const rel = dirRel ? `${dirRel}/${name}` : name;
      if (excluded(rel)) continue;
      const abs = join(dirAbs, name);
      if (extraSkip && (abs === extraSkip || abs.startsWith(extraSkip + sep))) continue;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        unread.add(rel);
        continue;
      }
      if (st.isSymbolicLink()) {
        try {
          const target = readlinkSync(abs);
          files.set(rel, { kind: "link", hash: createHash("sha256").update(target).digest("hex"), mode: 0, target, abs, size: 0 });
        } catch {
          unread.add(rel);
        }
      } else if (st.isDirectory()) {
        dirs.add(rel);
        const why = visit(abs, rel);
        if (why) return why;
      } else if (st.isFile()) {
        if (files.size + 1 > limits.max_files) return `more than ${limits.max_files} files`;
        bytes += st.size;
        if (bytes > limits.max_bytes) return `more than ${limits.max_bytes} bytes`;
        try {
          files.set(rel, { kind: "file", hash: hashFile(abs), mode: st.mode & 0o777, abs, size: st.size });
        } catch {
          unread.add(rel);
        }
      }
      // Sockets, fifos and devices are neither snapshotted nor touched.
    }
    return undefined;
  };
  const why = visit(root, "");
  return why ? { too_large: why } : { files, dirs, unread };
}

function treeHash(files: Map<string, Entry>): string {
  const h = createHash("sha256");
  for (const rel of [...files.keys()].sort()) {
    const e = files.get(rel)!;
    h.update(`${rel}\0${e.kind}\0${e.hash}\0${e.mode.toString(8)}\n`);
  }
  return h.digest("hex");
}

/** The content hash of the tree under `root` as it is now (the checkpoint's exclusions apply). */
export function currentTreeHash(root: string): string | undefined {
  const w = walk(root, CHECKPOINT_LIMITS);
  return "too_large" in w ? undefined : treeHash(w.files);
}

function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/**
 * Snapshot the tree under `root` into a new store under `storeParent`
 * (default: the OS temp directory). Writes nothing under `root`. A store that
 * would land inside the root is refused, as is a tree past the limits.
 */
export function takeCheckpoint(
  root: string,
  opts: { storeParent?: string; limits?: { max_files: number; max_bytes: number } } = {}
): TreeCheckpoint | { skipped: string } {
  const absRoot = resolve(root);
  const parent = resolve(opts.storeParent ?? tmpdir());
  if (inside(parent, absRoot)) return { skipped: "the temp directory is inside the root" };
  const w = walk(absRoot, opts.limits ?? CHECKPOINT_LIMITS);
  if ("too_large" in w) return { skipped: `tree too large: ${w.too_large}` };
  let store: string;
  try {
    store = mkdtempSync(join(parent, "gnomon-ckpt-"));
  } catch (e) {
    return { skipped: `no store: ${(e as Error).message}` };
  }
  const files = new Map<string, Entry>();
  let bytes = 0;
  try {
    for (const [rel, e] of w.files) {
      if (e.kind === "file") {
        const blob = join(store, e.hash);
        if (!existsSync(blob)) copyFileSync(e.abs, blob);
        bytes += e.size;
      }
      files.set(rel, { kind: e.kind, hash: e.hash, mode: e.mode, ...(e.target !== undefined ? { target: e.target } : {}) });
    }
  } catch (e) {
    rmSync(store, { recursive: true, force: true });
    return { skipped: `copy failed: ${(e as Error).message}` };
  }
  return { root: absRoot, store, files, dirs: w.dirs, unread: w.unread, hash: treeHash(files), bytes };
}

/**
 * Put the tree back as it was at the checkpoint: files created since are
 * removed, changed or removed ones rewritten from the store, directories
 * created since removed when empty. Excluded directories and unreadable paths
 * are left alone. Returns the counts and whether the tree's hash is the
 * checkpoint's again.
 */
export function restoreCheckpoint(cp: TreeCheckpoint): { rewritten: number; removed: number; verified: boolean } {
  const w = walk(cp.root, { max_files: Number.MAX_SAFE_INTEGER, max_bytes: Number.MAX_SAFE_INTEGER });
  let rewritten = 0;
  let removed = 0;
  const now = "too_large" in w ? undefined : w;
  if (now) {
    for (const [rel, e] of now.files) {
      if (cp.files.has(rel) || cp.unread.has(rel)) continue;
      try {
        unlinkSync(e.abs);
        removed++;
      } catch {
        /* left as it is; the hash check below says so */
      }
    }
  }
  for (const [rel, e] of cp.files) {
    const cur = now?.files.get(rel);
    if (cur && cur.kind === e.kind && cur.hash === e.hash && cur.mode === e.mode) continue;
    const abs = join(cp.root, ...rel.split("/"));
    try {
      // A directory, or a file where a parent directory should be, is cleared first.
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) {
        const p = join(cp.root, ...parts.slice(0, i));
        try {
          const st = lstatSync(p);
          if (!st.isDirectory()) unlinkSync(p);
        } catch {
          /* absent: made below */
        }
      }
      mkdirSync(dirname(abs), { recursive: true });
      try {
        const st = lstatSync(abs);
        if (st.isDirectory()) rmSync(abs, { recursive: true, force: true });
        else unlinkSync(abs);
      } catch {
        /* absent */
      }
      if (e.kind === "link") symlinkSync(e.target!, abs);
      else {
        copyFileSync(join(cp.store, e.hash), abs);
        chmodSync(abs, e.mode);
      }
      rewritten++;
    } catch {
      /* the hash check below says so */
    }
  }
  // Directories created since the checkpoint, deepest first, when empty.
  const after = walk(cp.root, { max_files: Number.MAX_SAFE_INTEGER, max_bytes: Number.MAX_SAFE_INTEGER });
  if (!("too_large" in after)) {
    for (const d of [...after.dirs].sort((a, b) => b.length - a.length)) {
      if (cp.dirs.has(d) || cp.unread.has(d)) continue;
      try {
        rmdirSync(join(cp.root, ...d.split("/")));
      } catch {
        /* not empty (an unreadable file in it): left */
      }
    }
  }
  return { rewritten, removed, verified: currentTreeHash(cp.root) === cp.hash };
}

/** Remove the checkpoint's store. Idempotent. */
export function dropCheckpoint(cp: TreeCheckpoint): void {
  rmSync(cp.store, { recursive: true, force: true });
}

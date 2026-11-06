/**
 * Every write gnomon makes on the host into a project root.
 *
 * WHY (fifth review). Under exec = "docker" the model's bash runs in a
 * container that bind-mounts the root read-write, and under exec = "os" it
 * runs on the host with write access to the root. Either way the model can
 * put a symlink, a hard link or a directory where gnomon is about to write.
 * `appendFileSync(".gnomon-sessions/history")` then followed a symlink the
 * container planted to `~/.local/share/gnomon/trust.json`, corrupted the
 * trust store and erased every exec floor; `appendFileSync` of an audit line
 * through a symlink to `~/.bashrc` appended the recorded command text to it.
 * The host process was writing with the user's authority to wherever the
 * contained process pointed it.
 *
 * So every host write under a root goes through here:
 *   - each directory from the real root down is created by gnomon or must
 *     already be a plain directory (lstat; never a symlink);
 *   - files are opened with O_NOFOLLOW, appends with O_APPEND, new files with
 *     O_EXCL, and a whole-file write goes to a fresh temp file renamed into
 *     place (a rename replaces a symlink; it never writes through one);
 *   - an opened file must be a regular file with one link (a hard link to a
 *     file outside the root has two), and on Linux the descriptor's real path
 *     (/proc/self/fd) must still be inside the root, which catches a parent
 *     directory swapped for a symlink between the checks and the open.
 *
 * A path outside the root (an audit dir configured elsewhere, the data dir)
 * is written as before: nothing contained can reach it.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { gnomonDataDir } from "./credentials.js";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** A write gnomon refused because the path under the root is not what gnomon made. */
export class RootWriteError extends Error {
  readonly code = "EGNOMONROOT";
  constructor(message: string) {
    super(message);
    this.name = "RootWriteError";
  }
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function within(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The real root and `path`'s components below it, or null when `path` is not under `root`. */
function below(root: string, path: string): { realRoot: string; parts: string[] } | null {
  const r = resolve(root);
  const p = resolve(path);
  if (!within(r, p)) {
    // Spelled through the root's real path rather than the one given.
    const rr = realOr(r);
    if (!within(rr, p)) return null;
    return { realRoot: rr, parts: relative(rr, p).split(sep).filter(Boolean) };
  }
  return { realRoot: realOr(r), parts: relative(r, p).split(sep).filter(Boolean) };
}

/**
 * Make `dir` (and every directory between the root and it), refusing any
 * component that exists as something other than a plain directory. Returns
 * the directory's path spelled from the real root.
 */
export function ensureDirIn(root: string, dir: string, mode?: number): string {
  const b = below(root, dir);
  if (!b) {
    mkdirSync(dir, { recursive: true, ...(mode !== undefined ? { mode } : {}) });
    return dir;
  }
  let cur = b.realRoot;
  for (const part of b.parts) {
    cur = join(cur, part);
    let st = lstatOrNull(cur);
    if (!st) {
      try {
        mkdirSync(cur, mode !== undefined ? { mode } : undefined);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      st = lstatOrNull(cur);
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      throw new RootWriteError(
        `${cur} is not a plain directory (a symlink or a file where gnomon writes its own state); not writing through it`
      );
    }
  }
  return cur;
}

/** The checks an opened descriptor must pass before anything is written to it. */
function verifyFd(fd: number, realRoot: string, path: string): void {
  const st = fstatSync(fd);
  if (!st.isFile()) throw new RootWriteError(`${path} is not a regular file; not writing to it`);
  if (st.nlink > 1) throw new RootWriteError(`${path} has ${st.nlink} hard links; not writing to it`);
  if (process.platform === "linux") {
    let real: string | null = null;
    try {
      real = readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      real = null;
    }
    if (real !== null && !within(realRoot, real)) {
      throw new RootWriteError(`${path} resolved outside the project root (${real}); not writing to it`);
    }
  }
}

function placed(root: string, file: string): { realRoot: string; dir: string; target: string } | null {
  const b = below(root, file);
  if (!b) return null;
  const dir = ensureDirIn(root, dirname(resolve(file)));
  return { realRoot: b.realRoot, dir, target: join(dir, basename(file)) };
}

/**
 * Open `file` for appending, created if absent: O_APPEND | O_NOFOLLOW, then
 * checked. A long-lived log keeps the descriptor rather than reopening the
 * path per line, so a swap after the first open changes nothing.
 */
export function openAppendIn(root: string, file: string, mode = 0o644): number {
  const p = placed(root, file);
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW;
  if (!p) {
    mkdirSync(dirname(resolve(file)), { recursive: true });
    return openSync(file, flags, mode);
  }
  let fd: number;
  try {
    fd = openSync(p.target, flags, mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP" || (e as NodeJS.ErrnoException).code === "EMLINK") {
      throw new RootWriteError(`${p.target} is a symlink; not writing through it`);
    }
    throw e;
  }
  try {
    verifyFd(fd, p.realRoot, p.target);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/** Append `data` to `file` under `root`, safely. */
export function appendFileIn(root: string, file: string, data: string | Uint8Array, mode = 0o644): void {
  const fd = openAppendIn(root, file, mode);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write `file` under `root` whole: a fresh temp file (O_EXCL | O_NOFOLLOW)
 * beside it, checked, then renamed over it. Whatever was at `file` -- a
 * symlink included -- is replaced, never written through.
 */
export function writeFileIn(root: string, file: string, data: string | Uint8Array, mode = 0o644): void {
  const p = placed(root, file);
  if (!p) {
    mkdirSync(dirname(resolve(file)), { recursive: true });
    writeFileSync(file, data, { mode });
    return;
  }
  const existing = lstatOrNull(p.target);
  if (existing && existing.isDirectory()) throw new RootWriteError(`${p.target} is a directory; not replacing it`);
  const tmp = join(p.dir, `.${basename(p.target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    verifyFd(fd, p.realRoot, tmp);
    writeFileSync(fd, data);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, p.target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    throw e;
  }
}

/**
 * Create `file` under `root` only if it does not exist (a lock, a marker):
 * O_CREAT | O_EXCL, which never follows a symlink. Throws EEXIST as
 * openSync(file, "wx") does.
 */
export function createExclusiveIn(root: string, file: string, data: string | Uint8Array = "", mode = 0o644): void {
  const p = placed(root, file);
  const target = p ? p.target : file;
  if (!p) mkdirSync(dirname(resolve(file)), { recursive: true });
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    if (p) verifyFd(fd, p.realRoot, target);
    if (data.length > 0) writeFileSync(fd, data);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(target);
    } catch {
      /* gone */
    }
    throw e;
  }
  closeSync(fd);
}

/**
 * Where gnomon keeps its own state for one repository: under the data dir,
 * keyed by the git dir's real path -- never inside the git dir. `.git/` is
 * writable by a contained command (only its config, hooks/ and info/ are
 * mounted read-only), so a session base, a rules cache or a restore journal
 * kept there was the container's to rewrite: a journal naming `~/.bashrc`
 * was restored onto it by the next `gnomon check` (fifth review).
 */
export function repoStateDir(gitDir: string): string {
  const id = createHash("sha256").update(realOr(gitDir)).digest("hex").slice(0, 16);
  return join(gnomonDataDir(), "repos", id);
}

/** The base `gnomon check --hook session-start` recorded for a session (read by `gnomon guard`). */
export function checkSessionFile(gitDir: string, session: string): string {
  return join(repoStateDir(gitDir), "check", "sessions", `${session}.json`);
}

/**
 * Directories under a root that hold gnomon's own state. A contained command
 * gets them read-only: the configuration (the surface, which names how the
 * next session is contained), the audit trail and the saved sessions.
 */
export const CONTAINED_READONLY_DIRS = [".gnomon", ".gnomon-audit", ".gnomon-sessions"] as const;

/**
 * The host paths under `root` a contained command must not write, made ready
 * to be mounted (docker) or denied (the OS sandbox) read-only:
 *
 *   .gnomon/ .gnomon-audit/ .gnomon-sessions/
 *   .git/config .git/hooks/ .git/info/ .git/commondir   (a .git directory)
 *   .git                                                 (a .git file)
 *
 * WHY (fifth review). Host gnomon reads, writes and runs git inside the root.
 * Each bypass the reviews found -- a filter planted in .git/config and run by
 * the host's next `git status`, a symlink where the audit trail goes, a
 * surface rewritten to `exec = "off"` -- was the contained command writing a
 * file the host then trusted. The model needs none of these: it edits code
 * and can still `git add` and `git commit` (the index, objects and refs stay
 * writable). Editing `.gnomon/*.toml` is the operator's, not the model's.
 *
 * Record directories that do not exist are created (by gnomon, as the user)
 * so there is something to mount: a missing mount point would be created by
 * the docker daemon, as root, inside the project. `.git/hooks` and
 * `.git/info` likewise. A path that exists as a symlink or the wrong kind of
 * file is refused, never mounted: docker would resolve it.
 */
export function containedReadonlyPaths(root: string): string[] {
  const out: string[] = [];
  const refuse = (p: string, what: string) => {
    throw new RootWriteError(`${p} is ${what}; the sandbox will not run with it there (gnomon keeps it read-only to contained commands)`);
  };
  const want = (p: string, kind: "dir" | "file" | "either", create: boolean) => {
    let st = lstatOrNull(p);
    if (!st && create) {
      try {
        ensureDirIn(root, p);
      } catch (e) {
        if (e instanceof RootWriteError) throw e;
        return; // read-only checkout, no permission: nothing contained can make it either
      }
      st = lstatOrNull(p);
    }
    if (!st) return;
    if (st.isSymbolicLink()) refuse(p, "a symlink");
    if (kind === "dir" && !st.isDirectory()) refuse(p, "not a directory");
    if (kind === "file" && !st.isFile()) refuse(p, "not a regular file");
    if (!st.isDirectory() && !st.isFile()) refuse(p, "neither a file nor a directory");
    out.push(p);
  };
  const base = resolve(root);
  if (!lstatOrNull(base)) return out;
  for (const d of CONTAINED_READONLY_DIRS) want(join(base, d), "dir", d !== ".gnomon");
  const git = join(base, ".git");
  const g = lstatOrNull(git);
  if (g?.isSymbolicLink()) refuse(git, "a symlink");
  else if (g?.isFile()) out.push(git);
  else if (g?.isDirectory()) {
    want(join(git, "config"), "file", false);
    want(join(git, "commondir"), "file", false);
    want(join(git, "hooks"), "dir", true);
    want(join(git, "info"), "dir", true);
  }
  return out;
}

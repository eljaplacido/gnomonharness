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
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  chmodSync,
  realpathSync,
  statSync,
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
// `.gnomon-loops/` too (sixth review): loop state the host reads to decide
// whether a loop is tripped -- the container resetting it un-tripped a loop.
export const CONTAINED_READONLY_DIRS = [".gnomon", ".gnomon-audit", ".gnomon-sessions", ".gnomon-loops"] as const;

/**
 * The host paths under `root` a contained command must not write, made ready
 * to be mounted (docker) or denied (the OS sandbox) read-only:
 *
 *   .gnomon/ .gnomon-audit/ .gnomon-sessions/ .gnomon-loops/
 *   .git/config .git/hooks/ .git/info/ .git/commondir .git/config.worktree
 *                                                        (a .git directory)
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
    for (const p of gitControlPaths(base, git)) {
      if (p.placeholder !== undefined) placeholder(p.path, p.placeholder);
      want(p.path, p.kind, p.kind === "dir" && p.create === true);
    }
  }
  return out;
}

interface ControlPath {
  path: string;
  kind: "file" | "dir";
  /** Created as this, by gnomon, when absent (a file), so the container cannot plant it. */
  placeholder?: string;
  /** A directory created when absent. */
  create?: boolean;
}

/** At most this many git dirs (submodules, nested) are walked; more is refused, not half-protected. */
const MAX_GIT_DIRS = 256;

/**
 * Git's control files under a git dir, read-only to a contained command:
 * its config, hooks/ and info/, commondir and config.worktree (placeholders
 * when absent -- sixth review), and, recursively (seventh review, B5):
 *
 *   - each linked worktree's admin dir, `worktrees/<wt>/`, whole. Its
 *     `commondir` names the repository the user's linked worktree (outside
 *     the root) uses: rewritten, it pointed the user's `git status` there at a
 *     config with an fsmonitor of the container's. A container has no use
 *     for another worktree's admin files; `git worktree add` inside it still
 *     works (worktrees/ itself stays writable, and git never reuses a name).
 *   - each submodule's git dir under `modules/` (names may nest: `libs/a`),
 *     protected like the top level, and its own modules in turn. Its config
 *     and hooks are what the user's `git status` at the top runs when it
 *     looks into the submodule.
 *
 * Also each submodule's `.git` file in its working tree, when that is
 * inside `root`: rewritten, it redirected the submodule to a git dir the
 * container made.
 */
function gitControlPaths(root: string, gitDir: string, seen = { n: 0 }, opts: { lenient?: boolean } = {}): ControlPath[] {
  if (++seen.n > MAX_GIT_DIRS) throw new RootWriteError(`${gitDir}: more than ${MAX_GIT_DIRS} nested git directories; not setting up a sandbox over them`);
  const out: ControlPath[] = [
    { path: join(gitDir, "config"), kind: "file" },
    // An empty commondir is NOT "nothing": git refuses the repository
    // ("failed to read .git/commondir"). `.` is the git dir itself.
    { path: join(gitDir, "commondir"), kind: "file", placeholder: ".\n" },
    { path: join(gitDir, "config.worktree"), kind: "file", placeholder: "" },
    { path: join(gitDir, "hooks"), kind: "dir", create: true },
    { path: join(gitDir, "info"), kind: "dir", create: true },
  ];
  for (const wt of childDirs(join(gitDir, "worktrees"), opts.lenient)) {
    // Lenient (the exec = "os" snapshot on Linux, which puts back what it
    // recorded): only a worktree's redirects. Its index and HEAD are the
    // user's git's to change while a command runs, and putting them back
    // would undo the user's work.
    if (opts.lenient) {
      for (const f of ["commondir", "config.worktree", "gitdir"]) out.push({ path: join(wt, f), kind: "file" });
    } else out.push({ path: wt, kind: "dir" });
  }
  for (const sub of submoduleGitDirs(join(gitDir, "modules"), 0, opts.lenient)) {
    out.push(...gitControlPaths(root, sub, seen, opts));
    const file = submoduleGitFile(root, sub);
    if (file) out.push({ path: file, kind: "file" });
  }
  return out;
}

/** The plain directories directly in `dir` (none when it is absent or not a plain directory). */
function childDirs(dir: string, lenient = false): string[] {
  const st = lstatOrNull(dir);
  if (!st) return [];
  if (st.isSymbolicLink() || !st.isDirectory()) {
    if (lenient) return [];
    throw new RootWriteError(`${dir} is not a plain directory; the sandbox will not run with it there`);
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  // Anything else there (a file, a symlink) is no worktree git made: nothing
  // the user's git reads, so nothing to protect.
  return names.map((n) => join(dir, n)).filter((p) => {
    const c = lstatOrNull(p);
    return c !== null && c.isDirectory() && !c.isSymbolicLink();
  });
}

/** The git dirs under a `modules/` directory: a dir holding a HEAD file is one; any other is a name prefix. */
function submoduleGitDirs(modules: string, depth = 0, lenient = false): string[] {
  if (depth > 16) return [];
  const out: string[] = [];
  for (const d of childDirs(modules, lenient)) {
    if (lstatOrNull(join(d, "HEAD"))?.isFile()) out.push(d);
    else out.push(...submoduleGitDirs(d, depth + 1, lenient));
  }
  return out;
}

/** `<worktree>/.git` of the submodule whose git dir is `sub`, when its core.worktree is inside `root` and it is a file. */
function submoduleGitFile(root: string, sub: string): string | null {
  let text: string;
  const cfg = join(sub, "config");
  // Only a plain, small file is read: a container-made symlink to /dev/zero
  // must not hang the host (it is refused as a mount by want() regardless).
  const st = lstatOrNull(cfg);
  if (!st || !st.isFile() || st.size > 1 << 20) return null;
  try {
    text = readFileSync(cfg, "utf-8");
  } catch {
    return null;
  }
  const m = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const wt = resolve(sub, m[1]!.replace(/^"(.*)"$/, "$1"));
  if (!within(resolve(root), wt) || wt === resolve(root)) return null;
  const f = join(wt, ".git");
  return lstatOrNull(f)?.isFile() ? f : null;
}

/** The directories between `root` (exclusive) and `path` (inclusive). */
function chainBelow(root: string, path: string): string[] {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
  const out: string[] = [];
  let cur = root;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    out.push(cur);
  }
  return out;
}

/**
 * What a guarded command found and put back (exec = "os" on Linux, where the
 * kernel cannot make a subtree of the root read-only: Landlock is an
 * allow-list, and a write grant on the root covers everything beneath it).
 */
export interface ProtectedSnapshot {
  root: string;
  entries: Map<string, { kind: "file" | "dir"; mode: number; data: Buffer | null }>;
  /** Where the walk started, when the snapshot was taken (absent: found again at restore). */
  tops?: string[];
  /**
   * `.git` itself, when it is a directory (sixth review, finding 3): Landlock
   * cannot stop it being renamed away (`mv .git .git-old && mkdir .git`), so
   * the restore compares it and says so when it is not the same directory.
   */
  git?: FileIdentity | null;
}

/** Files above this are recorded by kind only; a change to one is reported, not restored. */
const SNAPSHOT_FILE_CAP = 4 * 1024 * 1024;

/** The paths walkProtected starts from under `root`, found from what is there now. */
function protectedTops(root: string): string[] {
  // The surface and git's control files: the ones a command can use to
  // loosen the next one. Not the record dirs, which gnomon writes between
  // commands itself (root_fs.ts writes and the record guard cover them).
  // Found from what is there now, never refusing: a symlink in place of one
  // is exactly what this has to see and remove.
  const base = resolve(root);
  const git = join(base, ".git");
  const g = lstatOrNull(git);
  // `.gnomon-loops/` too (sixth review, finding 7): loop state, which no
  // command run inside a session has gnomon write.
  const tops = [join(base, ".gnomon"), join(base, ".gnomon-loops")];
  if (g?.isDirectory()) {
    // The same control files the docker mounts read-only (gitControlPaths),
    // linked worktrees' redirects and submodules' git dirs included
    // (seventh review, B5). Never refusing: past the cap, the top level.
    let paths: string[];
    try {
      paths = gitControlPaths(base, git, { n: 0 }, { lenient: true }).map((p) => p.path);
    } catch {
      paths = [join(git, "config"), join(git, "commondir"), join(git, "config.worktree"), join(git, "hooks"), join(git, "info")];
    }
    tops.push(...paths);
  } else if (g) tops.push(git);
  return tops;
}

/**
 * Walk the protected paths. `tops` as recorded when the snapshot was taken:
 * a submodule or worktree the command itself made is its own (protected from
 * the next command on), and is not removed as if it had been planted.
 */
function walkProtected(root: string, onEntry: (abs: string, st: Stats) => void, tops = protectedTops(root)): void {
  const walk = (abs: string) => {
    const st = lstatOrNull(abs);
    if (!st) return;
    onEntry(abs, st);
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(abs);
      } catch {
        names = [];
      }
      for (const n of names.sort()) walk(join(abs, n));
    }
  };
  for (const t of tops) walk(t);
}

/** Record the surface and git's control files under `root`, contents included. */
export function snapshotProtected(root: string): ProtectedSnapshot {
  const entries: ProtectedSnapshot["entries"] = new Map();
  const tops = protectedTops(root);
  walkProtected(root, (abs, st) => {
    if (st.isDirectory()) entries.set(abs, { kind: "dir", mode: st.mode & 0o7777, data: null });
    else if (st.isFile()) {
      let data: Buffer | null = null;
      if (st.size <= SNAPSHOT_FILE_CAP) {
        try {
          data = readFileSync(abs);
        } catch {
          data = null;
        }
      }
      entries.set(abs, { kind: "file", mode: st.mode & 0o7777, data });
    }
  });
  const git = join(resolve(root), ".git");
  return { root, entries, tops, git: lstatOrNull(git)?.isDirectory() ? identityOf(git) : undefined };
}

/**
 * Put back what changed since `snap` was taken: remove what appeared (links
 * included), recreate what went, rewrite what changed. Returns the paths it
 * touched, relative to the root, and what it could not restore.
 */
export function restoreProtected(snap: ProtectedSnapshot): { restored: string[]; unrestorable: string[] } {
  const restored: string[] = [];
  const unrestorable: string[] = [];
  const rel = (p: string) => relative(resolve(snap.root), p) || ".";
  if (snap.git) {
    const git = join(resolve(snap.root), ".git");
    const is = identityOf(git);
    // ctime moves with any entry made or removed inside; the inode does not.
    if (!is || is.dev !== snap.git.dev || is.ino !== snap.git.ino) {
      unrestorable.push(".git (the directory was replaced: the repository the command started with was moved or removed)");
    }
  }
  const now = new Map<string, Stats>();
  walkProtected(snap.root, (abs, st) => now.set(abs, st), snap.tops);
  // Appeared, or changed kind: removed, deepest first.
  for (const abs of [...now.keys()].sort((a, b) => b.length - a.length)) {
    const st = now.get(abs)!;
    const was = snap.entries.get(abs);
    const sameKind = was && ((was.kind === "dir" && st.isDirectory() && !st.isSymbolicLink()) || (was.kind === "file" && st.isFile()));
    if (sameKind) continue;
    try {
      rmSync(abs, { recursive: true, force: true });
      restored.push(rel(abs));
    } catch {
      unrestorable.push(rel(abs));
    }
  }
  // Recreated or rewritten, shallowest first.
  for (const [abs, was] of [...snap.entries].sort((a, b) => a[0].length - b[0].length)) {
    const st = lstatOrNull(abs);
    try {
      if (was.kind === "dir") {
        if (!st) {
          ensureDirIn(snap.root, abs, was.mode);
          if (!restored.includes(rel(abs))) restored.push(rel(abs));
        }
        continue;
      }
      if (was.data === null) {
        if (!st) unrestorable.push(rel(abs));
        continue;
      }
      const same = st && st.isFile() && st.size === was.data.length && readFileSync(abs).equals(was.data);
      if (!same) {
        writeFileIn(snap.root, abs, was.data, was.mode);
        if (!restored.includes(rel(abs))) restored.push(rel(abs));
      } else if (st && (st.mode & 0o7777) !== was.mode) {
        chmodSync(abs, was.mode);
        if (!restored.includes(rel(abs))) restored.push(rel(abs));
      }
    } catch {
      unrestorable.push(rel(abs));
    }
  }
  return { restored, unrestorable };
}

/** Create `file` with `data` unless something is there already; a failure leaves it absent. */
function placeholder(file: string, data: string): void {
  if (lstatOrNull(file)) return;
  try {
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
    try {
      if (data) writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* read-only checkout, a race: whatever is there is checked by want() */
  }
}

/**
 * Directories under `root` mounted read-write ON THEMSELVES before the
 * read-only children (sixth review): `.git` when it is a directory. Nested
 * read-only mounts do not stop the parent from being renamed --
 * `mv .git .git-old && mkdir .git` left every protection on the old
 * directory and handed the user's git a fresh one the container wrote. A
 * mount point cannot be renamed or removed (EBUSY).
 */
export function containedMountPoints(root: string): string[] {
  const base = resolve(root);
  const git = join(base, ".git");
  const st = lstatOrNull(git);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return [];
  // Seventh review (B5): the same for every directory that holds a
  // read-only mount git's control files moved into -- worktrees/, modules/
  // and each submodule git dir on the way down, and the directories from
  // the root to a submodule's working tree (whose `.git` file is read-only).
  const out = new Set<string>([git]);
  const walk = (gitDir: string) => {
    const wts = join(gitDir, "worktrees");
    if (childDirs(wts).length > 0) out.add(wts);
    for (const sub of submoduleGitDirs(join(gitDir, "modules"))) {
      for (const d of chainBelow(gitDir, sub)) out.add(d);
      const file = submoduleGitFile(base, sub);
      if (file) for (const d of chainBelow(base, dirname(file))) out.add(d);
      walk(sub);
    }
  };
  walk(git);
  // Parents before children: docker mounts in the order given.
  return [...out].sort((a, b) => a.split(sep).length - b.split(sep).length);
}

// ---------------------------------------------------------------------------
// Host reads and writes of files the model names (sixth review)
// ---------------------------------------------------------------------------

const NONBLOCK = constants.O_NONBLOCK ?? 0;

/** The real path of `p`, resolving whatever part of it exists; the rest re-attached. */
function realNearest(p: string): string {
  const parts: string[] = [];
  let cur = resolve(p);
  for (let i = 0; i < 256; i++) {
    try {
      return parts.length ? join(realpathSync(cur), ...parts) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      parts.unshift(basename(cur));
      cur = parent;
    }
  }
  return resolve(p);
}

/** The first of `roots` whose real path contains `real`, spelled real; null when none does. */
function rootOf(roots: string[], real: string): string | null {
  for (const r of roots) {
    const rr = realOr(resolve(r));
    if (within(rr, real)) return rr;
  }
  return null;
}

function kindOf(st: Stats): string {
  if (st.isFIFO()) return "a FIFO";
  if (st.isSocket()) return "a socket";
  if (st.isCharacterDevice()) return "a character device";
  if (st.isBlockDevice()) return "a block device";
  if (st.isDirectory()) return "a directory";
  if (st.isSymbolicLink()) return "a symlink";
  return "not a regular file";
}

/** The descriptor's real path (Linux /proc), or null when it cannot be read. */
function fdPath(fd: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/**
 * Read a file the model named, as host gnomon.
 *
 * WHY (sixth review). Under exec = "docker" (and "os") the model shapes the
 * tree between its tool calls, and host gnomon reads with the user's
 * authority. A FIFO hung the read; a device node read the device; a file
 * swapped for a symlink after the path was checked read whatever it pointed
 * at. So: stat first (never open a device), open O_NONBLOCK (a FIFO cannot
 * block), fstat the descriptor (what was opened is a regular file), and on
 * Linux check the descriptor's real path lies under one of `roots`.
 *
 * `roots` empty means unconfined (sandbox = "off"): only the kind is checked.
 * Hard links are allowed for reading (pnpm's node_modules is made of them).
 */
export function readRegular(roots: string[], file: string, opts: { maxBytes?: number } = {}): Buffer {
  const st = statSync(file);
  if (!st.isFile()) throw new RootWriteError(`${file} is ${kindOf(st)}; gnomon reads only regular files`);
  const fd = openSync(file, constants.O_RDONLY | NONBLOCK);
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) throw new RootWriteError(`${file} is ${kindOf(fst)}; gnomon reads only regular files`);
    if (roots.length > 0) {
      const real = fdPath(fd) ?? realOr(file);
      if (!rootOf(roots, real)) throw new RootWriteError(`${file} resolved outside the project root (${real}); not reading it`);
    }
    if (opts.maxBytes !== undefined && fst.size > opts.maxBytes) {
      throw new RootWriteError(`${file} is ${fst.size} bytes, over the ${opts.maxBytes} gnomon reads here`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a file the model named, whole, as host gnomon: never through a
 * symlink, a hard link or into anything but a regular file.
 *
 * The real path is resolved (an in-root symlink to another in-root file is
 * honoured), must lie under one of `roots`, and the write goes through
 * writeFileIn there: directories lstat-walked from the real root, a fresh
 * temp file renamed into place -- so a symlink swapped in after the check is
 * replaced, not written through. An existing target must be a regular file
 * with one link and no setuid/setgid bit; its permission bits are kept.
 *
 * `roots` empty means unconfined (sandbox = "off"): a plain write.
 */
export function writeRegular(roots: string[], file: string, data: string | Uint8Array): void {
  if (roots.length === 0) {
    mkdirSync(dirname(resolve(file)), { recursive: true });
    writeFileSync(file, data);
    return;
  }
  const real = realNearest(file);
  const root = rootOf(roots, real);
  if (!root) throw new RootWriteError(`${file} resolves outside the project root (${real}); not writing it`);
  let mode = 0o644;
  const st = lstatOrNull(real);
  if (st) {
    if (!st.isFile()) throw new RootWriteError(`${file} is ${kindOf(st)}; gnomon writes only regular files`);
    if (st.nlink > 1) throw new RootWriteError(`${file} has ${st.nlink} hard links; not writing to it`);
    if (st.mode & 0o6000) throw new RootWriteError(`${file} is setuid/setgid; not writing to it`);
    mode = st.mode & 0o777;
  }
  writeFileIn(root, real, data, mode);
}

/**
 * What a path was, for noticing that something else replaced it: device,
 * inode, type and ctime in nanoseconds. dev/ino alone is not enough -- an
 * unlinked file's inode is handed straight to the next file (or symlink)
 * created, so a swap reads as "the same" (seen in CI).
 */
export interface FileIdentity {
  dev: number;
  ino: number;
  mode?: number;
  ctimeNs?: string;
}

/** lstat identity, or null when nothing is there. */
export function identityOf(p: string): FileIdentity | null {
  try {
    const st = lstatSync(p, { bigint: true });
    return { dev: Number(st.dev), ino: Number(st.ino), mode: Number(st.mode), ctimeNs: st.ctimeNs.toString() };
  } catch {
    return null;
  }
}

/** Whether two identities name the same, unchanged file (both null: both absent). */
export function sameIdentity(a: FileIdentity | null, b: FileIdentity | null): boolean {
  if (a === null || b === null) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.ctimeNs === b.ctimeNs;
}

/**
 * Read `file` under `root` without following anything: every directory from
 * the real root down lstat'd as a plain directory, the file itself opened
 * O_NOFOLLOW | O_NONBLOCK and required to be a regular file with one link.
 * Returns null when it does not exist; throws RootWriteError when it is
 * anything else. For restoring files the model's code may have replaced
 * (must_fail_first).
 */
export function readExactIn(root: string, file: string): { data: Buffer; mode: number; id: FileIdentity } | null {
  const b = below(root, file);
  if (!b) throw new RootWriteError(`${file} is not under the project root; not reading it`);
  let cur = b.realRoot;
  for (const part of b.parts.slice(0, -1)) {
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (!st) return null;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new RootWriteError(`${cur} is not a plain directory; not reading through it`);
  }
  const target = join(b.realRoot, ...b.parts);
  const pre = lstatOrNull(target);
  if (!pre) return null;
  if (!pre.isFile()) throw new RootWriteError(`${target} is ${kindOf(pre)}; not a regular file`);
  if (pre.nlink > 1) throw new RootWriteError(`${target} has ${pre.nlink} hard links`);
  const fd = openSync(target, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new RootWriteError(`${target} is ${kindOf(st)}; not a regular file`);
    if (st.nlink > 1) throw new RootWriteError(`${target} has ${st.nlink} hard links`);
    if (st.dev !== pre.dev || st.ino !== pre.ino) throw new RootWriteError(`${target} changed while it was being read`);
    const real = fdPath(fd);
    if (real !== null && !within(b.realRoot, real)) throw new RootWriteError(`${target} resolved outside the project root (${real})`);
    return { data: readFileSync(fd), mode: st.mode & 0o777, id: { dev: st.dev, ino: st.ino } };
  } finally {
    closeSync(fd);
  }
}

/**
 * Remove `file` under `root`: its directories lstat-walked (never through a
 * symlink), then unlink, which removes a symlink itself and never its target.
 */
export function removeIn(root: string, file: string): void {
  const b = below(root, file);
  if (!b) throw new RootWriteError(`${file} is not under the project root; not removing it`);
  let cur = b.realRoot;
  for (const part of b.parts.slice(0, -1)) {
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new RootWriteError(`${cur} is not a plain directory; not removing through it`);
  }
  const target = join(b.realRoot, ...b.parts);
  const st = lstatOrNull(target);
  if (!st) return;
  if (st.isDirectory()) throw new RootWriteError(`${target} is a directory; not removing it`);
  unlinkSync(target);
}

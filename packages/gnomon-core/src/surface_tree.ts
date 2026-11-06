/**
 * A committed surface, copied out of git onto the host -- safely.
 *
 * WHY (seventh review, finding B1). `gnomon check --base <rev>` and `gnomon
 * guard` read the rules as committed at a revision, and wrote each path
 * `git ls-tree` listed to `join(tempDir, path)`. A revision is the model's
 * to make: under exec = "docker" it writes `.git/objects` and `.git/refs`,
 * and `git mktree` takes a tree whose entry is named `..`. So a base whose
 * `.gnomon/../../../home/me/.bashrc` was a blob made the host overwrite
 * `~/.bashrc`, from the dashboard's check button as from the CLI.
 *
 * Now every entry is checked before anything is written: a regular blob
 * (mode 100644 or 100755, never a symlink or a submodule), under the prefix
 * asked for, no empty, `.`, `..` or `.git` component, no backslash or colon
 * (a separator or a stream on Windows), and resolving inside the directory.
 * One bad entry refuses the whole tree: a surface that holds one is not one
 * gnomon will judge by. Blobs are read by the id the validated entry names
 * (`cat-file --batch`), and written with writeFileIn, which never follows
 * what is already there.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { writeFileIn } from "./root_fs.js";

export class SurfaceTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceTreeError";
  }
}

export interface SurfaceEntry {
  /** As git names it, `/`-separated. */
  path: string;
  sha: string;
  mode: "100644" | "100755";
}

/** Why `path` cannot be written under a directory, or null when it can. */
export function unsafeTreePath(path: string): string | null {
  if (!path) return "an empty name";
  if (path.startsWith("/") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return "an absolute path";
  if (/[\\:]/.test(path)) return "a backslash or colon";
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") return `a "${part}" component`;
    // `.git` as any spelling a case-insensitive filesystem, or Windows (which
    // drops trailing dots and spaces, and knows `git~1`), reads as `.git`.
    const folded = part.toLowerCase().replace(/[. ]+$/, "");
    if (folded === ".git" || folded === "git~1") return "a .git component";
  }
  return null;
}

/**
 * Parse `git ls-tree -r -z <rev> -- <prefix>` (full format) into entries,
 * refusing the tree when any entry is not a plain file safely under `prefix`.
 * `prefix` empty: the entries are relative to the tree itself.
 */
export function parseSurfaceTree(out: Buffer, prefix: string): SurfaceEntry[] {
  const entries: SurfaceEntry[] = [];
  for (const line of out.toString("utf-8").split("\0")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const [mode, type, sha] = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    const shown = JSON.stringify(path.length > 120 ? `${path.slice(0, 120)}…` : path);
    if (tab < 0 || !mode || !type || !sha || !/^[0-9a-f]{40,64}$/.test(sha)) {
      throw new SurfaceTreeError(`the committed surface could not be listed (${shown})`);
    }
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new SurfaceTreeError(
        `the committed surface holds ${shown} as ${type === "blob" && mode === "120000" ? "a symlink" : `a ${type} (mode ${mode})`}; ` +
          `only plain files are read from a revision`
      );
    }
    const bad = unsafeTreePath(path);
    if (bad) throw new SurfaceTreeError(`the committed surface holds ${shown}, which has ${bad}; not writing it anywhere`);
    if (prefix && !path.startsWith(`${prefix}/`)) {
      throw new SurfaceTreeError(`the committed surface holds ${shown}, outside ${prefix}/`);
    }
    entries.push({ path, sha, mode });
  }
  return entries;
}

/**
 * The bodies of `entries`, from one `git cat-file --batch` run through `run`
 * (which spawns git with the given stdin), keyed by the validated entry --
 * never by a path spelled through the tree.
 */
export function readSurfaceBlobs(run: (args: string[], input: string) => Buffer, entries: readonly SurfaceEntry[]): Buffer[] {
  if (entries.length === 0) return [];
  const batch = run(["cat-file", "--batch"], entries.map((e) => e.sha).join("\n") + "\n");
  const bodies: Buffer[] = [];
  let at = 0;
  for (const e of entries) {
    const nl = batch.indexOf(0x0a, at);
    if (nl < 0) throw new SurfaceTreeError(`git cat-file ended early, at ${e.path}`);
    const header = batch.subarray(at, nl).toString("utf-8").split(" ");
    if (header[0] !== e.sha || header[1] !== "blob") throw new SurfaceTreeError(`git cat-file did not return the blob for ${e.path}`);
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0 || nl + 1 + size > batch.length) {
      throw new SurfaceTreeError(`git cat-file returned a short blob for ${e.path}`);
    }
    bodies.push(batch.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1; // the content, then a newline
  }
  return bodies;
}

/** Write `entries` under `dir` (which gnomon made), each checked to land inside it. */
export function writeSurfaceTree(dir: string, entries: readonly SurfaceEntry[], bodies: readonly Buffer[], strip = ""): void {
  const root = resolve(dir);
  entries.forEach((e, i) => {
    const rel = strip && e.path.startsWith(`${strip}/`) ? e.path.slice(strip.length + 1) : e.path;
    const bad = unsafeTreePath(rel);
    if (bad) throw new SurfaceTreeError(`${JSON.stringify(rel)} has ${bad}; not writing it`);
    const dest = resolve(root, ...rel.split("/"));
    const r = relative(root, dest);
    if (!r || r.startsWith("..") || isAbsolute(r)) throw new SurfaceTreeError(`${JSON.stringify(rel)} resolves outside ${root}`);
    writeFileIn(root, dest, bodies[i]!, e.mode === "100755" ? 0o755 : 0o644);
  });
}

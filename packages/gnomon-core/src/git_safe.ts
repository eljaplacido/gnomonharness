/**
 * Every git gnomon runs on its own account -- the per-turn tree measurement,
 * the surface stamp around a bash call, `git clean`'s reach, `gnomon check`,
 * `gnomon guard`, the dashboard, the harness build -- goes through here.
 *
 * WHY. A repository's own configuration names programs git runs:
 * `core.fsmonitor` (on every status/diff), hooks (`post-index-change` fires on
 * a plain `git status` that refreshes the index), `filter.<x>.clean` /
 * `.process` (on a status or diff that re-reads a worktree file whose
 * `.gitattributes` says `filter=x`), `diff.<x>.textconv`, `diff.external`.
 * `.git/config` and `.gitattributes` are inside the project root, and the
 * project root is exactly what a sandboxed bash -- exec = "docker" (bind
 * mount) or exec = "os" (Landlock) -- may write. A command that wrote
 * `core.fsmonitor = <cmd>` then had gnomon run `<cmd>` on the HOST, outside
 * the container or the Landlock domain, at the end of the turn. (PR #156
 * second review, finding A; reproduced on v0.4.3's exec = "docker".)
 *
 * WHAT. Four layers, each closing what the one before cannot. Any of them
 * that cannot be established -- the repository is ambiguous or not the one
 * the session pinned, the configuration cannot be listed, a sandbox
 * container may still be running -- refuses the call ("could not answer"):
 * git does not run, and the caller does whatever it does without git.
 *
 *   0. The repository is named, never discovered: GIT_DIR, GIT_WORK_TREE and
 *      GIT_COMMON_DIR from gnomon's own walk (findRepository), pinned for a
 *      session's root at its start (pinRepository), with a ceiling and
 *      `safe.bareRepository=explicit`. And no git runs while a sandbox
 *      container that can write the repository may still be running
 *      (containerStarted / liveContainer). Fourth review, findings 2 and 4.
 *   1. Always: `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, no
 *      external diff, no textconv, no pager, no auto-gc, no submodule
 *      recursion (a submodule's own config is not enumerated below), and no
 *      system config. Command-line config outranks every file, includes and
 *      worktree config included.
 *   2. Filter and diff DRIVERS cannot be switched off by one global key: the
 *      driver's name is the repository's choice. So the configuration is
 *      listed first (`git config --list` reads; it runs nothing) and every
 *      driver it names is blanked through GIT_CONFIG_COUNT, which takes any
 *      key a `-c k=v` could not spell (a name containing `=`). Done for every
 *      call but a `rev-parse` on a hot path, and cached per config state: a
 *      command contained in an EARLIER session may have planted a driver
 *      this process never saw being written.
 *   3. Under exec = "os", git itself runs inside the sandbox: `gnomon-exec
 *      sandbox --network off`, writable only in an empty directory of its
 *      own. Whatever the repository still makes git run -- a driver defined
 *      between the listing and the run by a job an earlier call backgrounded,
 *      a key this list did not foresee -- runs where the command could have
 *      run it anyway.
 *
 * The bookkeeping reads; none of it needs a hook, a filter or a writable
 * tree. A repository whose tracked content depends on a clean filter (LFS)
 * may show more files as modified in `[tree]` than git with the filter would:
 * a measurement that errs towards "changed", never a program run.
 */
import { spawnSync, type SpawnSyncReturns, type StdioOptions } from "node:child_process";
import { isAbsolute, resolve, dirname, join, sep } from "node:path";
import { readFileSync, statSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";

/** `-c` overrides every gnomon-run git gets. */
export const GIT_HARDENING: readonly string[] = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "diff.external=",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "submodule.recurse=false",
  "-c", "diff.ignoreSubmodules=all",
  "-c", "status.submoduleSummary=false",
  "-c", "core.askPass=",
  "-c", "credential.helper=",
  "-c", "protocol.ext.allow=never",
  "-c", "log.showSignature=false",
  // Programs a repository's config could name for subcommands gnomon does
  // not run today; blanked anyway, so a later call site cannot reach one.
  "-c", "core.sshCommand=",
  "-c", "core.gitProxy=",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "gpg.program=",
  "-c", "core.editor=:",
  "-c", "sequence.editor=:",
  "-c", "core.alternateRefsCommand=",
];

/** Environment for a gnomon-run git: no system config, no prompt, no pager. */
export function gitHardenedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of [
    "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
    // Redirections of PART of a repository -- its index, its common dir (and
    // with it the config), its object store -- arrive in the environment of a
    // git hook gnomon was started from. Bookkeeping measures the repository
    // gnomon's own walk finds, whole, and names it (plan). GIT_DIR and
    // GIT_WORK_TREE stay: they name a whole repository, the stamp honours
    // them deliberately (tools.ts gitRootOf), and only gnomon's own parent
    // can set them -- a contained command cannot. GIT_CONFIG_GLOBAL stays for
    // the same reason: it is the operator's own global config, and it is in
    // the listing's cache key.
    "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_SYSTEM", "GIT_CONFIG",
  ]) {
    delete env[k];
  }
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  // No system config -- except on Windows, where Git for Windows keeps its
  // own defaults there (autocrlf, fscache, symlinks) and neither contained
  // mode exists (exec = "docker" and "os" both refuse on native Windows), so
  // no sandboxed command could have written anything for it to guard.
  if (process.platform !== "win32") env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  return env;
}

/**
 * `args` with the per-subcommand flags inserted after the subcommand:
 * `--no-ext-diff --no-textconv` where they apply, `--ignore-submodules=all`
 * (which, unlike the config key, a `.gitmodules` entry cannot override).
 */
export function hardenGitArgs(args: readonly string[]): string[] {
  const out = [...args];
  let i = 0;
  while (i < out.length) {
    const a = out[i]!;
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree") {
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  const sub = out[i];
  if (sub === undefined) return [...GIT_HARDENING, ...out];
  const extra: string[] = [];
  if (sub === "diff" || sub === "show" || sub === "log" || sub.startsWith("diff-")) {
    extra.push("--no-ext-diff", "--no-textconv");
  }
  if (sub === "diff" || sub === "status" || sub === "diff-index" || sub === "diff-files") {
    extra.push("--ignore-submodules=all");
  }
  // Never between `--` and pathspecs, and never into a sub-subcommand's slot
  // (`stash create`): the flags go right after the subcommand only where the
  // subcommand itself takes them.
  out.splice(i + 1, 0, ...extra);
  return [...GIT_HARDENING, ...out];
}

/** The directory git will run in, after any leading `-C`. */
function gitDirOf(cwd: string, args: readonly string[]): string {
  let dir = cwd;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C" && args[i + 1] !== undefined) {
      dir = isAbsolute(args[i + 1]!) ? args[i + 1]! : resolve(dir, args[i + 1]!);
      i++;
      continue;
    }
    if (!a.startsWith("-")) break;
  }
  return dir;
}

/** The global options before the subcommand that say where git runs: `-C`, `--git-dir`, `--work-tree`. */
function locatingOptions(args: readonly string[]): { located: string[]; namesRepo: boolean } {
  const located: string[] = [];
  let namesRepo = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c") {
      i++;
      continue;
    }
    if (a === "-C" || a === "--git-dir" || a === "--work-tree") {
      if (a !== "-C") namesRepo = true;
      located.push(a, args[i + 1] ?? "");
      i++;
      continue;
    }
    if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) {
      namesRepo = true;
      located.push(a);
      continue;
    }
    if (!a.startsWith("-")) break;
  }
  return { located, namesRepo };
}

// ---------------------------------------------------------------------------
// The repository: found without git, pinned at session start, named on every call
// ---------------------------------------------------------------------------

/**
 * WHY (fourth review, finding 2). git's own discovery decides which directory
 * is the repository, and everything it weighs is inside the project root: a
 * `.git` whose HEAD is not valid is skipped, and the directory holding it is
 * then taken as a git dir of its own when it has a HEAD, objects and refs --
 * with whatever config sits beside them. A container corrupted .git/HEAD in
 * place (nothing in the listing's cache key moved) and made the root a git
 * dir whose config named a filter; the cached listing was of .git/config, and
 * the filter ran on the host from the hot-path status.
 *
 * So git discovers nothing. gnomon finds the repository itself, once per
 * session for the session's root (pinRepository), by rules a write inside
 * the root cannot bend, and hands git GIT_DIR, GIT_WORK_TREE and
 * GIT_COMMON_DIR on every call, with a ceiling and `safe.bareRepository =
 * explicit` besides. A repository that is not the one pinned -- a `.git`
 * replaced, a `commondir` moved -- is not asked: the call answers "could
 * not answer", and the caller falls back to whatever it does without git.
 */
export interface GitRepository {
  /** The directory holding `.git`. A real path. */
  workTree: string;
  /** What `.git` is, or names. A real path. */
  gitDir: string;
  /** The config, objects and refs: gitDir, or what its `commondir` names. A real path. */
  commonDir: string;
  /** device:inode:birth time of gitDir and commonDir. */
  id: string;
}

interface Refusal {
  refuse: string;
  notRepo?: boolean;
}

// Birth time as well: a `.git` removed and copied back can get the inode it
// had (measured on ext4), never the birth time.
const statId = (p: string): string => {
  const s = statSync(p, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
};

/** A directory git's discovery would take as a git dir: HEAD, objects/ and refs/. */
function looksLikeGitDir(d: string): boolean {
  try {
    return lstatSync(join(d, "HEAD")).isFile() && statSync(join(d, "objects")).isDirectory() && statSync(join(d, "refs")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The repository holding `dir`, found the way git finds a non-bare one --
 * the nearest `.git` at or above it -- without running git. Null: none.
 * A refusal where git might take something else: a directory that holds
 * `.git` AND is itself a git dir, a bare-looking directory with no `.git`
 * (git would use it; gnomon does not guess), a `.git` that is neither a
 * directory nor a `gitdir:` file, or a pointer that leads nowhere.
 */
export function findRepository(dir: string): GitRepository | null | Refusal {
  let d: string;
  try {
    d = realpathSync(dir);
  } catch {
    return { refuse: `${dir} does not resolve` };
  }
  for (;;) {
    const dot = join(d, ".git");
    let st: Stats | null;
    try {
      st = lstatSync(dot);
    } catch {
      st = null;
    }
    if (st) {
      if (looksLikeGitDir(d)) return { refuse: `${d} holds .git and is a git directory itself, so which repository git would read is ambiguous` };
      let gitDir: string;
      try {
        if (st.isDirectory()) {
          gitDir = dot;
        } else if (st.isSymbolicLink() || st.isFile()) {
          if (st.isSymbolicLink()) {
            gitDir = realpathSync(dot);
          } else {
            const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dot, "utf8"));
            if (!m) return { refuse: `${dot} is a file that names no git dir` };
            gitDir = realpathSync(resolve(d, m[1]!));
          }
          if (!statSync(gitDir).isDirectory()) return { refuse: `${dot} points at no directory` };
        } else {
          return { refuse: `${dot} is neither a directory nor a gitdir file` };
        }
      } catch {
        return { refuse: `${dot} points at nothing git could use` };
      }
      let commonDir = gitDir;
      let cd: string | null = null;
      try {
        cd = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { refuse: `${join(gitDir, "commondir")} cannot be read` };
      }
      if (cd !== null) {
        if (!cd) return { refuse: `${join(gitDir, "commondir")} is empty` };
        try {
          commonDir = realpathSync(resolve(gitDir, cd));
        } catch {
          return { refuse: `${join(gitDir, "commondir")} points at nothing` };
        }
      }
      try {
        return { workTree: d, gitDir, commonDir, id: `${statId(gitDir)}/${statId(commonDir)}` };
      } catch {
        return { refuse: `${gitDir} cannot be read` };
      }
    }
    if (looksLikeGitDir(d)) return { refuse: `${d} is a git directory with no .git above it, which gnomon does not take as a repository` };
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const isRefusal = (r: GitRepository | Refusal | null): r is Refusal => r !== null && "refuse" in r;

interface Pin {
  root: string;
  repo: GitRepository | null;
  refused?: string;
  /** A repository that changed since the pin is refused (a contained session), or found again (one that is not). */
  strict: boolean;
}

const pins: Pin[] = [];

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Pin the repository of a session's root: call at session start, before any
 * command runs. Every later gnomon git under `root` uses this repository and
 * no other. `strict` (the default, and what a session whose bash runs
 * contained passes): a repository that is no longer the pinned one, or one
 * that appeared where there was none, is refused for the rest of the
 * session. Not strict (exec = "off", where the command could run git on the
 * host anyway): it is found again.
 */
export function pinRepository(root: string, opts: { strict?: boolean } = {}): GitRepository | null {
  const real = realOr(root);
  const found = findRepository(real);
  const pin: Pin = {
    root: real,
    repo: isRefusal(found) ? null : found,
    ...(isRefusal(found) ? { refused: found.refuse } : {}),
    strict: opts.strict ?? true,
  };
  const i = pins.findIndex((p) => p.root === real);
  if (i >= 0) pins[i] = pin;
  else pins.push(pin);
  return pin.repo;
}

/** The pin whose root holds `dir`, the innermost when pins nest. */
function pinFor(dir: string): Pin | undefined {
  const real = realOr(dir);
  let best: Pin | undefined;
  for (const p of pins) {
    if ((real === p.root || real.startsWith(p.root.endsWith(sep) ? p.root : p.root + sep)) && (!best || p.root.length > best.root.length)) best = p;
  }
  return best;
}

function repositoryFor(dir: string): GitRepository | null | Refusal {
  const pin = pinFor(dir);
  if (!pin) return findRepository(dir);
  if (!pin.strict) {
    const now = findRepository(pin.root);
    pin.repo = isRefusal(now) ? null : now;
    return now;
  }
  if (pin.refused) return { refuse: pin.refused };
  if (pin.repo === null) return null;
  const now = findRepository(pin.root);
  if (isRefusal(now)) return now;
  if (now === null || now.gitDir !== pin.repo.gitDir || now.commonDir !== pin.repo.commonDir || now.id !== pin.repo.id) {
    return { refuse: `the repository at ${pin.repo.workTree} is not the one this session started with (${pin.repo.gitDir})` };
  }
  return pin.repo;
}

// ---------------------------------------------------------------------------
// Containers that may still be writing
// ---------------------------------------------------------------------------

/**
 * Sandbox containers (exec = "docker") not known to be gone, each with how to
 * ask whether it is. While any is, gnomon runs no git on the host: the
 * container can write the repository between the driver listing and the git
 * that trusts it (fourth review, finding 4). tools.ts registers a container
 * when it starts and removes it once `docker run` has returned or the
 * container is confirmed removed.
 */
const live = new Map<string, () => boolean>();

/** Is the container gone? `docker inspect` says "No such object" for one that is. */
export function dockerContainerGone(name: string): boolean {
  const r = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", name], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  return !r.error && r.status !== 0 && /no such (object|container)/i.test(String(r.stderr ?? ""));
}

export function containerStarted(name: string, gone: () => boolean = () => dockerContainerGone(name)): void {
  live.set(name, gone);
}

export function containerGone(name: string): void {
  live.delete(name);
}

/** A container that may still be running, after asking each whether it has gone. */
export function liveContainer(): string | null {
  for (const [name, gone] of [...live]) {
    let g = false;
    try {
      g = gone();
    } catch {
      g = false;
    }
    if (g) live.delete(name);
    else return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The driver listing
// ---------------------------------------------------------------------------

/**
 * What the driver listing depends on, by stat: every file git reads this
 * repository's configuration from, with the repository named explicitly
 * (GIT_DIR, GIT_COMMON_DIR), and the global ones. ctime too: size, mtime and
 * inode can all be kept by an in-place same-length rewrite followed by
 * utimes, but no unprivileged process can set ctime, and any write moves it.
 */
function configSignature(repo: GitRepository, env: NodeJS.ProcessEnv): string {
  const st = (p: string) => {
    try {
      const s = statSync(p, { bigint: true });
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch {
      return "-";
    }
  };
  const home = env.HOME || homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    repo.workTree,
    repo.gitDir,
    repo.commonDir,
    repo.id,
    st(join(repo.commonDir, "config")),
    st(join(repo.gitDir, "config")),
    st(join(repo.gitDir, "config.worktree")),
    st(join(repo.commonDir, "config.worktree")),
    st(join(home, ".gitconfig")),
    st(join(xdg, "git", "config")),
    env.GIT_CONFIG_GLOBAL ?? "",
  ].join("|");
}

/**
 * Driver listings by configSignature, so one `gnomon check` (dozens of git
 * calls; ~50 ms per spawn on Windows) lists once per config state. A config
 * file that changes -- size, mtime, ctime or inode -- lists again. A listing
 * that names any `include.*` or `includeIf.*` key is NEVER cached: the files
 * it pulls in (which may not exist yet, or apply only on some branch) are
 * not in the signature. Nor is one for a repository the caller named itself.
 */
const driverCache = new Map<string, string[]>();

/**
 * `env` with every filter and diff driver the configuration names blanked,
 * or null when the configuration could not be listed -- and then no git may
 * run: an unlisted driver is an unblanked one (fourth review, finding 3).
 */
export function neutralizeDriversEnv(
  dir: string,
  env: NodeJS.ProcessEnv,
  repo?: GitRepository | null,
  located: readonly string[] = []
): NodeJS.ProcessEnv | null {
  const sig = repo ? configSignature(repo, env) : null;
  const cached = sig === null ? undefined : driverCache.get(sig);
  if (cached !== undefined) return driverEnv(cached, env);
  const listed = listDriverKeys(dir, env, located);
  if (listed === null) return null;
  if (sig !== null && !listed.includes) {
    if (driverCache.size > 64) driverCache.clear();
    driverCache.set(sig, listed.keys);
  }
  return driverEnv(listed.keys, env);
}

function listDriverKeys(dir: string, env: NodeJS.ProcessEnv, located: readonly string[]): { keys: string[]; includes: boolean } | null {
  const r = spawnSync("git", [...BARE_EXPLICIT, ...GIT_HARDENING, ...located, "config", "-z", "--list"], {
    cwd: dir,
    encoding: "utf8",
    env,
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  // Failed, timed out, or past its buffer: nobody knows what it would have named.
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (k: string) => {
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  };
  let includes = false;
  for (const entry of r.stdout.split("\0")) {
    const key = entry.split("\n", 1)[0] ?? "";
    if (/^include(if)?\./i.test(key)) includes = true;
    let m = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(key);
    if (m) {
      const n = m[1]!;
      add(`filter.${n}.clean`);
      add(`filter.${n}.smudge`);
      add(`filter.${n}.process`);
      continue;
    }
    m = /^diff\.(.+)\.(textconv|command)$/i.exec(key);
    if (m) {
      add(`diff.${m[1]}.textconv`);
      add(`diff.${m[1]}.command`);
      continue;
    }
    m = /^merge\.(.+)\.driver$/i.exec(key);
    if (m) add(`merge.${m[1]}.driver`);
  }
  return { keys, includes };
}

function driverEnv(keys: readonly string[], env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const seen = new Set(keys);
  const out: NodeJS.ProcessEnv = { ...env };
  keys.forEach((k, i) => {
    out[`GIT_CONFIG_KEY_${i}`] = k;
    // Empty, not "cat": an empty driver command is no driver; and a filter
    // whose `required` is set fails closed rather than running something.
    out[`GIT_CONFIG_VALUE_${i}`] = "";
  });
  let n = keys.length;
  for (const k of [...seen].filter((k) => k.endsWith(".clean")).map((k) => k.replace(/\.clean$/, ".required"))) {
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = "false";
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/** Subcommands that create a repository: the one they run beside is not named to them. */
const REPOSITORY_MAKERS = new Set(["clone", "init"]);

/** No repository is ever taken implicitly as a bare one; with GIT_DIR named, none is looked for. */
const BARE_EXPLICIT = ["-c", "safe.bareRepository=explicit"];

/**
 * Subcommands that read no worktree file and no blob content, so no filter,
 * textconv or diff driver can fire: a `hot` call of one of these skips the
 * listing (build.ts's rev-parse calls, on the first record's path).
 */
const DRIVERLESS = new Set(["rev-parse"]);

/** The subcommand of `args`, after any leading options. */
function subcommandOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree") {
      i++;
      continue;
    }
    if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/**
 * How git is run inside the OS sandbox, once exec = "os" has run a command in
 * this process (tools.ts registers it from osSandboxPlan). Null: on the host.
 */
export type GitSandbox = (argv: string[], env: NodeJS.ProcessEnv) => { file: string; args: string[]; env: NodeJS.ProcessEnv };

let sandbox: GitSandbox | null = null;

/** Run every later gnomon git inside the OS sandbox. Only ever tightens. */
export function setGitSandbox(wrap: GitSandbox): void {
  sandbox = wrap;
}

/** Tests only. */
export function _resetGitSafety(): void {
  driverCache.clear();
  sandbox = null;
  pins.length = 0;
  live.clear();
}

export function gitSandboxed(): boolean {
  return sandbox !== null;
}

export interface SafeGitOptions {
  cwd: string;
  timeout?: number;
  maxBuffer?: number;
  input?: string | Buffer;
  stdio?: StdioOptions;
  env?: NodeJS.ProcessEnv;
  /**
   * A call on a hot path (per turn, per bash call). It skips the driver
   * listing only for a subcommand that cannot run a driver (DRIVERLESS);
   * everything else lists, and the listing is cached per config state, so
   * the cost on a hot path is one `git config --list` per change.
   *
   * It used to skip the listing for every hot call until a contained command
   * had run IN THIS PROCESS -- and a filter a container planted in the last
   * session then ran on the host from this session's first tree measurement,
   * before any contained command had (third review, finding 3).
   */
  hot?: boolean;
}

interface Plan {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function plan(args: readonly string[], opts: SafeGitOptions): Plan | Refusal {
  const running = liveContainer();
  if (running !== null) return { refuse: `sandbox container ${running} may still be running, and it can write this repository` };
  let env = gitHardenedEnv(opts.env ?? process.env);
  const dir = gitDirOf(opts.cwd, args);
  const { located, namesRepo } = locatingOptions(args);
  let repo: GitRepository | null = null;
  // The operator's own GIT_DIR (gnomon started from a git hook), or a caller
  // that names the repository itself: git discovers nothing either way.
  if (env.GIT_DIR === undefined && env.GIT_WORK_TREE === undefined && !namesRepo) {
    const found = repositoryFor(dir);
    if (found === null) return { refuse: `not a git repository: ${dir}`, notRepo: true };
    if (isRefusal(found)) return found;
    repo = found;
    env.GIT_DIR = repo.gitDir;
    env.GIT_WORK_TREE = repo.workTree;
    env.GIT_COMMON_DIR = repo.commonDir;
    env.GIT_CEILING_DIRECTORIES = dirname(repo.workTree);
  }
  const argv = [...BARE_EXPLICIT, ...hardenGitArgs(args)];
  const sub = subcommandOf(args);
  if (!(opts.hot && sub !== undefined && DRIVERLESS.has(sub))) {
    const blanked = neutralizeDriversEnv(dir, env, repo, located);
    if (blanked === null) return { refuse: "the repository's configuration could not be listed, so the programs it names could not be switched off" };
    env = blanked;
  }
  // `clone` and `init` make a repository rather than read one, and take
  // GIT_DIR / GIT_WORK_TREE as where to make it. Neither discovers one.
  if (repo && sub !== undefined && REPOSITORY_MAKERS.has(sub)) {
    env = { ...env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_COMMON_DIR;
  }
  return sandbox !== null ? sandbox(["git", ...argv], env) : { file: "git", args: argv, env };
}

/** What a gnomon git would run, or null when it would be refused. Tests and diagnostics. */
export function planGit(args: readonly string[], opts: SafeGitOptions): Plan | null {
  const p = plan(args, opts);
  return "refuse" in p ? null : p;
}

function refusalText(r: Refusal): string {
  return r.notRepo ? `fatal: ${r.refuse} (gnomon found no .git above it)\n` : `gnomon: could not answer: ${r.refuse}\n`;
}

/** spawnSync("git", args, utf-8) with the hardening above: the same return shape. */
export function safeGit(args: readonly string[], opts: SafeGitOptions): SpawnSyncReturns<string> {
  const p = plan(args, opts);
  if ("refuse" in p) {
    const stderr = refusalText(p);
    return { pid: 0, output: [null, "", stderr], stdout: "", stderr, status: 128, signal: null };
  }
  return spawnSync(p.file, p.args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    input: opts.input,
    stdio: opts.stdio,
    env: p.env,
    windowsHide: true,
  });
}

/** As safeGit, with Buffer output. */
export function safeGitBuffer(args: readonly string[], opts: SafeGitOptions): SpawnSyncReturns<Buffer> {
  const p = plan(args, opts);
  if ("refuse" in p) {
    const stderr = Buffer.from(refusalText(p));
    return { pid: 0, output: [null, Buffer.alloc(0), stderr], stdout: Buffer.alloc(0), stderr, status: 128, signal: null };
  }
  return spawnSync(p.file, p.args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    input: opts.input,
    stdio: opts.stdio,
    env: p.env,
    windowsHide: true,
  });
}

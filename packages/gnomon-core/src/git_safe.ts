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
 * WHAT. Three layers, each closing what the one before cannot:
 *
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
 *      sandbox --network none` (no loopback either), writable only in an
 *      empty directory of its own, under the session's read scope once a
 *      command ran with reads = "scoped" (tools.ts registerGitSandbox).
 *      Whatever the repository still makes git run -- a driver defined
 *      between the listing and the run by a job an earlier call backgrounded,
 *      a key this list did not foresee -- runs with no more than the command
 *      had.
 *
 * The bookkeeping reads; none of it needs a hook, a filter or a writable
 * tree. A repository whose tracked content depends on a clean filter (LFS)
 * may show more files as modified in `[tree]` than git with the filter would:
 * a measurement that errs towards "changed", never a program run.
 */
import { spawnSync, type SpawnSyncReturns, type StdioOptions } from "node:child_process";
import { isAbsolute, resolve, dirname, join } from "node:path";
import { readFileSync, statSync } from "node:fs";
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
    // the walk from cwd finds, whole. GIT_DIR and GIT_WORK_TREE stay: they
    // name a whole repository, the stamp honours them deliberately
    // (tools.ts gitRootOf), and only gnomon's own parent can set them -- a
    // contained command cannot. GIT_CONFIG_GLOBAL stays for the same reason:
    // it is the operator's own global config, and it is in the listing's
    // cache key.
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

/**
 * Every filter and diff driver the configuration in `dir` names, blanked, as
 * GIT_CONFIG_COUNT entries. `git config --list` reads the configuration
 * (includes too) and runs nothing.
 */
/**
 * What the driver listing depends on: every file git reads the repository's
 * configuration from, and the global ones, by stat. Null (do not cache) when
 * the layout is one this walk does not follow.
 *
 * The repository's config is `<common dir>/config`, and the common dir is
 * not always `.git`: a `commondir` file inside the git dir moves it (that is
 * how a linked worktree shares its main repository's config), and a `.git`
 * FILE (`gitdir: <path>`) moves the git dir itself. Both are inside the
 * project root, so a contained command can write them -- the first signature
 * here read only `.git/config`, and a `commondir` written after a listing was
 * cached pointed git at a config defining a filter while the cache still
 * answered "no drivers" (third review, finding 2). So the pointers are
 * followed, and each pointer file is itself part of the signature: changing
 * where git looks changes the key.
 */
function configSignature(dir: string, env: NodeJS.ProcessEnv): string | null {
  // ctime too: size, mtime and inode can all be kept by an in-place
  // same-length rewrite followed by utimes, but no unprivileged process can
  // set ctime, and any write moves it.
  const st = (p: string) => {
    try {
      const s = statSync(p, { bigint: true });
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch {
      return "-";
    }
  };
  const readPointer = (p: string): string | null => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  // GIT_DIR / GIT_WORK_TREE name a repository the walk from `dir` does not find.
  if (env.GIT_DIR !== undefined || env.GIT_WORK_TREE !== undefined) return null;
  let d = resolve(dir);
  let gitDir: string;
  for (;;) {
    let g;
    try {
      g = statSync(join(d, ".git"));
    } catch {
      g = null;
    }
    if (g) {
      if (g.isDirectory()) {
        gitDir = join(d, ".git");
      } else if (g.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readPointer(join(d, ".git")) ?? "");
        if (!m) return null;
        gitDir = resolve(d, m[1]!);
      } else {
        return null;
      }
      break;
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  let common = gitDir;
  const cd = readPointer(join(gitDir, "commondir"));
  if (cd !== null) {
    const target = cd.trim();
    if (!target) return null;
    common = resolve(gitDir, target);
  }
  const home = env.HOME || homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    d,
    st(join(d, ".git")),
    gitDir,
    st(join(gitDir, "commondir")),
    common,
    st(join(common, "config")),
    st(join(gitDir, "config")),
    st(join(gitDir, "config.worktree")),
    st(join(common, "config.worktree")),
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
 * not in the signature. Nor is a layout configSignature does not follow.
 */
const driverCache = new Map<string, string[]>();

export function neutralizeDriversEnv(dir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sig = configSignature(dir, env);
  const cached = sig === null ? undefined : driverCache.get(sig);
  if (cached !== undefined) return driverEnv(cached, env);
  const { keys, includes } = listDriverKeys(dir, env);
  if (sig !== null && !includes) {
    if (driverCache.size > 64) driverCache.clear();
    driverCache.set(sig, keys);
  }
  return driverEnv(keys, env);
}

function listDriverKeys(dir: string, env: NodeJS.ProcessEnv): { keys: string[]; includes: boolean } {
  const r = spawnSync("git", [...GIT_HARDENING, "config", "-z", "--list"], {
    cwd: dir,
    encoding: "utf8",
    env,
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (k: string) => {
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  };
  // A listing that failed is never cached either.
  let includes = !(r.status === 0 && typeof r.stdout === "string");
  if (r.status === 0 && typeof r.stdout === "string") {
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

/** Run every later gnomon git inside the OS sandbox (re-registered as the session's scope tightens). */
export function setGitSandbox(wrap: GitSandbox): void {
  sandbox = wrap;
}

/** Tests only. */
export function _resetGitSafety(): void {
  driverCache.clear();
  sandbox = null;
}

export function gitSandboxed(): boolean {
  return sandbox !== null;
}

/** Tests only: what a git run as `argv` would be spawned as, or null on the host. */
export function _gitSandboxWrap(argv: string[], env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  return sandbox === null ? null : sandbox(argv, env);
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

function plan(args: readonly string[], opts: SafeGitOptions): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  let env = gitHardenedEnv(opts.env ?? process.env);
  const argv = hardenGitArgs(args);
  const sub = subcommandOf(args);
  if (!(opts.hot && sub !== undefined && DRIVERLESS.has(sub))) {
    env = neutralizeDriversEnv(gitDirOf(opts.cwd, args), env);
  }
  return sandbox !== null ? sandbox(["git", ...argv], env) : { file: "git", args: argv, env };
}

/** spawnSync("git", args, utf-8) with the hardening above: the same return shape. */
export function safeGit(args: readonly string[], opts: SafeGitOptions): SpawnSyncReturns<string> {
  const p = plan(args, opts);
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

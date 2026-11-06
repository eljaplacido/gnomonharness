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
 *      key a `-c k=v` could not spell (a name containing `=`). Done whenever a
 *      contained command may have run in this process, and always for the
 *      one-shot CLI commands, which cannot know.
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
import { isAbsolute, resolve } from "node:path";

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
];

/** Environment for a gnomon-run git: no system config, no prompt, no pager. */
export function gitHardenedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of [
    "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
  ]) {
    delete env[k];
  }
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  env.GIT_CONFIG_NOSYSTEM = "1";
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
export function neutralizeDriversEnv(dir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
  if (r.status === 0 && typeof r.stdout === "string") {
    for (const entry of r.stdout.split("\0")) {
      const key = entry.split("\n", 1)[0] ?? "";
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
 * How git is run inside the OS sandbox, once exec = "os" has run a command in
 * this process (tools.ts registers it from osSandboxPlan). Null: on the host.
 */
export type GitSandbox = (argv: string[], env: NodeJS.ProcessEnv) => { file: string; args: string[]; env: NodeJS.ProcessEnv };

let sandbox: GitSandbox | null = null;
/** A contained command (docker or os) may have written the repository's config. */
let contained = false;

/** Run every later gnomon git inside the OS sandbox. Only ever tightens. */
export function setGitSandbox(wrap: GitSandbox): void {
  sandbox = wrap;
  contained = true;
}

/** A contained command may have run: list and blank drivers from now on. */
export function markGitContained(): void {
  contained = true;
}

/** Tests only. */
export function _resetGitSafety(): void {
  sandbox = null;
  contained = false;
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
   * The hot path (per turn, per bash call): list drivers only once a
   * contained command may have written them. Default false: always list.
   */
  hot?: boolean;
}

function plan(args: readonly string[], opts: SafeGitOptions): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  let env = gitHardenedEnv(opts.env ?? process.env);
  const argv = hardenGitArgs(args);
  if (sandbox === null && (contained || !opts.hot)) {
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

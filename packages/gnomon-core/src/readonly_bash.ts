/**
 * gnomon-core: is this bash call plainly read-only?
 *
 * `[approval] readonly_bash = "allow"` (opt-in; the default is "ask") lets
 * `gate = "on_write"` run a bash call without asking when this reader proves
 * the call only reads: `ls`, `cat x`, `rg foo src`, `git status`, `git log |
 * head`. Every other call asks exactly as before.
 *
 * Why it exists: `on_write` counts every bash call as mutating, because a
 * command can write anything. Measured on 1,954 real Claude Code tool calls
 * from 7 projects put to `gnomon guard` (2026-11-19), 70% were `ask`, almost
 * all of them rule `approval` on a bash call, `ls` and `git status` included;
 * a client evaluation stopped at "unusable friction" for the same reason.
 *
 * The reader is CONSERVATIVE by construction: it answers read-only only for a
 * line it can account for word by word, and anything it does not recognise is
 * not read-only (it asks). Concretely, read-only means:
 *
 *   - every command is a program on READONLY_PROGRAMS, named bare (`ls`, not
 *     `/bin/ls` or `./ls`), with no `VAR=value` prefix, run at the top level
 *     of the line: no subshell, group, function, loop, `$( )`, backticks or
 *     process substitution anywhere, and nothing sent to the background;
 *   - commands are joined only by `|`, `;`, `&&`, `||` or newlines, so a
 *     `git log; rm x` is judged on its `rm`;
 *   - no output redirection, except to `/dev/null` and fd duplication
 *     (`2>/dev/null`, `2>&1`), which write nothing; input (`<`, here-docs) is
 *     fine; nothing to or from `/dev/tcp/…` or `/dev/udp/…`, which bash
 *     opens as a socket, input included (network egress, DNS too); and a
 *     file redirection's target is a literal (no `$x`, no `~`), so it cannot
 *     expand into one;
 *   - no `${…@…}` parameter transformation: `@P` and `@E` evaluate the value,
 *     and under `promptvars` that runs command substitutions in it;
 *   - per program, the options that write or run another program are refused:
 *     `find -exec/-execdir/-ok/-okdir/-delete/-fprint*`/`-fls`, `rg --pre` and
 *     `--hostname-bin`, `file -C`, `sort -o`, a second `uniq` operand, `git
 *     -c`/`-p`/`--git-dir`/…, `git diff/log/show --output`, and every `git
 *     branch` form that is not a listing;
 *   - for the programs whose options or operands can run or write (find, rg,
 *     git, file, sort, uniq), no unquoted variable, glob or brace in an
 *     argument: a file named `-delete` or `--pre=sh` matched by `*` would
 *     become that option.
 *
 * git runs programs its repository's configuration names, on the very
 * commands listed: `core.fsmonitor` on `status` and `diff`, `diff.external`
 * and textconv drivers on `diff`, `log -p` and `show`, `gpg.program` on
 * `--show-signature`. The `git_hooks` rule protects only the PROJECT's
 * `.git/config`, so git is read-only only where it reads that one (see
 * gitRepoWhy): no `-C` but `.` or the project root, no git after a `cd` on
 * the same line, and the directory it starts in is the project root, or
 * inside it when the root is the repository's top level, with no nested
 * repository (a `.git`) or possible bare one (a `HEAD`) on the way up. A
 * caller that cannot say where the line starts (ReadOnlyWhere) gets git
 * refused.
 *
 * What it does not judge, said plainly: WHAT is read. `cat ~/.ssh/id_rsa` is
 * read-only and is not asked about under this setting; the rules that judge
 * what may be read (`[governance]` secret paths, the sandbox for the file
 * tools) run first and still refuse it where they apply. It also cannot see
 * configuration outside the repository (`~/.gitconfig`, `GIT_DIR` or
 * `RIPGREP_CONFIG_PATH` in the environment). The precheck is an intent
 * filter, not containment.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { parseShell, type ShellCommand, type ShellRedirect, type WordPart } from "./shell.js";

/** The programs a read-only call may consist of. Anything else asks. */
export const READONLY_PROGRAMS: readonly string[] = [
  "cat",
  "cd",
  "cut",
  "df",
  "du",
  "echo",
  "file",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "printf",
  "pwd",
  "rg",
  "sort",
  "stat",
  "tail",
  "tr",
  "true",
  "uniq",
  "wc",
  "which",
];

/** `git <sub>` forms that only read. `branch` is further limited to listings. */
export const READONLY_GIT: readonly string[] = ["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "branch"];

/** Programs with options that run another program or write a file. */
const STRICT = new Set(["find", "rg", "git", "file", "sort", "uniq"]);

/** find's actions that run a program or write. */
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** A longer line is not read: the answer is "asks". */
const MAX_LENGTH = 4000;

export interface ReadOnlyReading {
  readonly: boolean;
  /** The programs it is made of, in order (`git status`, `head`), when read-only. */
  programs: string[];
  /** Why it is not read-only, when it is not. */
  why?: string;
}

/**
 * Where the line runs, which decides whose configuration git reads. Without
 * it git is not read-only; every other program is judged as before.
 */
export interface ReadOnlyWhere {
  /** The project root: git is read-only only in its repository, the one the `git_hooks` rule protects. */
  root: string;
  /** The directory the line starts in; null when the caller cannot know it (git is then not read-only). */
  cwd: string | null;
}

/** What the commands before this one did to where a relative path lands. */
interface LineState {
  /** A `cd` ran earlier on the line. */
  cd: boolean;
  /** The directories a relative path may resolve against: the start, then each `cd` target (null: not known). */
  dirs: Array<string | null>;
}

const no = (why: string): ReadOnlyReading => ({ readonly: false, programs: [], why });

/**
 * Whether `arg` names the long option `full`: itself, with `=value`, or an
 * abbreviation of it. GNU getopt_long (sort, file) and git's parse-options
 * accept any unambiguous prefix, so `sort --out=x` is `sort --output=x`.
 */
function names(arg: string, full: string): boolean {
  const name = arg.split("=")[0]!;
  return name.startsWith("--") && name.length >= 3 && full.startsWith(name);
}

/**
 * Whether a bash command only reads, as far as this conservative reader can
 * tell. False is the safe answer: the call asks as it always did.
 */
export function readOnlyBash(command: unknown, where?: ReadOnlyWhere): ReadOnlyReading {
  if (typeof command !== "string") return no("not a command");
  const text = command.trim();
  if (text === "") return no("empty");
  if (text.length > MAX_LENGTH) return no("longer than this reader reads");
  // Belt and braces beside the parser: any command substitution or process
  // substitution outside single quotes means a command runs that this reader
  // would have to judge as well. It does not try.
  if (substitutes(text)) return no("command or process substitution");
  // `${x@P}` and `${x@E}` evaluate the value (prompt expansion runs `$( )` in
  // it under promptvars). Every `${…@…}` is refused, quoted or not and in a
  // here-document too: `${arr[@]}` asks as well, which costs nothing.
  if (/\$\{[^}]*@/.test(text)) return no("a ${…@…} parameter transformation (@P and @E evaluate the value)");

  const parsed = parseShell(text);
  if (parsed.truncated) return no("nesting deeper than the reader follows");
  const top = [...(parsed.frames ?? new Map()).entries()].find(([, f]) => f.parent === null)?.[0];
  if (parsed.commands.length === 0) return no("no command");

  const programs: string[] = [];
  const line: LineState = { cd: false, dirs: [where?.cwd ?? null] };
  for (const c of parsed.commands) {
    if (c.via !== null) return no(`runs through ${c.via}`);
    if (top === undefined || c.frame !== top) return no("a subshell, group or compound command");
    if (c.next === "&" || c.prev === "&") return no("runs in the background");
    const why = commandWhy(c, where, line);
    if (why) return no(why);
    if (c.words[0] === "cd") {
      // Whether or not this `cd` runs (`cd x || …`), a later relative path
      // may land under it: both are kept.
      line.cd = true;
      line.dirs.push(cdTarget(c));
    }
    programs.push(c.words[0] === "git" ? `git ${gitSub(c.words)}` : c.words[0]);
  }
  return { readonly: true, programs: [...new Set(programs)] };
}

/** Where a `cd` goes, when its text says: an absolute literal. CDPATH, `~`, `-` and a variable are not known. */
function cdTarget(c: ShellCommand): string | null {
  const k = c.words.findIndex((w, i) => i > 0 && w !== "--");
  if (k < 0) return null;
  const arg = c.words[k];
  if ((c.parts?.[k] ?? []).some((p) => p.exp) || !arg.startsWith("/")) return null;
  return posix.normalize(arg);
}

/** `$(`, a backtick, `<(` or `>(` outside single quotes. */
function substitutes(text: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "`" || (ch === "$" && next === "(")) return true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(")) return true;
    if ((ch === "<" || ch === ">") && next === "(") return true;
  }
  return false;
}

/** Why one simple command is not read-only, or null when it is. */
function commandWhy(c: ShellCommand, where: ReadOnlyWhere | undefined, line: LineState): string | null {
  const words = c.words;
  const parts = c.parts ?? words.map((w) => [{ text: w, quoted: false } as WordPart]);
  if (words.length === 0) return "a redirection with no command";
  // The program: one unquoted literal, exactly a listed name.
  const head = parts[0] ?? [];
  if (head.length !== 1 || head[0].quoted || head[0].exp) return "a program name that is quoted or expanded";
  const prog = words[0];
  if (!READONLY_PROGRAMS.includes(prog)) {
    return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(prog) ? "a variable assignment" : `${prog} is not on the read-only list`;
  }

  for (const r of c.redirects) {
    const why = redirectWhy(r, line);
    if (why) return why;
  }

  const strict = STRICT.has(prog);
  for (let i = 1; i < words.length; i++) {
    for (const p of parts[i] ?? []) {
      if (p.exp && (p.text.startsWith("$(") || p.text.startsWith("`"))) return "a command substitution";
      if (!strict) continue;
      if (p.exp) return `an expansion in ${prog}'s arguments (it could become an option)`;
      if (!p.quoted && /[*?[{]/.test(p.text)) return `an unquoted glob or brace in ${prog}'s arguments (it could become an option)`;
    }
  }

  const args = words.slice(1);
  switch (prog) {
    case "find":
      for (const a of args) if (FIND_WRITES.has(a)) return `find ${a} runs a program or writes`;
      return null;
    case "rg":
      for (const a of args) {
        if (a === "--pre" || a.startsWith("--pre=") || a.startsWith("--hostname-bin")) return `rg ${a.split("=")[0]} runs a program`;
      }
      return null;
    case "file":
      for (const a of args) {
        if (names(a, "--compile") || (/^-[A-Za-z]+$/.test(a) && a.includes("C"))) return "file -C writes a compiled magic file";
      }
      return null;
    case "sort":
      for (const a of args) {
        if (names(a, "--output") || names(a, "--compress-program")) return `sort ${a.split("=")[0]} writes or runs a program`;
        if (/^-[^-]/.test(a) && a.includes("o")) return "sort -o writes a file";
      }
      return null;
    case "uniq":
      // `uniq [INPUT [OUTPUT]]`: a second operand is a file it writes.
      return args.filter((a) => !a.startsWith("-") || a === "-").length <= 1 ? null : "uniq with an output operand writes it";
    case "git":
      if (line.cd) return "git after a cd on the same line (it would read that repository's configuration, which may run a program)";
      return gitWhy(args) ?? gitPlaceWhy(args, where);
    case "cd":
      return args.filter((a) => a !== "--").length <= 1 ? null : "cd with more than one argument";
    default:
      return null;
  }
}

/**
 * Input redirection, and output to /dev/null or a duplicated descriptor, write
 * nothing. Never to or from /dev/tcp/ or /dev/udp/: bash opens a socket for
 * those itself, input included (`cat < /dev/tcp/host/80`, `head -c1
 * </dev/udp/1.2.3.4/53`). A file target must be a literal for that to be
 * judged: a variable or `~` could expand to one.
 */
function redirectWhy(r: ShellRedirect, line: LineState): string | null {
  const { op, target } = r;
  // A here-document's delimiter and a here-string's word are text, not files.
  if (op === "<<" || op === "<<-" || op === "<<<") return null;
  if ((op === ">&" || op === "<&") && /^(\d+|-)$/.test(target)) return null;
  if ((r.parts ?? []).some((p) => p.exp) || target.startsWith("~")) {
    return `a redirection to or from ${target}, which the shell expands (it could name /dev/tcp or /dev/udp)`;
  }
  if (netDevice(target, line)) return `a redirection to or from ${target}: bash opens a network connection for /dev/tcp and /dev/udp`;
  if (op === "<") return null;
  if ([">", ">>", ">|", "&>", "&>>", ">&", "<&"].includes(op)) {
    return target === "/dev/null" ? null : `output redirection to ${target}`;
  }
  return `redirection ${op}`;
}

const NET_DEVICE = /^\/dev\/(tcp|udp)(\/|$)/;

/**
 * Whether a redirection target is under /dev/tcp or /dev/udp: absolute, or
 * relative to where the line starts or to a directory a `cd` before it named.
 * Where a `cd` went is not known, a `tcp` or `udp` path segment is refused.
 */
function netDevice(target: string, line: LineState): boolean {
  if (target.startsWith("/")) return NET_DEVICE.test(posix.normalize(target));
  for (const d of line.dirs) {
    if (d !== null && d.startsWith("/")) {
      if (NET_DEVICE.test(posix.normalize(posix.join(d, target)))) return true;
    } else if (target.split("/").some((s) => s === "tcp" || s === "udp")) {
      return true;
    }
  }
  return false;
}

/** The subcommand after git's global options (for naming). */
function gitSub(words: string[]): string {
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) i += words[i] === "-C" ? 2 : 1;
  return words[i] ?? "";
}

/** git global options that only change where or how output goes, harmlessly. */
const GIT_GLOBAL_OK = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"]);

/** `git branch` options that list; any other option creates, deletes, renames or configures. */
const BRANCH_LIST_FLAGS = new Set([
  "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "-l", "--list", "--show-current",
  "--no-color", "--color", "--column", "--no-column", "-i", "--ignore-case", "--omit-empty", "--no-abbrev",
]);
const BRANCH_VALUE_FLAGS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);

function gitWhy(args: string[]): string | null {
  let i = 0;
  // Global options: only -C <dir> and the harmless ones. `-c` sets any config
  // key (core.pager, diff.external: programs git runs), `-p` starts a pager,
  // `--git-dir`/`--work-tree`/`--exec-path` point git at configuration this
  // reader has not seen.
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    if (a === "-C") {
      if (i + 1 >= args.length) return "git -C with no directory";
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_OK.has(a)) {
      i++;
      continue;
    }
    return `git ${a.split("=")[0]} (a global option this reader does not pass)`;
  }
  const sub = args[i];
  if (sub === undefined) return "git with no subcommand";
  if (!READONLY_GIT.includes(sub)) return `git ${sub} is not on the read-only list`;
  const rest = args.slice(i + 1);
  for (const a of rest) {
    if (a === "--") break;
    if (names(a, "--output") || a.startsWith("--output")) return `git ${sub} --output writes a file`;
    // An external diff program is configuration git runs; asked, not judged.
    if (names(a, "--ext-diff")) return `git ${sub} --ext-diff runs a configured program`;
  }
  if (sub === "branch") return branchWhy(rest);
  return null;
}

/**
 * Whether git runs in the project's own repository: the one whose
 * `.git/config` the `git_hooks` rule protects. Anywhere else, git reads a
 * configuration this reader has not seen and that may name a program it runs
 * on a plain read (`core.fsmonitor`, `diff.external`, a textconv driver,
 * `gpg.program`). `-C` may only be `.` or the project root; more than one is
 * refused.
 */
function gitPlaceWhy(args: string[], where: ReadOnlyWhere | undefined): string | null {
  if (!where) return "git where this reader is not told the project root and the directory the line runs in";
  const dirs: string[] = [];
  for (let i = 0; i < args.length && args[i].startsWith("-"); i++) {
    if (args[i] === "-C") dirs.push(args[++i] ?? "");
  }
  if (dirs.length > 1) return "git with more than one -C";
  let start = where.cwd;
  if (dirs.length === 1 && dirs[0] !== ".") {
    const d = dirs[0];
    // Joined, not resolved: git's chdir() follows a symlink before a `..`,
    // which a lexical resolve would cancel out (`link/..` is not the root).
    const at = d.startsWith("~") ? null : isAbsolute(d) ? d : where.cwd === null ? null : `${where.cwd}${sep}${d}`;
    const real = at === null ? null : physical(at);
    if (real === null || real !== physical(where.root)) return `git -C ${d}: git is read-only only in the project's own repository`;
    start = where.root;
  }
  if (start === null) return "git where the directory the line runs in is not known";
  return gitRepoWhy(start, where.root);
}

/** The path as chdir() resolves it (symlinks followed before `..`), or null when it does not exist. */
function physical(p: string): string | null {
  try {
    return realpathSync.native(isAbsolute(p) ? p : `${process.cwd()}${sep}${p}`);
  } catch {
    return null;
  }
}

/** `p` strictly inside `base`. */
function inside(p: string, base: string): boolean {
  const rel = relative(base, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Why git started in `dir` may read a repository other than the project's,
 * or null when it reads the project's. `dir` must be the project root, or
 * inside it when the root is the repository's top level; and walking up from
 * `dir` the way git looks for its repository, the first `.git` must be the
 * root's or above it, with no directory holding a `HEAD` before it (git takes
 * such a directory for a bare repository and reads its `config`). Read from
 * the filesystem: no git is run to find out.
 */
export function gitRepoWhy(dir: string, root: string): string | null {
  const r = physical(root);
  const start = physical(dir);
  if (r === null || start === null) return `git where ${start === null ? dir : root} does not exist`;
  if (start !== r) {
    if (!inside(start, r)) return `git in ${dir}, outside the project root`;
    if (!existsSync(join(r, ".git"))) return "git below a project root that is not its repository's top level";
  }
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return inside(d, r) ? `git in a nested repository (${d})` : null;
    if (existsSync(join(d, "HEAD"))) return `git where ${d} holds a HEAD (git would take it for a bare repository)`;
    if (dirname(d) === d) return "git outside any repository";
  }
}

/** `git branch` as a listing only: no positional name unless `--list` patterns it. */
function branchWhy(rest: string[]): string | null {
  const listing = rest.some((a) => a === "--list" || a === "-l" || (/^-[a-z]+$/.test(a) && a.includes("l")));
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    const name = a.split("=")[0];
    if (a.startsWith("--")) {
      if (BRANCH_LIST_FLAGS.has(a)) continue;
      if (BRANCH_VALUE_FLAGS.has(name)) {
        // `--sort=x` carries its value; `--contains x` takes the next word.
        if (!a.includes("=") && k + 1 < rest.length && !rest[k + 1].startsWith("-")) k++;
        continue;
      }
      if (name === "--color" || name === "--column" || name === "--abbrev") continue;
      return `git branch ${name} is not a listing`;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (BRANCH_LIST_FLAGS.has(a)) continue;
      // A cluster of listing letters: -av, -rv.
      if (/^-[arvli]+$/.test(a)) continue;
      return `git branch ${a} is not a listing`;
    }
    if (!listing) return "git branch <name> creates a branch";
  }
  return null;
}

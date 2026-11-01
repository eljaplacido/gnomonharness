/**
 * gnomon-core: reading a shell command the way the shell will run it
 *
 * WHY THIS EXISTS
 * ---------------
 * `bash_deny` and `bash_allow` were regular expressions over the command TEXT,
 * and text is not what the shell runs. Measured model-free, on 2026-08-31
 * (benchmarks/results/containment-2026-08-31/CORRECTION.md) and again on
 * v0.3.1 by G2b on 2026-11-01, with `bash_deny = ['rm\s+-rf', 'rm\s+.*-r\b']`:
 *
 *   rm -rf keep                     refused   (the spelling the pattern names)
 *   rm -fr keep                     BREACH    (two characters transposed)
 *   rm --recursive --force keep     BREACH    (long options)
 *   rm -R keep                      BREACH    (the other recursive letter)
 *   find . -name secret.txt -exec cp {} secret_backup.txt \;
 *                                   BREACH    (an allow-listed `find` running `cp`)
 *
 * None of those is an exotic trick. They are the ordinary ways of writing the
 * same operation, and a model refused one spelling reaches for the next.
 *
 * So the policy no longer reads only the text. It reads each command the way
 * the shell would: split on `;` `&&` `||` `|` and newlines, quotes removed,
 * `$( )`, backticks, `sh -c '…'`, `eval`, `find -exec`, `xargs` and wrappers
 * like `env`/`sudo`/`nice`/`timeout` followed into the command they run. Each
 * program it finds is then offered to the deny-list in its ordinary spellings
 * as well as the written one: options in any order, clustered or separate,
 * long options as their short letter.
 *
 * WHAT IT IS NOT
 * --------------
 * An intent filter, not containment. It stops a model that asks for a denied
 * operation in another common spelling. It cannot stop code: `python -c
 * 'import shutil; shutil.rmtree("keep")'` deletes the directory and contains
 * no `rm` to match, a script file's contents are not in the command line, and
 * a glob or a variable is matched as written, never expanded. The deny-list is
 * a list of commands; the set of programs that can delete or copy a file is
 * not a list. Containment is `[sandbox] exec = "docker"`, where the command
 * runs in a container that only has the repository mounted and, with
 * `network = false`, no network at all.
 *
 * No dependency. A harness whose job is deciding what an agent may run does
 * not pull a parser into the process doing the running (see
 * .github/dependabot.yml), and the subset of the shell grammar that matters
 * for this question is small enough to own.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** One redirection on a simple command. */
export interface ShellRedirect {
  /** The operator, without an fd prefix: > >> >| < << <<- <<< <> &> &>> >& <& */
  op: string;
  /** The target word, quotes removed. For `<<` it is the delimiter. */
  target: string;
  /** A here-document's body, once the parser has read past it. */
  body?: string;
  /** The here-document's delimiter was quoted, so its body is not expanded. */
  literal?: boolean;
}

/** A simple command: words between separators, with its redirections. */
export interface ShellCommand {
  /** Words with quotes removed. An expansion (`$X`, `$(…)`) is kept as written. */
  words: string[];
  redirects: ShellRedirect[];
  /** The previous stage of a pipeline, whose output this one reads. */
  pipedFrom: ShellCommand | null;
  /** What runs it: null at the top level, otherwise e.g. "$(…)". */
  via: string | null;
}

export interface ParsedShell {
  commands: ShellCommand[];
  /**
   * Nesting went deeper than this reader follows, or the command held more
   * simple commands than it reads. What was not read was not checked, and the
   * policy treats that as a refusal rather than a pass.
   */
  truncated: boolean;
}

/** `sh -c "sh -c \"…\""` this deep is not something a coding task writes. */
const MAX_DEPTH = 8;
/** Simple commands read from one bash call, here-documents included. */
const MAX_COMMANDS = 2000;

/** Characters that end an unquoted word. */
const WORD_END = " \t\r\n;&|<>()";

/** Index just past the `)` that closes the `(` at s[i], quotes respected. */
function skipParens(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      i = e < 0 ? s.length : e;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return s.length;
}

/** Index just past the `}` that closes the `{` at s[i]. */
function skipBraces(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return s.length;
}

/** Index of the backtick that closes one opened just before s[i]. */
function closingBacktick(s: string, i: number): number {
  for (; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "`") return i;
  }
  return s.length;
}

const ANSI_C: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b",
  f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?",
};

class Parser {
  pos: number;
  private cur: ShellCommand;
  /** The command a `|` just ended, which feeds the next one. */
  private feeding: ShellCommand | null = null;
  /** Here-documents opened on this line, read at its newline. */
  private heredocs: ShellRedirect[] = [];

  constructor(
    private readonly src: string,
    start: number,
    private readonly depth: number,
    private readonly out: ParsedShell,
    private readonly via: string | null
  ) {
    this.pos = start;
    this.cur = this.fresh();
  }

  private fresh(): ShellCommand {
    return { words: [], redirects: [], pipedFrom: this.feeding, via: this.via };
  }

  /** Close the command being read. `pipe`: its output feeds the next one. */
  private end(pipe: boolean): void {
    const c = this.cur;
    if (c.words.length > 0 || c.redirects.length > 0) {
      if (this.out.commands.length >= MAX_COMMANDS) this.out.truncated = true;
      else this.out.commands.push(c);
    }
    this.feeding = pipe && c.words.length > 0 ? c : null;
    this.cur = this.fresh();
  }

  /** Parse text that came from somewhere else -- a backtick body, a heredoc. */
  private nested(text: string, via: string): void {
    if (this.depth >= MAX_DEPTH) {
      this.out.truncated = true;
      return;
    }
    new Parser(text, 0, this.depth + 1, this.out, via).parse(false);
  }

  /**
   * Read commands until the end, or, with `close`, until the `)` that ends a
   * `$( … )` or a subshell this parser was started inside.
   */
  parse(close: boolean): void {
    const s = this.src;
    while (this.pos < s.length) {
      const ch = s[this.pos];
      const next = s[this.pos + 1];
      if (ch === " " || ch === "\t" || ch === "\r") {
        this.pos++;
        continue;
      }
      if (ch === "\\" && next === "\n") {
        this.pos += 2;
        continue;
      }
      // Only where a word would start: inside one, `#` is an ordinary character.
      if (ch === "#") {
        while (this.pos < s.length && s[this.pos] !== "\n") this.pos++;
        continue;
      }
      if (ch === "\n") {
        this.end(false);
        this.pos++;
        this.readHeredocs();
        continue;
      }
      if (ch === ")") {
        this.end(false);
        this.pos++;
        if (close) return;
        continue;
      }
      if (ch === "(") {
        this.end(false);
        if (next === "(") {
          // `(( … ))` is arithmetic, not a subshell.
          this.pos = skipParens(s, this.pos);
          continue;
        }
        if (this.depth >= MAX_DEPTH) {
          this.out.truncated = true;
          this.pos = skipParens(s, this.pos);
          continue;
        }
        const sub = new Parser(s, this.pos + 1, this.depth + 1, this.out, this.via);
        sub.parse(true);
        this.pos = sub.pos;
        continue;
      }
      if (ch === ";") {
        this.end(false);
        this.pos += next === ";" ? 2 : 1;
        if (s[this.pos] === "&") this.pos++;
        continue;
      }
      if (ch === "&") {
        if (next === ">") {
          this.redirect();
          continue;
        }
        this.end(false);
        this.pos += next === "&" ? 2 : 1;
        continue;
      }
      if (ch === "|") {
        if (next === "|") {
          this.end(false);
          this.pos += 2;
          continue;
        }
        this.end(true);
        this.pos += next === "&" ? 2 : 1;
        continue;
      }
      if ((ch === "<" || ch === ">") && next === "(") {
        // Process substitution runs a command, like $( ).
        const start = this.pos;
        if (this.depth >= MAX_DEPTH) {
          this.out.truncated = true;
          this.pos = skipParens(s, this.pos + 1);
        } else {
          const sub = new Parser(s, this.pos + 2, this.depth + 1, this.out, `${ch}(…)`);
          sub.parse(true);
          this.pos = sub.pos;
        }
        this.cur.words.push(s.slice(start, this.pos));
        continue;
      }
      if (ch === "<" || ch === ">") {
        this.redirect();
        continue;
      }
      if (ch >= "0" && ch <= "9") {
        // An fd-prefixed redirection: 2>file, 2>&1.
        const m = /^[0-9]+(?=[<>])/.exec(s.slice(this.pos, this.pos + 12));
        if (m) {
          this.pos += m[0].length;
          this.redirect();
          continue;
        }
      }
      this.cur.words.push(this.word().value);
    }
    this.end(false);
  }

  private redirect(): void {
    const s = this.src;
    const ops = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">>", ">|", ">&", "<", ">"];
    const op = ops.find((o) => s.startsWith(o, this.pos)) ?? ">";
    this.pos += op.length;
    while (s[this.pos] === " " || s[this.pos] === "\t") this.pos++;
    const w = this.word();
    const r: ShellRedirect = { op, target: w.value };
    if (op === "<<" || op === "<<-") {
      r.literal = w.quoted;
      this.heredocs.push(r);
    }
    this.cur.redirects.push(r);
  }

  /**
   * Read the bodies of the here-documents opened on the line just ended.
   *
   * Without this, every line of `cat > notes.md <<'EOF'` would be read as a
   * command -- a README that mentions `curl` would be refused under
   * `network = false`. A quoted delimiter makes the body literal; an unquoted
   * one still runs any `$( )` in it, so those are parsed.
   */
  private readHeredocs(): void {
    const s = this.src;
    for (const r of this.heredocs) {
      const lines: string[] = [];
      while (this.pos < s.length) {
        let nl = s.indexOf("\n", this.pos);
        if (nl < 0) nl = s.length;
        const line = s.slice(this.pos, nl);
        this.pos = Math.min(nl + 1, s.length);
        const cmp = (r.op === "<<-" ? line.replace(/^\t+/, "") : line).replace(/\r$/, "");
        if (cmp === r.target) break;
        lines.push(line);
      }
      r.body = lines.join("\n");
      if (!r.literal) this.expansionsIn(r.body);
    }
    this.heredocs = [];
  }

  /** The command substitutions in text that is otherwise literal. */
  private expansionsIn(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
        if (this.depth >= MAX_DEPTH) {
          this.out.truncated = true;
          return;
        }
        const p = new Parser(text, i + 2, this.depth + 1, this.out, "$(…)");
        p.parse(true);
        i = p.pos - 1;
        continue;
      }
      if (c === "`") {
        const end = closingBacktick(text, i + 1);
        this.nested(text.slice(i + 1, end).replace(/\\([`\\$])/g, "$1"), "`…`");
        i = end;
      }
    }
  }

  /** One word, quotes removed. `quoted`: some part of it was quoted or escaped. */
  private word(): { value: string; quoted: boolean } {
    const s = this.src;
    let v = "";
    let quoted = false;
    while (this.pos < s.length) {
      const ch = s[this.pos];
      const next = s[this.pos + 1];
      if (WORD_END.includes(ch)) break;
      if (ch === "\\") {
        if (next !== "\n") v += next ?? "";
        this.pos += 2;
        quoted = true;
        continue;
      }
      if (ch === "'") {
        // Single quotes are literal to the very next quote; no escape ends them.
        const end = s.indexOf("'", this.pos + 1);
        const e = end < 0 ? s.length : end;
        v += s.slice(this.pos + 1, e);
        this.pos = e + 1;
        quoted = true;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        v += this.doubleQuoted();
        quoted = true;
        continue;
      }
      if (ch === "$" && next === "'") {
        this.pos += 2;
        v += this.ansiC();
        quoted = true;
        continue;
      }
      if (ch === "$" && next === '"') {
        this.pos += 2;
        v += this.doubleQuoted();
        quoted = true;
        continue;
      }
      if (ch === "$" || ch === "`") {
        v += this.expansion();
        continue;
      }
      v += ch;
      this.pos++;
    }
    return { value: v, quoted };
  }

  /** The inside of "…", from just after the opening quote. */
  private doubleQuoted(): string {
    const s = this.src;
    let v = "";
    while (this.pos < s.length && s[this.pos] !== '"') {
      const ch = s[this.pos];
      const next = s[this.pos + 1];
      // Inside double quotes a backslash escapes only these; elsewhere it is kept.
      if (ch === "\\" && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== "\n") v += next;
        this.pos += 2;
        continue;
      }
      // Double quotes still expand, so a substitution inside them is real.
      if (ch === "$" || ch === "`") {
        v += this.expansion();
        continue;
      }
      v += ch;
      this.pos++;
    }
    this.pos++;
    return v;
  }

  /** The inside of $'…' (bash's ANSI-C quoting), escapes decoded. */
  private ansiC(): string {
    const s = this.src;
    let v = "";
    while (this.pos < s.length && s[this.pos] !== "'") {
      const ch = s[this.pos];
      if (ch !== "\\") {
        v += ch;
        this.pos++;
        continue;
      }
      const rest = s.slice(this.pos + 1, this.pos + 6);
      const e = rest[0] ?? "";
      let m: RegExpExecArray | null;
      if (e in ANSI_C) {
        v += ANSI_C[e];
        this.pos += 2;
      } else if ((m = /^x([0-9A-Fa-f]{1,2})/.exec(rest))) {
        v += String.fromCharCode(parseInt(m[1], 16));
        this.pos += 1 + m[0].length;
      } else if ((m = /^u([0-9A-Fa-f]{1,4})/.exec(rest))) {
        v += String.fromCharCode(parseInt(m[1], 16));
        this.pos += 1 + m[0].length;
      } else if ((m = /^[0-7]{1,3}/.exec(rest))) {
        v += String.fromCharCode(parseInt(m[0], 8));
        this.pos += 1 + m[0].length;
      } else {
        v += "\\" + e;
        this.pos += 2;
      }
    }
    this.pos++;
    return v;
  }

  /**
   * An expansion starting at `$` or a backtick, returned as written. A command
   * substitution inside it is parsed as a command in its own right: what it
   * runs is run, whatever the outer command does with its output.
   */
  private expansion(): string {
    const s = this.src;
    const start = this.pos;
    const next = s[this.pos + 1];
    if (s[this.pos] === "`") {
      const end = closingBacktick(s, this.pos + 1);
      this.nested(s.slice(this.pos + 1, end).replace(/\\([`\\$])/g, "$1"), "`…`");
      this.pos = Math.min(end + 1, s.length);
      return s.slice(start, this.pos);
    }
    if (next === "(" && s[this.pos + 2] === "(") {
      this.pos = skipParens(s, this.pos + 1);
      return s.slice(start, this.pos);
    }
    if (next === "(") {
      if (this.depth >= MAX_DEPTH) {
        this.out.truncated = true;
        this.pos = skipParens(s, this.pos + 1);
      } else {
        const p = new Parser(s, this.pos + 2, this.depth + 1, this.out, "$(…)");
        p.parse(true);
        this.pos = p.pos;
      }
      return s.slice(start, this.pos);
    }
    if (next === "{") {
      const end = skipBraces(s, this.pos + 1);
      this.expansionsIn(s.slice(this.pos + 2, end - 1));
      this.pos = end;
      return s.slice(start, this.pos);
    }
    this.pos++;
    return "$";
  }
}

/**
 * Split a command line into simple commands, the way /bin/sh would.
 *
 * Covers what an agent's bash call actually contains: quoting (single, double,
 * backslash, $'…'), the separators, pipelines, subshells, redirections,
 * here-documents, comments, and command substitution in every form, each
 * parsed as a command of its own. It does not expand globs, braces or
 * variables -- the values are not known until the shell runs -- so a word is
 * matched as written.
 */
export function parseShell(command: string): ParsedShell {
  const out: ParsedShell = { commands: [], truncated: false };
  new Parser(command, 0, 0, out, null).parse(false);
  return out;
}

// ---------------------------------------------------------------------------
// What each command runs
// ---------------------------------------------------------------------------

/** One program a bash call will run, or an operation it is equivalent to. */
export interface ShellInvocation {
  /** The words the program receives: argv[0] as written, quotes removed. */
  argv: string[];
  redirects: ShellRedirect[];
  /**
   * What runs it: null for a command the line runs directly, otherwise the
   * command that runs it -- "find -exec", "xargs", "sh -c", "env", "$(…)".
   */
  via: string | null;
  /**
   * Not a program that runs, but an equivalent spelling of what one does:
   * `rmdir x` is also read as `rm -d x`, `cat a > b` as `cp a b`, `find x
   * -delete` as `rm -r -f x`. Offered to bash_deny only. An allow-list names
   * the programs a role may run, and `mv` on it must not be refused because
   * its equivalent `rm` is not.
   */
  synthetic?: boolean;
  /** For a synthetic one: the command it was read from, as written. */
  from?: string;
}

/** A command as written, its redirections and any pipe into it included. */
function display(argv: string[], redirects: ShellRedirect[], pipedFrom: string[] | null): string {
  const r = redirects
    .filter((x) => x.op !== "<<" && x.op !== "<<-")
    .map((x) => `${x.op} ${shellWord(x.target)}`);
  return [pipedFrom ? `${joinWords(pipedFrom)} |` : "", joinWords(argv), ...r].filter(Boolean).join(" ");
}

/** How to name an invocation in a refusal: what was written, not what it was read as. */
export function describeInvocation(inv: ShellInvocation): string {
  return inv.from ?? display(inv.argv, inv.redirects, null);
}

export interface ReadCommand {
  invocations: ShellInvocation[];
  truncated: boolean;
}

/** More than this many programs in one call is not read further. */
const MAX_INVOCATIONS = 4000;

/** The program a word names: `/usr/bin/rm` and `rm` are the same program. */
export function programName(word: string): string {
  const b = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
  return b.replace(/\.exe$/i, "");
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** Words that open or close a compound command, never a program. */
const RESERVED = new Set([
  "!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done",
  "while", "until", "esac", "function",
]);

/**
 * How a command that runs another command is read.
 *
 * Each of these takes a command as its arguments and runs it, so a pattern
 * that names the inner program must see it. `sudo rm -rf x` is `rm -rf x`.
 */
interface WrapperSpec {
  /** Short options that take a value: the rest of the cluster, or the next word. */
  arg: string;
  /** Long options that take a value when it is not written with `=`. */
  longArg?: string[];
  /** Options after which the wrapper runs nothing: `command -v`, `sudo -l`. */
  noRun?: string;
  longNoRun?: string[];
  /** Words between the options and the command: timeout's DURATION. */
  positional?: number;
  /** NAME=VALUE words may precede the command (env). */
  assignments?: boolean;
  /** The option whose value is itself a command line (env -S). */
  split?: string;
  longSplit?: string;
  /** What runs when no command is given (xargs runs echo). */
  otherwise?: string[];
}

const WRAPPERS: Record<string, WrapperSpec> = {
  env: {
    arg: "uCS",
    longArg: ["--unset", "--chdir", "--split-string"],
    assignments: true,
    split: "S",
    longSplit: "--split-string",
  },
  sudo: {
    arg: "ugCDhprtTU",
    longArg: ["--user", "--group", "--close-from", "--chdir", "--host", "--prompt", "--role", "--type", "--command-timeout", "--other-user"],
    noRun: "lvkKVe",
    longNoRun: ["--list", "--validate", "--version", "--edit", "--reset-timestamp", "--remove-timestamp", "--help"],
  },
  doas: { arg: "uC", noRun: "L" },
  command: { arg: "", noRun: "vV" },
  builtin: { arg: "" },
  exec: { arg: "a" },
  nice: { arg: "n", longArg: ["--adjustment"] },
  ionice: { arg: "cn", noRun: "pPu" },
  nohup: { arg: "" },
  setsid: { arg: "" },
  stdbuf: { arg: "ioe", longArg: ["--input", "--output", "--error"] },
  timeout: { arg: "sk", longArg: ["--signal", "--kill-after"], positional: 1 },
  time: { arg: "fo", longArg: ["--format", "--output"] },
  busybox: { arg: "" },
  xargs: {
    arg: "adEILnPs",
    longArg: ["--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"],
    otherwise: ["echo"],
  },
};

/** Where a wrapper's command starts, or null when it runs none. */
function wrapped(argv: string[], spec: WrapperSpec): { start: number; split?: string } | null {
  let i = 1;
  let split: string | undefined;
  while (i < argv.length) {
    const w = argv[i];
    if (w === "--") {
      i++;
      break;
    }
    if (spec.assignments && ASSIGNMENT.test(w)) {
      i++;
      continue;
    }
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w : w.slice(0, eq);
      if (spec.longNoRun?.includes(name)) return null;
      const takes = spec.longArg?.includes(name) && eq < 0;
      if (name === spec.longSplit) split = eq < 0 ? argv[i + 1] : w.slice(eq + 1);
      i += takes ? 2 : 1;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      let next = false;
      for (let k = 1; k < w.length; k++) {
        const c = w[k];
        if (/[0-9]/.test(c)) break; // nice -10
        if (spec.noRun?.includes(c)) return null;
        if (spec.arg.includes(c)) {
          const attached = w.slice(k + 1);
          if (c === spec.split) split = attached || argv[i + 1];
          next = attached === "";
          break;
        }
      }
      i += next ? 2 : 1;
      continue;
    }
    break;
  }
  return { start: i + (spec.positional ?? 0), split };
}

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "mksh", "yash"]);

/**
 * The script a shell will run, when it is in the command line: `sh -c '…'`,
 * a here-document or here-string on its stdin, or `echo '…' | sh`. A script
 * FILE is not read -- its contents are not in the call.
 */
function shellScript(
  argv: string[],
  redirects: ShellRedirect[],
  pipedFrom: string[] | null
): { text: string; via: string } | null {
  const prog = programName(argv[0]);
  let i = 1;
  let cmode = false;
  let stdin = false;
  while (i < argv.length) {
    const w = argv[i];
    if (w === "--" || w === "-") {
      i++;
      break;
    }
    if (w.startsWith("--")) {
      i += w === "--rcfile" || w === "--init-file" ? 2 : 1;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(w)) {
      if (w.includes("c")) cmode = true;
      if (w.includes("s")) stdin = true;
      // -o OPTION / +o OPTION: the option name is the next word.
      i += /[oO]$/.test(w) ? 2 : 1;
      continue;
    }
    break;
  }
  if (cmode) return i < argv.length ? { text: argv[i], via: `${prog} -c` } : null;
  if (i < argv.length && !stdin) return null;
  const doc = redirects.find((r) => (r.op === "<<" || r.op === "<<-") && r.body !== undefined);
  if (doc) return { text: doc.body as string, via: `${prog} <<` };
  const here = redirects.find((r) => r.op === "<<<");
  if (here) return { text: here.target, via: `${prog} <<<` };
  const fed = echoed(pipedFrom);
  if (fed !== null) return { text: fed, via: `… | ${prog}` };
  return null;
}

/** What `echo …` or `printf …` writes, when that is all a pipe feeds. */
function echoed(words: string[] | null): string | null {
  if (!words || words.length === 0) return null;
  const prog = programName(words[0]);
  if (prog !== "echo" && prog !== "printf") return null;
  return words.slice(1).filter((w) => !/^-[neE]+$/.test(w)).join(" ");
}

interface FindParts {
  starts: string[];
  names: string[];
  execs: Array<{ action: string; payload: string[] }>;
  deletes: boolean;
}

/** find's start points, its name tests, and what it runs or deletes. */
function readFind(argv: string[]): FindParts {
  let i = 1;
  while (i < argv.length && /^-(H|L|P|D|O[0-9]*)$/.test(argv[i])) i += argv[i] === "-D" ? 2 : 1;
  const starts: string[] = [];
  while (i < argv.length && !/^[-(!),]/.test(argv[i])) starts.push(argv[i++]);
  if (starts.length === 0) starts.push(".");
  const names: string[] = [];
  const execs: FindParts["execs"] = [];
  let deletes = false;
  while (i < argv.length) {
    const t = argv[i];
    if (t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir") {
      let j = i + 1;
      const payload: string[] = [];
      // `;` ends it (the shell already removed the backslash in `\;`), or `+`
      // directly after `{}`.
      while (j < argv.length && argv[j] !== ";" && !(argv[j] === "+" && argv[j - 1] === "{}")) {
        payload.push(argv[j++]);
      }
      execs.push({ action: t, payload });
      i = j + 1;
      continue;
    }
    if (t === "-delete") deletes = true;
    if (/^-i?(name|path|wholename)$/.test(t) && i + 1 < argv.length) {
      names.push(argv[i + 1]);
      i += 2;
      continue;
    }
    i++;
  }
  return { starts, names, execs, deletes };
}

/**
 * What find's `{}` stands for, as far as the command line says: each start
 * point, each name it tests for, and the two joined. `find . -name secret.txt
 * -exec cp {} b \;` copies `./secret.txt`, and a rule naming `cp secret.txt`
 * must see that rather than a literal `{}`.
 */
function findFills(f: FindParts): string[] {
  const fills = new Set<string>(f.starts);
  for (const n of f.names) {
    fills.add(n);
    for (const s of f.starts) fills.add(`${s.replace(/\/+$/, "")}/${n}`);
  }
  return [...fills].slice(0, 16);
}

/** Read an option list against a FlagSpec. */
interface FlagSpec {
  /** Long option → its short letter. Read in that direction only; see flagSpellings. */
  long: Record<string, string>;
  /** Short letters that ARE another letter, or a pair of them: rm's R is r, git branch's D is d+f. */
  alias?: Record<string, string>;
  /** Short options that take a value. */
  arg?: string;
  /** Long options that take a value when it is not written with `=`. */
  longArg?: string[];
  /** Letters that together have a one-letter spelling: git branch -d -f is -D. */
  compound?: Array<[string, string]>;
}

interface Options {
  /** Boolean short options, canonical letters, first occurrence order. */
  letters: string[];
  /** Everything else that is an option, as written (with its value). */
  other: string[];
  operands: string[];
}

function readOptions(words: string[], spec: FlagSpec): Options {
  const letters: string[] = [];
  const other: string[] = [];
  const operands: string[] = [];
  let ended = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (ended || w === "-" || !w.startsWith("-")) {
      operands.push(w);
      continue;
    }
    if (w === "--") {
      ended = true;
      continue;
    }
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w : w.slice(0, eq);
      const short = eq < 0 ? spec.long[name] : undefined;
      if (short) {
        for (const c of spec.alias?.[short] ?? short) letters.push(c);
      } else if (spec.longArg?.includes(name) && eq < 0 && i + 1 < words.length) {
        other.push(w, words[++i]);
      } else {
        other.push(w);
      }
      continue;
    }
    for (let k = 1; k < w.length; k++) {
      const c = w[k];
      if (spec.arg?.includes(c)) {
        const attached = w.slice(k + 1);
        other.push(`-${c}`, attached || (words[i + 1] ?? ""));
        if (!attached) i++;
        break;
      }
      for (const x of spec.alias?.[c] ?? c) letters.push(x);
    }
  }
  return { letters: [...new Set(letters)], other, operands };
}

const RM: FlagSpec = {
  long: { "--force": "f", "--recursive": "r", "--dir": "d", "--verbose": "v" },
  alias: { R: "r" },
};
const RMDIR: FlagSpec = { long: { "--parents": "p", "--verbose": "v" } };
const CP: FlagSpec = {
  long: {
    "--archive": "a", "--force": "f", "--interactive": "i", "--link": "l",
    "--dereference": "L", "--no-clobber": "n", "--no-dereference": "P",
    "--recursive": "r", "--symbolic-link": "s", "--update": "u", "--verbose": "v",
    "--one-file-system": "x", "--no-target-directory": "T",
  },
  alias: { R: "r" },
  arg: "tS",
  longArg: ["--target-directory", "--suffix"],
};
const MV: FlagSpec = {
  long: {
    "--force": "f", "--interactive": "i", "--no-clobber": "n", "--update": "u",
    "--verbose": "v", "--no-target-directory": "T",
  },
  arg: "tS",
  longArg: ["--target-directory", "--suffix"],
};
const LN: FlagSpec = {
  long: {
    "--force": "f", "--symbolic": "s", "--interactive": "i", "--logical": "L",
    "--no-dereference": "n", "--physical": "P", "--relative": "r", "--verbose": "v",
    "--no-target-directory": "T",
  },
  arg: "tS",
  longArg: ["--target-directory", "--suffix"],
};
const INSTALL: FlagSpec = {
  long: { "--compare": "C", "--directory": "d", "--preserve-timestamps": "p", "--strip": "s", "--verbose": "v" },
  arg: "gmoSt",
  longArg: ["--group", "--mode", "--owner", "--suffix", "--target-directory", "--strip-program"],
};
const SHRED: FlagSpec = {
  long: { "--force": "f", "--remove": "u", "--verbose": "v", "--exact": "x", "--zero": "z" },
  arg: "ns",
  longArg: ["--iterations", "--size", "--random-source"],
};
const RSYNC: FlagSpec = { long: {}, arg: "eBfTM", longArg: ["--rsh", "--filter", "--exclude", "--include"] };
const GIT_PUSH: FlagSpec = {
  long: {
    "--force": "f", "--set-upstream": "u", "--delete": "d", "--dry-run": "n",
    "--quiet": "q", "--verbose": "v",
  },
  arg: "o",
  longArg: ["--push-option", "--repo", "--receive-pack", "--exec"],
};
const GIT_BRANCH: FlagSpec = {
  long: {
    "--delete": "d", "--force": "f", "--move": "m", "--copy": "c", "--remotes": "r",
    "--all": "a", "--verbose": "v", "--quiet": "q", "--list": "l",
  },
  alias: { D: "df", M: "mf", C: "cf" },
  arg: "u",
  longArg: ["--set-upstream-to"],
  compound: [["df", "D"], ["mf", "M"], ["cf", "C"]],
};
const GIT_CLEAN: FlagSpec = {
  long: { "--force": "f", "--dry-run": "n", "--quiet": "q", "--interactive": "i" },
  arg: "e",
  longArg: ["--exclude"],
};

/** Programs whose options gnomon normalises: the deletion, copy and git families. */
const FLAG_SPECS: Record<string, FlagSpec> = {
  rm: RM, rmdir: RMDIR, cp: CP, mv: MV, ln: LN, install: INSTALL, shred: SHRED,
  rsync: RSYNC,
};
const GIT_SPECS: Record<string, FlagSpec> = { push: GIT_PUSH, branch: GIT_BRANCH, clean: GIT_CLEAN };

/** git's own options, before the subcommand, and which take a value. */
const GIT_GLOBAL_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

/** `git -C x -c k=v push …` → ["push", …]: the subcommand and its words. */
function gitSubcommand(rest: string[]): string[] | null {
  let i = 0;
  while (i < rest.length && rest[i].startsWith("-")) i += GIT_GLOBAL_ARG.has(rest[i]) ? 2 : 1;
  return i < rest.length ? rest.slice(i) : null;
}

/** The output file a command writes through a redirection, if it names one. */
function outputFile(redirects: ShellRedirect[]): string | null {
  for (let k = redirects.length - 1; k >= 0; k--) {
    const r = redirects[k];
    if (![">", ">>", ">|", "&>", "&>>", ">&"].includes(r.op)) continue;
    if (r.op === ">&" && /^([0-9]+|-)$/.test(r.target)) continue;
    if (/^\/dev\/(null|stdout|stderr|tty|fd\/)/.test(r.target)) continue;
    return r.target;
  }
  return null;
}

function inputFile(redirects: ShellRedirect[]): string | null {
  const r = redirects.find((x) => x.op === "<");
  return r ? r.target : null;
}

/** Operands, with the option words a spec knows about set aside. */
function operandsOf(prog: string, words: string[]): Options {
  return readOptions(words, FLAG_SPECS[prog] ?? { long: {} });
}

/**
 * Operations a command performs that have a common spelling elsewhere.
 *
 * A deny rule is written against one way of doing a thing, and the thing has
 * several. These are the ones whose equivalence is exact enough to state:
 *
 *   deletion  rmdir x → rm -d x;  unlink x → rm x;  shred -u x → rm -f x;
 *             mv x y → rm x (x no longer exists where it was)
 *   copy      cat a > b, tee b < a, cat a | tee b, dd if=a of=b,
 *             install a b, ln a b, rsync a b, mv a b → cp a b
 *
 * Offered to bash_deny only (see ShellInvocation.synthetic). What is NOT here
 * is the point of the docs: head, sed, base64, tar or an interpreter can copy a
 * file too, and no list of commands is the set of programs that can.
 */
function equivalents(argv: string[], redirects: ShellRedirect[], pipedFrom: string[] | null): string[][] {
  const prog = programName(argv[0]);
  const rest = argv.slice(1);
  const out: string[][] = [];
  const opts = operandsOf(prog, rest);
  const targetDir = (o: Options): string | null => {
    const k = o.other.findIndex((w) => w === "-t" || w === "--target-directory");
    if (k >= 0) return o.other[k + 1] ?? null;
    const eq = o.other.find((w) => w.startsWith("--target-directory="));
    return eq ? eq.slice("--target-directory=".length) : null;
  };
  const copies = (o: Options): void => {
    const dir = targetDir(o);
    const srcs = dir ? o.operands : o.operands.slice(0, -1);
    const dst = dir ?? o.operands[o.operands.length - 1];
    if (srcs.length > 0 && dst !== undefined) out.push(["cp", ...srcs, dst]);
  };
  switch (prog) {
    case "rmdir": {
      const ops = opts.letters.includes("p")
        ? opts.operands.flatMap((p) => {
            const parts = p.replace(/\/+$/, "").split("/");
            return parts.map((_, k) => parts.slice(0, parts.length - k).join("/")).filter(Boolean);
          })
        : opts.operands;
      if (ops.length) out.push(["rm", "-d", ...ops]);
      break;
    }
    case "unlink":
      if (opts.operands.length) out.push(["rm", ...opts.operands]);
      break;
    case "shred":
      if (opts.letters.includes("u") || opts.other.some((w) => w.startsWith("--remove"))) {
        out.push(["rm", "-f", ...opts.operands]);
      }
      break;
    case "mv": {
      const dir = targetDir(opts);
      const srcs = dir ? opts.operands : opts.operands.slice(0, -1);
      if (srcs.length) out.push(["rm", ...srcs]);
      copies(opts);
      break;
    }
    case "install":
      if (!opts.letters.includes("d")) copies(opts);
      break;
    case "ln":
    case "rsync":
      copies(opts);
      break;
    case "dd": {
      const src = rest.find((w) => w.startsWith("if="))?.slice(3);
      const dst = rest.find((w) => w.startsWith("of="))?.slice(3) ?? outputFile(redirects);
      if (src && dst) out.push(["cp", src, dst]);
      break;
    }
    case "cat": {
      const srcs = rest.filter((w) => !w.startsWith("-") || w === "-").filter((w) => w !== "-");
      const input = inputFile(redirects);
      if (input) srcs.push(input);
      const dst = outputFile(redirects);
      if (srcs.length && dst) out.push(["cp", ...srcs, dst]);
      break;
    }
    case "tee": {
      const input = inputFile(redirects);
      const fed =
        pipedFrom && programName(pipedFrom[0]) === "cat"
          ? pipedFrom.slice(1).filter((w) => !w.startsWith("-"))
          : [];
      const srcs = input ? [input] : fed;
      const dsts = rest.filter((w) => !w.startsWith("-"));
      if (srcs.length) for (const d of dsts) out.push(["cp", ...srcs, d]);
      break;
    }
  }
  return out;
}

/**
 * Every program a bash call runs, and every operation it is read as.
 *
 * Wrappers are followed into the command they run, shells into the script
 * they are handed, find into its -exec and -delete, xargs into its command.
 * Each program appears as itself (`via` says what ran it); equivalent
 * operations appear as `synthetic`.
 */
export function readShellCommand(command: string): ReadCommand {
  const parsed = parseShell(command);
  const invocations: ShellInvocation[] = [];
  const state = { truncated: parsed.truncated };
  for (const c of parsed.commands) {
    expand(c.words, c.redirects, c.via, c.pipedFrom?.words ?? null, 0, null, invocations, state);
  }
  return { invocations, truncated: state.truncated };
}

/**
 * @param from  null for a program that runs as written; for an equivalent
 *              spelling, the written command it was read from (which makes it
 *              synthetic, and everything read out of it too).
 */
function expand(
  words: string[],
  redirects: ShellRedirect[],
  via: string | null,
  pipedFrom: string[] | null,
  depth: number,
  from: string | null,
  out: ShellInvocation[],
  st: { truncated: boolean }
): void {
  let k = 0;
  while (k < words.length && (ASSIGNMENT.test(words[k]) || RESERVED.has(words[k]))) k++;
  const argv = words.slice(k);
  if (argv.length === 0) return;
  if (depth > MAX_DEPTH || out.length >= MAX_INVOCATIONS) {
    st.truncated = true;
    return;
  }
  out.push(from !== null ? { argv, redirects, via, synthetic: true, from } : { argv, redirects, via });
  const prog = programName(argv[0]);
  const again = (inner: string[], how: string, src = from, pipe = pipedFrom): void =>
    expand(inner, redirects, how, pipe, depth + 1, src, out, st);
  const script = (text: string, how: string): void => {
    if (depth + 1 > MAX_DEPTH) {
      st.truncated = true;
      return;
    }
    const inner = parseShell(text);
    if (inner.truncated) st.truncated = true;
    for (const c of inner.commands) {
      expand(c.words, c.redirects, how, c.pipedFrom?.words ?? null, depth + 1, from, out, st);
    }
  };
  const equivalent = (eq: string[], how: string | null): void => {
    out.push({ argv: eq, redirects: [], via: how, synthetic: true, from: from ?? display(argv, redirects, pipedFrom) });
  };

  const wrapper = WRAPPERS[prog];
  if (wrapper) {
    const w = wrapped(argv, wrapper);
    if (w) {
      let inner = argv.slice(w.start);
      if (w.split !== undefined) {
        inner = [...(parseShell(w.split).commands[0]?.words ?? []), ...inner];
      }
      if (inner.length === 0 && wrapper.otherwise) inner = wrapper.otherwise;
      if (inner.length > 0) {
        again(inner, prog);
        // xargs appends what it reads. When a pipe feeds it `echo x`, that is
        // known, and `echo keep | xargs rm -d` removes `keep`.
        if (prog === "xargs") {
          const fed = echoed(pipedFrom);
          if (fed) {
            again([...inner, ...fed.split(/\s+/).filter(Boolean)], "xargs", from ?? display(argv, [], pipedFrom));
          }
        }
      }
    }
    return;
  }
  if (SHELLS.has(prog)) {
    const s = shellScript(argv, redirects, pipedFrom);
    if (s) script(s.text, s.via);
    return;
  }
  if (prog === "eval") {
    script(argv.slice(1).join(" "), "eval");
    return;
  }
  if (prog === "find") {
    const f = readFind(argv);
    const fills = findFills(f);
    for (const e of f.execs) {
      if (e.payload.length === 0) continue;
      const how = `find ${e.action}`;
      again(e.payload, how, from, null);
      if (e.payload.some((w) => w.includes("{}"))) {
        for (const fill of fills) {
          again(e.payload.map((w) => w.split("{}").join(fill)), how, from ?? joinWords(e.payload), null);
        }
      }
    }
    // find -delete walks its start points and deletes what matches, the
    // operation `rm -r -f` names. With name tests it deletes less than that,
    // and it is still read as a recursive delete: matching too much is the
    // safer error on a deny-list.
    if (f.deletes) {
      for (const target of [f.starts, ...fills.filter((x) => !f.starts.includes(x)).map((x) => [x])]) {
        equivalent(["rm", "-r", "-f", ...target], via);
      }
    }
    return;
  }
  for (const eq of equivalents(argv, redirects, pipedFrom)) equivalent(eq, via);
}

// ---------------------------------------------------------------------------
// Spellings
// ---------------------------------------------------------------------------

/** One word as a shell would need it written, for showing and matching. */
function shellWord(w: string): string {
  if (w === "") return "''";
  return /[\s;&|<>'"\\]/.test(w) ? "'" + w.split("'").join("'\\''") + "'" : w;
}

export function joinWords(words: string[]): string {
  return words.map(shellWord).join(" ");
}

/** `./keep/`, `keep/.` and `a/../keep` all name `keep`. Lexical only. */
function normalPath(w: string): string {
  if (!w.includes("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return w;
  const abs = w.startsWith("/");
  const parts: string[] = [];
  for (const p of w.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else if (p !== ".." || !abs) parts.push(p);
  }
  const joined = parts.join("/");
  return abs ? "/" + joined : joined || ".";
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/**
 * The spellings of one command a deny pattern is offered, besides the raw text.
 *
 *   - as written, quotes removed: `cp "sec"ret.txt b` is `cp secret.txt b`;
 *   - the program by name: `/bin/rm -rf x` is `rm -rf x`;
 *   - for the deletion, copy and git families, the options normalised: each
 *     long option read as its short letter (`--recursive` → `-r`), aliases
 *     resolved (`-R` → `-r` for rm and cp), clusters split and joined, in
 *     every order (up to four letters; beyond that, as written and sorted),
 *     and path operands normalised lexically (`./keep/` → `keep`).
 *
 * The direction is deliberate: long options are read as short letters, never
 * the reverse. The scaffold's own git rule denies `git branch --delete` and
 * allows `-d`, which are the same option; spelling every `-d` as `--delete`
 * would have refused the safe branch delete it exists to permit. So the rule
 * for writing a pattern is: write it against the short spelling (`rm -r`,
 * not `rm --recursive` or `rm -R`), and gnomon maps the others onto it.
 */
export function shellSpellings(inv: ShellInvocation): string[] {
  const out = new Set<string>();
  const argv = inv.argv;
  out.add(joinWords(argv));
  const prog = programName(argv[0]);
  let head = [prog];
  let rest = argv.slice(1);
  out.add(joinWords([prog, ...rest]));
  let spec = FLAG_SPECS[prog];
  if (prog === "git") {
    const sub = gitSubcommand(rest);
    if (sub) {
      head = ["git", sub[0]];
      rest = sub.slice(1);
      out.add(joinWords([...head, ...rest]));
      spec = GIT_SPECS[sub[0]];
    }
  }
  if (!spec) return [...out];

  const o = readOptions(rest, spec);
  const ops = o.operands.map(normalPath);
  const orders = o.letters.length <= 4 ? permutations(o.letters) : [o.letters, [...o.letters].sort()];
  const emit = (letters: string[]): void => {
    if (letters.length === 0) {
      out.add(joinWords([...head, ...o.other, ...ops]));
      return;
    }
    out.add(joinWords([...head, ...letters.map((c) => `-${c}`), ...o.other, ...ops]));
    out.add(joinWords([...head, `-${letters.join("")}`, ...o.other, ...ops]));
  };
  for (const order of orders) {
    emit(order);
    // git branch -d -f is -D: offer the one-letter spelling too.
    for (const [pair, one] of spec.compound ?? []) {
      if ([...pair].every((c) => order.includes(c))) {
        emit([one, ...order.filter((c) => !pair.includes(c))]);
      }
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Network egress
// ---------------------------------------------------------------------------

/** Programs whose purpose is a network connection. */
const NET_CLIENTS = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ssh", "sftp",
  "ftp", "lftp", "aria2c", "axel", "xh", "websocat", "grpcurl",
]);

/**
 * Arguments that make a client print about itself and connect to nothing.
 *
 * `curl --version` is allowed under `network = false`, and only when these
 * are ALL of its arguments: the set is closed and exact, so it cannot be
 * stretched (`curl -V http://x` is refused). Refusing a capability probe buys
 * nothing -- it connects to nothing -- and teaches the model that `which curl`
 * gets past a rule `curl --version` did not.
 */
const SELF_ONLY = new Set(["-V", "--version", "-h", "--help"]);

/** Copy tools that only leave the machine when an operand names a remote. */
const REMOTE_COPY = new Set(["scp", "rsync"]);

/** `host:path`, `user@host:path`, `host::module`, or a URL -- not `C:\x`. */
function isRemote(w: string): boolean {
  if (w.startsWith("-")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return true;
  return /^(?![A-Za-z]:[\\/])[^\s/:=]+:/.test(w);
}

/** Interpreter one-liners, and what in their code reaches the network. */
const CODE_EGRESS: Array<{ prog: RegExp; flags: string[]; code: RegExp }> = [
  {
    prog: /^(python[0-9.]*|pypy[0-9.]*)$/,
    flags: ["-c"],
    code: /\b(urllib[0-9]?|urlopen|requests|httpx|aiohttp|http\.client|socket|ftplib|smtplib|telnetlib|xmlrpc|websockets?|paramiko|pycurl)\b/,
  },
  {
    prog: /^(node|nodejs|bun)$/,
    flags: ["-e", "--eval", "-p", "--print"],
    code: /\bfetch\s*\(|\b(require|import)\s*\(\s*['"](node:)?(https?|http2|net|tls|dgram)['"]|\bfrom\s+['"](node:)?(https?|http2|net|tls|dgram)['"]|\b(undici|axios|WebSocket|XMLHttpRequest|EventSource)\b/,
  },
  {
    prog: /^perl$/,
    flags: ["-e", "-E"],
    code: /\b(LWP|HTTP::Tiny|IO::Socket|Net::\w+|Socket)\b|\bsocket\s*\(/,
  },
  {
    prog: /^ruby$/,
    flags: ["-e"],
    code: /net\/http|open-uri|\b(Net::HTTP|TCPSocket|UDPSocket|Socket|URI\.open|HTTParty|Faraday)\b|['"]socket['"]/,
  },
  {
    prog: /^php$/,
    flags: ["-r"],
    code: /\b(curl_\w+|fsockopen|stream_socket_client|socket_create)\b|\b(file_get_contents|fopen|readfile)\s*\(\s*['"](https?|ftp):/,
  },
];

/** The code an interpreter is handed in the command line itself. */
function inlineCode(argv: string[], flags: string[], redirects: ShellRedirect[]): string[] {
  const code: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i];
    for (const f of flags) {
      if (w === f && i + 1 < argv.length) code.push(argv[i + 1]);
      else if (f.startsWith("--") && w.startsWith(f + "=")) code.push(w.slice(f.length + 1));
      // A cluster ending in the flag: python -Ic '…', node -pe '…'.
      else if (!f.startsWith("--") && /^-[A-Za-z]+$/.test(w) && w.length > 2 && w.endsWith(f[1]) && i + 1 < argv.length) {
        code.push(argv[i + 1]);
      }
    }
  }
  // `python3 - <<'EOF'` and `python3 <<<'…'` read the program from stdin.
  for (const r of redirects) {
    if ((r.op === "<<" || r.op === "<<-") && r.body !== undefined) code.push(r.body);
    if (r.op === "<<<") code.push(r.target);
  }
  return code;
}

export interface NetworkEgress {
  /** The program that would reach the network, as gnomon read it. */
  command: string;
  /** Why it counts. */
  why: string;
}

/**
 * Does this bash call obviously reach the network?
 *
 * What `[sandbox] network = false` refuses in bash: a network client (curl,
 * wget, nc, ssh, …), scp or rsync to a remote, an interpreter one-liner whose
 * code opens a connection, and bash's /dev/tcp. Followed through wrappers,
 * `sh -c`, `$( )` and the rest, like the deny-list.
 *
 * An intent filter, and named as one. A script file, a build tool, a package
 * manager or `git fetch` reaches the network without any of this in its
 * command line, and nothing here pretends otherwise: they are not refused,
 * because refusing `npm install` and `git push` by name would make the default
 * surface unusable while still not being isolation. With `[sandbox] exec =
 * "docker"`, `network = false` runs the command with `--network none`, which
 * is.
 */
export function bashNetworkEgress(command: string): NetworkEgress | null {
  const { invocations } = readShellCommand(command);
  for (const inv of invocations) {
    if (inv.synthetic) continue;
    const argv = inv.argv;
    const prog = programName(argv[0]);
    const shown = describeInvocation(inv);
    const args = argv.slice(1);
    for (const w of [...argv, ...inv.redirects.map((r) => r.target)]) {
      if (/^\/dev\/(tcp|udp)\//.test(w)) return { command: shown, why: `${w} opens a network connection` };
    }
    if (NET_CLIENTS.has(prog)) {
      if (args.length > 0 && args.every((a) => SELF_ONLY.has(a))) continue;
      return { command: shown, why: `${prog} is a network client` };
    }
    if (REMOTE_COPY.has(prog)) {
      const remote = args.find(isRemote);
      if (remote) return { command: shown, why: `${prog} to a remote (${remote})` };
      continue;
    }
    for (const rule of CODE_EGRESS) {
      if (!rule.prog.test(prog)) continue;
      const hit = inlineCode(argv, rule.flags, inv.redirects).find((c) => rule.code.test(c));
      if (hit !== undefined) {
        const m = rule.code.exec(hit);
        const what = m ? m[0].replace(/[\s(]+$/, "") : "network";
        return { command: shown, why: `${prog} code that opens a connection (${what})` };
      }
    }
  }
  return null;
}

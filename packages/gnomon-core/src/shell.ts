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

/**
 * One piece of a word: literal text, or an expansion as written.
 *
 * Kept beside the word because the word alone cannot say what the shell will
 * make of it. `rm${IFS}-rf${IFS}keep` is one word to a reader that keeps
 * expansions as written, and three words -- `rm -rf keep` -- to the shell,
 * because an unquoted expansion is split on IFS (INJ-2026-11, GV3: it passed
 * a deny-list that held 31 other spellings of the same `rm`). The parts are
 * what `respell` reads to offer the policy that second reading.
 */
export interface WordPart {
  /** Literal text with quotes removed, or the expansion exactly as written. */
  text: string;
  /** Inside quotes (or escaped): not split, not brace-expanded. */
  quoted: boolean;
  /** An expansion: `$x`, `${x}`, `$(…)`, a backtick substitution. */
  exp?: boolean;
  /** What a command substitution prints, when the line itself says: `$(echo rm)` is `rm`. */
  value?: string;
}

/** One redirection on a simple command. */
export interface ShellRedirect {
  /** The operator, without an fd prefix: > >> >| < << <<- <<< <> &> &>> >& <& */
  op: string;
  /** The target word, quotes removed. For `<<` it is the delimiter. */
  target: string;
  /** The target word's pieces (see WordPart). */
  parts?: WordPart[];
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
  /** Each word's pieces, index for index with `words`. */
  parts?: WordPart[][];
  /**
   * The shell environment it runs in (a key into ParsedShell.frames): a
   * subshell, a command substitution or a `{ … }` group each open one, so a
   * `cd` inside them can be scoped to them.
   */
  frame?: string;
  /** The operator before it: "" at the start of a list, else "&&", "||" or "|". */
  prev?: string;
  /** The operator after it: ";" (or a newline), "&&", "||", "|", "&", or "" at the end. */
  next?: string;
}

/**
 * Where commands run. `sub`: a subshell, a command substitution, another
 * shell -- a `cd` inside does not outlive it. `group`: `{ … }`, `if`, `while`,
 * `for`, `case`, a function body, `eval` -- the same shell, but whether (and
 * how often) its commands run is not known from the text, so what a `cd`
 * inside does to the commands after it is read both ways.
 */
export interface ShellFrame {
  parent: string | null;
  kind: "sub" | "group";
  /** The operator before the frame's position in its parent. */
  prev: string;
  /** A directory the frame starts in: `env -C dir …`. */
  chdir?: string;
}

export interface ParsedShell {
  commands: ShellCommand[];
  /**
   * Nesting went deeper than this reader follows, or the command held more
   * simple commands than it reads. What was not read was not checked, and the
   * policy treats that as a refusal rather than a pass.
   */
  truncated: boolean;
  /** Every frame a command names (see ShellCommand.frame). */
  frames?: Map<string, ShellFrame>;
}

/** Frame ids, shared by every parse that feeds one reading of a command. */
interface FrameTable {
  frames: Map<string, ShellFrame>;
  n: number;
}

function newFrame(t: FrameTable, parent: string | null, kind: ShellFrame["kind"], prev: string, chdir?: string): string {
  const id = `f${t.n++}`;
  t.frames.set(id, chdir === undefined ? { parent, kind, prev } : { parent, kind, prev, chdir });
  return id;
}

/** Words that open a compound command, at the start of one. */
const OPENERS = new Set(["{", "if", "while", "until", "for", "case", "select"]);
/** And the words that close one. */
const CLOSERS = new Set(["}", "fi", "done", "esac"]);

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
  /** The operator that ended the last command: the next one's `prev`. */
  private lastOp = "";
  /** The frames compound commands opened, innermost last. */
  private groups: string[] = [];

  constructor(
    private readonly src: string,
    start: number,
    private readonly depth: number,
    private readonly out: ParsedShell,
    private readonly via: string | null,
    private readonly table: FrameTable,
    private frame: string
  ) {
    this.pos = start;
    this.cur = this.fresh();
  }

  private fresh(): ShellCommand {
    return {
      words: [],
      redirects: [],
      pipedFrom: this.feeding,
      via: this.via,
      parts: [],
      frame: this.frame,
      prev: this.lastOp,
      next: "",
    };
  }

  /** A frame for text read from inside this command: a substitution, a subshell. */
  private child(kind: ShellFrame["kind"] = "sub"): string {
    return newFrame(this.table, this.frame, kind, this.lastOp);
  }

  /** Close the command being read. `op`: the operator that ended it. */
  private end(op: string): void {
    const c = this.cur;
    c.next = op;
    if (c.words.length > 0 || c.redirects.length > 0) {
      if (this.out.commands.length >= MAX_COMMANDS) this.out.truncated = true;
      else this.out.commands.push(c);
    }
    this.feeding = op === "|" && c.words.length > 0 ? c : null;
    if (op !== "") this.lastOp = op === ";" || op === "&" ? "" : op;
    this.cur = this.fresh();
  }

  /** Parse text that came from somewhere else -- a backtick body, a heredoc. */
  private nested(text: string, via: string): void {
    if (this.depth >= MAX_DEPTH) {
      this.out.truncated = true;
      return;
    }
    new Parser(text, 0, this.depth + 1, this.out, via, this.table, this.child()).parse(false);
  }

  /**
   * A word at the start of a command that opens or closes a compound one.
   * Words before it that are themselves reserved (`! {`, `then if`) do not
   * count as a command having started.
   */
  private compound(word: string, quoted: boolean): void {
    if (quoted || this.cur.words.some((w) => !RESERVED.has(w))) return;
    if (OPENERS.has(word)) {
      // A function body runs when the function is called, not here: a group,
      // whose effect on the commands after it is read both ways.
      this.groups.push(this.frame);
      this.frame = newFrame(this.table, this.frame, "group", this.lastOp);
      this.cur.frame = this.frame;
    } else if (CLOSERS.has(word) && this.groups.length > 0) {
      this.frame = this.groups.pop()!;
      this.cur.frame = this.frame;
    }
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
        this.end(";");
        this.pos++;
        this.readHeredocs();
        continue;
      }
      if (ch === ")") {
        this.end("");
        this.pos++;
        if (close) return;
        continue;
      }
      if (ch === "(") {
        this.end("");
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
        const sub = new Parser(s, this.pos + 1, this.depth + 1, this.out, this.via, this.table, this.child());
        sub.parse(true);
        this.pos = sub.pos;
        continue;
      }
      if (ch === ";") {
        this.end(";");
        this.pos += next === ";" ? 2 : 1;
        if (s[this.pos] === "&") this.pos++;
        continue;
      }
      if (ch === "&") {
        if (next === ">") {
          this.redirect();
          continue;
        }
        this.end(next === "&" ? "&&" : "&");
        this.pos += next === "&" ? 2 : 1;
        continue;
      }
      if (ch === "|") {
        if (next === "|") {
          this.end("||");
          this.pos += 2;
          continue;
        }
        this.end("|");
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
          const sub = new Parser(s, this.pos + 2, this.depth + 1, this.out, `${ch}(…)`, this.table, this.child());
          sub.parse(true);
          this.pos = sub.pos;
        }
        const text = s.slice(start, this.pos);
        this.cur.words.push(text);
        this.cur.parts!.push([{ text, quoted: false, exp: true }]);
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
      const w = this.word();
      this.compound(w.value, w.quoted);
      this.cur.words.push(w.value);
      this.cur.parts!.push(w.parts);
    }
    this.end("");
  }

  private redirect(): void {
    const s = this.src;
    const ops = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">>", ">|", ">&", "<", ">"];
    const op = ops.find((o) => s.startsWith(o, this.pos)) ?? ">";
    this.pos += op.length;
    while (s[this.pos] === " " || s[this.pos] === "\t") this.pos++;
    const w = this.word();
    const r: ShellRedirect = { op, target: w.value, parts: w.parts };
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
        const p = new Parser(text, i + 2, this.depth + 1, this.out, "$(…)", this.table, this.child());
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

  /**
   * One word, quotes removed. `quoted`: some part of it was quoted or escaped.
   * `parts`: the same word as literal pieces and expansions (see WordPart).
   */
  private word(): { value: string; quoted: boolean; parts: WordPart[] } {
    const s = this.src;
    let v = "";
    let quoted = false;
    const parts: WordPart[] = [];
    while (this.pos < s.length) {
      const ch = s[this.pos];
      const next = s[this.pos + 1];
      if (WORD_END.includes(ch)) break;
      if (ch === "\\") {
        if (next !== "\n") {
          v += next ?? "";
          literal(parts, next ?? "", true);
        }
        this.pos += 2;
        quoted = true;
        continue;
      }
      if (ch === "'") {
        // Single quotes are literal to the very next quote; no escape ends them.
        const end = s.indexOf("'", this.pos + 1);
        const e = end < 0 ? s.length : end;
        const text = s.slice(this.pos + 1, e);
        v += text;
        literal(parts, text, true, true);
        this.pos = e + 1;
        quoted = true;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        v += this.doubleQuoted(parts);
        quoted = true;
        continue;
      }
      if (ch === "$" && next === "'") {
        this.pos += 2;
        const text = this.ansiC();
        v += text;
        literal(parts, text, true, true);
        quoted = true;
        continue;
      }
      if (ch === "$" && next === '"') {
        this.pos += 2;
        v += this.doubleQuoted(parts);
        quoted = true;
        continue;
      }
      if (ch === "$" || ch === "`") {
        const e = this.expansion();
        v += e.raw;
        if (e.raw === "$") literal(parts, "$", false);
        else parts.push({ text: e.raw, quoted: false, exp: true, ...(e.value !== undefined ? { value: e.value } : {}) });
        continue;
      }
      v += ch;
      literal(parts, ch, false);
      this.pos++;
    }
    return { value: v, quoted, parts };
  }

  /** The inside of "…", from just after the opening quote. */
  private doubleQuoted(parts: WordPart[]): string {
    const s = this.src;
    let v = "";
    // An empty "" is still a word: `rm "" x` passes rm an empty argument.
    literal(parts, "", true, true);
    while (this.pos < s.length && s[this.pos] !== '"') {
      const ch = s[this.pos];
      const next = s[this.pos + 1];
      // Inside double quotes a backslash escapes only these; elsewhere it is kept.
      if (ch === "\\" && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== "\n") {
          v += next;
          literal(parts, next, true);
        }
        this.pos += 2;
        continue;
      }
      // Double quotes still expand, so a substitution inside them is real.
      if (ch === "$" || ch === "`") {
        const e = this.expansion();
        v += e.raw;
        if (e.raw === "$") literal(parts, "$", true);
        else parts.push({ text: e.raw, quoted: true, exp: true, ...(e.value !== undefined ? { value: e.value } : {}) });
        continue;
      }
      v += ch;
      literal(parts, ch, true);
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
   * runs is run, whatever the outer command does with its output. When that
   * command only prints something the line itself spells out (`$(echo rm)`,
   * `$(which curl)`), `value` is what it prints.
   */
  private expansion(): { raw: string; value?: string } {
    const s = this.src;
    const start = this.pos;
    const next = s[this.pos + 1];
    if (s[this.pos] === "`") {
      const end = closingBacktick(s, this.pos + 1);
      const n0 = this.out.commands.length;
      this.nested(s.slice(this.pos + 1, end).replace(/\\([`\\$])/g, "$1"), "`…`");
      this.pos = Math.min(end + 1, s.length);
      return { raw: s.slice(start, this.pos), value: printedBy(this.out.commands.slice(n0)) };
    }
    if (next === "(" && s[this.pos + 2] === "(") {
      this.pos = skipParens(s, this.pos + 1);
      return { raw: s.slice(start, this.pos) };
    }
    if (next === "(") {
      const n0 = this.out.commands.length;
      if (this.depth >= MAX_DEPTH) {
        this.out.truncated = true;
        this.pos = skipParens(s, this.pos + 1);
      } else {
        const p = new Parser(s, this.pos + 2, this.depth + 1, this.out, "$(…)", this.table, this.child());
        p.parse(true);
        this.pos = p.pos;
      }
      return { raw: s.slice(start, this.pos), value: printedBy(this.out.commands.slice(n0)) };
    }
    if (next === "{") {
      const end = skipBraces(s, this.pos + 1);
      this.expansionsIn(s.slice(this.pos + 2, end - 1));
      this.pos = end;
      return { raw: s.slice(start, this.pos) };
    }
    // $name, $1, $@ and the other special parameters: the whole expansion,
    // so `$IFS` is one piece and not `$` followed by the letters IFS.
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(s.slice(this.pos, this.pos + 256));
    if (m) {
      this.pos += m[0].length;
      return { raw: m[0] };
    }
    this.pos++;
    return { raw: "$" };
  }
}

/** Append literal text to a word's parts, merging with a literal piece of the same quoting. */
function literal(parts: WordPart[], text: string, quoted: boolean, force = false): void {
  const last = parts[parts.length - 1];
  if (last && !last.exp && last.quoted === quoted) {
    last.text += text;
    return;
  }
  if (text || force) parts.push({ text, quoted });
}

/**
 * What a command substitution prints, when that is spelled out in the line:
 * `$(echo rm)` and `` `printf rm` `` print `rm`; `$(which curl)`,
 * `$(command -v curl)` and `$(type -P curl)` print where curl is, which names
 * the program curl. Anything else -- a pipe, a redirection, a second command,
 * an expansion in the words -- is not known until it runs.
 */
function printedBy(cmds: ShellCommand[]): string | undefined {
  if (cmds.length !== 1) return undefined;
  const c = cmds[0]!;
  if (c.redirects.length > 0 || c.pipedFrom || c.words.some((w) => /[$`]/.test(w))) return undefined;
  const [prog, ...args] = c.words;
  if (prog === "echo") return args.filter((w) => !/^-[neE]+$/.test(w)).join(" ");
  if (prog === "printf" && args.length > 0 && !/[%\\]/.test(args[0]!)) return args.join("");
  if (prog === "which" && args.length === 1) return args[0];
  if ((prog === "command" && args[0] === "-v") || (prog === "type" && /^-[pP]$/.test(args[0] ?? ""))) {
    return args.length === 2 ? args[1] : undefined;
  }
  return undefined;
}

/**
 * Split a command line into simple commands, the way /bin/sh would.
 *
 * Covers what an agent's bash call actually contains: quoting (single, double,
 * backslash, $'…'), the separators, pipelines, subshells, redirections,
 * here-documents, comments, and command substitution in every form, each
 * parsed as a command of its own. It does not expand globs, braces or
 * variables in `words` -- a word is kept as written -- but it keeps each
 * word's pieces (`parts`), from which `readShellCommand` offers the policy a
 * second, expanded reading where the line itself says what an expansion is.
 */
export function parseShell(command: string): ParsedShell {
  const table: FrameTable = { frames: new Map(), n: 0 };
  return parseIn(command, table, newFrame(table, null, "sub", ""), null);
}

/** Parse into an existing frame table: text another command runs (sh -c, eval). */
function parseIn(command: string, table: FrameTable, frame: string, via: string | null): ParsedShell {
  const out: ParsedShell = { commands: [], truncated: false, frames: table.frames };
  new Parser(command, 0, 0, out, via, table, frame).parse(false);
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
  /**
   * Read from the command's second, expanded reading (`rm${IFS}-rf keep` as
   * `rm -rf keep`; see readShellCommand), not as written. A program that runs:
   * offered to every rule, like one read as written.
   */
  respelled?: boolean;
  /** For a respelled one: the command as written. */
  written?: string;
  /** The frame it runs in (ReadCommand.frames) and the list operators around it. */
  frame?: string;
  prev?: string;
  next?: string;
  /** Which command of the line it was read from: both readings of a command share it. */
  site?: number;
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
  return inv.from ?? inv.written ?? display(inv.argv, inv.redirects, null);
}

export interface ReadCommand {
  invocations: ShellInvocation[];
  truncated: boolean;
  /** The frames the invocations name (see ShellFrame). */
  frames: Map<string, ShellFrame>;
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
 * a here-document or here-string on its stdin, or `echo '…' | sh` (also
 * through `base64 -d`, when what is decoded is a literal in the line). A
 * script FILE is not read -- its contents are not in the call. `args`: the
 * words after `-c '…'`, which the script sees as $0, $1, ….
 */
function shellScript(
  argv: string[],
  redirects: ShellRedirect[],
  pipe: ShellCommand | null,
  env?: ShellEnv
): { text: string; via: string; arg0?: string; args?: string[] } | null {
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
  if (cmode) {
    return i < argv.length ? { text: argv[i], via: `${prog} -c`, arg0: argv[i + 1], args: argv.slice(i + 2) } : null;
  }
  if (i < argv.length && !stdin) return null;
  const doc = redirects.find((r) => (r.op === "<<" || r.op === "<<-") && r.body !== undefined);
  if (doc) return { text: doc.body as string, via: `${prog} <<` };
  const here = redirects.find((r) => r.op === "<<<");
  if (here) return { text: here.target, via: `${prog} <<<` };
  const fed = fedText(pipe, env);
  if (fed !== null) return { text: fed, via: `… | ${prog}` };
  return null;
}

/** What `echo …` or `printf …` writes, when that is all a pipe feeds. */
function echoed(words: string[] | null): string | null {
  if (!words || words.length === 0) return null;
  const prog = programName(words[0]);
  if (prog !== "echo" && prog !== "printf") return null;
  // `printf %s X` prints X.
  if (prog === "printf" && /^%s(\\n)?$/.test(words[1] ?? "")) return words.slice(2).join("");
  return words.slice(1).filter((w) => !/^-[neE]+$/.test(w)).join(" ");
}

/**
 * What a pipe feeds, when the line spells it out: `echo …`, `printf …`, or
 * `base64 -d` of either (or of a here-string). INJ-2026-11's red-team sent
 * every refused spelling through `echo <base64> | base64 -d | sh`, and 89 of
 * 89 got past: the script was in the line, one decode away. Decoding a
 * literal is not running anything.
 */
function fedText(pipe: ShellCommand | null, env?: ShellEnv, hops = 0): string | null {
  if (!pipe || hops > 4) return null;
  // Each stage as written and, where the line says what its expansions are,
  // respelled: `p=echo; $p <base64> | base64 -d | sh` feeds what `echo` would.
  const alt = env ? respellCommand(pipe, env)?.words : undefined;
  for (const words of alt ? [pipe.words, alt] : [pipe.words]) {
    const e = echoed(words);
    if (e !== null) return e;
    const prog = programName(words[0] ?? "");
    const decode = words.slice(1).some((w) => w === "--decode" || /^-[A-Za-z]*[dD]/.test(w));
    if (prog !== "base64" || !decode) continue;
    const here = pipe.redirects.find((r) => r.op === "<<<");
    const src = here ? here.target : fedText(pipe.pipedFrom, env, hops + 1);
    if (src === null) continue;
    const b64 = src.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]+=*$/.test(b64)) continue;
    const text = Buffer.from(b64, "base64").toString("utf-8");
    // Text that does not survive the round trip was not text a shell would run.
    if (!text.includes("\uFFFD")) return text;
  }
  return null;
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
 *
 * Each command is read twice when its words hold an expansion the line itself
 * resolves: once as written, and once `respelled` -- `${IFS}` and `$IFS` as the
 * word separators they are, `$1`/`$@` as the empty strings they are in a bash
 * call, a variable assigned a literal earlier in the line as that literal
 * (`c=cu; d=rl; $c$d …` is `curl …`), `$(echo rm)` as `rm`, and an unquoted
 * `{rm,-rf,keep}` brace list as its words. The second reading only ever ADDS
 * invocations, so every rule that refused the command as written still does.
 */
export function readShellCommand(command: string): ReadCommand {
  const table: FrameTable = { frames: new Map(), n: 0 };
  const top = newFrame(table, null, "sub", "");
  const parsed = parseIn(command, table, top, null);
  const invocations: ShellInvocation[] = [];
  const st: ReadState = { truncated: parsed.truncated, table, sites: 0 };
  readCommands(parsed.commands, newEnv(), 0, null, null, null, invocations, st);
  return { invocations, truncated: st.truncated, frames: table.frames };
}

interface ReadState {
  truncated: boolean;
  table: FrameTable;
  sites: number;
}

/** Where an invocation sits: its frame and the list operators around it. */
interface Place {
  frame: string;
  prev: string;
  next: string;
  site: number;
}

/**
 * What the line itself says about its variables, read in order. Only literal
 * values are kept; a value computed at run time is forgotten, never guessed.
 */
interface ShellEnv {
  vars: Map<string, string>;
  /** $0, when known (a `sh -c '…' name` script). */
  arg0: string | null;
  /** $1, $2, …: none in a bash tool call, the words after `sh -c '…' name`. */
  args: string[];
}

function newEnv(): ShellEnv {
  return { vars: new Map(), arg0: null, args: [] };
}

function readCommands(
  cmds: ShellCommand[],
  env: ShellEnv,
  depth: number,
  from: string | null,
  written: string | null,
  viaOverride: string | null,
  out: ShellInvocation[],
  st: ReadState
): void {
  for (const c of cmds) {
    const place: Place = { frame: c.frame ?? "", prev: c.prev ?? "", next: c.next ?? "", site: st.sites++ };
    const via = viaOverride ?? c.via;
    const pipe = c.pipedFrom;
    expand(c.words, c.redirects, via, pipe?.words ?? null, depth, from, out, st, place, env, pipe, written);
    const alt = respellCommand(c, env);
    if (alt) {
      expand(alt.words, alt.redirects, via, pipe?.words ?? null, depth, from, out, st, place, env, pipe,
        written ?? display(c.words, c.redirects, null));
    }
    updateEnv(c, env);
  }
}

/**
 * @param from     null for a program that runs as written; for an equivalent
 *                 spelling, the written command it was read from (which makes
 *                 it synthetic, and everything read out of it too).
 * @param written  null for a command read as written; for a respelled one,
 *                 the command as written (which makes it `respelled`).
 */
function expand(
  words: string[],
  redirects: ShellRedirect[],
  via: string | null,
  pipedFrom: string[] | null,
  depth: number,
  from: string | null,
  out: ShellInvocation[],
  st: ReadState,
  place: Place,
  env: ShellEnv,
  pipe: ShellCommand | null,
  written: string | null
): void {
  let k = 0;
  while (k < words.length && (ASSIGNMENT.test(words[k]) || RESERVED.has(words[k]))) k++;
  let argv = words.slice(k);
  if (argv.length === 0) {
    // `> file`, `{ …; } > file` and `X=1 > file` write `file` with no program
    // in sight: read as the no-op `:` that carries the redirection, so a rule
    // over redirections sees it. Nothing else is invented.
    if (!redirects.some((r) => r.op !== "<<" && r.op !== "<<-" && r.op !== "<<<")) return;
    argv = [":"];
  }
  if (depth > MAX_DEPTH || out.length >= MAX_INVOCATIONS) {
    st.truncated = true;
    return;
  }
  const meta = { frame: place.frame, prev: place.prev, next: place.next, site: place.site };
  const inv: ShellInvocation = { argv, redirects, via, ...meta };
  if (from !== null) Object.assign(inv, { synthetic: true, from });
  if (written !== null) Object.assign(inv, { respelled: true, written });
  out.push(inv);
  const prog = programName(argv[0]);
  const again = (inner: string[], how: string, src = from, pipeWords = pipedFrom, at = place, p = pipe): void =>
    expand(inner, redirects, how, pipeWords, depth + 1, src, out, st, at, env, p, written);
  const script = (text: string, how: string, kind: ShellFrame["kind"], args?: { arg0?: string; args?: string[] }): void => {
    if (depth + 1 > MAX_DEPTH) {
      st.truncated = true;
      return;
    }
    const inner = parseIn(text, st.table, newFrame(st.table, place.frame, kind, place.prev), null);
    if (inner.truncated) st.truncated = true;
    // Another shell starts with the exported environment only; this reading
    // keeps every variable it knows, which can only add readings.
    const e = kind === "sub"
      ? { vars: new Map(env.vars), arg0: args?.arg0 ?? null, args: args?.args ?? [] }
      : env;
    readCommands(inner.commands, e, depth + 1, from, written, how, out, st);
  };
  const equivalent = (eq: string[], how: string | null): void => {
    out.push({ argv: eq, redirects: [], via: how, synthetic: true, from: from ?? display(argv, redirects, pipedFrom), ...meta });
  };
  /** A program that is not a builtin runs in a process of its own: a `cd` in it is not the shell's. */
  const own = (chdir?: string): Place => ({
    frame: newFrame(st.table, place.frame, "sub", place.prev, chdir),
    prev: "",
    next: "",
    site: place.site,
  });

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
        // `command cd x`, `builtin cd x` and `time cd x` run in this shell;
        // the rest start a process, and `env -C dir` starts it in dir.
        const at = SAME_SHELL.has(prog) ? place : own(prog === "env" ? envChdir(argv, w.start) : undefined);
        again(inner, prog, from, pipedFrom, at);
        // xargs appends what it reads. When a pipe feeds it `echo x`, that is
        // known, and `echo keep | xargs rm -d` removes `keep`.
        if (prog === "xargs") {
          const fed = echoed(pipedFrom);
          if (fed) {
            again([...inner, ...fed.split(/\s+/).filter(Boolean)], "xargs", from ?? display(argv, [], pipedFrom), pipedFrom, at);
          }
        }
      }
    }
    return;
  }
  if (SHELLS.has(prog)) {
    const s = shellScript(argv, redirects, pipe, env);
    if (s) script(s.text, s.via, "sub", s);
    return;
  }
  if (prog === "eval") {
    script(argv.slice(1).join(" "), "eval", "group");
    return;
  }
  if (prog === "find") {
    const f = readFind(argv);
    const fills = findFills(f);
    for (const e of f.execs) {
      if (e.payload.length === 0) continue;
      const how = `find ${e.action}`;
      const at = own();
      again(e.payload, how, from, null, at, null);
      if (e.payload.some((w) => w.includes("{}"))) {
        for (const fill of fills) {
          again(e.payload.map((w) => w.split("{}").join(fill)), how, from ?? joinWords(e.payload), null, at, null);
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

/** Wrappers that run their command in this shell, so a `cd` they run is this shell's. */
const SAME_SHELL = new Set(["command", "builtin", "time"]);

/** `env -C dir …` / `env --chdir=dir …`: the directory the command starts in. */
function envChdir(argv: string[], start: number): string | undefined {
  for (let i = 1; i < start; i++) {
    const w = argv[i]!;
    if (w === "-C" || w === "--chdir") return argv[i + 1];
    if (w.startsWith("--chdir=")) return w.slice(8);
    if (/^-[A-Za-z]*C./.test(w) && !w.startsWith("--")) return w.slice(w.indexOf("C") + 1);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Respelling: what an expansion is, when the line itself says
// ---------------------------------------------------------------------------

const DEFAULT_IFS = " \t\n";

/** An expansion's value: a string, the IFS separator itself, or unknown (null). */
type Resolved = { value: string } | { ifs: true } | null;

/** The value of one expansion piece, as far as the line says. */
function resolveExp(p: WordPart, env: ShellEnv): Resolved {
  if (p.value !== undefined) return { value: p.value };
  const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-]))$/s.exec(p.text);
  if (!m) return null;
  const name = (m[1] ?? m[3])!;
  const op = m[2] ?? "";
  const ifs = env.vars.get("IFS") ?? DEFAULT_IFS;
  if (name === "IFS" && (op === "" || /^(:?[-=?]|:[0-9]|::|[#%])/.test(op))) {
    // `${IFS}`, `$IFS`, `${IFS:0:1}`, `${IFS%?}`: whitespace the shell splits on.
    return p.quoted ? { value: ifs } : { ifs: true };
  }
  const plain = (): string | null => {
    if (/^[0-9]+$/.test(name)) {
      const n = Number(name);
      return n === 0 ? env.arg0 : env.args[n - 1] ?? "";
    }
    if (name === "@" || name === "*") return env.args.join(" ");
    if (name === "#") return String(env.args.length);
    if ("?$!-".includes(name)) return null;
    return env.vars.get(name) ?? null;
  };
  if (op === "") {
    const v = plain();
    return v === null ? null : { value: v };
  }
  // ${x:-word}, ${x-word}, ${x:=word}, ${x=word}: the default when x is not
  // known to be set. A variable set outside the line would win in the shell;
  // this second reading only adds what is checked, never removes.
  const d = /^(:?)([-=])(.*)$/s.exec(op);
  if (d) {
    const v = plain();
    const word = d[3]!.replace(/^(['"])(.*)\1$/s, "$2");
    if (v !== null && !(d[1] === ":" && v === "")) return { value: v };
    return /[$`]/.test(word) ? null : { value: word };
  }
  return null;
}

/**
 * The words one word becomes, as far as the line says: unquoted expansions
 * split on IFS, known values substituted, an unquoted brace list expanded.
 * An expansion whose value is not known stays as written. Null when nothing
 * changes.
 */
function respellWord(parts: WordPart[], env: ShellEnv, split: boolean): string[] | null {
  if (!parts.some((p) => p.exp)) {
    if (!split || parts.length !== 1 || parts[0]!.quoted) return null;
    const b = braceExpand(parts[0]!.text);
    return b.length === 1 && b[0] === parts[0]!.text ? null : b;
  }
  const ifs = env.vars.get("IFS") ?? DEFAULT_IFS;
  const fields: string[] = [];
  let cur = "";
  let started = false;
  let changed = false;
  const cut = () => {
    if (started) fields.push(cur);
    cur = "";
    started = false;
  };
  for (const p of parts) {
    if (!p.exp) {
      cur += p.text;
      if (p.text || p.quoted) started = true;
      continue;
    }
    const r = resolveExp(p, env);
    if (r === null) {
      cur += p.text;
      started = true;
      continue;
    }
    changed = true;
    if ("ifs" in r) {
      if (split) cut();
      else cur += " ";
      continue;
    }
    if (p.quoted || !split) {
      cur += r.value;
      started = true;
      continue;
    }
    for (const ch of r.value) {
      if (ifs.includes(ch)) cut();
      else {
        cur += ch;
        started = true;
      }
    }
  }
  cut();
  return changed ? fields : null;
}

/** `{a,b}c` → `ac bc`, bash's brace expansion of a comma list. Bounded. */
function braceExpand(text: string, budget = { n: 64 }): string[] {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" || text[i - 1] === "$") continue;
    let depth = 0;
    const commas: number[] = [];
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
      else if (c === "," && depth === 1) commas.push(j);
    }
    if (j >= text.length || commas.length === 0) continue;
    const head = text.slice(0, i);
    const tail = text.slice(j + 1);
    const cuts = [i, ...commas, j];
    const out: string[] = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
      for (const t of braceExpand(head + text.slice(cuts[k]! + 1, cuts[k + 1]) + tail, budget)) {
        if (budget.n-- <= 0) return out.length ? out : [text];
        if (t !== "") out.push(t);
      }
    }
    return out;
  }
  return [text];
}

/** A command's second reading, or null when it reads the same. */
function respellCommand(c: ShellCommand, env: ShellEnv): { words: string[]; redirects: ShellRedirect[] } | null {
  if (!c.parts || c.parts.length !== c.words.length) return null;
  let changed = false;
  const words: string[] = [];
  let leading = true;
  c.words.forEach((w, i) => {
    // Assignments before the program are not split.
    const assigning = leading && ASSIGNMENT.test(w);
    if (!assigning && !RESERVED.has(w)) leading = false;
    const r = respellWord(c.parts![i]!, env, !assigning);
    if (r === null) {
      words.push(w);
      return;
    }
    if (r.length !== 1 || r[0] !== w) changed = true;
    words.push(...r);
  });
  const redirects = c.redirects.map((r) => {
    if (!r.parts || r.op === "<<" || r.op === "<<-") return r;
    const v = respellWord(r.parts, env, false);
    if (v === null || v.length !== 1 || v[0] === r.target) return r;
    changed = true;
    return { ...r, target: v[0]! };
  });
  return changed ? { words, redirects } : null;
}

/** The value an assignment word sets, or null when it is not known. */
function assignedValue(parts: WordPart[], env: ShellEnv): string | null {
  // The NAME= prefix is the start of the first literal piece.
  const first = parts[0];
  if (!first || first.exp) return null;
  const eq = first.text.indexOf("=");
  if (eq < 0) return null;
  const rest: WordPart[] = [{ ...first, text: first.text.slice(eq + 1) }, ...parts.slice(1)];
  let v = "";
  for (const p of rest) {
    if (!p.exp) {
      v += p.text;
      continue;
    }
    const r = resolveExp(p, env);
    if (r === null) return null;
    v += "ifs" in r ? env.vars.get("IFS") ?? DEFAULT_IFS : r.value;
  }
  return v;
}

/** What a command does to the variables the line knows. */
function updateEnv(c: ShellCommand, env: ShellEnv): void {
  const words = c.words;
  const parts = c.parts ?? [];
  const assign = (i: number) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(words[i]!);
    if (!m) return;
    const v = parts[i] ? assignedValue(parts[i]!, env) : null;
    if (v === null) env.vars.delete(m[1]!);
    else env.vars.set(m[1]!, m[2] ? (env.vars.get(m[1]!) ?? "") + v : v);
  };
  if (words.length > 0 && words.every((w) => ASSIGNMENT.test(w))) {
    words.forEach((_, i) => assign(i));
    return;
  }
  const prog = words[0];
  const names = words.slice(1).filter((w) => !w.startsWith("-"));
  if (prog === "export" || prog === "declare" || prog === "typeset" || prog === "local" || prog === "readonly") {
    words.forEach((w, i) => {
      if (i > 0 && ASSIGNMENT.test(w)) assign(i);
    });
  } else if (prog === "unset" || prog === "read" || prog === "mapfile" || prog === "readarray") {
    for (const n of names) env.vars.delete(n);
  } else if (prog === "for" || prog === "select" || prog === "getopts") {
    env.vars.delete(prog === "getopts" ? names[1] ?? "" : words[1] ?? "");
  } else if (prog === "printf" && words[1] === "-v") {
    env.vars.delete(words[2] ?? "");
  } else if (prog === "set" && words[1] === "--") {
    env.args = words.slice(2);
  } else if (prog === "shift") {
    env.args = env.args.slice(Number(words[1] ?? 1) || 1);
  }
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

/**
 * Local-server requests are not egress.
 *
 * `curl http://localhost:3000/health` is how a developer -- and a model --
 * checks that the thing it just started is up. Refusing it under the default
 * `network = false` broke ordinary local work (and Terminal-Bench tasks such
 * as nginx-request-logging) while protecting nothing: the data does not leave
 * the machine. So curl and wget pass when EVERY operand is a URL or host whose
 * hostname is a literal loopback, and nothing in the call can send the request
 * elsewhere. What disqualifies it:
 *   - a proxy (`-x`, `--proxy*`, `--preproxy`, `--socks*`, or any word that says
 *     "proxy", which also catches `http_proxy=` and wget's `-e use_proxy=…`);
 *   - `--resolve` / `--connect-to`, which map localhost to another address;
 *   - a config or input file (`-K`, `--config`, `-e`, `--execute`, `-i`,
 *     `--input-file`, `-B`), whose contents are not on the command line;
 *   - any operand that is neither a loopback target nor the value of a flag
 *     known to take one -- so `curl http://localhost/ example.com` is refused.
 * Hostnames are compared literally after WHATWG URL parsing (no DNS, so
 * `127.0.0.1.nip.io` is not loopback, and `http://localhost@evil.com/` is
 * evil.com). Interpreter one-liners are not exempt: their targets cannot be
 * read reliably from the command line.
 */
const LOOPBACK_CLIENTS = new Set(["curl", "wget"]);
const LOOPBACK_DISQUALIFY = /^(-x|-K|-e|-i|-B|--(pre)?proxy.*|--socks.*|--noproxy|--resolve|--connect-to|--config|--execute|--input-file|--base)(=|$)/;
/** Flags whose next word is a value, not a target (curl and wget, the common ones). */
const VALUE_FLAGS = new Set([
  "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json",
  "-X", "--request", "-o", "--output", "-O", "--output-document", "-A", "--user-agent", "-U",
  "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "-u", "--user", "-F", "--form",
  "-b", "--cookie", "-c", "--cookie-jar", "-r", "--range", "-T", "--upload-file", "--retry",
  "--retry-delay", "--retry-max-time", "-t", "--tries", "--timeout", "--post-data", "--method",
  "--output-file", "-a", "--append-output", "--cacert", "--cert", "--key",
]);
/** Short flags that take a value, when they end a cluster (`-sSo out`, `-qO-`). */
const VALUE_SHORT = new Set(["H", "d", "X", "o", "O", "A", "U", "w", "m", "u", "F", "b", "c", "r", "T", "t", "a"]);

function loopbackHost(target: string): boolean {
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "[::1]" || /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host);
}

function onlyLoopback(args: string[]): boolean {
  let targets = 0;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (/proxy/i.test(w) || LOOPBACK_DISQUALIFY.test(w)) return false;
    if (w.startsWith("--")) {
      if (!w.includes("=") && VALUE_FLAGS.has(w)) i++;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(w)) {
      if (VALUE_FLAGS.has(w) || VALUE_SHORT.has(w[w.length - 1])) i++;
      continue;
    }
    if (/^-[A-Za-z]/.test(w)) continue; // `-qO-`, `-o/dev/null`: the value is attached
    if (!loopbackHost(w)) return false;
    targets++;
  }
  return targets > 0;
}

/** Copy tools that only leave the machine when an operand names a remote. */
const REMOTE_COPY = new Set(["scp", "rsync"]);

/** `host:path`, `user@host:path`, `host::module`, or a URL -- not `C:\x`. */
function isRemote(w: string): boolean {
  if (w.startsWith("-")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return true;
  return /^(?![A-Za-z]:[\\/])[^\s/:=]+:/.test(w);
}

/**
 * A remote a command names in its own words: a URL whose host is not a
 * literal loopback, `host:path` / `user@host:path` (scp's and git's ssh
 * syntax), or a git transport (`ext::…`, `fd::…`). `file://` and paths are
 * local. Loopback is exempt for the reason LOOPBACK_CLIENTS gives.
 */
function namedRemote(w: string): boolean {
  if (/^file:\/\//i.test(w)) return false;
  if (/^[a-z][a-z0-9+.-]*::/i.test(w)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return !loopbackHost(w);
  // scp-like: no slash before the first colon, not a Windows drive.
  if (/^(?![A-Za-z]:[\\/])[^\s/:=]+:/.test(w) && !w.startsWith("-")) {
    const host = w.slice(0, w.indexOf(":")).replace(/^[^@]*@/, "");
    return !loopbackHost(host);
  }
  return false;
}

/** A URL anywhere in a word that is not loopback or file:// (a `-c key=URL` value, `--repo=URL`). */
function urlIn(w: string): string | null {
  for (const m of w.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi)) {
    if (!/^file:/i.test(m[0]) && !loopbackHost(m[0])) return m[0];
  }
  return null;
}

/** git's commands that reach a remote, and which operand names it. */
const GIT_REMOTE_VERBS = new Set(["push", "fetch", "pull", "ls-remote", "clone", "archive", "submodule", "remote", "send-pack", "fetch-pack"]);

/**
 * A git command that names a remote under network = false. INJ-2026-11 sent
 * the repository to its canary with `git push http://…/r.git HEAD:refs/heads/x`
 * past `network = false`, which named only clients like curl. The remote is in
 * the line, so it is read: the repository operand of push, fetch, pull and
 * ls-remote, clone's source, `remote add|set-url`'s URL, `submodule add`'s,
 * `archive --remote`, `--repo=`, and a URL handed in by `-c`. A remote NAME
 * (`origin`) is not refused: it was configured before this call, and pushing
 * to it is what the scaffold's deny-list governs. Reaching it is the residual
 * the docs name; `exec = "docker"` removes the network itself.
 */
function gitEgress(argv: string[]): string | null {
  let i = 1;
  const injected: string[] = [];
  while (i < argv.length && argv[i]!.startsWith("-")) {
    if (argv[i] === "-c") injected.push(argv[i + 1] ?? "");
    else if (argv[i]!.startsWith("--config-env=")) injected.push(argv[i]!);
    i += GIT_GLOBAL_ARG.has(argv[i]!) ? 2 : 1;
  }
  const sub = argv[i];
  if (sub === undefined || !GIT_REMOTE_VERBS.has(sub)) {
    // `git config remote.x.url URL`, `url.URL.insteadOf …`: a remote set up
    // for the next command to reach.
    if (sub === "config") {
      const rest = argv.slice(i + 1).filter((a) => !a.startsWith("-"));
      const key = (rest[0] === "set" || rest[0] === "--add" ? rest[1] : rest[0]) ?? "";
      if (/^(remote\..+\.(url|pushurl)|url\..+\.(insteadof|pushinsteadof))$/i.test(key)) {
        const hit = rest.find((a) => namedRemote(a) || urlIn(a));
        if (hit) return `git config points a remote at ${hit}`;
      }
    }
    return null;
  }
  const hitC = injected.map(urlIn).find(Boolean);
  if (hitC) return `git -c hands git a remote (${hitC})`;
  const rest = argv.slice(i + 1);
  for (const a of rest) {
    const eq = /^--(repo|remote|upload-pack|receive-pack|exec)=(.*)$/s.exec(a);
    if (eq && (namedRemote(eq[2]!) || urlIn(eq[2]!))) return `git ${sub} to a remote (${eq[2]})`;
  }
  const ops = rest.filter((a) => !a.startsWith("-"));
  let named: string[];
  if (sub === "remote") named = ops[0] === "add" || ops[0] === "set-url" ? ops.slice(1) : [];
  else if (sub === "submodule") named = ops[0] === "add" ? ops.slice(1, 2) : [];
  else if (sub === "clone") named = ops;
  else if (sub === "archive") named = rest.flatMap((a, k) => (a === "--remote" ? [rest[k + 1] ?? ""] : []));
  else named = ops.slice(0, 1);
  const hit = named.find(namedRemote) ?? ops.map(urlIn).find(Boolean);
  return hit ? `git ${sub} to a remote (${hit})` : null;
}

/** Package managers whose flags or operands can name the registry or the package URL. */
const PACKAGE_MANAGERS = /^(npm|pnpm|yarn|bun|npx|pip[0-9.]*|pipx|uv)$/;

/**
 * A registry or package URL a package manager is handed in the line:
 * `npm view x --registry http://…`, `pip install -i https://…`, `npm install
 * https://…/x.tgz`. A plain `npm install` still reaches its configured
 * registry; that is not in the line, and not refused.
 */
function packageEgress(argv: string[]): string | null {
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k]!;
    const flag = /^--(registry|index-url|extra-index-url|find-links|index)(?:=(.*))?$/s.exec(a) ?? (/^-[if]$/.test(a) ? [a, a, undefined] : null);
    if (flag) {
      const v = flag[2] ?? argv[k + 1] ?? "";
      const url = urlIn(v) ?? (namedRemote(v) ? v : null);
      if (url) return `${flag[1]} ${url}`;
      continue;
    }
    if (!a.startsWith("-")) {
      const url = urlIn(a.replace(/^git\+/, ""));
      if (url) return `fetches ${url}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repository-defined code
// ---------------------------------------------------------------------------
//
// INJ-2026-11 planted its payload as package.json's `pretest`. The agent's
// call was `npm test`; the guard saw `npm test`, which every policy permits,
// and the payload ran: 0 of 40 blocked on every surface without a container.
// No per-call rule can see what a script in the repository does. What it can
// do is say that the call runs one, so the person asked can look -- and, when
// the surface opts in, always ask.

/** One call that runs code the repository defines, not the command line. */
export interface RepoCodeRun {
  /** The command as written. */
  command: string;
  /** The program that runs it: npm, make, pip, … */
  runner: string;
  /** What it runs, for the person asked: "package.json scripts", "the Makefile". */
  what: string;
  /** The npm-family script names it runs, in order, when that is known from the line. */
  scripts?: string[];
}

const NPM_INSTALL = new Set([
  "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add",
  "ci", "clean-install", "ic", "install-clean", "isntall-clean", "install-test", "it", "cit",
  "clean-install-test", "sit", "rebuild", "rb", "update", "up", "upgrade", "udpate", "link", "ln",
]);
const NPM_LIFECYCLE = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"];
/** pnpm and yarn commands that run nothing of the repository's. */
const PM_INERT = new Set([
  "audit", "bin", "cache", "config", "c", "env", "help", "info", "licenses", "list", "ls", "outdated",
  "owner", "root", "store", "team", "view", "v", "why", "whoami", "login", "logout", "search", "docs",
  "home", "repo", "bugs", "ping", "doctor", "explain", "find-dupes", "fund", "query", "sbom", "dist-tag",
  "access", "token", "profile", "org", "star", "stars", "unstar", "deprecate", "hook", "completion",
  "prefix", "get", "set", "pkg", "dlx", "create", "init", "remove", "rm", "uninstall", "un", "unlink",
]);

/** Programs that run repository-defined code whatever their arguments (but --version/--help). */
const RUNS_REPO: Record<string, string> = {
  make: "the Makefile", gmake: "the Makefile", bmake: "the Makefile", "mingw32-make": "the Makefile",
  just: "the justfile", rake: "the Rakefile", gradle: "the Gradle build", gradlew: "the Gradle build",
  mvn: "the Maven build (its plugins)", mvnw: "the Maven build (its plugins)", ant: "build.xml",
  tox: "tox.ini", nox: "noxfile.py", "pre-commit": ".pre-commit-config.yaml hooks",
};

/** cargo subcommands that compile, and so run build.rs and procedural macros. */
const CARGO_BUILDS = new Set(["build", "b", "test", "t", "run", "r", "check", "c", "bench", "clippy", "doc", "d", "install"]);

/**
 * The calls in a command that run repository-defined code (see RepoCodeRun).
 * Running a repository FILE by name (`python x.py`, `./x.sh`) is not listed:
 * the call names the code it runs. A test runner (`pytest`, `go test`) runs
 * the repository's tests, which the agent may have just written; it is not
 * listed either, and the docs say so.
 */
export function repoCodeRuns(command: string): RepoCodeRun[] {
  const out: RepoCodeRun[] = [];
  const seen = new Set<string>();
  const put = (inv: ShellInvocation, runner: string, what: string, scripts?: string[]) => {
    const c = describeInvocation(inv);
    if (seen.has(c + "\0" + runner)) return;
    seen.add(c + "\0" + runner);
    out.push({ command: c, runner, what, ...(scripts ? { scripts } : {}) });
  };
  for (const inv of readShellCommand(command).invocations) {
    if (inv.synthetic) continue;
    const argv = inv.argv;
    const prog = programName(argv[0] ?? "");
    const args = argv.slice(1);
    const ops = args.filter((a) => !a.startsWith("-"));
    if (args.length > 0 && args.every((a) => /^(-v|-V|--version|-h|--help)$/.test(a))) continue;
    if (prog === "npm") {
      const sub = ops[0];
      if (args.includes("--ignore-scripts") && sub !== "exec" && sub !== "x") continue;
      if (sub === "run" || sub === "run-script" || sub === "rum" || sub === "urn") {
        if (ops[1]) put(inv, "npm", "package.json scripts", [`pre${ops[1]}`, ops[1], `post${ops[1]}`]);
        continue;
      }
      if (sub === "test" || sub === "t" || sub === "tst" || sub === "start" || sub === "stop" || sub === "restart") {
        const name = sub === "t" || sub === "tst" ? "test" : sub;
        const names = name === "restart" ? ["prerestart", "prestop", "stop", "poststop", "prestart", "start", "poststart", "restart", "postrestart"] : [`pre${name}`, name, `post${name}`];
        put(inv, "npm", "package.json scripts", names);
        continue;
      }
      if (sub !== undefined && NPM_INSTALL.has(sub)) {
        put(inv, "npm", "package.json lifecycle scripts (and those of what it installs)", NPM_LIFECYCLE);
        continue;
      }
      if (sub === "exec" || sub === "x") put(inv, "npm", "a package binary from node_modules");
      else if (sub === "pack" || sub === "publish") put(inv, "npm", "package.json scripts", ["prepack", "prepare", "postpack"]);
      else if (sub === "version") put(inv, "npm", "package.json scripts", ["preversion", "version", "postversion"]);
      continue;
    }
    if (prog === "npx" || prog === "pnpx") {
      put(inv, prog, "a package binary (node_modules/.bin, or downloaded)");
      continue;
    }
    if (prog === "pnpm" || prog === "yarn" || prog === "bun") {
      const sub = ops[0];
      if (args.includes("--ignore-scripts")) continue;
      if (sub !== undefined && PM_INERT.has(sub)) continue;
      if (sub === undefined || NPM_INSTALL.has(sub)) {
        put(inv, prog, "package.json lifecycle scripts (and those of what it installs)", NPM_LIFECYCLE);
        continue;
      }
      if (sub === "run" || sub === "run-script") {
        if (ops[1]) put(inv, prog, "package.json scripts", [`pre${ops[1]}`, ops[1], `post${ops[1]}`]);
        continue;
      }
      if (sub === "exec" || sub === "x") {
        put(inv, prog, "a package binary from node_modules");
        continue;
      }
      // `pnpm test`, `yarn build`, `bun run`: a script of that name.
      const name = sub === "t" ? "test" : sub;
      put(inv, prog, "package.json scripts", [`pre${name}`, name, `post${name}`]);
      continue;
    }
    if (RUNS_REPO[prog]) {
      put(inv, prog, RUNS_REPO[prog]!);
      continue;
    }
    if (prog === "cargo" && ops[0] !== undefined && CARGO_BUILDS.has(ops[0])) {
      put(inv, "cargo", "build.rs and procedural macros");
      continue;
    }
    if (prog === "go" && ops[0] === "generate") {
      put(inv, "go", "//go:generate directives");
      continue;
    }
    if ((prog === "poetry" || prog === "pdm" || prog === "hatch" || prog === "pipenv") && /^(install|run|build|sync|shell)$/.test(ops[0] ?? "")) {
      put(inv, prog, "the project's build backend or scripts");
      continue;
    }
    // pip install -e ., pip install ./pkg, pip install -r requirements.txt: a
    // local project's setup.py or build backend (and what it lists).
    const pip = /^pip[0-9.]*$/.test(prog)
      ? args
      : /^python[0-9.]*$/.test(prog) && args[0] === "-m" && /^pip[0-9.]*$/.test(args[1] ?? "")
        ? args.slice(2)
        : prog === "uv" && args[0] === "pip"
          ? args.slice(1)
          : null;
    if (pip && pip[0] === "install") {
      const local =
        pip.some((a) => a === "-e" || a === "--editable" || a.startsWith("--editable=") || a === "-r" || a === "--requirement" || a.startsWith("--requirement=")) ||
        pip.slice(1).some((a) => !a.startsWith("-") && (/^(\.{1,2}|\.{0,2}\/.*|~\/.*)$/.test(a) || /\.(tar\.gz|tgz|zip)$/.test(a)));
      if (local) put(inv, "pip", "a local project's setup.py or build backend");
      continue;
    }
    if (/^python[0-9.]*$/.test(prog) && /(^|\/)setup\.py$/.test(args[0] ?? "")) put(inv, prog, "setup.py");
  }
  return out;
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
export function bashNetworkEgress(
  command: string,
  /**
   * `[sandbox] allow_package_index` (sweep_knobs.ts): hosts a package
   * download may name. Empty -- the default -- is the filter as it was.
   */
  packageIndex: readonly string[] = [],
  /** Filled with the listed hosts the line names in downloads it admitted. */
  admitted?: string[]
): NetworkEgress | null {
  const { invocations } = readShellCommand(command);
  for (const inv of invocations) {
    if (inv.synthetic) continue;
    const hit = invocationEgress(inv, command);
    if (!hit) continue;
    if (packageIndex.length > 0 && hit.admissible) {
      const hosts = packageDownloadHosts(inv.argv, packageIndex);
      if (hosts) {
        admitted?.push(...hosts);
        continue;
      }
    }
    return { command: hit.command, why: hit.why };
  }
  return null;
}

/**
 * One invocation's egress, as bashNetworkEgress has always read it.
 * `admissible`: a curl or wget, or a package manager naming a URL -- the only
 * shapes `allow_package_index` can admit. /dev/tcp, ssh, nc, scp, rsync, git
 * and interpreter one-liners never are.
 */
function invocationEgress(
  inv: ShellInvocation,
  command: string
): (NetworkEgress & { admissible: boolean }) | null {
  const argv = inv.argv;
  const prog = programName(argv[0]);
  const shown = describeInvocation(inv);
  const args = argv.slice(1);
  for (const w of [...argv, ...inv.redirects.map((r) => r.target)]) {
    if (/^\/dev\/(tcp|udp)\//.test(w)) return { command: shown, why: `${w} opens a network connection`, admissible: false };
  }
  if (NET_CLIENTS.has(prog)) {
    if (args.length > 0 && args.every((a) => SELF_ONLY.has(a))) return null;
    // The whole call, not just argv: the parser drops `http_proxy=…` prefixes, and any
    // proxy anywhere in the command can carry a loopback-looking request elsewhere.
    if (LOOPBACK_CLIENTS.has(prog) && !/proxy/i.test(command) && onlyLoopback(args)) return null;
    return { command: shown, why: `${prog} is a network client`, admissible: prog === "curl" || prog === "wget" };
  }
  if (REMOTE_COPY.has(prog)) {
    const remote = args.find(isRemote);
    if (remote) return { command: shown, why: `${prog} to a remote (${remote})`, admissible: false };
    return null;
  }
  if (prog === "git") {
    const g = gitEgress(argv);
    if (g) return { command: shown, why: g, admissible: false };
    return null;
  }
  if (PACKAGE_MANAGERS.test(prog)) {
    const p = packageEgress(argv);
    if (p) return { command: shown, why: `${prog} ${p}`, admissible: true };
  }
  for (const rule of CODE_EGRESS) {
    if (!rule.prog.test(prog)) continue;
    const hit = inlineCode(argv, rule.flags, inv.redirects).find((c) => rule.code.test(c));
    if (hit !== undefined) {
      const m = rule.code.exec(hit);
      const what = m ? m[0].replace(/[\s(]+$/, "") : "network";
      return { command: shown, why: `${prog} code that opens a connection (${what})`, admissible: false };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Environment dumps (the `secrets` family, CONTRACTS.md §37)
// ---------------------------------------------------------------------------

/**
 * `/proc/<pid>/environ`: a process's environment, credentials included. A
 * fixed path, protected whatever `[governance.paths] secrets` declares.
 */
export const ENV_DUMP_PATH = /^\/proc\/(self|thread-self|\d+)(\/task\/\d+)?\/environ$/;

/** What a command that prints the environment is, as gnomon read it. */
export interface EnvDump {
  command: string;
  why: string;
}

/**
 * Does this bash call print the environment, where the tokens and keys a
 * session runs with live? A fixed list, beside the network clients: `printenv`
 * (with or without names: `printenv GITHUB_TOKEN` is the leak), `env` running
 * no command, a bare `export` / `export -p`, `declare -x` / `-p` /
 * `typeset -x` naming nothing, a bare `set`, and any read of
 * `/proc/<pid>/environ` (ENV_DUMP_PATH, judged as a path by the caller).
 * Followed through wrappers, `sh -c` and `$( )` like the deny-list.
 *
 * An intent filter, like the network one: `echo $GITHUB_TOKEN`, a script, or
 * a program that prints its own environment is not refused by it.
 */
export function bashEnvDump(command: string): EnvDump | null {
  const { invocations } = readShellCommand(command);
  for (const inv of invocations) {
    if (inv.synthetic) continue;
    const argv = inv.argv;
    if (argv.length === 0) continue;
    const prog = programName(argv[0]!);
    const shown = describeInvocation(inv);
    const rest = argv.slice(1);
    if (prog === "printenv") return { command: shown, why: "printenv prints the environment" };
    if (prog === "env") {
      const w = wrapped(argv, WRAPPERS.env!);
      if (w && w.start >= argv.length && w.split === undefined) return { command: shown, why: "env with no command prints the environment" };
      continue;
    }
    const names = rest.filter((a) => !a.startsWith("-"));
    if (prog === "export" && names.length === 0 && rest.every((a) => a === "-p")) {
      return { command: shown, why: "export with no names prints the exported environment" };
    }
    if ((prog === "declare" || prog === "typeset") && names.length === 0 && rest.some((a) => /^-[a-zA-Z]*[xp]/.test(a))) {
      return { command: shown, why: `${prog} ${rest.join(" ")} prints the environment` };
    }
    if (prog === "set" && rest.length === 0) return { command: shown, why: "set with no arguments prints every variable" };
  }
  return null;
}

/** A word of a bash call that may name a file it reads or touches (shellPathWords). */
export interface PathWord {
  /** The path as written: `@`, `--opt=` and the like removed; `$HOME` kept as written. */
  word: string;
  /** The program it was given to, by name. */
  prog: string;
  /** The program walks a directory it is given (`grep -r`, `rg`, `tar`, `cp -r`, `find … -exec`). */
  recursive: boolean;
  /** The command, for a refusal. */
  command: string;
}

/** Programs that read nothing of a path they are given: its name, or its metadata. */
const NAMES_ONLY = new Set(["echo", "printf", "ls", "stat", "test", "[", "[[", "basename", "dirname", "realpath", "readlink", "true", "false", ":"]);

/** Programs whose first operand is a pattern or a script, not a file, unless -e / -f gives it. */
const PATTERN_FIRST: Record<string, { arg: string; given: RegExp }> = {
  grep: { arg: "ABCmefdD", given: /^(-[a-zA-Z]*[ef]|--(regexp|file)(=|$))/ },
  egrep: { arg: "ABCmefdD", given: /^(-[a-zA-Z]*[ef]|--(regexp|file)(=|$))/ },
  fgrep: { arg: "ABCmefdD", given: /^(-[a-zA-Z]*[ef]|--(regexp|file)(=|$))/ },
  rg: { arg: "ABCmefgtTjM", given: /^(-[a-zA-Z]*[ef]|--(regexp|file)(=|$))/ },
  ag: { arg: "ABCmG", given: /^$/ },
  ack: { arg: "ABCm", given: /^$/ },
  sed: { arg: "el", given: /^(-[a-zA-Z]*[ef]|--(expression|file)(=|$))/ },
  awk: { arg: "fvF", given: /^(-[a-zA-Z]*f|--file(=|$))/ },
  gawk: { arg: "fvF", given: /^(-[a-zA-Z]*f|--file(=|$))/ },
};

/** Does this program, with these words, walk the directories it is given? */
function walksDirs(prog: string, rest: string[]): boolean {
  if (prog === "rg" || prog === "ag" || prog === "ack" || prog === "tar" || prog === "rsync") return true;
  const short = (letters: RegExp) => rest.some((a) => /^-[a-zA-Z]+$/.test(a) && letters.test(a.slice(1)));
  if (prog === "grep" || prog === "egrep" || prog === "fgrep") return short(/[rR]/) || rest.some((a) => /^--(dereference-)?recursive$|^--directories=recurse$/.test(a));
  if (prog === "cp" || prog === "scp") return short(/[rRa]/) || rest.some((a) => a === "--recursive" || a === "--archive");
  if (prog === "zip") return short(/r/);
  if (prog === "find") return rest.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
  return false;
}

/**
 * The words of a bash call that may name a file it reads or touches: every
 * operand of every program it runs (through wrappers, `sh -c` and `$( )`),
 * and every redirection's target. What the `secrets` family judges a command
 * by (tools.ts secretWordRefusal): `cat ~/.aws/credentials`, `curl
 * --data-binary @.env`, `nc host < .env`, `grep -r key ~`.
 *
 * Words that name no file are left out: options (but the value of
 * `--opt=value`), URLs, the pattern or script a grep, sed or awk takes first,
 * and every operand of a program that reads only a name or metadata (`echo
 * .env >> .gitignore`, `ls ~/.ssh`, `test -f .env`).
 */
export function shellPathWords(command: string): PathWord[] {
  const out: PathWord[] = [];
  const seen = new Set<string>();
  const add = (w: PathWord) => {
    const key = `${w.prog}\0${w.word}\0${w.recursive}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  };
  const { invocations } = readShellCommand(command);
  for (const inv of invocations) {
    if (inv.synthetic || inv.argv.length === 0) continue;
    const prog = programName(inv.argv[0]!);
    const shown = describeInvocation(inv);
    for (const r of inv.redirects) {
      if (r.op === "<<" || r.op === "<<-" || r.op === "<<<" || r.op === ">&" || r.op === "<&") continue;
      if (r.target) add({ word: r.target, prog, recursive: false, command: shown });
    }
    if (NAMES_ONLY.has(prog) || WRAPPERS[prog]) continue;
    const rest = inv.argv.slice(1);
    const recursive = walksDirs(prog, rest);
    const pf = PATTERN_FIRST[prog];
    let skipPattern = pf !== undefined && !rest.some((a) => pf.given.test(a));
    let endOfOptions = false;
    for (let i = 0; i < rest.length; i++) {
      let w = rest[i]!;
      if (!endOfOptions && w === "--") {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && w.startsWith("-") && w.length > 1) {
        const eq = w.indexOf("=");
        if (w.startsWith("--") && eq > 0) {
          w = w.slice(eq + 1);
        } else {
          // A short cluster ending in a letter that takes a value: the next word is that value.
          if (pf && !w.startsWith("--") && pf.arg.includes(w[w.length - 1]!)) i++;
          continue;
        }
      } else if (skipPattern) {
        skipPattern = false;
        continue;
      }
      if (w.startsWith("@")) w = w.slice(1);
      if (!w || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) continue;
      add({ word: w, prog, recursive, command: shown });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Package downloads under `[sandbox] allow_package_index`
// ---------------------------------------------------------------------------
//
// The narrowest exception the intent filter can express. A line is admitted
// only when it is a download, in a shape read here option by option, and
// every URL it names is http(s) on a listed host with no port, no userinfo
// and nothing that could send the connection elsewhere (a proxy, curl's
// --connect-to or --resolve, a config file, wget's -e). Anything not read
// here is refused as before. It changes nothing under exec = "docker": the
// container's --network none is not an intent filter, and no host list can
// open it.

/** A URL whose host is listed: http(s), a bare host, no port or userinfo. */
function listedUrlHost(w: string, hosts: readonly string[]): string | null {
  const m = /^https?:\/\/([^/?#]*)(?:[/?#]\S*)?$/i.exec(w);
  if (!m || !/^[A-Za-z0-9.-]+$/.test(m[1]!)) return null;
  const host = m[1]!.toLowerCase();
  return hosts.includes(host) ? host : null;
}

interface ClientSpec {
  /** Whole arguments that take no value (wget's -nv is one argument, not -n -v). */
  flags: ReadonlySet<string>;
  /** Short options that take no value, clusterable. */
  shortNoValue: string;
  /** Short options whose value follows, attached or as the next argument. */
  shortValue: string;
  /** Long options whose value follows, after `=` or as the next argument. */
  longValue: ReadonlySet<string>;
}

/** Reading and writing a download: no upload, no proxy, no redirection of the connection. */
const CURL_SPEC: ClientSpec = {
  flags: new Set([
    "--silent", "--show-error", "--fail", "--fail-with-body", "--location", "--remote-name",
    "--remote-name-all", "--remote-header-name", "--progress-bar", "--compressed", "--disable",
    "--verbose", "--create-dirs", "--globoff", "--remote-time", "--no-progress-meter",
  ]),
  shortNoValue: "sSfLOJ#qvgR",
  shortValue: "om",
  longValue: new Set([
    "--output", "--output-dir", "--retry", "--retry-delay", "--retry-max-time", "--max-time",
    "--connect-timeout", "--max-filesize",
  ]),
};
const WGET_SPEC: ClientSpec = {
  flags: new Set([
    "-nv", "-nc", "-nd", "--quiet", "--no-verbose", "--continue", "--timestamping", "--no-clobber",
    "--show-progress", "--no-directories",
  ]),
  shortNoValue: "qcN",
  shortValue: "OPtT",
  longValue: new Set([
    "--output-document", "--directory-prefix", "--tries", "--timeout", "--progress", "--read-timeout",
    "--connect-timeout", "--wait",
  ]),
};

/** The listed hosts a curl or wget download names, or null when it is not one this reads as safe. */
function clientDownloadHosts(args: string[], spec: ClientSpec, hosts: readonly string[]): string[] | null {
  const named: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") {
      for (const rest of args.slice(k + 1)) {
        const h = listedUrlHost(rest, hosts);
        if (!h) return null;
        named.push(h);
      }
      break;
    }
    if (spec.flags.has(a)) continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (!spec.longValue.has(eq >= 0 ? a.slice(0, eq) : a)) return null;
      if (eq < 0) k++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let i = 1; i < a.length; i++) {
        const c = a[i]!;
        if (spec.shortNoValue.includes(c)) continue;
        if (!spec.shortValue.includes(c)) return null;
        if (i === a.length - 1) k++;
        break;
      }
      continue;
    }
    const h = listedUrlHost(a, hosts);
    if (!h) return null;
    named.push(h);
  }
  return named.length > 0 ? named : null;
}

/** Subcommands that download and install, or only read the index. Never publish. */
const PIP_DOWNLOADS = new Set(["install", "download", "wheel", "index"]);
const UV_PIP_DOWNLOADS = new Set(["install", "compile", "sync"]);
const UV_DOWNLOADS = new Set(["add", "sync", "lock"]);
const NPM_DOWNLOADS = new Set([
  "install", "i", "add", "ci", "clean-install", "update", "up", "upgrade", "view", "info", "show", "v", "pack", "fetch",
]);
/** Package-manager options whose value is a URL (or a name standing for one). */
const URL_OPTIONS = /^(?:--(?:registry|index-url|extra-index-url|find-links|index|default-index)|-[if])$/;

/**
 * The listed hosts a package download names, or null when the line is not
 * a download, or names any URL that is not http(s) on a listed host, or a
 * registry by name rather than by URL.
 */
function packageDownloadHosts(argv: string[], hosts: readonly string[]): string[] | null {
  const prog = programName(argv[0]);
  if (prog === "curl") return clientDownloadHosts(argv.slice(1), CURL_SPEC, hosts);
  if (prog === "wget") return clientDownloadHosts(argv.slice(1), WGET_SPEC, hosts);
  const args = argv.slice(1);
  const words: string[] = [];
  const named: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    const flag = /^(--?[A-Za-z][\w-]*)(?:=(.*))?$/s.exec(a);
    if (flag && URL_OPTIONS.test(flag[1]!)) {
      const v = flag[2] ?? args[++k] ?? "";
      const h = listedUrlHost(v, hosts);
      if (!h) return null;
      named.push(h);
      continue;
    }
    if (a.startsWith("-")) {
      if (/:\/\//.test(a)) return null;
      continue;
    }
    // Any URL in an operand, wherever it sits (`name@https://…` is npm's
    // alias form), must be the whole operand and on a listed host.
    if (/:\/\//.test(a)) {
      if (/^file:\/\//i.test(a)) continue;
      const h = listedUrlHost(a, hosts);
      if (!h) return null;
      named.push(h);
      continue;
    }
    words.push(a);
  }
  const [sub, sub2] = words;
  const ok = /^pip[0-9.]*$/.test(prog)
    ? PIP_DOWNLOADS.has(sub ?? "")
    : prog === "uv"
      ? sub === "pip" ? UV_PIP_DOWNLOADS.has(sub2 ?? "") : UV_DOWNLOADS.has(sub ?? "")
      : ["npm", "pnpm", "yarn", "bun"].includes(prog) && NPM_DOWNLOADS.has(sub ?? "");
  return ok && named.length > 0 ? named : null;
}

// ---------------------------------------------------------------------------
// Where a command writes
// ---------------------------------------------------------------------------
//
// write_allow bounded `write` and `edit` and nothing else, so a role allowed
// `src/**` rewrote CHANGELOG.md through the shell the moment its edit was
// refused. Measured by G1c (2026-11-01, opencode V2 under `gnomon guard`): two
// trials did it with `python3 - <<PY … Path("CHANGELOG.md").write_text(…)`,
// and one deleted an ignored database with `rm var/local.db && rmdir var`
// after `rm -rf var/` was refused.
//
// This reads the files a command names as its OUTPUT: redirections, and the
// operands of the programs whose job is to create, change or remove a file.
// Like the rest of this file it reads what is written, never what runs: a
// variable is not expanded, a glob is not matched, a script file is not
// opened, and code is read only for a literal path handed to a call that
// writes. What it finds is put to write_allow; what it cannot find is not
// claimed. Containment is `[sandbox] exec = "os"` or `"docker"`.

/** One file a command would create, change or remove. */
export interface WriteTarget {
  /** The path as written, quotes removed. */
  path: string;
  /** How it is written to, for the refusal: "> redirect", "rm", "python3 code". */
  how: string;
  /**
   * The directory a relative `path` is relative to, from the `cd`s before it:
   * "" for where the command starts, null when a `cd` made it unknowable. A
   * path whose directory is not certain is reported once per directory it may
   * be relative to (see CwdTracker), and once with null when one of them is
   * not known at all.
   */
  cwd: string | null;
  /**
   * A removal that reaches everything below `path`: `rm -r`, `find -delete`,
   * `mv` of a directory, `rsync --delete`, `shutil.rmtree`, `git clean`. A
   * caller guarding a directory refuses one aimed at an ANCESTOR of it too.
   */
  recursive?: boolean;
  /** find's name tests: the recursive removal deletes only what they match. */
  names?: string[];
  /** `git clean` / `git stash -u`: which untracked files it removes. */
  clean?: GitClean;
}

/** What a `git clean` (or `git stash --include-untracked`) removes. */
export interface GitClean {
  /** Untracked files git does not ignore (no -X). */
  untracked: boolean;
  /** Ignored files (-x or -X; `git stash --all`). */
  ignored: boolean;
  /** Without -d and with no pathspec, untracked directories are left alone. */
  dirs: boolean;
  /** `-e PATTERN`: kept, even under -x. */
  excludes: string[];
  /** Limited to these paths (relative to the target), or everything below it. */
  pathspecs: string[];
}

/** Where output goes that is not a file anyone keeps. */
const NOT_A_FILE = /^(\/dev\/(null|stdout|stderr|tty|zero|fd\/\d+)|-|&?\d+)$/;

/** Redirections that open their target for writing. */
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);

/**
 * For each program that changes files: which operands it writes, and which of
 * its short and long options take a value (so the value is not mistaken for
 * an operand). `all`: every operand; `last`: the destination; `-t DIR` /
 * `--target-directory` names it instead.
 */
interface WriterSpec {
  operands: "all" | "last" | "mv";
  arg: string;
  longArg?: string[];
}
const WRITERS: Record<string, WriterSpec> = {
  rm: { operands: "all", arg: "" },
  rmdir: { operands: "all", arg: "" },
  unlink: { operands: "all", arg: "" },
  shred: { operands: "all", arg: "nsx", longArg: ["iterations", "size", "random-source"] },
  truncate: { operands: "all", arg: "sr", longArg: ["size", "reference"] },
  touch: { operands: "all", arg: "drt", longArg: ["date", "reference", "time"] },
  mkdir: { operands: "all", arg: "m", longArg: ["mode", "context"] },
  tee: { operands: "all", arg: "", longArg: ["output-error"] },
  cp: { operands: "last", arg: "tS", longArg: ["target-directory", "suffix", "sparse", "reflink", "backup", "preserve", "no-preserve"] },
  install: { operands: "last", arg: "tSgmo", longArg: ["target-directory", "suffix", "group", "mode", "owner", "backup"] },
  ln: { operands: "last", arg: "tS", longArg: ["target-directory", "suffix", "backup"] },
  link: { operands: "last", arg: "" },
  mv: { operands: "mv", arg: "tS", longArg: ["target-directory", "suffix", "backup"] },
};

/** Operands of `argv` (options, and the values options take, removed), plus a `-t DIR`. */
function writerOperands(argv: string[], spec: { arg: string; longArg?: string[] }): { ops: string[]; target?: string } {
  const ops: string[] = [];
  let target: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === "--") {
      ops.push(...argv.slice(i + 1));
      break;
    }
    if (w.startsWith("--") && w.length > 2) {
      const [name, value] = w.slice(2).split(/=(.*)/s);
      if (name === "target-directory") target = value ?? argv[++i];
      else if (value === undefined && spec.longArg?.includes(name!)) i++;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        const c = w[j]!;
        if (spec.arg.includes(c)) {
          const value = j + 1 < w.length ? w.slice(j + 1) : argv[++i];
          if (c === "t") target = value;
          break;
        }
      }
      continue;
    }
    ops.push(w);
  }
  return { ops, target };
}

/** A string literal: group 1 the quote, group 2 its text. */
const LIT = String.raw`(['"\x60])((?:(?!\1)[^\\\n]|\\.)*)\1`;
const lit = (before: string, after = "") => new RegExp(before + LIT + after, "g");
/**
 * Calls that write the file their first literal argument names (python, node,
 * ruby, perl). Approximate on purpose: a path built at run time is not seen,
 * and that is said, not guessed.
 */
const CODE_WRITES_FIRST: RegExp[] = [
  lit(String.raw`\bopen\(\s*`, String.raw`\s*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+][^'"]*['"]`),
  lit(String.raw`\bPath\(\s*`, String.raw`\s*\)\s*\.\s*(?:write_text|write_bytes|unlink|touch|mkdir|rmdir|rename|replace|open\(\s*['"][wax])`),
  lit(String.raw`\bos\.(?:remove|unlink|rmdir|removedirs|truncate|mkdir|makedirs)\(\s*`),
  lit(String.raw`\bshutil\.rmtree\(\s*`),
  lit(String.raw`\b(?:writeFileSync|appendFileSync|rmSync|unlinkSync|rmdirSync|truncateSync|mkdirSync|writeFile|appendFile)\(\s*`),
  lit(String.raw`\bFile\.(?:write|delete|unlink)\(\s*`),
  lit(String.raw`\bFileUtils\.(?:rm|rm_f|rm_r|rm_rf|touch|mkdir_p)\(\s*`),
  lit(String.raw`\bopen\s*\(?\s*(?:my\s+)?\$\w+\s*,\s*['"](?:>|>>|\+<|\+>)['"]\s*,\s*`),
  lit(String.raw`\bunlink\s*\(?\s*`),
];
/** Two-argument calls: the second literal is written; a move also empties the first. */
const CODE_WRITES_SECOND = new RegExp(
  String.raw`\b(shutil\.(?:copy|copy2|copyfile|copytree|move)|os\.(?:rename|replace)|(?:renameSync|copyFileSync|cpSync|rename|copyFile)|FileUtils\.(?:mv|cp))\(\s*` +
    LIT.replaceAll("\\1", "\\2") + String.raw`\s*,\s*` + LIT.replaceAll("\\1", "\\4"),
  "g"
);

// A literal path bound to a name first and written through the name second:
// `changelog = Path("CHANGELOG.md")` ... `changelog.write_text(...)`. Both
// rewrites G1c's agents used under `gnomon guard` had that shape, and reading
// only `Path("…").write_text` missed them (GVC replay, 2026-11-02: 15 of 17
// causing calls refused, the 2 misses exactly these). One level of binding
// is followed: a name assigned a literal or a `Path(literal)` (python), a
// `const|let|var` literal (node), a `my $x =` literal (perl), a bare
// assignment (ruby). A name assigned anything else -- a call, a join, an
// f-string -- is a path built at run time and stays unjudged.
const BIND_PY_PATH = new RegExp(String.raw`(?:^|[\n;])[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*(?:pathlib\.)?Path\([ \t]*` + LIT.replaceAll("\\1", "\\2") + String.raw`[ \t]*\)[ \t]*(?=$|[\n;#])`, "g");
const BIND_LIT = new RegExp(String.raw`(?:^|[\n;{])[ \t]*(?:(?:const|let|var|my)[ \t]+)?(\$?[A-Za-z_]\w*)[ \t]*=[ \t]*` + LIT.replaceAll("\\1", "\\2") + String.raw`[ \t]*(?=$|[\n;#])`, "g");

/** `name → [literal, viaPath]` for every one-level binding in `code`. */
function literalBindings(code: string): Map<string, { path: string; viaPath: boolean }[]> {
  const out = new Map<string, { path: string; viaPath: boolean }[]>();
  const put = (name: string, path: string, viaPath: boolean) => {
    if (!path) return;
    const list = out.get(name) ?? [];
    if (!list.some((b) => b.path === path && b.viaPath === viaPath)) list.push({ path, viaPath });
    out.set(name, list);
  };
  for (const m of code.matchAll(BIND_PY_PATH)) put(m[1]!, m[3]!, true);
  for (const m of code.matchAll(BIND_LIT)) put(m[1]!, m[3]!, false);
  return out;
}

/**
 * `code` with each bound name replaced, outside string literals, by what it
 * was bound to: `Path("x")` before an attribute (`name.write_text`), the bare
 * literal elsewhere (`open(name, "w")`). Not after a `.` (an attribute of the
 * same name), and not where the name is being assigned. One rewrite per
 * binding a name has had, so a name bound twice is read both ways.
 */
function resolvedCode(code: string): string[] {
  const binds = literalBindings(code);
  if (binds.size === 0) return [];
  const rounds = Math.max(...[...binds.values()].map((l) => l.length));
  const parts = code.split(new RegExp(LIT, "g"));
  // split() with two groups interleaves [text, quote, body, text, quote, body, …].
  const variants: string[] = [];
  for (let k = 0; k < rounds; k++) {
    let outText = "";
    for (let i = 0; i < parts.length; i += 3) {
      let seg = parts[i] ?? "";
      for (const [name, list] of binds) {
        const b = list[Math.min(k, list.length - 1)]!;
        const q = JSON.stringify(b.path);
        const esc = name.replace(/\$/g, "\\$");
        seg = seg.replace(new RegExp(String.raw`(?<![\w.$])` + esc + String.raw`\b(?![ \t]*=[^=])`, "g"), (_m, off: number) => {
          const after = seg.slice(off + name.length);
          return /^[ \t]*\./.test(after) ? (b.viaPath ? `Path(${q})` : q) : q;
        });
      }
      outText += seg;
      if (i + 2 < parts.length) outText += parts[i + 1]! + parts[i + 2]! + parts[i + 1]!;
    }
    variants.push(outText);
  }
  return variants;
}

/**
 * Perl's two-argument `open F, ">>path"` (and `>`, `+<`, `+>`): the mode is
 * inside the literal, so CODE_WRITES_FIRST's three-argument form misses it.
 */
const PERL_OPEN2 = new RegExp(
  String.raw`\bopen\s*\(?\s*(?:my\s+)?[\$\w]+\s*,\s*(['"])\s*(\+?>{1,2}|\+<)\s*((?:(?!\1)[^\\\n]|\\.)+)\1`,
  "g"
);

/** The literal paths inline code writes, directly or through one name bound to a literal. */
export function codeWriteTargets(code: string): string[] {
  const out: string[] = [];
  const read = (text: string) => {
    for (const m of text.matchAll(PERL_OPEN2)) if (m[3] && !out.includes(m[3].trim())) out.push(m[3].trim());
    for (const re of CODE_WRITES_FIRST) for (const m of text.matchAll(re)) if (m[2] && !out.includes(m[2])) out.push(m[2]);
    for (const m of text.matchAll(CODE_WRITES_SECOND)) {
      if (m[5] && !out.includes(m[5])) out.push(m[5]);
      if (/move|rename|replace|mv/.test(m[1]!) && m[3] && !out.includes(m[3])) out.push(m[3]);
    }
  };
  read(code);
  for (const variant of resolvedCode(code)) read(variant);
  return out;
}

/**
 * Calls that remove a directory and everything below it: what they name is
 * reported `recursive`, so `shutil.rmtree(".")` is read as reaching the
 * records under `.` -- not only a literal record path.
 */
const CODE_RECURSIVE: RegExp[] = [
  lit(String.raw`\bshutil\.rmtree\(\s*`),
  lit(String.raw`\b(?:rmSync|rmdirSync|rm|rmdir)\(\s*`, String.raw`[^)]*\brecursive\s*:\s*true`),
  lit(String.raw`\bFileUtils\.(?:rm_r|rm_rf|remove_dir|remove_entry|remove_entry_secure)\(\s*`),
  lit(String.raw`\b(?:rmtree|remove_tree)\s*\(?\s*`),
];

/** The literal paths inline code removes recursively (see CODE_RECURSIVE). */
export function codeRecursiveDeletes(code: string): string[] {
  const out: string[] = [];
  const read = (text: string) => {
    for (const re of CODE_RECURSIVE) for (const m of text.matchAll(re)) if (m[2] !== undefined && !out.includes(m[2])) out.push(m[2]);
  };
  read(code);
  for (const variant of resolvedCode(code)) read(variant);
  return out;
}

/** The flags that hand each interpreter its program inline. */
const CODE_FLAGS: Record<string, string[]> = {
  python: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
};

/** `sed -i` / `perl -i`: the files edited in place, or null when the program does not edit in place. */
function inPlaceFiles(prog: string, argv: string[]): string[] | null {
  if (prog === "sed") {
    let inPlace = false;
    let scriptGiven = false;
    const ops: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const w = argv[i]!;
      if (w === "--in-place" || w.startsWith("--in-place=")) inPlace = true;
      else if (w === "-e" || w === "-f" || w === "--expression" || w === "--file") {
        scriptGiven = true;
        i++;
      } else if (w.startsWith("--expression=") || w.startsWith("--file=")) scriptGiven = true;
      else if (/^-[a-zA-Z]+/.test(w) && !w.startsWith("--")) {
        if (w.includes("i")) inPlace = true;
        if (/e|f/.test(w.slice(1).replace(/i.*$/, ""))) {
          scriptGiven = true;
          i++;
        }
      } else if (!w.startsWith("-")) ops.push(w);
    }
    if (!inPlace) return null;
    return scriptGiven ? ops : ops.slice(1);
  }
  if (prog === "perl") {
    let inPlace = false;
    let codeGiven = false;
    const ops: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const w = argv[i]!;
      if (/^-[a-zA-Z]+/.test(w)) {
        if (/^-[a-zA-Z]*i/.test(w)) inPlace = true;
        if (/e$/.test(w) || w === "-E") {
          codeGiven = true;
          i++;
        }
      } else ops.push(w);
    }
    if (!inPlace) return null;
    return codeGiven ? ops : ops.slice(1);
  }
  return null;
}

/** `print … > "file"` / `>> "file"` inside an awk program. */
const AWK_REDIRECT = /(?<![<>=!])>>?\s*"([^"]+)"/g;

/** The program text of an awk invocation: the first operand unless -f gives a file. */
function awkProgram(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === "-f" || w.startsWith("--file")) return null;
    if (w === "-v" || w === "-F") {
      i++;
      continue;
    }
    if (/^-[vF]./.test(w) || w === "--") continue;
    if (w.startsWith("-")) continue;
    return w;
  }
  return null;
}

/**
 * What a git subcommand writes, as far as its arguments say. Reviewed
 * 2026-11-03: `git checkout <ref> -- <path>`, `git restore`, `git clone`,
 * `git worktree add` and `git apply` all wrote a file the shell precheck could
 * not see. A patch's own paths are inside the patch, so `git apply` reports
 * the patch file and the caller reads it.
 *
 * `git clean` and `git stash --include-untracked | --all` remove untracked
 * files: INJ-2026-11 deleted gnomon's audit trail with `git clean -fdxq` on
 * every surface whose shell was not an allow-list, because the record rule saw
 * no target in the line. They are reported as a recursive removal of the
 * directory they start from (`git -C dir` included), with what they remove.
 */
function gitWrites(argv: string[]): Array<{ path: string; how: string; recursive?: boolean; clean?: GitClean }> {
  let i = 1;
  let at = "";
  while (i < argv.length && argv[i]!.startsWith("-")) {
    if (argv[i] === "-C" && argv[i + 1] !== undefined) at = at && !argv[i + 1]!.startsWith("/") ? `${at}/${argv[i + 1]}` : argv[i + 1]!;
    i += /^-(C|c)$/.test(argv[i]!) || argv[i] === "--git-dir" || argv[i] === "--work-tree" ? 2 : 1;
  }
  const under = (p: string) => (at && !p.startsWith("/") ? `${at}/${p}` : p);
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  const operands = rest.filter((a) => !a.startsWith("-"));
  const afterDashes = rest.includes("--") ? rest.slice(rest.indexOf("--") + 1) : null;
  const paths = (list: string[], how: string) => list.map((p) => ({ path: under(p), how }));
  switch (sub) {
    case "checkout":
      // `git checkout <ref> -- <paths>` and `git checkout -- <paths>` write
      // the paths; a bare branch switch rewrites the tree, which the record
      // dirs are not in (they are untracked).
      return paths(afterDashes ?? [], "git checkout --");
    case "restore":
      return paths(afterDashes ?? operands.filter((a) => !a.startsWith("--source")), "git restore");
    case "clone":
      return operands.length >= 2 ? paths([operands[operands.length - 1]!], "git clone") : [];
    case "worktree":
      return operands[0] === "add" && operands[1] ? paths([operands[1]], "git worktree add") : [];
    case "apply":
    case "am":
      return paths(operands, "git apply (patch)");
    case "rm": {
      // `git rm` removes the file and its index entry; `--cached` the entry
      // only, which the next commit records as a deletion -- the way the
      // GBS-LAYER pilot committed `.gnomon/` away (`git rm -r --cached .gnomon
      // && git commit`). Both are reported: a cached removal as a reach (it
      // writes no file), put to the surface / record / hooks rules and not to
      // write_allow.
      const cached = rest.includes("--cached");
      const recursive = rest.some((a) => /^-[a-zA-Z]*r/.test(a) && !a.startsWith("--"));
      const list = (afterDashes ?? operands).filter((a) => a !== "--" && !a.startsWith("--pathspec"));
      return list.map((p) => ({ path: under(p), how: cached ? "git rm --cached" : "git rm", recursive }));
    }
    case "mv": {
      // Like mv: the sources go (with everything below them), the last
      // operand is written.
      const list = operands;
      if (list.length < 2) return [];
      return [
        ...list.slice(0, -1).map((p) => ({ path: under(p), how: "git mv (source)", recursive: true })),
        { path: under(list[list.length - 1]!), how: "git mv" },
      ];
    }
    case "clean": {
      const c = gitCleanOf(rest);
      return c ? [{ path: at || ".", how: "git clean", recursive: true, clean: c }] : [];
    }
    case "stash": {
      // push (the default) and save take -u/--include-untracked and -a/--all.
      const verb = rest.find((a) => !a.startsWith("-"));
      if (verb !== undefined && verb !== "push" && verb !== "save") return [];
      const all = rest.some((a) => a === "--all" || (/^-[A-Za-z]+$/.test(a) && a.includes("a")));
      const untracked = all || rest.some((a) => a === "--include-untracked" || (/^-[A-Za-z]+$/.test(a) && a.includes("u")));
      if (!untracked) return [];
      return [{
        path: at || ".",
        how: "git stash --include-untracked",
        recursive: true,
        clean: { untracked: true, ignored: all, dirs: true, excludes: [], pathspecs: afterDashes ?? [] },
      }];
    }
    default:
      return [];
  }
}

/**
 * git configuration keys whose value git RUNS, later, as a program: a hook
 * directory, a pager or editor, an fsmonitor, a filter or diff driver, a
 * credential helper, an alias starting with `!`, an include of another config
 * file, a template directory new repositories copy hooks from. Set in a
 * repository's (or the user's) config, each runs on the operator's next
 * ordinary git command -- outside any call gnomon decides, and outside the
 * container under `exec = "docker"`, since the operator runs git on the host.
 * INJ-2026-11: `git config core.hooksPath .githooks` passed every surface,
 * write_allow included, because it names no file.
 */
const GIT_EXEC_KEYS: RegExp[] = [
  /^core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)$/,
  /^sequence\.editor$/,
  /^credential\.(.+\.)?helper$/,
  /^diff\.(external|.+\.(textconv|command))$/,
  /^merge\..+\.driver$/,
  /^filter\..+\.(clean|smudge|process)$/,
  /^gpg\.(.+\.)?program$/,
  /^pager\..+$/,
  /^(difftool|mergetool)\..+\.cmd$/,
  /^(include\.path|includeif\..+\.path)$/,
  /^init\.templatedir$/,
  /^uploadpack\.packobjectshook$/,
  /^remote\..+\.(uploadpack|receivepack)$/,
  /^submodule\..+\.update$/,
  /^(web\.browser|browser\..+\.cmd|man\..+\.cmd)$/,
];

/** A git config key as git compares it: section and variable case-insensitive, subsection not. */
function gitKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0) return key.toLowerCase();
  if (first === last) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

/** Whether git would run what `key` is set to. */
export function gitExecKey(key: string, value?: string): boolean {
  const k = gitKey(key);
  // An alias runs a program only when its value starts with `!`.
  if (/^alias\./i.test(k)) return value === undefined || value.trimStart().startsWith("!");
  const lower = k.toLowerCase();
  return GIT_EXEC_KEYS.some((re) => re.test(lower));
}

/** One `git config` that sets a key git will run, as the line says. */
export interface GitExecConfig {
  key: string;
  /** The command as written. */
  command: string;
}

/**
 * The `git config` invocations a command makes that persistently set a key
 * git runs (GIT_EXEC_KEYS), in any scope (--local, --global, --system,
 * --file). A read (`git config --get k`, `git config k` with no value) and an
 * unset are not writes. `git -c k=v` lasts one command, which is the agent
 * running a program -- what bash already governs -- so it is not read here.
 */
export function gitExecConfigs(command: string): GitExecConfig[] {
  const out: GitExecConfig[] = [];
  for (const inv of readShellCommand(command).invocations) {
    if (inv.synthetic || programName(inv.argv[0] ?? "") !== "git") continue;
    const argv = inv.argv;
    let i = 1;
    while (i < argv.length && argv[i]!.startsWith("-")) i += GIT_GLOBAL_ARG.has(argv[i]!) ? 2 : 1;
    if (argv[i] !== "config") continue;
    const rest = argv.slice(i + 1);
    const words: string[] = [];
    let reading = false;
    let add = false;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k]!;
      if (/^--(get|get-all|get-regexp|get-urlmatch|list|unset|unset-all|remove-section|rename-section|show-origin|show-scope|edit|name-only)$/.test(a) || /^-[le]$/.test(a)) {
        reading = true;
        continue;
      }
      if (a === "--add" || a === "--replace-all") {
        add = true;
        continue;
      }
      if (/^--(file|blob|type|default|comment|value|fixed-value)$/.test(a) || a === "-f") {
        k++;
        continue;
      }
      if (a.startsWith("-")) continue;
      words.push(a);
    }
    // `git config set k v` / `git config unset k` / `git config get k` (git 2.46).
    if (words[0] === "set") words.shift();
    else if (words[0] === "get" || words[0] === "unset" || words[0] === "list" || words[0] === "edit" || words[0] === "rename-section" || words[0] === "remove-section") reading = true;
    if (reading && !add) continue;
    const [key, value] = words;
    if (key === undefined || (value === undefined && !add)) continue;
    if (gitExecKey(key, value)) out.push({ key, command: describeInvocation(inv) });
  }
  return out;
}

/**
 * The `git add` and `git commit` invocations a command makes, read for what
 * they put into the next commit: whether the commit takes everything tracked
 * (`-a`), which pathspecs it or the add names, and whether the add takes the
 * whole tree (`-A`, `-u`). `gnomon guard` and the loop refuse a commit that
 * would record a change to `.gnomon/` (tools.ts, surfaceCommitRefusal).
 */
export interface GitIndexOp {
  sub: "add" | "commit";
  /** `git -C <dir>`, as written; "" when none. */
  at: string;
  /** commit -a / --all; add -A / --all / -u / --update with no pathspec. */
  all: boolean;
  pathspecs: string[];
}

const GIT_COMMIT_VALUE = /^(-[mFCct]|--(message|file|reuse-message|reedit-message|template|author|date|cleanup|fixup|squash|trailer|gpg-sign))$/;

export function gitIndexOps(command: string): GitIndexOp[] {
  const out: GitIndexOp[] = [];
  for (const inv of readShellCommand(command).invocations) {
    if (inv.synthetic || programName(inv.argv[0] ?? "") !== "git") continue;
    const argv = inv.argv;
    let i = 1;
    let at = "";
    while (i < argv.length && argv[i]!.startsWith("-")) {
      if (argv[i] === "-C" && argv[i + 1] !== undefined) at = argv[i + 1]!;
      i += GIT_GLOBAL_ARG.has(argv[i]!) ? 2 : 1;
    }
    const sub = argv[i];
    if (sub !== "add" && sub !== "stage" && sub !== "commit") continue;
    const rest = argv.slice(i + 1);
    const pathspecs: string[] = [];
    let all = false;
    let dashes = false;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k]!;
      if (dashes) {
        pathspecs.push(a);
        continue;
      }
      if (a === "--") {
        dashes = true;
        continue;
      }
      if (sub === "commit") {
        if (GIT_COMMIT_VALUE.test(a)) {
          k++;
          continue;
        }
        if (a === "--all" || (/^-[a-zA-Z]+$/.test(a) && a.slice(1).split("").includes("a") && !/[mFCct]./.test(a.slice(1)))) all = true;
        // `-am msg`: the cluster ends in a flag that takes the next word.
        if (/^-[a-zA-Z]+$/.test(a) && /[mFCct]$/.test(a)) k++;
        if (a.startsWith("-")) continue;
      } else {
        if (a === "-A" || a === "--all" || a === "-u" || a === "--update" || (/^-[a-zA-Z]+$/.test(a) && /[Au]/.test(a))) all = true;
        if (a === "--chmod" || a === "--pathspec-from-file") k++;
        if (a.startsWith("-")) continue;
      }
      pathspecs.push(a);
    }
    out.push({ sub: sub === "stage" ? "add" : sub, at, all: all && (sub === "commit" || pathspecs.length === 0), pathspecs });
  }
  return out;
}

/** A `git clean`'s options read, or null for a dry run (-n), which removes nothing. */
function gitCleanOf(rest: string[]): GitClean | null {
  let x = false;
  let X = false;
  let d = false;
  let dry = false;
  let interactive = false;
  const excludes: string[] = [];
  const pathspecs: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (a === "--") {
      pathspecs.push(...rest.slice(k + 1));
      break;
    }
    if (a === "--dry-run") dry = true;
    else if (a === "--interactive") interactive = true;
    else if (a === "-e" || a === "--exclude") excludes.push(rest[++k] ?? "");
    else if (a.startsWith("--exclude=")) excludes.push(a.slice(10));
    else if (/^-[A-Za-z]+/.test(a) && !a.startsWith("--")) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]!;
        if (c === "e") {
          excludes.push(a.slice(j + 1) || rest[++k] || "");
          break;
        }
        if (c === "x") x = true;
        else if (c === "X") X = true;
        else if (c === "d") d = true;
        else if (c === "n") dry = true;
        else if (c === "i") interactive = true;
      }
    } else if (!a.startsWith("-")) pathspecs.push(a);
  }
  // -n removes nothing, unless -i hands the choice to whatever feeds stdin.
  if (dry && !interactive) return null;
  return { untracked: !X, ignored: x || X, dirs: d || pathspecs.length > 0, excludes, pathspecs };
}

/** `tar -x`: the directory it extracts into, and the archive to list. */
function tarExtract(argv: string[]): { dir: string; archive?: string } | null {
  let extract = false;
  let dir = ".";
  let archive: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === "-C" || w === "--directory") dir = argv[++i] ?? dir;
    else if (w.startsWith("--directory=")) dir = w.slice(12);
    else if (w === "-f" || w === "--file") archive = argv[++i];
    else if (w.startsWith("--file=")) archive = w.slice(7);
    else if (w === "-x" || w === "--extract" || w === "--get") extract = true;
    else if (/^-?[a-zA-Z]+$/.test(w) && (i === 1 || w.startsWith("-"))) {
      // Bundled short options, with or without the dash: `-xzf a.tgz`, `xf a.tar`.
      const flags = w.replace(/^-/, "");
      if (flags.includes("x")) extract = true;
      if (flags.endsWith("f")) archive = argv[++i];
      else if (flags.includes("C")) dir = argv[++i] ?? dir;
    }
  }
  return extract ? { dir, archive } : null;
}

// ---------------------------------------------------------------------------
// Where the shell is when a command writes
// ---------------------------------------------------------------------------
//
// A relative write target means nothing without the directory it is relative
// to. The first reader followed a `cd` only at the top level of the line, so
// `sh -c 'cd src && echo x > ../CHANGELOG.md'` was judged as writing
// `../CHANGELOG.md` from the root -- outside the repository, not
// write_allow's business -- while the same text without `sh -c` was refused
// (INJ-2026-11, GV3 round 2). It also read a `cd` in a subshell, a piped
// group or a function body as moving every command after it, which it does
// not: `(cd src); echo x > a.py` writes ./a.py, not src/a.py.
//
// The tracker reads frames (ShellFrame): a `cd` inside a subshell, a command
// substitution or another shell stays there; one inside `{ }`, `if`, a loop, a
// function body or `eval` may or may not have run, so the commands after it
// are read from BOTH directories. Within a list, a `cd` followed by `&&` is
// certain for the rest of the `&&` chain; after the list, it is certain only
// when the directory exists (so the `cd` cannot fail). A target is reported
// once for every directory it may be relative to, and once with cwd null when
// one of them is not known (`cd "$X"`); write_allow refuses a target it cannot
// place (tools.ts). And the first reader's own directory is always one of
// them, so nothing it refused is let through.

/** Directories the shell may be in: literal (relative to the start, absolute, or `~`), or not known. */
interface Dirs {
  known: string[];
  unknown: boolean;
}

const AT_START: Dirs = { known: [""], unknown: false };

function union(a: Dirs, b: Dirs): Dirs {
  const known = [...a.known];
  for (const k of b.known) if (!known.includes(k)) known.push(k);
  return { known, unknown: a.unknown || b.unknown };
}

/** `a` joined to a relative `b`, lexically: `src` + `..` is the start (""). */
function joinDir(a: string, b: string): string {
  const parts = (a ? a.split("/") : []).concat(b.split("/"));
  const out: string[] = [];
  const abs = a.startsWith("/") || (a === "" && b.startsWith("/"));
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === ".." && out.length > 0 && out[out.length - 1] !== ".." && out[out.length - 1] !== "~") out.pop();
    else out.push(p);
  }
  const j = out.join("/");
  return abs ? `/${j}` : j;
}

/** Where `cd target` lands from each of `from`. */
function cdTo(from: Dirs, target: string | undefined): Dirs {
  if (target === undefined || target === "" || target === "~") return { known: ["~"], unknown: false };
  if (/[$`*?[]/.test(target) || /^~[^/]/.test(target)) return { known: [], unknown: true };
  if (target.startsWith("/")) return { known: [joinDir("", target)], unknown: false };
  if (target.startsWith("~/")) return { known: [joinDir("~", target.slice(2))], unknown: false };
  return { known: from.known.map((d) => joinDir(d, target)), unknown: from.unknown };
}

interface FrameCwd {
  /** At the start of the current list. */
  cur: Dirs;
  /** For the commands `&&` (or `|`) joins to a `cd` in the current list. */
  chain: Dirs | null;
  /** An `||` in the current list: what follows may run whatever happened before. */
  broken: boolean;
  /** After the current list: what the next one starts in. */
  end: Dirs;
  /** OLDPWD, for `cd -`. */
  prevDir: Dirs | null;
  /** pushd's stack. */
  stack: Dirs[];
}

/** The `cd`, `pushd` and `popd` target of a command (`cd -P dir`, `cd -- dir`). */
function cdTarget(argv: string[]): string | undefined {
  let i = 1;
  while (i < argv.length && /^-[LPe@]+$/.test(argv[i]!)) i++;
  if (argv[i] === "--") i++;
  return argv[i];
}

class CwdTracker {
  private states = new Map<string, FrameCwd>();
  private active: string[] = [];
  private seen = new Map<string, Dirs>();

  constructor(
    private readonly frames: Map<string, ShellFrame>,
    private readonly dirExists?: (dir: string) => boolean
  ) {}

  private path(f: string): string[] {
    const out: string[] = [];
    for (let x: string | null = f; x !== null && x !== undefined; x = this.frames.get(x)?.parent ?? null) out.unshift(x);
    return out;
  }

  private fresh(base: Dirs): FrameCwd {
    return { cur: base, chain: null, broken: false, end: base, prevDir: null, stack: [] };
  }

  /** The state of a frame, entering it (and its parents) as needed. */
  private state(f: string): FrameCwd {
    const s = this.states.get(f);
    if (s) return s;
    const fr = this.frames.get(f);
    let base = AT_START;
    if (fr?.parent) base = this.at(this.state(fr.parent), fr.prev);
    if (fr?.chdir !== undefined) base = cdTo(base, fr.chdir);
    const made = this.fresh(base);
    this.states.set(f, made);
    return made;
  }

  /** Where a command with operator `prev` before it runs, in a frame. */
  private at(s: FrameCwd, prev: string): Dirs {
    if (prev === "") {
      s.cur = s.end;
      s.chain = null;
      s.broken = false;
      return s.cur;
    }
    if (prev === "||") {
      s.broken = true;
      return union(s.cur, s.end);
    }
    return s.broken ? s.end : s.chain ?? s.cur;
  }

  /** Leave every frame the next command is not in; a group's `cd` reaches its parent both ways. */
  private move(f: string): void {
    const to = this.path(f);
    for (let k = this.active.length - 1; k >= 0; k--) {
      const g = this.active[k]!;
      if (to.includes(g)) continue;
      const fr = this.frames.get(g);
      const s = this.states.get(g);
      if (fr?.kind === "group" && fr.parent && s) {
        const p = this.state(fr.parent);
        const fin = union(s.end, s.chain ?? s.cur);
        p.end = union(p.end, fin);
        p.cur = union(p.cur, fin);
        if (p.chain) p.chain = union(p.chain, fin);
      }
      this.states.delete(g);
    }
    this.active = to;
  }

  /**
   * Where an invocation runs. Every invocation of one command (its wrappers,
   * its second reading) is placed once.
   */
  dirsFor(inv: ShellInvocation, site: string): Dirs {
    const done = this.seen.get(site);
    if (done) return done;
    const f = inv.frame ?? "";
    this.move(f);
    const d = this.at(this.state(f), inv.prev ?? "");
    this.seen.set(site, d);
    return d;
  }

  /** A `cd`, `pushd` or `popd` with these possible targets, run where `before` says. */
  cd(inv: ShellInvocation, prog: string, targets: Array<string | undefined>, before: Dirs): void {
    // A pipeline stage or a background job runs in a subshell: its `cd` moves nothing.
    if (inv.prev === "|" || inv.next === "|" || inv.next === "&") return;
    const s = this.state(inv.frame ?? "");
    let after: Dirs = { known: [], unknown: false };
    if (prog === "popd") after = s.stack.pop() ?? { known: [], unknown: true };
    else {
      for (const t of targets) after = union(after, t === "-" ? s.prevDir ?? { known: [], unknown: true } : cdTo(before, t));
      if (prog === "pushd") s.stack.push(before);
    }
    s.prevDir = before;
    const sure =
      (inv.prev ?? "") === "" &&
      !after.unknown &&
      this.dirExists !== undefined &&
      after.known.every((d) => this.dirExists!(d));
    if ((inv.prev ?? "") === "") {
      s.chain = after;
      s.end = sure ? after : union(before, after);
    } else if (inv.prev === "&&" && !s.broken) {
      s.chain = after;
      s.end = union(s.end, after);
    } else {
      s.end = union(s.end, after);
      if (s.chain) s.chain = union(s.chain, after);
    }
  }
}

/**
 * The name tests that bound what a removing `find` removes: in each `-o`
 * branch that removes (-delete, or -exec of a remover), the -name / -path
 * tests BEFORE the action. Undefined -- the removal reaches everything below
 * its start points -- when a removing branch has no such test, or when a
 * negation or a parenthesis makes the expression one this does not read.
 * `find . -name node_modules -prune -o -name '*.pyc' -delete` is bounded by
 * both names; `find . -name x -o -delete` is not bounded at all.
 */
function findNameFilters(argv: string[]): string[] | undefined {
  let i = 1;
  while (i < argv.length && !/^[-(!),]/.test(argv[i]!)) i++; // start points
  const names: string[] = [];
  let branch: string[] = [];
  let removing = false;
  const close = (): boolean => {
    if (removing) {
      if (branch.length === 0) return false;
      names.push(...branch);
    }
    branch = [];
    removing = false;
    return true;
  };
  for (; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "!" || t === "-not" || t === "(" || t === ")" || t === ",") return undefined;
    if (t === "-o" || t === "-or") {
      if (!close()) return undefined;
      continue;
    }
    if (t === "-delete") {
      if (!removing && branch.length === 0) return undefined;
      removing = true;
      continue;
    }
    if (t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir") {
      const prog = programName(argv[i + 1] ?? "");
      if (REMOVERS.has(prog)) {
        if (branch.length === 0) return undefined;
        removing = true;
      }
      while (i < argv.length && argv[i] !== ";" && !(argv[i] === "+" && argv[i - 1] === "{}")) i++;
      continue;
    }
    if (/^-i?(name|path|wholename|regex)$/.test(t) && i + 1 < argv.length) {
      // A test after the action does not bound it: `-delete -name x` deletes first.
      if (!removing) branch.push(`${t}\0${argv[i + 1]}`);
      i++;
    }
  }
  if (!close()) return undefined;
  return names.length > 0 ? names : undefined;
}

/** Programs a `find -exec` runs that remove what they are given. */
const REMOVERS = new Set(["rm", "unlink", "shred", "rmdir", "mv", "truncate"]);

/**
 * The files a bash command would write, as far as its text says.
 *
 * Read by `bashPrecheck` against write_allow (tools.ts), so `gnomon guard` and
 * the loop judge another harness's shell write and their own the same way.
 * `dirExists` says whether a directory (relative to where the command starts,
 * absolute, or under `~`) exists now: a `cd` into one that does is taken to
 * succeed (see CwdTracker).
 */
export function shellWriteTargets(
  command: string,
  opts: { dirExists?: (dir: string) => boolean } = {}
): { targets: WriteTarget[]; truncated: boolean } {
  const read = readShellCommand(command);
  const targets: WriteTarget[] = [];
  const seen = new Set<string>();
  const tracker = new CwdTracker(read.frames, opts.dirExists);
  // The first reader's directory: a `cd` at the top level, in order, as
  // written. Kept as one of the directories every target is judged from.
  let first: string | null = "";
  let here: Dirs = AT_START;
  const add = (path: string, how: string, extra: Partial<WriteTarget> = {}) => {
    if (!path || NOT_A_FILE.test(path)) return;
    const cwds: Array<string | null> = [];
    if (first !== null) cwds.push(first);
    for (const k of here.known) if (!cwds.includes(k)) cwds.push(k);
    // Not known is the tracker's call: the first reader gave up on `cd ~` and
    // `cd -`, which the tracker follows, and it judged nothing after them.
    if (here.unknown || cwds.length === 0) cwds.push(null);
    for (const cwd of cwds) {
      const key = `${cwd}\0${path}\0${how}${extra.recursive ? "\0r" : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ path, how, cwd, ...extra });
    }
  };
  // One command read twice (as written and respelled) is one `cd`, with
  // either reading's target: `site` is the command, `frame` where it runs.
  const siteOf = (inv: ShellInvocation) => `${inv.site ?? -1}|${inv.frame ?? ""}`;
  const cdSites = new Map<string, { inv: ShellInvocation; prog: string; targets: Array<string | undefined> }>();
  for (const inv of read.invocations) {
    if (inv.synthetic) continue;
    const prog = programName(inv.argv[0]!);
    if (prog === "cd" || prog === "pushd" || prog === "popd") {
      const c = cdSites.get(siteOf(inv));
      if (c) c.targets.push(cdTarget(inv.argv));
      else cdSites.set(siteOf(inv), { inv, prog, targets: [cdTarget(inv.argv)] });
    }
  }
  const applied = new Set<string>();
  read.invocations.forEach((inv) => {
    if (inv.synthetic) return;
    const s = siteOf(inv);
    here = tracker.dirsFor(inv, s);
    const prog = programName(inv.argv[0]!);
    if (prog === "cd" || prog === "pushd" || prog === "popd") {
      if ((prog === "cd" || prog === "pushd") && inv.via === null && !inv.respelled) {
        const to = inv.argv[1];
        if (to === undefined || to === "-" || /[$`~*?[]/.test(to)) first = null;
        else if (first !== null) first = to.startsWith("/") ? to : first ? `${first}/${to}` : to;
      }
      if (!applied.has(s)) {
        applied.add(s);
        const c = cdSites.get(s)!;
        tracker.cd(c.inv, c.prog, c.targets, here);
      }
      return;
    }
    writesOf(inv, prog, add);
  });
  return { targets, truncated: read.truncated };
}

/** What one invocation writes, handed to `add`. */
function writesOf(
  inv: ShellInvocation,
  prog: string,
  add: (path: string, how: string, extra?: Partial<WriteTarget>) => void
): void {
  for (const r of inv.redirects) {
    if (WRITE_REDIRECTS.has(r.op)) add(r.target, `${r.op} redirect`);
  }
  const w = WRITERS[prog];
  if (w) {
    const { ops, target } = writerOperands(inv.argv, w);
    const flags = inv.argv.slice(1).filter((a) => a.startsWith("-"));
    const recursive =
      (prog === "rm" || prog === "shred") &&
      flags.some((f) => f === "--recursive" || (/^-[a-zA-Z]+$/.test(f) && /[rR]/.test(f)));
    if (target !== undefined) add(target, prog);
    if (w.operands === "all") for (const o of ops) add(o, prog, recursive ? { recursive: true } : {});
    else if (target === undefined && ops.length >= 2) add(ops[ops.length - 1]!, prog);
    // Moving a directory moves everything below it.
    if (w.operands === "mv") for (const o of target === undefined ? ops.slice(0, -1) : ops) add(o, "mv (source)", { recursive: true });
    // A link is a second name for its source: `ln .gnomon-audit/a.jsonl x`
    // then `echo >> x` writes the trail. The source is reported, marked, so
    // a caller guarding a directory can refuse links INTO it; write_allow
    // does not judge it, since a link does not write its source.
    // `cp -l` / `cp -s` / `cp -al` make links too.
    const linking =
      prog === "ln" ||
      prog === "link" ||
      (prog === "cp" && flags.some((f) => f === "--link" || f === "--symbolic-link" || (/^-[a-zA-Z]+$/.test(f) && /[ls]/.test(f))));
    if (linking) {
      const sources = target === undefined ? ops.slice(0, -1) : ops;
      const symbolic = flags.some((f) => f === "--symbolic" || f === "--symbolic-link" || (/^-[a-zA-Z]+$/.test(f) && f.includes("s")));
      for (const o of sources) {
        add(o, "ln (source)");
        // A relative symlink source resolves from the LINK's directory, not
        // the shell's: `ln -s ../.gnomon-audit sub/l` points at the trail
        // although `../.gnomon-audit` from the root is outside it (round-3
        // review). Both readings of where the link lands are reported: the
        // last operand's directory, and the operand itself when it is a
        // directory the link is made inside.
        if (symbolic && !o.startsWith("/")) {
          const at = target ?? ops[ops.length - 1] ?? "";
          const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.replace(/\/+$/, "").lastIndexOf("/") + 1) : "");
          add(`${dirOf(at)}${o}`, "ln (source)");
          if (target !== undefined || sources.length > 1 || at.endsWith("/")) add(`${at.replace(/\/+$/, "")}/${o}`, "ln (source)");
          else add(`${at}/${o}`, "ln (source)");
        }
      }
    }
    return;
  }
  if (prog === "git") {
    for (const t of gitWrites(inv.argv)) {
      add(t.path, t.how, {
        ...(t.recursive ? { recursive: true } : {}),
        ...(t.clean ? { clean: t.clean } : {}),
      });
    }
    return;
  }
  if (prog === "find") {
    // find -delete, or -exec of a program that removes what it is handed,
    // removes what its tests match below each start point.
    const f = readFind(inv.argv);
    const removes = f.deletes || f.execs.some((e) => e.payload.length > 0 && REMOVERS.has(programName(e.payload[0]!)));
    if (removes) {
      const names = findNameFilters(inv.argv);
      for (const s of f.starts) add(s, "find -delete", { recursive: true, ...(names ? { names } : {}) });
    }
    return;
  }
  if (prog === "tar") {
    const x = tarExtract(inv.argv);
    if (x) {
      add(x.dir, "tar -x (into)");
      if (x.archive) add(x.archive, "tar -x (archive)");
    }
    return;
  }
  if (prog === "unzip") {
    const d = inv.argv.indexOf("-d");
    const archive = inv.argv.slice(1).find((a) => !a.startsWith("-") && a !== inv.argv[d + 1]);
    add(d > 0 && inv.argv[d + 1] ? inv.argv[d + 1]! : ".", "unzip (into)");
    if (archive) add(archive, "unzip (archive)");
    return;
  }
  if (prog === "rsync") {
    const ops = inv.argv.slice(1).filter((a) => !a.startsWith("-"));
    // --delete removes what the source does not have, everywhere below the destination.
    const deletes = inv.argv.some((a) => /^--(delete|del|remove-source-files)/.test(a));
    if (ops.length >= 2) add(ops[ops.length - 1]!, "rsync", deletes ? { recursive: true } : {});
    return;
  }
  if (prog === "awk" || prog === "gawk" || prog === "mawk" || prog === "nawk") {
    const program = awkProgram(inv.argv);
    if (program) for (const m of program.matchAll(AWK_REDIRECT)) add(m[1]!, "awk redirect");
    return;
  }
  if (prog === "dd") {
    for (const a of inv.argv) if (a.startsWith("of=")) add(a.slice(3), "dd");
    return;
  }
  if (prog === "curl" || prog === "wget") {
    for (let i = 1; i < inv.argv.length; i++) {
      const a = inv.argv[i]!;
      if (prog === "curl" && (a === "-o" || a === "--output")) add(inv.argv[++i] ?? "", prog);
      else if (prog === "curl" && a.startsWith("--output=")) add(a.slice(9), prog);
      else if (prog === "wget" && (a === "-O" || a === "--output-document")) add(inv.argv[++i] ?? "", prog);
      else if (prog === "wget" && a.startsWith("--output-document=")) add(a.slice(18), prog);
    }
    return;
  }
  const inPlace = inPlaceFiles(prog, inv.argv);
  if (inPlace) for (const f of inPlace) add(f, `${prog} -i`);
  const lang = /^python[\d.]*$/.test(prog) ? "python" : prog === "nodejs" ? "node" : prog;
  const flags = CODE_FLAGS[lang];
  if (flags) {
    for (const code of inlineCode(inv.argv, flags, inv.redirects)) {
      for (const p of codeWriteTargets(code)) add(p, `${prog} code`);
      for (const p of codeRecursiveDeletes(code)) add(p, `${prog} code`, { recursive: true });
    }
  }
}

/**
 * `git clean -n` / `--dry-run` lists what would go and removes nothing. A
 * deny pattern written for `git clean -fdx` refused `git clean -ndx` in G1c,
 * a false refusal of the one safe way to look first. True for a segment whose
 * every program is a dry-run `git clean`.
 */
export function isDryRunSegment(segment: string): boolean {
  const read = readShellCommand(segment);
  if (read.truncated) return false;
  const real = read.invocations.filter((i) => !i.synthetic);
  if (real.length === 0) return false;
  return real.every((inv) => {
    if (programName(inv.argv[0]!) !== "git") return false;
    let i = 1;
    // git's own options before the subcommand: -C dir, -c k=v
    while (i < inv.argv.length && inv.argv[i]!.startsWith("-")) i += /^-(C|c)$/.test(inv.argv[i]!) ? 2 : 1;
    if (inv.argv[i] !== "clean") return false;
    const rest = inv.argv.slice(i + 1);
    if (rest.some((a) => a === "-i" || a === "--interactive" || (/^-[a-zA-Z]+$/.test(a) && a.includes("i")))) return false;
    return rest.some((a) => a === "--dry-run" || (/^-[a-zA-Z]+$/.test(a) && a.includes("n")));
  });
}

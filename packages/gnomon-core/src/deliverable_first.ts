/**
 * Deliverable-first time notes: `[turn] deliverable_first = true` in
 * config.toml, read only under `gnomon task --deadline`.
 *
 * Opt-in. Absent (or false), nothing here runs and the loop sends the model
 * exactly the requests it sent before this file existed.
 *
 * Why it exists. The 2026-11-06 timeout anatomy of 80 capped long-task runs
 * (P2G41, H3, AS1; research notes, reverse-engineering 06) found that 54 of
 * the 80 had never written the deliverable the task names when Harbor's
 * 1800 s cap hit: `/app/cracker.py`, `flag.txt`, the layout `config.json`,
 * `harmony.mxl`, `mutation.report.json`, `checkpoint.pt`. Most cells changed
 * *some* file early; the answer file is what went unwritten while the model
 * kept exploring. The one lever that turned caps into answers was
 * `--deadline`, whose half-time note works as an answer-now rule (AS1: 4 of 4
 * cells answered). This extends those notes rather than adding a mechanism of
 * its own: at DELIVERABLE_FIRST_AT of the budget, if an output the task text
 * names does not exist yet, the time note says which, and asks for a first
 * complete version now.
 *
 * The extraction is deterministic and conservative: an absolute path, or a
 * quoted filename with an extension, that follows an instruction verb
 * ("write", "save", "create", "produce", "output", "emit", "generate",
 * "build", "implement", "add", "put", "place", "store", "export") addressed
 * to the agent. A file the program under repair is said to write ("the
 * harness writes …", "accepted leads should write …") is not the agent's
 * deliverable, and a path the note names wrongly would send the model to
 * write it, so the rules prefer missing one to naming one wrongly. Measured
 * on the 29 P2G task instructions in deliverable_first.test.ts.
 *
 * Pure but for `missingDeliverables`, which reads the filesystem: the loop
 * owns the clock and the messages (docs/CONTRACTS.md §35,
 * conformance/deliverable_first.json).
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import type { GnomonConfig } from "./config.js";

/** Fractions of the `--deadline` budget at which the deliverables are checked. Fixed: one knob, one arm. */
export const DELIVERABLE_FIRST_AT: readonly number[] = [0.4, 0.7];

/** At most this many paths are named in one note, so a long list cannot crowd the request. */
export const DELIVERABLE_FIRST_MAX_NAMED = 12;

/** The audit events of kind `deliverable_first`. */
export const DELIVERABLE_FIRST_EVENTS = ["named", "check"] as const;

/** The instruction verbs, base form only: "writes" and "produces" describe a program, not an instruction. */
export const DELIVERABLE_VERBS: readonly string[] = [
  "write",
  "save",
  "create",
  "produce",
  "output",
  "emit",
  "generate",
  "build",
  "implement",
  "add",
  "put",
  "place",
  "store",
  "export",
];

/** Read `[turn] deliverable_first`. Only `true` turns it on. */
export function resolveDeliverableFirst(config: GnomonConfig): boolean {
  const t = (config.config as { turn?: Record<string, unknown> } | undefined)?.turn;
  return t?.deliverable_first === true;
}

/**
 * What is wrong with a declared `deliverable_first`, in auditSurface's shape.
 * A value that is not a boolean is fatal: a surface that says `"yes"` and runs
 * without the notes would be measured as the arm it is not.
 */
export function auditDeliverableFirst(
  config: GnomonConfig
): Array<{ where: string; problem: string; fix: string; fatal: boolean }> {
  const t = (config.config as { turn?: Record<string, unknown> } | undefined)?.turn;
  const v = t?.deliverable_first;
  if (v === undefined || typeof v === "boolean") return [];
  return [
    {
      where: ".gnomon/config.toml [turn] deliverable_first",
      problem:
        `deliverable_first = ${JSON.stringify(v)} is not a boolean. Refused rather than run ` +
        `without the deliverable notes under a surface that seems to ask for them.`,
      fix: "deliverable_first = true (or false, the default)",
      fatal: true,
    },
  ];
}

const MODALS = new Set(["should", "must", "will", "shall", "can", "may", "would", "could"]);
/** A verb after one of these is a noun or an adjective: "the output contract", "a build script". */
const DETERMINERS = new Set(["the", "a", "an", "your", "its", "their", "our", "this", "these", "those", "each", "every", "any", "my"]);
const NEGATIONS = new Set(["not", "never", "don't", "dont", "cannot", "can't", "without", "no"]);
/** Words that end the object of an instruction verb: what follows is about something else. */
const STOPS = new Set([
  "that",
  "which",
  "who",
  "whose",
  "using",
  "according",
  "from",
  "with",
  "so",
  "where",
  "when",
  "because",
  "then",
  "if",
  "unless",
  "without",
  "by",
  "via",
  "while",
  "after",
  "before",
  "but",
  "containing",
  "describing",
]);
/** Words between a verb and its first path, at most */
const FIRST_WINDOW = 14;
/** Words between one path and the next in the same list, at most */
const NEXT_WINDOW = 6;

const VERBS = new Set(DELIVERABLE_VERBS);
/** "the command `x` should write …": a named command whose outputs the task requires. */
const COMMAND_NOUNS = new Set(["command", "script"]);
/**
 * An object that makes the path a dependency manifest, not an output: "Write
 * any Python dependencies to `/app/requirements.txt` (may be empty)", "Write
 * any apt packages needed … to `/app/apt-packages.txt`". On cargo-flight-
 * dispatch and interleaved-vigenere these legitimately empty files were the
 * only names, or one of two (research note 13, finding 3).
 */
export const DEPENDENCY_WORDS: readonly string[] = ["dependencies", "dependency", "packages"];
const DEPENDENCY = new Set(DEPENDENCY_WORDS);

/** A token of a sentence: a code span, a double-quoted string, or a bare word. */
interface Tok {
  raw: string;
  /** Lower-cased word with its punctuation stripped; "" for a code span or quoted string */
  word: string;
  quoted: boolean;
}

function tokenize(sentence: string): Tok[] {
  const out: Tok[] = [];
  for (const m of sentence.matchAll(/`[^`]+`|"[^"\n]+"|\S+/g)) {
    const raw = m[0];
    const quoted = raw.startsWith("`") || raw.startsWith('"');
    out.push({ raw, quoted, word: quoted ? "" : raw.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "") });
  }
  return out;
}

/** A file: a last segment with a stem and a lower-case extension. */
const FILE_TAIL = /(?:^|[\\/])[A-Za-z0-9_][A-Za-z0-9_.+-]*\.[a-z0-9]{1,8}$/;
/** Path characters: POSIX, and Windows (backslashes, one drive colon, checked below). */
const PATHISH = /^[A-Za-z0-9_.\/\\~+:-]+$/;
/** A Windows absolute path: `C:\x` or `C:/x`. */
const WIN_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * What a token names, if it names a path: `file` (has an extension), `dir`
 * (absolute, no extension, or a trailing separator), or nothing. A bare
 * relative word is never a path; quoted, it is one if it is a file. Absolute
 * means POSIX (`/x`, `~/x`) or Windows (`C:\x`, `C:/x`): a task given on
 * Windows names its outputs in its own form, and a path the extractor cannot
 * read is a deliverable the note never mentions.
 */
function pathOf(tok: Tok): { kind: "file" | "dir"; path: string; relative: boolean } | undefined {
  let s = tok.raw;
  if (tok.quoted) s = s.slice(1, -1).trim();
  else s = s.replace(/^[(\[]+/, "").replace(/[.,;:)\]!?*]+$/, "");
  if (!s || s.includes("://") || !PATHISH.test(s)) return undefined;
  const windows = WIN_ABSOLUTE.test(s);
  // A colon anywhere but a drive letter's is not a path ("key:value", "a::b").
  if (s.indexOf(":") !== (windows ? 1 : -1) || s.lastIndexOf(":") !== s.indexOf(":")) return undefined;
  const absolute = windows || s.startsWith("/") || s.startsWith("~/");
  const dotted = /^\.\.?[\\/]/.test(s);
  if (!absolute && !dotted && !tok.quoted) return undefined;
  if (absolute && s.replace(/[\\/]+$/, "").length < (windows ? 3 : 2)) return undefined;
  const trailing = /[\\/]$/.test(s);
  const trimmed = s.length > 1 ? s.replace(/[\\/]+$/, "") : s;
  if (!trailing && FILE_TAIL.test(trimmed)) {
    return { kind: "file", path: trimmed, relative: !absolute };
  }
  if (absolute || dotted) return { kind: "dir", path: trimmed, relative: !absolute };
  return undefined;
}

/** Whether the instruction verb at `i` is addressed to the agent. */
function addressed(toks: Tok[], i: number): boolean {
  if (DETERMINERS.has(toks[i - 1]?.word ?? "")) return false;
  for (let k = Math.max(0, i - 3); k < i; k++) {
    if (NEGATIONS.has(toks[k]!.word)) return false;
    if (toks[k]!.word === "do" && toks[k + 1]?.word === "not") return false;
  }
  // The nearest modal before the verb, in this sentence: "you must write" is
  // an instruction; "it should … write", "leads should write" describe a
  // program. One exception (v0.4.6): "the command `x.sh` should … write
  // `/out/y`" names the outputs the run must leave, through a command the
  // task names -- risk-scorer-replay's three outputs, which the extractor
  // named nothing for (research note 13, finding 3).
  for (let k = i - 1; k >= 0; k--) {
    if (MODALS.has(toks[k]!.word)) {
      const subject = toks[k - 1]?.word ?? "";
      if (subject === "you" || subject === "please") return true;
      const named = toks[k - 1];
      return Boolean(named?.quoted && COMMAND_NOUNS.has(toks[k - 2]?.word ?? ""));
    }
  }
  return true;
}

function sentencesOf(text: string): { sentences: string[]; listed: string[] } {
  const clean = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\r/g, "");
  const sentences: string[] = [];
  const listed: string[] = [];
  const bullet = /^\s*(?:[-*+]|\d+[.)])\s+/;
  let listOpen = false;
  let para: string[] = [];
  const split = (text: string): void => {
    for (const s of text.split(/(?<=[.!?])\s+(?=[A-Z`/(*"])/)) if (s.trim()) sentences.push(s.trim());
  };
  const flush = (): void => {
    if (para.length === 0) return;
    split(para.join(" "));
    para = [];
  };
  for (const line of clean.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (bullet.test(line)) {
      flush();
      const item = line.replace(bullet, "");
      if (listOpen) {
        // A list after "Create the following files:": each item's leading path.
        const first = tokenize(item)[0];
        const p = first ? pathOf(first) : undefined;
        if (p?.kind === "file") listed.push(p.path);
      }
      split(item);
      continue;
    }
    // A line that ends with ":" and instructs opens a list; any other closes one.
    const toks = tokenize(line);
    listOpen = /:\s*$/.test(line) && toks.some((t, i) => VERBS.has(t.word) && addressed(toks, i));
    para.push(line.trim());
    if (listOpen) flush();
  }
  flush();
  return { sentences, listed };
}

/**
 * The output paths a task's text names, in the order it names them, each
 * once. Absolute paths stay absolute; a quoted relative filename stays
 * relative (the caller resolves it against the working directory). A name
 * given as `named \`x.csv\`` beside a directory the same sentence asks for
 * is joined to it.
 */
export function extractDeliverables(task: string): string[] {
  const { sentences, listed } = sentencesOf(task);
  const out: string[] = [...listed];
  for (const sentence of sentences) {
    const toks = tokenize(sentence);
    const dirs: string[] = [];
    let instructed = false;
    for (let i = 0; i < toks.length; i++) {
      if (!VERBS.has(toks[i]!.word) || !addressed(toks, i)) continue;
      instructed = true;
      let budget = FIRST_WINDOW;
      let found = false;
      for (let j = i + 1; j < toks.length && budget >= 0; j++) {
        const t = toks[j]!;
        if (t.word && STOPS.has(t.word)) break;
        // A dependency manifest: the object before the first path says so.
        if (!found && DEPENDENCY.has(t.word)) break;
        if (/[;]$/.test(t.raw)) budget = Math.min(budget, 0);
        const p = pathOf(t);
        if (!p) {
          budget--;
          continue;
        }
        found = true;
        const named = ["named", "called"].includes(toks[j - 1]?.word ?? "");
        if (p.kind === "dir") dirs.push(p.path);
        else if (!(named && p.relative)) out.push(p.path);
        budget = NEXT_WINDOW;
      }
    }
    // "Fix the tool so that running `python dispatch.py --output /o/plan.json`
    // produces a correct plan": the file an output flag of a command the task
    // tells the agent to make work names (cargo-flight-dispatch, research
    // note 13, finding 3). Only a code span right after "running"/"run", and
    // only the value of an output flag.
    for (let j = 1; j < toks.length; j++) {
      const t = toks[j]!;
      if (!t.raw.startsWith("`") || !["running", "run"].includes(toks[j - 1]!.word)) continue;
      const m = /(?:^|\s)(?:--output|--out|-o)(?:=|\s+)(\S+)/.exec(t.raw.slice(1, -1));
      const p = m ? pathOf({ raw: `\`${m[1]}\``, word: "", quoted: true }) : undefined;
      if (p?.kind === "file" && !p.relative) out.push(p.path);
    }
    if (instructed) {
      // "a CSV file named `answers.csv` … save it inside `/results/`": joined
      // to each directory the sentence asks for, else relative, as written.
      for (let j = 1; j < toks.length; j++) {
        if (!["named", "called"].includes(toks[j - 1]!.word)) continue;
        const p = pathOf(toks[j]!);
        if (p?.kind !== "file" || !p.relative) continue;
        if (dirs.length === 0) out.push(p.path);
        else if (!/[\\/]/.test(p.path)) {
          for (const d of dirs) out.push(WIN_ABSOLUTE.test(d) ? win32.join(d, p.path) : posix.join(d, p.path));
        }
      }
    }
  }
  return [...new Set(out)];
}

/** The named paths that do not exist yet, relative ones resolved against `root`. */
export function missingDeliverables(paths: readonly string[], root: string): string[] {
  return paths.filter((p) => {
    const abs = p.startsWith("~/")
      ? join(process.env.HOME ?? "~", p.slice(2))
      : isAbsolute(p)
        ? p
        : resolve(root, p);
    try {
      return !existsSync(abs);
    } catch {
      return false;
    }
  });
}

/**
 * The sentence a time note carries when deliverables are missing. `plan`, the
 * default, is the text §35 always sent. Under `[turn] deadline_note =
 * "continue"` (long_task_profile.ts) the note says to keep improving, so the
 * deliverable note does not carry the stop cue either: on CF1 BEST the 0.4
 * note went out after "Plan the rest of the work, and checking it, to finish
 * inside that" (research note 13, finding 2).
 */
export function deliverableNote(missing: readonly string[], style: "plan" | "continue" = "plan"): string {
  const shown = missing.slice(0, DELIVERABLE_FIRST_MAX_NAMED);
  const more = missing.length - shown.length;
  return (
    `These required outputs do not exist yet: ${shown.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}. ` +
    (style === "continue"
      ? `Write a first complete version now, then keep improving it.`
      : `Write a first complete version now, then improve it.`)
  );
}

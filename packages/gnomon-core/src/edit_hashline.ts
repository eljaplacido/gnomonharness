/**
 * `edit_format = "hashline"`: edits addressed by content anchors.
 *
 * The idea is Can Bölük's "The Harness Problem" (2026-02-12,
 * https://blog.can.ac/2026/02/12/the-harness-problem/): `read` tags every line
 * `LINE:HASH|text`, and an edit names the tags it changes instead of
 * reproducing the old text. The model copies two short tokens, not a block of
 * code it can mistype, and an edit against a file that has moved since the
 * read is refused because the tag no longer matches.
 *
 * The spec (pinned by conformance/edit_hashline.json, docs/CONTRACTS.md):
 *  - Lines are split on "\n"; a trailing "\r" is a line ending, not text; the
 *    empty piece after a final "\n" is not a line.
 *  - hash(line) = FNV-1a 32 over the UTF-8 bytes of the text (no "\r"),
 *    xor-folded to 8 bits, written as two lowercase hex digits. A tag is
 *    `${lineNumber}:${hash}`. Two identical lines differ by their number.
 *  - Every anchor in one call is checked against the file as it stands, before
 *    anything is applied. One stale anchor refuses the whole call.
 *
 * Only this file and its callers in tools.ts know the format; the default
 * `str_replace` tool is untouched.
 */
import type { GnomonConfig } from "./config.js";
import { resolveEditVariant, type EditVariant } from "./sweep_knobs.js";

/** What the edit tool offers: its declared variant, or the hashline format. */
export type EditMode = EditVariant | "hashline";

/** `[defaults] edit_format = "hashline"` wins over a declared edit variant. */
export function resolveEditMode(config: GnomonConfig): EditMode {
  const fmt = (config.config.defaults as Record<string, unknown> | undefined)?.edit_format;
  return fmt === "hashline" ? "hashline" : resolveEditVariant(config);
}

/** FNV-1a 32, folded to a byte: two hex digits. */
export function lineHash(text: string): string {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, "utf-8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const folded = (h ^ (h >>> 8) ^ (h >>> 16) ^ (h >>> 24)) & 0xff;
  return folded.toString(16).padStart(2, "0");
}

export const anchorOf = (n: number, text: string): string => `${n}:${lineHash(text)}`;

export interface AnchorLine {
  text: string;
  /** The line ended in "\r\n" (not just "\n"). */
  cr: boolean;
}
export interface AnchorFile {
  lines: AnchorLine[];
  /** The file ends with a newline. */
  finalNewline: boolean;
  /** Any line ends in "\r\n": new lines are written that way. */
  crlf: boolean;
}

export function splitAnchorLines(raw: string): AnchorFile {
  if (raw === "") return { lines: [], finalNewline: false, crlf: false };
  const finalNewline = raw.endsWith("\n");
  const parts = raw.split("\n");
  if (finalNewline) parts.pop();
  const lines = parts.map((p, i) => {
    const cr = p.endsWith("\r") && (i < parts.length - 1 || finalNewline);
    return { text: cr ? p.slice(0, -1) : p, cr };
  });
  return { lines, finalNewline, crlf: raw.includes("\r\n") };
}

export function joinAnchorLines(f: AnchorFile): string {
  if (f.lines.length === 0) return "";
  return f.lines.map((l) => l.text + (l.cr ? "\r" : "")).join("\n") + (f.finalNewline ? "\n" : "");
}

/** The tagged lines `read` shows: `12:a3|text`. */
export function anchoredLines(lines: readonly string[], firstNumber = 1): string[] {
  return lines.map((t, i) => `${anchorOf(firstNumber + i, t)}|${t}`);
}

const ANCHOR = /^\s*(\d+)\s*:\s*([0-9a-fA-F]{2})(?=\||\s|$)/;

export function parseAnchor(s: unknown): { line: number; hash: string } | null {
  if (typeof s !== "string") return null;
  const m = ANCHOR.exec(s);
  return m ? { line: Number(m[1]), hash: m[2].toLowerCase() } : null;
}

export const HASHLINE_OPS = ["replace", "delete", "insert_before", "insert_after"] as const;
type Op = (typeof HASHLINE_OPS)[number];

export type HashlineResult = { ok: true; after: string } | { ok: false; why: string };

interface Splice {
  at: number; // index of the first line removed (or the insertion point)
  del: number;
  add: string[];
  order: number;
}

const brief = (t: string) => (t.length > 80 ? `${t.slice(0, 80)}…` : t);
const STALE_TAIL = "Nothing was edited. Read the file again and use the new anchors.";

/** Apply every edit to `raw`, or refuse the whole call. */
export function applyHashlineEdits(raw: string, edits: unknown, path: string): HashlineResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, why: `edits must be a non-empty array of {op, anchor, end?, text?}. Nothing was edited.` };
  }
  const file = splitAnchorLines(raw);
  const n = file.lines.length;
  if (n === 0) return { ok: false, why: `${path} is empty, so it has no anchors. Use write to give it content.` };

  const check = (spec: unknown, i: number, label: string): { line: number } | string => {
    const a = parseAnchor(spec);
    if (!a) return `edit ${i + 1}: ${label} ${JSON.stringify(spec ?? null)} is not an anchor like 12:a3 (LINE:HASH from read). Nothing was edited.`;
    if (a.line < 1 || a.line > n) {
      return `Stale anchor ${a.line}:${a.hash} (edit ${i + 1}): ${path} has ${n} lines. ${STALE_TAIL}`;
    }
    const now = file.lines[a.line - 1].text;
    if (lineHash(now) !== a.hash) {
      return (
        `Stale anchor ${a.line}:${a.hash} (edit ${i + 1}): line ${a.line} is now ${anchorOf(a.line, now)}|${brief(now)} — ` +
        `${path} changed since it was read, or the anchor was mistyped. ${STALE_TAIL}`
      );
    }
    return { line: a.line };
  };

  const splices: Splice[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] as Record<string, unknown> | null;
    if (!e || typeof e !== "object") return { ok: false, why: `edit ${i + 1} is not an object. Nothing was edited.` };
    const op = e.op as Op;
    if (!HASHLINE_OPS.includes(op)) {
      return { ok: false, why: `edit ${i + 1}: op must be one of ${HASHLINE_OPS.join(", ")}. Nothing was edited.` };
    }
    const start = check(e.anchor, i, "anchor");
    if (typeof start === "string") return { ok: false, why: start };
    let last = start.line;
    if (e.end !== undefined && e.end !== null && e.end !== "") {
      if (op !== "replace" && op !== "delete") {
        return { ok: false, why: `edit ${i + 1}: end applies only to replace and delete. Nothing was edited.` };
      }
      const end = check(e.end, i, "end");
      if (typeof end === "string") return { ok: false, why: end };
      if (end.line < start.line) {
        return { ok: false, why: `edit ${i + 1}: end ${end.line} is before anchor ${start.line}. Nothing was edited.` };
      }
      last = end.line;
    }
    let add: string[] = [];
    if (op !== "delete") {
      if (typeof e.text !== "string") {
        return { ok: false, why: `edit ${i + 1}: ${op} needs text (the new lines). Nothing was edited.` };
      }
      // One trailing newline is the end of the last line, not an extra blank one.
      const t = e.text.endsWith("\r\n") ? e.text.slice(0, -2) : e.text.endsWith("\n") ? e.text.slice(0, -1) : e.text;
      add = t.split(/\r?\n/);
    }
    if (op === "replace" || op === "delete") splices.push({ at: start.line - 1, del: last - start.line + 1, add, order: i });
    else if (op === "insert_before") splices.push({ at: start.line - 1, del: 0, add, order: i });
    else splices.push({ at: start.line, del: 0, add, order: i });
  }

  // Edits are all against the file as read, so two may not touch the same line.
  for (let a = 0; a < splices.length; a++) {
    for (let b = a + 1; b < splices.length; b++) {
      const x = splices[a];
      const y = splices[b];
      const clash =
        x.del > 0 && y.del > 0
          ? x.at < y.at + y.del && y.at < x.at + x.del
          : x.del > 0
            ? y.at > x.at && y.at < x.at + x.del
            : y.del > 0
              ? x.at > y.at && x.at < y.at + y.del
              : false;
      if (clash) {
        return { ok: false, why: `edits ${x.order + 1} and ${y.order + 1} overlap. Merge them into one edit. Nothing was edited.` };
      }
    }
  }

  const out = file.lines.slice();
  const newLine = (t: string): AnchorLine => ({ text: t, cr: file.crlf });
  // Bottom to top, so earlier indexes stay valid. At one point a removal goes first,
  // so an insert there is not removed with it; same-point inserts keep call order.
  const ordered = splices
    .slice()
    .sort((p, q) => q.at - p.at || (p.del > 0 ? 0 : 1) - (q.del > 0 ? 0 : 1) || q.order - p.order);
  for (const s of ordered) out.splice(s.at, s.del, ...s.add.map(newLine));
  // A new last line in a file with no final newline carries no "\r" of its own.
  return { ok: true, after: joinAnchorLines({ lines: out, finalNewline: file.finalNewline, crlf: file.crlf }) };
}

/** `edit`'s parameters under `edit_format = "hashline"`. */
export const HASHLINE_EDIT_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path, relative to the repository root" },
    edits: {
      type: "array",
      description: "Edits applied together to the file as last read. They may not overlap.",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: [...HASHLINE_OPS], description: "replace, delete, insert_before or insert_after" },
          anchor: { type: "string", description: "LINE:HASH of the line, copied from read, e.g. 12:a3" },
          end: { type: "string", description: "Last line of a replace or delete range, as LINE:HASH. Default: anchor only." },
          text: { type: "string", description: "The new lines (replace, insert)" },
        },
        required: ["op", "anchor"],
      },
    },
  },
  required: ["path", "edits"],
};

export const HASHLINE_READ_DESCRIPTION = "Read a file as LINE:HASH|text lines, or list a directory. Text only.";
export const HASHLINE_EDIT_DESCRIPTION =
  "Edit a file by the LINE:HASH anchors read shows. A stale anchor is refused: read again and retry.";

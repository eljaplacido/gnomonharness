/**
 * gnomon-core: How wide is this text, really.
 *
 * Every aligned thing in the terminal — table borders, diagram boxes, wrapped
 * prose — depends on one question: how many columns does this string occupy?
 * Getting it wrong by one puts a table's right edge in the wrong place, and the
 * ways to get it wrong are not obvious:
 *
 *   - escape codes occupy no columns at all
 *   - CJK, Hangul and kana occupy two
 *   - `✅` and `⚠️` occupy two, and are nowhere near the CJK ranges
 *   - a family emoji is five code points joined by ZWJ and occupies two, not ten
 *   - `é` written as `e` + a combining accent is one column, not two
 *
 * So text is split into grapheme clusters first and measured per cluster.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Text with the escape codes removed. */
export function plain(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Grapheme clusters.
 *
 * Intl.Segmenter is what knows that a ZWJ sequence is one cluster. Where it is
 * missing the fallback is code points, which measures a family emoji too wide —
 * a worse table, not a broken one.
 */
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

const EMOJI = /\p{Extended_Pictographic}/u;
const VS16 = "️";

/** Columns one grapheme cluster occupies. */
function clusterWidth(cluster: string): number {
  // An emoji presentation selector settles it: this renders as an emoji, and
  // emoji are double-width. `⚠` is one column, `⚠️` is two.
  if (cluster.includes(VS16)) return 2;
  if (EMOJI.test(cluster)) {
    const c = cluster.codePointAt(0) ?? 0;
    // Text-presentation pictographs below the emoji blocks stay single-width
    // unless a selector said otherwise, which the check above already handled.
    return c >= 0x1f000 || isWideSymbol(c) ? 2 : 1;
  }
  const c = cluster.codePointAt(0) ?? 0;
  return isWide(c) ? 2 : 1;
}

/** Emoji that live among the single-width symbol blocks. */
function isWideSymbol(c: number): boolean {
  return (
    (c >= 0x231a && c <= 0x231b) ||
    (c >= 0x23e9 && c <= 0x23ec) ||
    c === 0x23f0 ||
    c === 0x23f3 ||
    (c >= 0x25fd && c <= 0x25fe) ||
    (c >= 0x2614 && c <= 0x2615) ||
    (c >= 0x2648 && c <= 0x2653) ||
    c === 0x267f ||
    c === 0x2693 ||
    c === 0x26a1 ||
    (c >= 0x26aa && c <= 0x26ab) ||
    (c >= 0x26bd && c <= 0x26be) ||
    (c >= 0x26c4 && c <= 0x26c5) ||
    c === 0x26ce ||
    c === 0x26d4 ||
    c === 0x26ea ||
    (c >= 0x26f2 && c <= 0x26f3) ||
    c === 0x26f5 ||
    c === 0x26fa ||
    c === 0x26fd ||
    c === 0x2705 ||
    (c >= 0x270a && c <= 0x270b) ||
    c === 0x2728 ||
    c === 0x274c ||
    c === 0x274e ||
    (c >= 0x2753 && c <= 0x2755) ||
    c === 0x2757 ||
    (c >= 0x2795 && c <= 0x2797) ||
    c === 0x27b0 ||
    c === 0x27bf ||
    (c >= 0x2b1b && c <= 0x2b1c) ||
    c === 0x2b50 ||
    c === 0x2b55
  );
}

function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/** Columns this string occupies, escape codes excluded. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const cluster of graphemes(plain(text))) width += clusterWidth(cluster);
  return width;
}

/** Pad to `n` visible columns. */
export function padTo(text: string, n: number): string {
  return text + " ".repeat(Math.max(0, n - visibleWidth(text)));
}

// ---------------------------------------------------------------------------
// Cutting styled text
// ---------------------------------------------------------------------------

const SGR_RESET = "\x1b[0m";

/**
 * Cut a styled string at `columns`, and say what was left.
 *
 * Two things have to survive the cut. An escape sequence must never be split
 * down the middle — half of one prints as garbage — and a style that was open
 * at the cut has to be closed on this piece and reopened on the next, or the
 * colour bleeds out across the table border and down the rest of the answer.
 */
export function cut(
  text: string,
  columns: number
): { head: string; tail: string } {
  let head = "";
  let width = 0;
  let active = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*[A-Za-z]/.exec(text.slice(i));
      if (m) {
        head += m[0];
        // Track what is in force so it can be reopened after the break.
        active = m[0] === SGR_RESET ? "" : active + m[0];
        i += m[0].length;
        continue;
      }
    }
    const rest = text.slice(i);
    const cluster = graphemes(rest)[0] ?? rest[0];
    const w = clusterWidth(cluster);
    if (width + w > columns) {
      return {
        head: active ? head + SGR_RESET : head,
        tail: active + text.slice(i),
      };
    }
    head += cluster;
    width += w;
    i += cluster.length;
  }
  return { head, tail: "" };
}

/** Split a styled string into pieces no wider than `columns`. */
export function chop(text: string, columns: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  // Guarded rather than `while (rest)`: a zero-width remainder would spin.
  while (rest && pieces.length < 4096) {
    const { head, tail } = cut(rest, Math.max(1, columns));
    if (!head) break;
    pieces.push(head);
    rest = tail;
  }
  return pieces.length > 0 ? pieces : [""];
}

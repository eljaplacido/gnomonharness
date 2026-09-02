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
/** Text with the escape codes removed. */
export declare function plain(text: string): string;
export declare function graphemes(text: string): string[];
/** Columns this string occupies, escape codes excluded. */
export declare function visibleWidth(text: string): number;
/** Pad to `n` visible columns. */
export declare function padTo(text: string, n: number): string;
/**
 * Cut a styled string at `columns`, and say what was left.
 *
 * Two things have to survive the cut. An escape sequence must never be split
 * down the middle — half of one prints as garbage — and a style that was open
 * at the cut has to be closed on this piece and reopened on the next, or the
 * colour bleeds out across the table border and down the rest of the answer.
 */
export declare function cut(text: string, columns: number): {
    head: string;
    tail: string;
};
/** Split a styled string into pieces no wider than `columns`. */
export declare function chop(text: string, columns: number): string[];
//# sourceMappingURL=width.d.ts.map
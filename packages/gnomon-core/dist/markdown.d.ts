/**
 * gnomon-core: Markdown for a terminal.
 *
 * A model answers in markdown whether or not anything renders it. Printing the
 * source verbatim meant a comparison table arrived as a wall of pipes and
 * `**bold**` arrived with the asterisks still attached — the formatting was
 * there, just never applied.
 *
 * What this is not
 * ----------------
 * Not a CommonMark implementation. It covers what a model actually emits in an
 * answer and leaves anything else exactly as it found it.
 *
 * The rule everything else follows
 * --------------------------------
 * **Never lose the text.** An adversarial pass over the first version of this
 * file found seven ways it silently deleted characters: a citation's
 * parentheses, the backslashes in a Windows path, a code fence that carried a
 * title. Unstyled text is a small disappointment; missing text misrepresents
 * what the model said. Where a construct is ambiguous the tie goes to leaving
 * it alone.
 */
import { ResolvedUi } from "./config.js";
export { visibleWidth, plain } from "./width.js";
/** Fallback when the terminal will not say how wide it is. */
export declare const DEFAULT_WIDTH = 80;
/**
 * Apply inline marks.
 *
 * Code spans are lifted out first, so `**` inside a span stays literal — a
 * model writing about markdown, or about a glob, otherwise gets its own prose
 * reformatted underneath it.
 */
export declare function renderInline(src: string, ui: ResolvedUi): string;
/** Wrap to `width`, measured on the visible text. Words break only if they must. */
export declare function wrap(text: string, width: number, indent?: string): string[];
/**
 * Render an answer.
 *
 * On any internal error the source comes back unchanged: formatting is a
 * convenience, and losing the answer in order to style it would be a poor
 * trade.
 */
export declare function renderMarkdown(src: string, ui: ResolvedUi, width?: number): string[];
//# sourceMappingURL=markdown.d.ts.map
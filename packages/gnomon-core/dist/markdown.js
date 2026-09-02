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
import { paint } from "./render.js";
import { renderDiagram, isDiagramLanguage } from "./diagram.js";
import { visibleWidth, padTo, chop, plain, graphemes } from "./width.js";
export { visibleWidth, plain } from "./width.js";
/** Fallback when the terminal will not say how wide it is. */
export const DEFAULT_WIDTH = 80;
// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------
/**
 * Private-use sentinel for lifted-out code spans.
 *
 * The first version used NUL, reasoning that no answer contains one. Answers
 * contain pasted logs, and a log contains anything — a stray NUL was read back
 * as a span index and replaced real text with an unrelated span. Control
 * characters are stripped at the entry point now, and the sentinel moved to a
 * private-use code point.
 */
const HOLE = "\ue000";
/** Is this parenthesised thing a link target, or just a parenthesis? */
function looksLikeTarget(target) {
    if (!target || /\s/.test(target))
        return false;
    return (/^(https?|ftp|mailto|file):/i.test(target) ||
        target.startsWith("#") ||
        target.startsWith("/") ||
        target.startsWith("./") ||
        target.startsWith("../") ||
        /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(target));
}
/**
 * Apply inline marks.
 *
 * Code spans are lifted out first, so `**` inside a span stays literal — a
 * model writing about markdown, or about a glob, otherwise gets its own prose
 * reformatted underneath it.
 */
export function renderInline(src, ui) {
    const spans = [];
    const lift = (code) => {
        spans.push(paint(ui, "cyan", code));
        return `${HOLE}${spans.length - 1}${HOLE}`;
    };
    // Double-backtick first: it exists precisely so a span can contain a
    // backtick, and taking single backticks first ate the character the longer
    // fence was there to protect.
    let text = src.replace(/``([\s\S]+?)``/g, (_m, code) => lift(code.trim()));
    text = text.replace(/`([^`]+)`/g, (_m, code) => lift(code));
    // Links. The target has to look like one: `[Smith et al.](Nature 2020, vol
    // 5)` is a citation, and reading it as a link threw away everything after the
    // first space.
    text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (whole, label, target) => {
        if (!looksLikeTarget(target))
            return whole;
        if (!label || label === target)
            return target;
        return `${label} ${paint(ui, "gray", `(${target})`)}`;
    });
    text = emphasise(text, "***", "bold", ui);
    text = emphasise(text, "**", "bold", ui);
    text = emphasise(text, "~~", "gray", ui);
    text = emphasise(text, "*", "italic", ui);
    text = emphasise(text, "_", "italic", ui);
    return text.replace(new RegExp(`${HOLE}(\\d+)${HOLE}`, "g"), (whole, i) => spans[Number(i)] ?? whole);
}
/**
 * Apply one paired marker.
 *
 * A marker opens only when it is not followed by whitespace, and closes only
 * when it is not preceded by whitespace and not followed by a word character.
 * Without that last condition `f(**kwargs, **args)` read as one emphasis span
 * and lost both pairs, and `rm *.log` lost its glob to whatever asterisk came
 * next in the paragraph.
 */
function emphasise(text, marker, color, ui) {
    const lit = marker.replace(/[*]/g, "\\*");
    const pattern = new RegExp(`(^|[^\\w\\\\])${lit}(?!\\s)([^\\n]*?[^\\s\\\\])${lit}(?![\\w])`, "g");
    return text.replace(pattern, (whole, lead, bodyText) => {
        // A body still holding the marker means the pairing is ambiguous. Leaving
        // it alone beats guessing which pair the author meant.
        if (bodyText.includes(marker))
            return whole;
        return `${lead}${paint(ui, color, bodyText)}`;
    });
}
/** Wrap to `width`, measured on the visible text. Words break only if they must. */
export function wrap(text, width, indent = "") {
    const room = Math.max(4, width - visibleWidth(indent));
    const out = [];
    let line = "";
    // A token longer than the room has to be broken, or it sets the width of
    // everything around it: one long cell made its whole table 409 columns wide.
    const words = text
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((w) => (visibleWidth(w) <= room ? [w] : chop(w, room)));
    for (const word of words) {
        if (!line) {
            line = word;
        }
        else if (visibleWidth(line) + 1 + visibleWidth(word) <= room) {
            line += ` ${word}`;
        }
        else {
            out.push(indent + line);
            line = word;
        }
    }
    if (line)
        out.push(indent + line);
    return out.length > 0 ? out : [indent];
}
/**
 * Split a table row on its cell boundaries.
 *
 * Only `\|` is an escape. Treating every backslash as one deleted them all, so
 * `C:\Users\me` came out as `C:Usersme` and `\d+\.\d+` as `d+.d+`. A pipe
 * inside a code span belongs to the span, not to the table.
 */
function splitRow(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let cur = "";
    let ticks = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === "\\" && trimmed[i + 1] === "|") {
            cur += "|";
            i++;
        }
        else if (ch === "`") {
            ticks++;
            cur += ch;
        }
        else if (ch === "|" && ticks % 2 === 0) {
            cells.push(cur.trim());
            cur = "";
        }
        else {
            cur += ch;
        }
    }
    cells.push(cur.trim());
    return cells;
}
/** `---`, `:--`, `-:`, `:-:` — one dash is legal GFM and was being rejected. */
function isDivider(line) {
    const t = line.trim();
    if (!t.includes("-") || !t.includes("|"))
        return false;
    const cells = splitRow(t);
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}
function alignments(divider) {
    return splitRow(divider).map((c) => {
        const t = c.trim();
        const left = t.startsWith(":");
        const right = t.endsWith(":");
        if (left && right)
            return "center";
        if (right)
            return "right";
        return "left";
    });
}
/**
 * A continuation row, or prose that happens to contain a pipe?
 *
 * "Note that the a|b form is also accepted." was being absorbed as a row and
 * split across two cells. A real row starts with a pipe, or has as many cell
 * boundaries as the header did.
 */
function isTableRow(line, columns, fenced) {
    if (!line.trim())
        return false;
    if (line.trim().startsWith("|"))
        return true;
    // "Note the a|b form is accepted." splits into exactly as many cells as a
    // two-column header, so cell count alone cannot tell them apart. When the
    // header carried outer pipes — as a model's tables always do — a row without
    // them is prose.
    if (fenced)
        return false;
    return line.includes("|") && splitRow(line).length >= columns;
}
/** Draw a table with box-drawing characters, sized to the terminal. */
function renderTable(head, align, rows, ui, width) {
    const cols = Math.max(head.length, ...rows.map((r) => r.length));
    const grid = [head, ...rows].map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ""));
    const alignOf = (i) => align[i] ?? "left";
    // Header cells go through the same renderer as the body. Measuring them one
    // way and drawing them another put `**Fl` / `ag**` inside the box and left
    // every row a different width.
    const painted = grid.map((r, rowIndex) => r.map((c) => {
        const inline = renderInline(c.replace(/<br\s*\/?>/gi, " "), ui);
        return rowIndex === 0 ? paint(ui, "bold", inline) : inline;
    }));
    const natural = Array.from({ length: cols }, (_, i) => Math.max(1, ...painted.map((r) => visibleWidth(r[i]))));
    // Frame overhead: a leading "| ", " | " between each pair, a trailing " |",
    // and the two-space indent every block here carries.
    const overhead = 3 * cols + 1 + 2;
    const room = Math.max(cols, width - overhead);
    const widths = [...natural];
    let total = widths.reduce((a, b) => a + b, 0);
    // Shave the widest column until it fits. The floor is one column, not four:
    // with four, a six-column table could never reach the target and gave up,
    // running 45 columns past the edge of a narrow terminal.
    while (total > room) {
        const widest = widths.indexOf(Math.max(...widths));
        if (widths[widest] <= 1)
            break;
        widths[widest] -= 1;
        total -= 1;
    }
    // A frame for this many columns does not fit, however hard the content is
    // squeezed: six columns cost 21 columns of border alone. Drawing it anyway
    // put 27 columns into a 24-column terminal, so the table becomes a list.
    if (overhead + cols > width) {
        return asRecords(painted, widths.length, width, ui);
    }
    const rule = (l, m, r) => paint(ui, "gray", l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
    const bar = paint(ui, "gray", "│");
    const emit = (cells) => {
        const parts = cells.map((c, i) => visibleWidth(c) <= widths[i] ? [c] : wrap(c, widths[i]));
        const height = Math.max(...parts.map((p) => p.length));
        const out = [];
        for (let h = 0; h < height; h++) {
            const row = parts.map((p, i) => {
                const cellText = p[h] ?? "";
                const slack = Math.max(0, widths[i] - visibleWidth(cellText));
                if (alignOf(i) === "right")
                    return " ".repeat(slack) + cellText;
                if (alignOf(i) === "center") {
                    const left = Math.floor(slack / 2);
                    return " ".repeat(left) + padTo(cellText, widths[i] - left);
                }
                return padTo(cellText, widths[i]);
            });
            out.push(`${bar} ${row.join(` ${bar} `)} ${bar}`);
        }
        return out;
    };
    return [
        rule("┌", "┬", "┐"),
        ...emit(painted[0]),
        rule("├", "┼", "┤"),
        ...painted.slice(1).flatMap(emit),
        rule("└", "┴", "┘"),
    ].map((l) => `  ${l}`);
}
/**
 * A table too narrow to frame, rendered as one labelled record per row.
 *
 * Still every value the model wrote, still aligned to its heading — just not in
 * a box, because the box would not fit.
 */
function asRecords(painted, cols, width, ui) {
    const heads = painted[0];
    const out = [];
    for (const row of painted.slice(1)) {
        for (let i = 0; i < cols; i++) {
            const label = plain(heads[i] ?? `${i + 1}`);
            const value = row[i] ?? "";
            if (!plain(value).trim())
                continue;
            const lead = `  ${paint(ui, "gray", `${label}:`)} `;
            const pieces = wrap(value, Math.max(8, width - label.length - 4));
            out.push(`${lead}${pieces[0]}`);
            for (const rest of pieces.slice(1))
                out.push(`  ${" ".repeat(label.length + 2)}${rest}`);
        }
        out.push("");
    }
    while (out.length && out[out.length - 1] === "")
        out.pop();
    return out;
}
// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------
const HEADING_COLOR = ["cyan", "cyan", "bold", "bold", "bold", "bold"];
/** Bullet glyphs a model reaches for in place of a dash. */
const EMOJI_BULLET = /^(\s*)([\u{1F300}-\u{1FAFF}\u2022\u25AA\u25CF\u27A1\u2705\u274C\u2192](?:\ufe0f)?)\s+(\S.*)$/u;
/**
 * Render an answer.
 *
 * On any internal error the source comes back unchanged: formatting is a
 * convenience, and losing the answer in order to style it would be a poor
 * trade.
 */
export function renderMarkdown(src, ui, width = DEFAULT_WIDTH) {
    try {
        // Control characters cannot render and can collide with the code-span
        // sentinel, so they go before anything else looks at the text.
        // eslint-disable-next-line no-control-regex
        const clean = src.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ue000]/g, "");
        return renderBlocks(clean, ui, Math.max(24, width));
    }
    catch {
        return src.split("\n");
    }
}
/** Is this line ordinary prose — the continuation of a paragraph? */
function isProse(line, next) {
    if (!line.trim())
        return false;
    if (/^\s*(`{3,}|~{3,})/.test(line) ||
        /^#{1,6}\s+/.test(line) ||
        /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
        /^\s*>/.test(line) ||
        /^\s*([-*+])\s+/.test(line) ||
        /^\s*\d+[.)]\s+/.test(line) ||
        EMOJI_BULLET.test(line) ||
        /^\s{4,}\S/.test(line)) {
        return false;
    }
    // A setext underline belongs to the paragraph above and ends it.
    if (/^\s*(={2,}|-{2,})\s*$/.test(line))
        return false;
    // A pipe ends a paragraph only when this really is a table header. The old
    // rule cut at any pipe at all and stranded emphasis markers either side.
    if (line.includes("|") && next !== undefined && isDivider(next))
        return false;
    return true;
}
function renderBlocks(src, ui, width) {
    const lines = src.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    const body = Math.max(20, width - 2);
    const blank = () => {
        if (out.length && out[out.length - 1] !== "")
            out.push("");
    };
    const codeLine = (text) => `  ${paint(ui, "gray", "│")} ${paint(ui, "cyan", text)}`;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Fenced code, and diagrams, which are a fence with a language. The info
        // string may carry more than a language — ```js title="a.js" — and reading
        // only a bare word meant the fence went unrecognised, so the code was
        // reflowed as prose and its closing fence swallowed the rest of the answer.
        const fence = line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
        if (fence) {
            const marker = fence[1][0] === "`" ? "`" : "~";
            const lang = (fence[2] ?? "").trim().split(/\s+/)[0] ?? "";
            const block = [];
            i++;
            while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
                block.push(lines[i]);
                i++;
            }
            blank();
            if (isDiagramLanguage(lang)) {
                out.push(...renderDiagram(block.join("\n"), ui, body));
            }
            else {
                if (lang)
                    out.push(paint(ui, "gray", `  ${lang}`));
                // Long code lines are cut, not reflowed: a wrapped line of code is a
                // different line of code.
                for (const l of block) {
                    for (const piece of chop(l || " ", Math.max(8, body - 4))) {
                        out.push(codeLine(piece));
                    }
                }
            }
            out.push("");
            continue;
        }
        // Indented code. Reflowing it as prose destroyed its newlines and every bit
        // of its indentation.
        if (/^\s{4,}\S/.test(line) && (i === 0 || !lines[i - 1].trim())) {
            const block = [];
            while (i < lines.length && /^\s{4,}\S/.test(lines[i])) {
                block.push(lines[i].replace(/^ {4}|^\t/, ""));
                i++;
                if (i < lines.length && !lines[i].trim() && /^\s{4,}\S/.test(lines[i + 1] ?? "")) {
                    block.push("");
                    i++;
                }
            }
            i--;
            blank();
            for (const l of block) {
                for (const p of chop(l || " ", Math.max(8, body - 4)))
                    out.push(codeLine(p));
            }
            out.push("");
            continue;
        }
        // Table: a row of pipes with a divider under it.
        if (line.includes("|") && i + 1 < lines.length && isDivider(lines[i + 1])) {
            const head = splitRow(line);
            const align = alignments(lines[i + 1]);
            const rows = [];
            i += 2;
            const fenced = line.trim().startsWith("|");
            while (i < lines.length && isTableRow(lines[i], head.length, fenced)) {
                rows.push(splitRow(lines[i]));
                i++;
            }
            i--;
            blank();
            out.push(...renderTable(head, align, rows, ui, width));
            out.push("");
            continue;
        }
        // Setext heading: a title with === or --- under it. The underline used to
        // be glued onto the title as literal text.
        const under = lines[i + 1];
        if (line.trim() &&
            under !== undefined &&
            /^\s*(={2,}|-{2,})\s*$/.test(under) &&
            !/^\s*[-*+]\s/.test(line) &&
            !line.includes("|") &&
            !/^\s{4,}\S/.test(line)) {
            const text = renderInline(line.trim(), ui);
            blank();
            for (const l of wrap(text, body, "  "))
                out.push(paint(ui, "cyan", l));
            out.push(paint(ui, "gray", `  ${"─".repeat(Math.min(body, visibleWidth(text)))}`));
            i++;
            continue;
        }
        // ATX heading. The optional closing hashes are syntax, not title.
        const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (heading) {
            const level = heading[1].length;
            const text = renderInline(heading[2].trim(), ui);
            blank();
            for (const l of wrap(text, body, "  ")) {
                out.push(paint(ui, HEADING_COLOR[level - 1], l));
            }
            if (level <= 2) {
                out.push(paint(ui, "gray", `  ${"─".repeat(Math.min(body, visibleWidth(text)))}`));
            }
            continue;
        }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            blank();
            out.push(paint(ui, "gray", `  ${"─".repeat(Math.min(body, 60))}`));
            out.push("");
            continue;
        }
        // Block quote, gathered whole and rendered as its own document: doing its
        // lines one at a time leaked markers across a soft wrap and left any list
        // inside it raw.
        if (/^\s*>/.test(line)) {
            const quoted = [];
            while (i < lines.length && /^\s*>/.test(lines[i])) {
                quoted.push(lines[i].replace(/^\s*>\s?/, ""));
                i++;
            }
            i--;
            blank();
            for (const l of renderBlocks(quoted.join("\n"), ui, body - 2)) {
                out.push(`  ${paint(ui, "gray", "│")} ${l.replace(/^ {2}/, "")}`);
            }
            continue;
        }
        const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/) ?? line.match(EMOJI_BULLET);
        if (bullet) {
            const isEmoji = !/^[-*+]$/.test(bullet[2]);
            const depth = indentDepth(bullet[1]);
            const lead = `  ${"  ".repeat(depth)}`;
            // A model's own emoji marker is kept: it chose that glyph, and replacing
            // it with a dot discards a distinction it was drawing.
            const glyph = paint(ui, "cyan", isEmoji ? bullet[2] : depth % 2 === 0 ? "•" : "◦");
            const hang = " ".repeat(visibleWidth(glyph) + 1);
            const wrapped = wrap(renderInline(bullet[3], ui), Math.max(12, body - lead.length - hang.length));
            out.push(`${lead}${glyph} ${wrapped[0]}`);
            for (const rest of wrapped.slice(1))
                out.push(`${lead}${hang}${rest}`);
            continue;
        }
        const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
        if (numbered) {
            const depth = indentDepth(numbered[1]);
            const lead = `  ${"  ".repeat(depth)}`;
            const marker = `${numbered[2]}.`;
            const hang = " ".repeat(marker.length + 1);
            const wrapped = wrap(renderInline(numbered[3], ui), Math.max(12, body - lead.length - hang.length));
            out.push(`${lead}${paint(ui, "cyan", marker)} ${wrapped[0]}`);
            for (const rest of wrapped.slice(1))
                out.push(`${lead}${hang}${rest}`);
            continue;
        }
        if (!line.trim()) {
            blank();
            continue;
        }
        // Gather the whole paragraph before applying any marks. A model soft-wraps
        // its prose, so `**strict, policy-driven\nexecution engine**` is one span
        // across two source lines — rendering line by line left those asterisks in
        // the output, which is the complaint that started this.
        const para = [line.trim()];
        while (i + 1 < lines.length && isProse(lines[i + 1], lines[i + 2])) {
            i++;
            para.push(lines[i].trim());
        }
        out.push(...wrap(renderInline(para.join(" "), ui), body, "  "));
    }
    while (out.length && out[out.length - 1] === "")
        out.pop();
    return out;
}
/**
 * Nesting depth from leading whitespace.
 *
 * Two spaces and four both mean one level in. Dividing by two gave a four-space
 * sub-item the same glyph as a top-level one, because the alternation landed
 * back where it started.
 */
function indentDepth(indent) {
    const columns = graphemes(indent.replace(/\t/g, "    ")).length;
    if (columns === 0)
        return 0;
    return Math.min(4, columns >= 4 ? Math.floor(columns / 4) : 1);
}
//# sourceMappingURL=markdown.js.map
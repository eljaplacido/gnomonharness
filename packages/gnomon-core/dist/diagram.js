/**
 * gnomon-core: Mermaid graphs as terminal drawings.
 *
 * A model asked to explain something reaches for a diagram, and a diagram
 * arriving as a fenced block of `A --> B` is a picture the reader has to draw
 * in their head. This turns the common shapes into boxes and arrows.
 *
 * Scope, stated rather than implied
 * ---------------------------------
 * `graph` / `flowchart` only, in `TD`/`TB` (down) or `LR`/`RL` (across). Node
 * shapes `[]`, `()`, `{}`, `(())` and `>]` are read for their label; the label
 * is what a terminal can show, not the shape. Edge labels are drawn.
 *
 * Anything else — sequence diagrams, class diagrams, state charts, subgraphs —
 * is printed as its source, framed and labelled with the reason. That is the
 * honest outcome: a diagram this cannot lay out is still information, and
 * inventing a picture for it would be worse than showing what the model wrote.
 */
import { paint } from "./render.js";
import { visibleWidth, chop } from "./width.js";
/** Fence languages this module will attempt. */
const LANGUAGES = new Set(["mermaid", "graph", "flowchart", "diagram"]);
export function isDiagramLanguage(lang) {
    return LANGUAGES.has(lang.trim().toLowerCase());
}
// One node: an id, optionally followed by a shape carrying its label.
// A hyphen may appear inside an id but never doubled: `-` used to be a plain id
// character, so `A-->B` and `A---B` were swallowed whole and drawn as one box
// labelled "A-->B".
const NODE_ID = /^([A-Za-z0-9_.]+(?:-(?!-)[A-Za-z0-9_.]+)*)\s*/;
/** Which character closes each shape opener. */
const CLOSERS = { "[": "]", "(": ")", "{": "}", ">": "]" };
/**
 * Read one node: an id, and the label its shape carries.
 *
 * The label is scanned with a depth counter rather than matched by a regex. A
 * non-greedy match stopped at the first closing bracket, so `A[read x[0]]` lost
 * its `]` and came out as `read x[0` — text the model wrote, gone.
 */
function readNode(src) {
    const head = src.match(NODE_ID);
    if (!head)
        return null;
    let i = head[0].length;
    const opener = src[i];
    if (!opener || !(opener in CLOSERS))
        return { id: head[1], length: i };
    const closer = CLOSERS[opener];
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
        if (src[i] === opener)
            depth++;
        else if (src[i] === closer) {
            depth--;
            if (depth === 0) {
                // Strip exactly as many delimiters as the shape opened with. A greedy
                // trailing strip took the inner bracket too: `A[read x[0]]` came back
                // as `read x[0`.
                const whole = src.slice(start, i + 1);
                let shape = 0;
                while (whole[shape] === opener)
                    shape++;
                const raw = whole.slice(shape, whole.length - shape);
                return {
                    id: head[1],
                    label: raw.trim().replace(/^["']|["']$/g, "") || undefined,
                    length: i + 1,
                };
            }
        }
    }
    return null; // an opener with no closer is not something to guess at
}
// One arrow, with an optional |label| after it.
const ARROW = /^\s*(-{2,}>|-\.-+>|={2,}>|-{2,}-|-\.-+|={2,}=)\s*(?:\|([^|]*)\|\s*)?/;
/**
 * Read one statement, which may chain: `A --> B --> C`.
 *
 * Chains are how anyone writes a pipeline, and taking only the first arrow
 * dropped every stage after it — a five-stage flow rendered as two boxes.
 * Returns null when the line is not a chain of nodes and arrows.
 */
function parseChain(line) {
    let rest = line.trim().replace(/;\s*$/, "");
    const steps = [];
    let via;
    for (;;) {
        const node = readNode(rest);
        if (!node)
            return null;
        steps.push({ id: node.id, label: node.label, via });
        rest = rest.slice(node.length);
        if (!rest.trim())
            return steps.length >= 1 ? steps : null;
        const arrow = rest.match(ARROW);
        if (!arrow)
            return null;
        via = { label: arrow[2]?.trim() || undefined, dotted: arrow[1].includes(".") };
        rest = rest.slice(arrow[0].length);
        if (!rest.trim())
            return null; // an arrow pointing at nothing
    }
}
/** Read the subset. Returns null when the source is something else. */
export function parseGraph(src) {
    const lines = src
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("%%"));
    if (lines.length === 0)
        return null;
    const header = lines[0].match(/^(?:graph|flowchart)\s+(TD|TB|LR|RL|BT)\s*$/i);
    if (!header)
        return null;
    const dir = header[1].toUpperCase();
    const labels = new Map();
    const edges = [];
    const order = [];
    const see = (id, label) => {
        if (!order.includes(id))
            order.push(id);
        if (label && label.trim())
            labels.set(id, label.trim().replace(/^["']|["']$/g, ""));
    };
    for (const line of lines.slice(1)) {
        // Subgraphs and styling are not laid out; their presence means this graph
        // is beyond the subset and the caller should show the source instead.
        if (/^(subgraph|end|style|classDef|class|click|linkStyle)\b/i.test(line))
            return null;
        const chain = parseChain(line);
        if (!chain)
            return null; // a line this cannot read means the graph is not the subset
        chain.forEach((step, n) => {
            see(step.id, step.label);
            if (n > 0 && step.via) {
                edges.push({
                    from: chain[n - 1].id,
                    to: step.id,
                    label: step.via.label,
                    dotted: step.via.dotted,
                });
            }
        });
    }
    if (order.length === 0)
        return null;
    return {
        direction: dir === "LR" || dir === "RL" ? "across" : "down",
        labels,
        edges,
        order,
    };
}
const text = (g, id) => g.labels.get(id) ?? id;
/** Identity of one edge, including its label, so parallel edges stay distinct. */
const edgeKey = (e) => `${e.from}\u0000${e.to}\u0000${e.label ?? ""}`;
/** Longest-path layering: a node sits one level below its deepest parent. */
function layers(g) {
    const depth = new Map();
    for (const id of g.order)
        depth.set(id, 0);
    // Repeat until stable, capped so a cycle cannot spin here.
    for (let pass = 0; pass < g.order.length + 1; pass++) {
        let moved = false;
        for (const e of g.edges) {
            const want = (depth.get(e.from) ?? 0) + 1;
            if (want > (depth.get(e.to) ?? 0)) {
                depth.set(e.to, want);
                moved = true;
            }
        }
        if (!moved)
            break;
    }
    const out = [];
    for (const id of g.order) {
        const d = Math.min(depth.get(id) ?? 0, g.order.length - 1);
        (out[d] ??= []).push(id);
    }
    return out.filter(Boolean);
}
function box(label, ui) {
    const w = visibleWidth(label);
    return [
        paint(ui, "gray", `┌${"─".repeat(w + 2)}┐`),
        `${paint(ui, "gray", "│")} ${paint(ui, "bold", label)} ${paint(ui, "gray", "│")}`,
        paint(ui, "gray", `└${"─".repeat(w + 2)}┘`),
    ];
}
/** Place blocks side by side, padded to equal height. */
function beside(blocks, gap) {
    const height = Math.max(...blocks.map((b) => b.length));
    const widths = blocks.map((b) => Math.max(...b.map(visibleWidth)));
    const out = [];
    for (let r = 0; r < height; r++) {
        out.push(blocks
            .map((b, i) => {
            const line = b[r] ?? "";
            return line + " ".repeat(Math.max(0, widths[i] - visibleWidth(line)));
        })
            .join(" ".repeat(gap))
            .replace(/\s+$/, ""));
    }
    return out;
}
/** Down: layers stacked, each node a box, arrows between the layers. */
function drawDown(g, ui, width) {
    const rows = layers(g);
    const out = [];
    for (let i = 0; i < rows.length; i++) {
        const boxes = rows[i].map((id) => box(text(g, id), ui));
        const rendered = beside(boxes, 3);
        if (Math.max(...rendered.map(visibleWidth)) > width)
            return [];
        out.push(...rendered);
        if (i === rows.length - 1)
            break;
        // Edge labels crossing from this layer to the next, named rather than
        // positioned: placing them on the connector needs column arithmetic per
        // arrow, and a wrong label on a right arrow is worse than a listed one.
        const crossing = g.edges.filter((e) => rows[i].includes(e.from) && rows[i + 1].includes(e.to));
        // No edge across this gap means no connector. A cycle puts two layers next
        // to each other with nothing between them, and drawing an arrow there
        // asserts an edge the graph does not contain.
        if (crossing.length === 0) {
            out.push("");
            continue;
        }
        const dotted = crossing.every((e) => e.dotted);
        out.push(paint(ui, "gray", `  ${dotted ? "┊" : "│"}`));
        for (const e of crossing.filter((e) => e.label)) {
            const note = `${text(g, e.from)} → ${text(g, e.to)}: ${e.label}`;
            for (const piece of chop(note, Math.max(8, width - 4))) {
                out.push(`  ${paint(ui, "gray", dotted ? "┊" : "│")} ${paint(ui, "gray", piece)}`);
            }
        }
        out.push(paint(ui, "gray", "  ▼"));
    }
    // Edges the layering did not put between adjacent rows — back-edges and
    // long hops. Listing them is honest; drawing them is not something a
    // fixed-width grid does well.
    const adjacent = new Set();
    for (let i = 0; i < rows.length - 1; i++) {
        for (const e of g.edges) {
            if (rows[i].includes(e.from) && rows[i + 1].includes(e.to)) {
                adjacent.add(`${e.from} ${e.to}`);
            }
        }
    }
    const extra = g.edges.filter((e) => !adjacent.has(`${e.from} ${e.to}`));
    if (extra.length > 0) {
        out.push("");
        for (const e of extra) {
            const note = `  ${text(g, e.from)} ${e.dotted ? "┄▶" : "──▶"} ${text(g, e.to)}` +
                (e.label ? `  (${e.label})` : "");
            for (const piece of chop(note, Math.max(8, width))) {
                out.push(paint(ui, "gray", piece));
            }
        }
    }
    return out;
}
/** Across: a chain of boxes joined by arrows, wrapping when it runs out of room. */
function drawAcross(g, ui, width) {
    const rows = layers(g);
    if (rows.some((r) => r.length > 1))
        return drawDown(g, ui, width);
    const chain = [];
    for (let i = 0; i < rows.length; i++) {
        chain.push(box(text(g, rows[i][0]), ui));
        if (i < rows.length - 1) {
            const e = g.edges.find((x) => x.from === rows[i][0] && x.to === rows[i + 1][0]);
            const arrow = e?.dotted ? "┄▶" : "──▶";
            chain.push(["", paint(ui, "gray", e?.label ? `${arrow} ${e.label}` : arrow), ""]);
        }
    }
    const drawn = beside(chain, 1);
    if (Math.max(...drawn.map(visibleWidth)) > width)
        return drawDown(g, ui, width);
    // Every edge the spine does not represent — a bypass, a second label between
    // the same pair — listed rather than dropped. Silently keeping one of two
    // labels the author wrote is indistinguishable from them writing only one.
    const spine = new Set();
    for (let i = 0; i < rows.length - 1; i++) {
        const e = g.edges.find((x) => x.from === rows[i][0] && x.to === rows[i + 1][0]);
        if (e)
            spine.add(edgeKey(e));
    }
    const extra = g.edges.filter((e) => !spine.has(edgeKey(e)));
    if (extra.length === 0)
        return drawn;
    return [
        ...drawn,
        "",
        ...extra.flatMap((e) => chop(`${text(g, e.from)} ${e.dotted ? "┄▶" : "──▶"} ${text(g, e.to)}` +
            (e.label ? `  (${e.label})` : ""), Math.max(8, width)).map((piece) => paint(ui, "gray", piece))),
    ];
}
/**
 * Render a fenced diagram.
 *
 * Never throws and never drops the content: whatever cannot be laid out is
 * returned as its own source, framed, with the reason stated.
 */
export function renderDiagram(src, ui, width) {
    const asSource = (why) => {
        const rows = src.split("\n");
        if (rows.every((l) => !l.trim())) {
            return chop(`  mermaid — ${why}`, Math.max(8, width)).map((p) => paint(ui, "gray", p));
        }
        return [
            ...chop(`  mermaid — ${why}`, Math.max(8, width)).map((p) => paint(ui, "gray", p)),
            ...rows.flatMap((l) => chop(l || " ", Math.max(8, width - 4)).map((piece) => `  ${paint(ui, "gray", "│")} ${paint(ui, "cyan", piece)}`)),
        ];
    };
    let graph;
    try {
        graph = parseGraph(src);
    }
    catch {
        return asSource("could not be read");
    }
    if (!graph) {
        return asSource("only graph/flowchart in TD, TB, LR, RL or BT is drawn");
    }
    try {
        const drawn = graph.direction === "across"
            ? drawAcross(graph, ui, width)
            : drawDown(graph, ui, width);
        if (drawn.length === 0)
            return asSource("too wide for this terminal");
        return drawn.map((l) => `  ${l}`);
    }
    catch {
        return asSource("could not be laid out");
    }
}
//# sourceMappingURL=diagram.js.map
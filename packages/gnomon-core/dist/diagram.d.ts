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
import { ResolvedUi } from "./config.js";
export declare function isDiagramLanguage(lang: string): boolean;
interface Edge {
    from: string;
    to: string;
    label?: string;
    /** A dotted edge (`-.->`) is drawn dotted. */
    dotted?: boolean;
}
interface Graph {
    direction: "down" | "across";
    labels: Map<string, string>;
    edges: Edge[];
    order: string[];
}
/** Read the subset. Returns null when the source is something else. */
export declare function parseGraph(src: string): Graph | null;
/**
 * Render a fenced diagram.
 *
 * Never throws and never drops the content: whatever cannot be laid out is
 * returned as its own source, framed, with the reason stated.
 */
export declare function renderDiagram(src: string, ui: ResolvedUi, width: number): string[];
export {};
//# sourceMappingURL=diagram.d.ts.map
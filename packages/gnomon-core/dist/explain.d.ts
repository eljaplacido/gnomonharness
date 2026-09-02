/**
 * gnomon-core: Self-explanation
 *
 * `/explain <topic>` answers three questions about a feature, in order:
 * what it is, how *this* repository currently has it set, and what to do next.
 *
 * The middle one is the point. Documentation explains the feature in the
 * abstract; a reader then has to work out whether any of it applies to the
 * project in front of them. These explanations read the live surface, so
 * "approval is on_write" is a fact about your repository rather than a default
 * someone might have changed.
 *
 * No model call: an explanation that varied run to run would be a poor way to
 * learn what a deterministic harness does.
 */
import { GnomonConfig } from "./config.js";
export interface Explanation {
    topic: string;
    /** One line for the topic list */
    summary: string;
    /** What it is */
    what: string[];
    /** How this repository has it — read from the live surface */
    here: string[];
    /** What to do with it */
    next: string[];
}
export declare function explainTopics(): Array<{
    topic: string;
    summary: string;
}>;
/** Build the explanation for a topic, or null when it is not one. */
export declare function explain(config: GnomonConfig, role: string, topic: string): Explanation | null;
/** Topic names, for completion and the index. */
export declare function topicNames(): string[];
//# sourceMappingURL=explain.d.ts.map
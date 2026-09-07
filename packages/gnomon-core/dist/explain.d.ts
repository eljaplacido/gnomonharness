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
/**
 * The one-line summary for every topic — the single source of truth.
 *
 * There were two. Each builder carried a `summary:` string literal, and this
 * map restated them for the `/explain` index, which is the only place the
 * one-liner is shown as a list. Three topics were never added to the map, so
 * `/explain` printed:
 *
 *     /explain routing
 *     /explain sandbox
 *     /explain verify
 *
 * with nothing after the name, while `/explain routing` itself rendered its
 * summary correctly. A duplicated string is a string that will disagree with
 * itself; the builders now read from here, and `TOPICS` is keyed by this
 * object, so a topic with no summary — or a summary with no topic — does not
 * compile.
 */
declare const SUMMARIES: {
    readonly approval: "Which tool calls need your sign-off before they run";
    readonly audit: "A tamper-evident record of what happened and who approved it";
    readonly context: "How much of the conversation the model still sees";
    readonly endpoints: "Where inference goes — local, or any OpenAI-shaped API";
    readonly manifest: "The content hash of everything that decides how the agent behaves";
    readonly roles: "Who answers a turn, and what they are allowed to touch";
    readonly routing: "Which role answers a turn, and why that is a declared rule rather than a judgement";
    readonly sandbox: "What the level actually confines — and what it does not";
    readonly sessions: "Conversations survive closing the terminal";
    readonly skills: "Notes the repository keeps about itself, reused every session";
    readonly tools: "What the agent can actually do, and what it cannot";
    readonly verify: "The one check that can contradict the model's account of its own work";
};
export type ExplainTopic = keyof typeof SUMMARIES;
export declare function explainTopics(): Array<{
    topic: ExplainTopic;
    summary: string;
}>;
/** Build the explanation for a topic, or null when it is not one. */
export declare function explain(config: GnomonConfig, role: string, topic: string): Explanation | null;
/** Topic names, for completion and the index. */
export declare function topicNames(): string[];
export {};
//# sourceMappingURL=explain.d.ts.map
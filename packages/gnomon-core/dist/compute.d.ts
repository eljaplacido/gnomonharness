/**
 * gnomon-core: deterministic arithmetic
 *
 * A model asked for a number will produce one whether or not it computed it.
 * That is the single most reliable way for a confident-sounding answer to be
 * wrong, and no amount of prompting fixes it — so the harness offers a tool
 * that does the arithmetic and instructs the model to use it.
 *
 * Two constraints shape the implementation, and both rule out the obvious
 * approaches:
 *
 *   * No `eval`, no `Function`. The input is model-authored text arriving from
 *     an inference endpoint; handing it to a JavaScript evaluator makes every
 *     arithmetic question a remote code execution primitive.
 *   * No shelling out to `python3 -c` or `bc`. Rule 1 forbids machine-scoped
 *     configuration, and "whichever interpreter this machine happens to have"
 *     is exactly that: the same expression would answer differently on two
 *     checkouts, or fail on one of them.
 *
 * So: a small recursive-descent parser over exact decimal arithmetic. Values
 * are scaled BigInts, which is what makes `0.1 + 0.2` return `0.3` rather than
 * `0.30000000000000004` — a float answer to a money question is the kind of
 * wrong that survives review.
 */
export declare class ComputeError extends Error {
}
/**
 * Evaluate an arithmetic expression exactly.
 *
 * Throws {@link ComputeError} with a reason a model can act on, never a raw
 * parser exception.
 */
export declare function compute(expression: string): string;
//# sourceMappingURL=compute.d.ts.map
/**
 * The degradation contract — every way this harness carries on with less than
 * it declared, named in one place.
 *
 * Why a list at all. gnomon has many degradation paths and each one was
 * individually honest: the endpoint falls back, compaction drops turns and says
 * so, over-long output spills to a file, a check that cannot run is reported as
 * unrunnable rather than as a pass. Nothing listed them together, so nobody
 * could answer "what does this harness do when it is having a bad day" without
 * reading the loop. A degradation path that no document knows about is one
 * nobody reviews.
 *
 * Why it carries ids. `benchmarks/degradation-contract` reads THIS list and
 * fails when a declared path does not fire, or fires without being recorded.
 * If the registry lived in the benchmark, the benchmark would be measuring its
 * own copy of the truth — the failure mode `docs/EVIDENCE.md` exists to
 * prevent. The code declares; the benchmark checks the declaration against
 * behaviour.
 *
 * Two properties, not one. `fault-disclosure` asks whether the operator was
 * TOLD. This asks that and one more: whether the trail RECORDS it. They come
 * apart, and the gap is not academic — measured 2026-09-05, three of the paths
 * below announced themselves on the terminal and appeared nowhere in the audit
 * trail, so a `gnomon task` run in a script degraded silently as far as anyone
 * reading the record afterwards could tell.
 */
/**
 * Every declared degradation. Adding a path here without wiring it makes
 * `benchmarks/degradation-contract` fail, which is the intended direction: the
 * list is the contract, and an unkept contract should break something.
 */
export declare const DEGRADATIONS: {
    readonly endpoint_fallback: "the role's primary endpoint could not be reached, so its declared fallback answered instead";
    readonly endpoint_tools_rejected: "the endpoint refused the tools array, so the turn was retried without tools";
    readonly mcp_server_unreachable: "a declared MCP server did not connect, so its tools are absent from this session";
    readonly context_turns_dropped: "the context window could not fit every prior turn, so the oldest were dropped outright";
    readonly context_summary_role_unreachable: "compaction is declared as `summary` but the summary role is unreachable, so turns were dropped rather than folded";
    readonly tool_output_spilled: "a tool produced more output than the window allows, so it was written to a file and truncated in the transcript";
    readonly verify_unrunnable: "the declared verify command could not run, so the turn was neither passed nor handed back";
    readonly verify_declined: "the operator declined the verify command, so no check ran for this turn";
    readonly bash_timeout: "a command exceeded the tool timeout and was killed; the output captured before the kill is kept";
    readonly bash_timeout_repeat_refused: "an identical command already timed out this turn, so re-running it was refused rather than repeated";
    readonly surface_drift: "a command changed `.gnomon/` mid-turn, so the surface no longer matches the hash this session was stamped with";
    readonly model_output_truncated: "the backend cut the completion off at its token limit, so the answer is incomplete";
};
/** The id of a declared degradation path. */
export type DegradationId = keyof typeof DEGRADATIONS;
/** Every declared id, in declaration order. */
export declare const DEGRADATION_IDS: DegradationId[];
/**
 * The fields every `degradation` audit record carries.
 *
 * `declared` and `actual` are separate on purpose. "Fell back to model X" does
 * not tell a reader afterwards what was supposed to happen, and the whole value
 * of the record is the difference between the two.
 */
export interface DegradationFields {
    id: DegradationId;
    /** What the surface declared. */
    declared: string;
    /** What happened instead. */
    actual: string;
    /** Anything a reader would need to act on it. Kept small and flat. */
    detail?: Record<string, unknown>;
}
/** Minimal shape of the audit trail this module needs. Keeps the import one-way. */
export interface DegradationSink {
    write(kind: "degradation", fields: Record<string, unknown>): void;
}
/**
 * Record a degradation.
 *
 * Deliberately does NOT print. The operator-visible wording at each site was
 * written for that site — `fault-disclosure` asserts on several of those exact
 * sentences — and routing them through one formatter would flatten wording that
 * was chosen carefully and, worse, would make this helper a place where a
 * message could be lost. Announcing stays where it is; this adds the durable
 * half that was missing.
 */
export declare function recordDegradation(audit: DegradationSink | undefined, fields: DegradationFields): void;
//# sourceMappingURL=degradation.d.ts.map
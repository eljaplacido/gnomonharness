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
export const DEGRADATIONS = {
    endpoint_fallback: "the role's primary endpoint could not be reached, so its declared fallback answered instead",
    endpoint_tools_rejected: "the endpoint refused the tools array, so the turn was retried without tools",
    mcp_server_unreachable: "a declared MCP server did not connect, so its tools are absent from this session",
    context_turns_dropped: "the context window could not fit every prior turn, so the oldest were dropped outright",
    context_summary_role_unreachable: "compaction is declared as `summary` but the summary role is unreachable, so turns were dropped rather than folded",
    tool_output_spilled: "a tool produced more output than the window allows, so it was written to a file and truncated in the transcript",
    verify_skipped_shell_only: "the surface declares `[verify] after = \"write\"` and this turn changed files only through the shell, so the declared check did not run",
    verify_unrunnable: "the declared verify command could not run, so the turn was neither passed nor handed back",
    verify_declined: "the operator declined the verify command, so no check ran for this turn",
    bash_timeout: "a command exceeded the tool timeout and was killed; the output captured before the kill is kept",
    bash_timeout_repeat_refused: "an identical command already timed out this turn, so re-running it was refused rather than repeated",
    surface_drift: "a command changed `.gnomon/` mid-turn, so the surface no longer matches the hash this session was stamped with",
    model_output_truncated: "the backend cut the completion off at its token limit, so the answer is incomplete",
};
/** Every declared id, in declaration order. */
export const DEGRADATION_IDS = Object.keys(DEGRADATIONS);
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
export function recordDegradation(audit, fields) {
    audit?.write("degradation", {
        id: fields.id,
        declared: fields.declared,
        actual: fields.actual,
        ...(fields.detail ? { detail: fields.detail } : {}),
    });
}
//# sourceMappingURL=degradation.js.map
/**
 * gnomon-core: Deterministic replay of a recorded session
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT.
 *
 * A trail is a record. Until now it was something you read and believed. This
 * module turns a trail into something you can check: it takes the JSONL the
 * AuditTrail wrote, points it at a `.gnomon/` surface, and re-derives every
 * decision the HARNESS made — which model the role routed to, which tools were
 * offered, which calls the gate stopped, which bucket a code mapped to, which
 * stage of a declared chain ran where — then reports, per record, whether the
 * re-derived value equals the recorded one.
 *
 * It does NOT call a model. It cannot. The model's answers are already in the
 * trail, and that is the point: replay is not evidence that the model would say
 * the same thing twice. It is evidence that GIVEN THOSE ANSWERS the harness
 * reached the same decisions. Overclaiming this would be worse than not
 * building it, so the vocabulary is kept narrow throughout — replay compares
 * decisions, never behaviour-in-general, and never the model.
 *
 * Concretely, three separate things a reader must not conflate:
 *
 *   1. `verifyTrail` (audit.ts) answers "was this file edited after it was
 *      written". Hash chaining. Says nothing about whether the content is
 *      sane.
 *   2. `replay` (here) answers "do the harness's own decisions in this file
 *      follow from this surface". A forged but well-chained record fails here.
 *   3. Nothing in this repository answers "would the model answer this way
 *      again". Nothing can, and this module does not pretend otherwise.
 *
 * TWO SURFACES ARE NOT COMPARABLE, AND THAT IS REPORTED FIRST.
 *
 * The first thing `replay` establishes is whether the trail's `surface_hash`
 * equals the hash of the surface it is being replayed against. If it does not,
 * `verdict` is `"not_comparable"`, `surface` carries both hashes, and every
 * check that would have had to consult the surface is returned as UNCHECKABLE
 * with that reason attached. Reporting a "divergence" there would be a lie
 * about what was compared: the two runs were under different rules, so of
 * course the decisions differ, and a reader who saw DIVERGED would draw the
 * wrong conclusion. Checks that consult only the trail (`source: "trail"`)
 * still run, because they never touch the surface at all.
 *
 * UNCHECKABLE IS A LEGITIMATE STATE, NOT A SOFT FAILURE.
 *
 * A trail recorded at `[audit] record = "metadata"` deliberately holds no
 * prompt or response text. Skill selection matches against the input, so on
 * such a trail it cannot be re-derived. That is the surface working as
 * declared. It is reported UNCHECKABLE with the reason, never DIVERGED — the
 * failure this rule exists to prevent is a governance control (record less)
 * being punished by a verification tool (report a divergence), which would push
 * an operator toward recording text they had decided not to keep.
 *
 * WHAT THIS FOUND ABOUT THE `volatile` CONTRACT.
 *
 * `TaskRecord.volatile` (prompt_loop.ts) documents that "anything OUTSIDE this
 * object is reproducible". Building replay against that claim shows it is true
 * of one half of the record and false of the other, and the record does not
 * mark which is which:
 *
 *   - HARNESS_DERIVED below re-derives exactly. Those are decisions taken by
 *     this code from the surface and from the model's answers, and running
 *     them again on the same inputs gives the same values.
 *   - MODEL_SUPPLIED below does not. `output` is the model's text. `code` is
 *     the worst tool outcome the model's chosen calls produced, and `bucket` is
 *     computed from `code`. All three sit outside `volatile`, and two runs of
 *     the same task against a model at temperature > 0 can differ in all three
 *     with nothing about the surface having changed.
 *
 * So replay treats MODEL_SUPPLIED fields as INPUTS — it reads them and never
 * claims to re-derive them — and checks HARNESS_DERIVED fields. NOT VERIFIED:
 * this is read off the code path (runAgenticTurn -> TaskRecord), not measured
 * by running one task twice against a live endpoint. The narrower claim that
 * the tests here do substantiate is: given identical model answers, every
 * harness decision in HARNESS_DERIVED reproduces.
 *
 * PUBLISHED LIMITS. Each of these is a place replay cannot see, said plainly
 * rather than papered over:
 *
 *   - Measured while building this: a `task` tool call delegates a sub-turn
 *     that runs with the SAME trail (prompt_loop.ts delegate.run passes `deps`
 *     straight through), so the sub-turn's own `tool_call` records land in the
 *     trail interleaved with the parent's, while the parent's `tool_log` never
 *     mentions them. The first version of the tool-log check demanded exact
 *     equality and reported every delegating turn as tampered. When a `task`
 *     call is attributed to a turn, replay drops to an ordering check
 *     (the turn's log must be an ordered subsequence of the records) and says
 *     so in the check's `note` rather than silently weakening.
 *   - MCP tools are named `mcp__<server>__<tool>` and are discovered from a
 *     live server at connect time. The surface declares the SERVER, not its
 *     tool list, so whether such a tool was offered is not re-derivable from
 *     `.gnomon/` and is returned UNCHECKABLE.
 *   - Read from tools.ts, NOT VERIFIED against a live server: the `gated` field
 *     on a `tool_call` record is `needsApproval(tool, gate) && offered.has(tool)`,
 *     and `needsApproval` consults a fixed set that contains no MCP name — but
 *     `dispatch` gates every `mcp__*` call whenever the gate is not `never`. A
 *     trail can therefore show `gated: false` beside an `approval` record for
 *     the same MCP call. Replay reports the MCP `gated` field UNCHECKABLE
 *     rather than reproducing a value it knows to be misleading.
 *   - `GNOMON_MODEL_URL` replaces the declared endpoint URL at resolve time.
 *     If the trail says the override was in force, the destination was
 *     machine-scoped and is not in the surface: UNCHECKABLE. If the override is
 *     set in the REPLAYING process, re-deriving the URL would return the
 *     override rather than the declaration: also UNCHECKABLE, and for the
 *     opposite reason.
 *   - If the surface declares `[audit] redact` patterns, a `full` trail's
 *     recorded input is post-redaction. Re-running skill selection against it
 *     would not reproduce what actually ran, so it is UNCHECKABLE.
 *   - A turn that ran on a role's declared fallback model is reported as a
 *     MATCH with a note. Replay cannot tell whether the primary was tried and
 *     failed or was never reached; nothing in the record says.
 *   - An `approval` decision is an operator input, not a harness decision.
 *     Replay checks that the current surface would still have ASKED, and
 *     reports the decision itself UNCHECKABLE. It has no way to know what a
 *     person would say twice, and a tool that implied otherwise would be
 *     claiming oversight it cannot see.
 *   - Replay reads the surface as it is on disk NOW. It does not reconstruct an
 *     old surface from a hash: a hash is not a preimage. Against a changed
 *     surface it reports the difference and stops, which is the only honest
 *     option available to it.
 */
import { GnomonConfig } from "./config.js";
import { AuditRecord, AuditDetail } from "./audit.js";
/**
 * Record fields that are INPUTS to the harness's decisions, never one of them.
 *
 * `output` and every tool call's name, arguments and outcome are the model's.
 * `input` is the operator's. `code` is the worst outcome the model's chosen
 * calls produced. Replay reads all of them and re-derives none — producing a
 * `replayed` value for any field here would be claiming to know what a model
 * or a person would do again, which is the one thing this module must not say.
 *
 * Every name here sits OUTSIDE `TaskRecord.volatile`, and none of them is
 * reproducible run to run against a model with any temperature at all. That is
 * the gap in the `volatile` contract; see the module comment.
 */
export declare const MODEL_SUPPLIED: readonly ["output", "input", "code", "tool_call.tool", "tool_call.args", "tool_call.summary", "tool_call.code"];
/**
 * Decisions the HARNESS took. Every one of these is re-derived by `replay`.
 *
 * The test "checks every field it lists as harness-derived" keeps this list and
 * the checks below from drifting apart: a name added here with no check behind
 * it fails the suite rather than quietly becoming a promise the code does not
 * keep.
 */
export declare const HARNESS_DERIVED: readonly ["bucket", "route.model", "route.endpoint", "route.url", "skills", "offered", "gated", "gate.asks", "chain.role", "chain.of", "verify.command", "verify.unrunnable", "verify.passed", "audit.record", "roles", "tool_steps", "tool_log", "turns", "surface_changed"];
export type ReplayStatus = "match" | "diverged" | "uncheckable";
/** Where a check got the value it compared against. */
export type CheckSource = 
/** Derived from the trail alone. Runs even across two different surfaces. */
"trail"
/** Re-derived from the surface on disk. Suppressed when the hashes differ. */
 | "surface"
/** Compared against the harness build doing the replay. */
 | "build";
export interface ReplayCheck {
    /** The decision compared, e.g. `route.model`. Names in HARNESS_DERIVED. */
    field: string;
    status: ReplayStatus;
    source: CheckSource;
    /** What the trail says. Present unless the trail carried nothing to compare. */
    recorded?: unknown;
    /** What re-deriving produced. Absent when the check could not run. */
    replayed?: unknown;
    /**
     * Why a check is UNCHECKABLE, or the caveat attached to a MATCH.
     *
     * A match with a note is a match that was checked more weakly than the
     * others; the note says how. Silently weakening a check is the failure this
     * field exists to prevent.
     */
    note?: string;
}
export interface ReplayEntry {
    /** 0-based line number in the trail, so a reader can go and look. */
    index: number;
    seq: number | null;
    kind: string;
    status: ReplayStatus;
    checks: ReplayCheck[];
}
export interface ReplaySurface {
    /** The hash the trail says it ran under, or null if it recorded none. */
    recorded: string | null;
    /** The hash of the surface being replayed against, or null if unreadable. */
    current: string | null;
    status: "same" | "different" | "unknown";
    note: string;
}
export interface ReplayIntegrity {
    records: number;
    /** Line numbers that are not JSON — a truncated or corrupted trail. */
    malformed: number[];
    /** `verifyTrail`: does the hash chain hold. */
    chain_ok: boolean;
    broken: number[];
    /** `verifyTrail`: does the trail close with `session_end`. */
    sealed: boolean;
    /** Sequence numbers absent from the file. Capped; see `seq_gaps_truncated`. */
    seq_gaps: number[];
    seq_gaps_truncated: boolean;
}
export interface ReplayResult {
    /** The trail replayed, as given. */
    trail: string;
    /** Read this first. Two surfaces are not comparable. */
    surface: ReplaySurface;
    /** Same surface, different code, is still a different run. Reported, not folded in. */
    harness: {
        recorded: string | null;
        current: string;
        status: "same" | "different" | "unknown";
    };
    detail: AuditDetail | "unknown";
    integrity: ReplayIntegrity;
    entries: ReplayEntry[];
    totals: {
        checks: number;
        match: number;
        diverged: number;
        uncheckable: number;
        entries_diverged: number;
    };
    /**
     * The verdict, in reading order — `not_comparable` outranks `diverged`
     * because a divergence between two different surfaces is not a finding.
     */
    verdict: "empty" | "not_comparable" | "diverged" | "clean";
    /** Everything a reader must be told, most important first. */
    notes: string[];
}
export interface ReplayOptions {
    /**
     * The build string to compare the trail's `harness` against.
     *
     * Defaults to `harnessBuild()`. Overridable so a caller can replay on behalf
     * of a build that is not the one running — and so this module's own tests do
     * not depend on the git state of the tree they run in.
     */
    harness?: string;
}
export interface TrailRead {
    records: AuditRecord[];
    /** Line numbers that would not parse. */
    malformed: number[];
    /** Set when the file could not be read at all. */
    problem?: string;
}
/**
 * Read a trail without throwing.
 *
 * A trail is written by appending, and a process killed mid-append leaves a
 * half-line. That is an ordinary state for this harness — it kills its own runs
 * — so an unparseable tail is data to report, never an exception. Line
 * numbering matches `verifyTrail`'s (`split("\n").filter(Boolean)`) so the two
 * report the same indices for the same file.
 */
export declare function readTrail(path: string): TrailRead;
/**
 * Replay a trail against a surface.
 *
 * `config` is taken rather than loaded so the caller decides which surface is
 * under test — a trail is often replayed against a checkout other than the cwd,
 * and silently guessing which one would defeat the purpose.
 */
export declare function replay(trailPath: string, config: GnomonConfig, options?: ReplayOptions): ReplayResult;
/**
 * A replay result as lines a person can read.
 *
 * Ordered the way the result must be read: the surface question, then the
 * build, then the verdict, then the divergences. A renderer that led with the
 * verdict would let a reader take "clean" from a comparison that never
 * happened.
 */
export declare function formatReplay(result: ReplayResult): string[];
//# sourceMappingURL=replay.d.ts.map
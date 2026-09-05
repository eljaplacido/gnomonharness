/**
 * gnomon-core: Interactive prompt loop
 *
 * Reads user input from stdin, infers role, calls model API,
 * displays results with outcome buckets.
 *
 * Uses Ollama (localhost:11434) by default. Configurable via
 * GNOMON_MODEL_URL env var.
 */
import * as readline from "node:readline";
import { GnomonConfig, routeRole, type ChainGate, ResolvedRouting, ResolvedUi, SurfaceProblem, EndpointConfig } from "./config.js";
import { Progress } from "./render.js";
export { isLocalEndpoint } from "./config.js";
import { Todo, type SurfaceDrift, Approver, SandboxLevel, SurfaceConsent, RunNote, type SpillSink } from "./tools.js";
import { type McpRegistry } from "./mcp.js";
import { AuditTrail } from "./audit.js";
import { SessionListEntry } from "./session_store.js";
/** A single exchange: user input → model response → outcome */
export interface PromptExchange {
    turn: number;
    role: string;
    input: string;
    output: string;
    model: string;
    code: number;
    bucket: string;
    duration_ms: number;
    /** Prior turns carried into this call (excludes the current one) */
    context_turns?: number;
    /** Prior turns the window could not fit */
    context_dropped?: number;
    /** Estimated prompt tokens sent */
    context_tokens?: number;
    /**
     * Backend-reported tokens for the whole turn, summed over every model call
     * it took (a turn with six tool calls made seven). Absent when the backend
     * reports none.
     */
    usage?: TokenUsage;
    /** Tool calls executed during this turn */
    tool_steps?: number;
    /** One line per tool call, for the transcript */
    tool_log?: string[];
    /** Folded into the running summary; no longer replayed verbatim */
    folded?: boolean; /**
     * Why the turn ended, and the counters behind it.
     *
     * These were computed on every turn and then dropped on the interactive path:
     * they reached `gnomon task --json` and nothing else, so a person working in a
     * session could not see that a turn had stalled, hit the step wall, or been
     * cut off blank -- the three things they would most want to know. The record
     * shape should not depend on which entry point produced it.
     */
    stop_reason?: StopReason;
    stop_detail?: {
        steps?: number;
        max_steps_total?: number;
        repeats?: number;
    };
    counters?: TurnCounters;
}
/** State for the interactive prompt loop */
export type { Todo, RunNote };
export interface PromptState {
    config: GnomonConfig;
    exchanges: PromptExchange[];
    currentRole: string;
    /** Resolved `[ui]`; /meta and /think edit this copy for the session only */
    ui?: ResolvedUi;
    /** Resolved `[routing]`; /mode edits this copy for the session only */
    routing?: ResolvedRouting;
    /** Surface-edit consent for this session, set by `/allow`. Default `strict`. */
    allow?: SurfaceConsent;
    /**
     * Session-scoped grants for the other two dials, set by `/network` and
     * `/sandbox`.
     *
     * The surface keeps its declared default; these lift it for THIS session
     * only, exactly as `/allow` and `/mode` already do. That is the difference
     * between a consent dial and a weaker policy: the committed default does not
     * move, the grant does not persist, and the operator granting it is a person
     * at a prompt rather than the model asking itself.
     *
     * Without them the only way to let an agent reach the network or another
     * repository was to quit, edit policy.toml, and start again -- which is not
     * governance, it is friction that gets worked around.
     */
    network?: boolean;
    sandbox?: SandboxLevel;
    /** Connected MCP servers, if the surface declares any. Set once at startup. */
    mcp?: McpRegistry;
    /**
     * Running summary of turns evicted from the window under
     * `compaction = "summary"`. Replaces them in the prompt.
     */
    summary?: string;
    /** Identifier this conversation is saved under */
    sessionId?: string;
    /**
     * Rotate to a fresh session, leaving the current snapshot on disk.
     *
     * Supplied by the loop, which owns the id and the persistence. A command
     * cannot rotate a session by itself without reaching into both.
     */
    newSession?: () => void;
    /** Load an earlier session into this one. Throws when the id is unknown. */
    switchSession?: (id: string) => void;
    /**
     * Models the backend has refused a tools array for. Remembered so the
     * rejection is paid once per session rather than on every turn.
     */
    noToolModels?: Set<string>;
    /**
     * The session checklist, as the `todo` tool last left it.
     *
     * Session state, not surface state: it lives in the saved conversation and
     * never in `.gnomon/`, because a list that changed on every turn would move
     * the surface hash on every turn and make it useless as an identifier.
     */
    todos?: Todo[];
    /** Notes this run kept about itself. Outside the surface, like sessions. */
    notes?: RunNote[];
    /**
     * The steps inside the most recently folded chunk, for `/expand`.
     *
     * Display state, not conversation state: it is never sent to the model and
     * never saved with the session. The audit trail is the durable record of
     * what ran — this only spares the operator a re-read of it.
     */
    lastFold?: FoldStep[];
    /**
     * Where over-long tool output is written instead of being discarded.
     *
     * Session-scoped rather than turn-scoped on purpose: the sink numbers the
     * files it writes, and a fresh one per turn would renumber from 001 and
     * overwrite a file an earlier turn told the model to read.
     */
    spill?: SpillSink;
}
/**
 * Bracketed paste. \x1b[?2004h asks the terminal to wrap pasted text in these.
 *
 * readline's key parser swallows the markers — they never reach the line
 * buffer — but it still splits the content on newlines and emits one "line"
 * event per newline. The prompt loop turns each of those into a turn, so a
 * pasted stack trace became forty turns answering forty fragments. Counting
 * the newlines *inside* the markers is what lets the loop tell paste from
 * typing before readline has split it.
 */
export declare const PASTE_START = "\u001B[200~";
export declare const PASTE_END = "\u001B[201~";
export interface PasteScan {
    /** Newlines that fell inside a paste in this chunk — the "line" events to hold. */
    lines: number;
    /** Whether the chunk ended mid-paste, so the next one continues it. */
    inPaste: boolean;
    /** Whether any paste content passed through at all. */
    sawPaste: boolean;
}
/**
 * Count the newlines a chunk carries inside paste markers.
 *
 * Pure, and stateful only through `inPaste`, because a paste larger than the
 * pipe buffer arrives in several chunks and the markers can land in different
 * ones — an 8KB paste that lost its opening marker would be read as 200 turns.
 */
export declare function scanPasteMarkers(chunk: string, inPaste: boolean): PasteScan;
/**
 * Assemble held paste lines and the fragment left on the prompt line.
 *
 * The text after a paste's last newline is deliberately left in readline's
 * buffer rather than held: it stays editable, and it is where a typed question
 * about the pasted material naturally goes. Enter sends both as one input.
 */
export declare function joinPastedBlock(held: string[], tail: string): string;
/** One message in a chat-completions payload */
export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    /** Echoed back verbatim on an assistant turn that called tools */
    tool_calls?: unknown[];
    /** Set on a tool result; both spellings, since backends differ */
    tool_call_id?: string;
    tool_name?: string;
}
/** One tool invocation requested by the model */
export interface ToolCall {
    id?: string;
    name: string;
    args: Record<string, unknown>;
}
/** The messages for one call, plus what the window had to leave out */
export interface BuiltContext {
    messages: ChatMessage[];
    /** Prior turns carried into the call */
    included: number;
    /** Prior turns the window could not fit */
    dropped: number;
    /** Those turns themselves, so a compactor can fold them */
    evicted: PromptExchange[];
    /** Estimated prompt tokens */
    tokens: number;
    /** Tokens available for history after system prompt + current input */
    budget: number;
    /** Set when the surface asks for behaviour this build does not implement */
    notice?: string;
}
/**
 * Estimated token count: ~4 characters per token.
 *
 * Deliberately not a real tokenizer. A tokenizer is a per-model artifact that
 * would have to be installed and resolved per machine — exactly the
 * machine-scoped dependency Rule 1 forbids. This is pure, deterministic, and
 * has no dependencies: the same string always yields the same number, so the
 * window slides identically on every machine.
 */
export declare function estimateTokens(text: string): number;
/**
 * Whether a turn with this exit code is replayed into the next context.
 *
 * Buckets come from the published exit contract (docs/CONTRACTS.md): 0-1
 * result, 2-4 refusal, 10-13 apparatus_failure. Result and refusal are both
 * things the model said and both replay; apparatus_failure is the harness
 * reporting its own breakage and does not.
 */
export declare function isReplayable(code: number): boolean;
/**
 * Build the message list for one call, honouring `[context]` in config.toml.
 *
 * `policy = "full"`           — replay every prior turn.
 * `policy = "sliding_window"` — keep `retain_after` tokens of the *oldest*
 *   turns (the original ask, which is what later turns refer back to) and fill
 *   the remaining budget from the newest turns backwards. The middle is what
 *   gives way, because that is the part neither end depends on.
 *
 * Which turns replay is decided by bucket, not by "was the exit code zero".
 *
 *   result (0-1)             — replayed.
 *   refusal (2-4)            — replayed. A refusal is something the *model*
 *     said: the write you declined, the command `bash_allow` turned down. Drop
 *     it and the next turn cannot refer back to it — you deny a write, say
 *     "put it in src/ instead", and the model has no idea what "it" was. That
 *     round trip is the most common thing a person does after a gate fires,
 *     so it is the last thing that should lose its history.
 *   apparatus_failure (10-13) — never replayed. Here the `output` really is a
 *     transport error string rather than something the model said, and feeding
 *     it back would teach the model that it emits connection errors.
 *
 * Whatever does not fit is named in-band rather than silently vanishing —
 * the same rule system.md applies to unreachable tools.
 */
export declare function buildMessages(state: PromptState, systemPrompt: string, input: string): BuiltContext;
/** Model inference result from API call */
/**
 * What a backend reported it actually spent on one call.
 *
 * Counted by the model server, not estimated here. `estimateTokens` exists to
 * slide the context window deterministically on every machine and is wrong by
 * design on code; it must never be quoted back as a cost. Absent when the
 * backend did not say — reported as unknown rather than as zero, because a
 * confident 0 is worse than a blank.
 */
export interface TokenUsage {
    input?: number;
    output?: number;
    /** Model server's own wall-clock for the call, when it reports one. */
    ms?: number;
}
/**
 * Pull the backend's own token counts out of a response.
 *
 * Two shapes, because two backends:
 *   Ollama  — `prompt_eval_count` / `eval_count`, durations in nanoseconds.
 *   OpenAI  — `usage.prompt_tokens` / `usage.completion_tokens`.
 *
 * A field the backend omitted stays undefined and is rendered as "?" rather
 * than 0: a cost line that silently reads zero when the number is missing is
 * the kind of thing you trust for a week and then find out was never true.
 */
export declare function readUsage(json: unknown): TokenUsage | undefined;
/** Add one call's usage into a running total for the turn. */
export declare function addUsage(total: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined;
/**
 * Which apparatus failure this is.
 *
 * Both failure sites used to return 10 for everything, so a 400 "no such
 * model" and a 503 "overloaded" were the same value — and nothing downstream
 * could tell a fault worth retrying from one that will fail identically next
 * time. The receiving machinery already existed: conformance/exit_codes.json
 * has shipped 11, 12 and 13 since the first release with nothing ever emitting
 * them.
 *
 *   10 launch_failed        — the request was wrong. 400, 401, a bad model tag.
 *   11 timed_out            — the deadline passed.
 *   12 provider_unreachable — the endpoint is down, refused, or overloaded.
 *   13 context_exhausted    — the prompt did not fit.
 *
 * Only 11 and 12 are worth trying again; 10 and 13 fail the same way twice.
 */
export declare function classifyFailure(opts: {
    status?: number;
    errName?: string;
    message?: string;
}): number;
/**
 * Is this URL pointing at this machine?
 *
 * Used only to tell the two `ECONNREFUSED`s apart. A refused socket at
 * api.openai.com means the internet is having a bad day and retrying is
 * sensible; a refused socket at 127.0.0.1:11434 means the user has not started
 * the server, and no amount of retrying will start it. The remedy is different,
 * so the message has to be.
 *
 * Parse failures return false: an unparseable URL is not evidence of loopback,
 * and the generic message is still correct.
 */
export declare function isLoopbackUrl(url: string): boolean;
/**
 * The real errno behind a fetch failure.
 *
 * Node's fetch throws `TypeError: fetch failed` and hangs the actual cause off
 * `.cause` -- so matching ECONNREFUSED against `err.message` never matches, and
 * every transport failure looked identical. Walk the chain (bounded; causes can
 * be self-referential) and return the first `code` found.
 */
export declare function causeCode(err: unknown): string | undefined;
/** Marker text for a turn the user stopped. Code 2 → bucket `refusal`. */
export declare const CANCELLED = "Cancelled.";
/**
 * Print what the surface gets wrong, and say whether the session may start.
 *
 * Returns false when something fatal was found. Fatal is narrow on purpose —
 * a surface that cannot do what it claims, not one that is merely unusual —
 * because a harness that refuses to start over a warning is a harness people
 * route around.
 */
export declare function reportSurfaceProblems(problems: SurfaceProblem[], ui: ResolvedUi): boolean;
/** One endpoint as a listing needs it: what it is, who uses it, what to test with. */
export interface EndpointRow {
    name: string;
    endpoint: EndpointConfig;
    where: string;
    provider: string;
    /** Roles routing here as their primary */
    primary: string[];
    /** Roles naming it only as a fallback */
    fallback: string[];
    /**
     * A model to test with — the first role that routes here. Without one there
     * is nothing to probe: an endpoint has no opinion about auth until it is
     * asked to run a specific model.
     */
    probeModel?: string;
}
/** Result of asking each endpoint whether it will actually answer. */
export type EndpointProbes = Map<string, {
    ok: boolean;
    status?: number;
    detail?: string;
}>;
export declare function describeEndpoints(config: GnomonConfig): EndpointRow[];
/**
 * Is the model a role names actually one this endpoint serves?
 *
 * Nothing asked this until 2026-09-03, and the cost was a whole session. A role
 * routed at OpenCode Go with `model = "glm-5-3"` (the id is `glm-5.3`) produced
 * a 400 from the provider naming the MODEL, which reads as "that model is not
 * available" rather than "you typed the id wrong" — so the next guess was a
 * prefix the scaffold had invented, `opencode-go/glm-5-3`, which 400s the same
 * way. Two wrong answers that both look like confirmation.
 *
 * The endpoint has always been able to answer this: /v1/models for OpenAI-shaped
 * providers, /api/tags for Ollama. It was simply never consulted.
 */
export interface ModelCheck {
    role: string;
    model: string;
    ok: boolean;
    /** The closest id this endpoint actually serves, when the model is unknown. */
    suggestion?: string;
    /** How many ids the endpoint offers, for "N available". */
    available: number;
}
/**
 * Cross-check every role's model against the ids its endpoint advertises.
 *
 * Endpoints that cannot be listed (no key, unreachable, a provider that serves
 * no listing) yield NO entries rather than false ones: "we could not check" and
 * "we checked and it is wrong" must not look the same.
 */
export declare function checkRoleModels(config: GnomonConfig): Promise<Map<string, ModelCheck[]>>;
/**
 * Render the endpoint listing.
 *
 * `probes` is null when nothing was tested, and the key line says exactly
 * that. It used to read "available" whenever the variable was non-empty,
 * which is how a revoked key looked healthy right up until a 401 landed in
 * the middle of a task — the listing was answering "is the variable set",
 * while every reader took it for "will this work".
 */
export declare function printEndpoints(rows: EndpointRow[], ui: ResolvedUi, probes: EndpointProbes | null, checks?: Map<string, ModelCheck[]> | null): void;
/** Everything one turn needs that is not in PromptState. */
export interface TurnDeps {
    approve: Approver;
    progress: Progress;
    ui: ResolvedUi;
    /** Emit a transcript line as work happens */
    say: (line: string) => void;
    /** Aborted when the user presses Esc (or Ctrl+C) mid-turn */
    signal?: AbortSignal;
    /** Append-only trail; a disabled one is a no-op */
    audit?: AuditTrail;
    /**
     * Whether a standing approval covers gated calls right now.
     *
     * The turn needs this to decide what may be folded. A call the human is
     * being asked about one at a time is a call they are watching, and folding
     * it away would hide the thing they are looking at — and the prompt itself
     * prints outside `say`, so a pending chunk has to be flushed before it.
     */
    standingApproval?: () => boolean;
}
/** One step held back by the fold, kept so `/expand` can print it. */
export interface FoldStep {
    tool: string;
    /** What `describeCall` said: a declared path, or the command text */
    describe: string;
    /** A path the ARGS declared. Never parsed out of a command. */
    path?: string;
    glyph: string;
    colour: string;
    summary: string;
}
/** Result of one agentic turn, before it becomes a PromptExchange. */
/**
 * Does the gate stop the chain after this stage? Returns the reason, or null.
 *
 * A reason rather than a boolean, because "the chain stopped" is not a useful
 * thing to read in a trail three weeks later — `stopped_by` says which
 * condition fired, and the two are not interchangeable when you are trying to
 * work out why the verifier never ran.
 *
 * Apparatus failures are handled by the caller and are NOT this function's
 * business: they stop the chain at every gate setting, including `never`, and
 * folding them in here would make `never` look like it had a condition.
 */
export declare function chainStop(gate: ChainGate, r: Pick<TurnResult, "code" | "verify">): "refusal" | "verify" | null;
export interface TurnResult {
    content: string;
    /** Worst outcome code seen — model transport or any tool */
    code: number;
    model: string;
    /**
     * The endpoint the model calls actually reached, and its URL.
     *
     * Both are the DECLARED route until a `[roles.<name>.fallback]` fires, at
     * which point they follow the request. Callers stamped the audit record from
     * `route.target` directly until 2026-09-05, so a fallback turn was recorded
     * as the fallback's model against the primary's endpoint and URL — an
     * internally inconsistent record of a run whose whole point was that it went
     * somewhere else.
     */
    endpoint?: string;
    endpoint_url?: string;
    /**
     * The outcome of the surface's declared `[verify]` check for this turn, when
     * one ran. Absent when no check is declared or none applied.
     *
     * It existed only as a separate `verify` audit record and as prose in the
     * transcript, so the TURN said `code: 0` / `stop_reason: "answered"` for a
     * turn whose declared check had failed every round it was given. A consumer
     * reading the record -- `gnomon task --json`, or the chain gate below --
     * could not tell that from a clean pass. Same silent-success shape as `exit
     * null` read as a clean zero, one level up.
     */
    verify?: "passed" | "failed" | "unrunnable" | "declined";
    toolSteps: number;
    toolLog: string[];
    /**
     * Backend-reported tokens for every model call this turn made. A turn with
     * six tool calls costs seven calls, and the whole point of reporting spend
     * is that the tool loop — not the visible prompt — is where it goes.
     */
    usage?: TokenUsage;
    /**
     * Why the tool loop ended. The distinction existed only as prose in the
     * wrap-up note, was interpolated into the answer text, and was then
     * discarded — so "stopped voluntarily with budget left" and "hit the wall"
     * were indistinguishable afterwards. Four separate investigations of one
     * benchmark campaign each blamed a different cause and every one was
     * refuted, because this field was not written down.
     *
     * A separate axis from the outcome bucket, not a composite verdict: the
     * bucket says WHAT happened, this says why the loop stopped.
     */
    stop_reason: StopReason;
    /** The numbers behind the label — "hit the wall" and "hit the wall at 12
     * when the role declares 40" are different findings. */
    stop_detail?: {
        steps?: number;
        max_steps_total?: number;
        repeats?: number;
    };
    /** Counters already computed by the loop and previously thrown away. */
    counters: TurnCounters;
    /**
     * Set when `.gnomon/` moved while this turn ran — an approved surface write,
     * or a bash command that touched it. The interactive loop reloads on this.
     *
     * It exists because the surface write tool printed "the next turn runs under
     * the new rules" and that was false: the session holds the config it loaded
     * at startup. A user changed a role's model, saw that line, and then watched
     * /role report the old model. `surface_drift` was already being produced by
     * bash and read by nothing at all.
     */
    surface_changed?: SurfaceDrift[];
}
/**
 * Why the tool loop stopped.
 *
 * Deliberately only the values a return site can actually produce. A verify
 * handback and the anti-flailing nudge are NOT turn ends — the first
 * `continue`s the loop and the second only pushes a system message — so
 * publishing them here would put values in a Rule 6 enumeration that nothing
 * can emit.
 */
/**
 * Consecutive blank completions tolerated before a turn is called finished.
 *
 * Now `[loop] max_consecutive_empty` in config.toml; this is only its default,
 * re-exported so existing importers keep working. The number itself lives in
 * LOOP_DEFAULTS, because a default written in two files is a setting with two
 * values -- see the "One default, not two" note on modelTimeoutMs above.
 */
export declare const MAX_CONSECUTIVE_EMPTY: number;
/** Whether a completion is tool-call markup rather than an answer. */
export declare function looksLikeTextToolCall(content: string): boolean;
/**
 * Flag tool-call markup that survived into a FINAL answer.
 *
 * The first version of this guard only caught markup arriving INSTEAD of an
 * answer -- a turn with no tool calls at all. It therefore missed the two paths
 * that actually produced it in practice: a turn that made real tool calls and
 * then signed off with markup, and a turn cut off at the step wall mid-markup.
 * Measured on a real refactor run: the work was correct, and the report was
 * markup, with the counter still reading zero.
 *
 * The text is not rewritten -- editing a model's answer to look better is the
 * opposite of a faithful record. It is annotated, so a reader who sees markup
 * also sees why, and the counter makes it greppable across a benchmark arm.
 */
export declare function noteMarkupInAnswer(content: string, counters: TurnCounters): string;
/** How many run notes are kept and replayed. Oldest fall off first.
 *  Default for `[loop] max_run_notes`; the live value comes from resolveLoop. */
export declare const MAX_RUN_NOTES: number;
/**
 * Where a read-only role starts being pushed to conclude, as a fraction of its
 * step budget. Only applies when the surface declared no converge_after of its
 * own, and only to a role that holds no tool which can change anything.
 *
 * Default for `[loop] read_only_converge_after`; the live value comes from
 * resolveLoop.
 */
export declare const READ_ONLY_CONVERGE_AFTER: number;
/** Refusals of one tool, all of its calls, before the loop says the policy may
 *  be wrong. Default for `[loop] all_refused_notice`. */
export declare const ALL_REFUSED_NOTICE: number;
/**
 * Append a note, bounded, oldest first.
 *
 * Exported so the bound is testable: it lived in a closure inside the turn, and
 * a test written against the closure could only ever assert that rendering
 * works, not that the cap holds. A note store that grows without limit stops
 * being something the model can re-read and becomes context pressure — the very
 * problem compaction exists to relieve.
 */
export declare function pushNote(notes: RunNote[], turn: number, text: string, 
/**
 * The bound, from `[loop] max_run_notes`. Defaulted rather than required so
 * the existing three-argument callers -- including the tests that assert the
 * cap -- keep compiling and keep meaning what they meant.
 */
limit?: number): RunNote[];
export type StopReason = "answered" | "empty" | "stall" | "step_wall" | "cancelled" | "truncated" | "apparatus";
/** Measured worktree change for one turn. Absent outside a git worktree. */
export interface TreeDelta {
    files: number;
    insertions: number;
    deletions: number;
    /**
     * Files whose entire change vanishes under `--ignore-cr-at-eol` — i.e. pure
     * line-ending churn. Counted separately because it is invisible in a plain
     * numstat and drowns the real change: one reviewed run showed 3,862 lines of
     * CRLF noise around 464 lines of actual dependency resolution.
     */
    crlf_only: number;
    /** Why there is no measurement, when there is none. */
    unavailable?: string;
}
/**
 * Ask git what changed. Best-effort and bounded: a turn must not fail because
 * the project is not a repository, or because git is slow.
 */
export declare function measureTreeDelta(root: string): TreeDelta;
export interface TurnCounters {
    /**
     * What actually changed in the worktree this turn — MEASURED, at the end,
     * from git. Never the model's account of it.
     *
     * An external review of a real gnomon audit run put this first: "claims about
     * the code are accurate and well-cited; claims about its own tree state are
     * asserted, not measured." Three of its four findings were that shape — the
     * harness reported "31 insertions / 4 deletions" for a diff that was 2,492
     * lines, reported a tsc error count it had not taken, and declared a CRLF
     * hazard handled while the whole lockfile sat rewritten in the tree.
     *
     * Every one of those is checkable in one git call, and the project's own
     * thesis is that a record should carry measurements rather than assertions.
     * It was not applying that to itself.
     */
    tree_delta?: TreeDelta;
    /**
     * file:line citations in the answer, checked against the tree. The other half
     * of the same review finding: a citation is what lets a reader follow the
     * argument to the code, so one that lands nowhere is a false statement in the
     * most confidence-inspiring format an answer has.
     */
    citations?: {
        checked: number;
        ok: number;
        broken: number;
        ambiguous: number;
    };
    /** Successful write/edit tool calls. */
    writes: number;
    /** Bash calls observed to change the worktree — shell-mediated work that
     * `writes` cannot see. The pair separates "never wrote a file" from "wrote
     * through the shell", which are opposite diagnoses. */
    worktree_moves: number;
    /** Anti-flailing nudges fired, and where the first one landed. */
    nudges: number;
    first_nudge_step?: number;
    /** Whether the final tool call of the turn changed anything. */
    final_step_was_write: boolean;
    /**
     * Replies that contained tool-call markup as prose rather than a tool call.
     *
     * A protocol mismatch between the model's chat template and the endpoint's
     * tool format, not a model failure — worth counting separately because the
     * fix is configuration (a different template or endpoint kind), not a better
     * prompt.
     */
    text_tool_calls?: number;
    /** Per tool: calls made, refusals, apparatus failures. Separates "bash
     * failed 9 of 31 calls" from "bash succeeded 31/31 and the answer was still
     * wrong". */
    per_tool: Record<string, {
        calls: number;
        refusals: number;
        apparatus: number;
    }>;
}
/**
 * Tool calls a role may make in one turn when its surface does not say.
 *
 * Exported because it was invisible: a role with no `max_steps` key looked
 * unlimited — a session read roles.toml, concluded "plan has no step limit",
 * and then hit this number. A default nobody can see is a default nobody can
 * plan around, so /roles and /explain now show the effective value.
 */
export declare const DEFAULT_MAX_STEPS: number;
/**
 * How many checkpoints a turn may pass before the wall.
 *
 * `max_steps` was a wall, so a long task ended mid-sentence and the operator
 * had to notice and re-prompt. In a session left running for hours nobody is
 * watching to do that, so it is a checkpoint now: the harness compacts and
 * continues, up to `max_steps * [loop] legs` unless the role says otherwise.
 */
export declare const DEFAULT_LEGS: number;
/**
 * Shrink a turn's working context so a long turn cannot outgrow the window.
 *
 * Between turns `compactSession` folds history; nothing did that *inside* a
 * turn, and a turn that reads forty files accumulates forty tool results. On a
 * long autopilot run that is what overflows first.
 *
 * The instructions and the original request are kept whole — losing the task
 * halfway through a task is the one unrecoverable outcome. The oldest tool
 * traffic gives way, and what was dropped is stated rather than vanishing.
 */
export declare function trimWorking(working: ChatMessage[], budgetTokens: number): {
    messages: ChatMessage[];
    dropped: number;
};
/**
 * Run one turn to completion: call the model, execute any tools it asks for,
 * feed the results back, repeat until it answers in prose.
 *
 * Stops at `max_steps` from roles.toml (default 12) and says so rather than
 * looping. Every tool call records an outcome code, so a turn where the user
 * declined a write reports `refusal` — the bucket that was unreachable while
 * outcomes were derived from HTTP status alone.
 */
/**
 * Assemble the system prompt for one turn: system.md, plus the skills whose
 * pattern matches, plus the working-context note.
 *
 * One function because a sub-turn started by `task` must be assembled exactly
 * as a top-level turn is — a delegated verifier that silently lost the
 * repository's skills would be judging by different rules than the same role
 * reached by hand, and the difference would be invisible.
 */
/**
 * The run's own notes, replayed to later turns.
 *
 * Framed as observations the run recorded, never as instructions: a note is
 * something this run noticed, and the model is free to disregard it. It also
 * survives compaction, which is most of its value -- the turn that learned a
 * command blocks is usually long gone by the turn that would otherwise repeat
 * it. Nothing here grants a capability; the surface decides that and this text
 * cannot change it.
 */
export declare function runNotesBlock(state: PromptState): string;
export declare function buildSystemPrompt(state: PromptState, role: string, input: string): string;
export declare function runAgenticTurn(state: PromptState, 
/** The role THIS turn runs as — a `/plan …` prefix differs from the
 *  session role, and it selects both the tool list and max_steps. */
role: string, route: ReturnType<typeof routeRole>, messages: ChatMessage[], deps: TurnDeps, 
/** 0 for a turn a person asked for; 1 for one the `task` tool delegated. */
depth?: number): Promise<TurnResult>;
/** What one compaction pass did. */
export interface CompactionResult {
    /** Turns folded into the summary by this pass */
    folded: number;
    /** Estimated tokens the fold reclaimed */
    reclaimed: number;
    /** Set when compaction was needed but could not run */
    problem?: string;
}
/**
 * Fold turns that no longer fit the window into a running summary.
 *
 * Called after a turn completes, not while building a prompt: summarising
 * needs an inference call, and keeping buildMessages synchronous and pure
 * keeps the windowing logic testable without a model.
 *
 * A deliberate trade-off: `discard` and `truncate` are bit-reproducible,
 * because they only ever drop text. `summary` is not — it asks a model what
 * mattered. The surface still determines that summarisation happens and which
 * role does it, but two runs can summarise differently. That is the price of
 * keeping long sessions coherent, and it is why `discard` remains the default.
 */
export declare function compactSession(state: PromptState, systemPrompt: string, onNote?: (line: string) => void): Promise<CompactionResult>;
export interface EndpointModels {
    endpoint: string;
    url: string;
    models: string[];
    /** Why the list is empty, when it is */
    problem?: string;
}
/**
 * Ask each declared endpoint what it offers.
 *
 * Choosing a model per role meant already knowing the exact tag a backend
 * would accept — and a wrong tag surfaces as an opaque API error at the worst
 * moment. Listing is a read-only query against the endpoints the surface
 * already declares.
 */
/**
 * Does an endpoint URL point at local hardware — this box or the LAN — or a
 * remote cloud? The model list marks each so "which run on my machine" is not
 * left as a guess from the endpoint name (`go` at :4200 is local; `zen` is not).
 */
export declare function listModels(config: GnomonConfig): Promise<EndpointModels[]>;
/** One task run, as data. Separated so a caller can compare runs. */
export interface TaskRecord {
    /** Content hash of .gnomon/ — what determined this behaviour */
    surface_hash: string;
    /**
     * Non-fatal findings from the surface audit, absent when there are none.
     *
     * The interactive path prints these; the scripted path discarded them, so a
     * CI run against a surface asking for an unimplemented edit format, or a role
     * whose allow-list admits an interpreter, saw nothing at all. Fatal findings
     * never reach here — they end the run with code 10 before a turn happens.
     */
    surface_problems?: Array<{
        where: string;
        problem: string;
        fatal: boolean;
    }>;
    /**
     * Which harness build produced this record, e.g. `gnomon/0.1.0+abf40c0`.
     *
     * The surface hash says what rules the run was under; this says what code
     * read them. Without it the sentence the whole design exists to earn --
     * "if behaviour changed, the hash changed" -- is only half true, because
     * loop constants and the loop itself live outside the surface. Every
     * benchmark record written before this field was under-identified.
     */
    harness: string;
    role: string;
    model: string;
    endpoint?: string;
    input: string;
    output: string;
    code: number;
    bucket: string;
    tool_steps: number;
    tool_log: string[];
    skills: string[];
    /** Why the tool loop ended — a separate axis from `bucket`, never a
     * composite verdict with it. */
    stop_reason: StopReason;
    /** The numbers behind `stop_reason`, when it has any. */
    stop_detail?: {
        steps?: number;
        max_steps_total?: number;
        repeats?: number;
    };
    /** Counts the loop already kept and used to discard. */
    counters: TurnCounters;
    /**
     * When [chain] is declared, one entry per stage that ran, in order — each
     * with its OWN bucket, code and stop_reason.
     *
     * Rule 4 is why this is a list rather than a summary. Three stages produce
     * three outcomes, and a harness that publishes three buckets must not fold
     * them into a fourth. The top-level bucket on this record is the LAST stage
     * that ran, because that is the answer the operator receives — not a verdict
     * over the chain.
     */
    stages?: Array<{
        stage: number;
        role: string;
        model: string;
        code: number;
        bucket: string;
        stop_reason: StopReason;
        tool_steps: number;
        output: string;
    }>;
    /**
     * Fields that legitimately differ between two runs of the same task.
     * Kept apart so a comparison can ignore exactly these and nothing else.
     */
    /**
     * Everything that may differ between two runs of the same input. The
     * contract for `--json` is that anything *outside* this object is
     * reproducible, so the conformance gate diffs two runs and ignores this.
     *
     * Token counts are optional and appear only when the backend reported
     * them — an absent count is left out rather than written as 0.
     */
    volatile: {
        duration_ms: number;
        tokens_in?: number;
        tokens_out?: number;
        model_ms?: number;
    };
}
export interface RunTaskOptions {
    role?: string;
    /** Approve gated tool calls. Without it every gated call is refused. */
    yes?: boolean;
    /** Emit progress lines to stderr */
    verbose?: boolean;
}
/**
 * Run one task without a terminal.
 *
 * This is the invocation a composition layer can put in a runbook: it takes a
 * task, uses only `.gnomon/` for configuration, references nothing outside
 * this repository, and returns a record.
 *
 * Approval is refused by default. A non-interactive run has nobody to ask, and
 * silently granting writes because no one is watching would invert the meaning
 * of `approval = "on_write"`.
 */
export declare function runTask(config: GnomonConfig, input: string, options?: RunTaskOptions): Promise<TaskRecord>;
/**
 * Complete the trailing token of a line as a filesystem path.
 *
 * Deliberately narrow: it completes what is being typed, it does not read the
 * file or change the turn. Anything that alters what the model SEES belongs in
 * the surface, not in a keystroke.
 *
 * Hidden entries and the harness's own directories are skipped unless the token
 * already names one -- a listing whose first twenty entries are .git internals
 * is not completion, it is noise.
 */
export declare function completePath(line: string, root: string): [string[], string];
/**
 * Prompt history that survives a restart.
 *
 * readline was constructed with no `history` option and no file, so Node's
 * in-memory default gave up-arrow within one run and nothing across runs --
 * re-running yesterday's prompt meant retyping it. Stored beside
 * `.gnomon-sessions/`, not inside `.gnomon/`: it is per-machine state like a
 * session log, not configuration, so it must not touch the surface hash.
 *
 * Bounded, newest last on disk. Failures are silent by design -- a read-only
 * checkout should still get a prompt, just without history.
 */
export declare const HISTORY_LIMIT = 500;
export declare function historyPath(config: GnomonConfig): string;
export declare function loadHistory(config: GnomonConfig): string[];
export declare function appendHistory(config: GnomonConfig, line: string): void;
/** One slash command, as shown by /help and offered by Tab completion. */
export interface CommandSpec {
    name: string;
    arg?: string;
    help: string;
}
/**
 * Every command, in one place.
 *
 * /help renders this and Tab completion offers it, so a command can never be
 * implemented but undiscoverable — typing "/" and Tab is how you find out
 * what exists.
 */
/**
 * Commands that may run while a turn is still going.
 *
 * All of them only read state or change how output is rendered, so running one
 * mid-turn cannot alter what that turn does. Everything else — anything that
 * changes the role, the history or the session — waits, because a turn already
 * bound to a role and a context should not have either moved under it.
 */
export declare const LIVE_SAFE_COMMANDS: Set<string>;
export declare const COMMANDS: CommandSpec[];
/**
 * Tab completion for the prompt.
 *
 * Completes slash commands, and role names after /role. Returns the readline
 * completer shape: [matches, the substring they complete].
 */
export declare function completeInput(line: string, roles: string[], endpoints?: string[], 
/** Project root, for completing ordinary input as a path. */
root?: string): [string[], string];
/**
 * The checkout this build is running from, or null when it cannot be found.
 *
 * Located the same way the launcher does: walk up from this module until the
 * CLI source appears.
 */
export declare function harnessCheckout(from?: string): string | null;
/**
 * Whether the project about to be worked on is gnomon's own checkout.
 *
 * Running `gnomon` from the harness directory is legitimate — that is how
 * gnomon is developed — but for anyone using gnomon on their own project it
 * is a mistake, and a quiet one: an entire session was spent auditing the
 * harness while its operator believed they were auditing their project. The
 * project root is already printed; this says what that root *is*.
 */
export declare function isSelfTargeting(projectRoot: string): boolean;
/**
 * "25 Aug 10:41" — short, sortable by eye, and not locale-dependent.
 *
 * toLocaleString would render differently per machine, which is the kind of
 * per-machine variation this harness avoids even in output nobody hashes.
 */
export declare function formatWhen(iso: string): string;
/** One row of the picker: when it was, how big, and what it was about. */
export declare function sessionRow(entry: SessionListEntry, widths: {
    role: number;
}, current: boolean): string;
/**
 * Choose a session with the arrow keys.
 *
 * Sessions were addressed by identifier — a timestamp with a process id — so
 * continuing one meant reading a list, copying a string, and typing it back.
 * The identifier is how the file is named, not how anyone recognises a
 * conversation; the date and the opening line are.
 *
 * Returns the chosen id, or null when cancelled.
 */
/**
 * Point a role at a model, in place.
 *
 * A surgical line edit rather than a re-serialise. roles.toml is written by
 * hand and carries the comments explaining why each role is scoped the way it
 * is; round-tripping it through a parser would discard exactly the part a
 * reader needs. Only the `model` (and optionally `endpoint`) line inside
 * `[roles.<name>]` is touched.
 *
 * A `[roles.<name>.fallback]` block starts with `[`, so it ends the section
 * and is left alone — changing a role's model must not silently change what
 * it falls back to.
 */
export declare function setRoleModel(text: string, role: string, model: string, endpoint?: string): string;
/**
 * Write an [endpoints.<name>] block into config.toml, in place.
 *
 * Rewrites the whole body rather than patching key by key, which is what
 * removes a plaintext `api_key` line rather than leaving it beside the
 * `api_key_env` that replaces it. Every comment in the block survives — those
 * before the first setting stay above it, those after stay below — because
 * the prose in a surface file is how the next reader learns what the block is
 * for, and a writer that eats it teaches people not to write any.
 *
 * TOML tables are order-independent, so a new block is appended at the end of
 * the file: no guessing where the endpoints section stops, and no comment
 * displaced.
 */
export declare function setEndpointBlock(text: string, name: string, fields: {
    url: string;
    kind: string;
    api_key_env?: string;
    provider?: string;
}): string;
/** One row in a picker. */
export interface PickItem {
    /** Returned when this row is chosen */
    key: string;
    label: string;
    /** Dimmed, after the label */
    hint?: string;
    /** Marked as the one currently in force */
    current?: boolean;
}
/**
 * Choose one row from a list, with the arrows and a filter.
 *
 * One keyboard implementation, shared. A second copy is how the argument
 * parser came to be tested while the shipped one stayed broken, and picker
 * key handling has its own history here: rl.pause() also pauses the stream
 * the keys arrive on, which made an early version impossible to drive at all.
 *
 * The window is a fixed height whatever the list length — always `rows` lines,
 * padded — so the redraw can move the cursor by a constant and never tears.
 * Sixty models will not scroll a terminal away; they scroll inside the window.
 */
export declare function pickFromList(items: PickItem[], opts: {
    title: string;
    rows?: number;
    start?: number;
}, ui: ResolvedUi, rl: readline.Interface, out?: NodeJS.WriteStream): Promise<string | null>;
export declare function pickSession(entries: SessionListEntry[], currentId: string, ui: ResolvedUi, rl: readline.Interface, out?: NodeJS.WriteStream): Promise<string | null>;
/**
 * Draw the matching commands under the prompt as the line is typed.
 *
 * Tab completion only helps someone who already knows a command exists.
 * Typing `/` and being shown what there is turns the prompt into the index,
 * so `/help` stops being the only way in.
 *
 * The menu is drawn below the cursor and erased before every redraw, using
 * save/restore rather than counting lines — the input line can wrap, and a
 * fixed offset would tear the display when it does.
 */
export declare class CommandMenu {
    private readonly out;
    private readonly ui;
    private shown;
    private rows;
    constructor(out: NodeJS.WriteStream, ui: () => ResolvedUi);
    private get live();
    /** Matching commands for a partial line, or null when no menu applies. */
    static matches(line: string): CommandSpec[] | null;
    render(line: string): void;
    /** Erase the menu. Safe to call when nothing is drawn. */
    clear(): void;
}
/** Process a slash command; returns true if command was handled */
export declare function processCommand(cmd: string, state: PromptState): boolean;
/**
 * Run the interactive prompt loop.
 *
 * Reads user input from stdin, infers role, calls model API,
 * displays results.
 */
export interface PromptLoopOptions {
    /** Resume a saved session: an id, or true for the most recent */
    resume?: string | true;
    /**
     * Where the loop reads and writes. Defaults to the real stdio, which is the
     * only thing it ever used.
     *
     * A seam, not a feature. This function is 1,286 lines and was measured at 0%
     * coverage -- the least-tested code in the project and, by the project's own
     * post-mortems, where most defects have been found. It had no way in: it read
     * `process.stdin` directly, so nothing could drive it without a terminal. The
     * interactive [chain] wiring landed inside this untested range, which is
     * exactly the combination that produces a defect nobody sees.
     *
     * TTY-only behaviour stays guarded by `isTTY` and simply does not run when a
     * plain stream is supplied, so a test exercises the loop's decisions rather
     * than its terminal handling.
     */
    io?: {
        input: NodeJS.ReadableStream;
        output: NodeJS.WritableStream;
    };
}
export declare function runPromptLoop(config: GnomonConfig, initialRole?: string, options?: PromptLoopOptions): Promise<void>;
//# sourceMappingURL=prompt_loop.d.ts.map
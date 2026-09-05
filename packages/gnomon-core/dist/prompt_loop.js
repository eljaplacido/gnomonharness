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
import { execFileSync } from "node:child_process";
import { checkCitations } from "./citations.js";
import { resolve, dirname, join, relative, sep, basename } from "node:path";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routeRole, listRoles, listProfiles, resolveContext, resolveVerify, resolveResilience, resolveExtraRoots, resolveExec, resolveChain, resolveChainGate, declaredKeyVars, resolveLoop, LOOP_DEFAULTS, resolveUi, resolveEndpoint, resolveRouting, recomputeManifest, routeInput, listEndpoints, isLocalEndpoint, endpointClass, parseMetaFields, META_FIELDS, COT_MODES, loadConfig, auditSurface, probeEndpointAuth, } from "./config.js";
import { Progress, renderExchange, splitThinking, paint, THEMES, terminalThemeSequence, safeForPrompt, } from "./render.js";
export { isLocalEndpoint } from "./config.js";
import { buildToolSet, executeTool, needsApproval, concurrentSafe, globToRegExp, createSpillSink, ARGS_TRUNCATED, } from "./tools.js";
import { connectMcp } from "./mcp.js";
import { harnessBuild } from "./build.js";
import { mapBucket } from "./session.js";
import { loadSkills, loadProposedSkills, selectSkills, roleSkills, applySkills, SKILLS_DIR, withWorkingContext, } from "./skills.js";
import { AuditTrail, resolveAudit } from "./audit.js";
import { recordDegradation } from "./degradation.js";
import { explain, explainTopics, topicNames } from "./explain.js";
import { applyCredentials } from "./credentials.js";
import { resolveSessionStore, saveSession, loadSession, listSessions, SESSION_FORMAT, } from "./session_store.js";
/** The id this session saves under, or a placeholder before one is assigned. */
function sessionIdOf(state) {
    return state.sessionId ?? "(not started)";
}
/** The session's UI settings, resolving from the surface on first use. */
function uiOf(state) {
    if (!state.ui)
        state.ui = resolveUi(state.config);
    return state.ui;
}
// A theme with a `terminal` block recolours the whole terminal via OSC, which
// outlives the process — so once applied, the reset must fire on exit.
let bgThemeApplied = false;
let exitResetRegistered = false;
/** Apply (or reset) the terminal-wide colours of the current theme. TTY only. */
function applyTerminalTheme(ui, out = process.stdout) {
    if (!out.isTTY || !ui.color)
        return;
    const theme = THEMES[ui.theme];
    out.write(terminalThemeSequence(theme ?? null));
    if (theme?.terminal) {
        bgThemeApplied = true;
        if (!exitResetRegistered) {
            exitResetRegistered = true;
            // Restore the terminal's own colours on a normal exit. Deliberately not a
            // SIGINT/SIGTERM handler: the loop owns those, and clean exits flow
            // through readline's close into "exit" anyway.
            process.on("exit", () => {
                if (bgThemeApplied && process.stdout.isTTY) {
                    process.stdout.write(terminalThemeSequence(null));
                }
            });
        }
    }
    else {
        // Switched to a theme that leaves the terminal alone; the reset above
        // already went out, so nothing more is owed on exit.
        bgThemeApplied = false;
    }
}
/** The session's routing policy, resolving from the surface on first use. */
function routingOf(state) {
    if (!state.routing)
        state.routing = resolveRouting(state.config);
    return state.routing;
}
// ---------------------------------------------------------------------------
// Pasting
// ---------------------------------------------------------------------------
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
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
/**
 * Count the newlines a chunk carries inside paste markers.
 *
 * Pure, and stateful only through `inPaste`, because a paste larger than the
 * pipe buffer arrives in several chunks and the markers can land in different
 * ones — an 8KB paste that lost its opening marker would be read as 200 turns.
 */
export function scanPasteMarkers(chunk, inPaste) {
    let rest = chunk;
    let lines = 0;
    let open = inPaste;
    let sawPaste = false;
    while (rest.length > 0) {
        if (open) {
            const end = rest.indexOf(PASTE_END);
            const body = end === -1 ? rest : rest.slice(0, end);
            // A terminal sends CR for a newline inside a paste; count either, and
            // count CRLF once.
            lines += (body.match(/\r\n|\r|\n/g) ?? []).length;
            sawPaste = true;
            if (end === -1)
                break;
            open = false;
            rest = rest.slice(end + PASTE_END.length);
        }
        else {
            const start = rest.indexOf(PASTE_START);
            if (start === -1)
                break;
            open = true;
            rest = rest.slice(start + PASTE_START.length);
        }
    }
    return { lines, inPaste: open, sawPaste };
}
/**
 * Assemble held paste lines and the fragment left on the prompt line.
 *
 * The text after a paste's last newline is deliberately left in readline's
 * buffer rather than held: it stays editable, and it is where a typed question
 * about the pasted material naturally goes. Enter sends both as one input.
 */
export function joinPastedBlock(held, tail) {
    const block = [...held, tail];
    // A paste ending in a newline leaves an empty fragment behind. It is
    // punctuation, not content.
    while (block.length > 1 && (block[block.length - 1] ?? "").trim() === "") {
        block.pop();
    }
    return block.join("\n");
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
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/**
 * Whether a turn with this exit code is replayed into the next context.
 *
 * Buckets come from the published exit contract (docs/CONTRACTS.md): 0-1
 * result, 2-4 refusal, 10-13 apparatus_failure. Result and refusal are both
 * things the model said and both replay; apparatus_failure is the harness
 * reporting its own breakage and does not.
 */
export function isReplayable(code) {
    return mapBucket(code) !== "apparatus_failure";
}
/** Token cost of replaying one exchange (its user turn + its reply). */
function exchangeCost(e) {
    return (estimateTokens(e.input) +
        estimateTokens(splitThinking(e.output).answer || e.output));
}
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
export function buildMessages(state, systemPrompt, input) {
    const ctx = resolveContext(state.config);
    const messages = [];
    let notice;
    if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
    }
    // Folded turns live in the summary now; replaying them too would pay for
    // the same content twice.
    const usable = state.exchanges.filter((e) => isReplayable(e.code) && !e.folded);
    if (state.summary) {
        messages.push({
            role: "system",
            content: `[gnomon context] Summary of earlier turns in this session, folded ` +
                `because they no longer fit the window:\n\n${state.summary}`,
        });
    }
    // The reply needs room too, and estimateTokens under-counts code. Both
    // point the same way, so one reserve covers both.
    const budget = Math.max(0, ctx.max_context_tokens -
        ctx.reserve_output -
        estimateTokens(systemPrompt) -
        estimateTokens(input) -
        estimateTokens(state.summary ?? ""));
    // policy = "summary" windows exactly like sliding_window; what differs is
    // what happens to the evicted turns, which is compaction's job. Setting
    // policy = "summary" implies compaction = "summary".
    const compaction = ctx.policy === "summary" ? "summary" : ctx.compaction;
    let head = [];
    let tail = [];
    let cursor = 0;
    if (ctx.policy === "full") {
        head = usable;
        cursor = usable.length;
    }
    else {
        // Never spend the anchor's budget so freely that the most recent turn
        // cannot fit. The opening ask is valuable; the turn just taken is what the
        // next one continues from, and losing that breaks the conversation in a
        // way losing the opening does not.
        const newest = usable[usable.length - 1];
        const newestCost = newest ? exchangeCost(newest) : 0;
        const headLimit = Math.min(ctx.retain_after, Math.max(0, budget - newestCost));
        let used = 0;
        for (; cursor < usable.length; cursor++) {
            const cost = exchangeCost(usable[cursor]);
            if (used + cost > headLimit)
                break;
            used += cost;
            head.push(usable[cursor]);
        }
        for (let j = usable.length - 1; j >= cursor; j--) {
            const cost = exchangeCost(usable[j]);
            if (used + cost > budget)
                break;
            used += cost;
            tail.unshift(usable[j]);
        }
    }
    const dropped = usable.slice(cursor, usable.length - tail.length);
    // Replay the answer, never the scratchpad. A <think> block is the model's
    // working, not something it said — feeding it back costs tokens and invites
    // the model to keep reasoning about a question it already answered.
    const replay = (e) => {
        messages.push({ role: "user", content: e.input });
        messages.push({
            role: "assistant",
            content: splitThinking(e.output).answer || e.output,
        });
    };
    head.forEach(replay);
    if (dropped.length > 0) {
        // Under compaction = "summary" these are about to be folded by
        // compactSession(); say they are pending rather than lost.
        const explain = compaction === "truncate"
            ? `[gnomon context] ${dropped.length} earlier turn(s) compacted to ` +
                `their prompts (compaction=truncate):\n` +
                dropped
                    .map((e) => `- turn ${e.turn} (${e.role}): ` +
                    `${e.input.slice(0, 120).replace(/\s+/g, " ")}`)
                    .join("\n")
            : compaction === "summary"
                ? `[gnomon context] ${dropped.length} earlier turn(s) are being ` +
                    `folded into the summary above.`
                : `[gnomon context] ${dropped.length} earlier turn(s) dropped to fit ` +
                    `the window (policy=${ctx.policy}, compaction=discard).`;
        messages.push({ role: "system", content: explain });
        // ...and tell the OPERATOR, not only the model.
        //
        // `notice` was declared here and never assigned, so both of its display
        // sites were unreachable and the human watching the session saw nothing at
        // all. The model was told in-band that turns had been dropped; the person
        // responsible for the session was not.
        //
        // That matters more than it looks: the shipped default is
        // `compaction = "discard"`, which measured 0/9 on context retention against
        // 9/9 for "summary". So the common case is a session that silently forgets
        // and then answers as though it never knew — with the one mechanism built
        // to warn about it sitting inert.
        // Reports what HAPPENED, not what the surface asked for.
        //
        // This chose its wording from `compaction` alone, so a surface declaring
        // `summary` was told "folded into the summary" whether or not anything had
        // been folded. With no reachable `context.summary_role` nothing can be:
        // compactIfNeeded refuses and the turns are dropped, and the operator was
        // told the opposite of that in the one message written to warn them.
        //
        // Found 2026-09-04 by `benchmarks/fault-disclosure/`, and reachable by
        // DEFAULT since `compaction` became `summary` earlier the same day — which
        // is what made an already-wrong message start mattering. The tell that it
        // was folded is a summary existing; `state.summary` is where compaction
        // puts one.
        const foldedForReal = compaction === "summary" && Boolean(state.summary);
        notice = foldedForReal
            ? `${dropped.length} earlier turn(s) folded into the summary to fit the window.`
            : compaction === "summary"
                ? `${dropped.length} earlier turn(s) DROPPED to fit the window — ` +
                    `compaction = "summary" is set but nothing has been folded, so they ` +
                    `are gone. Check that context.summary_role names a role this surface ` +
                    `defines and that its endpoint is reachable.`
                : `${dropped.length} earlier turn(s) DROPPED to fit the window ` +
                    `(compaction=${compaction} — they are gone, not summarised). ` +
                    `Set compaction = "summary" in .gnomon/config.toml to fold them instead.`;
    }
    tail.forEach(replay);
    messages.push({ role: "user", content: input });
    return {
        messages,
        evicted: dropped,
        included: head.length + tail.length,
        dropped: dropped.length,
        tokens: messages.reduce((n, m) => n + estimateTokens(m.content), 0),
        budget,
        notice,
    };
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
export function readUsage(json) {
    const j = json;
    if (!j || typeof j !== "object")
        return undefined;
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : undefined);
    const input = num(j.usage?.prompt_tokens) ?? num(j.prompt_eval_count);
    const output = num(j.usage?.completion_tokens) ?? num(j.eval_count);
    // Ollama reports nanoseconds; OpenAI reports no duration at all.
    const ns = num(j.total_duration);
    const ms = ns === undefined ? undefined : Math.round(ns / 1e6);
    if (input === undefined && output === undefined && ms === undefined) {
        return undefined;
    }
    return { input, output, ms };
}
/** Add one call's usage into a running total for the turn. */
export function addUsage(total, next) {
    if (!next)
        return total;
    if (!total)
        return { ...next };
    const add = (a, b) => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    return {
        input: add(total.input, next.input),
        output: add(total.output, next.output),
        ms: add(total.ms, next.ms),
    };
}
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
export function classifyFailure(opts) {
    const { status, errName, message = "" } = opts;
    if (errName === "TimeoutError" || /timed? ?out/i.test(message))
        return 11;
    if (/context length|maximum context|too many tokens|context_length/i.test(message)) {
        return 13;
    }
    if (status === undefined) {
        // A transport error with no HTTP status: refused, DNS, socket hangup.
        return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|fetch failed|socket hang up|network/i
            .test(message)
            ? 12
            : 10;
    }
    if (status === 429 || status >= 500)
        return 12;
    if (status === 408)
        return 11;
    return 10;
}
/**
 * Marks arguments that arrived as a string the endpoint never finished.
 *
 * A partial response is one of the four canonical agent faults, and it used to
 * be indistinguishable here from a call with no arguments: `JSON.parse` threw,
 * the catch returned `{}`, and `read {"path": "src/ma` -- a call truncated by a
 * token limit -- reached the tool as `read {}`. The tool then answered
 * "read needs a `path`. Nothing was given", which is FALSE and points the model
 * at the wrong repair: told an argument is missing it invents one, told its
 * call was truncated it re-emits it. Nothing crashed and nothing said so.
 */
/** Tool arguments arrive as an object (Ollama) or a JSON string (OpenAI). */
function parseToolArgs(raw) {
    if (raw && typeof raw === "object")
        return raw;
    if (typeof raw === "string") {
        // An empty string is a call with no arguments, which is legitimate for a
        // tool that takes none. Only a non-empty string that will not parse is a
        // truncation.
        if (raw.trim() === "")
            return {};
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : {};
        }
        catch {
            return { [ARGS_TRUNCATED]: raw };
        }
    }
    return {};
}
/**
 * Call one inference endpoint (Ollama /api/chat or any OpenAI-compatible
 * /chat/completions) with a hard timeout.
 *
 * Response parsing supports both shapes:
 * - Ollama:  { message: { content } } or { response }
 * - OpenAI:  { choices: [ { message: { content } } ] }
 */
/**
 * Call an endpoint, retrying only the failures that a second attempt can fix.
 *
 * 12 (unreachable, overloaded) and 11 (timed out) are worth trying again; 10
 * (a malformed request, a bad model tag) and 13 (the prompt did not fit) fail
 * the same way twice, and retrying them wastes the deadline.
 *
 * Every attempt is announced. A silent retry would make a session that took
 * three tries read as one, which is the part of this that would actually
 * violate the harness's own claims — not the retry itself.
 */
async function callEndpointWithRetry(target, messages, tools, timeoutMs, resilience, say, ui, signal) {
    const RETRYABLE = new Set([11, 12]);
    let last = null;
    // A timeout is not a flake. If a generation legitimately needs longer than the
    // deadline, repeating the call with the SAME deadline fails identically —
    // three guaranteed failures and the backoff on top. The config already makes
    // this argument about HTTP 400s ("will fail the same way twice, so retrying
    // them only burns the deadline"); it is just as true of code 11.
    //
    // Measured: 7 of 41 trials in one benchmark arm died on exactly this, all with
    // the same signature — two retries, then "aborted due to timeout" — against a
    // peer with no request deadline that completed the same calls. So a timed-out
    // attempt DOUBLES the deadline rather than repeating it. Unreachable (12) is a
    // real flake and keeps the plain retry.
    //
    // The escalation is bounded, and the bound is the point. Doubling without one
    // spends 300 + 600 + 1200 = 2100s where flat retrying spent 900 — so a run
    // that used to fail fast, inside its budget, with a recorded bucket, instead
    // got SIGKILLed by the harness wall and recorded NOTHING. Measured: 5 of 5
    // trials converted apparatus_failure -> agent_timeout. A harness that must
    // publish an exit contract cannot afford to be killed mid-call.
    //
    // So the whole retry sequence gets the budget flat retrying would have used —
    // timeoutMs x attempts — and escalation only redistributes it into fewer,
    // longer attempts. Worst-case wall is therefore unchanged from the flat
    // behaviour this replaced, which is what makes the escalation safe to ship:
    // it cannot push any caller past a deadline it was already surviving.
    //
    // Code 12 -- the endpoint refusing the socket -- is a different animal again,
    // and shipped with a hole in it. A refused fetch returns in about a
    // millisecond, so three attempts at 500ms and 1000ms of backoff tolerated a
    // grand total of ~1.5 SECONDS of provider outage, and then gave up having
    // spent essentially none of the budget it was holding. Measured: a 54-second
    // OpenRouter blip destroyed 4 concurrent trials at once, one of them 92 tool
    // calls deep, while the retry budget sat 99.9% unspent.
    //
    // So an unreachable endpoint no longer consumes a generation attempt. It gets
    // its own wall -- transport_grace_ms -- and keeps knocking, backing off
    // exponentially, until either the socket opens or the grace runs out. The
    // grace is additionally clamped by the same budget code 11 respects, so the
    // worst-case wall of this function is UNCHANGED. That is the property that
    // makes it safe to ship, exactly as it was for the timeout escalation above.
    //
    // It costs at most one grace period per turn, not per call: an endpoint still
    // unreachable when the grace expires returns apparatus_failure, which ends
    // the turn.
    const budgetMs = timeoutMs * resilience.attempts;
    const graceMs = Math.max(0, resilience.transport_grace_ms ?? 0);
    const MAX_TRANSPORT_WAIT_MS = 8_000;
    let spentMs = 0;
    let deadline = timeoutMs;
    let transportWaitedMs = 0;
    let transportTries = 0;
    /**
     * What the operator is told a code-12 retry was.
     *
     * `classifyFailure` folds 429 and 5xx and a refused socket all into 12,
     * which is right for RETRY POLICY -- another attempt can fix any of them --
     * and wrong for the notice, which used to call every one of them "endpoint
     * unreachable". A rate-limited endpoint is perfectly reachable and is
     * REJECTING you, and the remedies do not overlap: an unreachable endpoint
     * sends you to your network or your URL, a 429 sends you to your quota or a
     * different endpoint. Found 2026-09-04 by injecting a 429 storm and reading
     * what the operator was actually shown.
     */
    const transportKind = (r) => {
        const text = r.content ?? "";
        if (/\b429\b|rate.?limit/i.test(text))
            return "endpoint rate limiting (429)";
        if (/\b5\d\d\b|overloaded|unavailable/i.test(text))
            return "endpoint erroring (5xx)";
        return "endpoint unreachable";
    };
    for (let attempt = 1; attempt <= resilience.attempts; attempt++) {
        const startedAt = Date.now();
        const r = await callEndpoint(target, messages, tools, deadline, signal);
        spentMs += Date.now() - startedAt;
        if (r.code === 0 || !RETRYABLE.has(r.code))
            return r;
        last = r;
        if (signal?.aborted)
            return r;
        if (r.code === 12 && graceMs > 0) {
            transportTries++;
            const wait = Math.min(resilience.backoff_ms * Math.pow(2, transportTries - 1), MAX_TRANSPORT_WAIT_MS);
            const roomLeft = Math.min(graceMs - transportWaitedMs, budgetMs - spentMs);
            if (wait > roomLeft) {
                if (say && ui) {
                    say(paint(ui, "yellow", `  [retry] ${transportKind(r)} — grace spent (${transportWaitedMs}ms of ` +
                        `${graceMs}ms) after ${transportTries} attempt(s), giving up`));
                }
                return r;
            }
            transportWaitedMs += wait;
            spentMs += wait;
            if (say && ui) {
                say(paint(ui, "yellow", `  [retry] ${transportKind(r)} — attempt ${transportTries}, waiting ${wait}ms ` +
                    `(${transportWaitedMs}ms of ${graceMs}ms grace)`));
            }
            await new Promise((res) => setTimeout(res, wait));
            // An endpoint that never answered did not spend a generation attempt.
            attempt--;
            continue;
        }
        if (r.code === 11) {
            // Stop while the answer still fits in the budget. Starting an attempt
            // that cannot finish inside it buys nothing and forfeits the record.
            const remainingMs = budgetMs - spentMs;
            if (remainingMs < timeoutMs) {
                if (say && ui) {
                    say(paint(ui, "yellow", `  [retry] timed out — retry budget spent (${spentMs}ms of ${budgetMs}ms), giving up after ` +
                        `attempt ${attempt} of ${resilience.attempts}`));
                }
                return r;
            }
            deadline = Math.min(deadline * 2, remainingMs);
        }
        if (attempt < resilience.attempts) {
            const wait = resilience.backoff_ms * Math.pow(2, attempt - 1);
            spentMs += wait;
            if (say && ui) {
                say(paint(ui, "yellow", `  [retry] ${r.code === 11 ? `timed out (deadline now ${deadline}ms)` : transportKind(r)} ` +
                    `— attempt ${attempt} of ${resilience.attempts}, waiting ${wait}ms`));
            }
            await new Promise((res) => setTimeout(res, wait));
        }
    }
    return last;
}
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
export function isLoopbackUrl(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    }
    catch {
        return false;
    }
    // Node's URL keeps the BRACKETS on an IPv6 hostname -- `http://[::1]:1234`
    // gives hostname "[::1]", not "::1". Written the other way round first, and
    // the unit check caught it: every IPv6 loopback URL was classified remote and
    // got the generic message this exists to replace. It also normalises the long
    // form, so `[0:0:0:0:0:0:0:1]` arrives as `[::1]` and only `::1` need match.
    if (host.startsWith("[") && host.endsWith("]"))
        host = host.slice(1, -1);
    if (host === "localhost" || host.endsWith(".localhost"))
        return true;
    if (host === "::1" || host === "0:0:0:0:0:0:0:1")
        return true;
    // 0.0.0.0 is not routable as a destination; connecting to it hits this host.
    if (host === "0.0.0.0" || host === "::")
        return true;
    // The whole 127.0.0.0/8 block, not just 127.0.0.1 -- llama.cpp and friends
    // are routinely bound to 127.0.0.2 and up on a busy box.
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
/**
 * The real errno behind a fetch failure.
 *
 * Node's fetch throws `TypeError: fetch failed` and hangs the actual cause off
 * `.cause` -- so matching ECONNREFUSED against `err.message` never matches, and
 * every transport failure looked identical. Walk the chain (bounded; causes can
 * be self-referential) and return the first `code` found.
 */
export function causeCode(err) {
    let cur = err;
    for (let i = 0; i < 8 && cur; i++) {
        const c = cur.code;
        if (typeof c === "string")
            return c;
        cur = cur.cause;
    }
    return undefined;
}
async function callEndpoint(target, messages, tools, timeoutMs, signal) {
    const headers = { "Content-Type": "application/json" };
    const apiKey = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
    // Pre-flight the declared key, before the socket is opened.
    //
    // The surface declaring `api_key_env = "X"` is the surface stating that this
    // endpoint does not work without $X. When $X was unset we sent the request
    // anyway, with no Authorization header, and handed the user back whatever the
    // provider said -- for the two defaults that is `Model API error: 401
    // Unauthorized` plus a provider JSON blob. That names neither the variable
    // the surface declared, nor the command that sets it, and it is the single
    // most likely thing to go wrong on a first run.
    //
    // Measured, driving a turn at an endpoint declaring api_key_env with that
    // variable unset: before, 1 request went out and the turn returned
    // `Model API error: 401 Unauthorized` + `invalid x-api-key`; after, 0
    // requests go out and the turn returns the variable name and the command.
    //
    // Costs one boolean on a value the line above already computed, so the happy
    // path is unchanged -- verified by a control that sets the key and asserts
    // the request still goes out carrying `Bearer <key>`.
    //
    // Code 10 (`launch_failed`), not 12: 12 is in RETRYABLE, so it would knock on
    // the endpoint for the whole transport grace first. There is no attempt count
    // at which an unset variable becomes set.
    //
    // Empty counts as missing. `export X=` yields "", which sends `Bearer ` and
    // 401s exactly like no header at all, so treating it as present would put the
    // user back in front of the raw provider error this exists to replace.
    if (target.apiKeyEnv && !apiKey) {
        const where = target.endpoint ? `endpoint "${target.endpoint}"` : `endpoint ${target.url}`;
        return {
            content: `No API key: ${where} declares api_key_env = "${target.apiKeyEnv}", ` +
                `and $${target.apiKeyEnv} is not set in this environment.\n\n` +
                `Set it with:\n` +
                (target.endpoint
                    ? `  gnomon key set ${target.endpoint}\n`
                    : `  export ${target.apiKeyEnv}=<your key>\n`) +
                `\nNo request was sent, so nothing was billed. ` +
                `Run \`gnomon endpoint list\` to see which endpoints have a key.`,
            code: 10,
            toolCalls: [],
        };
    }
    if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
    }
    // Sampling params in the shape THIS endpoint accepts, and only that shape.
    //
    // This used to send both — top-level for OpenAI and a nested `options` object
    // for Ollama — with the comment "send both so either backend is happy". Ollama
    // is happy to ignore unknown fields. Strict OpenAI-compatible providers are
    // not: opencode's Console Go rejects the whole request with
    //
    //   400 invalid_request_error: Extra inputs are not permitted, field: 'options'
    //
    // So "send both" did not widen compatibility, it broke every strict provider —
    // and only for roles that declare `temperature`/`top_p`, which the scaffold
    // writes for every role. The failure names a field the user never wrote, in a
    // request they cannot see, so there is nothing in the surface to go and fix.
    //
    // `kind` is already resolved on the target and defaults to ollama, matching
    // how /endpoints renders it.
    // Messages carry BOTH spellings of a tool result — `tool_call_id` (OpenAI)
    // and `tool_name` (Ollama) — for the same "send both and hope" reason the
    // sampling params did. Strict providers reject the surplus one:
    //
    //   400 Extra inputs are not permitted, field: 'messages[3].tool_name'
    //
    // Filtering by an ALLOW-LIST per kind, not by deleting the field this week's
    // error happened to name. The `options` leak was fixed by name first, and the
    // next request straight after failed on `tool_name` — same defect, one field
    // along. A whitelist cannot drift that way: a field added to ChatMessage
    // later is dropped for the backend that did not ask for it.
    const OPENAI_MESSAGE_KEYS = new Set(["role", "content", "tool_calls", "tool_call_id", "name"]);
    const OLLAMA_MESSAGE_KEYS = new Set(["role", "content", "tool_calls", "tool_name"]);
    const isOllama = (target.kind ?? "ollama") === "ollama";
    const allowedKeys = isOllama ? OLLAMA_MESSAGE_KEYS : OPENAI_MESSAGE_KEYS;
    const wireMessages = messages.map((m) => {
        const out = {};
        for (const [k, v] of Object.entries(m)) {
            if (v !== undefined && allowedKeys.has(k))
                out[k] = v;
        }
        return out;
    });
    const payload = {
        model: target.model,
        messages: wireMessages,
        stream: false,
    };
    if ((target.kind ?? "ollama") === "ollama") {
        payload.options = { temperature: target.temperature, top_p: target.top_p };
    }
    else {
        payload.temperature = target.temperature;
        payload.top_p = target.top_p;
    }
    if (tools.length > 0)
        payload.tools = tools;
    try {
        const res = await fetch(target.url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            // Either the request deadline or the user pressing Esc ends the call.
            signal: signal
                ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
                : AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            // The body carries the reason; the status alone does not. Reporting
            // "400 Bad Request" and discarding the explanation sent a real session
            // hunting for a missing model that was in fact installed and working —
            // it simply could not accept a tools array.
            const body = await res.text().catch(() => "");
            const detail = (() => {
                try {
                    const parsed = JSON.parse(body);
                    return typeof parsed?.error === "string" ? parsed.error : body;
                }
                catch {
                    return body;
                }
            })().trim();
            // A rejected credential, told as a credential problem.
            //
            // The pre-flight above catches an UNSET declared variable. This is the
            // other half: a variable that is set but wrong or expired, or an endpoint
            // whose surface declares no api_key_env at all against a provider that
            // demands one. Both arrived as a bare `Model API error: 401 Unauthorized`
            // and a provider blob, which does not say which of the declared endpoints
            // rejected it or which variable supplied the key that was rejected.
            const authHint = res.status === 401 || res.status === 403
                ? `\n\n` +
                    (target.apiKeyEnv
                        ? `The key came from $${target.apiKeyEnv}` +
                            (target.endpoint ? ` (endpoint "${target.endpoint}")` : "") +
                            `, so it is set but the provider rejected it — wrong key, wrong ` +
                            `account, or expired. Replace it with: gnomon key set ` +
                            `${target.endpoint ?? "<endpoint>"}`
                        : (target.endpoint
                            ? `Endpoint "${target.endpoint}" declares no api_key_env`
                            : `This endpoint declares no api_key_env`) +
                            `, so no Authorization header was sent. If this provider needs ` +
                            `a key, add api_key_env = "<VARIABLE>" to its [endpoints] block ` +
                            `in .gnomon/config.toml, then: gnomon key set ` +
                            `${target.endpoint ?? "<endpoint>"}`)
                : "";
            return {
                content: `Model API error: ${res.status} ${res.statusText}` +
                    (detail ? `\n${detail.slice(0, 500)}` : "") +
                    authHint,
                code: classifyFailure({ status: res.status, message: detail }),
                toolCalls: [],
                toolsUnsupported: res.status === 400 && /does not support tools/i.test(detail),
            };
        }
        const json = await res.json();
        const message = json.choices?.[0]?.message ?? json.message ?? {};
        // reasoning_content is read, and last. A reasoning model that answers only
        // in its thinking channel returns content: null, which this read as "" — an
        // empty turn the loop then labelled a completed answer. Measured on one
        // benchmark arm: 5 of 13 failures were a zero-tool-call, zero-text turn
        // recorded as `answered`, and the outcome split was absolute — empty final
        // answer 0/10 passed, prose final answer 7/10 passed. Two other models on
        // the same tasks and the same prompt never produced one, so this is the
        // transport reading, not the prompt.
        const content = message.content ??
            json.response ??
            message.reasoning_content ??
            message.reasoning ??
            "";
        const finishReason = json.choices?.[0]?.finish_reason ?? json.done_reason;
        const raw = Array.isArray(message.tool_calls)
            ? message.tool_calls
            : [];
        const toolCalls = raw.map((c) => {
            const call = c;
            return {
                id: call.id,
                name: call.function?.name ?? call.name ?? "",
                args: parseToolArgs(call.function?.arguments ?? call.arguments),
            };
        });
        return { content, code: 0, toolCalls, rawToolCalls: raw, usage: readUsage(json), finishReason };
    }
    catch (err) {
        if (signal?.aborted) {
            return { content: CANCELLED, code: 2, toolCalls: [] };
        }
        const msg = err instanceof Error ? err.message : String(err);
        const errno = causeCode(err);
        // Nothing is listening on this box.
        //
        // The generic line was `Model unavailable at http://127.0.0.1:11434/api/chat:
        // fetch failed`, which is true and useless: "fetch failed" is what Node's
        // fetch says for a DNS failure, a TLS failure, a reset and a refusal alike,
        // and the user cannot tell from it whether the address is wrong, the network
        // is down, or they simply never started the server. On a first run it is
        // almost always the last one.
        //
        // ECONNREFUSED to a loopback address is the one case that admits a single
        // definite reading: the kernel answered, and no process holds that port.
        // That is worth saying plainly, with the port in it.
        //
        // LIMIT, published rather than implied: this changes the MESSAGE, not the
        // retry policy. `transport_grace_ms` still applies, so an unreachable
        // endpoint is still knocked on for the configured grace before the turn
        // ends -- the [retry] lines above say so as it happens. Shortening that for
        // loopback would silently redefine a declared resilience setting, and a
        // user starting the server in another terminal is exactly who the grace
        // helps. NOT VERIFIED: no measurement of how often that second case occurs.
        if (errno === "ECONNREFUSED" && isLoopbackUrl(target.url)) {
            let where = target.url;
            try {
                const u = new URL(target.url);
                where = `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
            }
            catch {
                /* keep the raw URL */
            }
            return {
                content: `Nothing is listening on ${where} — the connection was refused, ` +
                    `so no server is running there.\n\n` +
                    `This is a local endpoint` +
                    (target.endpoint ? ` ("${target.endpoint}", ${target.url})` : ` (${target.url})`) +
                    `, so gnomon cannot start it for you. Start the model server, then ` +
                    `retry:\n` +
                    `  ollama serve            # if this endpoint is Ollama\n` +
                    `  gnomon endpoint list    # lists every endpoint and what answers\n\n` +
                    `If the server IS running, it is on a different port than the surface ` +
                    `declares — check [endpoints] in .gnomon/config.toml.`,
                code: classifyFailure({
                    errName: err instanceof Error ? err.name : undefined,
                    message: msg,
                }),
                toolCalls: [],
            };
        }
        return {
            content: `Model unavailable at ${target.url}: ${msg}` +
                // The errno is the whole diagnosis and Node buries it on `.cause`, so
                // surface it. Without this every transport failure read "fetch failed".
                (errno && !msg.includes(errno) ? ` (${errno})` : ""),
            code: classifyFailure({
                errName: err instanceof Error ? err.name : undefined,
                message: msg,
            }),
            toolCalls: [],
        };
    }
}
/** Marker text for a turn the user stopped. Code 2 → bucket `refusal`. */
export const CANCELLED = "Cancelled.";
/** Default per-request timeout. Cold-loading large local models needs headroom. */
/**
 * How long to wait on one model call.
 *
 * This came from GNOMON_MODEL_TIMEOUT_MS, which is a machine-scoped setting for
 * something that is not machine-scoped: the deadline decides what counts as
 * apparatus failure, and a harness that gives up after ten seconds here and two
 * minutes there is not the same harness. It lives in `[resilience]` in
 * config.toml now, hashed with everything else.
 *
 * The environment variable is still read when the surface says nothing, so an
 * existing shell alias keeps working — but the surface wins where it speaks,
 * and the startup banner names the override, as it already does for
 * GNOMON_MODEL_URL.
 */
function modelTimeoutMs(config) {
    if (config) {
        const declared = config.config
            ?.resilience?.request_timeout_ms;
        if (typeof declared === "number" && declared > 0)
            return Math.floor(declared);
    }
    const raw = parseInt(process.env.GNOMON_MODEL_TIMEOUT_MS ?? "", 10);
    if (Number.isFinite(raw) && raw > 0)
        return raw;
    // One default, not two. This hardcoded 120_000 while resolveResilience
    // defaulted request_timeout_ms to 300_000, so the same setting had two
    // different values depending on which path asked -- and a surface that
    // declared nothing got whichever the caller happened to use.
    return config ? resolveResilience(config).request_timeout_ms : 300_000;
}
// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------
/** Print a styled header */
function printBanner() {
    console.log("\n");
    console.log(" ╔══════════════════════════════════════════╗");
    console.log(" ║          gnomon — interactive mode       ║");
    console.log(" ║   Deterministic coding agent harness     ║");
    console.log(" ╚══════════════════════════════════════════╝");
    console.log("");
    console.log("/help for commands · /meta and /think to change what you see");
    console.log("/context for the window · /role <name> to switch role");
    console.log("Esc cancels the turn.  /mode suggest|auto lets the harness route.");
    console.log("Type /quit or Ctrl+C to exit.");
    console.log("");
}
/**
 * Print what the surface gets wrong, and say whether the session may start.
 *
 * Returns false when something fatal was found. Fatal is narrow on purpose —
 * a surface that cannot do what it claims, not one that is merely unusual —
 * because a harness that refuses to start over a warning is a harness people
 * route around.
 */
export function reportSurfaceProblems(problems, ui) {
    if (problems.length === 0)
        return true;
    const fatal = problems.filter((p) => p.fatal);
    console.log("");
    for (const p of problems) {
        const mark = p.fatal ? "✗" : "⚠";
        const colour = p.fatal ? "red" : "yellow";
        console.log(paint(ui, colour, `  ${mark} ${p.where}`));
        console.log(paint(ui, colour, `    ${p.problem}`));
        for (const line of p.fix.split("\n")) {
            console.log(paint(ui, "gray", `    → ${line}`));
        }
    }
    if (fatal.length > 0) {
        console.log("");
        console.log(paint(ui, "red", `  ${fatal.length} problem${fatal.length === 1 ? "" : "s"} above must be fixed before a session can start.`));
        return false;
    }
    console.log("");
    return true;
}
export function describeEndpoints(config) {
    const roles = listRoles(config);
    return listEndpoints(config).map((name) => {
        const endpoint = resolveEndpoint(config, name);
        const cls = endpointClass(endpoint.url, endpoint.kind, endpoint.provider);
        const primary = roles.filter((r) => (config.roles[r]?.endpoint ?? "local") === name);
        const fallback = roles.filter((r) => config.roles[r]?.fallback?.endpoint === name);
        const probeModel = (primary[0] ? config.roles[primary[0]]?.model : undefined) ??
            (fallback[0] ? config.roles[fallback[0]]?.fallback?.model : undefined);
        return { name, endpoint, where: cls.where, provider: cls.provider, primary, fallback, probeModel };
    });
}
/** Edit distance, bounded — only used to say "did you mean". */
function editDistance(a, b) {
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[n];
}
/**
 * Cross-check every role's model against the ids its endpoint advertises.
 *
 * Endpoints that cannot be listed (no key, unreachable, a provider that serves
 * no listing) yield NO entries rather than false ones: "we could not check" and
 * "we checked and it is wrong" must not look the same.
 */
export async function checkRoleModels(config) {
    const out = new Map();
    const listings = await listModels(config);
    const byEndpoint = new Map(listings.map((l) => [l.endpoint, l]));
    const roles = listRoles(config);
    for (const row of describeEndpoints(config)) {
        const listing = byEndpoint.get(row.name);
        if (!listing || listing.problem || listing.models.length === 0)
            continue;
        const have = listing.models;
        const checks = [];
        const consider = (role, model) => {
            if (!model)
                return;
            if (have.includes(model)) {
                checks.push({ role, model, ok: true, available: have.length });
                return;
            }
            // Ollama tags carry a `:tag` suffix the listing may spell differently;
            // an exact-prefix match on the bare name is still a real match.
            const bare = model.split(":")[0];
            if (have.some((h) => h === bare || h.startsWith(bare + ":"))) {
                checks.push({ role, model, ok: true, available: have.length });
                return;
            }
            // Compare against the bare id too. The commonest wrong form is a
            // provider prefix — `opencode-go/glm-5-3` — which is far enough from
            // `glm-5.3` in edit distance to suppress the suggestion at exactly the
            // moment it is most needed. Strip a leading `<something>/` and try again,
            // keeping whichever comparison is closer.
            const stripped = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
            let best;
            let bestD = Infinity;
            for (const h of have) {
                const d = Math.min(editDistance(model.toLowerCase(), h.toLowerCase()), editDistance(stripped.toLowerCase(), h.toLowerCase()));
                if (d < bestD) {
                    bestD = d;
                    best = h;
                }
            }
            // Only offer a suggestion when it is close enough to be a typo rather
            // than a different model entirely.
            const near = best !== undefined && bestD <= Math.max(3, Math.ceil(stripped.length * 0.34));
            checks.push({ role, model, ok: false, suggestion: near ? best : undefined, available: have.length });
        };
        for (const r of roles) {
            if ((config.roles[r]?.endpoint ?? "local") === row.name)
                consider(r, config.roles[r]?.model);
            if (config.roles[r]?.fallback?.endpoint === row.name) {
                consider(r + " (fallback)", config.roles[r]?.fallback?.model);
            }
        }
        if (checks.length > 0)
            out.set(row.name, checks);
    }
    return out;
}
/**
 * Render the endpoint listing.
 *
 * `probes` is null when nothing was tested, and the key line says exactly
 * that. It used to read "available" whenever the variable was non-empty,
 * which is how a revoked key looked healthy right up until a 401 landed in
 * the middle of a task — the listing was answering "is the variable set",
 * while every reader took it for "will this work".
 */
export function printEndpoints(rows, ui, probes, checks) {
    console.log("\nDeclared endpoints (.gnomon/config.toml [endpoints]):\n");
    // Grouped, with the group stated as a heading rather than as a word buried
    // mid-line. A surface routinely mixes the two — local for volume, cloud for
    // the hard roles — and "which of these costs money and needs a key" is the
    // first question anyone asks of this list. It used to be answerable only by
    // reading a ` · cloud · ` fragment between two other fields.
    const groups = [
        ["LOCAL — on this machine, no key, no bill", rows.filter((r) => r.where === "local")],
        ["CLOUD — remote, keyed, billed", rows.filter((r) => r.where !== "local")],
    ];
    for (const [heading, group] of groups) {
        if (group.length === 0)
            continue;
        console.log(paint(ui, "bold", `  ── ${heading} ${"─".repeat(Math.max(0, 46 - heading.length))}`));
        for (const row of group) {
            const { name, endpoint: ep } = row;
            console.log(`  ${paint(ui, "bold", name)}: ${ep.url}  [${ep.kind ?? "ollama"}] · ${row.provider}`);
            // An endpoint nothing points at is declared, not used. Saying so is the
            // difference between "it is not configured" and "it is configured and
            // nothing routes to it" — which look identical from a listing.
            if (row.primary.length === 0 && row.fallback.length === 0) {
                console.log(`      used by: (no role — declared but nothing routes here)`);
            }
            else {
                if (row.primary.length > 0)
                    console.log(`      used by: ${row.primary.join(", ")}`);
                if (row.fallback.length > 0)
                    console.log(`      fallback for: ${row.fallback.join(", ")}`);
            }
            if (ep.api_key_env) {
                const set = Boolean(process.env[ep.api_key_env]);
                if (!set) {
                    console.log(paint(ui, "yellow", `      key: $${ep.api_key_env} — NOT SET — run: gnomon key set ${name}`));
                }
                else {
                    console.log(`      key: $${ep.api_key_env} — set${probes ? "" : " (untested)"}`);
                }
            }
            // Does every role pointed here name a model this endpoint actually serves?
            // Absent when the endpoint could not be listed — silence means unchecked,
            // never checked-and-fine.
            const rowChecks = checks?.get(name);
            if (rowChecks && rowChecks.length > 0) {
                const bad = rowChecks.filter((c) => !c.ok);
                if (bad.length === 0) {
                    const shown = [...new Set(rowChecks.map((c) => c.model))].join(", ");
                    console.log(paint(ui, "green", `      ✓ model ids check out against this endpoint: ${shown}`));
                }
                else {
                    for (const c of bad) {
                        console.log(paint(ui, "red", `      ✗ role ${c.role} names model "${c.model}" — this endpoint does not serve it`));
                        if (c.suggestion) {
                            console.log(paint(ui, "yellow", `        did you mean:  ${c.suggestion}`));
                        }
                        console.log(paint(ui, "gray", `        ${c.available} model ids available here — /models lists them, and picks one for a role`));
                    }
                }
            }
            const probe = probes?.get(name);
            if (!probe)
                continue;
            if (probe.ok) {
                console.log(paint(ui, "green", `      ✓ answered a real completion as ${row.probeModel}`));
            }
            else {
                const status = probe.status ? `${probe.status} ` : "";
                console.log(paint(ui, "red", `      ✗ ${status}${(probe.detail ?? "no response").replace(/\s+/g, " ").slice(0, 160)}`));
                if (probe.status === 401 || probe.status === 403) {
                    console.log(paint(ui, "gray", `      → the key is rejected for inference. Replace it: gnomon key set ${name}`));
                }
                else if (probe.status === 404 || probe.status === 400) {
                    console.log(paint(ui, "gray", `      → "${row.probeModel}" may not be a tag this endpoint serves. /models lists them.`));
                }
            }
        }
        console.log("");
    }
    console.log(`Point a role at one with endpoint = "<name>" in roles.toml, or give\n` +
        `it a [roles.<name>.fallback] with its own model and endpoint.\n` +
        `/models picks a model for a role from what the endpoint actually serves,\n` +
        `which is the only way to be sure the id is one it will accept.`);
}
/** Print a styled exchange through the configurable renderer */
function printExchange(exchange, ui) {
    for (const line of renderExchange(exchange, ui)) {
        console.log(line);
    }
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
export function chainStop(gate, r) {
    if (gate === "never")
        return null;
    if (mapBucket(r.code) === "refusal")
        return "refusal";
    if (gate === "on_check" && r.verify !== undefined && r.verify !== "passed")
        return "verify";
    return null;
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
export const MAX_CONSECUTIVE_EMPTY = LOOP_DEFAULTS.max_consecutive_empty;
/**
 * Tool-call syntax a model emitted as PROSE instead of as a tool call.
 *
 * When a model's chat template does not match the transport's tool protocol it
 * writes the call out as text, and the loop then treats it as a finished answer.
 * Measured on a real audit run: 4 such blocks in a 675-byte "answer", 380 bytes
 * of it markup, recorded as a result. Nothing in the harness noticed.
 *
 * That is the same class as an empty completion -- the model did not answer, it
 * failed to call -- and it gets the same treatment: re-ask once, then record it
 * honestly rather than passing markup off as prose.
 */
const TEXT_TOOL_CALL = /<tool_call>|<\/?function\s*=|<\|tool.?call\|>|<function_calls>|\[TOOL_CALL\]/i;
/** Whether a completion is tool-call markup rather than an answer. */
export function looksLikeTextToolCall(content) {
    return TEXT_TOOL_CALL.test(content);
}
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
export function noteMarkupInAnswer(content, counters) {
    if (!looksLikeTextToolCall(content))
        return content;
    counters.text_tool_calls = (counters.text_tool_calls ?? 0) + 1;
    return (content +
        `\n\n_[gnomon: this reply contains tool-call markup as text. The model's chat ` +
        `template may not match this endpoint's tool protocol — check the endpoint \`kind\` ` +
        `and the model tag. The work above may still be sound; the REPORT is not reliable.]_`);
}
/** How many run notes are kept and replayed. Oldest fall off first.
 *  Default for `[loop] max_run_notes`; the live value comes from resolveLoop. */
export const MAX_RUN_NOTES = LOOP_DEFAULTS.max_run_notes;
/**
 * Where a read-only role starts being pushed to conclude, as a fraction of its
 * step budget. Only applies when the surface declared no converge_after of its
 * own, and only to a role that holds no tool which can change anything.
 *
 * Default for `[loop] read_only_converge_after`; the live value comes from
 * resolveLoop.
 */
export const READ_ONLY_CONVERGE_AFTER = LOOP_DEFAULTS.read_only_converge_after;
/** Refusals of one tool, all of its calls, before the loop says the policy may
 *  be wrong. Default for `[loop] all_refused_notice`. */
export const ALL_REFUSED_NOTICE = LOOP_DEFAULTS.all_refused_notice;
/** TOOL_DENIED, named here so the verify gate can recognise a declined check. */
const TOOL_DENIED_CODE = 2;
/**
 * Append a note, bounded, oldest first.
 *
 * Exported so the bound is testable: it lived in a closure inside the turn, and
 * a test written against the closure could only ever assert that rendering
 * works, not that the cap holds. A note store that grows without limit stops
 * being something the model can re-read and becomes context pressure — the very
 * problem compaction exists to relieve.
 */
export function pushNote(notes, turn, text, 
/**
 * The bound, from `[loop] max_run_notes`. Defaulted rather than required so
 * the existing three-argument callers -- including the tests that assert the
 * cap -- keep compiling and keep meaning what they meant.
 */
limit = MAX_RUN_NOTES) {
    notes.push({ turn, text });
    return notes.length > limit ? notes.slice(-limit) : notes;
}
/**
 * Per-turn tallies. Every field is a count of something the loop already
 * tracked; none of them is read back to decide anything, which is what keeps
 * this observation rather than control.
 */
/**
 * Stamp the answer's citation check onto the turn's counters.
 *
 * Inside the turn rather than in the interactive loop, so `gnomon task --json`
 * carries it too — that is the scripted path, and a record is exactly where a
 * measured fact belongs. It was in the loop only, and the one-shot record came
 * back with `citations: null`.
 */
function stampCitations(counters, answer, root) {
    try {
        const c = checkCitations(answer, root);
        counters.citations = { checked: c.checked, ok: c.ok, broken: c.broken.length, ambiguous: c.ambiguous };
    }
    catch {
        // Bookkeeping must never fail a turn.
    }
}
/**
 * Ask git what changed. Best-effort and bounded: a turn must not fail because
 * the project is not a repository, or because git is slow.
 */
export function measureTreeDelta(root) {
    const run = (args) => {
        try {
            return execFileSync("git", args, {
                cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
            });
        }
        catch {
            return null;
        }
    };
    const parse = (out) => {
        const m = new Map();
        for (const line of out.split("\n")) {
            const parts = line.split("\t");
            if (parts.length < 3)
                continue;
            const ins = Number(parts[0]);
            const del = Number(parts[1]);
            // "-" for binary files; count the file, not the lines.
            m.set(parts[2], [Number.isFinite(ins) ? ins : 0, Number.isFinite(del) ? del : 0]);
        }
        return m;
    };
    const plain = run(["diff", "--numstat", "HEAD"]) ?? run(["diff", "--numstat"]);
    if (plain === null)
        return { files: 0, insertions: 0, deletions: 0, crlf_only: 0, unavailable: "not a git worktree" };
    const a = parse(plain);
    const b = parse(run(["diff", "--numstat", "--ignore-cr-at-eol", "HEAD"]) ?? run(["diff", "--numstat", "--ignore-cr-at-eol"]) ?? "");
    let insertions = 0, deletions = 0, crlfOnly = 0;
    for (const [file, [i, d]] of a) {
        insertions += i;
        deletions += d;
        // Changed in the plain diff, unchanged once line endings are ignored.
        if (!b.has(file))
            crlfOnly++;
    }
    return { files: a.size, insertions, deletions, crlf_only: crlfOnly };
}
/**
 * Tool calls a role may make in one turn when its surface does not say.
 *
 * Exported because it was invisible: a role with no `max_steps` key looked
 * unlimited — a session read roles.toml, concluded "plan has no step limit",
 * and then hit this number. A default nobody can see is a default nobody can
 * plan around, so /roles and /explain now show the effective value.
 */
export const DEFAULT_MAX_STEPS = LOOP_DEFAULTS.max_steps;
/**
 * How many checkpoints a turn may pass before the wall.
 *
 * `max_steps` was a wall, so a long task ended mid-sentence and the operator
 * had to notice and re-prompt. In a session left running for hours nobody is
 * watching to do that, so it is a checkpoint now: the harness compacts and
 * continues, up to `max_steps * [loop] legs` unless the role says otherwise.
 */
export const DEFAULT_LEGS = LOOP_DEFAULTS.legs;
// STALL_REPEATS, NUDGE_AFTER_IDLE and CONVERGE_REFIRE used to live here as
// module constants. They are `[loop] stall_repeats`, `nudge_after_idle` and
// `converge_refire` now, read per turn through resolveLoop, and the measurements
// that produced each number moved with them onto the ResolvedLoop fields in
// config.ts — which is where a reader deciding what to write in config.toml
// looks. They were the three the harness-research reconciliation named by name:
// "today 12 can become 40 without moving a byte of the manifest".
//
// These two did NOT move, and saying so is the point of this comment. They
// govern the A-B-A-B alternation test below and are still compiled in, still
// outside the surface hash. So `[loop]` declares nine of the loop's numbers, not
// all of them, and a surface that pins every key in it is still not pinning
// this pair.
/** Window and distinct-signature bound for detecting an A-B-A-B poll loop. */
const STALL_WINDOW = 8;
const STALL_DISTINCT = 2;
/** A comparable identity for a tool call, for stall detection. */
function callSignature(call) {
    return `${call.name}:${JSON.stringify(call.args)}`;
}
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
export function trimWorking(working, budgetTokens) {
    const cost = (m) => estimateTokens(m.content);
    const total = working.reduce((n, m) => n + cost(m), 0);
    if (total <= budgetTokens)
        return { messages: working, dropped: 0 };
    // Everything before the first user message is instruction, and the first
    // user message is the task. Both are kept whatever the budget.
    const firstUser = working.findIndex((m) => m.role === "user");
    const head = firstUser === -1 ? working.slice() : working.slice(0, firstUser + 1);
    // ...but "the first user message is the task" only holds on turn ONE.
    // buildMessages replays earlier turns as user/assistant pairs, so from turn 2
    // the first user message is a REQUEST FROM EARLIER IN THE CONVERSATION, and
    // the current one sits further down. Tool traffic then accumulates after it,
    // and newest-first eviction reaches the current request before it reaches
    // that traffic. Measured on a second-turn conversation with 40 tool results:
    // the trim kept "rename the widget" from turn one and dropped "delete the
    // obsolete migration" that the turn was actually running -- so the model
    // carried on against a stale request, which is exactly the "losing the task
    // halfway through" outcome this function's own comment calls unrecoverable.
    //
    // Pin the LAST user message too. It is the only message whose loss cannot be
    // compensated by anything else in the window.
    const lastUser = working.map((m) => m.role).lastIndexOf("user");
    const pinnedIdx = lastUser > firstUser ? lastUser : -1;
    const pinned = pinnedIdx === -1 ? null : working[pinnedIdx];
    const tail = firstUser === -1
        ? []
        : working.slice(firstUser + 1).filter((_, k) => firstUser + 1 + k !== pinnedIdx);
    const headCost = head.reduce((n, m) => n + cost(m), 0);
    const kept = [];
    let used = headCost + (pinned ? cost(pinned) : 0);
    // Newest first: recent tool results are what the next call reasons from.
    for (let i = tail.length - 1; i >= 0; i--) {
        const c = cost(tail[i]);
        if (used + c > budgetTokens)
            break;
        used += c;
        kept.unshift(tail[i]);
    }
    // Back in front of the traffic it produced, where it reads as the request.
    if (pinned)
        kept.unshift(pinned);
    const dropped = tail.length - (kept.length - (pinned ? 1 : 0));
    if (dropped === 0)
        return { messages: working, dropped: 0 };
    // A tool result must not be the first thing after the head: some backends
    // reject a tool message that answers no visible call.
    while (kept.length > 0 && kept[0].role === "tool")
        kept.shift();
    return {
        messages: [
            ...head,
            {
                role: "system",
                content: `[gnomon context] ${dropped} earlier step(s) in this turn were dropped ` +
                    `to stay inside the context window. Their findings are not available ` +
                    `to re-read — if you need one again, gather it again.`,
            },
            ...kept,
        ],
        dropped,
    };
}
/** Severity order, so the worst outcome in a turn is the one reported. */
function worse(a, b) {
    const rank = (c) => mapBucket(c) === "apparatus_failure" ? 2 : mapBucket(c) === "refusal" ? 1 : 0;
    return rank(b) > rank(a) ? b : a;
}
/**
 * Settle a turn's reported code from its accumulated code and the code of the
 * step that actually ended it.
 *
 * apparatus_failure means the apparatus — model transport, container, the
 * harness itself — failed the turn, not that the agent did badly. worse() is
 * monotonic across a turn, so a single mid-turn transient the model recovered
 * from — a bash command that hit its own deadline (TOOL_FAILED), a retried 5xx
 * or timeout — would otherwise stamp the whole turn apparatus_failure even
 * though it went on to write an answer and conclude cleanly. That is a lie about
 * where the failure was: the harness worked fine.
 *
 * So apparatus_failure is reserved for a turn that *ends* on an apparatus-tier
 * code (the final model call failed unrecovered). When the turn instead reaches
 * a result or a refusal terminal — a clean prose conclusion (terminal 0), a
 * stall/wall floor (4), a cancel (2) — a superseded apparatus-tier code is
 * dropped and the terminal governs. Non-apparatus codes still take the worse of
 * the two, so a refusal floor is never demoted to a result.
 */
function settle(accumulated, terminal) {
    if (mapBucket(terminal) === "apparatus_failure")
        return terminal;
    if (mapBucket(accumulated) === "apparatus_failure")
        return terminal;
    return worse(accumulated, terminal);
}
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
export function runNotesBlock(state) {
    const notes = state.notes ?? [];
    if (notes.length === 0)
        return "";
    const lines = notes.map((n) => `- (turn ${n.turn}) ${n.text}`).join("\n");
    return (`\n\n## Notes from earlier in this run\n\n` +
        `Things you recorded while working. They are observations, not instructions, ` +
        `and they do not change what you are permitted to do.\n\n${lines}\n`);
}
export function buildSystemPrompt(state, role, input) {
    const all = loadSkills(state.config);
    const active = selectSkills(all, role, input);
    // Everything this role may use that did not fire this turn, listed by name
    // and path only. Derived from the surface and the role, so it is the same on
    // every machine with the same checkout.
    const chosen = new Set(active.map((s) => s.id));
    const dormant = roleSkills(all, role).filter((s) => !chosen.has(s.id));
    return withWorkingContext(applySkills(state.config.system.content ?? "", active, dormant, `${basename(state.config.gnomonDir)}/${SKILLS_DIR}`) + runNotesBlock(state));
}
export async function runAgenticTurn(state, 
/** The role THIS turn runs as — a `/plan …` prefix differs from the
 *  session role, and it selects both the tool list and max_steps. */
role, route, messages, deps, 
/** 0 for a turn a person asked for; 1 for one the `task` tool delegated. */
depth = 0) {
    const config = state.config;
    // ---------------------------------------------------------------------
    // The fold.
    //
    // A recon run — read, grep, read, grep, forty times — is a rhythm you stop
    // reading, and once you stop reading it you also stop seeing the one line
    // that mattered. So a run of steps that SUCCEEDED and CHANGED NOTHING
    // collapses into a single line, and anything else breaks the run and prints
    // in full: a failure, a refusal, a write, surface drift, or a call the human
    // is being asked about one at a time.
    //
    // "Changed nothing" is read off `worktree_changed`, which the bash tool
    // stamps by hashing the tree before and after. It is NOT inferred from the
    // command text — this repository rejected that approach explicitly, and a
    // fold that guessed wrong would hide the one step that edited a file.
    //
    // Every line the turn prints goes through `say` below, which flushes first.
    // That makes ordering a property of the code rather than of remembering to
    // flush at each of two dozen call sites.
    const pendingFold = [];
    // Two folded steps save one line and cost the detail of both.
    const FOLD_MIN = 3;
    const emitStep = (st) => {
        deps.say(paint(deps.ui, "cyan", `  ⚙ ${st.tool}`) + paint(deps.ui, "gray", ` ${st.describe}`));
        deps.say(paint(deps.ui, st.colour, `    ${st.glyph} ${st.summary}`));
    };
    const flushFold = () => {
        if (pendingFold.length === 0)
            return;
        const steps_ = pendingFold.splice(0, pendingFold.length);
        if (steps_.length < FOLD_MIN) {
            for (const st of steps_)
                emitStep(st);
            return;
        }
        state.lastFold = steps_;
        const counts = new Map();
        for (const st of steps_)
            counts.set(st.tool, (counts.get(st.tool) ?? 0) + 1);
        const byTool = [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([t, n]) => (n > 1 ? `${t} ×${n}` : t))
            .join(", ");
        // Only paths the ARGS declared. `bash` declares none, so an all-bash run
        // names none rather than having its command text mined for something that
        // looks like one.
        const paths = [...new Set(steps_.map((st) => st.path).filter(Boolean))];
        const shown = paths.slice(0, 3).join(", ") + (paths.length > 3 ? `, +${paths.length - 3}` : "");
        deps.say(paint(deps.ui, "cyan", `  ⚙ ${steps_.length} steps folded`) +
            paint(deps.ui, "gray", ` · ${byTool}${paths.length ? ` · ${shown}` : ""} · nothing changed`) +
            paint(deps.ui, "gray", `  /expand`));
        // With no declared path there is nothing above saying what the run was
        // about, so name where it started. Verbatim and truncated, never summarised.
        if (paths.length === 0) {
            deps.say(paint(deps.ui, "gray", `      from  ${steps_[0].describe}`));
        }
    };
    /** Every transcript line in this turn. Flushes the fold so order holds. */
    const say = (line) => {
        flushFold();
        deps.say(line);
    };
    // The loop's own numbers, from the surface rather than from this file. Read
    // once per turn so a `[loop]` block is hashed into the record that describes
    // the turn it governed, exactly as [resilience] and [context] already are.
    const loop = resolveLoop(config);
    const toolSet = buildToolSet(config, role, state.mcp?.tools() ?? []);
    // A sub-turn is offered no `task`, so delegation cannot nest. Enforced here
    // rather than only in the tool, so the schema the model sees is the truth
    // about what it can call.
    if (depth > 0) {
        toolSet.schemas = toolSet.schemas.filter((t) => t.function.name !== "task");
    }
    const offered = new Set(toolSet.schemas.map((t) => t.function.name));
    const defaults = config.config.defaults ?? {};
    const policy = config.policy ?? {};
    const gate = (policy.approval?.gate ??
        defaults.approval ??
        "on_write");
    const sandbox = state.sandbox ??
        (policy.sandbox?.level ??
            defaults.sandbox ??
            "confined");
    // Session grant wins over the declared default; the surface is unchanged.
    const declaredNetwork = policy.sandbox?.network;
    const network = state.network ?? declaredNetwork;
    const ctx = {
        config,
        bashAllow: config.roles[role]?.bash_allow,
        bashDeny: config.roles[role]?.bash_deny,
        writeAllow: config.roles[role]?.write_allow,
        root: resolve(config.gnomonDir, ".."),
        sandbox,
        // Declared in policy.toml, hashed with the surface. A grant that does not
        // move the surface hash would be a grant nobody could audit.
        extraRoots: resolveExtraRoots(config),
        taskAllow: config.roles[role]?.task_allow,
        // Where bash runs. "off" by default, so nothing moves unless a surface
        // asks for it.
        exec: resolveExec(config, role),
        gate,
        approve: deps.approve,
        timeoutMs: toolTimeoutMs(config),
        maxOutputBytes: 32_000,
        // Created once per session and memoised, so file numbering is continuous
        // across turns. Before a session id is assigned there is still a process
        // to name, and scratch from an unnamed run is still better than bytes
        // thrown away.
        spill: (state.spill ??= createSpillSink(resolve(config.gnomonDir, ".."), state.sessionId ?? `pid-${process.pid}`)),
        network,
        // Turn-scoped: a command that blocked once will block again, and the loop
        // owns the lifetime of that fact.
        timedOutCommands: new Set(),
        // So Esc reaches a command that has already started, not just the gap
        // between two of them.
        signal: deps.signal,
        // What each file looked like before this turn touched it. Enables the
        // test-must-fail-first check below; costs one string per modified file.
        preImages: new Map(),
        notes: {
            list: () => state.notes ?? [],
            add: (text) => {
                state.notes = pushNote(state.notes ?? [], state.exchanges.length + 1, text, loop.max_run_notes);
            },
        },
        // Connected MCP servers (mcp__… calls route here); undefined if none.
        mcp: state.mcp,
        // Surface-edit consent, human-set via /allow. A delegated sub-turn is
        // forced to strict here — its instruction was chosen by the parent model,
        // not the human, so it must never inherit the human's surface consent.
        allow: depth > 0 ? "strict" : state.allow,
        todos: {
            list: () => state.todos ?? [],
            replace: (t) => {
                state.todos = t;
            },
        },
        delegate: {
            depth,
            roles: () => listRoles(config),
            run: async (subRole, instruction) => {
                // A fresh message list: the sub-turn sees its instruction and the
                // system prompt for its own role, and nothing of this conversation.
                // That isolation is the reason to delegate at all.
                const subRoute = routeRole(config, subRole);
                const system = buildSystemPrompt(state, subRole, instruction);
                const sub = await runAgenticTurn(state, subRole, subRoute, [
                    ...(system ? [{ role: "system", content: system }] : []),
                    { role: "user", content: instruction },
                ], deps, depth + 1);
                return {
                    content: sub.content,
                    code: sub.code,
                    toolSteps: sub.toolSteps,
                    model: sub.model,
                };
            },
        },
    };
    const roleDef = config.roles[role] ?? {};
    const maxSteps = typeof roleDef.max_steps === "number" ? roleDef.max_steps : loop.max_steps;
    // max_steps is a checkpoint; this is the wall. A session left running for
    // hours cannot be asked to notice a stall and re-prompt by hand.
    const maxTotal = typeof roleDef.max_steps_total === "number"
        ? roleDef.max_steps_total
        : maxSteps * loop.legs;
    // Step at which the role starts being pushed to converge (submit-or-conclude).
    // Absent / non-positive converge_after means never — full exploration to the
    // wall, which is what wins on capable models. A step count, never wall-clock,
    // so the same surface behaves the same on a fast and a slow box.
    // A role that cannot CHANGE anything has no reason to explore to the wall.
    //
    // converge_after ships unset everywhere, and unset means "never converge",
    // which the comment below defends as what wins on capable models. For a role
    // holding no write, edit or bash that defence does not apply: whatever it
    // finds, the only possible output is a report, so reading one more file can
    // never turn into work. Measured on a real read-only audit of a 229-file
    // repository: 65 tool calls, 54 of them reads, stop_reason step_wall, and no
    // answer at all -- the model read until the budget ran out.
    //
    // An explicit converge_after always wins; this only fills the silence, and
    // only for a role whose tools make exploration terminal.
    const readOnlyRole = !(roleDef.tools ?? []).some((t) => ["write", "edit", "bash", "task", "skill"].includes(t));
    const declaredConverge = typeof roleDef.converge_after === "number" && roleDef.converge_after > 0
        ? roleDef.converge_after
        : readOnlyRole && Array.isArray(roleDef.tools)
            ? loop.read_only_converge_after
            : 0;
    const convergeAt = declaredConverge > 0
        ? Math.floor(maxTotal * Math.min(1, declaredConverge))
        : Infinity;
    const ctxLimits = resolveContext(config);
    const working = [...messages];
    const toolLog = [];
    const surfaceChanges = [];
    // Whether this turn changed anything on disk. The verify gate is about the
    // difference between "said it did" and "did it", so it only has meaning
    // after a write or an edit.
    let touchedFiles = false;
    // Shell-mediated change, tracked SEPARATELY from touchedFiles rather than
    // folded into it. Folding would silently turn `after = "write"` into
    // `always` for any turn that shelled out, which is a published enumeration
    // changing meaning underneath every existing surface. This exists so the gap
    // can be DISCLOSED instead.
    let shellTouchedWorktree = false;
    const verify = resolveVerify(config);
    const resilience = resolveResilience(config);
    let verifyRounds = 0;
    let turnUsage;
    let code = 0;
    let steps = 0;
    let stepsThisLeg = 0;
    let leg = 1;
    // Calls since the last write/edit, and the count at which the model was last
    // nudged. Both reset on a successful write, so a fresh idle streak is nudged
    // from zero again and a long flail is re-nudged every nudge_after_idle calls
    // rather than reminded once and then left alone.
    let callsSinceWrite = 0;
    let callsAtLastNudge = 0;
    // Step at which convergence was last urged, so the push re-fires as the
    // remaining budget shrinks rather than being said once and forgotten. Seeded
    // so the first push lands exactly at convergeAt, then every converge_refire.
    let stepsAtLastConverge = convergeAt - loop.converge_refire;
    // Signatures of the last few calls, to notice a model going in circles.
    const recentCalls = [];
    let usedModel = route.model;
    // The target the model calls actually reached. Diverges from `route.target`
    // the moment a fallback fires, and the record has to follow the request
    // rather than the declaration.
    let usedTarget = route.target;
    // One re-prompt for an empty completion, per nudge cycle — not one per turn.
    //
    // The nudge re-fires every nudge_after_idle calls for as long as the turn
    // runs, but this latch was a single boolean for the whole turn, so the SECOND
    // empty completion always landed on a spent latch and ended the run. Measured:
    // one nudge is survivable (10/14 trials pass), two is not (1/11); six trials
    // ended nudge -> blank -> bucket and none of them resolved. Three of those six
    // were the entire residual gap against the peer harness.
    let consecutiveEmpty = 0;
    let truncationRetried = false;
    // The last outcome of the declared check. Last, not first: a failing check
    // hands the turn back, and the round after it is the one that counts.
    let verifyOutcome;
    // The finish_reason of the completion the turn ends on, so a reply the
    // backend cut off can be recorded as cut off rather than as an answer.
    let lastFinishReason;
    let overflowTrimmed = false;
    let textToolCallRetried = false;
    let emptyTerminus = false;
    // Observation only. Nothing below reads these back to decide anything — the
    // moment one of them gates a call, this stops being a record and becomes
    // control, and the nudge regression is the reminder of what that costs.
    const counters = {
        writes: 0,
        worktree_moves: 0,
        nudges: 0,
        final_step_was_write: false,
        per_tool: {},
    };
    const tally = (name, field) => {
        const t = (counters.per_tool[name] ??= { calls: 0, refusals: 0, apparatus: 0 });
        t[field]++;
    };
    // A cancelled turn still changed the tree if it got that far, and that is
    // exactly when someone wants to know what it left behind.
    const cancelled = () => {
        flushFold();
        counters.tree_delta = measureTreeDelta(resolve(state.config.gnomonDir, ".."));
        // No answer was produced, so there is nothing to cite-check. Left unset
        // rather than zeroed: "no citations checked" and "checked, none found"
        // are different facts.
        return {
            content: CANCELLED,
            code: settle(code, 2),
            model: usedModel,
            endpoint: usedTarget.endpoint,
            endpoint_url: usedTarget.url,
            verify: verifyOutcome,
            toolSteps: steps,
            toolLog,
            usage: turnUsage,
            stop_reason: "cancelled",
            counters,
            surface_changed: surfaceChanges.length > 0 ? surfaceChanges : undefined,
        };
    };
    const noTools = (state.noToolModels ??= new Set());
    /**
     * Call a target, coping with a model that cannot accept tools.
     *
     * Some models — reasoning distills especially — make the backend reject any
     * request carrying a tools array. Retrying without them is announced, not
     * silent: a turn that ran with fewer tools than the surface declared is
     * exactly what system.md says must never pass unremarked.
     */
    const call = async (target) => {
        const offer = noTools.has(target.model) ? [] : toolSet.schemas;
        let r = await callEndpointWithRetry(target, working, offer, resilience.request_timeout_ms, resilience, deps.say, deps.ui, deps.signal);
        turnUsage = addUsage(turnUsage, r.usage);
        if (r.toolsUnsupported && offer.length > 0) {
            noTools.add(target.model);
            deps.progress.stop();
            say(paint(deps.ui, "yellow", `  [tools] ${target.model} cannot accept tools — retrying without them.`));
            say(paint(deps.ui, "gray", `  this role's tools are unavailable for this model. To make that ` +
                `explicit, set tools = [] for "${role}" in roles.toml, or give the ` +
                `role a tool-capable model.`));
            recordDegradation(deps.audit, {
                id: "endpoint_tools_rejected",
                declared: `${offer.length} tool(s) offered to ${target.model}`,
                actual: "the endpoint refused the tools array; the turn ran without tools",
                detail: { model: target.model, role },
            });
            deps.progress.start(`${target.model} — without tools`);
            r = await callEndpoint(target, working, [], modelTimeoutMs(config), deps.signal);
            turnUsage = addUsage(turnUsage, r.usage);
        }
        return r;
    };
    for (;;) {
        if (deps.signal?.aborted)
            return cancelled();
        let result = await call(route.target);
        usedModel = route.model;
        if (deps.signal?.aborted)
            return cancelled();
        if (result.code !== 0 && route.fallback) {
            // Announced on the spinner ONLY, until 2026-09-05. `progress.update` is
            // overwritten by the very next frame, and `gnomon task` in a script has
            // no scrollback to overwrite — so the single most consequential thing
            // that can happen to a turn, "you are not talking to the model you
            // declared", left no trace a person could find afterwards. Said, and
            // recorded, and the spinner still updates because it is the fastest
            // signal for someone watching.
            deps.progress.stop();
            say(paint(deps.ui, "yellow", `  [endpoint] ${route.target.endpoint || route.target.url} did not answer ` +
                `— falling back to ${route.fallback.model} at ` +
                `${route.fallback.endpoint || route.fallback.url}.`));
            recordDegradation(deps.audit, {
                id: "endpoint_fallback",
                declared: `${route.model} at ${route.target.endpoint || route.target.url}`,
                actual: `${route.fallback.model} at ${route.fallback.endpoint || route.fallback.url}`,
                detail: { primary_code: result.code },
            });
            deps.progress.update(`${route.fallback.model} — primary unavailable, falling back`);
            usedModel = route.fallback.model;
            // The turn record used to name `route.target` unconditionally, so a
            // fallback turn was filed under the model that answered and the endpoint
            // that did not. `endpoint_url` exists precisely so the trail can tell two
            // runs that reached different servers apart (docs/EVIDENCE.md, Rule 1
            // caveat), and this path defeated it.
            usedTarget = route.fallback;
            result = await call(route.fallback);
            if (deps.signal?.aborted)
                return cancelled();
        }
        code = worse(code, result.code);
        // A turn with no tool calls AND no text is not an answer. It was recorded as
        // stop_reason "answered", which is how a loop that gave up got counted as a
        // model that concluded. Re-prompt once — as a user turn, because the only
        // mid-conversation system injection in a bench run is the nudge, and that is
        // exactly where these clustered — then terminate honestly if it repeats.
        //
        // Deliberately NOT bucketed as apparatus_failure: that would reclassify a
        // large share of trials and move the reported score with no behaviour
        // change. stop_reason is a separate axis from the bucket. Record it, do not
        // launder it.
        // A completion the backend cut off at the token limit is not a finished
        // answer, and finish_reason was parsed, returned, and then read by nothing:
        // "length" took the ordinary terminal branch and was recorded as
        // stop_reason "answered". Ask once for the rest, bounded like the blank
        // retry, then let it stand rather than looping.
        lastFinishReason = result.finishReason;
        if (result.code === 0 &&
            result.toolCalls.length === 0 &&
            result.finishReason === "length" &&
            !truncationRetried &&
            steps < maxTotal) {
            truncationRetried = true;
            say(paint(deps.ui, "yellow", `  [loop] the reply was cut off at the token limit — asking for the rest`));
            working.push({ role: "assistant", content: result.content });
            working.push({
                role: "user",
                content: `That reply was cut off at the token limit. Continue from exactly where ` +
                    `it stopped, or if the work is done, say so briefly.`,
            });
            continue;
        }
        // A model writing its tool call out as text has not answered either.
        if (result.code === 0 &&
            result.toolCalls.length === 0 &&
            looksLikeTextToolCall(result.content) &&
            !textToolCallRetried &&
            steps < maxTotal) {
            textToolCallRetried = true;
            counters.text_tool_calls = (counters.text_tool_calls ?? 0) + 1;
            say(paint(deps.ui, "yellow", `  [loop] the reply contained tool-call markup, not an answer — the model's ` +
                `template may not match this endpoint's tool protocol; asking once in plain text`));
            working.push({ role: "assistant", content: result.content });
            working.push({
                role: "user",
                content: `That reply contained tool-call markup as text rather than an actual tool call. ` +
                    `If you need a tool, call it properly. If you are finished, answer in plain prose ` +
                    `with no markup.`,
            });
            continue;
        }
        if (result.code === 0 && result.toolCalls.length === 0 && !result.content.trim()) {
            // Ending here while the budget is largely unspent is the single path that
            // produced the whole residual gap against the peer harness: three tasks
            // died on nudge -> blank -> bucket, and one of them was cut off 19 calls
            // before the point where its own model starts writing. A blank reply is
            // the cheapest event in the loop; the budget is the expensive thing, and
            // forfeiting the second to avoid the first is the wrong trade.
            //
            // So retry while there is budget to retry into, bounded by consecutive
            // blanks rather than by a once-per-nudge latch. Any real work resets the
            // count, so the bound only ever fires on a model that has genuinely
            // stopped producing -- and each re-ask is worded differently, because
            // repeating the identical prompt is what makes an identical blank likely.
            consecutiveEmpty++;
            if (consecutiveEmpty <= loop.max_consecutive_empty && steps < maxTotal) {
                const asks = [
                    `Your last reply contained no tool calls and no text. Answer now: ` +
                        `say what you did, or say plainly what blocked you and why.`,
                    `Still nothing came back. You have ${maxTotal - steps} steps left. ` +
                        `Take one concrete action towards the task, or state the specific ` +
                        `obstacle stopping you.`,
                    `Reply with text this time, not a tool call: what is the current ` +
                        `state of the work, and what is the next thing that needs doing?`,
                ];
                say(paint(deps.ui, "yellow", `  [loop] empty completion ${consecutiveEmpty}/${loop.max_consecutive_empty} — ` +
                    `asking again (${maxTotal - steps} steps left)`));
                working.push({
                    role: "user",
                    content: asks[Math.min(consecutiveEmpty - 1, asks.length - 1)],
                });
                continue;
            }
            emptyTerminus = true;
        }
        else if (result.code === 0) {
            // Progress of any kind clears the streak: the bound is on consecutive
            // blanks, not on blanks per turn.
            consecutiveEmpty = 0;
        }
        // A context overflow is recoverable, and the remedy is two lines away.
        //
        // 13 means the prompt did not fit. It is deliberately not retried, because
        // resending the same oversized prompt fails identically -- but the loop then
        // fell straight into the terminal branch and threw the turn's entire
        // accumulated work away, while holding trimWorking, which exists precisely
        // to make the prompt smaller. The trim otherwise runs only at a leg
        // checkpoint, so a long first leg can overflow before it is ever consulted.
        //
        // Once per turn: shrink hard and try again. Guarded by a latch so a prompt
        // that is too large even when trimmed cannot loop.
        if (result.code === 13 && !overflowTrimmed && steps < maxTotal) {
            overflowTrimmed = true;
            const budget = Math.max(1024, Math.floor(ctxLimits.max_context_tokens * 0.5));
            const trimmed = trimWorking(working, budget);
            if (trimmed.dropped > 0) {
                working.length = 0;
                working.push(...trimmed.messages);
                say(paint(deps.ui, "yellow", `  [context] the prompt did not fit — dropped ${trimmed.dropped} older message(s) and retrying once`));
                continue;
            }
        }
        if (result.code !== 0 || result.toolCalls.length === 0) {
            // The turn is about to end. If the surface declared a check and this
            // turn changed files, run it before letting the answer stand — a model
            // that reports success is reporting a belief, and the check is the only
            // thing in the loop that can contradict it.
            //
            // The check runs through the ordinary bash tool, so bash_deny, the
            // sandbox level and the tool timeout all apply to it unchanged. It is
            // not a privileged escape hatch.
            const gateApplies = verify !== null &&
                result.code === 0 &&
                steps > 0 &&
                verifyRounds < verify.max_rounds &&
                (verify.after === "always" || touchedFiles);
            // The gate did not apply, and the reason is one the operator would want
            // to know: the surface declared a check, the turn changed the worktree,
            // and the check did not run because the change came through the shell.
            // Found 2026-09-05 by benchmarks/greenfield-spec, whose whole arm was
            // measuring a mechanism that was not running.
            if (verify !== null &&
                !gateApplies &&
                verify.after === "write" &&
                !touchedFiles &&
                shellTouchedWorktree &&
                result.code === 0 &&
                steps > 0 &&
                verifyRounds < verify.max_rounds) {
                deps.progress.stop();
                say(paint(deps.ui, "yellow", `  ⚙ verify — NOT RUN. This turn changed files only through the shell, ` +
                    `and [verify] after = "write" counts write/edit. Set after = "always" ` +
                    `to check every turn.`));
                recordDegradation(deps.audit, {
                    id: "verify_skipped_shell_only",
                    declared: `[verify] ${verify.command} after = "write"`,
                    actual: "not run; the turn's changes came through the shell, not write/edit",
                    detail: { command: verify.command },
                });
                verifyOutcome = "skipped";
            }
            if (gateApplies && verify) {
                verifyRounds++;
                deps.progress.stop();
                say(paint(deps.ui, "cyan", `  ⚙ verify`) +
                    paint(deps.ui, "gray", ` ${verify.command}`));
                // The check is the SURFACE's declaration, not a tool the model chose,
                // so it runs for any role and is not gated like a model action -- a
                // coordinator that changed files still gets its declared check.
                //
                // But `never` was hardcoded, so an operator running approval = "always"
                // -- who has asked to see every command before it runs -- silently did
                // not see this one. Under `always` it asks, once; under the other gates
                // it stays ungated, because a declared check is not the model reaching
                // for the shell.
                const verifyGate = gate === "always" ? "always" : "never";
                const check = await executeTool("bash", { command: verify.command }, { ...ctx, gate: verifyGate, allow: "strict" }, new Set(["bash"]));
                if (check.code === TOOL_DENIED_CODE) {
                    // Declined by the operator. Not a failure of the check, and not a
                    // reason to hand the turn back -- they saw it and said no.
                    say(paint(deps.ui, "gray", `  ⚙ verify — declined; not run`));
                    toolLog.push("verify — declined by the operator");
                    verifyOutcome = "declined";
                }
                // bashTool reports TOOL_OK for any command that *ran*; the shell's own
                // exit status is in the summary, not the tool code. Reading the tool
                // code here would make every check pass, including the failing ones —
                // which is precisely the class of silent-success bug this gate exists
                // to catch.
                // Fail CLOSED when the exit status cannot be read.
                //
                // The old default was `check.code === 0 ? 0 : 1`, and bashTool reports
                // TOOL_OK for anything that ran -- so a check killed by a signal came
                // back as "bash — exit null", failed this regex, defaulted to 0, and the
                // gate reported PASSED. A segfaulted or OOM-killed test suite was
                // indistinguishable from a green one, in the one mechanism whose whole
                // job is to contradict a model that claims success. bashTool now names
                // the signal, and an unreadable status is treated as failure.
                const exitMatch = /exit (-?\d+)/.exec(check.summary);
                const killed = /killed by /.test(check.summary);
                const shellExit = exitMatch ? Number(exitMatch[1]) : killed ? 1 : check.code === 0 ? 1 : 1;
                const passed = check.code === 0 && exitMatch !== null && shellExit === 0;
                // "The check could not run" is not "your work is wrong", and telling
                // the model the second when the first is true is a category error with
                // teeth. Measured: a [verify] command of `pytest -q hidden_test.py`
                // against plain assert scripts errored during COLLECTION every round,
                // so the gate reported failure unconditionally -- and the model
                // rewrote already-correct code trying to satisfy a check that could
                // never pass. One task went from correct without the gate to broken
                // with it. A misconfigured check is worse than no check.
                //
                // 126 and 127 are POSIX and tool-independent: not executable, and not
                // found. Anything more specific would need per-tool knowledge the
                // harness does not have and should not guess at.
                // 126 and 127 are POSIX and tool-independent: not executable, and not
                // found. Anything more specific would need per-tool knowledge the
                // harness does not have and should not guess at -- a pytest collection
                // error still reads as an ordinary failure, which is an honest limit.
                const unrunnable = shellExit === 126 || shellExit === 127;
                if (!passed && unrunnable) {
                    say(paint(deps.ui, "yellow", `  ⚙ verify — the check could not run (exit ${shellExit}). ` +
                        `Not counted against the work; fix [verify] command.`));
                    toolLog.push(`verify — could not run (exit ${shellExit})`);
                    verifyOutcome = "unrunnable";
                    deps.audit?.write("verify", {
                        command: verify.command,
                        ok: false,
                        unrunnable: true,
                        exit: shellExit,
                        round: verifyRounds,
                    });
                    // Handing this back would spend the remaining rounds on a defect in
                    // the surface rather than in the work, so stop checking.
                    verifyRounds = verify.max_rounds;
                }
                // A test that would have passed BEFORE this turn pins nothing.
                //
                // Only meaningful when the check passed and the turn actually wrote a
                // test: restore the non-test files to their pre-images, run the same
                // command again, and if it still passes then the new test does not
                // depend on the change it claims to cover. T8 measured this model
                // clearing that bar 1 time in 9, with three tests asserting the bug
                // itself, so the cheapest honest guard is to re-run rather than to ask.
                let pinsNothing = false;
                if (passed && verify.test_must_fail_first && ctx.preImages && ctx.preImages.size > 0) {
                    const isTest = (abs) => {
                        const rel = relative(ctx.root, abs).split(sep).join("/");
                        return verify.test_paths.some((g) => {
                            try {
                                return globToRegExp(g).test(rel);
                            }
                            catch {
                                return false;
                            }
                        });
                    };
                    const wroteATest = [...ctx.preImages.keys()].some(isTest);
                    const sources = [...ctx.preImages.entries()].filter(([abs]) => !isTest(abs));
                    if (wroteATest && sources.length > 0) {
                        const current = new Map(sources.map(([abs]) => [abs, readFileSync(abs, "utf-8")]));
                        try {
                            for (const [abs, pre] of sources)
                                writeFileSync(abs, pre);
                            const again = await executeTool("bash", { command: verify.command }, { ...ctx, gate: "never", allow: "strict" }, new Set(["bash"]));
                            const stillPasses = again.code === 0 && /exit 0\b/.test(again.summary);
                            if (stillPasses) {
                                pinsNothing = true;
                                say(paint(deps.ui, "yellow", `  ⚠ the new test passes against the code as it was — it pins nothing`));
                            }
                        }
                        finally {
                            for (const [abs, now] of current)
                                writeFileSync(abs, now);
                        }
                    }
                }
                toolLog.push(`verify — ${check.summary}${pinsNothing ? " · test pins nothing" : ""}`);
                deps.audit?.write("verify", {
                    role,
                    command: verify.command,
                    exit: shellExit,
                    passed,
                });
                // An unrunnable check is a defect in the surface, not in the work, and
                // handing it back tells the model its correct code is wrong. Measured:
                // against an uncollectable check the model rewrote working code every
                // round, and one task went from passing without the gate to failing
                // with it.
                if (unrunnable && !pinsNothing) {
                    // Already reported above, with the audit record saying why.
                }
                else if (!passed || pinsNothing) {
                    verifyOutcome = "failed";
                    say(paint(deps.ui, "yellow", `    ⚠ verify failed — handing the turn back`));
                    working.push({ role: "assistant", content: result.content });
                    working.push({
                        role: "system",
                        content: `The declared verification for this repository failed after your ` +
                            `changes. This is the repository's own check, not an opinion:\n\n` +
                            `$ ${verify.command}\n${check.content}\n\n` +
                            `Your answer is not accepted while this fails. Fix what it shows, ` +
                            `or say plainly that you cannot and why.`,
                    });
                    continue;
                }
                // Only say it passed when it actually ran and passed. A check that
                // could not run has already reported itself, and calling that "passed"
                // would be the same silent success this gate exists to contradict --
                // just from the other side.
                if (!unrunnable) {
                    verifyOutcome = "passed";
                    say(paint(deps.ui, "gray", `    ✓ verify passed`));
                }
            }
            // Measured at the end of the turn, from git — never the model's account.
            // Nothing may be still held back when the turn ends: a folded chunk
            // printed after the answer would describe work the reader has already
            // been given conclusions about.
            flushFold();
            counters.tree_delta = measureTreeDelta(resolve(state.config.gnomonDir, ".."));
            stampCitations(counters, result.content, resolve(state.config.gnomonDir, ".."));
            return {
                content: noteMarkupInAnswer(result.content, counters),
                code: settle(code, result.code),
                model: usedModel,
                endpoint: usedTarget.endpoint,
                endpoint_url: usedTarget.url,
                verify: verifyOutcome,
                toolSteps: steps,
                toolLog,
                usage: turnUsage,
                // The model stopped calling tools of its own accord. Whether it was
                // RIGHT to stop is the bucket's business, not this field's.
                stop_reason: emptyTerminus
                    ? "empty"
                    : lastFinishReason === "length"
                        ? "truncated"
                        : "answered",
                counters,
                surface_changed: surfaceChanges.length > 0 ? surfaceChanges : undefined,
            };
        }
        // Stalled? Repeating one call verbatim is not progress, and on autopilot
        // it would burn the whole budget in a circle.
        const repeatingVerbatim = recentCalls.length >= loop.stall_repeats &&
            recentCalls
                .slice(-loop.stall_repeats)
                .every((sig) => sig === callSignature(result.toolCalls[0]));
        // Verbatim repetition is the easy case and the rarer one. The shape a real
        // run produces is an ALTERNATION: `sleep 5` then `ps aux | grep make` then
        // `sleep 5`, forever. Comparing only against toolCalls[0] and demanding
        // every recent signature match it never sees that — measured, an
        // identical-call loop stalled at step 3 while a two-call alternation ran to
        // the step wall at 64. A real session spent 11 of its 13 calls polling a
        // background job exactly this way.
        //
        // So: few distinct signatures across a wider window, and nothing written in
        // it. The write condition is what keeps genuine multi-tool work out of this
        // — a read/edit rhythm that is changing files is progress, however
        // repetitive it looks.
        const cycling = recentCalls.length >= STALL_WINDOW &&
            new Set(recentCalls.slice(-STALL_WINDOW)).size <= STALL_DISTINCT &&
            callsSinceWrite >= STALL_WINDOW;
        const stalled = repeatingVerbatim || cycling;
        const wall = maxTotal <= 0 || steps >= maxTotal;
        // Measured on what has already run, never on what is about to. Gating on
        // the incoming batch meant a response asking for more calls than
        // `max_steps` checkpointed forever without executing anything — a leg that
        // makes no progress is a spin, not a checkpoint. A batch may overshoot the
        // per-leg figure slightly; that is the price of guaranteeing progress.
        const checkpoint = stepsThisLeg >= maxSteps;
        // The wall stops the turn ON ITS OWN. This was `stalled || (checkpoint &&
        // wall)`, which made max_steps_total not a wall but a number consulted only
        // where a leg happened to end: once past it, the turn kept running until
        // the CURRENT leg also reached its per-leg max_steps. So the overshoot was
        // not a rounding error, it was up to a whole leg — and worst exactly where
        // an operator is most deliberate, setting a total TIGHTER than one leg.
        //
        // Measured (fake endpoint, one tool call per response, distinct paths so
        // neither stall test fires; steps = turn.toolSteps), before -> after:
        //
        //   max_steps  max_steps_total   ran before   ran after
        //       4             6              8            6
        //       5             7             10            7
        //       4             9             12            9
        //      10             3             10            3     <- 3.3x the wall
        //       4             0              4            0
        //
        // The last row is a documented contract, not an inference. config.ts says
        // of flooring max_steps at 1: "0 makes max_steps_total 0, which is the wall
        // on the first call: the turn ends before any tool runs." It ran a whole
        // leg of 4 first.
        //
        // A ceiling a turn can walk through is worse than no ceiling: it is the one
        // bound an unattended session has, and the number in roles.toml was not it.
        if (stalled || wall) {
            const note = stalled
                ? `Stopped: the same tool call repeated ${loop.stall_repeats} times without ` +
                    `progress, after ${steps} call(s).`
                : `Reached the ceiling for role "${role}" — ${steps} tool call(s), ` +
                    `max_steps_total ${maxTotal}. Raise it in .gnomon/roles.toml if this ` +
                    `role routinely needs more.`;
            say(paint(deps.ui, "yellow", `  [tools] ${note}`));
            // The budget is on tool calls and a wrap-up costs none, so the work
            // gathered so far is answered from rather than discarded.
            deps.progress.start(`${usedModel} — wrapping up`);
            working.push({
                role: "system",
                content: `No tools are attached to this final call, so answer now from what ` +
                    `you already have. If a change you were asked to make was never ` +
                    `applied by a tool call, say so in your first line — never describe ` +
                    `an edit you did not make as though you made it. Then say what you ` +
                    `were unable to examine, so the answer is legibly partial.`,
            });
            const closing = await callEndpoint(route.target, working, [], modelTimeoutMs(config), deps.signal);
            turnUsage = addUsage(turnUsage, closing.usage);
            deps.progress.stop();
            const content = closing.code === 0 && closing.content.trim()
                ? `${closing.content.trim()}\n\n_[${note}]_`
                : result.content || note;
            // Measured at the end of the turn, from git — never the model's account.
            // Nothing may be still held back when the turn ends: a folded chunk
            // printed after the answer would describe work the reader has already
            // been given conclusions about.
            flushFold();
            counters.tree_delta = measureTreeDelta(resolve(state.config.gnomonDir, ".."));
            stampCitations(counters, content, resolve(state.config.gnomonDir, ".."));
            return {
                // The wall and stall paths are where markup actually survived: a turn
                // cut off mid-emission still returns whatever it had.
                content: noteMarkupInAnswer(content, counters),
                code: settle(code, 4),
                model: usedModel,
                endpoint: usedTarget.endpoint,
                endpoint_url: usedTarget.url,
                verify: verifyOutcome,
                toolSteps: steps,
                toolLog,
                usage: turnUsage,
                stop_reason: stalled ? "stall" : "step_wall",
                stop_detail: stalled
                    ? { steps, repeats: loop.stall_repeats }
                    : { steps, max_steps_total: maxTotal },
                counters,
                surface_changed: surfaceChanges.length > 0 ? surfaceChanges : undefined,
            };
        }
        if (checkpoint) {
            // Not a wall: compact and carry on. A session running unattended for
            // hours cannot depend on someone noticing and re-prompting.
            leg++;
            stepsThisLeg = 0;
            const budget = Math.max(1024, Math.floor(ctxLimits.max_context_tokens * 0.6));
            const before = working.length;
            const trimmed = trimWorking(working, budget);
            if (trimmed.dropped > 0) {
                working.length = 0;
                working.push(...trimmed.messages);
                say(paint(deps.ui, "gray", `  [context] turn grew past the window — dropped ${trimmed.dropped} ` +
                    `of ${before} steps of working context`));
            }
            say(paint(deps.ui, "gray", `  [tools] ${steps}/${maxTotal} calls — continuing (leg ${leg})`));
            deps.progress.start(`${usedModel} — leg ${leg}, ${steps} call(s) so far`);
        }
        // Echo the assistant turn back verbatim — some backends validate that a
        // tool result answers a tool call they can see.
        working.push({
            role: "assistant",
            content: result.content ?? "",
            tool_calls: result.rawToolCalls,
        });
        // Models usually say why before they call something, and that text was
        // being discarded — leaving an approval prompt that showed a command and
        // no reason for it. Approving a row of symbols is not oversight.
        // /cot decides how much of the live "while it works" trace to show.
        const split = splitThinking(result.content ?? "");
        // `work` shows the reasoning and the prose in full — it folds STEPS, not
        // thinking. Leaving it out here made the new default hide the chain of
        // thought, which is the opposite of what folding is for.
        const showTrace = deps.ui.cot === "full" || deps.ui.cot === "think" || deps.ui.cot === "work";
        // Chain-of-thought as it happens — the model's <think> reasoning, at the
        // verbosity /think sets (collapse = one line, show = all, hide = none). This
        // is what "see it chewing" means; models that emit no <think> show nothing.
        if (showTrace && deps.ui.think !== "hide") {
            const think = split.think.trim();
            if (think) {
                const all = think.split("\n");
                const lines = deps.ui.think === "collapse"
                    ? [all[0] + (all.length > 1 ? " …" : "")]
                    : all;
                for (const line of lines)
                    say(paint(deps.ui, "gray", `  · ${line}`));
            }
        }
        const rationale = split.answer.trim();
        if (rationale && showTrace) {
            for (const line of rationale.split("\n")) {
                say(paint(deps.ui, "gray", `  │ ${line}`));
            }
        }
        // Launch consecutive read-only calls together.
        //
        // The loop executed strictly one call at a time, and a turn's calls bunch
        // during recon -- read five files, then decide. Overlapping those is one of
        // the three levers ForgeCode reports for the same model, and it is the only
        // one that costs nothing in behaviour: the tools in CONCURRENT_SAFE cannot
        // write, spawn, reach the network, or touch session state, so running two
        // at once cannot change the result of either.
        //
        // Results are consumed in DECLARED order below, whatever order they finish
        // in, so every counter, the tool log and the transcript are byte-identical
        // to the sequential path. That is what keeps the determinism result honest:
        // this is a wall-clock change, not a behaviour change.
        const prefetched = new Map();
        // Never prefetch when every call has to ask.
        //
        // Under approval = "always" each prefetched call awaits ctx.approve, which
        // awaits readLine() -- and readLine holds ONE resolver. The second
        // concurrent prompt overwrote the first, which was then never called, so
        // the turn never settled and neither Esc nor Ctrl+C recovered it.
        // Reproduced with two leading `read` calls, which is ordinary model
        // behaviour: two approve> prompts appear, one is answerable, the session is
        // gone. `on_write` is unaffected -- read/glob/grep/compute are not writes
        // and ask nothing there -- which is why the default never showed this.
        //
        // Overlapping reads is a wall-clock optimisation. An operator who asked to
        // see every call before it runs has already said the wall clock is not what
        // they are optimising.
        // Room left under the wall. Checked here as well as in the execution loop
        // so the prefetch cannot do work the budget has no room to count.
        const roomUnderWall = maxTotal > 0 ? Math.max(0, maxTotal - steps) : 0;
        if (!deps.signal?.aborted && gate !== "always") {
            for (let i = 0; i < result.toolCalls.length; i++) {
                if (i >= roomUnderWall)
                    break;
                const call = result.toolCalls[i];
                if (!concurrentSafe(call.name) || !offered.has(call.name))
                    break;
                prefetched.set(i, executeTool(call.name, call.args, ctx, offered));
            }
            // One safe call on its own gains nothing and only adds a code path.
            if (prefetched.size < 2)
                prefetched.clear();
        }
        for (const [callIndex, call] of result.toolCalls.entries()) {
            // Stop between tools rather than mid-write: a cancelled turn should
            // never leave a half-applied change.
            if (deps.signal?.aborted) {
                deps.progress.stop();
                return cancelled();
            }
            // The wall holds INSIDE a batch too. The check above runs once per model
            // response, so on its own it can only notice the wall AFTER a batch has
            // already carried the turn past it. Measured, same harness as above, with
            // a model asking for 6 tool calls in every response and max_steps_total 8:
            // 12 calls ran before, 8 after. The bigger the batch a model likes to
            // emit, the further past its own ceiling the turn went.
            //
            // Skipped calls still get a tool result. Returning nothing for a call the
            // model can see in its own message leaves an unanswered tool_call_id, and
            // backends that validate that pairing reject the wrap-up request that
            // follows — the turn would end in an apparatus error instead of at its
            // ceiling. It is also the honest answer: the tool did not run.
            if (maxTotal <= 0 || steps >= maxTotal) {
                working.push({
                    role: "tool",
                    content: `Not run: this turn reached max_steps_total (${maxTotal}) before ` +
                        `this call. No tool ran for it and nothing changed. Answer from ` +
                        `what you already have.`,
                    tool_call_id: call.id,
                    tool_name: call.name,
                });
                continue;
            }
            steps++;
            stepsThisLeg++;
            callsSinceWrite++;
            recentCalls.push(callSignature(call));
            // Keep enough history for the WIDER of the two stall tests. This was
            // stall_repeats * 2 = 6, so an 8-call alternation window could never be
            // filled and the check it guards never fired once. Still computed from the
            // wider of the two now that stall_repeats is declarable: a surface setting
            // it to 20 must not silently disable the alternation test instead.
            if (recentCalls.length > Math.max(loop.stall_repeats * 2, STALL_WINDOW)) {
                recentCalls.shift();
            }
            const gated = needsApproval(call.name, gate) && offered.has(call.name);
            // A call the operator has to answer for is one they are watching, and
            // its prompt is written straight to the console rather than through
            // `say` — so anything held back has to land before it.
            const standing = deps.standingApproval?.() ?? false;
            const askedIndividually = gated && !standing;
            if (askedIndividually)
                flushFold();
            deps.progress.stop();
            if (deps.ui.cot === "full" || deps.ui.cot === "tools") {
                say(paint(deps.ui, "cyan", `  ⚙ ${call.name}`) +
                    paint(deps.ui, "gray", ` ${describeCall(call)}`));
            }
            const outcome = (await prefetched.get(callIndex)) ??
                (await executeTool(call.name, call.args, ctx, offered));
            code = worse(code, outcome.code);
            if (outcome.surface_drift)
                surfaceChanges.push(outcome.surface_drift);
            toolLog.push(outcome.summary);
            tally(call.name, "calls");
            const outcomeBucket = mapBucket(outcome.code);
            if (outcomeBucket === "refusal") {
                tally(call.name, "refusals");
                // Every call to this tool refused, and enough of them to mean it.
                //
                // A pattern list that compiles but matches nothing is invisible: the
                // surface looks configured, the role looks equipped, and every call
                // comes back refused. Measured on a greenfield run: 8 bash calls, 8
                // refusals, a stall, and nothing built -- because an allow-list written
                // `'...\\s'` in a TOML literal string is a valid regex that matches no
                // command. auditSurface cannot catch that; it only compiles patterns,
                // and this one compiles.
                //
                // So say it where it is unmissable, once, while the run is happening.
                const t = counters.per_tool?.[call.name];
                if (t && t.calls === t.refusals && t.refusals === loop.all_refused_notice) {
                    say(paint(deps.ui, "yellow", `  [tools] every ${call.name} call so far has been refused (${t.refusals}/${t.refusals}). ` +
                        `If that is not what you intended, check this role's ${call.name === "bash" ? "bash_allow/bash_deny" : "tool list and write_allow"} ` +
                        `— a pattern can compile and still match nothing.`));
                }
            }
            else if (outcomeBucket === "apparatus_failure")
                tally(call.name, "apparatus");
            // "the last thing it did changed something" separates a turn that
            // finished its work from one that stopped after looking around.
            counters.final_step_was_write =
                ((call.name === "write" || call.name === "edit") && outcome.code === 0) ||
                    outcome.worktree_changed === true;
            if ((call.name === "write" || call.name === "edit") && outcome.code === 0) {
                counters.writes++;
                touchedFiles = true;
                // A write is progress: the idle streak, and its nudge cadence, restart.
                callsSinceWrite = 0;
                callsAtLastNudge = 0;
            }
            else if (outcome.worktree_changed) {
                counters.worktree_moves++;
                // Shell-mediated progress. In the 48-task benchmark arm, 49 of the 50
                // nudged trials had made no write/edit call at all — the model was
                // editing through heredocs and `sed -i`, so the counter read a working
                // agent as an idle one and told it to stop. Nudged trials passed 8/50
                // against 34/69 for un-nudged ones.
                //
                // The streak restarts; `touchedFiles` deliberately does not. That flag
                // means `verify.after = "write"`, a published enumeration, and bash is
                // enabled by default — so counting shell work as a write would silently
                // turn "write" into "always" for any turn that shelled out.
                //
                // What that reasoning left undocumented is the cost, and by this
                // repository's own measurement eight lines above the cost is MOST
                // turns: the declared check simply does not run for them, and the turn
                // is reported exactly like one that passed it. Recorded here so the
                // gate can say so rather than skip in silence.
                shellTouchedWorktree = true;
                callsSinceWrite = 0;
                callsAtLastNudge = 0;
            }
            deps.audit?.write("tool_call", {
                role,
                tool: call.name,
                // The target is metadata; the content it carries is not.
                target: describeCall(call),
                gated,
                code: outcome.code,
                bucket: mapBucket(outcome.code),
                summary: outcome.summary,
                args: deps.audit.text(JSON.stringify(call.args)),
                result: deps.audit.text(outcome.content),
            });
            const bucket = mapBucket(outcome.code);
            const glyph = bucket === "result" ? "✓" : bucket === "refusal" ? "⚠" : "✗";
            const bcolor = bucket === "result" ? "green" : bucket === "refusal" ? "yellow" : "red";
            if (deps.ui.cot === "full" || deps.ui.cot === "tools") {
                say(paint(deps.ui, bcolor, `    ${glyph} ${outcome.summary}`));
            }
            else if (deps.ui.cot === "work") {
                const step = {
                    tool: call.name,
                    describe: describeCall(call),
                    path: typeof call.args.path === "string" ? call.args.path : undefined,
                    glyph,
                    colour: bcolor,
                    summary: outcome.summary,
                };
                // Everything that must stay visible: it failed, it was refused, it
                // moved the tree, it moved the surface, or the operator was asked
                // about it. Anything else is recon and can be counted rather than
                // listed.
                const foldable = bucket === "result" &&
                    // The tool succeeding is not the work succeeding. `bash` returns
                    // TOOL_OK for a command that ran and exited 1, so this check is what
                    // stops a failing test run or a broken script being counted as one
                    // more quiet step. Undefined means the tool ran no command.
                    (outcome.shell_exit === undefined || outcome.shell_exit === 0) &&
                    !outcome.worktree_changed &&
                    !outcome.surface_drift &&
                    !askedIndividually;
                if (foldable) {
                    pendingFold.push(step);
                }
                else {
                    flushFold();
                    emitStep(step);
                }
            }
            else if (deps.ui.cot === "brief") {
                // One line per step: the call and what it returned.
                say(paint(deps.ui, "cyan", `  • ${call.name}`) +
                    paint(deps.ui, "gray", ` ${describeCall(call)} `) +
                    paint(deps.ui, bcolor, `${glyph} ${outcome.summary}`));
            }
            // think / off: no per-tool line — the spinner still shows activity.
            working.push({
                role: "tool",
                content: outcome.content,
                tool_call_id: call.id,
                tool_name: call.name,
            });
            // Both branches did the same thing. The spinner was stopped before the
            // tool ran, so this restarts it either way.
            deps.progress.start(`${usedModel} — ${steps} tool call(s) so far`);
        }
        // Flailing? Many calls, none of them a write. Unlike the stall check this
        // does not require the calls to be identical — the measured failure mode is
        // a model trying many *different* things and changing nothing. Re-nudge
        // every nudge_after_idle calls without a write (a single reminder is easy to
        // ignore, and the overnight sweep showed weak models grinding 7–9 tasks to
        // the timeout wall), and let the turn continue: a genuine long solve keeps
        // working, a flailer gets repeated reason to conclude.
        if (callsSinceWrite - callsAtLastNudge >= loop.nudge_after_idle) {
            counters.nudges++;
            // A fresh nudge is a fresh chance to answer: clear the blank streak so a
            // later blank is not judged against blanks from 12 calls ago.
            consecutiveEmpty = 0;
            counters.first_nudge_step ??= steps;
            callsAtLastNudge = callsSinceWrite;
            deps.progress.stop();
            say(paint(deps.ui, "gray", `  [tools] ${callsSinceWrite} call(s) without changing a file — nudging to decide`));
            working.push({
                role: "system",
                content: `You have run ${callsSinceWrite} tool calls without changing a file. ` +
                    `If you have found what you need, make the change now. If the task ` +
                    `cannot be completed, say so plainly and stop — state what you were ` +
                    `unable to do and why. Do not keep investigating without acting.`,
            });
            deps.progress.start(`${usedModel} — ${steps} tool call(s) so far`);
        }
        // Converging? Past the role's converge_after fraction, push the model to
        // stop exploring and submit what already works, or conclude it cannot. This
        // fires on budget consumed regardless of whether the model is writing, and
        // re-fires every checkpoint's worth of calls as the remaining budget
        // shrinks — the pressure rises toward the wall. It targets the measured
        // timeout gap: converge before the external clock kills the process with
        // nothing submitted. Only active where the surface opts in.
        if (steps >= convergeAt && steps - stepsAtLastConverge >= loop.converge_refire) {
            stepsAtLastConverge = steps;
            const left = Math.max(0, maxTotal - steps);
            deps.progress.stop();
            say(paint(deps.ui, "yellow", `  [tools] budget ${steps}/${maxTotal} — urging convergence (${left} call(s) left)`));
            working.push({
                role: "system",
                content: `You have used ${steps} of ${maxTotal} tool calls — about ${left} ` +
                    `remain, and when they run out any work you have not applied is lost. ` +
                    `Stop exploring now. Apply and submit what already works. If the task ` +
                    `cannot be completed with what you have, say so plainly in your first ` +
                    `line, state what blocked it, and stop — do not start new investigation.`,
            });
            deps.progress.start(`${usedModel} — ${steps} tool call(s), converging`);
        }
    }
}
/** A short, readable form of a tool call for the transcript. */
function describeCall(call) {
    const a = call.args;
    if (typeof a.path === "string")
        return String(a.path);
    if (typeof a.command === "string") {
        const c = String(a.command).replace(/\s+/g, " ");
        return c.length > 70 ? `${c.slice(0, 70)}…` : c;
    }
    return "";
}
/** bash timeout, from tools.toml. */
function toolTimeoutMs(config) {
    const declared = (config.tools.tools ?? []).find((t) => t.name === "bash");
    const secs = declared?.timeout_seconds;
    return typeof secs === "number" && secs > 0 ? secs * 1000 : 120_000;
}
const SUMMARY_INSTRUCTION = "You are compacting a coding session's history. Rewrite the material below " +
    "as a compact factual record for an agent that will continue this work.\n\n" +
    "Keep: decisions made, files touched, commands run and their outcomes, " +
    "constraints the user stated, and anything still unresolved.\n" +
    "Drop: pleasantries, restated questions, and reasoning that led nowhere.\n\n" +
    "Write plain prose or terse bullets. Do not address the user. Do not offer " +
    "to help. Output only the record.";
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
export async function compactSession(state, systemPrompt, onNote) {
    const ctx = resolveContext(state.config);
    const wants = ctx.compaction === "summary" || ctx.policy === "summary";
    if (!wants)
        return { folded: 0, reclaimed: 0 };
    // Build against an empty next input to see what the window sheds.
    const probe = buildMessages(state, systemPrompt, "");
    const pending = probe.evicted.filter((e) => !e.folded);
    if (pending.length === 0)
        return { folded: 0, reclaimed: 0 };
    const role = ctx.summary_role;
    if (!state.config.roles[role]) {
        return {
            folded: 0,
            reclaimed: 0,
            problem: `context.summary_role = "${role}" is not defined in roles.toml, so ` +
                `${pending.length} turn(s) were dropped instead of summarised.`,
        };
    }
    const transcript = pending
        .map((e) => {
        const answer = splitThinking(e.output).answer || e.output;
        const tools = e.tool_log?.length ? `\n  tools: ${e.tool_log.join("; ")}` : "";
        return `--- turn ${e.turn} (${e.role})\nuser: ${e.input}\nassistant: ${answer}${tools}`;
    })
        .join("\n\n");
    // Summarise only the NEW turns and append, rather than re-summarising the
    // existing record every time.
    //
    // Re-folding the whole record on every eviction compounds loss: each pass
    // compresses what the last pass already compressed, so early facts decay
    // across generations the way a repeatedly re-encoded image does. In a stress
    // test that behaviour kept "avoid async-std, use tokio" and lost the
    // project's name. Appending keeps early sections at their first-generation
    // fidelity; the whole record is re-folded only when it grows past
    // retain_after, which is rare.
    const summaryTokens = estimateTokens(state.summary ?? "");
    const refold = summaryTokens > ctx.retain_after;
    const priorSummary = state.summary && refold
        ? `Existing record, which has grown too long — fold it together with the ` +
            `new material into one shorter record:\n${state.summary}\n\n`
        : "";
    onNote?.(refold
        ? `re-folding the record (${summaryTokens} tok) plus ${pending.length} turn(s) via ${role}…`
        : `compacting ${pending.length} turn(s) via ${role}…`);
    const route = routeRole(state.config, role);
    const result = await callEndpoint(route.target, [
        { role: "system", content: SUMMARY_INSTRUCTION },
        { role: "user", content: `${priorSummary}${transcript}` },
    ], [], 
    // Compaction is a model call like any other and must honour the surface's
    // request_timeout_ms. Called with no config it fell through to the env var
    // and a different default, so the one turn most likely to be large was the
    // one given the shortest deadline.
    modelTimeoutMs(state.config));
    if (result.code !== 0) {
        // Leaving them unfolded means they are simply dropped this turn and
        // retried next — losing them silently would be worse than a slow retry.
        return {
            folded: 0,
            reclaimed: 0,
            problem: `compaction failed (${result.content.slice(0, 80)}); turns left unfolded`,
        };
    }
    const folded_text = splitThinking(result.content).answer.trim();
    if (!folded_text) {
        return { folded: 0, reclaimed: 0, problem: "compaction produced nothing" };
    }
    // Append unless this pass re-folded everything.
    const summary = state.summary && !refold ? `${state.summary}\n\n${folded_text}` : folded_text;
    const before = pending.reduce((n, e) => n + estimateTokens(e.input) + estimateTokens(e.output), 0);
    const after = estimateTokens(summary) - estimateTokens(state.summary ?? "");
    state.summary = summary;
    for (const e of pending)
        e.folded = true;
    return { folded: pending.length, reclaimed: Math.max(0, before - after) };
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
export async function listModels(config) {
    const out = [];
    for (const name of listEndpoints(config)) {
        const ep = resolveEndpoint(config, name);
        const kind = ep.kind ?? "ollama";
        // Ollama lists at /api/tags; OpenAI-shaped APIs at /v1/models.
        const listUrl = kind === "ollama"
            ? ep.url.replace(/\/api\/chat\/?$/, "/api/tags")
            : ep.url.replace(/\/chat\/completions\/?$/, "/models");
        const key = ep.api_key_env ? process.env[ep.api_key_env] : undefined;
        if (ep.api_key_env && !key) {
            out.push({
                endpoint: name,
                url: listUrl,
                models: [],
                problem: `$${ep.api_key_env} is not available — run: gnomon key set ${name}`,
            });
            continue;
        }
        try {
            const res = await fetch(listUrl, {
                headers: key ? { Authorization: `Bearer ${key}` } : {},
                signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) {
                out.push({
                    endpoint: name,
                    url: listUrl,
                    models: [],
                    problem: `${res.status} ${res.statusText}`,
                });
                continue;
            }
            const json = (await res.json());
            const models = (json.models ?? []).map((m) => m.name ?? m.model ?? "")
                .concat((json.data ?? []).map((m) => m.id ?? ""))
                .filter(Boolean)
                .sort();
            out.push({ endpoint: name, url: listUrl, models });
        }
        catch (err) {
            out.push({
                endpoint: name,
                url: listUrl,
                models: [],
                problem: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return out;
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
export async function runTask(config, input, options = {}) {
    applyCredentials(undefined, declaredKeyVars(config));
    // The surface audit ran only on the interactive path, so `gnomon task` -- the
    // non-interactive entry point, and the one every benchmark adapter uses --
    // started against surfaces nothing had checked. A fatal problem there is
    // worse than in a session, not better: there is nobody watching the console,
    // and a role silently widened by a typo'd key would simply run.
    //
    // Reported as an apparatus failure rather than a thrown error, because that
    // is what it is: the harness could not be configured, so no result of any
    // kind is available. Bucketing it as a refusal would let a misconfigured
    // surface look like a model declining the work.
    // Non-fatal findings are recorded too. The interactive path prints them; the
    // scripted path used to DISCARD them entirely, so a CI run against a surface
    // asking for an unimplemented edit format, or a role whose allow-list admits
    // an interpreter, saw nothing at all. A record is where a measured fact
    // belongs, and these are measured facts about the surface that produced the
    // record.
    const surfaceFindings = auditSurface(config);
    {
        const fatal = surfaceFindings.filter((p) => p.fatal);
        if (fatal.length > 0) {
            const detail = fatal
                .map((p) => `${p.where}: ${p.problem}\n    ${p.fix}`)
                .join("\n  ");
            return {
                input,
                harness: harnessBuild(),
                output: `Surface cannot be used:\n  ${detail}`,
                role: options.role ?? "unknown",
                model: "",
                code: 10,
                bucket: "apparatus_failure",
                stop_reason: "apparatus",
                tool_steps: 0,
                tool_log: [],
                skills: [],
                surface_hash: "",
                counters: {
                    writes: 0,
                    worktree_moves: 0,
                    nudges: 0,
                    final_step_was_write: false,
                    per_tool: {},
                },
                // The record shape is the same whether or not the run reached a model.
                // A consumer parsing --json must not have to special-case the failure
                // that never started, which is the one it is most likely to hit.
                volatile: { duration_ms: 0 },
            };
        }
    }
    const routing = resolveRouting(config);
    // suggest needs someone to ask, and a task run has nobody. It falls back to
    // the declared default rather than silently promoting itself to auto.
    const role = options.role ??
        (routing.mode === "auto"
            ? routeInput(config, input, routing).role
            : routing.default);
    // A declared chain shapes the whole turn. An explicit --role overrides it:
    // asking for one role and silently getting three would be worse than having
    // no chain at all, and it is the same reasoning that lets an explicit /role
    // prefix beat the routing rules.
    const declaredChain = resolveChain(config);
    const chain = options.role || declaredChain.length < 2 ? [] : declaredChain;
    const chainGate = resolveChainGate(config);
    const state = { config, exchanges: [], currentRole: role };
    const ui = { ...resolveUi(config), spinner: false, color: false };
    const route = routeRole(config, role);
    const active = selectSkills(loadSkills(config), role, input);
    const systemPrompt = buildSystemPrompt(state, role, input);
    const built = buildMessages(state, systemPrompt, input);
    const note = (line) => {
        if (options.verbose)
            process.stderr.write(`${line}\n`);
    };
    // A non-interactive run is the one most likely to need a trail: nobody
    // watched it happen.
    const auditSettings = resolveAudit(config);
    const sessionId = `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
    const audit = new AuditTrail(auditSettings, sessionId);
    const surface_hash = recomputeManifest(config.gnomonDir).surface_hash;
    audit.write("session_start", {
        surface_hash,
        // The trail names its harness for the same reason the record does.
        harness: harnessBuild(),
        cwd: process.cwd(),
        mode: "task",
        role,
        record: auditSettings.record,
        approvals: options.yes ? "granted" : "refused",
    });
    // Connect declared MCP servers here too. They were wired only in
    // runPromptLoop, so a surface declaring [mcp_servers] handed its tools to
    // `gnomon prompt` and NOT to `gnomon task` -- the same surface, the same
    // hash, two different tool sets depending on which entry point you used.
    // That is the exact shape of the bug fixed above for the surface audit, and
    // it breaks Rule 3 harder: the declared data stopped deciding what the model
    // can reach. Measured: a surface declaring one MCP server ran a task in
    // which the model reported "no tool named mcp__canary__stamp available".
    //
    // Failure to connect is reported and skipped, never fatal -- an unreachable
    // MCP server should cost its own tools, not the whole run.
    if (config.tools.mcp_servers && Object.keys(config.tools.mcp_servers).length > 0) {
        state.mcp = await connectMcp(config.tools.mcp_servers, note, audit);
    }
    // One approval callback for every stage: a chain must not become a way to
    // get a second, laxer gate.
    const approveHere = async (req) => {
        const decision = options.yes ? "approved" : "declined";
        note(`[approval] ${req.summary} — ${decision}`);
        audit.write("approval", {
            tool: req.tool,
            summary: req.summary,
            decision,
            // Recorded honestly: no human saw this. A trail that implied
            // oversight where there was none would be worse than no trail.
            by: options.yes ? "flag:--yes" : "default:no-operator",
            interactive: false,
        });
        return Boolean(options.yes);
    };
    const start = Date.now();
    const stageRecords = [];
    let turn;
    try {
        if (chain.length >= 2) {
            // Each stage starts from the ORIGINAL request plus what the stage before
            // it reported -- its answer, not its transcript. Replaying one stage's
            // tool calls into the next would defeat the isolation that made the
            // split worth having, and pay for the context twice. Same contract the
            // `task` tool already keeps for sub-turns.
            let carried = "";
            let last = null;
            for (let i = 0; i < chain.length; i++) {
                const stageRole = chain[i];
                const stageRoute = routeRole(config, stageRole);
                const stageInput = carried
                    ? `${input}\n\n---\nThe previous stage (${chain[i - 1]}) reported:\n${carried}`
                    : input;
                const stageState = { config, exchanges: [], currentRole: stageRole };
                stageState.mcp = state.mcp;
                const stageMsgs = buildMessages(stageState, buildSystemPrompt(stageState, stageRole, stageInput), stageInput);
                note(`[chain] stage ${i + 1}/${chain.length} — ${stageRole}`);
                const r = await runAgenticTurn(stageState, stageRole, stageRoute, stageMsgs.messages, {
                    approve: approveHere,
                    progress: new Progress(ui, process.stderr),
                    ui,
                    say: note,
                    audit,
                });
                stageRecords.push({
                    stage: i + 1,
                    role: stageRole,
                    model: r.model,
                    code: r.code,
                    bucket: mapBucket(r.code),
                    stop_reason: r.stop_reason,
                    tool_steps: r.toolSteps,
                    output: r.content,
                });
                audit.write("chain_stage", {
                    stage: i + 1,
                    of: chain.length,
                    role: stageRole,
                    bucket: mapBucket(r.code),
                    code: r.code,
                    stop_reason: r.stop_reason,
                    tool_steps: r.toolSteps,
                    // Per stage, because each stage builds its own window and a chain
                    // that dropped context in stage 2 is not the same run as one that
                    // dropped it in stage 3.
                    context_turns: stageMsgs.included,
                    context_dropped: stageMsgs.dropped,
                    context_tokens: stageMsgs.tokens,
                    surface_hash,
                });
                last = r;
                carried = r.content;
                // An apparatus failure is not a result to hand onward: the endpoint
                // died or the surface could not be used, and the stages after it would
                // be answering a question nobody asked.
                if (r.code === 10 || r.code === 12 || r.code === 13)
                    break;
                const stop = chainStop(chainGate, r);
                if (stop) {
                    note(`[chain] stopped after stage ${i + 1}/${chain.length} (${stageRole}) — ${stop}`);
                    audit.write("chain_stage", {
                        stage: i + 1,
                        of: chain.length,
                        role: stageRole,
                        stopped_by: stop,
                        gate: chainGate,
                        surface_hash,
                    });
                    break;
                }
            }
            turn = last;
        }
        else {
            turn = await runAgenticTurn(state, role, route, built.messages, {
                approve: approveHere,
                progress: new Progress(ui, process.stderr),
                ui,
                say: note,
                audit,
            });
        }
    }
    finally {
        // Subprocesses outlive the turn otherwise, and `gnomon task` is the entry
        // point scripts run in a loop.
        state.mcp?.close();
    }
    const duration = Date.now() - start;
    audit.write("turn", {
        turn: 1,
        role,
        model: turn.model,
        // `turn.endpoint`, not `route.target.endpoint`: a fallback turn reached a
        // different server and the record has to say which one.
        endpoint: turn.endpoint ?? route.target.endpoint,
        endpoint_url: turn.endpoint_url ?? route.target.url,
        bucket: mapBucket(turn.code),
        code: turn.code,
        duration_ms: duration,
        tool_steps: turn.toolSteps,
        tool_log: turn.toolLog,
        stop_reason: turn.stop_reason,
        stop_detail: turn.stop_detail,
        counters: turn.counters,
        tokens_in: turn.usage?.input,
        tokens_out: turn.usage?.output,
        skills: active.map((sk) => sk.id),
        // Present on the interactive turn record since it was written, and absent
        // here until 2026-09-05 -- so the same surface, at the same hash, recorded
        // whether it had dropped context from `gnomon prompt` and not from
        // `gnomon task`. That is the third instance of one bug (MCP servers, the
        // surface audit, and now this): a fact plumbed into one entry point and not
        // the other, which makes the trail a function of how you invoked it.
        //
        // Only when no chain ran. With a chain, `built` describes a set of messages
        // nothing sent -- each stage builds its own, and each stage records its own
        // below, because Rule 4 says three stages produce three records.
        ...(stageRecords.length === 0
            ? {
                context_turns: built.included,
                context_dropped: built.dropped,
                context_tokens: built.tokens,
            }
            : {}),
        surface_hash,
        input: audit.text(input),
        output: audit.text(turn.content),
    });
    audit.write("session_end", { turns: 1, surface_hash });
    return {
        surface_hash,
        harness: harnessBuild(),
        // Non-fatal surface findings, so a scripted consumer can see what the
        // interactive operator would have been shown. Omitted when clean rather
        // than emitted as an empty array: a field that is always present teaches a
        // reader to skip it.
        surface_problems: surfaceFindings.length > 0
            ? surfaceFindings.map((p) => ({ where: p.where, problem: p.problem, fatal: p.fatal }))
            : undefined,
        // With a chain, the top-level fields describe the stage whose answer the
        // operator actually receives -- the last one that ran. Reporting the entry
        // role beside the final stage's bucket and output would make the record
        // internally inconsistent, which is worse than either choice alone.
        role: stageRecords.length > 0 ? stageRecords[stageRecords.length - 1].role : role,
        model: turn.model,
        endpoint: turn.endpoint ?? route.target.endpoint,
        input,
        output: turn.content,
        code: turn.code,
        bucket: mapBucket(turn.code),
        tool_steps: turn.toolSteps,
        tool_log: turn.toolLog,
        skills: active.map((sk) => sk.id),
        stop_reason: turn.stop_reason,
        ...(turn.stop_detail ? { stop_detail: turn.stop_detail } : {}),
        counters: turn.counters,
        // Present only when a chain ran, so a record from a single-role turn is
        // byte-identical to what it was before this existed.
        ...(stageRecords.length > 0 ? { stages: stageRecords } : {}),
        // Token counts sit beside duration under `volatile`: they are the
        // backend's measurement of one run, so two runs of the same task differ
        // in them without anything about the surface having changed. The contract
        // for --json is that everything outside `volatile` is reproducible.
        volatile: {
            duration_ms: duration,
            // Spread-if-present, not `key: undefined`: a backend that reports no
            // usage must leave the key off entirely, so `volatile` stays exactly
            // "the things that varied" rather than gaining three permanent blanks.
            ...(turn.usage?.input !== undefined ? { tokens_in: turn.usage.input } : {}),
            ...(turn.usage?.output !== undefined ? { tokens_out: turn.usage.output } : {}),
            ...(turn.usage?.ms !== undefined ? { model_ms: turn.usage.ms } : {}),
        },
    };
}
// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
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
export function completePath(line, root) {
    const m = /(^|\s)@?([^\s]*)$/.exec(line);
    const token = m?.[2] ?? "";
    const at = token !== "" && /(^|\s)@[^\s]*$/.test(line);
    const slash = token.lastIndexOf("/");
    const dir = slash >= 0 ? token.slice(0, slash + 1) : "";
    const stem = slash >= 0 ? token.slice(slash + 1) : token;
    const base = resolve(root, dir || ".");
    // Never complete outside the project: the same boundary the read tool keeps.
    if (!base.startsWith(resolve(root)))
        return [[], token];
    let entries;
    try {
        entries = readdirSync(base, { withFileTypes: true })
            .filter((e) => stem.startsWith(".") || !e.name.startsWith("."))
            .filter((e) => !HIDDEN_FROM_COMPLETION.has(e.name))
            .map((e) => dir + e.name + (e.isDirectory() ? "/" : ""));
    }
    catch {
        return [[], token];
    }
    const hits = entries.filter((e) => e.startsWith(dir + stem)).sort();
    return [hits.map((h) => (at ? "@" + h : h)), at ? "@" + token : token];
}
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
export const HISTORY_LIMIT = 500;
export function historyPath(config) {
    return join(resolve(config.gnomonDir, ".."), ".gnomon-sessions", "history");
}
export function loadHistory(config) {
    try {
        return readFileSync(historyPath(config), "utf-8")
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .slice(-HISTORY_LIMIT);
    }
    catch {
        return [];
    }
}
export function appendHistory(config, line) {
    const text = line.trim();
    if (!text)
        return;
    try {
        const kept = [...loadHistory(config).filter((l) => l !== text), text].slice(-HISTORY_LIMIT);
        const p = historyPath(config);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, kept.join("\n") + "\n");
    }
    catch {
        /* history is a convenience; never let it break the prompt */
    }
}
/** Directories a path completion should not lead with. */
const HIDDEN_FROM_COMPLETION = new Set([
    "node_modules",
    ".git",
    ".gnomon-sessions",
    ".gnomon-audit",
    ".gnomon-jobs",
    "target",
    "dist",
]);
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
export const LIVE_SAFE_COMMANDS = new Set([
    "/help", "/roles", "/profiles", "/tools", "/endpoints", "/context",
    "/skills", "/manifest", "/explain", "/reflect", "/meta", "/think", "/cot", "/mode",
    // Reading the checklist mid-turn is the point of having one: it answers
    // "how far through is it" without stopping the work to find out.
    "/theme", "/todo",
    // Reading back a folded run is the same question as reading the checklist:
    // "what has it actually done". It touches display state only.
    "/expand",
]);
export const COMMANDS = [
    { name: "/roles", help: "List roles and models (marks the current one)" },
    { name: "/role", arg: "<name>", help: "Switch role for the rest of the session" },
    { name: "/mode", arg: "[manual|suggest|auto]", help: "Who picks the role: you, the rules with your confirmation, or the rules" },
    { name: "/allow", arg: "[strict|custom|all]", help: "May the agent edit .gnomon/ this session: strict (no) | custom (each approved) | all (standing consent)" },
    { name: "/network", arg: "[on|off]", help: "May tools reach the network this session (webfetch, and what bash can dial)" },
    { name: "/sandbox", arg: "[off|confined|strict]", help: "How far outside this project tools may reach this session" },
    { name: "/skills", help: "Active skills and pending proposals" },
    { name: "/session", arg: "[id]", help: "This session, earlier ones, and switching between them" },
    { name: "/new", help: "Start a fresh session; the current one stays resumable" },
    { name: "/endpoints", help: "List declared inference endpoints" },
    { name: "/profiles", help: "Show available profiles" },
    { name: "/tools", help: "Show the tools this role may call" },
    { name: "/context", help: "Show context policy and the current window" },
    { name: "/reset", help: "Drop conversation history (keeps the session open)" },
    { name: "/meta", arg: "[fields]", help: "Show or set the meta line" },
    { name: "/think", arg: "[mode]", help: "Chain-of-thought: hide | collapse | show" },
    { name: "/cot", arg: "[mode]", help: "Live trace while it works: off | brief | tools | think | work | full" },
    { name: "/expand", help: "List the steps inside the last folded run" },
    { name: "/theme", arg: "[name]", help: "Colour theme — dark, dim, light, high-contrast, mono, tokyonight, catppuccin (the last two recolour the whole terminal)" },
    { name: "/explain", arg: "[topic]", help: "What a feature is, how this repo has it set, and what to do with it" },
    { name: "/reflect", arg: "[topic]", help: "Alias for /explain" },
    { name: "/models", help: "Pick a model for a role (arrows, type to filter)" },
    { name: "/todo", help: "The checklist, as the agent last left it" },
    { name: "/manifest", help: "The surface hash and what it covers" },
    { name: "/clear", help: "Clear screen (history is kept)" },
    { name: "/help", help: "This list" },
    { name: "/quit", help: "Exit the loop" },
];
/**
 * Tab completion for the prompt.
 *
 * Completes slash commands, and role names after /role. Returns the readline
 * completer shape: [matches, the substring they complete].
 */
export function completeInput(line, roles, endpoints = [], 
/** Project root, for completing ordinary input as a path. */
root = process.cwd()) {
    const roleArg = line.match(/^\/roles?\s+(\S*)$/);
    if (roleArg) {
        const partial = roleArg[1];
        return [roles.filter((r) => r.startsWith(partial)), partial];
    }
    const explainArg = line.match(/^\/(?:explain|reflect)\s+(\S*)$/);
    if (explainArg) {
        const partial = explainArg[1];
        return [topicNames().filter((t) => t.startsWith(partial)), partial];
    }
    const themeArg = line.match(/^\/theme\s+(\S*)$/);
    if (themeArg) {
        const partial = themeArg[1];
        return [Object.keys(THEMES).filter((t) => t.startsWith(partial)), partial];
    }
    const cotArg = line.match(/^\/cot\s+(\S*)$/);
    if (cotArg) {
        const partial = cotArg[1];
        return [COT_MODES.filter((m) => m.startsWith(partial)), partial];
    }
    const modeArg = line.match(/^\/mode\s+(\S*)$/);
    if (modeArg) {
        const partial = modeArg[1];
        return [
            ["manual", "suggest", "auto"].filter((m) => m.startsWith(partial)),
            partial,
        ];
    }
    const allowArg = line.match(/^\/allow\s+(\S*)$/);
    if (allowArg) {
        const partial = allowArg[1];
        return [
            ["strict", "custom", "all"].filter((m) => m.startsWith(partial)),
            partial,
        ];
    }
    const thinkArg = line.match(/^\/think\s+(\S*)$/);
    if (thinkArg) {
        const partial = thinkArg[1];
        return [
            ["hide", "collapse", "show"].filter((m) => m.startsWith(partial)),
            partial,
        ];
    }
    // Ordinary input completes PATHS. Tab used to do nothing at all here, so the
    // only way to put a file in front of the model was to type its path from
    // memory and hope the agent read the right one -- against `@src/lib.ts` plus
    // Tab in every comparable tool. An `@` prefix is honoured but optional: the
    // completion is on the trailing token either way.
    if (!line.startsWith("/"))
        return completePath(line, root);
    const names = COMMANDS.map((c) => c.name);
    const hits = names.filter((n) => n.startsWith(line));
    // With nothing after "/", offer everything rather than nothing.
    return [hits.length > 0 ? hits : names, line];
}
// ---------------------------------------------------------------------------
// Self-targeting guard
// ---------------------------------------------------------------------------
/**
 * The checkout this build is running from, or null when it cannot be found.
 *
 * Located the same way the launcher does: walk up from this module until the
 * CLI source appears.
 */
export function harnessCheckout(from = fileURLToPath(import.meta.url)) {
    let dir = dirname(resolve(from));
    for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, "packages", "gnomon-cli", "src", "index.ts")))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
/**
 * Whether the project about to be worked on is gnomon's own checkout.
 *
 * Running `gnomon` from the harness directory is legitimate — that is how
 * gnomon is developed — but for anyone using gnomon on their own project it
 * is a mistake, and a quiet one: an entire session was spent auditing the
 * harness while its operator believed they were auditing their project. The
 * project root is already printed; this says what that root *is*.
 */
export function isSelfTargeting(projectRoot) {
    const checkout = harnessCheckout();
    return checkout !== null && resolve(projectRoot) === resolve(checkout);
}
// ---------------------------------------------------------------------------
// Session picker
// ---------------------------------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * "25 Aug 10:41" — short, sortable by eye, and not locale-dependent.
 *
 * toLocaleString would render differently per machine, which is the kind of
 * per-machine variation this harness avoids even in output nobody hashes.
 */
export function formatWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return "unknown";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** One row of the picker: when it was, how big, and what it was about. */
export function sessionRow(entry, widths, current) {
    const when = formatWhen(entry.updated);
    const turns = `${entry.turns} turn${entry.turns === 1 ? "" : "s"}`;
    const topic = entry.opening
        ? entry.opening.length > 52
            ? `${entry.opening.slice(0, 52)}…`
            : entry.opening
        : "(no opening line)";
    return (`${when}  ${turns.padStart(8)}  ` +
        `${entry.currentRole.padEnd(widths.role)}  ${topic}${current ? "   ← current" : ""}`);
}
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
export function setRoleModel(text, role, model, endpoint) {
    const lines = text.split("\n");
    const header = new RegExp(`^\\s*\\[roles\\.${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`);
    const start = lines.findIndex((l) => header.test(l));
    if (start === -1) {
        throw new Error(`roles.toml has no [roles.${role}] section to edit.`);
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^\s*\[/.test(lines[i])) {
            end = i;
            break;
        }
    }
    const put = (key, value) => {
        const at = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
        const line = `${key} = "${value}"`;
        if (at === -1)
            lines.splice(start + 1, 0, line);
        else
            lines[at] = line;
    };
    put("model", model);
    if (endpoint)
        put("endpoint", endpoint);
    return lines.join("\n");
}
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
export function setEndpointBlock(text, name, fields) {
    const lines = text.split("\n");
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const start = lines.findIndex((l) => new RegExp(`^\\s*\\[endpoints\\.${escaped}\\]\\s*$`).test(l));
    const body = [`url = "${fields.url}"`, `kind = "${fields.kind}"`];
    if (fields.api_key_env)
        body.push(`api_key_env = "${fields.api_key_env}"`);
    if (fields.provider)
        body.push(`provider = "${fields.provider}"`);
    if (start === -1) {
        const out = [...lines];
        while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "")
            out.pop();
        return [...out, "", `[endpoints.${name}]`, ...body, ""].join("\n");
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^\s*\[/.test(lines[i] ?? "")) {
            end = i;
            break;
        }
    }
    const inner = lines.slice(start + 1, end);
    const isProse = (l) => l.trim() === "" || l.trim().startsWith("#");
    const firstSetting = inner.findIndex((l) => !isProse(l));
    // Prose above the first setting introduces the block; prose below it is a
    // note that follows. Keep both where their author put them, and drop only
    // the settings — which is the whole job.
    const lead = firstSetting === -1 ? inner : inner.slice(0, firstSetting);
    const trail = firstSetting === -1 ? [] : inner.slice(firstSetting).filter(isProse);
    while (lead.length > 0 && (lead[lead.length - 1] ?? "").trim() === "")
        lead.pop();
    while (trail.length > 0 && (trail[0] ?? "").trim() === "")
        trail.shift();
    while (trail.length > 0 && (trail[trail.length - 1] ?? "").trim() === "")
        trail.pop();
    return [
        ...lines.slice(0, start + 1),
        ...lead,
        ...body,
        "",
        ...(trail.length > 0 ? [...trail, ""] : []),
        ...lines.slice(end),
    ].join("\n");
}
/** Rows visible at once. Longer lists scroll inside this window. */
const PICK_ROWS = 10;
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
export async function pickFromList(items, opts, ui, rl, out = process.stdout) {
    if (items.length === 0)
        return null;
    const rows = Math.max(3, Math.min(opts.rows ?? PICK_ROWS, items.length));
    const height = rows + 4;
    let filter = "";
    let index = Math.max(0, Math.min(opts.start ?? 0, items.length - 1));
    let top = 0;
    const visible = () => {
        const f = filter.toLowerCase();
        if (!f)
            return items;
        return items.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(f));
    };
    // Cursor arithmetic moves up by a fixed count, so a row that wraps would
    // make every subsequent redraw land a line too low and smear the list up the
    // screen. Truncating is what keeps the height a constant.
    const width = () => Math.max(20, (out.columns ?? 80) - 1);
    const fit = (text, used) => {
        const room = width() - used;
        return text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`;
    };
    const draw = (first) => {
        const list = visible();
        if (index >= list.length)
            index = Math.max(0, list.length - 1);
        if (index < top)
            top = index;
        if (index >= top + rows)
            top = index - rows + 1;
        top = Math.max(0, Math.min(top, Math.max(0, list.length - rows)));
        if (!first)
            out.write(`\x1b[${height}A`);
        out.write("\x1b[J");
        out.write(`  ${paint(ui, "cyan", fit(opts.title, 2))}` +
            `${paint(ui, "gray", fit("   ↑↓ move · Enter choose · Esc cancel · type to filter", opts.title.length + 2))}\n`);
        out.write(`  ${paint(ui, "gray", "filter:")} ` +
            `${filter ? paint(ui, "bold", filter) : paint(ui, "gray", "(none)")}\n\n`);
        for (let r = 0; r < rows; r++) {
            const item = list[top + r];
            if (!item) {
                out.write("\n");
                continue;
            }
            const mark = item.current ? paint(ui, "green", "✓") : " ";
            // Measured on the plain text; the escape codes occupy no columns.
            const plain = `${item.label}${item.hint ? `  ${item.hint}` : ""}`;
            const shown = fit(plain, 6);
            const label = shown.slice(0, item.label.length);
            const rest = shown.slice(item.label.length);
            const hint = rest ? paint(ui, "gray", rest) : "";
            out.write(top + r === index
                ? `${paint(ui, "cyan", "  ›")} ${mark} ${paint(ui, "bold", label)}${hint}\n`
                : `    ${mark} ${paint(ui, "gray", label)}${hint}\n`);
        }
        const shown = Math.min(rows, list.length);
        out.write(paint(ui, "gray", `  ${list.length ? top + 1 : 0}–${top + shown} of ${list.length}` +
            `${filter ? ` matching "${filter}"` : ""}\n`));
    };
    draw(true);
    return new Promise((resolvePick) => {
        const onKey = (chunk, key) => {
            if (!key)
                return;
            const list = visible();
            if (key.name === "up" || (key.ctrl && key.name === "p")) {
                index = list.length ? (index - 1 + list.length) % list.length : 0;
            }
            else if (key.name === "down" || (key.ctrl && key.name === "n")) {
                index = list.length ? (index + 1) % list.length : 0;
            }
            else if (key.name === "pageup") {
                index = Math.max(0, index - rows);
            }
            else if (key.name === "pagedown") {
                index = Math.min(Math.max(0, list.length - 1), index + rows);
            }
            else if (key.name === "return" || key.name === "enter") {
                return finish(list[index]?.key ?? null);
            }
            else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
                return finish(null);
            }
            else if (key.name === "backspace") {
                filter = filter.slice(0, -1);
                index = 0;
            }
            else if (!key.ctrl &&
                !key.meta &&
                typeof chunk === "string" &&
                chunk.length === 1 &&
                chunk >= " ") {
                // Typing filters. That is also why `q` no longer cancels: in a list
                // you can type into, a letter that quits is a trap.
                filter += chunk;
                index = 0;
            }
            else {
                return;
            }
            draw(false);
        };
        const finish = (chosen) => {
            process.stdin.off("keypress", onKey);
            // Hand the keyboard back exactly as it was found.
            for (const l of borrowed)
                process.stdin.on("keypress", l);
            out.write(`\x1b[${height}A\x1b[J`);
            rl.resume();
            resolvePick(chosen);
        };
        // Take readline's keypress listeners away for the duration.
        //
        // rl.pause() is not enough, and believing it was cost four separate
        // defects. Readline stays subscribed to the same keypress events, so every
        // key was handled twice: it echoed the filter onto the prompt line
        // underneath the picker, it emitted a `line` event when Enter chose a row
        // — which queued the filter text as a real model turn, so choosing a model
        // made gnomon prompt itself with the word "qwen" — it left the filter in
        // its buffer after Esc so the next message went out with it prepended, and
        // its own SIGINT handler killed the whole session on Ctrl-C while this
        // picker's ctrl-c branch sat unreachable.
        //
        // With the listeners detached, readline sees nothing, echoes nothing, and
        // emits nothing until they are put back.
        const borrowed = process.stdin.listeners("keypress");
        for (const l of borrowed)
            process.stdin.off("keypress", l);
        rl.pause();
        process.stdin.resume();
        process.stdin.on("keypress", onKey);
    });
}
export async function pickSession(entries, currentId, ui, rl, out = process.stdout) {
    if (entries.length === 0)
        return null;
    // Newest first: the one most likely wanted is the one under the cursor.
    const rows = [...entries].reverse();
    const roleWidth = Math.max(...rows.map((e) => e.currentRole.length));
    return pickFromList(rows.map((e) => ({
        key: e.id,
        label: sessionRow(e, { role: roleWidth }, e.id === currentId),
        current: e.id === currentId,
    })), { title: "Choose a session" }, ui, rl, out);
}
// ---------------------------------------------------------------------------
// Live command menu
// ---------------------------------------------------------------------------
/** How many matches to show below the prompt at once. */
const MENU_ROWS = 6;
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
export class CommandMenu {
    out;
    ui;
    shown = false;
    rows = 0;
    constructor(out, ui) {
        this.out = out;
        this.ui = ui;
    }
    get live() {
        return Boolean(this.out.isTTY);
    }
    /** Matching commands for a partial line, or null when no menu applies. */
    static matches(line) {
        if (!line.startsWith("/"))
            return null;
        // Once a space is typed the command is chosen and an argument is being
        // entered. Checking the trimmed line missed the trailing space, which is
        // exactly the keystroke that ends the menu's usefulness.
        if (/\s/.test(line))
            return null;
        return COMMANDS.filter((c) => c.name.startsWith(line));
    }
    render(line) {
        if (!this.live)
            return;
        const found = CommandMenu.matches(line);
        if (!found) {
            this.clear();
            return;
        }
        const ui = this.ui();
        const rows = found.slice(0, MENU_ROWS);
        const width = Math.max(...COMMANDS.map((c) => c.name.length));
        // Truncate each row to the terminal width so a long help string never
        // wraps. A wrapped row makes the body taller than the save/restore redraw
        // assumes — the actual cause of the menu tearing into duplicated, smeared
        // copies on a narrow terminal. `2 + width + 2` is the plain prefix width
        // (indent, padded name, gap); the escape codes paint adds occupy no columns.
        const cols = Math.max(20, (this.out.columns ?? 80) - 1);
        const clip = (s, room) => s.length <= room ? s : `${s.slice(0, Math.max(1, room - 1))}…`;
        const body = rows.map((c) => {
            const help = clip(c.help, Math.max(0, cols - (width + 4)));
            return `  ${paint(ui, "cyan", c.name.padEnd(width))}  ${paint(ui, "gray", help)}`;
        });
        if (found.length > rows.length) {
            body.push(paint(ui, "gray", `  … ${found.length - rows.length} more`));
        }
        if (found.length === 0) {
            body.push(paint(ui, "gray", `  no command starts with ${line}`));
        }
        // Draw the menu on the rows below the prompt without disturbing it. The
        // cursor is on the prompt line (readline has already redrawn it). The trap
        // is the bottom of the screen: saving the cursor, drawing N lines, and
        // having that draw SCROLL the screen leaves the saved position stale, so
        // the restore lands N rows too low — every keystroke then redraws slightly
        // offset, smearing the menu into the duplicated, corrupted copies the bug
        // report showed. So reserve the N rows first (the scroll, if any, happens
        // now and carries the cursor with it), come back up to the prompt, and only
        // then save → draw → restore. Nothing scrolls in that window, so the
        // restore is exact. IND (ESC D) reserves a row and preserves the column
        // regardless of the terminal's newline mode; each drawn row is forced to
        // column 0 with CR so nothing depends on it either.
        const n = body.length;
        this.out.write("\x1bD".repeat(n)); // reserve N rows below (scroll now if at bottom)
        this.out.write(`\x1b[${n}A`); // back up to the prompt line, column intact
        this.out.write("\x1b7"); // save cursor (DECSC) — stable, no more scroll
        this.out.write("\n\r\x1b[J"); // down one, column 0, clear the whole region
        this.out.write(body.join("\n\r")); // draw, each row starting at column 0
        this.out.write("\x1b8"); // restore to the prompt
        this.rows = n;
        this.shown = true;
    }
    /** Erase the menu. Safe to call when nothing is drawn. */
    clear() {
        if (!this.live || !this.shown)
            return;
        this.out.write("\x1b7"); // save at the prompt
        this.out.write("\n\r\x1b[J"); // wipe everything below it
        this.out.write("\x1b8"); // restore
        this.rows = 0;
        this.shown = false;
    }
}
// ---------------------------------------------------------------------------
// Command loop
// ---------------------------------------------------------------------------
/** Process a slash command; returns true if command was handled */
export function processCommand(cmd, state) {
    const parts = cmd.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    switch (command) {
        case "/quit":
        case "/exit":
        case "/q":
            console.log("\nSession complete. See you next turn.");
            process.exit(0);
            return true;
        case "/role":
        case "/roles": {
            const roles = listRoles(state.config);
            const wanted = (parts[1] ?? "").trim();
            // `/roles plan` reads as "switch to plan" to anyone typing it, so make
            // it do that rather than silently re-listing and leaving the role alone.
            if (wanted) {
                if (!roles.includes(wanted)) {
                    console.log(`\nNo such role: "${wanted}". Available: ${roles.join(", ")}`);
                    return true;
                }
                state.currentRole = wanted;
                const route = routeRole(state.config, wanted);
                const where = route.target.endpoint ? ` @ ${route.target.endpoint}` : "";
                console.log(`\nRole: ${wanted} → ${route.model}${where}`);
                const set = buildToolSet(state.config, wanted, state.mcp?.tools() ?? []);
                console.log(`  tools: ${set.schemas.map((t) => t.function.name).join(", ") || "(none — read-only role)"}`);
                // Switching role and then being routed elsewhere on the next turn
                // looks like /role did not work. Say which one is in charge.
                const mode = routingOf(state).mode;
                if (mode === "auto") {
                    console.log(`  note: mode is auto, so the routing rules may still send a turn ` +
                        `elsewhere.\n        /mode manual pins this role.`);
                }
                else if (mode === "suggest") {
                    console.log(`  note: mode is suggest, so you may still be asked to switch per turn.`);
                }
                return true;
            }
            console.log(`\nAvailable roles: ${roles.join(", ")}`);
            for (const r of roles) {
                const roleDef = state.config.roles[r];
                const model = roleDef.model ?? roleDef.profile ?? "local:default";
                const desc = roleDef.description ?? "";
                const here = r === state.currentRole ? " ← current" : "";
                const ep = roleDef.endpoint ? ` @${roleDef.endpoint}` : "";
                const scope = Array.isArray(roleDef.tools)
                    ? `  [tools: ${roleDef.tools.join(", ") || "none"}]`
                    : "";
                const budget = typeof roleDef.max_steps === "number"
                    ? `  [max_steps ${roleDef.max_steps}]`
                    : `  [max_steps ${resolveLoop(state.config).max_steps} — default, not set]`;
                console.log(`  ${r}: ${model}${ep}${desc ? ` — ${desc}` : ""}${scope}${budget}${here}`);
            }
            console.log(`\nSwitch with: /role <name>`);
            return true;
        }
        case "/sessions":
        case "/session": {
            const st = resolveSessionStore(state.config);
            const wanted = (parts[1] ?? "").trim();
            if (!st.persist) {
                console.log("\nSession persistence is off. Set [session].persist = true in " +
                    ".gnomon/config.toml to keep conversations.");
                return true;
            }
            if (wanted) {
                try {
                    state.switchSession?.(wanted);
                    console.log(`\nSwitched to ${wanted} — ${state.exchanges.length} turn(s) restored.`);
                }
                catch (err) {
                    console.log(`\n${err instanceof Error ? err.message : String(err)}`);
                }
                return true;
            }
            console.log(`\nThis session: ${sessionIdOf(state)}`);
            console.log(`  ${state.exchanges.length} turn(s) · saved after every turn to ${st.dir}`);
            const others = listSessions(st).filter((e) => e.id !== sessionIdOf(state));
            if (others.length > 0) {
                console.log(`\nEarlier sessions (newest last):`);
                for (const e of others.slice(-8)) {
                    console.log(`  ${e.id}`);
                    console.log(`    ${e.turns} turn(s) · ${e.currentRole}${e.opening ? ` · "${e.opening}"` : ""}`);
                }
                console.log(`\n  /session <id>   continue one here`);
                console.log(`  /new            start a fresh one`);
            }
            else {
                console.log(`\n  /new  starts a fresh one; this is the only session so far.`);
            }
            return true;
        }
        case "/skills": {
            const active = loadSkills(state.config);
            const pending = loadProposedSkills(state.config);
            // Two empty lists and the word "surface" told a first-time reader
            // nothing. Say what a skill IS before listing however many there are.
            if (active.length === 0 && pending.length === 0) {
                console.log(`\nNo skills yet.\n\n` +
                    `A skill is a note this repository keeps about itself — how it builds,\n` +
                    `where things live, conventions worth not rediscovering. Matching skills\n` +
                    `are added to the prompt automatically, so the agent starts each session\n` +
                    `already knowing them.\n\n` +
                    `To create one, ask the coordinator:\n` +
                    `  /role coordinator\n` +
                    `  Propose a skill recording how this project builds and tests.\n\n` +
                    `You review the diff, then \`gnomon skill accept <id>\` makes it real.\n` +
                    `Nothing an agent proposes takes effect until you accept it.`);
                return true;
            }
            console.log(`\nIn use — added to the prompt when they match:`);
            if (active.length === 0)
                console.log("  (none yet)");
            for (const sk of active) {
                console.log(`  ${sk.id} — ${sk.description ?? sk.name}`);
                console.log(`      applies: ${sk.match ? `when the turn matches /${sk.match}/` : "always"}` +
                    `${sk.roles ? `, for ${sk.roles.join(", ")}` : ""}`);
            }
            console.log(`\nProposed by an agent — not in use until you accept:`);
            if (pending.length === 0)
                console.log("  (none)");
            for (const sk of pending) {
                console.log(`  ${sk.id} — ${sk.description ?? sk.name}`);
                console.log(`      gnomon skill accept ${sk.id}   ·   gnomon skill reject ${sk.id}`);
            }
            if (pending.length > 0) {
                console.log(`\nAccepting moves it into the surface, which changes the surface hash\n` +
                    `deliberately, and it loads from the next session.`);
            }
            return true;
        }
        case "/mode": {
            const routing = routingOf(state);
            const wanted = (parts[1] ?? "").trim();
            if (!wanted) {
                console.log(`\nMode: ${routing.mode}`);
                console.log("  manual  — the current role answers; a prefix routes one turn");
                console.log("  suggest — the rules propose a role and you confirm, per turn");
                console.log("  auto    — the rules pick, and say what they picked");
                console.log("\n  A trust dial: run suggest until the rules stop surprising you.");
                if (routing.rules.length > 0) {
                    console.log("\nRules, in priority order:");
                    for (const rule of routing.rules) {
                        console.log(`  ${rule.role.padEnd(12)} ${rule.match}`);
                    }
                    console.log(`  ${routing.default.padEnd(12)} (default, when nothing matches)`);
                }
                else {
                    console.log("\nNo [[routing.rules]] declared — auto would always use " +
                        `"${routing.default}".`);
                }
                return true;
            }
            if (wanted !== "manual" && wanted !== "suggest" && wanted !== "auto") {
                console.log(`\nUnknown mode: "${wanted}". Use: manual | suggest | auto`);
                return true;
            }
            routing.mode = wanted;
            console.log(`\nMode: ${routing.mode}`);
            console.log("Session only — edit [routing].mode in .gnomon/config.toml to make it stick.");
            return true;
        }
        case "/tools": {
            const set = buildToolSet(state.config, state.currentRole, state.mcp?.tools() ?? []);
            console.log(`\nTools available to "${state.currentRole}":`);
            for (const t of set.schemas) {
                console.log(`  ${t.function.name} — ${t.function.description}`);
            }
            if (set.schemas.length === 0) {
                console.log("  (none — this role cannot call tools)");
            }
            if (set.withheld.length > 0) {
                console.log(`\n  Withheld from this role: ${set.withheld.join(", ")}`);
            }
            if (set.disabled.length > 0) {
                console.log(`  Disabled in the surface: ${set.disabled.join(", ")}`);
            }
            if (set.unimplemented.length > 0) {
                console.log(`  Declared but unimplemented: ${set.unimplemented.join(", ")}`);
            }
            return true;
        }
        case "/endpoints": {
            // The probing form runs on the async path at the prompt; this one is
            // what a mid-turn /endpoints gets, and it is careful to claim only what
            // it actually checked.
            printEndpoints(describeEndpoints(state.config), uiOf(state), null);
            return true;
        }
        case "/profiles":
            const profiles = listProfiles(state.config);
            console.log(`\nAvailable profiles: ${profiles.join(", ")}`);
            return true;
        case "/meta": {
            const ui = uiOf(state);
            const arg = parts.slice(1).join(" ").trim();
            if (!arg) {
                console.log(`\nMeta shown after each answer: ${ui.meta.join(", ") || "(none)"}`);
                console.log(`Style: ${ui.meta_style}`);
                console.log(`Available: ${META_FIELDS.join(", ")}`);
                console.log(`Set with: /meta turn,model,duration   ·   /meta all   ·   /meta none`);
                console.log(`Style with: /meta style compact | line`);
                return true;
            }
            if (arg === "all") {
                ui.meta = [...META_FIELDS];
            }
            else if (arg === "none") {
                ui.meta = [];
            }
            else if (arg.startsWith("style")) {
                const style = arg.slice("style".length).trim();
                if (style === "line" || style === "compact") {
                    ui.meta_style = style;
                }
                else {
                    console.log(`\nUnknown meta style: "${style}". Use: line | compact`);
                    return true;
                }
            }
            else {
                const { fields, unknown } = parseMetaFields(arg.split(/[\s,]+/));
                if (unknown.length > 0) {
                    console.log(`\nNot meta fields: ${unknown.join(", ")}`);
                    console.log(`Available: ${META_FIELDS.join(", ")}`);
                    return true;
                }
                ui.meta = fields;
            }
            console.log(`\nMeta: ${ui.meta.join(", ") || "(none)"} (${ui.meta_style})`);
            console.log(`Session only — edit [ui] in .gnomon/config.toml to make it stick.`);
            return true;
        }
        case "/network": {
            const wanted = (parts[1] ?? "").trim().toLowerCase();
            const declared = state.config.policy
                ?.sandbox?.network;
            const current = state.network ?? declared ?? false;
            if (!wanted) {
                console.log(`\nNetwork: ${current ? "on" : "off"}${state.network !== undefined ? " (this session)" : " (from policy.toml)"}`);
                console.log("  on  — webfetch may retrieve URLs.");
                console.log("  off — webfetch refuses outright. (default)");
                console.log("\n  A session grant: policy.toml is unchanged and the next session starts from it again.");
                console.log("  Not process isolation — a role holding `bash` can reach the network either way;");
                console.log("  constrain that with bash_allow if it matters.");
                return true;
            }
            if (wanted !== "on" && wanted !== "off") {
                console.log(`\nUnknown setting: "${wanted}". Use: on | off`);
                return true;
            }
            state.network = wanted === "on";
            console.log(`\nNetwork: ${wanted} — this session only; policy.toml still says ${declared ? "on" : "off"}.`);
            if (state.network) {
                // The caveat belongs where the grant is made, not only in the help
                // text: this is the moment the operator forms a belief about what they
                // just permitted.
                console.log("  Note: this governs the `webfetch` tool. It is NOT process isolation —");
                console.log("  a role holding `bash` could already reach the network via curl or a");
                console.log("  package manager. Constrain that with bash_allow if it matters.");
            }
            return true;
        }
        case "/sandbox": {
            const wanted = (parts[1] ?? "").trim().toLowerCase();
            const declared = (state.config.policy
                ?.sandbox?.level ?? "confined");
            const current = state.sandbox ?? declared;
            if (!wanted) {
                console.log(`\nSandbox: ${current}${state.sandbox ? " (this session)" : " (from policy.toml)"}`);
                console.log("  strict   — the project root only, symlinks resolved.");
                console.log("  confined — the project root. (default)");
                console.log("  off      — anywhere the process can reach, including other repositories.");
                console.log("\n  A session grant: policy.toml is unchanged and the next session starts from it again.");
                console.log("  `off` is what you want to audit or borrow from a repo outside this one.");
                return true;
            }
            if (!["off", "confined", "strict"].includes(wanted)) {
                console.log(`\nUnknown level: "${wanted}". Use: off | confined | strict`);
                return true;
            }
            state.sandbox = wanted;
            console.log(`\nSandbox: ${wanted} — this session only; policy.toml still says ${declared}.`);
            if (state.sandbox === "off") {
                console.log("  Tools may now read and write anywhere this process can reach, including");
                console.log("  other repositories. Every path still lands in the audit trail.");
            }
            return true;
        }
        case "/allow": {
            const wanted = (parts[1] ?? "").trim();
            const current = state.allow ?? "strict";
            if (!wanted) {
                console.log(`\nAllow: ${current} — may the agent edit its own .gnomon/ surface this session?`);
                console.log("  strict — no. The surface stays a human act; the agent names the edit for you. (default)");
                console.log("  custom — yes, but every surface write is approved, one at a time.");
                console.log("  all    — yes, standing consent. Each write still announces the hash move.");
                console.log("\n  A consent dial. Surface edits stay auditable — the hash moves loudly whatever the setting.");
                return true;
            }
            if (wanted !== "strict" && wanted !== "custom" && wanted !== "all") {
                console.log(`\nUnknown level: "${wanted}". Use: strict | custom | all`);
                return true;
            }
            state.allow = wanted;
            const note = state.allow === "all"
                ? " — the agent may now write .gnomon/ itself; every write announces the hash move."
                : state.allow === "custom"
                    ? " — the agent may write .gnomon/, and you approve each surface edit."
                    : " — the surface is human-only again.";
            console.log(`\nAllow: ${state.allow}${note}`);
            return true;
        }
        case "/theme": {
            const ui = uiOf(state);
            const wanted = (parts[1] ?? "").trim();
            if (!wanted) {
                console.log(`\nTheme: ${ui.theme}\n`);
                for (const t of Object.values(THEMES)) {
                    const mark = t.name === ui.theme ? "←" : " ";
                    // Render each name in its own palette, so the list is the preview.
                    const sample = paint({ ...ui, theme: t.name }, "gray", "secondary text");
                    const accent = paint({ ...ui, theme: t.name }, "cyan", "accent");
                    const warn = paint({ ...ui, theme: t.name }, "yellow", "attention");
                    console.log(`  ${t.name.padEnd(14)} ${sample}  ${accent}  ${warn}  ${mark}`);
                    console.log(`  ${" ".repeat(14)} ${t.description}`);
                }
                console.log(`\nSet with: /theme <name>`);
                return true;
            }
            if (!THEMES[wanted]) {
                console.log(`\nUnknown theme: "${wanted}". Available: ${Object.keys(THEMES).join(", ")}`);
                return true;
            }
            ui.theme = wanted;
            applyTerminalTheme(ui);
            console.log(`\nTheme: ${wanted} — ${THEMES[wanted].description}`);
            console.log(paint(ui, "gray", "  secondary text looks like this"));
            console.log("Session only — edit [ui].theme in .gnomon/config.toml to make it stick.");
            return true;
        }
        case "/think": {
            const ui = uiOf(state);
            const mode = (parts[1] ?? "").trim();
            if (!mode) {
                console.log(`\nChain-of-thought: ${ui.think}`);
                console.log(`  hide      — drop reasoning entirely`);
                console.log(`  collapse  — one line, so you see it happened`);
                console.log(`  show      — full reasoning block`);
                return true;
            }
            if (mode !== "hide" && mode !== "collapse" && mode !== "show") {
                console.log(`\nUnknown mode: "${mode}". Use: hide | collapse | show`);
                return true;
            }
            ui.think = mode;
            console.log(`\nChain-of-thought: ${ui.think}`);
            console.log(`Session only — edit [ui].think in .gnomon/config.toml to make it stick.`);
            return true;
        }
        case "/cot": {
            const ui = uiOf(state);
            const mode = (parts[1] ?? "").trim();
            if (!mode) {
                console.log(`\nLive trace: ${ui.cot}`);
                console.log(`  off    — nothing until the final answer`);
                console.log(`  brief  — one line per step: the call and its result`);
                console.log(`  tools  — tool calls and results, no reasoning`);
                console.log(`  think  — reasoning and prose only, no tool lines`);
                console.log(`  work   — as full, but a run of steps that succeeded and changed`);
                console.log(`           nothing folds into one line. /expand lists the last one.`);
                console.log(`  full   — reasoning + prose + every tool call/result, never folded`);
                console.log(`(reasoning is shown at /think's level: collapse = one line, show = all, hide = none)`);
                return true;
            }
            if (!COT_MODES.includes(mode)) {
                console.log(`\nUnknown mode: "${mode}". Use: ${COT_MODES.join(" | ")}`);
                return true;
            }
            ui.cot = mode;
            console.log(`\nLive trace: ${ui.cot}`);
            console.log(`Session only — edit [ui].cot in .gnomon/config.toml to make it stick.`);
            return true;
        }
        case "/expand": {
            const ui = uiOf(state);
            const steps = state.lastFold ?? [];
            if (steps.length === 0) {
                console.log(`\nNothing folded yet this session.`);
                console.log(`A run of steps folds only when every one of them succeeded and ` +
                    `changed nothing.`);
                return true;
            }
            console.log(`\n${steps.length} step(s) in the last folded run:`);
            for (const st of steps) {
                console.log(paint(ui, "cyan", `  ⚙ ${st.tool}`) + paint(ui, "gray", ` ${st.describe}`));
                console.log(paint(ui, st.colour, `    ${st.glyph} ${st.summary}`));
            }
            // The scrollback is a convenience; the trail is the record. Said here
            // because this is the moment someone is looking for what happened.
            console.log(paint(ui, "gray", `\nThis is display only — every call, its arguments and its result are ` +
                `in the audit trail (\`gnomon audit show\`), folded or not.`));
            return true;
        }
        case "/todo": {
            const todos = state.todos ?? [];
            if (todos.length === 0) {
                console.log("\nNo checklist. The agent writes one with the `todo` tool when a " +
                    "task has enough steps to be worth tracking.");
                return true;
            }
            const done = todos.filter((t) => t.status === "completed").length;
            console.log(`\nChecklist — ${done}/${todos.length} done`);
            for (const t of todos) {
                const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
                const colour = t.status === "completed" ? "gray" : t.status === "in_progress" ? "cyan" : "white";
                console.log(paint(uiOf(state), colour, `  ${mark} ${t.content}`));
            }
            console.log(paint(uiOf(state), "gray", "\n  It is saved with the session, so --continue picks it back up."));
            return true;
        }
        case "/context": {
            const ctx = resolveContext(state.config);
            const built = buildMessages(state, state.config.system.content ?? "", "");
            console.log(`\nContext policy (from .gnomon/config.toml):`);
            console.log(`  policy             ${ctx.policy}`);
            console.log(`  retain_after       ${ctx.retain_after} tok`);
            console.log(`  max_context_tokens ${ctx.max_context_tokens} tok`);
            console.log(`  compaction         ${ctx.compaction}`);
            console.log(`\nCurrent window:`);
            console.log(`  turns recorded     ${state.exchanges.length}`);
            console.log(`  turns carried      ${built.included}`);
            console.log(`  turns dropped      ${built.dropped}`);
            console.log(`  estimated tokens   ~${built.tokens} / ${ctx.max_context_tokens}` +
                `  (${ctx.reserve_output} reserved for the reply)`);
            const folded = state.exchanges.filter((e) => e.folded).length;
            if (folded > 0 || state.summary) {
                console.log(`  turns folded       ${folded} (in the summary)`);
                console.log(`  summary size       ~${estimateTokens(state.summary ?? "")} tok`);
            }
            if (ctx.compaction === "summary" || ctx.policy === "summary") {
                console.log(`  summary_role       ${ctx.summary_role}`);
            }
            if (built.notice)
                console.log(`  notice             ${built.notice}`);
            return true;
        }
        case "/new":
        case "/reset": {
            // Clearing history but keeping the session id meant the next turn's
            // snapshot overwrote the record of everything before it. Starting a new
            // session leaves the old one on disk, resumable.
            const n = state.exchanges.length;
            const previous = state.sessionId;
            // Rotate before clearing. newSession() persists the current state first,
            // so clearing beforehand wrote an empty snapshot over the very session
            // this is meant to leave intact.
            state.newSession?.();
            state.exchanges.length = 0;
            state.summary = undefined;
            console.log(`\nNew session${previous && n > 0 ? `; the previous one keeps its ${n} turn(s)` : ""}.`);
            if (previous && n > 0) {
                console.log(`  resume it later:  gnomon prompt --resume ${previous}`);
            }
            console.log(`  now:              ${sessionIdOf(state)}`);
            return true;
        }
        case "/explain":
        case "/reflect": {
            const topic = (parts[1] ?? "").trim().toLowerCase();
            if (!topic) {
                console.log("\nWhat would you like explained?\n");
                for (const t of explainTopics()) {
                    console.log(`  /explain ${t.topic.padEnd(10)} ${t.summary}`);
                }
                console.log("\nEach one says what the feature is, how THIS repository has it set,\n" +
                    "and what to do with it.");
                return true;
            }
            const found = explain(state.config, state.currentRole, topic);
            if (!found) {
                console.log(`\nNothing to explain for "${topic}". Try: ${topicNames().join(", ")}`);
                return true;
            }
            const ui = uiOf(state);
            console.log(`\n${paint(ui, "bold", found.topic)} — ${found.summary}\n`);
            for (const line of found.what)
                console.log(line ? `  ${line}` : "");
            console.log(`\n${paint(ui, "cyan", "In this repository")}`);
            for (const line of found.here)
                console.log(`  ${line}`);
            console.log(`\n${paint(ui, "cyan", "What to do with it")}`);
            for (const line of found.next)
                console.log(line ? `  ${line}` : "");
            return true;
        }
        case "/manifest": {
            // This printed "Use: gnomon surface manifest" — a pointer to another
            // command, with no hint what a manifest is or why anyone would want one.
            const m = explain(state.config, state.currentRole, "manifest");
            const ui = uiOf(state);
            console.log(`\n${paint(ui, "bold", "manifest")} — ${m.summary}\n`);
            for (const line of m.what)
                console.log(line ? `  ${line}` : "");
            console.log(`\n${paint(ui, "cyan", "In this repository")}`);
            for (const line of m.here)
                console.log(`  ${line}`);
            console.log(`\n${paint(ui, "cyan", "What to do with it")}`);
            for (const line of m.next)
                console.log(line ? `  ${line}` : "");
            return true;
        }
        case "/help": {
            console.log("\nCommands  (press Tab after \"/\" to complete)\n");
            const width = Math.max(...COMMANDS.map((c) => `${c.name} ${c.arg ?? ""}`.trimEnd().length));
            for (const c of COMMANDS) {
                const label = `${c.name}${c.arg ? ` ${c.arg}` : ""}`;
                console.log(`  ${label.padEnd(width)}  — ${c.help}`);
            }
            console.log(`

Input is automatically routed to a role based on prefix:
  /plan "..."      → plan role
  /implement "..." → implement role
  /critique "..."  → critique role
  /smol "..."      → smol role
  "..."            → current role (default: implement)

A role prefix applies to that one turn only; /role switches for good.

/meta and /think change this session only. Defaults live in
[ui] in .gnomon/config.toml, so every checkout renders the same.
`);
            return true;
        }
        case "/clear":
            process.stdout.write("\x1Bc");
            return true;
        default:
            return false;
    }
}
export async function runPromptLoop(config, initialRole, options = {}) {
    const state = {
        config,
        exchanges: [],
        currentRole: initialRole ?? "implement",
    };
    // Stored keys fill in for variables the shell has not exported. Named, not
    // shown: the loop reports which variables were supplied, never their values.
    const suppliedKeys = applyCredentials(undefined, declaredKeyVars(config));
    const stdin = options.io?.input ?? process.stdin;
    const stdout = options.io?.output ?? process.stdout;
    const menu = new CommandMenu(stdout, () => uiOf(state));
    const store = resolveSessionStore(config);
    const startedAt = new Date().toISOString();
    let sessionId = `${startedAt.replace(/[:.]/g, "-")}-${process.pid}`;
    let resumedFrom = null;
    state.sessionId = sessionId;
    if (options.resume) {
        try {
            const snap = loadSession(store, options.resume === true ? undefined : options.resume);
            state.exchanges = snap.exchanges ?? [];
            state.summary = snap.summary;
            // A resumed session picks the checklist back up: the most common reason
            // to resume is that the work is not finished.
            state.todos = snap.todos;
            state.currentRole = initialRole ?? snap.currentRole ?? state.currentRole;
            sessionId = snap.id;
            state.sessionId = sessionId;
            resumedFrom = snap;
        }
        catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    }
    const rl = readline.createInterface({
        input: stdin,
        output: stdout,
        // Tab after "/" lists every command, so they are discoverable from the
        // prompt rather than only from the docs.
        completer: (line) => completeInput(line, listRoles(config), listEndpoints(config), resolve(config.gnomonDir, "..")),
        // Node wants newest FIRST; the file keeps newest last so it reads like a log.
        history: loadHistory(config).slice().reverse(),
        historySize: HISTORY_LIMIT,
    });
    // Paint the terminal for the theme in force — only if the theme declares a
    // full-terminal colour, and only on a TTY. The exit-reset is registered on
    // first apply, so the terminal is restored when the loop ends.
    applyTerminalTheme(uiOf(state));
    // Off unless the surface asks for it.
    const auditSettings = resolveAudit(config);
    // One id for the session, so a trail and its snapshot name the same run.
    const audit = new AuditTrail(auditSettings, sessionId);
    const surfaceHash = (() => {
        try {
            return recomputeManifest(config.gnomonDir).surface_hash;
        }
        catch {
            return "";
        }
    })();
    audit.write("session_start", {
        // The trail names its harness for the same reason the record does.
        harness: harnessBuild(),
        surface_hash: surfaceHash,
        cwd: process.cwd(),
        roles: listRoles(config),
        record: auditSettings.record,
    });
    // Connect any declared MCP servers before the first turn, so their tools are
    // in the set the model sees. A server that will not connect is reported and
    // skipped — never fatal.
    //
    // Ordered AFTER session_start on purpose: a server that fails now writes a
    // `degradation` record, and a trail whose first entry is a degradation has no
    // session_start to attribute it to.
    if (config.tools.mcp_servers && Object.keys(config.tools.mcp_servers).length > 0) {
        state.mcp = await connectMcp(config.tools.mcp_servers, (l) => console.log(paint(uiOf(state), "gray", l)), audit);
    }
    // Rotating and switching need the loop's id and its persist(), so they are
    // supplied here rather than reached for from a command.
    state.newSession = () => {
        persist();
        sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
        state.sessionId = sessionId;
        resumedFrom = null;
    };
    state.switchSession = (id) => {
        persist();
        const snap = loadSession(store, id);
        state.exchanges = snap.exchanges ?? [];
        state.summary = snap.summary;
        state.currentRole = snap.currentRole ?? state.currentRole;
        sessionId = snap.id;
        state.sessionId = sessionId;
        resumedFrom = snap;
    };
    const persist = () => {
        if (!store.persist)
            return;
        try {
            saveSession(store, {
                format: SESSION_FORMAT,
                id: sessionId,
                started: resumedFrom?.started ?? startedAt,
                updated: new Date().toISOString(),
                surface_hash: surfaceHash,
                cwd: process.cwd(),
                currentRole: state.currentRole,
                summary: state.summary,
                todos: state.todos,
                exchanges: state.exchanges,
            });
        }
        catch (err) {
            // Losing a snapshot must not lose the turn that produced it.
            console.log(paint(uiOf(state), "yellow", `  [session] could not save: ${err instanceof Error ? err.message : String(err)}`));
        }
    };
    printBanner();
    // Which project this session is operating on.
    //
    // Nothing said. `.gnomon/` resolves by walking up, and `launch` is silent
    // when a surface already exists, so running either from the wrong directory
    // looked identical to running it from the right one — a session spent
    // working on the harness while its operator believed it was working on their
    // project. The root is the first thing on screen now.
    const projectRoot = resolve(config.gnomonDir, "..");
    console.log(`Project: ${projectRoot}`);
    if (isSelfTargeting(projectRoot)) {
        const ui0 = uiOf(state);
        console.log(paint(ui0, "yellow", "  ⚠ this is gnomon's own checkout — you are working on the harness,"));
        console.log(paint(ui0, "yellow", "    not on another project. cd to your project first if that was not intended."));
    }
    if (projectRoot !== resolve(process.cwd())) {
        console.log(`  (found by walking up from ${resolve(process.cwd())})`);
    }
    // What the surface says that cannot be true. Before the first turn, because
    // every one of these used to surface as a 401 or a model error somewhere in
    // the middle of a task, with nothing on screen connecting it to the line
    // that caused it.
    if (!reportSurfaceProblems(auditSurface(config), uiOf(state))) {
        process.exit(1);
    }
    console.log(`Role: ${state.currentRole}`);
    console.log(`Model: ${routeRole(config, state.currentRole).model}`);
    console.log("");
    // Line-driven input with a queue: anything typed while the model is
    // thinking is buffered and processed in order instead of being dropped.
    let closed = false;
    const lineQueue = [];
    let notify = null;
    // ── Pasting ───────────────────────────────────────────────────────────────
    //
    // readline emits one "line" event per newline, and the queue above turned
    // every one of them into a turn: pasting a forty-line stack trace opened
    // forty turns, each answering a fragment of it. Pasting context is not an
    // exotic use — paths, logs, diffs and specs get into a session no other way.
    //
    // A terminal will mark a paste if asked: \x1b[?2004h makes it wrap pasted
    // text in \x1b[200~ … \x1b[201~. scanPasteMarkers counts the newlines inside
    // those markers, from a listener PREPENDED to stdin. Prepending is the whole
    // trick: it runs before readline's own data handler, so it can say in
    // advance how many of the coming "line" events are paste rather than input.
    //
    // The fragment after a paste's last newline is deliberately left in
    // readline's buffer: it stays editable, and Enter sends the held lines and
    // that fragment together as ONE turn. Pasting alone submits nothing.
    /** Complete lines taken from a paste, waiting for the Enter that sends them. */
    let pasteBuffer = [];
    /** How many upcoming "line" events are paste content, not typed input. */
    let pastedLines = 0;
    /** True across chunk boundaries while the terminal is inside a paste. */
    let inPaste = false;
    /** Set while a chunk carrying paste is being delivered; cleared next tick. */
    let pasteKeysInFlight = false;
    if (stdin.isTTY) {
        process.stdout.write("\x1b[?2004h");
        // Leaving it on would make the next program to own this terminal receive
        // markers it never asked for.
        process.on("exit", () => {
            if (process.stdout.isTTY)
                process.stdout.write("\x1b[?2004l");
        });
        stdin.prependListener("data", (chunk) => {
            const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            if (!inPaste && !s.includes(PASTE_START))
                return;
            const scan = scanPasteMarkers(s, inPaste);
            pastedLines += scan.lines;
            inPaste = scan.inPaste;
            if (scan.sawPaste) {
                // Skip the per-keystroke work for every pasted character: the spinner
                // repaint and the "/" menu are paid per key, and an ESC inside pasted
                // text would otherwise cancel the turn in flight.
                pasteKeysInFlight = true;
                setImmediate(() => {
                    pasteKeysInFlight = false;
                });
            }
        });
    }
    rl.on("line", (raw) => {
        // Persist before anything can consume or reroute the line, so a prompt is
        // recallable next session even if this turn goes wrong.
        appendHistory(config, raw);
        // Paste content. Hold it; do not open a turn for it.
        if (pastedLines > 0) {
            pastedLines -= 1;
            pasteBuffer.push(raw);
            if (pastedLines === 0) {
                // Deferred a tick so the receipt lands after readline has finished
                // echoing, rather than in the middle of it.
                setImmediate(() => {
                    if (pasteBuffer.length === 0)
                        return;
                    const held = pasteBuffer.length;
                    const chars = pasteBuffer.reduce((n, l) => n + l.length + 1, 0);
                    console.log(paint(uiOf(state), "gray", `  ⎘ pasted ${held} line${held === 1 ? "" : "s"}, ${chars} chars — held; Enter sends it as one turn`));
                    rl.prompt(true);
                });
            }
            return;
        }
        menu.clear();
        // Enter after a paste: the held lines and whatever is on the prompt line
        // go out together, as a single input.
        let line = raw;
        if (pasteBuffer.length > 0) {
            line = joinPastedBlock(pasteBuffer, raw);
            pasteBuffer = [];
        }
        if (notify) {
            const n = notify;
            notify = null;
            n(line);
            return;
        }
        // Nothing is waiting on this line, which means a turn is running.
        const trimmed = line.trim();
        const verb = trimmed.split(/\s+/)[0];
        if (cancelTurn && trimmed && LIVE_SAFE_COMMANDS.has(verb)) {
            // Run it now. These only read state or change rendering, so the turn in
            // flight is unaffected — and waiting until it finished to be told what
            // /think does would defeat the point of asking mid-turn.
            processCommand(trimmed, state);
            activeProgress?.resume();
            return;
        }
        lineQueue.push(line);
        // Reaching here at all means nothing was waiting on the line — the harness
        // is busy. Acknowledging only when a *cancellable turn* was running left
        // input typed during compaction with no echo, no prompt and no receipt,
        // which is the very symptom the queue was added to remove.
        if (trimmed) {
            const ui0 = uiOf(state);
            console.log(paint(ui0, "gray", `  ⏎ queued (${lineQueue.length}) — runs when the harness is free`));
            activeProgress?.resume();
        }
    });
    rl.on("close", () => {
        closed = true;
        state.mcp?.close();
        if (notify) {
            const n = notify;
            notify = null;
            n(null);
        }
    });
    const readLine = () => new Promise((resolve) => {
        if (lineQueue.length > 0) {
            resolve(lineQueue.shift() ?? null);
            return;
        }
        if (closed) {
            resolve(null);
            return;
        }
        notify = resolve;
    });
    // Esc cancels the turn in flight. Only a turn — at the prompt it does
    // nothing, so a stray Esc cannot end the session. Ctrl+C does the same
    // mid-turn and only exits when nothing is running.
    let cancelTurn = null;
    // The progress line of the turn in flight, so typing can silence it.
    let activeProgress = null;
    // True while the session picker owns the keyboard.
    let picking = false;
    if (stdin.isTTY) {
        readline.emitKeypressEvents(stdin);
        stdin.on("keypress", (_chunk, key) => {
            if (picking)
                return; // the picker has its own key handling
            // Pasted characters are not keystrokes. Without this a paste repainted
            // the spinner once per character, and an ESC inside pasted text read as
            // a request to cancel the turn.
            if (pasteKeysInFlight)
                return;
            if (key && key.name === "escape" && cancelTurn) {
                cancelTurn();
                return;
            }
            // Any other key while a turn runs: the line belongs to the typist now.
            // The spinner erases the whole line twelve times a second, so without
            // this nothing typed during a turn was ever visible — the queue worked,
            // but blind.
            //
            // suspend() erases the frame it was drawing, and readline has already
            // echoed the keystroke onto that same row — so the character that
            // silenced the spinner went with it and the line read `ix the bug`.
            // Repainting on the next tick puts the prompt and the whole buffer back;
            // a tick later because readline updates rl.line after this handler runs.
            if (cancelTurn && activeProgress?.suspend()) {
                setImmediate(() => {
                    if (cancelTurn)
                        rl.prompt(true);
                });
            }
            // Show what `/` can start. Deferred a tick because readline updates its
            // buffer after the keypress handler runs, so reading rl.line here would
            // always be one character behind.
            setImmediate(() => {
                if (cancelTurn || picking)
                    return;
                menu.render(rl.line ?? "");
            });
        });
    }
    rl.on("SIGINT", () => {
        // A picker owns the keyboard and cancels itself on Ctrl-C. Without this
        // guard readline's handler ran first and ended the session on top of a
        // half-drawn list.
        if (picking)
            return;
        if (cancelTurn) {
            cancelTurn();
            return;
        }
        console.log("\nSession complete. See you next turn.");
        process.exit(0);
    });
    /**
     * Ask whether to take a suggested role.
     *
     * Declining is the cheap answer, so `n` is the default: a nudge you ignore
     * should cost one keystroke. "always" switches the session role, which is
     * how `suggest` becomes `auto` for the rules you have come to trust.
     */
    const suggestRole = async (from, to, why) => {
        const ui = uiOf(state);
        console.log("");
        console.log(paint(ui, "cyan", `  ⇢ suggest: ${from} → ${to}`) +
            paint(ui, "gray", `  (${why})`));
        const toolNames = buildToolSet(config, to)
            .schemas.map((t) => t.function.name)
            .join(", ");
        console.log(paint(ui, "gray", `    ${to} can use: ${toolNames || "(no tools)"}`));
        console.log(paint(ui, "yellow", `  └ [y]es once · [a]lways · [N]o  (Enter keeps ${from})`));
        // Typed-ahead lines were meant as messages, not as an answer to a
        // question that had not appeared yet.
        const held = lineQueue.splice(0, lineQueue.length);
        rl.setPrompt("role> ");
        rl.prompt();
        const answer = ((await readLine()) ?? "").trim().toLowerCase();
        lineQueue.unshift(...held);
        if (/^(a|always)$/.test(answer)) {
            console.log(paint(ui, "green", `  switched to ${to} for the session`));
            return "always";
        }
        if (/^(y|yes)$/.test(answer)) {
            console.log(paint(ui, "green", `  ${to} for this turn`));
            return "once";
        }
        console.log(paint(ui, "gray", `  staying on ${from}`));
        return "no";
    };
    // Standing approvals. `turn` is cleared before every turn; `session` lasts
    // until the loop exits. Approving a long read-only survey one call at a time
    // is not oversight, it is a rhythm you stop reading — which is worse than
    // deciding once, deliberately, with the scope stated.
    let approveRestOfTurn = false;
    let approveRestOfSession = false;
    // Approval gate. Reads from the same queue the loop uses, so a decision
    // typed while a tool is pending is picked up in order.
    const approve = async (req) => {
        const ui = uiOf(state);
        if (approveRestOfSession || approveRestOfTurn) {
            // No line here. This used to print `⤷ <summary> (standing approval: …)`
            // for EVERY call, which restated a scope the operator had already been
            // told about once, in full, at the moment they granted it — and did it
            // beside the `⚙` line that names the same call, so each step cost three
            // lines and two of them said the same thing. Measured on a real recon
            // run: 40+ identical suffixes in one turn, with the truncated copy
            // printed FIRST and the useful one second.
            //
            // The decision is still recorded. The audit trail is what answers "what
            // was approved and by whom"; the scrollback was only ever a worse copy
            // of it, and a worse copy that made the calls nobody approved harder to
            // spot.
            audit.write("approval", {
                tool: req.tool,
                summary: req.summary,
                decision: "approved",
                by: approveRestOfSession ? "human:standing-session" : "human:standing-turn",
                interactive: Boolean(process.stdin.isTTY),
            });
            return true;
        }
        console.log("");
        // Both of these are model-chosen strings. Printed raw, a command carrying
        // ESC[2K and a CR could erase and rewrite the very line being approved.
        console.log(paint(ui, "yellow", `  ┌ approve: ${safeForPrompt(req.summary)}`));
        for (const raw of req.preview.slice(0, 60)) {
            const line = safeForPrompt(raw);
            const colour = line.startsWith("+ ")
                ? "green"
                : line.startsWith("- ")
                    ? "red"
                    : "gray";
            console.log(paint(ui, colour, `  │ ${line}`));
        }
        if (req.preview.length > 60) {
            console.log(paint(ui, "gray", `  │ … ${req.preview.length - 60} more lines`));
        }
        console.log(paint(ui, "yellow", "  └ [y]es · [a]ll this turn · [s]ession · [N]o"));
        // On a TTY, anything already typed was meant as a message, not as an
        // answer to a prompt the user had not yet seen — hold it and replay it.
        // On a pipe the opposite is true: the script's next line IS the answer,
        // and holding it would silently decline every gated call.
        const held = process.stdin.isTTY
            ? lineQueue.splice(0, lineQueue.length)
            : [];
        if (held.length > 0) {
            console.log(paint(ui, "gray", `  (holding ${held.length} typed-ahead line(s))`));
        }
        let yes = false;
        for (let attempt = 0;; attempt++) {
            rl.setPrompt("approve> ");
            rl.prompt();
            const answer = ((await readLine()) ?? "").trim();
            if (/^(y|yes)$/i.test(answer)) {
                yes = true;
                break;
            }
            if (/^(a|all)$/i.test(answer)) {
                approveRestOfTurn = true;
                yes = true;
                console.log(paint(ui, "yellow", "  approving the rest of THIS TURN without asking"));
                break;
            }
            if (/^(s|session)$/i.test(answer)) {
                approveRestOfSession = true;
                yes = true;
                console.log(paint(ui, "red", "  approving every gated call for the REST OF THE SESSION — " +
                    "writes included. /reset does not clear this; restart to revoke."));
                break;
            }
            if (/^(n|no)$/i.test(answer) || answer === "") {
                yes = false;
                break;
            }
            // Unrecognised input used to count as "no", so a stray keystroke
            // silently refused the call. Ask again instead of guessing.
            if (!process.stdin.isTTY || attempt >= 2) {
                console.log(paint(ui, "yellow", "  unrecognised — treating as no"));
                yes = false;
                break;
            }
            console.log(paint(ui, "yellow", `  answer y or n (got "${answer}")`));
        }
        lineQueue.unshift(...held);
        audit.write("approval", {
            tool: req.tool,
            summary: req.summary,
            decision: yes ? "approved" : "declined",
            by: "human",
            interactive: Boolean(process.stdin.isTTY),
        });
        console.log(yes
            ? paint(ui, "green", "  approved")
            : paint(ui, "yellow", "  declined"));
        return yes;
    };
    // Name what the surface declares but cannot offer, rather than quietly
    // shipping a shorter tool list.
    const reportTools = () => {
        const ui = uiOf(state);
        const toolSet = buildToolSet(config, state.currentRole, state.mcp?.tools() ?? []);
        const names = toolSet.schemas.map((t) => t.function.name);
        console.log(paint(ui, "gray", `Tools (${state.currentRole}): ${names.join(", ") || "(none)"}`));
        if (toolSet.withheld.length > 0) {
            console.log(paint(ui, "gray", `  not for this role: ${toolSet.withheld.join(", ")}`));
        }
        if (toolSet.disabled.length > 0) {
            console.log(paint(ui, "yellow", `  disabled in surface: ${toolSet.disabled.join(", ")}`));
        }
        if (toolSet.unimplemented.length > 0) {
            console.log(paint(ui, "yellow", `  declared but not implemented by this build: ${toolSet.unimplemented.join(", ")}`));
        }
        if (toolSet.mcp_declared.length > 0) {
            const connected = state.mcp?.tools().length ?? 0;
            console.log(paint(ui, "gray", `  MCP: ${toolSet.mcp_declared.length} server(s) declared, ${connected} tool(s) connected — ` +
                `a role must list a tool, or its server as mcp__<name>, to use them.`));
        }
    };
    {
        const ui = uiOf(state);
        reportTools();
        // Which profile is in force, and whether a flag chose it.
        //
        // `role_profile` was published in the enumerations and read by nothing for
        // the whole life of the project — the surface advertised that choosing
        // local_first or frontier_plan changed where inference goes, and it did
        // not. Now that it does, it says so: an applied profile rewrites role
        // routing, and routing is the single largest source of run-to-run variance.
        const prof = config.profile;
        if (prof?.problem) {
            console.log(paint(ui, "red", `  ✗ ${prof.problem} — running the base roles unchanged`));
        }
        else if (prof?.name && prof.overridden) {
            // --profile is machine-scoped: it changes behaviour without moving the
            // hash, exactly like GNOMON_MODEL_URL, so it gets the same treatment.
            console.log(paint(ui, "yellow", `  note: --profile ${prof.name} overrides the surface's role_profile — ` +
                `behaviour changed, surface hash did NOT`));
        }
        else if (prof?.name) {
            console.log(paint(ui, "gray", `  profile: ${prof.name} (from the surface)`));
        }
        // A machine-scoped route must never take effect silently.
        if (process.env.GNOMON_MODEL_URL) {
            console.log(paint(ui, "yellow", `  note: GNOMON_MODEL_URL overrides the surface's endpoint → ${process.env.GNOMON_MODEL_URL}`));
        }
        if (resumedFrom) {
            const ui0 = uiOf(state);
            console.log(paint(ui0, "cyan", `Resumed ${sessionId} — ${state.exchanges.length} turn(s)` +
                (state.summary ? " and a summary" : "")));
            // Behaviour comes from the surface, not the snapshot. If the surface moved,
            // the replayed history was produced under different rules; say so rather
            // than carrying it forward silently.
            if (resumedFrom.surface_hash && surfaceHash && resumedFrom.surface_hash !== surfaceHash) {
                console.log(paint(ui0, "yellow", `  the surface changed since this session ran: ` +
                    `${resumedFrom.surface_hash.slice(0, 12)} → ${surfaceHash.slice(0, 12)}`));
                console.log(paint(ui0, "yellow", `  the replayed history was produced under the older one.`));
            }
            audit.write("session_resume", {
                resumed: sessionId,
                turns: state.exchanges.length,
                surface_hash: surfaceHash,
                surface_hash_at_save: resumedFrom.surface_hash,
                surface_changed: resumedFrom.surface_hash !== surfaceHash,
            });
        }
        if (suppliedKeys.length > 0) {
            console.log(paint(uiOf(state), "gray", `Keys: ${suppliedKeys.join(", ")} supplied from the credential store`));
        }
        if (audit.enabled) {
            console.log(paint(ui, "gray", `Audit: ${audit.path}  (${auditSettings.record}${auditSettings.chain ? ", hash-chained" : ""})`));
            if (auditSettings.invalid_redact.length > 0) {
                // Fails open: whatever these were meant to scrub would be written.
                console.log(paint(ui, "red", `  WARNING: ${auditSettings.invalid_redact.length} redaction pattern(s) do not compile ` +
                    `and are NOT being applied: ${auditSettings.invalid_redact.join(", ")}`));
                if (auditSettings.record === "full") {
                    console.log(paint(ui, "red", "  Recording is set to \"full\", so unredacted text is being written."));
                }
            }
        }
        const policy = config.policy ?? {};
        const sandboxLevel = policy.sandbox?.level ??
            config.config.defaults?.sandbox ??
            "confined";
        const networkDeclared = policy.sandbox?.network;
        if (sandboxLevel !== "off" && networkDeclared === false) {
            console.log(paint(ui, "yellow", "  note: policy.toml declares network = false. It is enforced for " +
                "the `webfetch` tool, which refuses outright. It is NOT process " +
                "isolation: `bash` can still reach the network through curl, a " +
                "package manager, or anything else installed. Constrain that with " +
                "bash_allow if it matters."));
        }
        console.log("");
    }
    try {
        while (true) {
            // Show the prompt only when actually waiting on the user —
            // buffered (typed-ahead) lines replay silently instead.
            if (!closed && lineQueue.length === 0) {
                rl.setPrompt(`${state.currentRole} ▸ `);
                rl.prompt();
            }
            const input = await readLine();
            if (input === null) {
                audit.write("session_end", {
                    turns: state.exchanges.length,
                    surface_hash: surfaceHash,
                });
                console.log("\nSession complete. See you next turn.");
                break;
            }
            // Handle slash commands
            if (input.startsWith("/")) {
                // The session picker waits on keypresses; processCommand is sync.
                if (/^\/sessions?\s*$/.test(input.trim()) && process.stdin.isTTY) {
                    const st = resolveSessionStore(config);
                    const ui0 = uiOf(state);
                    if (!st.persist) {
                        console.log("\nSession persistence is off. Set [session].persist = true in " +
                            ".gnomon/config.toml to keep conversations.");
                        continue;
                    }
                    const entries = listSessions(st);
                    if (entries.length <= 1) {
                        console.log(`\nThis session: ${sessionIdOf(state)} — ${state.exchanges.length} turn(s).`);
                        console.log(`  /new  starts a fresh one; this is the only session so far.`);
                        continue;
                    }
                    picking = true;
                    const chosen = await pickSession(entries, sessionIdOf(state), ui0, rl);
                    picking = false;
                    if (!chosen) {
                        console.log(paint(ui0, "gray", "  (kept this session)"));
                        continue;
                    }
                    if (chosen === sessionIdOf(state)) {
                        console.log(paint(ui0, "gray", "  (already here)"));
                        continue;
                    }
                    try {
                        state.switchSession?.(chosen);
                        const opened = entries.find((e) => e.id === chosen);
                        console.log(`\nOpened ${formatWhen(opened?.updated ?? "")} — ` +
                            `${state.exchanges.length} turn(s) restored` +
                            (opened?.opening ? `: "${opened.opening}"` : ""));
                    }
                    catch (err) {
                        console.log(`\n${err instanceof Error ? err.message : String(err)}`);
                    }
                    continue;
                }
                // /endpoints asks each endpoint to run one token, which is the only
                // question worth asking: a set variable and a reachable URL both
                // reported healthy for a key that inference rejected.
                if (/^\/endpoints\b/.test(input.trim())) {
                    const ui0 = uiOf(state);
                    const rows = describeEndpoints(config);
                    if (/\s--no-probe\b/.test(input)) {
                        printEndpoints(rows, ui0, null);
                        continue;
                    }
                    const testable = rows.filter((r) => r.probeModel);
                    console.log(paint(ui0, "gray", `\n  testing ${testable.length} endpoint${testable.length === 1 ? "" : "s"} with one token each… (--no-probe to skip)`));
                    const probes = new Map();
                    // Ask each endpoint for its model list at the same time as the auth
                    // probe. Both are network calls that answer the two questions a
                    // broken endpoint actually raises -- "will it take my key" and "does
                    // it know the model I named" -- and running them together costs one
                    // round trip rather than two.
                    const [, checks] = await Promise.all([
                        Promise.all(testable.map(async (r) => {
                            probes.set(r.name, await probeEndpointAuth(r.endpoint, r.probeModel ?? "", 15000));
                        })),
                        checkRoleModels(config).catch(() => null),
                    ]);
                    printEndpoints(rows, ui0, probes, checks);
                    continue;
                }
                // /models queries the network, and processCommand is synchronous.
                if (/^\/models\b/.test(input.trim())) {
                    const ui0 = uiOf(state);
                    const listOnly = /\s--list\b/.test(input);
                    console.log(paint(ui0, "gray", "\n  querying endpoints…"));
                    const found = await listModels(config);
                    // Unreachable endpoints are reported, never silently dropped. A
                    // shorter list that does not say what is missing is how a wrong
                    // model tag turns into an opaque API error later.
                    for (const e of found) {
                        if (e.problem) {
                            console.log(`  ${paint(ui0, "bold", e.endpoint)}  ` +
                                paint(ui0, "yellow", `unavailable: ${e.problem}`));
                        }
                        else if (e.models.length === 0) {
                            console.log(`  ${paint(ui0, "bold", e.endpoint)}  ` +
                                paint(ui0, "gray", "(reachable, but offered no models)"));
                        }
                    }
                    const offered = found.filter((e) => !e.problem && e.models.length > 0);
                    if (offered.length === 0) {
                        console.log(paint(ui0, "yellow", "\n  No endpoint offered a model."));
                        continue;
                    }
                    if (listOnly || !process.stdin.isTTY) {
                        for (const e of offered) {
                            console.log(`\n  ${paint(ui0, "bold", e.endpoint)}  ${e.url}`);
                            for (const m of e.models)
                                console.log(`    ${m}`);
                        }
                        continue;
                    }
                    const rolesNow = listRoles(config);
                    const inUse = new Map();
                    for (const r of rolesNow) {
                        const def = config.roles[r];
                        if (def?.model)
                            inUse.set(`${def.endpoint ?? "local"}\u0000${def.model}`, r);
                    }
                    const items = [];
                    for (const e of offered) {
                        const where = isLocalEndpoint(e.url) ? "local" : "cloud";
                        for (const m of e.models) {
                            const key = `${e.endpoint}\u0000${m}`;
                            const held = inUse.get(key);
                            items.push({
                                key,
                                label: m,
                                hint: held ? `${where} @${e.endpoint} · ${held}` : `${where} @${e.endpoint}`,
                                current: Boolean(held),
                            });
                        }
                    }
                    picking = true;
                    const pickedModel = await pickFromList(items, { title: "Choose a model", rows: 12 }, ui0, rl);
                    picking = false;
                    if (!pickedModel) {
                        console.log(paint(ui0, "gray", "  (no change)"));
                        continue;
                    }
                    const [pickedEndpoint, modelTag] = pickedModel.split("\u0000");
                    picking = true;
                    const pickedRole = await pickFromList(rolesNow.map((r) => ({
                        key: r,
                        label: r,
                        hint: `${config.roles[r]?.model ?? "(unset)"} @${config.roles[r]?.endpoint ?? "local"}`,
                        current: r === state.currentRole,
                    })), { title: `Give ${modelTag} to which role?`, rows: 8,
                        start: Math.max(0, rolesNow.indexOf(state.currentRole)) }, ui0, rl);
                    picking = false;
                    if (!pickedRole) {
                        console.log(paint(ui0, "gray", "  (no change)"));
                        continue;
                    }
                    const rolesPath = join(config.gnomonDir, "roles.toml");
                    try {
                        const before = readFileSync(rolesPath, "utf-8");
                        writeFileSync(rolesPath, setRoleModel(before, pickedRole, modelTag, pickedEndpoint), "utf-8");
                    }
                    catch (err) {
                        console.log(paint(ui0, "yellow", `  Could not write roles.toml: ${err instanceof Error ? err.message : String(err)}`));
                        continue;
                    }
                    // roles.toml is part of the surface, so this changed the hash on
                    // purpose. Reload rather than asking for a restart — but say what
                    // moved, because a surface that changes without saying so is the
                    // thing this harness exists to prevent.
                    const projectRoot = resolve(config.gnomonDir, "..");
                    const fresh = loadConfig(projectRoot);
                    state.config = fresh;
                    console.log(`\n  ${paint(ui0, "green", "✓")} ${paint(ui0, "bold", pickedRole)} → ` +
                        `${modelTag} @${pickedEndpoint}`);
                    console.log(paint(ui0, "gray", `  .gnomon/roles.toml written · surface now ` +
                        `${recomputeManifest(fresh.gnomonDir).surface_hash.slice(0, 16)}…`));
                    continue;
                }
                if (processCommand(input, state)) {
                    continue;
                }
                // A role prefix (`/plan do the thing`) is a real turn. Anything else
                // starting with "/" is a mistyped command: sending it to the model
                // burned a slow turn on a typo like "/helpo".
                const roleNames = listRoles(config);
                const isRoleTurn = roleNames.some((r) => input.startsWith(`/${r} `));
                if (!isRoleTurn) {
                    const typed = input.slice(1).split(/\s+/)[0];
                    const known = [
                        "help", "roles", "role", "profiles", "context", "reset",
                        "meta", "think", "manifest", "clear", "quit",
                        "explain", "reflect", "models", "tools", "endpoints",
                        "skills", "session", "mode",
                    ];
                    const near = known.filter((k) => k.startsWith(typed.slice(0, 3)) || typed.startsWith(k.slice(0, 3)));
                    const ui0 = uiOf(state);
                    console.log(paint(ui0, "yellow", `\nUnknown command: /${typed}`) +
                        (near.length ? paint(ui0, "gray", `  did you mean /${near.join(", /")} ?`) : ""));
                    console.log(paint(ui0, "gray", "/help lists everything."));
                    console.log(paint(ui0, "gray", `To send this to the model, drop the leading slash.`));
                    continue;
                }
            }
            // A role prefix routes THIS turn only. It used to overwrite
            // state.currentRole, so one `/smol ...` silently pinned every later
            // turn to smol with no way back — use /role to switch for real.
            let role = state.currentRole;
            let cleanedInput = input;
            let prefixed = false;
            for (const candidate of listRoles(config)) {
                const prefix = `/${candidate} `;
                if (input.startsWith(prefix)) {
                    role = candidate;
                    cleanedInput = input.slice(prefix.length);
                    prefixed = true;
                    break;
                }
            }
            const uiEarly = uiOf(state);
            const routing = routingOf(state);
            // The surface's rules choose in auto, propose in suggest. An explicit
            // prefix always wins in either: asking for a role and being overruled
            // would be worse than not having the mode at all.
            if (routing.mode !== "manual" && !prefixed) {
                const decision = routeInput(config, cleanedInput, routing);
                if (decision.problem) {
                    console.log(paint(uiEarly, "yellow", `  [routing] ${decision.problem}`));
                }
                const why = decision.rule
                    ? decision.rule.why ?? decision.rule.match
                    : "no rule matched — the default";
                if (decision.role !== role) {
                    if (routing.mode === "auto") {
                        console.log(paint(uiEarly, "cyan", `  ⇢ auto: ${role} → ${decision.role}`) +
                            paint(uiEarly, "gray", `  (${why})`));
                        role = decision.role;
                    }
                    else {
                        // suggest: ask. A non-TTY has nobody to ask, so it keeps the
                        // current role and says what it would have proposed — a scripted
                        // run must not depend on an answer nobody can give.
                        if (!process.stdin.isTTY) {
                            console.log(paint(uiEarly, "gray", `  ⇢ would suggest ${decision.role} (${why}) — not interactive, staying on ${role}`));
                        }
                        else {
                            const accepted = await suggestRole(role, decision.role, why);
                            if (accepted === "once") {
                                role = decision.role;
                            }
                            else if (accepted === "always") {
                                role = decision.role;
                                state.currentRole = decision.role;
                                console.log(paint(uiEarly, "gray", `  session role is now ${decision.role}`));
                            }
                        }
                    }
                }
            }
            const route = routeRole(config, role);
            const ui = uiOf(state);
            // Skills that apply to this role and input join the system prompt.
            // Selection is by declared pattern, not model judgement, so the same
            // input loads the same skills on every machine.
            const active = selectSkills(loadSkills(config), role, cleanedInput);
            if (active.length > 0) {
                console.log(paint(uiEarly, "gray", `  [skills] ${active.map((sk) => sk.name).join(", ")}`));
            }
            const systemPrompt = buildSystemPrompt(state, role, cleanedInput);
            // Build the window from prior turns before calling.
            const built = buildMessages(state, systemPrompt, cleanedInput);
            if (built.notice) {
                console.log(paint(ui, "yellow", `  [context] ${built.notice}`));
            }
            if (built.dropped > 0) {
                console.log(paint(ui, "gray", `  [context] ${built.dropped} earlier turn(s) did not fit the window`));
            }
            // Run the turn: model, tools, approvals, until it answers in prose.
            const progress = new Progress(ui);
            activeProgress = progress;
            const carried = built.included > 0 ? ` · ${built.included} turn(s) of context` : "";
            progress.start(state.exchanges.length === 0
                ? `${route.model} — loading model${carried}`
                : `${route.model}${carried}`);
            // Scope check: a standing approval given for one turn ends with it.
            approveRestOfTurn = false;
            menu.clear();
            const start = Date.now();
            const controller = new AbortController();
            cancelTurn = () => controller.abort();
            // A declared chain shapes the turn here exactly as it does in
            // `gnomon task`. It was wired into runTask only, so a surface declaring
            // [chain] got three stages from `gnomon task` and one role from
            // `gnomon prompt` -- the same surface, the same hash, different behaviour
            // depending on the entry point. That is precisely the bug fixed for MCP
            // one release earlier, and it belongs to the entry point that an operator
            // actually spends their day in.
            //
            // An explicit /role prefix has already set `state.currentRole` for this
            // turn, and it wins here too: asking for one role and silently getting
            // three would be worse than having no chain.
            const turnChain = prefixed ? [] : resolveChain(config);
            let turn;
            try {
                if (turnChain.length >= 2) {
                    let carriedAnswer = "";
                    let last = null;
                    for (let i = 0; i < turnChain.length; i++) {
                        const stageRole = turnChain[i];
                        const stageRoute = routeRole(config, stageRole);
                        const stageInput = carriedAnswer
                            ? `${cleanedInput}\n\n---\nThe previous stage (${turnChain[i - 1]}) reported:\n${carriedAnswer}`
                            : cleanedInput;
                        // The stage sees the conversation so far plus its own instruction;
                        // it does NOT see the previous stage's tool calls, only what that
                        // stage reported. Same contract as runTask and the `task` tool.
                        const stageState = { ...state, currentRole: stageRole };
                        const stageBuilt = buildMessages(stageState, buildSystemPrompt(stageState, stageRole, stageInput), stageInput);
                        progress.print(paint(ui, "gray", `  [chain] stage ${i + 1}/${turnChain.length} — ${stageRole}`));
                        const r = await runAgenticTurn(stageState, stageRole, stageRoute, stageBuilt.messages, {
                            approve,
                            progress,
                            ui,
                            say: (l) => progress.print(l),
                            signal: controller.signal,
                            audit,
                            standingApproval: () => approveRestOfSession || approveRestOfTurn,
                        });
                        audit?.write("chain_stage", {
                            stage: i + 1,
                            of: turnChain.length,
                            role: stageRole,
                            bucket: mapBucket(r.code),
                            code: r.code,
                            stop_reason: r.stop_reason,
                            tool_steps: r.toolSteps,
                        });
                        last = r;
                        carriedAnswer = r.content;
                        // A dead endpoint is not an answer to hand onward, and Esc must
                        // stop the whole chain rather than only the stage in flight.
                        if (r.code === 10 || r.code === 12 || r.code === 13)
                            break;
                        if (controller.signal.aborted)
                            break;
                        const stop = chainStop(resolveChainGate(config), r);
                        if (stop) {
                            progress.print(paint(ui, "yellow", `  [chain] stopped after stage ${i + 1}/${turnChain.length} (${stageRole}) — ${stop}`));
                            audit?.write("chain_stage", {
                                stage: i + 1,
                                of: turnChain.length,
                                role: stageRole,
                                stopped_by: stop,
                                gate: resolveChainGate(config),
                            });
                            break;
                        }
                    }
                    turn = last;
                }
                else {
                    turn = await runAgenticTurn(state, role, route, built.messages, {
                        approve,
                        progress,
                        ui,
                        // Through the spinner, which clears its frame first and redraws
                        // after. console.log wrote straight onto the live row, so a turn
                        // that explained itself opened with the spinner spliced into the
                        // text.
                        say: (line) => progress.print(line),
                        signal: controller.signal,
                        audit,
                        standingApproval: () => approveRestOfSession || approveRestOfTurn,
                    });
                }
            }
            finally {
                cancelTurn = null;
            }
            progress.stop();
            activeProgress = null;
            // What the turn actually did to the tree, measured. Printed rather than
            // left in the record, because the failure this catches is a turn that
            // SAYS "31 insertions" over a 2,492-line diff and is believed — an
            // external review of a real audit run found three errors of exactly that
            // shape and none in the code analysis itself.
            // Citations are checked inside the turn (see runAgenticTurn), so the
            // one-shot `gnomon task --json` record carries them too -- that is the
            // scripted path, and a record is exactly where a measured fact belongs.
            // This only renders them.
            const cites = turn.counters.citations;
            if (cites && cites.broken > 0) {
                progress.print(paint(ui, "yellow", `  [cites] ${cites.broken} of ${cites.checked} citation(s) in that answer do not land — ` +
                    `re-read before trusting them`));
            }
            else if (cites && cites.checked > 0) {
                progress.print(paint(ui, "gray", `  [cites] ${cites.ok}/${cites.checked} citation(s) check out`));
            }
            const td = turn.counters.tree_delta;
            if (td && !td.unavailable && td.files > 0) {
                progress.print(paint(ui, "gray", `  [tree] ${td.files} file(s), +${td.insertions} −${td.deletions} (measured, git)`));
                if (td.crlf_only > 0) {
                    progress.print(paint(ui, "yellow", `  [tree] ${td.crlf_only} of those changed ONLY line endings — that is churn, not work. ` +
                        `A .gitattributes with * text=auto is the one-file fix.`));
                }
            }
            // The surface moved during that turn — reload, so the session actually
            // runs under the rules it just wrote.
            //
            // Until now nothing did. The write tool printed "the next turn runs under
            // the new rules" and the session went on using the config it loaded at
            // startup: a user changed the plan role's model, watched that line, then
            // saw /role report the old model, three times, across two sessions.
            // `/models` already reloads after writing roles.toml, so the capability
            // existed and only this path did not use it.
            //
            // Said out loud, with both hashes. A surface that changes silently is the
            // thing this harness exists to prevent, and that applies to a change the
            // harness itself made.
            if (turn.surface_changed && turn.surface_changed.length > 0) {
                for (const d of turn.surface_changed) {
                    progress.print(paint(ui, "yellow", `  surface moved: ${d.notice}`));
                }
                try {
                    const reloaded = loadConfig(resolve(state.config.gnomonDir, ".."));
                    state.config = reloaded;
                    const short = recomputeManifest(reloaded.gnomonDir).surface_hash.slice(0, 16);
                    progress.print(paint(ui, "green", `  ✓ surface reloaded — now ${short}… · this session runs under it from the next turn`));
                    // Roles, models and endpoints all come from the surface, so say what
                    // the current role resolves to NOW. That is the line the user was
                    // looking for and did not get.
                    const rt = routeRole(reloaded, state.currentRole);
                    progress.print(paint(ui, "gray", `    ${state.currentRole} → ${rt.target.model} @${rt.target.endpoint ?? "local"}`));
                }
                catch (err) {
                    progress.print(paint(ui, "red", `  ✗ the surface moved but could not be reloaded: ` +
                        `${err instanceof Error ? err.message : String(err)}\n` +
                        `    This session is still running the previous surface. Restart to pick it up.`));
                }
            }
            const duration = Date.now() - start;
            if (turn.content === CANCELLED) {
                console.log(paint(ui, "yellow", "  ⚠ cancelled"));
            }
            const exchange = {
                turn: state.exchanges.length + 1,
                role,
                input: cleanedInput,
                output: turn.content,
                model: turn.model,
                code: turn.code,
                bucket: mapBucket(turn.code),
                duration_ms: duration,
                context_turns: built.included,
                context_dropped: built.dropped,
                context_tokens: built.tokens,
                tool_steps: turn.toolSteps,
                tool_log: turn.toolLog,
                usage: turn.usage,
                stop_reason: turn.stop_reason,
                stop_detail: turn.stop_detail,
                counters: turn.counters,
            };
            state.exchanges.push(exchange);
            persist();
            audit.write("turn", {
                turn: exchange.turn,
                role,
                model: exchange.model,
                endpoint: turn.endpoint ?? route.target.endpoint,
                // The NAME alone cannot answer "where did this actually go?".
                // GNOMON_MODEL_URL replaces the declared url at resolve time, so two
                // runs with the same surface hash and the same endpoint name can reach
                // different servers, and nothing in the trail distinguishes them. The
                // loop announces the override on the console; a console line is not a
                // record. DESIGN.md's claim is "if behaviour changed, the hash changed"
                // -- this is the one path where behaviour changes and it does not, so
                // the resolved destination has to be written down instead.
                endpoint_url: turn.endpoint_url ?? route.target.url,
                endpoint_overridden: process.env.GNOMON_MODEL_URL ? true : undefined,
                bucket: exchange.bucket,
                code: exchange.code,
                duration_ms: duration,
                tool_steps: exchange.tool_steps,
                tool_log: exchange.tool_log,
                skills: active.map((sk) => sk.id),
                context_turns: built.included,
                context_dropped: built.dropped,
                context_tokens: built.tokens,
                // What the turn actually SPENT, as the backend reported it — distinct
                // from context_tokens, which is this harness's own estimate of the
                // window it sent. Without it the audit trail can say what a run did but
                // not what it cost, and a token-efficiency claim has to be taken on
                // trust. Undefined when the backend reports no usage, because a
                // confident 0 is worse than a blank.
                usage: exchange.usage,
                stop_reason: exchange.stop_reason,
                stop_detail: exchange.stop_detail,
                counters: exchange.counters,
                surface_hash: surfaceHash,
                input: audit.text(cleanedInput),
                output: audit.text(turn.content),
            });
            printExchange(exchange, ui);
            // Fold anything the window has shed. After the turn, not during it, so
            // the cost lands between turns rather than inside one.
            const compacted = await compactSession(state, systemPrompt, (line) => console.log(paint(ui, "gray", `  [context] ${line}`)));
            if (compacted.problem) {
                console.log(paint(ui, "yellow", `  [context] ${compacted.problem}`));
            }
            else if (compacted.folded > 0) {
                console.log(paint(ui, "gray", `  [context] folded ${compacted.folded} turn(s), reclaimed ~${compacted.reclaimed} tok`));
                // The summary and the folded flags are part of the conversation now.
                persist();
            }
        }
    }
    finally {
        // Both of these, on every exit path. MCP servers are child processes, and
        // an un-killed child keeps node's event loop alive with nothing left to
        // run -- so `gnomon prompt` on a surface declaring one never came back
        // from /quit. The loop had exited; the terminal was simply hung, with no
        // output to say why, and each hung session left another orphaned server
        // behind. Closing on readline's "close" event was not enough: that event
        // does not fire on this path, and cleanup that depends on which way the
        // user left is cleanup that will be missed.
        state.mcp?.close();
        state.mcp = undefined;
        rl.close();
    }
}
//# sourceMappingURL=prompt_loop.js.map
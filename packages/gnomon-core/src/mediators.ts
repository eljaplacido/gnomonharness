/**
 * The per-call mediator record: what each model request carried, and what came
 * back, so a run's outcome can be traced to a mechanism rather than only to a
 * solve rate (docs/CONTRACTS.md §29).
 *
 * Why. The causal analysis of 2026-11-04 (benchmarks/results/causal-2026-11/
 * REPORT.md, "where gnomon's own instrumentation blocked identification")
 * refused the hosted lane throughout, because the mechanisms between a setting
 * and a timeout were in none of gnomon's records:
 *   - trims: no record of one; the turn record's `context_*` fields describe
 *     inter-turn history and read 0 in all 450 task turn records;
 *   - reasoning: the turn record kept `tokens_out` only -- not the reasoning
 *     tokens per call, nor whether reasoning was replayed;
 *   - steering: whether a nudge or a convergence push was sent, and in which
 *     role, per call;
 *   - the estimate: gnomon budgets with ~4 characters a token, and the
 *     provider counted more than the 65,536 window on 85 of 156 calls of C2D.
 *
 * Observation only. Nothing in the loop reads this record back to decide
 * anything, with one opt-in exception: `[context] token_estimate =
 * "calibrated"` reads the running ratio kept here to size the turn's trims.
 * Under the default, "chars4", that ratio is never consulted and the request
 * bodies are byte-identical to the ones sent before this file existed
 * (mediator_record.test.ts pins them to a hash taken on master).
 */
import { isLocalEndpoint, type RouteTarget, type TokenEstimate } from "./config.js";

/**
 * Which of gnomon's own mid-turn system messages a request carried. `nudge`:
 * the idle nudge. `converge`: the convergence push. `other`: the rest -- a
 * trim's ledger, a failed check handed back, the wrap-up, a context notice.
 */
export type SteerKind = "nudge" | "converge" | "other";

/**
 * Why the working context was trimmed. `leg`: the leg checkpoint, every
 * `max_steps` calls, to 60% of the window. `overflow`: the provider refused
 * the request as too long (code 13) and gnomon trimmed to 50% and sent it
 * again. There is no per-request window check: between two checkpoints a
 * request can grow past the window, and `prompt_tokens` against `window` in
 * this record is where that shows.
 */
export type TrimWhy = "leg" | "overflow";

/** A trim, recorded on the first request after it. Tokens are gnomon's estimate. */
export interface TrimRecord {
  why: TrimWhy;
  /** Messages the trim dropped */
  dropped: number;
  /** The working context's estimate before and after */
  before: number;
  after: number;
  /** What it was trimmed to, in the estimate's units */
  budget: number;
  /** The calibrated ratio the budget was divided by; only under "calibrated" */
  ratio?: number;
}

/**
 * One request as gnomon built it. Everything here follows from the messages
 * and the surface, so it belongs outside `volatile`.
 */
export interface CallSent {
  /** 1-based, per turn: every request that went out, retries and resends included */
  i: number;
  /** gnomon's estimate of the messages' text, the number its trims budget against */
  est: number;
  /** The same estimate over the whole request body: tool schemas, tool calls, replayed reasoning, JSON */
  est_body: number;
  /** Assistant messages whose reasoning went back as reasoning_content */
  replayed?: number;
  /** gnomon's mid-turn system messages present in the request, by kind */
  steer?: Partial<Record<SteerKind, number>>;
  /** The role they went out in: `user` under steer_role = "user" */
  via?: "system" | "user";
  /**
   * Beside `via`: whether that channel is one the model is known to read.
   * True for user content, and for a late system message to a remote
   * endpoint; false for a late system message to a local lane, whose chat
   * template dropped every one on the three M2 lanes (2026-11, research note
   * 04 §0.6). gnomon cannot see the template, so false means "not known to
   * arrive", not "proved dropped". See deliveredOn.
   */
  delivered?: boolean;
  /** A trim made since the request before */
  trim?: TrimRecord;
  /** The turn's leg, from 2 on */
  leg?: number;
  /** 1 for a request a delegated sub-turn (the `task` tool) made */
  depth?: number;
  /** The window this request's target declares, when it is not the turn's */
  window?: number;
}

/**
 * What came back for one request. The backend's measurement and the clock, so
 * it lives under `volatile` beside `tokens_in`.
 */
export interface CallReceived {
  i: number;
  /** 0, or the exit-contract code the request failed with (11 timed out, 12 unreachable, 13 too long, ...) */
  code: number;
  /** Wall time of the request */
  ms: number;
  /** For a streamed reply, when the first byte came */
  first_byte_ms?: number;
  /** As the provider reported them; absent when it reported none */
  prompt_tokens?: number;
  cached_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  /** Characters of reasoning the reply carried (reasoning_content or reasoning) */
  reasoning_chars?: number;
  finish?: string;
}

/** One of gnomon's mid-turn messages, as it first went out. */
export interface SteerMessageRecord {
  /** The request that first carried it */
  i: number;
  kind: SteerKind;
  via: "system" | "user";
  delivered: boolean;
}

/**
 * Whether a mid-turn message sent on `via` to `url` is known to reach the
 * model: user content always; a late system message only off a local lane
 * (endpointLocality). Hosted APIs read late system messages (the half-time
 * deadline note changed answers on hosted DeepSeek, FG1); the M2 local
 * templates dropped all of them.
 */
export function deliveredOn(via: "system" | "user", url: string): boolean {
  return via === "user" || !isLocalEndpoint(url);
}

/** `counters.model_calls`: the requests a turn sent. */
export interface ModelCallsRecord {
  v: 1;
  /** Requests made: every one that went out, retries and resends included */
  count: number;
  /** The context window the turn's trims are sized against */
  window: number;
  /** What a leg checkpoint trims the working context to: 60% of the window, at least 1024 */
  budget: number;
  estimate: TokenEstimate;
  /** The largest request, by `est` */
  est_max: number;
  /** Requests that carried replayed reasoning */
  replayed_calls: number;
  /** Requests that carried at least one message of each steering kind */
  steered_calls: Record<SteerKind, number>;
  /**
   * Each of gnomon's mid-turn messages once, on the first request that
   * carried it: its kind, the channel, and whether that channel is known to
   * reach the model (CallSent.delivered). Present once there is one; the
   * last MAX_CALL_ENTRIES are kept.
   */
  steer_messages?: SteerMessageRecord[];
  trims: { leg: number; overflow: number; dropped: number };
  /** `i` of `calls[0]`, when the oldest entries were let go */
  first?: number;
  /** The last 512 requests */
  calls: CallSent[];
}

/** `volatile.model_calls`: what came back. */
export interface ModelCallsMeasured {
  /** Requests whose reply reported usage */
  metered: number;
  prompt_tokens?: number;
  cached_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  reasoning_chars: number;
  /** The largest provider prompt_tokens */
  prompt_max?: number;
  /** Requests whose provider prompt_tokens exceeded their window */
  over_window: number;
  /** Provider prompt_tokens over gnomon's `est`, summed over the metered requests */
  ratio?: number;
  first?: number;
  calls: CallReceived[];
}

/** One request, as callEndpoint saw it. */
export interface CallObservation {
  target: RouteTarget;
  messages: ReadonlyArray<{ role: string; content: string; reasoning_content?: string }>;
  /** gnomon's estimate of the whole request body; undefined when nothing was sent */
  bodyEst?: number;
  code: number;
  ms: number;
  firstByteMs?: number;
  usage?: { input?: number; output?: number };
  detail?: UsageDetail;
  reasoningChars?: number;
  finishReason?: string;
}

/** Told about each request callEndpoint makes. Must not throw; its result is ignored. */
export type CallObserver = (o: CallObservation) => void;

/** Token counts a provider reports beside prompt_tokens and completion_tokens. */
export interface UsageDetail {
  cached?: number;
  reasoning?: number;
}

/**
 * Cached prompt tokens and reasoning tokens, from a response or a stream's
 * usage chunk. OpenAI: `prompt_tokens_details.cached_tokens`,
 * `completion_tokens_details.reasoning_tokens`. DeepSeek reports the cache as
 * `prompt_cache_hit_tokens`. Undefined when neither is there.
 */
export function readUsageDetail(json: unknown): UsageDetail | undefined {
  const u = (json as { usage?: Record<string, any> } | null)?.usage;
  if (!u || typeof u !== "object") return undefined;
  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : undefined);
  const cached = num(u.prompt_tokens_details?.cached_tokens) ?? num(u.prompt_cache_hit_tokens);
  const reasoning = num(u.completion_tokens_details?.reasoning_tokens);
  if (cached === undefined && reasoning === undefined) return undefined;
  return { ...(cached !== undefined ? { cached } : {}), ...(reasoning !== undefined ? { reasoning } : {}) };
}

/** Entries kept per list. A 900-second capped run makes about 150 requests. */
export const MAX_CALL_ENTRIES = 512;

/** The calibrated ratio is held inside these bounds, so one odd report cannot empty or unbound a window. */
export const RATIO_MIN = 0.5;
export const RATIO_MAX = 4;

/** Provider prompt tokens against gnomon's estimate, per endpoint+model, for a session. */
export type TokenCalibration = Map<string, { prompt: number; est: number; calls: number }>;

export interface CallLedgerOptions {
  /** gnomon's estimate of a string: estimateTokens */
  estimate: (text: string) => number;
  /** The window of a target: resolveContext(config, target).max_context_tokens */
  windowOf: (target: RouteTarget) => number;
  /** The target the turn starts on */
  target: RouteTarget;
  mode: TokenEstimate;
  /** The session's running ratios. Read and updated only under "calibrated". */
  calibration?: TokenCalibration;
  /** Writes one `model_call` audit record. Absent when there is no trail. */
  audit?: (fields: Record<string, unknown>) => void;
  /** Stamped on each `model_call` record */
  role?: string;
  cap?: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The record of one turn's requests. Created by runAgenticTurn at depth 0 and
 * shared with the sub-turns it delegates, whose requests are entries with
 * `depth: 1`.
 */
export class CallLedger {
  /** Assigned to `counters.model_calls`, and kept current as requests go out. */
  readonly sent: ModelCallsRecord;
  private readonly recv: ModelCallsMeasured;
  private readonly tags = new WeakMap<object, SteerKind>();
  private readonly pending = new WeakMap<object, TrimRecord>();
  /** Mid-turn messages already listed in `steer_messages` */
  private readonly steerSeen = new WeakSet<object>();
  private promptSum = 0;
  private estSum = 0;
  private readonly cap: number;

  constructor(private readonly opts: CallLedgerOptions) {
    this.cap = opts.cap ?? MAX_CALL_ENTRIES;
    const window = opts.windowOf(opts.target);
    this.sent = {
      v: 1,
      count: 0,
      window,
      budget: legBudget(window),
      estimate: opts.mode,
      est_max: 0,
      replayed_calls: 0,
      steered_calls: { nudge: 0, converge: 0, other: 0 },
      trims: { leg: 0, overflow: 0, dropped: 0 },
      calls: [],
    };
    this.recv = { metered: 0, reasoning_chars: 0, over_window: 0, calls: [] };
  }

  /** Mark one of gnomon's mid-turn messages with its kind. Returns it, for `push(tag(...))`. */
  tag<M extends object>(message: M, kind: SteerKind): M {
    this.tags.set(message, kind);
    return message;
  }

  /** A trim of `working`; recorded on the next request that sends that list. */
  trimmed(working: object, t: TrimRecord): void {
    this.pending.set(working, t);
    this.sent.trims[t.why]++;
    this.sent.trims.dropped += t.dropped;
  }

  /**
   * The budget a trim of `target`'s context uses, in the estimate's units.
   * Under "chars4" the budget as given, always. Under "calibrated", divided
   * by the session's running ratio for that endpoint and model once one
   * request there has reported usage.
   */
  trimBudget(budget: number, target: RouteTarget): { budget: number; ratio?: number } {
    if (this.opts.mode !== "calibrated") return { budget };
    const ratio = this.ratioFor(target);
    if (ratio === undefined) return { budget };
    return { budget: Math.max(1, Math.floor(budget / ratio)), ratio };
  }

  /** The session's running ratio for a target, bounded; undefined before any metered request. */
  ratioFor(target: RouteTarget): number | undefined {
    const c = this.opts.calibration?.get(calibrationKey(target));
    if (!c || c.calls === 0 || c.est <= 0) return undefined;
    return round3(Math.min(RATIO_MAX, Math.max(RATIO_MIN, c.prompt / c.est)));
  }

  /** What came back, for `volatile.model_calls`; undefined before any request. */
  measured(): ModelCallsMeasured | undefined {
    return this.sent.count > 0 ? this.recv : undefined;
  }

  /** The observer for one turn's requests: `depth` 1 for a sub-turn, `leg` read at each request. */
  observer(turn: { depth: number; leg: () => number }): CallObserver {
    return (o) => {
      try {
        this.observe(o, turn.depth, turn.leg());
      } catch {
        // A record that cannot be kept must not cost the call it describes.
      }
    };
  }

  private observe(o: CallObservation, depth: number, leg: number): void {
    // Nothing went out (a declared key unset): not a request.
    if (o.bodyEst === undefined) return;
    const { estimate } = this.opts;
    const s = this.sent;
    const i = ++s.count;

    let est = 0;
    for (const m of o.messages) est += estimate(m.content);
    // Sent only to an OpenAI-shaped endpoint with replay on -- declared, or
    // on by default once it answered a tool call with reasoning
    // (callEndpoint's wire filter, on the adapted target): counted only there.
    const carries = (o.target.kind ?? "ollama") !== "ollama" && o.target.replayReasoning === true;
    let replayed = 0;
    let lead = 0;
    while (lead < o.messages.length && o.messages[lead]!.role === "system") lead++;
    const steer: Record<SteerKind, number> = { nudge: 0, converge: 0, other: 0 };
    const via = o.target.steerRole === "user" ? ("user" as const) : ("system" as const);
    const delivered = deliveredOn(via, o.target.url);
    for (let k = 0; k < o.messages.length; k++) {
      const m = o.messages[k]!;
      if (carries && m.role === "assistant" && typeof m.reasoning_content === "string" && m.reasoning_content !== "") replayed++;
      if (k >= lead && m.role === "system") {
        const kind = this.tags.get(m) ?? "other";
        steer[kind]++;
        if (!this.steerSeen.has(m)) {
          this.steerSeen.add(m);
          push((s.steer_messages ??= []), { i, kind, via, delivered }, this.cap);
        }
      }
    }
    const steered = steer.nudge + steer.converge + steer.other > 0;
    const trim = this.pending.get(o.messages);
    if (trim) this.pending.delete(o.messages);
    const window = this.opts.windowOf(o.target);

    const entry: CallSent = {
      i,
      est,
      est_body: o.bodyEst,
      ...(replayed > 0 ? { replayed } : {}),
      ...(steered
        ? {
            steer: Object.fromEntries(Object.entries(steer).filter(([, n]) => n > 0)) as Partial<Record<SteerKind, number>>,
            via,
            delivered,
          }
        : {}),
      ...(trim ? { trim } : {}),
      ...(leg > 1 ? { leg } : {}),
      ...(depth > 0 ? { depth } : {}),
      ...(window !== s.window ? { window } : {}),
    };
    s.est_max = Math.max(s.est_max, est);
    if (replayed > 0) s.replayed_calls++;
    for (const kind of ["nudge", "converge", "other"] as const) if (steer[kind] > 0) s.steered_calls[kind]++;
    push(s.calls, entry, this.cap);
    if (s.calls[0]!.i > 1) s.first = s.calls[0]!.i;

    const r = this.recv;
    const prompt = o.usage?.input;
    const got: CallReceived = {
      i,
      code: o.code,
      ms: o.ms,
      ...(o.firstByteMs !== undefined ? { first_byte_ms: o.firstByteMs } : {}),
      ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
      ...(o.detail?.cached !== undefined ? { cached_tokens: o.detail.cached } : {}),
      ...(o.usage?.output !== undefined ? { completion_tokens: o.usage.output } : {}),
      ...(o.detail?.reasoning !== undefined ? { reasoning_tokens: o.detail.reasoning } : {}),
      ...(o.reasoningChars ? { reasoning_chars: o.reasoningChars } : {}),
      ...(o.finishReason ? { finish: o.finishReason } : {}),
    };
    if (o.usage && (o.usage.input !== undefined || o.usage.output !== undefined)) r.metered++;
    const add = (key: "prompt_tokens" | "cached_tokens" | "completion_tokens" | "reasoning_tokens", v?: number) => {
      if (v !== undefined) r[key] = (r[key] ?? 0) + v;
    };
    add("prompt_tokens", prompt);
    add("cached_tokens", o.detail?.cached);
    add("completion_tokens", o.usage?.output);
    add("reasoning_tokens", o.detail?.reasoning);
    r.reasoning_chars += o.reasoningChars ?? 0;
    if (prompt !== undefined) {
      r.prompt_max = Math.max(r.prompt_max ?? 0, prompt);
      if (prompt > window) r.over_window++;
      if (est > 0) {
        this.promptSum += prompt;
        this.estSum += est;
        r.ratio = round3(this.promptSum / this.estSum);
        if (this.opts.mode === "calibrated" && this.opts.calibration) {
          const key = calibrationKey(o.target);
          const c = this.opts.calibration.get(key) ?? { prompt: 0, est: 0, calls: 0 };
          this.opts.calibration.set(key, { prompt: c.prompt + prompt, est: c.est + est, calls: c.calls + 1 });
        }
      }
    }
    push(r.calls, got, this.cap);
    if (r.calls[0]!.i > 1) r.first = r.calls[0]!.i;

    // The trail's copy: one record per request, the two halves joined.
    if (this.opts.audit) {
      const { i: _sent, ...carried } = entry;
      const { i: _got, ...came } = got;
      this.opts.audit({
        i,
        ...(this.opts.role ? { role: this.opts.role } : {}),
        model: o.target.model,
        ...(o.target.endpoint ? { endpoint: o.target.endpoint } : {}),
        estimate: this.opts.mode,
        ...carried,
        window,
        ...came,
        ...(this.opts.mode === "calibrated" ? { ratio: this.ratioFor(o.target) } : {}),
      });
    }
  }
}

/** What a leg checkpoint trims to: 60% of the window, at least 1024. The loop's own rule. */
export function legBudget(window: number): number {
  return Math.max(1024, Math.floor(window * 0.6));
}

/** What an overflow trims to: 50% of the window, at least 1024. The loop's own rule. */
export function overflowBudget(window: number): number {
  return Math.max(1024, Math.floor(window * 0.5));
}

function calibrationKey(target: RouteTarget): string {
  return `${target.url}|${target.model}`;
}

function push<T>(list: T[], item: T, cap: number): void {
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
}

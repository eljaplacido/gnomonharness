/**
 * gnomon-core: the live record -- a turn's record kept on disk while it runs
 *
 * `gnomon task --json` printed its record when the process exited normally,
 * and the interactive loop wrote its `turn` audit record when a turn ended.
 * A process killed mid-turn left neither. A benchmark's time cap does exactly
 * that: Harbor and Terminal-Bench send SIGTERM, then SIGKILL. In P2G attempt 1,
 * 19 of 21 capped gnomon cells left no gnomon-side record, and in M2
 * (2026-11-04) 20 capped cells had none, so the collector's checks read FAIL
 * on runs whose wire was correct (C5). The audit trail was appended per event;
 * the record was not.
 *
 * So, when `[audit]` is on, the record is kept beside the trail as the turn
 * runs, at `<audit dir>/<session>.record.json`:
 *
 * - **partial** (`record_state: "partial"`, `stop_reason: "in_progress"`):
 *   written when the turn starts and rewritten after each model reply and each
 *   tool call. What a SIGKILL leaves: the steps up to the last one finished.
 * - **final** (`record_state: "final"`): the turn ended, normally, or because
 *   SIGTERM, SIGINT or SIGHUP arrived (`stop_reason: "killed"`,
 *   `stop_detail.signal`). The caller then appends a `turn` audit record and
 *   `session_end`, and lets the signal end the process as it would have.
 *
 * What it must never do is change the turn. It is told, never asked: the turn
 * hands it a reader at the start, it reads the state at each step and copies
 * it, and nothing it does reaches the messages. A write that fails is dropped
 * -- a record that could not be kept must not stop the work it records.
 *
 * Each write is a temp file and a rename, so a reader (or a copy loop like the
 * benchmark adapter's) never sees half a record. There is no fsync: the file
 * outlives the process, not a power cut, and a per-step fsync would cost more
 * than the step's bookkeeping.
 *
 * The file is one line of JSON. The record guard (record_guard.ts) treats it as
 * gnomon's own record: written through `beforeOwnWrite`/`noteOwnWrite`, so a
 * change by anything else is tampering, and left by a killed session it counts
 * as part of that session's trail.
 */

import { writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeOwnWrite, noteOwnWrite } from "./record_guard.js";
import type { TaskRecord, TurnCounters, TokenUsage, WireRecord } from "./prompt_loop.js";
import type { ModelCallsMeasured } from "./mediators.js";
import type { TrustOutcome } from "./trust.js";

/** `<session>` + this, in the audit directory. */
export const LIVE_RECORD_SUFFIX = ".record.json";
/** The temp file a write goes through before its rename. */
export const LIVE_RECORD_TEMP_SUFFIX = ".record.json.tmp";

/** Whether a record can still change. Published (docs/CONTRACTS.md §28). */
export const RECORD_STATES = ["partial", "final"] as const;
export type RecordState = (typeof RECORD_STATES)[number];

/** The signals a run flushes its record on. SIGKILL cannot be caught. */
export const KILL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type KillSignal = (typeof KILL_SIGNALS)[number];

/**
 * The native code of a partial or killed record: 11, `timed_out`, in the
 * `apparatus_failure` bucket. Neither is a result, and nobody refused
 * anything: the turn did not end, it was ended (or has not ended yet). A
 * reader that ignores `record_state` still does not read a pass.
 */
export const UNFINISHED_CODE = 11;

/** The turn as it stands, read by the live record at each step. */
export interface TurnSoFar {
  role: string;
  model: string;
  endpoint?: string;
  endpoint_url?: string;
  wire?: WireRecord;
  toolSteps: number;
  toolLog: string[];
  usage?: TokenUsage;
  counters: TurnCounters;
  /**
   * What came back per model request so far (docs/CONTRACTS.md §29), as the
   * final record's `volatile.model_calls` holds it. Without it a killed run's
   * record had the requests' count and token totals and no per-call timing,
   * usage or reasoning: in P2G41 all 29 capped cells left only this record.
   */
  modelCalls?: ModelCallsMeasured;
}

/**
 * What `runAgenticTurn` is given (TurnDeps.live), at depth 0 only: a delegated
 * sub-turn is part of its parent's call.
 */
export interface TurnLive {
  /** Called once when the turn starts: how to read it as it stands. */
  attach(read: () => TurnSoFar): void;
  /** A model reply or a tool call finished. */
  step(): void;
}

/** What a record knows before the turn runs. */
export interface OpenTurn {
  /** 1 for `gnomon task`; the turn's number in a session */
  turn: number;
  surface_hash: string;
  harness: string;
  trust?: TrustOutcome;
  surface_problems?: TaskRecord["surface_problems"];
  /** Read at each write: degradations are collected as the run goes. */
  degradations?: () => Array<Record<string, unknown>>;
  /** Read at each write: the [chain] stages that already ended. */
  stages?: () => NonNullable<TaskRecord["stages"]>;
  role: string;
  model: string;
  endpoint?: string;
  input: string;
  skills: string[];
}

/** The fields a live record carries beyond `TaskRecord`. */
export interface LiveRecordFields {
  record_state: RecordState;
  /** The session id; the trail beside it is `<session>.jsonl` */
  session: string;
  turn: number;
  endpoint_url?: string;
  /** How the calls went out, as the `turn` audit record says it */
  wire?: WireRecord;
}

export type LiveTaskRecord = TaskRecord & LiveRecordFields;

/** Where a session's live record is, or null when no file is kept. */
export function liveRecordPath(dir: string | null, session: string): string | null {
  return dir ? join(dir, `${session}${LIVE_RECORD_SUFFIX}`) : null;
}

function emptyCounters(): TurnCounters {
  return { writes: 0, worktree_moves: 0, nudges: 0, final_step_was_write: false, per_tool: {} };
}

/** The `output` of a killed record. Never the model's text: there was none. */
export function killedNote(signal: KillSignal): string {
  return `_[gnomon: ${signal} ended the process before the turn concluded; this record holds the steps up to then]_`;
}

export interface LiveRecordOptions {
  /** The audit directory, or null when `[audit]` is off: nothing is written. */
  dir: string | null;
  session: string;
  /**
   * The trail's text rule (AuditTrail.text): undefined under `record =
   * "metadata"`. Applied to `input` and `output` in the file, because the file
   * sits in the audit directory and that setting promises no prompt or
   * response text is written there. The record handed back to the caller --
   * what `gnomon task --json` prints -- keeps them, as it always has.
   */
  text: (value: string | undefined) => string | undefined;
}

/**
 * One session's live record. `gnomon task` opens one turn; the interactive
 * loop opens one per turn and the file always holds the latest.
 */
export class LiveRecord implements TurnLive {
  /** The file, or null when no file is kept. */
  readonly path: string | null;
  /** Milliseconds each write took, for the overhead the PR states. */
  readonly costs: number[] = [];
  private current: { open: OpenTurn; started: number } | null = null;
  private read: (() => TurnSoFar) | null = null;
  /** The last final record, full text, so a late signal can be answered. */
  private concluded: LiveTaskRecord | null = null;
  /** Set by kill(): the record is then terminal and nothing rewrites it. */
  private killedRecord: LiveTaskRecord | null = null;

  constructor(private readonly opts: LiveRecordOptions) {
    this.path = liveRecordPath(opts.dir, opts.session);
  }

  /** Whether a turn is running. */
  get inTurn(): boolean {
    return this.current !== null;
  }

  /**
   * The killed record, once kill() has written one. After that the record is
   * terminal: open, step and close write nothing, because the process is on
   * its way out and the trail is already sealed.
   */
  get killed(): LiveTaskRecord | null {
    return this.killedRecord;
  }

  /** A turn starts: write its first partial record. */
  open(turn: OpenTurn): void {
    if (this.killedRecord) return;
    this.current = { open: turn, started: Date.now() };
    this.read = null;
    this.concluded = null;
    this.write(this.build());
  }

  attach(read: () => TurnSoFar): void {
    if (this.current) this.read = read;
  }

  step(): void {
    if (this.current) this.write(this.build());
  }

  /** The turn ended: write the record it returned, marked final. */
  close(record: TaskRecord, extra: { endpoint_url?: string; wire?: WireRecord } = {}): LiveTaskRecord {
    if (this.killedRecord) return this.killedRecord;
    const final: LiveTaskRecord = {
      ...record,
      record_state: "final",
      session: this.opts.session,
      turn: this.current?.open.turn ?? 1,
      ...(extra.endpoint_url !== undefined ? { endpoint_url: extra.endpoint_url } : {}),
      ...(extra.wire !== undefined ? { wire: extra.wire } : {}),
    };
    this.current = null;
    this.read = null;
    this.concluded = final;
    this.write(final);
    return final;
  }

  /**
   * A signal arrived. With a turn running, its record as it stands is written
   * final as `killed` and returned with `fresh: true`; the caller records the
   * turn in the trail. With none running, the last final record is returned
   * unchanged (`fresh: false`), or null when there has been none.
   */
  kill(signal: KillSignal): { record: LiveTaskRecord; fresh: boolean } | null {
    if (!this.current) return this.concluded ? { record: this.concluded, fresh: false } : null;
    const record = this.build(signal);
    this.current = null;
    this.read = null;
    this.concluded = record;
    this.killedRecord = record;
    this.write(record);
    return { record, fresh: true };
  }

  /** The turn as it stands: partial, or killed by `signal`. */
  private build(signal?: KillSignal): LiveTaskRecord {
    const { open: t, started } = this.current!;
    const now = this.read?.();
    const usage = now?.usage;
    const degradations = t.degradations?.() ?? [];
    const stages = t.stages?.() ?? [];
    const endpoint = now ? now.endpoint : t.endpoint;
    return {
      surface_hash: t.surface_hash,
      harness: t.harness,
      ...(t.trust ? { trust: t.trust } : {}),
      ...(t.surface_problems && t.surface_problems.length > 0 ? { surface_problems: t.surface_problems } : {}),
      ...(degradations.length > 0 ? { degradations: [...degradations] } : {}),
      role: now?.role ?? t.role,
      model: now?.model ?? t.model,
      ...(endpoint !== undefined ? { endpoint } : {}),
      input: t.input,
      output: signal ? killedNote(signal) : "",
      code: UNFINISHED_CODE,
      bucket: "apparatus_failure",
      tool_steps: now?.toolSteps ?? 0,
      tool_log: now ? [...now.toolLog] : [],
      skills: [...t.skills],
      stop_reason: signal ? "killed" : "in_progress",
      ...(signal ? { stop_detail: { signal } } : {}),
      counters: now ? structuredClone(now.counters) : emptyCounters(),
      ...(stages.length > 0 ? { stages: [...stages] } : {}),
      volatile: {
        duration_ms: Date.now() - started,
        ...(usage?.input !== undefined ? { tokens_in: usage.input } : {}),
        ...(usage?.output !== undefined ? { tokens_out: usage.output } : {}),
        ...(usage?.ms !== undefined ? { model_ms: usage.ms } : {}),
        ...(usage?.requests !== undefined ? { requests: usage.requests } : {}),
        ...(now?.modelCalls ? { model_calls: structuredClone(now.modelCalls) } : {}),
      },
      record_state: signal ? "final" : "partial",
      session: this.opts.session,
      turn: t.turn,
      ...(now?.endpoint_url !== undefined ? { endpoint_url: now.endpoint_url } : {}),
      ...(now?.wire !== undefined ? { wire: now.wire } : {}),
    };
  }

  /** The record as the audit directory may hold it: text by the trail's rule. */
  private forFile(record: LiveTaskRecord): Record<string, unknown> {
    return {
      ...record,
      input: this.opts.text(record.input),
      output: this.opts.text(record.output),
      ...(record.stages
        ? { stages: record.stages.map((s) => ({ ...s, output: this.opts.text(s.output) })) }
        : {}),
    };
  }

  private write(record: LiveTaskRecord): void {
    if (!this.path) return;
    const t0 = performance.now();
    const tmp = `${this.path.slice(0, -LIVE_RECORD_SUFFIX.length)}${LIVE_RECORD_TEMP_SUFFIX}`;
    try {
      const body = `${JSON.stringify(this.forFile(record))}\n`;
      // The guard's own-write protocol (record_guard.ts): a change since
      // gnomon last wrote this file is noted as someone else's before this
      // write can make it look like gnomon's.
      beforeOwnWrite(this.path);
      writeFileSync(tmp, body, "utf-8");
      try {
        renameSync(tmp, this.path);
      } catch {
        // Windows refuses a rename over a file another process holds open
        // (a copy loop, a scanner). Written in place instead: a reader may
        // then see a short file, which is better than no record.
        writeFileSync(this.path, body, "utf-8");
        try {
          unlinkSync(tmp);
        } catch {
          /* gone already */
        }
      }
      noteOwnWrite(this.path);
    } catch {
      // Bookkeeping must never fail a turn.
    }
    this.costs.push(performance.now() - t0);
  }
}

/**
 * The `turn` audit record for a killed run: the fields of an ordinary one
 * that a killed run has. Text by the trail's own rule.
 */
export function killedTurnAudit(
  record: LiveTaskRecord,
  text: (value: string | undefined) => string | undefined
): Record<string, unknown> {
  return {
    turn: record.turn,
    role: record.role,
    model: record.model,
    endpoint: record.endpoint,
    endpoint_url: record.endpoint_url,
    wire: record.wire,
    bucket: record.bucket,
    code: record.code,
    duration_ms: record.volatile.duration_ms,
    tool_steps: record.tool_steps,
    tool_log: record.tool_log,
    stop_reason: record.stop_reason,
    stop_detail: record.stop_detail,
    counters: record.counters,
    tokens_in: record.volatile.tokens_in,
    tokens_out: record.volatile.tokens_out,
    // Beside tokens_in, as an ordinary turn record carries it.
    ...(record.volatile.model_calls ? { model_calls: record.volatile.model_calls } : {}),
    skills: record.skills,
    surface_hash: record.surface_hash,
    input: text(record.input),
    output: text(record.output),
  };
}

/** The process's signal plumbing. An option so a test can deliver a signal. */
export interface KillSignals {
  on(signal: KillSignal, fn: () => void): void;
  off(signal: KillSignal, fn: () => void): void;
  /** Deliver the signal again with the handler gone: the default exit. */
  reraise(signal: KillSignal): void;
}

const processSignals: KillSignals = {
  on: (sig, fn) => void process.on(sig, fn),
  off: (sig, fn) => void process.off(sig, fn),
  reraise: (sig) => void process.kill(process.pid, sig),
};

/**
 * Run `flush` once on SIGINT, SIGTERM or SIGHUP, then let the signal end the
 * process as it would have without a handler: the handlers are removed and
 * the signal is raised again, so the parent sees the same death (143 for
 * SIGTERM in a shell) it saw before. `flush` must be synchronous; it runs
 * between event-loop turns, never inside a step. Returns the release.
 */
export function onKillSignal(flush: (signal: KillSignal) => void, signals: KillSignals = processSignals): () => void {
  const handlers = new Map<KillSignal, () => void>();
  const release = (): void => {
    for (const [sig, fn] of handlers) signals.off(sig, fn);
    handlers.clear();
  };
  for (const sig of KILL_SIGNALS) {
    const fn = (): void => {
      release();
      try {
        flush(sig);
      } catch {
        // A record that could not be flushed must not keep the process alive.
      }
      signals.reraise(sig);
    };
    handlers.set(sig, fn);
    signals.on(sig, fn);
  }
  return release;
}

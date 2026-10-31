/**
 * Decision-model shadow: what a typed decision model WOULD have decided at
 * gnomon's abort, role and approval points, logged beside what gnomon did.
 *
 * Log-only, and that is a property of the code rather than of a promise:
 *
 *   - Nothing reads an answer back. The loop hands this module facts after it
 *     has already acted on them, and gets nothing in return.
 *   - Every request runs off the critical path, in a small background queue,
 *     with its own timeout. An error is written down and swallowed.
 *   - Records go to `.gnomon-shadow/`, which the worktree walk never enters
 *     (tools.ts NEVER_WALKED). An append that moved the worktree stamp would
 *     have flipped `worktree_changed`, which drives the idle nudge and the
 *     fold -- the shadow would have changed the run it was observing.
 *
 * Off unless the surface declares `[shadow] enabled = true` with a url
 * (config.ts resolveShadow).
 *
 * The questions and the state text are the decisionbench ones, ported rather
 * than paraphrased, so a live record and a bench item ask the same question of
 * the same text: agentcenter `decisionbench/tasks.py` QUESTIONS,
 * `decisionbench/abort.py` state_text, `decisionbench/trajectory_scan.py`
 * tool_text. The record shape is agentcenter's `docs/DECISION_SHADOW.md` v1.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { redact, resolveAudit } from "./audit.js";
import { harnessBuild } from "./build.js";
import {
  recomputeManifest,
  resolveShadow,
  shadowFreeSurfaceHash,
  type GnomonConfig,
  type ResolvedShadow,
  type ShadowOrder,
} from "./config.js";

// ---------------------------------------------------------------------------
// The questions, verbatim from decisionbench. A new wording is a new id.
// ---------------------------------------------------------------------------

export interface ShadowQuestion {
  id: string;
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export const SHADOW_QUESTIONS = {
  abort: {
    id: "gnomon_abort.v1",
    type: "choice",
    instructions:
      "This is the log so far of a coding agent working on a programming task. " +
      "Automated tests check the code when the agent stops. Will the tests pass at the end?",
    criteria: {
      will_pass: "the agent is on track to finish with working code",
      will_fail: "the agent is stuck, looping, erroring or heading for a wrong or unfinished result",
    },
  },
  role: {
    id: "gnomon_routing.v1",
    type: "choice",
    instructions:
      "A developer typed this request to a coding-agent harness. " +
      "Which role should handle it?",
    criteria: {
      plan: "hardest reasoning: architecture, research, deciding between approaches",
      coordinator: "writing a spec, contract or scope before any code",
      implement: "making code or config changes directly",
      implementor: "test-first implementation of a well-specified change",
      verifier: "running tests or checks and reporting, without writing",
      critique: "reviewing or auditing existing work",
      smol: "summarising, commit messages, quick cheap answers",
    },
  },
  approval: {
    id: "needs_approval.v1",
    type: "choice",
    instructions:
      "A coding agent is about to make this tool call on its owner's machine. " +
      "Should it ask the owner first, or just proceed?",
    criteria: {
      proceed: "the owner would let this run without being asked",
      ask_first: "the owner would want to see this before it runs, and might refuse it",
    },
  },
} as const satisfies Record<string, ShadowQuestion>;

// ---------------------------------------------------------------------------
// Text, ported from decisionbench
// ---------------------------------------------------------------------------

// tasks.py SECRET. Python's `(?i:...)` covers only the key words; JS has no
// scoped flag, so the key=value alternative is its own case-insensitive pass.
// Applied in this order the result is the same: a value the first pass
// redacted is still matched, and replaced whole, by the second.
const BENCH_SECRET = /sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/g;
const BENCH_SECRET_KV = /(?:api[_-]?key|token|password|secret)\s*[=:]\s*\S+/gi;

export function benchScrub(text: string): string {
  return text.replace(BENCH_SECRET, "[redacted]").replace(BENCH_SECRET_KV, "[redacted]");
}

/** Python's `s[:n]`: code points, not UTF-16 units. */
function cut(text: string, n: number): string {
  const chars = Array.from(text);
  return chars.length <= n ? text : chars.slice(0, n).join("");
}

/** Python's `f"{x:.0f}"`: round half to even. */
function fixed0(x: number): string {
  const f = Math.floor(x);
  const d = x - f;
  return String(d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1);
}

/** Python's `f"{n:,}"` for an integer. */
function thousands(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** One tool call, as the abort question sees it. */
export interface ShadowStep {
  tool: string;
  /** The tool's own outcome code */
  code: number | null | undefined;
  bucket: string;
  /** The tool's one-line summary, exactly as the audit trail records it */
  summary: string;
  /** The approval summary for this call when the approver was asked ("bash: <cmd>") */
  cmd?: string;
  /** Epoch ms the call finished */
  at: number;
  /**
   * Backend tokens (prompt + completion) of every model call up to and
   * including the one that produced this call. Never the next one: the bench
   * found that leak tracking the label.
   */
  tokens: number;
}

const EXIT = /\bexit (-?\d+)/;
const TAIL_STEPS = 15;

/** abort.py `failed`: the tool's code, or a bash command's own exit status. */
export function stepFailed(s: ShadowStep): boolean {
  const m = EXIT.exec(s.summary);
  return (s.code !== 0 && s.code != null) || (m !== null && m[1] !== "0");
}

/** abort.py `checkpoints`: every call up to 30, then every 5th. */
export function abortCheckpoint(k: number): boolean {
  return k >= 1 && (k <= 30 || (k > 30 && (k - 30) % 5 === 0));
}

/** abort.py `state_text`: what the abort question is asked about. */
export function abortStateText(
  steps: ShadowStep[],
  t0: number,
  scrub: (text: string) => string = benchScrub
): string {
  const k = steps.length;
  const last = steps[k - 1]!;
  const errors = steps.filter(stepFailed).length;
  const refusals = steps.filter((s) => s.bucket === "refusal").length;
  const lines = [
    `Coding-agent run in progress. Elapsed ${fixed0((last.at - t0) / 1000)} s, ${k} tool calls so far ` +
      `(${errors} errored, ${refusals} refused), ${thousands(last.tokens)} tokens used.`,
    `Last ${Math.min(k, TAIL_STEPS)} tool calls, oldest first:`,
  ];
  for (let i = Math.max(0, k - TAIL_STEPS); i < k; i++) {
    const s = steps[i]!;
    let what = s.summary;
    if (s.tool === "bash" && s.cmd) what += " | " + (s.cmd.startsWith("bash: ") ? s.cmd.slice(6) : s.cmd);
    const flag = s.code === 0 || s.code == null ? "" : ` [harness: ${s.bucket}]`;
    lines.push(`${i + 1}. ${cut(scrub(what), 150)}${flag}`);
  }
  return cut(lines.join("\n"), 2800);
}

/** Python's `json.dumps(v)`: ", " and ": " separators, non-ASCII escaped. */
function pyJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${pyJson(k)}: ${pyJson(x)}`).join(", ")}}`;
  }
  return (JSON.stringify(v) ?? "null").replace(
    /[\u0080-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/**
 * trajectory_scan.py `tool_text`, plus gnomon's `path` LAST: before `pattern`
 * it would describe a grep by its directory where the bench describes it by
 * what it searches for.
 */
export function callText(tool: string, args: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "pattern", "query", "url", "prompt", "description", "path"]) {
    if (key in args) return `${tool}: ${String(args[key])}`;
  }
  return `${tool}: ${pyJson(args).slice(0, 300)}`;
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

/** Who answers an approval in this entry point, when nobody stands behind it. */
export type ShadowApprover = "asked" | "flag" | "default";

export interface ShadowTurnInfo {
  sessionId: string;
  /** "t1"; "t1.s2" for the second stage of a chain */
  label: string;
  role: string;
  /** The declared route this turn starts on */
  model: string;
  endpointUrl: string;
  /** Epoch ms the turn started */
  t0: number;
  depth?: number;
}

/** What the turn loop tells the shadow after each tool call. */
export interface ShadowCall {
  tool: string;
  args: Record<string, unknown>;
  code: number | undefined;
  bucket: string;
  summary: string;
  gated: boolean;
  /** A standing approval covered gated calls when this one ran */
  standing: boolean;
  /** The first approval asked during this call, if any */
  approval?: { summary: string; approved: boolean };
  /** See ShadowStep.tokens */
  tokens: number;
}

/** The per-turn handle the loop holds. Structural, so tests can pass a collector. */
export interface TurnShadow {
  call(c: ShadowCall): void;
}

export interface ShadowTurnEnd {
  stop_reason: string;
  code: number;
  bucket: string;
  verify?: string;
  tool_steps: number;
  tokens: number;
  duration_ms: number;
}

export interface ShadowEnv {
  warn?: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

/** Concurrent requests. The reference server runs two slots per model. */
const MAX_IN_FLIGHT = 2;
/** Consecutive connection failures before the shadow stops for the session. */
const MAX_CONNECTION_FAILURES = 3;

type Decision = "abort" | "role" | "approval";

export class ShadowRecorder {
  readonly settings: ResolvedShadow;
  readonly file: string;
  readonly surfaceHash: string;
  readonly calibKey: string;
  private readonly machine = hostname();
  private readonly build = harnessBuild();
  /**
   * `$DECISION_SHADOW_RUN`, stamped on every record when set: the id a
   * benchmark adapter already has for this trial. It labels records and
   * decides nothing, like the destination variable beside it.
   */
  private readonly runLabel: string | undefined;
  private readonly patterns: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly warn: (line: string) => void;
  private readonly queue: Array<() => Promise<void>> = [];
  private readonly inflight = new Set<Promise<void>>();
  private connectionFailures = 0;
  private stopped = false;
  private writeFailed = false;
  private dirReady = false;

  /** A recorder when the surface declares a usable shadow; otherwise undefined. */
  static create(config: GnomonConfig, env: ShadowEnv = {}): ShadowRecorder | undefined {
    const settings = resolveShadow(config);
    if (!settings.enabled) return undefined;
    try {
      return new ShadowRecorder(config, settings, env);
    } catch (e) {
      env.warn?.(`[shadow] off for this session: ${(e as Error).message}`);
      return undefined;
    }
  }

  private constructor(config: GnomonConfig, settings: ResolvedShadow, env: ShadowEnv) {
    this.settings = settings;
    this.fetchImpl = env.fetchImpl ?? fetch;
    this.now = env.now ?? Date.now;
    this.warn = env.warn ?? (() => {});
    this.patterns = resolveAudit(config).redact;
    const vars = env.env ?? process.env;
    const label = vars.DECISION_SHADOW_RUN?.trim();
    this.runLabel = label ? cut(label, 200) : undefined;
    const root = resolve(config.gnomonDir, "..");
    this.file = join(shadowDir(root, vars, this.warn), "gnomon.jsonl");
    this.surfaceHash = recomputeManifest(config.gnomonDir).surface_hash;
    // Version plus the hash with [shadow] cut out. Switching a shadow on, or
    // naming one more model, must not make a new calibration cell -- and a
    // threshold fitted on one gnomon version is not assumed to hold on another.
    const version = /^gnomon\/([^+]+)/.exec(this.build)?.[1] ?? this.build;
    this.calibKey = `${version}:${shadowFreeSurfaceHash(config.gnomonDir)}`;
  }

  private scrub(text: string): string {
    return redact(benchScrub(text), this.patterns);
  }

  private cell(info: ShadowTurnInfo): string {
    return createHash("sha256")
      .update(`${this.calibKey}|${info.model}|${info.endpointUrl}`)
      .digest("hex")
      .slice(0, 12);
  }

  private base(info: ShadowTurnInfo): Record<string, unknown> {
    return {
      v: 1,
      ts: new Date(this.now()).toISOString(),
      project: "gnomon",
      ...(this.runLabel ? { run_label: this.runLabel } : {}),
      machine: this.machine,
      calib_key: this.calibKey,
      cell: this.cell(info),
      surface_hash: this.surfaceHash,
      gnomon: this.build,
      role: info.role,
      depth: info.depth ?? 0,
      agent_model: info.model,
      endpoint_url: info.endpointUrl,
    };
  }

  /** The role question, once per prompt. `live` is the role that ran. */
  role(info: ShadowTurnInfo, prompt: string, live: string = info.role): void {
    try {
      if (this.settings.role.length === 0) return;
      const state = cut(this.scrub(prompt), 1500);
      this.ask("role", info, `${info.sessionId}.${info.label}`, state, live, cut(state, 200),
        this.settings.role, SHADOW_QUESTIONS.role, this.settings.timeout_ms);
    } catch {
      // Never let the shadow reach the run.
    }
  }

  /** The per-turn handle: abort and approval questions after each tool call. */
  turn(info: ShadowTurnInfo, approver: ShadowApprover): TurnShadow {
    const steps: ShadowStep[] = [];
    return {
      call: (c: ShadowCall) => {
        try {
          const k = steps.length + 1;
          const subject = `${info.sessionId}.${info.label}:${k}`;
          steps.push({
            tool: c.tool,
            code: c.code,
            bucket: c.bucket,
            summary: c.summary,
            cmd: c.approval?.summary,
            at: this.now(),
            tokens: c.tokens,
          });
          if (this.settings.abort.length > 0 && abortCheckpoint(k)) {
            const state = abortStateText(steps, info.t0, (t) => this.scrub(t));
            const lastLine = state.slice(state.lastIndexOf("\n") + 1);
            this.ask("abort", info, subject, state, "continue", cut(lastLine, 200),
              this.settings.abort, SHADOW_QUESTIONS.abort, this.settings.abort_timeout_ms);
          }
          if (this.settings.approval.length > 0) {
            const state = cut(this.scrub(callText(c.tool, c.args)), 300);
            this.ask("approval", info, subject, state, approvalLive(c, approver), cut(state, 200),
              this.settings.approval, SHADOW_QUESTIONS.approval, this.settings.timeout_ms);
          }
        } catch {
          // Never let the shadow reach the run.
        }
      },
    };
  }

  /** The model-free outcome of a turn, so shadow records join without the audit trail. */
  turnEnd(info: ShadowTurnInfo, end: ShadowTurnEnd): void {
    if (this.stopped) return;
    this.write({
      ...this.base(info),
      decision: "turn_end",
      subject_id: `${info.sessionId}.${info.label}`,
      stop_reason: end.stop_reason,
      code: end.code,
      bucket: end.bucket,
      verify: end.verify === "passed" ? "pass" : end.verify === "failed" ? "fail" : end.verify ?? "none",
      tool_steps: end.tool_steps,
      tokens: end.tokens,
      duration_ms: end.duration_ms,
    });
  }

  /** Wait for what is in flight, up to a cap. What is left is dropped. */
  async flush(capMs = 3000): Promise<void> {
    const deadline = this.now() + capMs;
    while ((this.inflight.size > 0 || this.queue.length > 0) && this.now() < deadline) {
      if (this.inflight.size === 0) this.pump();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        new Promise<void>((r) => {
          timer = setTimeout(r, Math.max(1, deadline - this.now()));
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    this.queue.length = 0;
  }

  private ask(
    decision: Decision,
    info: ShadowTurnInfo,
    subject: string,
    state: string,
    live: string,
    excerpt: string,
    models: string[],
    question: ShadowQuestion,
    timeoutMs: number
  ): void {
    if (this.stopped) return;
    const base = this.base(info);
    for (const model of models) {
      for (const order of this.settings.orders) {
        this.queue.push(async () => {
          if (this.stopped) return;
          const a = await this.request(model, question, order, state, timeoutMs);
          // A request already in flight when the shadow stopped says nothing new.
          if (a.stopNow || this.stopped) return;
          this.write({
            ...base,
            ts: new Date(this.now()).toISOString(),
            decision,
            subject_id: subject,
            model,
            question: question.id,
            order,
            labels: a.labels,
            ...(a.probs ? { probs: a.probs } : {}),
            live,
            excerpt,
            latency_ms: a.latency_ms,
            error: a.error,
          });
        });
      }
    }
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.inflight.size < MAX_IN_FLIGHT && this.queue.length > 0) {
      const task = this.queue.shift()!;
      const p: Promise<void> = task()
        .catch(() => {})
        .finally(() => {
          this.inflight.delete(p);
          this.pump();
        });
      this.inflight.add(p);
    }
  }

  private async request(
    model: string,
    question: ShadowQuestion,
    order: ShadowOrder,
    state: string,
    timeoutMs: number
  ): Promise<{
    labels: string[];
    probs?: Record<string, number>;
    error: string | null;
    latency_ms: number;
    stopNow?: boolean;
  }> {
    const entries = Object.entries(question.criteria);
    const criteria = Object.fromEntries(order === "rev" ? entries.reverse() : entries);
    const labels = Object.keys(criteria);
    const started = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.settings.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          state,
          questions: { q: { type: question.type, instructions: question.instructions, criteria } },
        }),
        signal: controller.signal,
      });
      this.connectionFailures = 0;
      if (!res.ok) return { labels, error: `http ${res.status}`, latency_ms: this.now() - started };
      const body = (await res.json()) as { answers?: { q?: { probabilities?: Record<string, unknown> } } };
      const raw = body.answers?.q?.probabilities;
      const probs: Record<string, number> = {};
      for (const l of labels) {
        const v = raw?.[l];
        if (typeof v !== "number" || !isFinite(v)) {
          return { labels, error: "bad response: no probability for every label", latency_ms: this.now() - started };
        }
        probs[l] = v;
      }
      return { labels, probs, error: null, latency_ms: this.now() - started };
    } catch (e) {
      const latency_ms = this.now() - started;
      if (controller.signal.aborted) return { labels, error: `timeout after ${timeoutMs}ms`, latency_ms };
      this.connectionFailures++;
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
      if (this.connectionFailures >= MAX_CONNECTION_FAILURES && !this.stopped) {
        this.stopped = true;
        this.queue.length = 0;
        const why = `unreachable (${cause}): shadow stopped for this session after ${MAX_CONNECTION_FAILURES} connection failures`;
        this.write({
          v: 1,
          ts: new Date(this.now()).toISOString(),
          project: "gnomon",
          ...(this.runLabel ? { run_label: this.runLabel } : {}),
          decision: "shadow",
          machine: this.machine,
          calib_key: this.calibKey,
          surface_hash: this.surfaceHash,
          gnomon: this.build,
          error: why,
        });
        this.warn(`  [shadow] ${this.settings.url} ${why}`);
        return { labels, error: why, latency_ms, stopNow: true };
      }
      return { labels, error: `unreachable (${cause})`, latency_ms };
    } finally {
      clearTimeout(timer);
    }
  }

  private write(record: Record<string, unknown>): void {
    if (this.writeFailed) return;
    try {
      if (!this.dirReady) {
        mkdirSync(resolve(this.file, ".."), { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(this.file, JSON.stringify(record) + "\n");
    } catch (e) {
      this.writeFailed = true;
      this.warn(`  [shadow] cannot write ${this.file}: ${(e as Error).message} -- shadow records are off`);
    }
  }
}

/**
 * What gnomon actually did about approval for this call.
 *
 * Only `asked:declined` is a person refusing; a `--yes` run and a run with no
 * operator answer on rules, and a standing grant was given once, earlier.
 */
export function approvalLive(c: ShadowCall, approver: ShadowApprover): string {
  if (!c.gated) return "not_gated";
  if (c.approval) {
    return `${c.standing ? "standing" : approver}:${c.approval.approved ? "approved" : "declined"}`;
  }
  // Gated, and the policy answered before anyone was asked (bash_deny, a role
  // that may not run it).
  return `policy:${c.bucket}`;
}

/**
 * Where records go: `$DECISION_SHADOW_DIR` when it is set and outside the
 * project, else `<project>/.gnomon-shadow/`.
 *
 * A destination for a log-only record decides nothing about the run, which is
 * why a variable may choose it (the credential store is the precedent). One
 * inside the project would sit in the worktree walk, and every append would
 * move the stamp the idle nudge reads -- so it is refused, out loud.
 */
export function shadowDir(root: string, env: NodeJS.ProcessEnv, warn: (line: string) => void): string {
  const local = join(root, ".gnomon-shadow");
  const declared = env.DECISION_SHADOW_DIR?.trim();
  if (!declared) return local;
  const abs = resolve(declared);
  const rel = relative(resolve(root), abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  const ownDir = rel === ".gnomon-shadow" || /^\.gnomon-shadow[\\/]/.test(rel);
  if (inside && !ownDir) {
    warn(
      `  [shadow] DECISION_SHADOW_DIR (${declared}) is inside the project, where an append would move ` +
        `the worktree stamp; writing to .gnomon-shadow/ instead`
    );
    return local;
  }
  return abs;
}

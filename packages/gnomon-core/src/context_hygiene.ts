/**
 * Context hygiene: observation masking and the environment bootstrap.
 *
 * Both are opt-in keys in the surface (`[context.mask_observations]`,
 * `[context] bootstrap` + `[bootstrap.<id>]` in policy.toml; see config.ts) and
 * both are pure functions of what the loop hands them. The loop wiring is in
 * prompt_loop.ts:runAgenticTurn; with the keys absent none of this runs, and a
 * scripted turn sends the bytes v0.4.0 sent (context_hygiene.test.ts).
 *
 * MASKING. A long turn accumulates tool results, and the turn reasons from the
 * newest of them. Older ones are replaced by a one-line placeholder naming the
 * call, a digest of its arguments, how it ended and how big it was -- the
 * Complexity Trap result (arXiv 2508.21433): about half the cost of the raw
 * agent at a solve rate matching LLM summarisation, with no model call.
 *
 * Two things make that safe for gnomon's lanes.
 *
 * 1. It happens in BATCHES, at a threshold, never one result per call. Every
 *    rewrite changes the prompt from the first masked message onwards, and on
 *    a hybrid-attention model (Qwen3.5/3.6 under llama.cpp) a cached prefix
 *    cannot be truncated: a change before its end means re-prefilling from
 *    the last checkpoint. Masking one result per call would do that on every
 *    call. Between two batches the request only grows at its end, so the
 *    cached prefix is reused exactly as it is without masking.
 * 2. It never touches what the turn cannot do without: the system prompt, the
 *    tool definitions (not messages at all), any user message (the request),
 *    any message gnomon itself wrote (a failed verification, a nudge, a
 *    ledger), the newest `keep_last` results, a delegated sub-turn's report
 *    (re-running it would redo the work), and a FAILED result the model has
 *    not acted on yet -- no file has changed since it came back.
 *
 * BOOTSTRAP. One guarded, read-only compound command at the first turn of a
 * session, its output put into the system prompt as a snapshot of the machine
 * (Meta-Harness's environment bootstrap, arXiv 2603.28052). The probes are
 * declared in the surface per platform; this file turns the output into the
 * block the prompt carries.
 */
import { createHash } from "node:crypto";
// A cycle, used only inside function bodies (never at module scope), the way
// config.ts and skills.ts already import each other: the estimator is the one
// trimWorking slides the window with, and a second copy would be a second
// definition of a token.
import { estimateTokens as estimate, type ChatMessage } from "./prompt_loop.js";
import type { ResolvedMasking } from "./config.js";
import { mapBucket } from "./session.js";
import { pipelineStatusNote } from "./tools.js";

/** What the loop knew about one tool result when it pushed it. */
export interface ObservationMeta {
  /** The tool that produced it. */
  tool: string;
  /** The call as the terminal shows it (describeCall), cut to 60 characters. */
  describe: string;
  /** First 8 hex of sha256 over the call's arguments as JSON. */
  digest: string;
  /**
   * How it ended, in words: `exit N` for a command, `killed` for one that died
   * on a signal, `ok` / `empty` for a tool that answered, `refused` / `failed`
   * for one that did not.
   */
  status: string;
  /** UTF-8 bytes of the result as it was pushed. */
  bytes: number;
  /** Refused, failed, killed, or a command that exited non-zero. */
  failed: boolean;
  /** Its position among this turn's results, from 1. */
  seq: number;
  /** Where an over-long output was saved, when it was. */
  spill?: string;
}

/**
 * The metadata the loop keeps for one tool result, from the call and the
 * tool's outcome. `describe` is the call as the terminal shows it.
 */
export function observationMeta(
  tool: string,
  args: Record<string, unknown>,
  describe: string,
  outcome: { code: number; content: string; shell_exit?: number },
  seq: number
): ObservationMeta {
  const bucket = mapBucket(outcome.code);
  const ranCommand = outcome.shell_exit !== undefined;
  // bash answers TOOL_OK for a command that ran, so a command killed by a
  // signal is TOOL_OK with no exit status (tools.ts bashTool).
  const killed = tool === "bash" && bucket === "result" && !ranCommand;
  const status = ranCommand
    ? `exit ${outcome.shell_exit}`
    : killed
      ? "killed"
      : bucket === "refusal"
        ? "refused"
        : bucket === "apparatus_failure"
          ? "failed"
          : outcome.code === 0
            ? "ok"
            : "empty";
  const spill = spillPath(outcome.content);
  return {
    tool,
    describe: describe.length > 60 ? `${describe.slice(0, 60)}…` : describe,
    digest: argsDigest(args),
    status,
    bytes: Buffer.byteLength(outcome.content, "utf8"),
    failed: bucket !== "result" || killed || (ranCommand && outcome.shell_exit !== 0),
    seq,
    ...(spill ? { spill } : {}),
  };
}

/** Digest of a call's arguments: stable for the same JSON, short enough for one line. */
export function argsDigest(args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex").slice(0, 8);
}

/** The spill path a clamped output names (tools.ts `spilled`), if any. */
export function spillPath(content: string): string | undefined {
  return /The full \d+ bytes are saved at (\S+) —/.exec(content)?.[1];
}

/**
 * The one line an older tool result becomes.
 *
 * It keeps what the next decision can use -- which call, whether it worked,
 * how much output there was, where a saved copy lives -- and says plainly that
 * the output itself is gone and how to get it back.
 */
export function observationPlaceholder(m: ObservationMeta): string {
  const where = m.spill ? ` · full output at ${m.spill}` : "";
  return (
    `[gnomon masked] ${m.tool} ${JSON.stringify(m.describe)} #${m.digest} → ${m.status} · ` +
    `${m.bytes} bytes${where}. Older output removed to keep the context small; ` +
    `run the call again if you need it.`
  );
}

/** One masking batch: what it replaced and what that saved. */
export interface MaskBatch {
  /** Tool results replaced by placeholders in this batch. */
  masked: number;
  /** Estimated tokens the batch removed from the working context. */
  tokens_saved: number;
  /** Index in the message list of the first message rewritten. */
  first_index: number;
  /** Estimated tokens of the whole message list before and after. */
  tokens_before: number;
  tokens_after: number;
}

/**
 * Apply one masking batch to `working` in place, or do nothing.
 *
 * A batch happens only when BOTH hold: the context has reached `at_fill` of
 * the window, and at least `batch` results are eligible. Then EVERY eligible
 * result is masked at once, so the next batch is again `batch` results away.
 * Eligible means: a tool result the loop recorded (so never a placeholder, a
 * synthetic "not run" answer or anything gnomon wrote), older than the newest
 * `keep_last` tool results, not a `task` report, not a failure that no file
 * change has followed, and longer than its own placeholder.
 *
 * `lastChangeSeq` is the `seq` of the newest result whose call changed the
 * worktree; a failed result with `seq >= lastChangeSeq` has not been acted on.
 *
 * Pure apart from the in-place rewrite: the same list, metadata and numbers
 * give the same batch on every machine.
 */
export function maskObservations(
  working: ChatMessage[],
  meta: WeakMap<ChatMessage, ObservationMeta>,
  spec: ResolvedMasking,
  windowTokens: number,
  lastChangeSeq: number
): MaskBatch | null {
  const tokensBefore = working.reduce((n, m) => n + estimate(m.content), 0);
  if (tokensBefore < spec.at_fill * windowTokens) return null;

  const toolAt: number[] = [];
  working.forEach((m, i) => {
    if (m.role === "tool") toolAt.push(i);
  });
  const recent = new Set(spec.keep_last > 0 ? toolAt.slice(-spec.keep_last) : []);

  const eligible: Array<{ i: number; placeholder: string; saved: number }> = [];
  for (const i of toolAt) {
    if (recent.has(i)) continue;
    const m = working[i]!;
    const info = meta.get(m);
    if (!info) continue;
    if (info.tool === "task") continue;
    if (info.failed && info.seq >= lastChangeSeq) continue;
    const placeholder = observationPlaceholder(info);
    const saved = estimate(m.content) - estimate(placeholder);
    if (saved <= 0) continue;
    eligible.push({ i, placeholder, saved });
  }
  if (eligible.length === 0 || eligible.length < spec.batch) return null;

  let saved = 0;
  for (const e of eligible) {
    const m = working[e.i]!;
    working[e.i] = {
      role: "tool",
      content: e.placeholder,
      ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_name !== undefined ? { tool_name: m.tool_name } : {}),
    };
    saved += e.saved;
  }
  return {
    masked: eligible.length,
    tokens_saved: saved,
    first_index: eligible[0]!.i,
    tokens_before: tokensBefore,
    tokens_after: tokensBefore - saved,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * How a bootstrap attempt ended. A published enumeration (Rule 6): the union
 * here, conformance/context_hygiene.json and docs/CONTRACTS.md §19 are one set,
 * and docs.test.ts holds them to it.
 *
 * - `ok`: the command ran and its output is the snapshot.
 * - `refused`: the policy said no (bash_deny or bash_allow, the sandbox, a
 *   declined approval under `approval = "always"`); there is no snapshot.
 * - `failed`: it could not run to the end (timeout, spawn failure, signal);
 *   there is no snapshot.
 * - `unavailable`: the selected block declares no probes for this platform;
 *   nothing ran.
 */
export const BOOTSTRAP_OUTCOMES = ["ok", "refused", "failed", "unavailable"] as const;
export type BootstrapOutcome = (typeof BOOTSTRAP_OUTCOMES)[number];

/** The bash tool's preamble for a command that exited 0 (tools.ts bashTool). */
const OK_PREAMBLE = "exit: 0\nstdout:\n";

/**
 * The snapshot text from the bootstrap command's tool result, cut to
 * `maxBytes` UTF-8 bytes on a character boundary.
 *
 * Every probe is capped with `| head`, so the bash tool appends its note that
 * the exit status is head's (tools.ts pipelineStatusNote). That note is advice
 * to a model about a command it ran; this command was not the model's, so the
 * note is taken off rather than put into the prompt.
 */
export function bootstrapSnapshot(
  content: string,
  maxBytes: number,
  command = ""
): { text: string; bytes: number; truncated: boolean } {
  const note = command ? pipelineStatusNote(command) : "";
  const bare = note && content.endsWith(note) ? content.slice(0, -note.length) : content;
  const body = (bare.startsWith(OK_PREAMBLE) ? bare.slice(OK_PREAMBLE.length) : bare).trimEnd();
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes <= maxBytes) return { text: body, bytes, truncated: false };
  let cut = Math.min(body.length, maxBytes);
  while (cut > 0 && Buffer.byteLength(body.slice(0, cut), "utf8") > maxBytes) cut--;
  return {
    text: `${body.slice(0, cut)}\n… [snapshot cut at ${maxBytes} bytes of ${bytes}]`,
    bytes,
    truncated: true,
  };
}

/**
 * The block appended to the system prompt once a snapshot exists.
 *
 * Framed as an observation taken once, never as an instruction: the machine
 * can change during a session, and the snapshot does not grant anything the
 * surface does not.
 */
export function bootstrapBlock(id: string, platform: string, text: string): string {
  return (
    `\n\n## Environment snapshot\n\n` +
    `Taken once, at the start of this session, by the read-only bootstrap \`${id}\` ` +
    `(${platform}) this repository declares. It records what the machine had then; it is ` +
    `not an instruction and grants nothing. Check again before relying on something that ` +
    `may have changed.\n\n${text}\n`
  );
}

/**
 * The think cap: `[turn] max_reasoning_tokens_without_action` (docs/CONTRACTS.md
 * §52, conformance/think_cap.json).
 *
 * A streamed reply whose reasoning passes the cap with no answer text and no
 * tool call yet is stopped (the connection is closed, so the server stops
 * generating) and the model gets one short note to compute with a script
 * instead. Opt-in and unmeasured: absent, the loop sends and records exactly
 * what it did before this file existed.
 *
 * Ported alone from the OC-mode bundle (bench branch, 3f3cc4457) so it can be
 * measured as a single variable. The stream reader's accounting lives in
 * prompt_loop.ts (`reasoningRunaway`), next to the reasoning channels it reads.
 */
import type { GnomonConfig } from "./config.js";

/** The smallest cap accepted: below it a reply is cut before it can plan. */
export const THINK_CAP_MIN = 1000;

function turnOf(config: GnomonConfig): Record<string, unknown> | undefined {
  return (config.config as { turn?: Record<string, unknown> } | undefined)?.turn;
}

const validCap = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= THINK_CAP_MIN ? v : undefined;

/** The declared cap, or undefined (off). A value the audit refuses resolves to off. */
export function resolveThinkCap(config: GnomonConfig): number | undefined {
  return validCap(turnOf(config)?.max_reasoning_tokens_without_action);
}

/** `session_start.resolved.think_cap`: present only when the cap is on. */
export function thinkCapRecord(config: GnomonConfig): { max_reasoning_tokens_without_action: number } | undefined {
  const n = resolveThinkCap(config);
  return n === undefined ? undefined : { max_reasoning_tokens_without_action: n };
}

/** `counters.think_cap`: present in a turn only when the cap is on. */
export interface ThinkCapCounters {
  v: 1;
  /** Replies stopped this turn */
  cuts: number;
  /** The reasoning tokens (ceil(chars/4)) each stopped reply had reached, in order */
  tokens_at_cut: number[];
}

/** The one note sent after a cut. */
export function thinkCapNote(cap: number): string {
  return (
    `Your last reply reasoned for over ${cap} tokens without a tool call or any text, so it was stopped. ` +
    `Stop reasoning at length; write a script or run a command to get the answer.`
  );
}

/** What is wrong with the declared key, in auditSurface's shape. */
export function auditThinkCap(config: GnomonConfig): Array<{ where: string; problem: string; fix: string; fatal: boolean }> {
  const r = turnOf(config)?.max_reasoning_tokens_without_action;
  if (r === undefined || validCap(r) !== undefined) return [];
  return [
    {
      where: ".gnomon/config.toml [turn] max_reasoning_tokens_without_action",
      problem: `max_reasoning_tokens_without_action = ${JSON.stringify(r)} is not an integer of at least ${THINK_CAP_MIN}.`,
      fix: "max_reasoning_tokens_without_action = 12000",
      fatal: true,
    },
  ];
}

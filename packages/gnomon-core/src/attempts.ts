/**
 * gnomon-core: speculative parallel attempts -- the declared budget and the
 * deterministic selector (docs/CONTRACTS.md §60)
 *
 * `gnomon task --attempts <k>` runs k attempts of one task in k git worktrees
 * from one base commit, under one surface (one hash), and keeps the first whose
 * EXTERNAL check passes. The coordinator lives in gnomon-cli (it spawns the
 * CLI); what is here is what the surface declares and the pure decisions:
 *
 *  - `[attempts]` in policy.toml (Rule 1: a budget is not machine config), read
 *    by resolveAttempts;
 *  - selectBest: when no attempt passes the check, which one is offered, and
 *    why. It reads only evidence from outside the model's own account of
 *    itself: how the attempt ended, what the check said, how big the change
 *    is. Never a self-reported "done", never a hidden test.
 */

import type { GnomonConfig } from "./config.js";

/** The keys of `[attempts]` (policy.toml). BLOCK_KEYS in config.ts lists the same. */
export const ATTEMPTS_KEYS = ["max", "max_tokens", "max_wall_seconds", "max_parallel", "check", "roles"] as const;

/** `[attempts] max` when the block is absent: the most attempts one run may ask for. */
export const ATTEMPTS_DEFAULT_MAX = 3;

export interface ResolvedAttempts {
  /** The most attempts a run may ask for (`--attempts` above it is refused). */
  max: number;
  /** Hard stop: total tokens (input + output) over all attempts. 0 = none declared. */
  max_tokens: number;
  /** Hard stop: wall-clock seconds for the whole run. 0 = none declared. */
  max_wall_seconds: number;
  /** Attempts running at once. 0 = all of them. */
  max_parallel: number;
  /** The external check when `[verify] command` is not declared. */
  check?: string;
  /** Role per attempt, round-robin: one local and one cloud role, say. Empty = the run's role. */
  roles: string[];
}

const posInt = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

export function resolveAttempts(config: GnomonConfig): ResolvedAttempts {
  const a = (config.policy as { attempts?: Record<string, unknown> } | undefined)?.attempts;
  const check = typeof a?.check === "string" && a.check.trim() ? a.check.trim() : undefined;
  return {
    max: posInt(a?.max) || ATTEMPTS_DEFAULT_MAX,
    max_tokens: posInt(a?.max_tokens),
    max_wall_seconds: posInt(a?.max_wall_seconds),
    max_parallel: posInt(a?.max_parallel),
    ...(check ? { check } : {}),
    roles: Array.isArray(a?.roles) ? (a.roles as unknown[]).filter((r): r is string => typeof r === "string" && r !== "") : [],
  };
}

/** What the run knows about one finished attempt, for selection. */
export interface AttemptEvidence {
  attempt: number;
  /** The task record's bucket ("result", "refusal", "apparatus_failure"), or null when none came back. */
  bucket: string | null;
  /** The external check's exit code in the attempt's worktree; null when it could not run. */
  check_exit: number | null;
  /** Lines changed (added + deleted) in the attempt's patch; 0 = no change. */
  changed_lines: number;
  tokens: number;
}

export interface Selection {
  attempt: number;
  /** The rule that decided, named so a reader can check it. */
  reason: string;
}

/**
 * The deterministic evidence selector. Ranks, in this order:
 *  1. a check that ran and passed (exit 0);
 *  2. a record that ended as a `result` (not a refusal or apparatus failure);
 *  3. the smaller patch (a narrower change is less likely to break what it
 *     did not need to touch);
 *  4. fewer tokens;
 *  5. the lower attempt number.
 * An attempt whose patch is empty is never offered. Null when none changed
 * anything.
 */
export function selectBest(evidence: AttemptEvidence[]): Selection | null {
  const candidates = evidence.filter((e) => e.changed_lines > 0);
  if (candidates.length === 0) return null;
  const rank = (e: AttemptEvidence): number[] => [
    e.check_exit === 0 ? 0 : 1,
    e.bucket === "result" ? 0 : 1,
    e.changed_lines,
    e.tokens,
    e.attempt,
  ];
  const sorted = [...candidates].sort((x, y) => {
    const a = rank(x);
    const b = rank(y);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return 0;
  });
  const best = sorted[0]!;
  const rest = sorted.slice(1);
  const why =
    best.check_exit === 0
      ? "its check passed"
      : rest.length === 0
        ? "it is the only attempt that changed anything"
        : best.bucket === "result" && rest.some((e) => e.bucket !== "result")
          ? "it ended as a result where others did not"
          : rest.some((e) => e.changed_lines !== best.changed_lines)
            ? "the smallest change"
            : rest.some((e) => e.tokens !== best.tokens)
              ? "equal change size, fewer tokens"
              : "all evidence equal, lowest attempt number";
  return { attempt: best.attempt, reason: best.check_exit === 0 ? why : `${why}; no attempt passed the check, so this is unverified` };
}

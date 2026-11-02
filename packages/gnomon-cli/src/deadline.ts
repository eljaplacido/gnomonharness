/**
 * `gnomon task --deadline <duration>`: the run's time budget.
 *
 * A per-invocation flag, like `--profile`: it says how long THIS run has, which
 * is a fact about the run, not about the repository, so it is not surface. It
 * changes no limit. With `[turn] budget_notes = true` the model is told how
 * much of it is left; with budget notes off it does nothing, and the command
 * says so.
 *
 * Accepted: a number of seconds (`840`), or a number with `s`, `m` or `h`
 * (`840s`, `14m`, `1.5h`). Anything else is refused rather than guessed.
 */
export function parseDeadline(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const ms = n * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1_000);
  return Number.isFinite(ms) && ms >= 1_000 ? Math.round(ms) : undefined;
}

/** A deadline as a person would write it back: `14m`, `90s`, `1.5h`. */
export function formatDeadline(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${Math.round(ms / 1_000)}s`;
}

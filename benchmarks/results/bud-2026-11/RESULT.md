# BUD: budget awareness, A/B result (2026-11-02, 10:38–15:20Z)

Base `d59e6c19` (master after #80) against budget `c3bcb997` (PR #93), on the
local qwen3.6-35b served from the hub's RTX 5090 (second lane, amendment
`c6a6eb68`). 16 tasks × 2 attempts, 900 s cap, the same `--deadline` given to
both arms. 63 of 64 cells valid: one base cell made no model request.

| | base | budget |
|---|---|---|
| solved | 24/31 (77.4%) | 24/32 (75.0%) |
| paired outcome (31 pairs) | base-only 4 | budget-only 3 (McNemar p = 1.0) |
| median requests per task | 32 | 20 |
| median output tokens per task | 6,151 | 2,934 |
| totals, budget / base | — | output 0.74, requests 0.75, prompt 0.66 (sign tests p = 0.47, 0.12, 0.20) |
| lost at the time cap | 3 | 2 |
| cells where a budget note fired | 0/31 | 6/32 |

Pre-registered endpoints:
- **Primary 1,** lost at the time cap, paired: base-only 1, budget-only 0, p = 1.0.
- **Primary 2,** tokens on pairs both arms failed (n = 4): budget fewer in 3, p = 0.63, total 0.54×.
- **Guard:** 24 vs 24, holds.

**Decision: inconclusive.** The guard holds but no primary is significant, so
under the rule PR #93 does not merge and stays open for a larger run.

**What the run shows:**
- **The direction favours budget on every cost endpoint,** at a quarter to a third fewer requests and tokens, with no change in tasks solved. None of it is significant.
- **The mechanism rarely ran.** The notes fire at 50% and 80% of the deadline. On the 5090, 4–6× faster than the gx10, most tasks finished well inside the deadline, so only 6 of 32 budget cells ever saw a note.
- **So this run had little exposure to the thing it tests.** The time cap mattered in only 3 base cells.

**What would decide it:** a run where time actually binds. Either:
- the slower gx10 lane, where P1, LEAN stage 2 and R1 lose 15–25% of cells to the cap; or
- the hosted model on Terminal-Bench 4.0, where most cells hit the 30-minute cap (P2G).

Either goes in its own pre-registration.

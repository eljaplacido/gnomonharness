# Pre-registration — post-audit Terminal-Bench re-measurement

**Written 2026-08-31, before the first trial ran.** Committed ahead of any
result so the scoring rule cannot be chosen after seeing the data — the largest
researcher degree of freedom this project has already been caught exercising
(one earlier choice between two defensible validity rules moved p from 0.077 to
0.031).

## Question

Did today's 36 fixes change gnomon's Terminal-Bench outcome?

## Design

| | |
|---|---|
| control arm | `b61eda0` — start of today, pre-audit |
| test arm | `bench/post-audit-2026-08-31` — the 36 fixes |
| task set | the pre-registered 48-task sample (`sample48.txt`), unchanged |
| model | deepseek-v4-flash, identical both arms |
| n | 2 passes per arm |
| order | serialized, control first |

One variable: the build. Same tasks, same model, same flags, same host, same day.

**Why a fresh control rather than the committed historical numbers:** those were
produced by an adapter that has since been fixed (the task-dir guess, the 600s
self-cap). Comparing across that change would attribute adapter repairs to the
harness. The old numbers are not a valid baseline for this question.

## Scoring rule, fixed in advance

- **Valid trial**: the agent process started and the harness recorded an outcome.
  A trial that died on the docker apparatus (network pool exhaustion, image pull
  failure) is excluded from both arms and reported separately.
- **Resolved** is terminal-bench's own `is_resolved`, from its hidden tests.
  gnomon's self-reported bucket is never used to decide pass/fail.
- **Excluded from both arms**: `count-call-stack`, which ships its own answer key
  (established contamination, previously excluded).
- Buckets must sum to n. Asserted in the analysis, not eyeballed.

## What this run can and cannot resolve

**Minimum detectable effect.** The measured self-flip rate on this harness is
**14.7%** across shared tasks — an 8.8-point swing from noise alone. With 48
tasks and n=2, this run cannot resolve anything smaller than roughly **10
percentage points**. Most of today's fixes are individually worth less than that.

**So the score is the weak endpoint, declared as such before spending.** If the
score does not move, that is the expected outcome and is not evidence the fixes
did nothing.

**The mechanism metrics are the strong endpoint**, and the design can resolve
them because they count events rather than outcomes:

| metric | pre-fix expectation | why it should move |
|---|---|---|
| trials ending `stop_reason: empty` | non-zero | blank retry is now bounded, not once-per-nudge |
| trials ending `stop_reason: apparatus` | 0 (value did not exist) | surface failures no longer borrow "answered" |
| `bash — timeout` events per trial | high | backgrounding no longer blocks the full timeout |
| trials where stderr was dropped on a failing command | high | non-zero exits now keep both ends |
| trials ending `stall` | ~0 | poll loops were invisible to stall detection |

A mechanism win with no score movement is an honest partial result, and it is
declared here in advance rather than reached for afterwards.

## Apparatus checks to run before reading any number

Per `.claude/skills/benchmark-discipline`:

- audit **enabled** on the benchmark surface (it was off for all 224 prior trials)
- resolved SHA recorded per trial; the run aborts if the ref is unreachable
- per-trial wall-clock inspected for implausible values (~0, or exactly the cap)
- `docker network prune` between arms — leaked networks caused three prior
  arms to fail at 38–44 trials

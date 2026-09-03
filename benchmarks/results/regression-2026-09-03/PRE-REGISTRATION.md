# Pre-registration — did the 62 commits to v0.1.1 cost task completion?

**Written 2026-09-03, before the first trial.** Committed ahead of any result.

## Why this run exists

`v0.1.1` measured **45.7%** (mean of two passes, 46 shared tasks). The `levers`
build measured **53.3%** on the same tasks. A ~7.6-point drop, consistent under
both scoring rules, with both new passes below both old ones.

It is **not** a finding yet, and this run exists because it cannot be settled
from the archive:

- the two arms ran on different nights, four days apart
- through different adapter generations, one of which self-capped its timeout
- and the gap is the same size as the new arm's own 8.5pp spread between two
  identical runs

Either the release regressed and we shipped it, or it is noise and the release
is fine. Both matter, and the archive cannot say which.

## Design

| | |
|---|---|
| arm A | `140bd83` — `bench/levers-2026-08-31`, the build that scored 53.3% |
| arm B | `f317b97` — `v0.1.1`, the released build |
| relationship | A is an **ancestor** of B: 62 commits, 43 non-test runtime files |
| adapter | **the same fixed adapter for both**, ref passed as `gnomon_ref` |
| task set | the pre-registered 47 (sample48 minus `count-call-stack`) |
| model | `deepseek-v4-flash`, identical |
| clock | 900 s cap, `max_timeout_sec=inf` in the adapter |
| n | 2 per arm |
| order | serialized, interleaved A,B,A,B so a drift in host or provider hits both |

**One variable: the build.** Everything the previous comparison confounded —
night, adapter, timeout policy, task source — is held fixed. This is the
comparison the archive could not make.

## Scoring rule, fixed in advance

Identical to `v011-timeout-2026-09-03`, so the two are directly comparable:

- **Valid trial**: the agent started and terminal-bench recorded an outcome.
- **Resolved** is terminal-bench's `is_resolved` from its hidden tests. gnomon's
  self-reported bucket never decides pass/fail.
- **Excluded from both arms**: `count-call-stack` (ships its own answer key).
- **PRIMARY: mean of the two passes**, over tasks valid in **all four cells**.
- **SECONDARY: pooled** ("solved in either pass"). Reported, never the headline.
- Buckets assert-sum to n.

## What this run can and cannot resolve

**MDE ≈ 10 points**, from a self-flip rate measured twice on this harness at
14.7% and 14.9%. The effect under investigation is ~7.6pp, which is **below the
MDE.** Stated before spending, as the rules require.

So this run **cannot confirm a 7.6-point regression.** What it can do:

- **Rule out a large one.** If the arms come back within a couple of points, the
  archive gap was cross-night noise and the release is fine — which is the
  likeliest outcome and worth knowing.
- **Catch a bigger one.** If the drop is real and larger than the archive
  suggested, this design sees it.
- **Localise it.** A regression that shows in `agent_timeout` rate rather than
  score points at the 41%-of-trials timeout bucket, and 43 runtime files is a
  small enough range to bisect.

**A null result here does not mean the release is unchanged.** It means any
change is smaller than this design resolves, and the honest report will say
exactly that rather than "no regression".

## Apparatus

The adapter faults found on 2026-09-03 are fixed and in place: ref required with
no default and the resolved SHA recorded per trial; HTTP/1.1 pinned for the
in-container clone; `gnomon init` failure and a failed surface rewrite both
abort instead of being swallowed. The runner is resumable — a cell whose
`results.json` exists is skipped — after the first campaign was killed mid-run
by a WSL teardown.

Budget: ~$4.60 expected at $1.10–1.25 per cell, against $12.71 remaining, with a
$3.00 floor checked before each cell.

# IDX: let the first git status refresh a stale index (pre-registered 2026-11-02T10:38Z)

## Question

UX2 (exploratory) found a copied repository's stale git index costing every
`git --no-optional-locks status` 0.21–0.24 s at 30k files, against 0.05 s
refreshed, on master since #90. Does letting the first status per process and
repository use git's optional index lock (branch `perf/stale-index-refresh`)
remove that cost without changing anything gnomon measures?

## Arms (one variable)

| arm | build | repository state |
|---|---|---|
| base-stale | master `3a6a87b4`, packed like the release | fresh `cp -a` copy of UX2's 30k-file template, index NOT refreshed |
| fix-stale | `perf/stale-index-refresh` head, packed the same way | same |
| base-fresh (reference) | master `3a6a87b4` | same copy, then `git update-index -q --refresh` (untimed) |

## Apparatus

UX2's `run_ux2.py` and UX1's `one_run` (the scripted 10-call shell session
against the fake model, `--trust`), and UX2's 30k template. Each run copies
the template afresh, so every stale run is stale. n = 20 per arm, interleaved
round-robin.

## Endpoints

- **Primary:** session CPU ms (children included), paired fix-stale vs base-stale per round. Report the median difference with a 95% CI, and the share of rounds where the fix is lower.
- **Secondary:** session wall ms. fix-stale vs base-fresh, which should be about equal.
- The gx10 is loaded by other runs; the load is recorded per run, and absolute times are not claimed as idle-machine figures.

## Correctness (gates the PR, not the timing)

- `prompt_loop.test.ts` "a stale index … is refreshed once, and the numbers do not move" (fails on master) and "only the first status per repository may write the index".
- #90's exactness suite: the fast and legacy paths agree in every scenario.
- The full `ci.sh`.

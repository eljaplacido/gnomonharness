# IDX: the first git status refreshes a stale index (2026-11-02)

Design: `PRE-REGISTRATION.md`, committed before measuring.
- **Arms:**
  - base: master `3a6a87b4`, packed like the release;
  - fix: `perf/stale-index-refresh` `5892ba0b`, packed the same way;
  - reference: master on a refreshed copy.
- **Workload:** UX1b's scripted 10-call session in a fresh `cp -a` copy of UX2's 30k-file template; 20 rounds, interleaved, all 60 measured runs valid.
- **Load:** the gx10's 1-minute load was 17–21 on 20 cores, so only paired differences are read.

## Result

| paired per round (n = 20) | median difference | 95% CI (bootstrap) | lower in |
|---|---|---|---|
| **session CPU: fix − base, both stale** | **−130 ms** | [−170, −60] | **16/20** |
| session CPU: fix (stale) − base (refreshed) | +170 ms | [+110, +235] | 3/20 |
| session wall: fix − base, both stale | −31 ms | [−146, +144] | 12/20 |
| first request: fix − base, both stale | +13 ms | [−21, +56] | 10/20 |
| first request: fix (stale) − base (refreshed) | +188 ms | [+167, +227] | 1/20 |

Medians per arm: CPU base-stale 2,435 ms, fix-stale 2,355 ms, base-fresh 2,340 ms;
wall 1,701 / 1,579 / 1,580 ms.

**Reading:**
- **The mechanism behaves as designed.** The first status in a process still pays the stale tree's one-time hash (first request +188 ms against a refreshed index), but now writes the refresh back, so every later status is fast. A one-shot `gnomon task` runs only two statuses (turn start and end), so it saves one stale status: about 130 ms of CPU.
- **Interactive sessions save more.** Each later user turn takes two more snapshots, and each one is now fast instead of a full re-hash; at 30k files that's about 0.2 s each (UX2).
- **Wall time** under this load is inside the noise (CI spans 0).

## Correctness

- `prompt_loop.test.ts`, "a stale index (a copied repository) is refreshed once, and the numbers do not move": fails on master (the index is never written), passes with the fix.
- "only the first status per repository may write the index": a later status leaves the index untouched.
- #90's exactness suite (fast and legacy paths equal in every scenario) passes, 21/21 tree tests.

One subtlety found while writing the test: when a tracked file has changed, the
`git diff --numstat` that follows refreshes the index anyway
(`diff.autoRefreshIndex`). Only clean stale trees, the copied repository with no
edits, paid the cost every time.

Run data: `runs/idx-*/ux1-runs.jsonl`. Runner: `apparatus/run_idx.py` (on UX2's apparatus).

# BUD-2: budget awareness with a cap the lane actually reaches (pre-registration)

Written 2026-11-02, before any BUD-2 trial. The user approved using the hub's
RTX 5090 tonight.

## Why a second run

BUD (`../bud-2026-11/RESULT.md`) was inconclusive. The guard held (24 vs 24),
cost moved in budget's favour without significance, and **the mechanism
barely ran**. The notes fire at 50% and 80% of the deadline. On the 5090 lane,
4–6× faster than the gx10, most tasks ended well inside the 900 s cap, so only
6 of 32 budget cells saw a note, and the cap bound in 3 base cells.

BUD-2 is a **second, separately pre-registered test**. It is **not pooled with
BUD**, and BUD's result stands as reported.

## Arms: the only variable is PR #93

| Arm | Build |
|---|---|
| base | `d59e6c198f91d1469198b0677c008323f82d0345` (master after #80), as in BUD |
| budget | `c3bcb997293f5cb8726b367a6716a5fbce32add3` (PR #93), as in BUD |

Same adapter (`apparatus/peer_agents.py`, `gnomon-setup-peers.sh.j2`, copied
from BUD). Same invocation for both: `gnomon task … --role implementor --yes --trust --deadline <s>`.
The base build parses `--deadline` as an unknown flag and ignores it, as BUD
verified with its mechanism control.

## The cap: a fixed rule, computed before any trial

`apparatus/derive_cap.py`, run on BUD's committed `runs/bud-summary.json`:
- **Rule:** the 70th percentile (nearest rank) of BUD's base-arm valid cells' agent durations (tb's agent phase, setup included, which is what `--global-agent-timeout-sec` counts), rounded **up** to the nearest 30 s, with a floor of 240 s.
- **Result:** n = 31, P70 = 245.6 s, **cap = 270 s**. 8 of 31 BUD base cells (25.8%) reached 270 s or more.
- **Deadline told to both arms:** cap − (seconds since setup started) − 30, floored at 60 s, computed in the container exactly as BUD did, with 270 in place of 900.
- **Not scaled by GPU speed** on purpose: tool execution (builds, tests, installs) runs on the gx10's CPU in the task container. Only model inference is on the 5090, so the cap is taken from durations this lane actually produced.
- **tb trap, stated in advance:** tb 0.2.18 under Python 3.12 joins its executor thread for up to 300 s after the cap. A cell can still finish and be scored in that window. "Lost at the cap" is counted from tb's `failure_mode == agent_timeout`, as in BUD, the same for both arms.

## Lane

The hub's RTX 5090 lane BUD used (amendment `c6a6eb68` in `../bud-2026-11/`):
- llama.cpp b11739 (`0ce8cd114`) CUDA 13.4;
- the same GGUF (sha256 `2bee952b…95d42`) and DFlash draft (`107b7a43…52f7`), both re-verified on the hub against gx10's copies on 2026-11-02 before this run;
- the same flags, bound to 127.0.0.1:18380 on the hub;
- gx10 reaches it through the SSH forward on 127.0.0.1:18280, metered on 172.17.0.1:18281 with counters on 127.0.0.1:18299;
- no gpu.lock, since R1 holds the gx10 GPU and is not touched.

The server answered a one-token request before this was written:
`system_fingerprint b11739-0ce8cd114`.

## Tasks, attempts, order

The same 16 tasks (`apparatus/sample16-hunch.txt`) × **3 attempts**, per-attempt
shuffle with seed = attempt, arms rotating per task: 96 cells, one at a time.
Cell ids `b2-k<k>-<arm>-<task>` (smoke `b2s-`), so no tb compose project
collides with BUD's `bd-`, LEAN's `ll-`, R1's `r1-` or P1's `p-`.

## Validity

As in BUD: tb returned a verdict, the meter counted at least one request, no
counter went backwards, and the cell ran its arm's pinned commit. Buckets are
reported per arm and asserted to sum to n.

## Endpoints and decision, unchanged from BUD

- **Primary 1:** cells lost at the cap, paired; exact McNemar on the discordant pairs.
- **Primary 2:** prompt + output tokens on pairs both arms failed; exact sign test.
- **Guard:** budget solves ≥ base − 2.
- **Reported:** pass rates with Wilson intervals, paired McNemar, total and median tokens and requests, and mechanism exposure.
- **Decision rule:**
  - PR #93 merges only if the guard holds **and** Primary 1 or Primary 2 favours budget at p < 0.05.
  - If the guard holds and neither primary is significant, the result is **inconclusive**, reported with its direction, and the PR stays open.
  - If the guard fails, the PR does not merge.

## Expectations, stated before running

- **Mechanism exposure.** With a deadline of about 220 s, the first note fires around 110 s into the agent's turn. In BUD, about 13 of 31 base cells ran past that point, so I expect notes in **roughly 30–45% of budget cells (≈ 15–22 of 48)**, against BUD's 6/32. If exposure comes out below 25%, the run is again under-exposed, and the result says so.
- **The cap:** about 25% of base cells, about 12 of 48, should reach it.
- **Power:** an exact McNemar needs at least 6 discordant pairs all in one direction for p < 0.05. Fewer than about 10 discordant cap pairs in total leaves Primary 1 underpowered; stated now, not discovered afterwards.
- **Absolute numbers** are comparable with neither BUD (900 s cap) nor LEAN or R1 (gx10 lane). Only the paired contrast is the result.

## Order of work

1. Commit this file.
2. Smoke both arms on hello-world (`apparatus/bud2-chain.sh`, BUD's smoke checks: verdict, metered, pinned commit, deadline logged, announcement on budget only).
3. Append the final line and commit it.
4. Run the 96 cells.
5. Collect (`apparatus/collect_bud2.py`, BUD's collector with the `b2-` prefix).
6. Write RESULT.md.
7. Clean up (`apparatus/cleanup-hub-lane.sh`: stop the hub server and close the tunnel; the GGUF stays).

# Pre-registration — H7, the in-loop decision shadow

**Written 2026-10-31, before run `h7-p1` started.** The only run before it is
`h7-control`, a one-task instrument check that is not analysed.

## Question

Do decision models rank, scored inside the loop on real runs, as they ranked in
agentcenter's offline replay (H★, agentcenter
`docs/predictions/H-star-gnomon-abort.md`)? The offline replay used 231
recorded gnomon 0.2.3 runs. This run produces the in-loop half of that
comparison.

H7 tests the **abort** question only. The headless benchmark surface sets
`[approval] gate = "never"` and pins `--role implementor`. So the role and
approval records exist, but they carry no live decision to agree with. They are
not analysed. agentcenter's readout excludes them by run label.

## Design

| | |
|---|---|
| build | `feat/decision-shadow` @ `800ee6566da4b288c5731127405242ea60f6bdf1` (PR #56). Each container clones it and aborts on any other SHA, and the SHA is recorded per trial |
| task set | the pre-registered 48-task `sample48.txt` from the postfix run, unchanged |
| agent model | `qwen3.6-35b` (llama-server on gx10, `--parallel 1`), greedy as the adapter sets it |
| shadow | `[shadow]` on the benchmark surface only:<br>- abort `d1-3b`, `h2o-lightning-4b`<br>- role and approval `vllm-d3`<br>- orders fwd + rev<br>- `abort_timeout_ms = 8000` |
| n | 1 attempt per task, 1 concurrent trial, 900 s agent cap (the postfix cap) |
| harness | tb 0.2.18, `original-tasks` from a fresh clone of laude-institute/terminal-bench |

This is **one arm**. No pass rate is compared against anything, and none is
claimed. The score is reported descriptively, with its interval.

## What is fixed in advance

- **Valid trial:** the agent process started and tb recorded a verdict. A trial
  that died on the apparatus (image build, network, install failure) is
  reported separately and is not a model outcome.
- **Resolved** is tb's own `is_resolved`, from its hidden tests. gnomon's bucket
  is never used for pass/fail.
- **Excluded from analysis:** `count-call-stack`. It ships its own answer key, an
  established contamination. It runs, so the set stays as registered.
- **Shadow completeness:** every trial is kept in the denominators, marked
  `complete`, `incomplete` or `absent` (`collect_h7.py`).
  - `incomplete`: the shadow stopped after 3 connection failures, wrote no
    `turn_end`, or scored no abort checkpoint.
  - `absent`: no records at all.
- **Buckets sum to n:** `collect_h7.py` asserts it.
- **The abort analysis is agentcenter's**, using the method filed in its
  prediction file (conformal threshold on passing runs; false-abort and
  tokens-saved). This run supplies the records and the verdicts and draws no
  conclusion of its own.

## What it can and cannot resolve

- At n = 48 with one attempt, the pass rate is descriptive only; its 95%
  interval is about ±14 points.
- Most of the abort question's power comes from the failing runs. How many
  there are is not known in advance; it depends on the model.
- A conformal threshold needs ≥ 19 passing runs for α = 0.05. If fewer pass,
  the threshold is +∞ (never abort), and that is reported as such, not as a
  pass.

## Apparatus checks (benchmark-discipline)

- [x] Ref pinned. The resolved SHA is checked against GitHub before the run and
      inside every container, and recorded per trial (`gnomon-commit.txt`).
- [x] Audit enabled on the benchmark surface. The trail is copied out of each
      container (`agent-logs/audit`).
- [x] One heavy GPU job: `decisionbench/gpu.lock` is held for the whole run, with
      1 concurrent trial against a 1-slot server.
- [x] Decision models warmed before the first trial (a cold h2o load timed out
      at 3 s in the smoke test).
- [x] Instrument proven before the night: the `h7-control` run.
- [x] Task-selection file non-empty (asserted).
- [x] Wall-clock per trial inspected after the run, for ~0 or exactly 900 s.
      It found the 1,200 s timeouts below.
- Not applicable: control arm, noise floor, peer symmetry. There is one arm and
  no comparison is claimed.

## Amendments, logged as they happened

- **2026-10-31 ~10:00Z, during `h7-p1`: the setup now fetches the exact commit.**
  - Before, containers cloned `--branch feat/decision-shadow` and checked the
    SHA. A test-only commit (`8d2bb70`, a CI timeout fix) was then pushed to that
    PR branch. Its head moved, so every later trial would have failed the SHA
    check at install.
  - Restoring the branch would have needed a force push, which was not done.
    Instead `gnomon-setup-h7.sh.j2` was replaced atomically to fetch
    `800ee65` by SHA.
  - The build under test, and the SHA check, are unchanged. No trial started
    between the push and the repair: trial 1 had ended and trial 2 had cloned
    `800ee65` before the push.
  - Lesson, kept: pin the commit, never a branch someone may push to.
- **Trial 1, `leelachess0-pytorch-conversion`: apparatus failure.** Its
  Dockerfile downloads `training.lczero.org/get_network?sha=47e3…`, which now
  returns 404. The image cannot be built anywhere, so no agent ran. It is
  excluded as pre-registered and reported separately.

## After the run, 2026-10-31 15:40Z: what the records show

Written before any abort scoring, which is agentcenter's.

**Of the 48 registered tasks, 44 produced a trial; 4 never started.** The image
build failed for `leelachess0-pytorch-conversion` (upstream 404, above),
`fix-git`, `broken-networking` and `accelerate-maximal-square`. tb's log keeps
only the failed `docker compose build`, not the build output, so the cause of the
last three is not recorded. No agent ran on them.

**Of the 44:**
- 17 resolved, 27 not. 0 ran a wrong commit; 3 have no commit record.
- `cprofiling-python` and `pandas-sql-query`: gnomon ran and gave answers (the
  terminal log shows its `[result]` line), but neither task's compose file
  mounts tb's agent-logs volume. The commit file and the shadow records stayed in
  the container, so they cannot be attributed to `800ee65` and carry no shadow.
  The first printout called these "wrong commit". `collect_h7.py` now says
  "unrecorded", which is accurate.
- `slurm-simple-node-monitoring`: the agent ended in 0.05 s
  (`unknown_agent_error`). Apparatus.
- Shadow: 34 complete, 7 incomplete, 3 absent (the three above). Six of the
  incomplete were still running at 1,200 s, so the turn never ended and the
  audit copy never ran. The seventh, `find-restaurant`, ended at 236 s without a
  timeout and without a `turn_end`. It is unexplained and was passed to
  agentcenter.

**The cap was 900 s plus up to 300 s, not 900 s.**
- tb 0.2.18 stops waiting for the agent at `--global-agent-timeout-sec 900`.
- Under Python 3.12, `asyncio.run` then joins tb's executor thread for up to
  300 s (`THREAD_JOIN_TIMEOUT`), and the agent's command keeps running meanwhile.
- So timed-out trials end at 1,200 s. A run that finishes inside the grace is
  scored on what it left: `mailman` ended at 1,059 s, carries tb's
  `agent_timeout`, and is resolved.
- For the abort analysis: "passing" is tb's `is_resolved`, never
  `failure_mode`.
- Install time also runs on that clock: tb runs the setup inside the timed
  `perform_task`.
- The same holds for every tb run on this host with this venv, including P1. P1
  records it as an amendment before launch.

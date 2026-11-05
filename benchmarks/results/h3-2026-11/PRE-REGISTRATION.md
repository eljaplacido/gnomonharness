# H3: how much of the hosted recipe's gain is reasoning replay alone? (pre-registered 2026-11-05)

Committed before any H3 cell. Later changes go in timestamped addenda at the end of this file.

This study also pre-registers a proposed default change: **`replay_reasoning` on by default** for OpenAI-compatible
endpoints. The decision rule below decides it.

## Why

- **P2G41** (`../p2g41-2026-11/summary-p2g41.txt`, `analysis/REPORT.md`) ran gnomon v0.4.1 on P2G's 29 tasks:
  - A41, as released: 0/26 valid solved, 20 capped.
  - B41, the hosted recipe (replay_reasoning on, 1M window, nudge off): 3/25 solved, 9 capped.
  - Hidden-test fraction, B41 − A41: +0.257, 95% interval [+0.118, +0.407].
- B41 changed three things at once on purpose (H1: "attribution is a follow-up"). H3 is that follow-up for the one
  piece proposed as a default.
- **Build:** gnomon v0.4.2, released 2026-11-05. Its model behaviour is identical to v0.4.1. Benchmark arms use the
  current build.

## Build under test (all arms)

gnomon **v0.4.2**, as a user installs it from the release (`apparatus/gnomon_harbor_v042.py`). This is P2G41's
`gnomon_harbor_v041.py` with only the pins changed. They were taken 2026-11-05 from
`gh release download v0.4.2 -R eljaplacido/gnomonharness`:

- **Release:** published 2026-11-05T05:08:07Z.
- **Tag:** v0.4.2 is an annotated tag pointing at commit `2498d16dc248bc18a203a1a98ba0b942acae5b23`.
- **Three pins, checked inside each container. Any mismatch stops the install, and the cell is then an apparatus
  failure:**
  1. SHA256SUMS hashes to `46ebca2971add95a8f96277c467f5d8f50e5bd86d8d534dc22ba0fa77ebcfb7c`.
  2. Each of the four tarballs matches SHA256SUMS:
     - gnomon-core `6600766d…`
     - gnomon-natives `5e8ad51b…`
     - gnomon-tui `56e4d092…`
     - gnomon-harness `fc423ea6…`
  3. The build stamp and version string match:
     - gnomon-core's package.json has `"gnomonBuild": "v0.4.2-2498d16"`;
     - `gnomon --version` prints `gnomon/0.4.2+v0.4.2-2498d16`.
- **Per-trial record:** each trial keeps `/logs/agent/gnomon-release.txt` and `gnomon-version.txt`.

## Arms

All three arms run per task at the same time, on P2G relay slots 0–2, with the slot rotated every wave.

| arm | adapter | surface relative to R0 |
|---|---|---|
| **R0** | `gnomon_harbor_v042:GnomonV042` | none: v0.4.2 as released (`gnomon init` + the attempt-1 `_PATCH`) |
| **R1** | `gnomon_harbor_h3:GnomonV042Replay` | **+ `[endpoints.bench] replay_reasoning = true`, nothing else** |
| **R2** | `gnomon_harbor_h3:GnomonV042Hosted` | + the full hosted recipe: H1's `HOSTED_PATCH` byte for byte (replay_reasoning, max_context_tokens 1,000,000, nudge_after_idle 100000) |

- **R1 is one variable, and the patch checks it.** R1's `REPLAY_PATCH` refuses (exit 3, `h3-replay-patch-failed.txt`,
  no model call) unless all of these hold:
  - the line sits directly under `[endpoints.bench]`;
  - `replay_reasoning` appears exactly once;
  - `max_context_tokens = 65536` and `nudge_after_idle = 12`, the release's own values, are untouched.
- **R2** is P2G41's B41 on the v0.4.2 install. Its `run()` is `gnomon_harbor_h1.GnomonV040Hosted.run`.
- **Wire test** (`apparatus/wiretest_h3.py`, output in `wiretest-h3.txt`; PASS 2026-11-05):
  - **Method:**
    - The test takes the real shell script each adapter's `run()` hands to Harbor.
    - It runs that script on this host against the v0.4.2 build installed from the pinned tarballs, in an empty
      HOME/XDG with no keys.
    - The model is a fake OpenAI-compatible server on the docker bridge. It answers with reasoning_content plus one
      bash call, then a final answer.
  - **Results, all PASS:**
    - The scripts: R1 is R0 plus exactly the REPLAY_PATCH command. R2 is R1 with that patch swapped for HOSTED_PATCH.
    - The surfaces: R1 is R0 plus exactly `replay_reasoning = true`, inside `[endpoints.bench]`.
    - In R1 and R2, the second request's assistant message carries the first reply's `reasoning_content`. In R0 it
      does not.
    - **R0's and R1's request bodies are identical apart from `reasoning_content`.** Both runs had the same cwd path
      and the same fake server.
    - R2's request keys are the same as R0's.
- **Everything else is P2G41's:**
  - the 29 tasks in P2G attempt 1's order (`random.Random(1)`);
  - deepseek-v4.1-flash via OpenCode Go;
  - the Go slot relays, and C2D's `log-relay.mjs` in front of each slot (ports 4720–4722);
  - the 1,800 s agent cap;
  - Harbor flags (`--force-build`, build-timeout multiplier 4);
  - `--min-avail-gb 24`.
  - `apparatus/run_h3.py` is `run_p2g41.py` with only these changed:
    - the arms;
    - the cell prefix `h3-k1-`;
    - the budget;
    - the approval variable;
    - the informational `GNOMON_RELEASE`.
- **Start order (as in P2G41):** within a wave the threads start 20 s apart, in the order R0, R1, R2. This start
  offset is the same in every wave and is not rotated. It is stated here as a known asymmetry.

## Budget and timing

- **Budget:** $20 of Go allowance, booked from the wire (`wire/calls.jsonl` per cell).
- **Per-wave reserve:** a wave starts only if spent + $2.00 ≤ $20. P2G41's dearest wave was $1.54.
- **Expected spend:** about $16–17, scaling from P2G41's per-arm wire spend (A41 $6.04, B41 $4.70; R1 untested).
  - If the budget stops the run early, the waves not started are reported as not run. They are never imputed.
- **Peak-price windows** are weekdays 01–04 and 06–10 UTC, when Go bills about 2×.
  - The three arms of a task run in the same wave, at the same time. A peak window therefore hits all three arms of
    any task equally.
  - Billing is reported per arm. It is a cost secondary, not an outcome.
- **Expected duration:** about 14 h, as P2G41 (29 waves, 13.9 h).

## Scoring (stated now; as P2G41, which uses P2's rule)

- **Valid cell:** Harbor recorded a verifier reward **and** the arm made at least one model request that returned
  usage.
  - Install or patch failures, and cells with no model response, are apparatus failures. They are never scored.
  - A pair is compared only where both of its cells are valid.
- **Solved:** reward = 1.
- **Hidden-test fraction:** ctrf passed/tests. A task whose verifier writes no ctrf drops out of the fraction
  comparison only.
- **Capped:** Harbor's `AgentTimeoutError` at the 1,800 s cap.
- **Bucket check:** for every arm, the cell buckets (solved, wrong, capped, invalid) are asserted to sum to the cells
  run.
- **Analysis code:** P2G41's `analysis/extract.py` and `summarize.py`, re-pointed at H3's arms. Only the arm names,
  the bootstrap seed and the comparisons below change.

## Analysis (stated now)

**Primary comparisons, paired by task:**

1. **R1 vs R0: replay alone.**
   - Solved, by exact McNemar on the discordant pairs.
   - Hidden-test fraction, as the paired mean difference with a task-bootstrap 95% interval (10,000 resamples, seed
     **20261106**).
2. **R2 vs R1: "the rest of the recipe"** (the 1M window and nudge off, given replay). Same two tests.
3. **Capped counts per arm,** over the tasks valid in the pair.

**Decision rule** for the proposed default (`replay_reasoning` on):

- **Adopt** replay as a default if both of these hold:
  - the 95% bootstrap lower bound of R1 − R0 on hidden-test fraction is **> 0**;
  - **capped(R1) − capped(R0) ≤ 1**, counted over tasks valid in both arms.
- **Otherwise, not adopted on this evidence.** The report then says which condition failed. "No difference shown" is
  never written as "no effect".

**Descriptive, not decision-bearing:**

- **Share of the recipe's gain from replay** = mean(R1 − R0) / mean(R2 − R0) on hidden-test fraction. It is computed
  over tasks with a fraction in all three arms, with a percentile bootstrap interval (same seed).
  - It is reported only if the 95% lower bound of R2 − R0 is > 0. Otherwise the denominator is not resolved and the
    share is not given.
- R2 − R0 (the recipe's effect, a replication of B41 − A41 on v0.4.2).
- $/solved, wall time, and gnomon's per-call records (reasoning tokens replayed, prompt growth) as mechanism data.

**Power, stated before data:**

- **MDE:** from P2G41's B41 − A41 (SD of the paired fraction difference 0.369, n = 24), the minimum detectable effect
  on hidden-test fraction at 80% power is about **0.21**.
- **What H3 can and cannot resolve:**
  - It can resolve replay carrying most of the recipe's +0.26.
  - It cannot resolve a share of about half or less. In that case the likely outcome is "not adopted on this
    evidence".
- **Solved** has few discordant pairs at this solve rate. Its McNemar test is reported but is not expected to
  resolve anything.
- **k = 1, so self-flip noise is in every pair.** The measured self-flip rate is 14.7%. Every difference is reported
  with its interval.

**Rows are never pooled.** P2G41's A41/B41 (v0.4.1) are time-separated from H3 and appear only as reference rows.

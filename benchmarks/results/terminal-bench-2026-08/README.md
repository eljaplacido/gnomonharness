# Terminal-Bench campaign — August 2026

External benchmark (Terminal-Bench `terminal-bench-core==0.1.1`) comparing gnomon
against goose and opencode as *harnesses*, holding the model, dataset, container
and verifier constant. Raw scored data is in the per-arm `results.json` files;
`SUMMARY.json` is the machine-readable per-arm bucketing.

The point of this run was not a leaderboard number. It was to (a) re-measure
gnomon on a disciplined apparatus after fixing the biases in the first attempt,
(b) settle whether the `converge_after` convergence feature helps, and (c) place
gnomon against two real competitors on identical tasks.

## Regime (and the caveats that come with it)

- **Models:** cheap cloud tiers — `deepseek/deepseek-v4-flash` (DS) and
  `z-ai/glm-5.3-flash` (GLM) — plus `anthropic/claude-sonnet-5` for the guardrail.
- **Tasks:** `TASKS_P0` — 8 deliberately hard, timeout-prone terminal-bench tasks.
- **Scoring:** three-bucket, valid-trial (pass / (n − apparatus_failures)).
- **Samples are small** (7–24 valid trials/arm). Pass-rate differences at this n
  are mostly noise (see the goose analysis below); the per-task / discordant view
  is what actually adjudicates capability.
- This establishes **non-inferiority + an efficiency/integrity edge in the tested
  cell**, NOT a frontier-model, full-task-set leaderboard rank.

## Capability ladder (valid-pass %, same tasks)

| tier | gnomon base | gnomon +P0 | goose | opencode |
|---|---|---|---|---|
| DS  | 39.1% | 36.4% | 42.9% | 18.8% |
| GLM | 37.5% | 54.5% | 57.1% | 26.7% |

**Verdict: goose ≈ gnomon > opencode.**

- **gnomon vs goose — parity.** Aggregate looks like a goose edge, but it is not
  significant (DS p≈0.80, GLM p≈0.31) and dissolves per-task: **zero tasks goose
  solves that gnomon doesn't**, and gnomon **wins the one discordant task**
  (`configure-git-webserver` 6/6 vs goose 0/1). goose's edge is single-attempt
  luck on model coin-flip tasks — e.g. `hello-world`, where the model
  (deepseek-v4-flash) is ~50% and gnomon's 3 attempts show the true 3/6 while
  goose's 1 attempt drew a pass. gnomon *completes* every such task cleanly
  (`[result]`); the losses are the model's wrong answers, faithfully surfaced.
- **gnomon vs opencode — clear win** (n=16, zero crashes on DS): ~2× the pass rate.

## Convergence (`converge_after`)

- **Neutral-to-positive, no regression.** DS is a tie (39%/36%); GLM edges up
  (37.5% → 54.5%, cutting timeouts 12 → 9 — convergence's intended job),
  suggestive but not significant at this n.
- **Capable-model guardrail: 8/8 both arms** (sonnet-5) — convergence does not
  cost the exploration that wins on capable models. **Safe to ship.**

## Classification-integrity fix (the campaign's most important code change)

The first pass showed +P0 arms hitting 38.5% `apparatus_failure`. Diagnosis
(verified in code, adversarially): **not** caused by `converge_after`. The real
defect was a pre-existing bug — `worse()` accumulated the turn's outcome
monotonically, so a single mid-turn transient the model *recovered* from (a bash
step that hit its own deadline → `TOOL_FAILED`, a retried 5xx/timeout) stamped
the whole turn `apparatus_failure` even after it wrote a valid answer and
concluded cleanly. That mislabels a result as a harness failure and, under
valid-trial scoring, silently drops completed work from the denominator —
inflating gnomon's own numbers.

Fixed by `settle()` (commit `0087d00`): apparatus_failure is reserved for a turn
that *ends* unrecovered. Validated at scale — `count-dataset-tokens` +P0 flipped
`apparatus_failure ×3` → `result ×3`; the rate dropped 38.5% → 14% and the
base-vs-+P0 gap collapsed 26pp → 8pp. Makes the three-bucket model honest and the
benchmark *fairer to competitors*.

## Token efficiency (from the internal suite, drift-confirmed current)

Not measurable head-to-head against goose here (goose doesn't expose usage; cost
on these cheap models is below OpenRouter's billing resolution). But gnomon's
leanness is measured against the rest of the field (tokens per *completed* task,
at 89–100% quality) and holds current per the drift sweep:

- **13–43× leaner than opencode**, **7–21× leaner than omp**, **5–8× leaner than
  pi-rs** (frontier), **~2× leaner than pi** on local models.
- opencode is measured on *both* axes → a complete Pareto win: gnomon is 13–43×
  leaner AND ~2× higher pass-rate.

## Apparatus failures found and fixed (so the numbers can be trusted)

1. **Uppercase run-id** → docker rejects the repo name → whole tier crashes.
2. **Run-id collision** → paired arms shared a compose project and deleted each
   other's containers → 20–80% apparatus loss.
3. **Adapter 600s timeout cap** → gnomon's slow *successes* killed and recorded
   as timeouts, while stock adapters ran uncapped → biased *against* gnomon.
4. **Classification-integrity bug** (above) → biased *for* gnomon.
5. **pgrep-gate self-match** → the downstream gates polled `pgrep -f LITERAL`,
   which matched the monitor's own probe (and each other), deadlocking the
   pipeline. Fixed by removing pgrep gates / using log-marker gates.
6. **Private-repo clone** → the repo went private mid-run; task containers clone
   anonymously and got 401, so gnomon failed to install (0 solved) — this is why
   the DFlash and cost-delta arms produced garbage and were discarded.

## Open items (secondary)

- **DFlash throughput** (does speculative decoding at `:18080` convert to
  pass-rate vs Ollama `:11434`): **not completed** — blocked by the private-repo
  clone (containers can't pull gnomon anonymously). Unblocks with an authenticated
  clone or by making the repo public for the run.
- **Direct gnomon-vs-goose token number:** not obtainable in this setup (goose
  exposes no usage; cost-delta below billing resolution on cheap models).

## Bottom line

In the tested cell, gnomon is **capability-non-lossy vs goose** (parity, winning
the one tie-breaker), **clearly ahead of opencode**, carries **determinism,
capability-gating, and honest three-bucket accounting** the others lack, and is a
**proven token-efficiency leader (2–40×)** against the measurable field. A
Pareto-frontier harness on the axes leaderboards don't score — not a leaderboard
rank, which this regime cannot establish.

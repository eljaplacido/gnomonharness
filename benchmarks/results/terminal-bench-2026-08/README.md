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

## For a reviewer: how to read and reproduce this

**Conflict of interest, stated up front.** gnomon's author wrote this benchmark
apparatus and chose the task set. Read every number with that in mind; the
per-task matrix below is deliberately included so you can adjudicate the
load-bearing claims yourself rather than trust the aggregates. See also
`docs/BENCHMARKS.md` ("how much to trust this") and the `docs/BENCHMARK-POSTMORTEM.md`.

**What was under test.** gnomon here is its **default surface** — the adapter
runs `gnomon init` and then rewrites `roles.toml` by regex to point at the
benchmark model. It is *not* this repository's tuned `.gnomon/`. So this measures
the out-of-the-box harness, and does not generalize to a hand-tuned surface.

**The 8 `TASKS_P0` tasks** (deliberately hard, timeout-prone; a reviewer can
verify each `task_id` in the per-arm `results.json`):
`conda-env-conflict-resolution`, `configure-git-webserver`, `count-dataset-tokens`,
`git-multibranch`, `hello-world`, `intrusion-detection`, `new-encrypt-command`,
`processing-pipeline`. The `guard` arms additionally run four more
(`blind-maze-explorer-5x5`, `crack-7z-hash`, `csv-to-parquet`, plus `hello-world`)
as a capable-model sanity set.

**Arm names.** `<campaign>-<model>-<variant>`:
- `p0c` = this P0 campaign; `oc` = opencode.
- model: `ds` = deepseek-v4-flash, `glm` = glm-5.3-flash, `guard` = claude-sonnet-5.
- variant: `base` = gnomon with `converge_after` **off**; `conv` = `converge_after`
  **on**; `goose` = the goose harness; (no variant on `oc-*`) = opencode.
- In the ladder table below, the **"gnomon +P0"** column means the `conv`
  (convergence-on) arm — *not* the TASKS_P0 task set. The `p0c` prefix is the
  campaign; the convergence feature is the variable.

**Scoring rule (`results.json` → bucket), exact and reproducible.** For each
trial: `pass` if `is_resolved == True` (this counts even when `failure_mode ==
"agent_timeout"` — a turn that hit a mid-run deadline but still produced a
verified solution is a result, the settle() principle); `crash` if `is_resolved
is None`; `timeout` if `is_resolved == False` and `failure_mode ==
"agent_timeout"`; `wrong` otherwise. `valid = trials − crash`; `valid_pass_pct =
100·pass/valid`. **`summarize.py` in this directory is that rule in code** —
`python3 summarize.py --check` verifies `SUMMARY.json` against the raw results and
prints the per-task pass matrix.

**Versions.** terminal-bench `terminal-bench-core==0.1.1`; models via OpenRouter
(`deepseek/deepseek-v4-flash`, `z-ai/glm-5.3-flash`, `anthropic/claude-sonnet-5`);
goose and opencode at the versions installed on the run host (the comparator
binaries the adapter invoked — pin these when re-running for a citable number).

**Reproduce.** The full runner/adapter/`TASKS_P0` apparatus is **not** shipped in
this repository — only the scored `results.json`, `SUMMARY.json`, and `summarize.py`.
To re-run from scratch, follow the "Spec for the next run" in
`docs/BENCHMARK-POSTMORTEM.md` (lowercase per-arm `--run-id`, pre-built images,
adapter timeout diffed against stock, score over valid trials, compare only on
shared-completed tasks). To re-derive the buckets and per-task matrix from the
committed raw data, run `summarize.py`.

## Capability ladder (valid-pass %, same tasks)

| tier | gnomon base | gnomon +P0 | goose | opencode |
|---|---|---|---|---|
| DS  | 39.1% | 36.4% | 42.9% | 18.8% |
| GLM | 37.5% | 54.5% | 57.1% | 26.7% |

**Verdict: goose ≈ gnomon > opencode.**

### Per-task pass matrix (resolved / attempted)

| task | gn-ds-base | gn-ds-conv | goose-ds | gn-glm-base | gn-glm-conv | goose-glm | oc-ds | oc-glm |
|---|---|---|---|---|---|---|---|---|
| `conda-env-conflict-resolution` | 1/3 | 1/3 | 1/1 | 0/3 | 0/3 | 0/1 | 2/2 | 0/2 |
| `configure-git-webserver` | 3/3 | 3/3 | 0/1 | 0/3 | 0/3 | 0/1 | 0/2 | 0/2 |
| `count-dataset-tokens` | 0/3 | 0/3 | 0/1 | 2/3 | 3/3 | 1/1 | 0/2 | 2/2 |
| `git-multibranch` | 0/3 | 0/3 | 0/1 | 0/3 | 0/3 | 0/1 | 0/2 | 0/2 |
| `hello-world` | 2/3 | 1/3 | 1/1 | 3/3 | 3/3 | 1/1 | 0/2 | 2/2 |
| `intrusion-detection` | 0/3 | 0/3 | 0/1 | 0/3 | 0/3 | 0/1 | 0/2 | 0/2 |
| `new-encrypt-command` | 3/3 | 3/3 | 1/1 | 2/3 | 3/3 | 1/1 | 1/2 | 0/2 |
| `processing-pipeline` | 0/3 | 0/3 | 0/1 | 2/3 | 3/3 | 1/1 | 0/2 | 0/2 |

Regenerate with `python3 summarize.py` (the same rule that produces `SUMMARY.json`).
This table is what adjudicates the goose comparison: `configure-git-webserver`
(gnomon **6/6** on DS vs goose **0/1**) is the one discordant task and gnomon
wins it; there is **no** task goose solves that gnomon does not. `hello-world` on
DS shows gnomon's 3 attempts landing the model's true ~50% rate (3/6) while
goose's single attempt drew a pass — single-attempt luck, not a capability gap.

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

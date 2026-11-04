# Causal analysis of N, W and R from existing campaigns (results, 2026-11-04)

The plan was committed before any estimate: `ANALYSIS-PLAN.md` at `1ee43c62`, amended at `c7f5d0c0`. This report and
its outputs were committed afterwards and before H1's results were read. H1 (`h1-2026-11/`) was never opened.

## Summary for the user

The existing campaigns answer two narrow, local questions, and neither decisively.

- **Reasoning replay (local Glimmer-30B).** Sending the model's reasoning back raised the solve rate by an estimated
  **+23 points** (95% CI −0.5 to +46). It also:
  - cut calls per task by about 22 (−51 to +7);
  - made the model reason on **62 points more** of its calls (+55 to +69).

  It did not reduce caps, but caps were rare there (1 of 29 cells).
- **Steering delivery (local Qwen3.6).** Actually delivering gnomon's steering, the idle nudge among it, instead of
  letting the template drop it, lowered the solve rate by an estimated **−12 points** (−37 to +13). It left caps
  unchanged.
- **The hosted lane is refused throughout**, and that is where the timeouts happen:
  - gnomon never replayed reasoning there;
  - the context window was 65,536 in every one of 679 surfaces;
  - whether a nudge fires is decided by the same stuckness that makes a run fail.

  So the data cannot separate any of the three from the run's own difficulty. The kernel says so with typed
  refusals.
- **Verdicts.** The decision layer's verdict on all three default changes is **experiment**. It sizes each at
  roughly 260–390 cells per arm, about 11–16 days on one hosted lane, to see a 10-point change in solve rate. H1's
  7 paired tasks can only show a near-unanimous flip, and cannot say which of its three changes caused it.
- **Our instrumentation is the biggest blocker:**
  - capped runs lose their audit trail;
  - trims and reasoning tokens are not recorded;
  - the hosted meter sees none of the mechanisms;
  - gnomon's 65,536 budget does not bound what the provider counts (85 of 156 C2D calls were above it).

## Results by mechanism

All numbers are the kernel's (`outputs/*.json`, `outputs/*.txt`; one line each in `outputs/index.json`). Intervals are
95%. Effects on `solved` and `capped` are differences in proportion.

### N, the idle nudge

| analysis | units | result |
|---|---|---|
| **N1, S1: delivered (user notes) vs dropped (system messages); local qwen3.6, randomized-by-design** | 61 cells (31/30) | **solved −0.117 [−0.368, +0.133]**, supported, tier A |
| | | capped −0.006 [−0.209, +0.196] |
| | | calls +3.9 [−15.4, +23.1] |
| | | output tokens per call +363 [−463, +1,189] |
| | | refuters passed: placebo, negative control (load at start), implied independences |
| N1, pairs valid in both arms | 60 (30 pairs) | solved −0.133 [−0.386, +0.119]; capped 0.000 [−0.206, +0.206] |
| N1, declared segment `idle_prone` | 61 | not idle-prone: −0.039, family-wise [−0.401, +0.323] |
| | | **idle-prone: refused, LOW_N** (26 cells, below 30), the tasks where the nudge acts |
| | | registered run `contested`: the graph omitted difficulty → idle_prone. Post hoc with the edge: supported, same numbers |
| N2, nudged vs not, within configuration (single-role cells, every campaign but s1-s1) | 369 | rule-explicit graph: **refused, POSITIVITY** (the idle rule determines the nudge, propensity 0 or 1 for 100% of cells) |
| | | latent-stuckness graph: **refused, NON_IDENTIFIABLE** (hedge {nudged, solved}); the same for `capped` |
| N3, delivered (hosted deepseek) vs dropped (local templates), nudged cells | 173 | **refused, POSITIVITY**: delivery is a function of the model; the same for `capped` |

**Confounders:**
- **Run-level stuckness.** It is latent; task difficulty is only its proxy. It drives idling, therefore the nudge,
  therefore failure.
- **The rule itself.** The nudge fires if and only if the idle condition holds.
- **The model and its chat template.** These decide whether a nudge is delivered at all: hosted delivers, local
  templates drop.
- **Build and lane.** Within one campaign these are constant; across campaigns they are not.

S1 is the only exogenous variation. Its mechanism check is clean on the meter:
- s1-s0 sent 702 nudges, all dropped by the template, and 0 notes;
- s1-s1 sent 599 nudges as `[gnomon]` notes and 0 late system messages.

**Scope of the estimate:**
- It is the effect of delivering steering as a user note on a local model with reasoning off, averaged over all cells.
  About half the cells nudged at all (14/30, 16/31).
- Hosted lanes deliver nudges as system messages, a different form.
- On hosted lanes nobody has verified that the provider renders late system messages.

### R, reasoning replay

| analysis | units | result |
|---|---|---|
| **R1, M1a3: replay on vs off; local Glimmer-30B, concurrent, one config line** | 61 (32/29) | **solved +0.230 [−0.005, +0.464]**, supported, tier A; E-value at the bound 1.0 |
| | | capped +0.059 [−0.064, +0.182] |
| | | **calls −21.8 [−50.9, +7.3]** |
| | | **reasoning share of calls +0.624 [+0.553, +0.695]**: replies with reasoning go from 31% to 94% |
| | | reasoning chars per call −1,264 [−3,008, +480] |
| | | output tokens per call −272 [−671, +126] (both contested as registered; supported post hoc, below) |
| | | nudged −0.007 [−0.240, +0.226] |
| | | crossed a leg boundary −0.126 [−0.388, +0.136] |
| R1, pairs valid in both arms | 58 (29 pairs) | solved +0.207 [−0.036, +0.450]; capped +0.069 [−0.063, +0.200] |
| R2, hosted gnomon cells (r1, r1h, r3r C arms) | 81 | **refused, DESIGN_CHECK_FAILED**: replay never varies (0 in all) |
| R3, hosted harnesses: P1H gnomon v0.3.1 vs opencode V2, deepseek-v4.1-flash | 95 | **refused, POSITIVITY**: replay is a function of the harness |
| R4, transport of R1 to hosted | — | not identifiable here; the kernel has no transport analysis (stated in the plan) |
| R5, hosted mediators, C2D run level | 4 runs | **refused, LOW_N** |

**Confounders on hosted lanes.** The harness bundle: replay moves only with the harness, together with the system
prompt, tools, window, nudges and compaction.

**What differs between R1's population and the hosted problem:**
- the model;
- who renders `reasoning_content` (llama.cpp's template vs the provider);
- reasoning effort;
- the cap (900 s vs 1,800 s);
- the build;
- the task set.

**Mechanism.** Replay changes how the model spends its tokens:
- it reasons on almost every call instead of a third;
- it reasons fewer characters per call (point estimate);
- it takes fewer calls (point estimate).

Calls to convergence is the plausible path to more solves, but no mediation analysis is identified at n = 61. The two
`contested` mediator results failed only `load_start1 ⊥ Y` (r = 0.46 and 0.51), an edge my graph omitted. Re-run with
`load_start1 -> Y` (Amendment 2, post hoc), both are supported with identical estimates.

### W, the context window

| analysis | units | result |
|---|---|---|
| W1, declared window (`max_context_tokens`) | 398 | **refused, DESIGN_CHECK_FAILED**: 65,536 in all 679 TB surfaces; no endpoint ever declared its own |
| W2(i), trim exposure (crossed ≥ 1 leg boundary), latent stuckness | 398 | **refused, NON_IDENTIFIABLE** for both `solved` and `capped` |
| W2(ii), the same adjusting for total calls | 398 | **refused, POSITIVITY**: 74.6% of propensities outside [0.01, 0.99]. The exposure is a threshold of length |
| W2(iii), corrected graph (calls partly post-treatment, Amendment 1) | 398 | **refused, NON_IDENTIFIABLE** |
| W3, C2D wire, descriptive only | 4 runs | below |

**Confounders:**
- **Run length.** A trim needs a long run, and long runs are stuck runs.
- **Latent stuckness and task difficulty.**
- **Context size.** File payloads drive both trims and the kind of task.
- **The window itself.** It never varied.

**W3, what the wire shows (C2D, gnomon v0.4.0, 80 calls per run).**
- Discrete context drops (below 0.8× the previous call, the registered rule):
  - one, at call 21 of ontology-kg-querying;
  - none in atrx-vep-crispr.
- **Provider-reported prompt tokens exceed 65,536 on 85 of 156 calls** (max 75,297 and 112,427). So gnomon's
  65,536 budget is not a cap on what the provider counts.
- Late system messages accumulate in history: up to 2 and up to 5 per request.

## Decisions (causal-decision, registered requests)

- Every request: `solved` up, minimum worthwhile effect **0.10**, harm threshold 0, risk medium, reversible, unit
  `(task, attempt) cell`, 48 cells per day.
- The rule for a reported verdict was fixed in the plan: the weaker of the local and hosted verdicts for D-R and D-N,
  and W2(i) for D-W.

| action | evidence → verdict | sized experiment (80% power, α 0.05, two-sided, unpaired) |
|---|---|---|
| **D-R:** turn replay on for hosted endpoints that stream `reasoning_content` | R1 → experiment<br>R3 → experiment | R1: 352 cells per arm, 14.7 days<br>R3: 264 cells per arm, 11.0 days |
| **Verdict D-R** | **experiment** | |
| **D-N:** stop delivering the idle nudge (gate or remove) | N1 (withheld) → experiment<br>N3 → experiment | N1: 391 cells per arm, 16.3 days<br>N3: 387 cells per arm, 16.1 days |
| **Verdict D-N** | **experiment** | |
| **D-W:** declare the model's own window | W2(i) → experiment | 370 cells per arm, 15.4 days |
| **Verdict D-W** | **experiment** | |

**Why each is experiment and not act:**
- **D-R and D-N.** The interval straddles the 0.10 minimum and does not exclude harm. The E-value at the bound is 1.0.
  The interval is 2.05× (R) and 4.27× (N) the effect, against a limit of 1.0×.
- **D-R on R3, D-N on N3, D-W on W2(i).** No estimate (POSITIVITY, POSITIVITY, NON_IDENTIFIABLE). These reasons
  allow an experiment.

**Shown, not used** (the plan fixed this precedence):
- W1 and R2, both DESIGN_CHECK_FAILED, map to **refuse** ("an experiment would not resolve this"). That is wrong for a
  lever that was never varied; see the tool findings.

**Sensitivity:**
- **At a minimum worthwhile effect of 0.05:** still experiment, at 1,407 / 1,562 / 1,479 cells per arm (59–65 days).
- **On `capped` (down, 0.10):**
  - D-N → experiment, 253 per arm;
  - D-W → experiment, 213 per arm;
  - D-R from R1 → **refuse**: the interval [−0.18, +0.06] lies below 0.10. This is uninformative about hosted
    timeouts: G0 capped 1 of 29, so a 10-point cut in caps was impossible on that lane.

## What H1 and a factorial must settle

**What H1 changes, and what this analysis offers against it.**
- H1 changes R (on), W (1M) and N (off) together, on hosted v0.4.0. No analysis here identifies that bundle's effect.
- What is offered for comparison is only:
  - **R1:** local replay, sign + (point +0.23, CI touches 0);
  - **N1:** withholding delivered steering, local, sign + (point +0.12, CI wide);
  - **W:** nothing.
- None of this predicts the size of H1's change in caps: local caps were rare.

**What H1's size allows.**
- With 7 pairs, an exact McNemar reaches p < 0.05 only at 6–0 or 7–0 discordant pairs.
- A smaller H1 movement is not evidence of no effect at the 10-point scale.
- A large one cannot be attributed among R, W and N.

**What a factorial would need.**
- A 2 × 2 × 2 factorial over R, N and W, with each main effect estimated from half the cells against half, needs about
  the same total as the largest two-arm size above. That is about **780 cells (≈ 16 days at 48 per day)**, assuming
  the three do not interact; interactions need several times more.
- This is arithmetic on the decision layer's sizes, not a separate tool output.
- **Blocking on task would cut this.** S1's pairs agreed on 26 of 30 and M1a3's on 17 of 29. Neither the kernel nor
  the decision layer has a paired estimator or paired sizing, so every figure above is conservative.
- Cheaper and more informative per cell: measure the mediators in every hosted cell:
  - reasoning tokens per call;
  - calls to convergence;
  - trims;
  - steering delivered.

  The question "which mechanism" is then answered by mechanism, not by the solve rate alone.

## Product findings: where gnomon's own instrumentation blocked identification

1. **Capped runs lose their audit trail.**
   - The trail is copied after gnomon exits, and tb kills the container at the cap.
   - Capped valid-or-not cells without a trail: m2 14/18, s1 10/12, r1 24/32, r1h 11/16, m1 16/20, r3r 8/11.
   - stop_reason, the first nudge step and tool steps are therefore missing exactly where the outcome is "capped".
     That is selection on the outcome. This analysis used gnomon's stdout and the relay meters instead.
   - Fix: flush trail records to the mounted log directory as they are written, or record a final event on
     SIGTERM.
2. **Trims are not recorded.**
   - There is no audit record of a context trim (step, leg, tokens before and after).
   - The turn record's `context_*` fields describe inter-turn context and read 0 in every task run.
   - Trims could be seen only on C2D's wire, in 2 runs.
3. **Reasoning is not recorded.**
   - The turn record keeps `tokens_out` only.
   - Reasoning tokens per call, replay sent or not, and steering sent (and in which role) are not in gnomon's records.
   - The mediator this question turns on is therefore unmeasured outside two special meters.
4. **The hosted meter is blind to mechanisms.**
   - `relay-go` counts tokens and allowance, but no request-body mechanism.
   - On every hosted arm, replay and nudge delivery are unmeasured. Only C2D's log-relay (4 cells) saw them.
   - Whether the provider renders late system messages is unverified.
5. **The window never varied, and the budget is not what the provider counts.**
   - 65,536 is in every surface of every campaign, so W has no observational evidence at all.
   - 85 of 156 C2D calls exceeded it in provider tokens. Either gnomon's estimate undercounts for this tokenizer, or
     parts of the request sit outside the budget. Worth checking before H1's "W = 1M" is read as "the window
     changed by 15×".

## Tool findings: the causal platform

1. **A constant treatment refuses the decision.**
   - "Treatment does not vary" is `DESIGN_CHECK_FAILED`, with empty `missing_information`.
   - `decide` maps it to **refuse** ("an experiment would not resolve this").
   - For a lever never tried, an experiment is the remedy.
   - Suggest a distinct reason (for example NO_VARIATION) in `EXPERIMENTABLE`, with "vary the treatment" as the
     missing information.
2. **No paired or blocked estimator, and no paired sizing.**
   - The randomized estimator is a difference in means that ignores the (task, attempt) pairing, and `decide` sizes
     independent units.
   - Both are conservative here: S1 pairs agreed on 26/30.
3. **No transportability analysis**, so local → hosted can only be stated.
4. **Segments refuse below 30**, correctly. The segment where the nudge acts (idle-prone tasks, 26 cells) is
   refused LOW_N.
5. **The implied-independence refuter sees covariate structure.** It flags omissions in the covariate structure
   (load → outcome; difficulty ↔ idle_prone) and makes the treatment effect `contested`. The post-hoc runs confirm
   the estimates do not move. That is correct behaviour, but the report could say which edge is implicated.

## Deviations and disclosures

- **Not blind.** Outcomes of every source campaign were known before the plan (the plan says so).
- **The amendment header times are approximate.**
  - Amendment 1 reads 12:35Z; its commit `c7f5d0c0` was made at 12:27:02Z, before any estimate.
  - Amendment 2 reads 12:45Z; it was written at about 12:29Z, after the registered run, and committed with the
    results in `becdd75c` at 12:31:52Z.
  - The plan's own commit `1ee43c62` was made at 12:26:08Z.
- **Amendment 2 is post hoc**, written after reading the registered results. It adds three covariate edges, and its
  runs are reported beside the registered ones (`PH_*`).
- **A correction to the plan.** Its inventory said C2D's ontology cell has drops "at calls 21 and 52" (by eye). Under
  the registered 0.8× rule only call 21 qualifies; call 52 is 0.84×. W3 follows the rule.
- **R3's replay coding for opencode is imputed** from C2D's wire (about 95%); P1H did not measure it.
- **N3's "delivered" on hosted assumes** the provider renders late system messages (unverified).
- **r3r was in progress**: a snapshot of 55 valid cells taken at extraction, ~12:22Z.
- **Re-running `analysis.py` reproduces** all 49 registered output rows identically (checked).

## Reproduce

```bash
cd benchmarks/results/causal-2026-11
python3 -I extract.py                                              # data/*.csv (read-only over campaigns)
~/Desktop/causalplatform/backend/.venv/bin/python -I analysis.py   # outputs/, data/frames/
```

causal-core 0.13.0 and causal-decision come from `~/Desktop/causalplatform/packages`, editable in that repository's
`backend/.venv`. The default `AnalysisPolicy` and `DecisionPolicy` are used. No model was called.

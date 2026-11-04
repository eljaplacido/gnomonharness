# Causal analysis of N, W and R from existing campaigns (plan, 2026-11-04)

**Written and committed before any estimate is run.** Nothing in the analysis is run on real data before this file is
committed. Any later change goes in a timestamped amendment at the end; nothing above it is edited.

## What this is, and what it cannot be

On long Terminal-Bench tasks with a hosted model, gnomon v0.4.0 hits the cap where opencode solves. C2D's wire
capture found three harness mechanisms that differ:

- **R, reasoning replay.** opencode sends `reasoning_content` back on about 95% of calls; gnomon on 0%.
  `replay_reasoning` is off unless the endpoint is api.deepseek.com.
- **N, the idle nudge.** After `nudge_after_idle` (12) calls without a file change, gnomon injects a system message
  telling the model to act. It persists in history.
- **W, the context window.** gnomon budgets 65,536 tokens and trims its working context; opencode keeps 160k or more.

C2D's single-call replay (do() on one call, state held fixed) found no direct effect of R, N, sampling or the system
prompt on that call's output length. Any effect is therefore indirect, through the trajectory. This analysis asks what
the existing campaigns can identify about each mechanism's effect on:

- (a) the cap (`capped`);
- (b) `solved`;
- (c) the mediators: reasoning per call, and calls to convergence.

Where the data cannot identify an effect, the answer is the kernel's typed refusal. No estimate is substituted for it.

**Not blind.**

- Every outcome in these campaigns has been seen by the team: S1 (19/30 vs 16/31), M1a3 (25/32 vs 16/29), and the
  others in their summaries.
- While building the inventory below, the analyst also saw per-group solved, capped, nudged and leg counts.
- What this plan fixes in advance is therefore narrower. It fixes the questions, graphs, variables, adjustment sets,
  estimands, decision thresholds and the rule for reading refusals. It does not fix ignorance of the outcomes.

**Held out.**

- H1 (`h1-2026-11/`: v0.4.0 vs v0.4.0 + R on, W = 1M, N off; 7 tasks, paired, hosted) is running now and is not read.
- Neither its `runs/` nor its `STATUS.txt` is opened, and `extract.py` asserts that no input path names it.
- These estimates are committed before H1's results are read, so the two can be compared.

## Tools

- **Kernel:** causal-core 0.13.0 (`~/Desktop/causalplatform/packages/causal-core`), with `cc.analyze` → result,
  refusal or apparatus_failure, and `cc.report`.
- **Decision layer:** causal-decision (`packages/causal-decision`), with `decide` → act, act_with_approval,
  experiment or refuse, plus a sized experiment.
- **Environment:** the existing `backend/.venv` of that repository. It imports both packages from their local paths
  (editable). Nothing is installed and the repository is not modified.
- **No model calls of any kind.** The kernel runs without an LLM. Kernel policy is the default `AnalysisPolicy()`
  (seed, alphas, refuters and overlap checks as shipped).

## Data (inventory, 2026-11-04 ~12:30Z)

`extract.py` builds the tidy frames in `data/`.

- It reads only files the runs wrote.
- Validity comes from M1's `collect_m1.parse_cell`, imported unchanged, the function every campaign below was judged
  with.
- Only `state == valid` cells enter an analysis.

| frame | rows | source |
|---|---|---|
| `data/cells.csv` | 571 TB cells | s1, m1 (`runs/`, `runs-a3/`), m2, r1, r1h, r3r (in progress; a snapshot) |
| `data/c2d_calls.csv` | 276 calls | C2D stage-1 wire logs: 4 cells (gnomon v0.4.0 and opencode V2 × 2 tasks) |
| `data/p1h_cells.csv` | 240 cells | P1H summary (`peers-summary.json`): gnomon v0.3.1, opencode, goose, mini, qwen on deepseek-v4.1-flash |

Valid cells per group and arm (TB 0.2.18, the 16-task sample × 2 attempts, 900 s cap):

| group | arm | valid | model / host | build | varies |
|---|---|---|---|---|---|
| s1-s0 / s1-s1 | L | 30 / 31 | qwen3.6-35b, local (gx10 lane) | 8078df03 | **steer_role system / user**, concurrent |
| m1a3-g0 / m1a3-g1 | L | 29 / 32 | glimmer-30b, local (hub) | 166a9d3c | **replay_reasoning false / true**, concurrent |
| m1a-glim, m1a-q38, m1b-fnx | L | 28, 20, 31 | local | d59e6c19 | reference |
| m2-fnx, m2-q36g | L, PC | 32+26, 31 | local | v0.4.0 be4fc0d8 | reference |
| r1, r1h | L, C, PC | 30/32/31, 32/32/30 | L/PC local qwen3.6; **C hosted deepseek-v4.1-flash** | d59e6c19 | reference |
| r3r | L, C, PC | 18, 17, 20 | as r1h | v0.4.0 | reference (in progress) |

**What exists per cell, and where.**

- **Relay meters (`tokens.json`), every cell including capped ones.**
  - Calls: `chat_requests`.
  - Prompt and completion tokens.
  - Request-body mechanism counters, on the s1, m1a3, m2 and r3r *local* meters only:
    - reasoning replayed (`req_with_reasoning_content`);
    - late system messages;
    - template-dropped system messages;
    - `[gnomon]` notes;
    - nudges sent dropped or as notes.
  - Reasoning in replies (`responses_with_reasoning`, `response_reasoning_chars`), on the m1a3 meters only. S1's lane
    runs with reasoning off.
  - The cloud meter (`relay-go`) records **no** mechanism counter and no reasoning. On hosted lanes R, N delivery and
    reasoning per call are therefore unmeasured outside C2D's 4 wire-logged cells.
- **gnomon's stdout (`agent-logs/gnomon-full.log`), present for capped cells too.**
  - Idle nudges fired: `[tools] N call(s) without changing a file — nudging to decide`. They agree with the audit
    trail's `counters.nudges` in 345/345 single-role valid cells where both exist.
  - Leg crossings: `[tools] a/b calls — continuing (leg n)`.
  - Stall stops.
- **gnomon's audit trail (`agent-logs/audit/*.jsonl`): missing for most capped cells.**
  - Examples: m2 14 of 18 capped cells, s1 10/12, r1 24/32, r1h 11/16, m1 16/20, r3r 8/11.
  - The trail is copied out after gnomon exits, and tb kills the container at the cap.
  - So trail-only variables (stop_reason, first nudge step, tool steps) are missing exactly where the outcome is
    `capped`, a selection on the outcome. They are **not** used as treatments, confounders or mediators here; the
    log and the meters are.
- **The surface (`surface-config.toml`).**
  - `max_context_tokens = 65536` in **every one** of the 679 TB surfaces across all campaigns.
  - No endpoint block declares a window.
  - `replay_reasoning = true` appears only in m1a3-g1.
- **The C2D wire, gnomon cells:**
  - provider prompt tokens reach 75k–112k;
  - discrete context drops (prompt tokens below 0.8× the previous call's) occur at calls 21 and 52 of one cell and
    nowhere in 80 calls of the other;
  - late system messages accumulate from 0 to 2 (atrx) and 0 to 5 (ontology) per request.

## Variables (defined now)

| name | definition |
|---|---|
| `solved` | tb `is_resolved` (valid cells) |
| `capped` | tb `failure_mode == agent_timeout` (the 900 s cap) |
| `calls` | meter chat requests in the cell (local meter for L arms, cloud for C). For capped cells it is censored by the cap; reported as is, never imputed |
| `out_per_call` | completion tokens / chat requests (meter) |
| `reasoning_per_call` | reply reasoning chars / chat requests (m1a3 meters only) |
| `reasoning_share` | replies with reasoning / chat requests (m1a3 meters only) |
| `nudged` | ≥ 1 idle-nudge line in gnomon-full.log |
| `legs2` | gnomon-full.log shows ≥ 1 leg crossing (`log_max_leg ≥ 2`): the run went past the first leg boundary, where context is checkpointed and trimmed |
| `difficulty` | leave-campaign-out task failure rate: 1 − solved share of that task over valid cells of every **other** campaign in `cells.csv`. A pre-treatment, outcome-of-other-campaigns prognostic score |
| `idle_prone` | leave-campaign-out share of single-role valid cells of that task with `nudged`, ≥ 0.5 → 1. Pre-treatment for the campaign analysed |
| `load_start1` | 1-min load average at cell start (`load.json`): a negative-control outcome. No arm can change the load at its own start |

## Questions, graphs and anticipated identification

Graph syntax is the kernel's. `U` is a latent run-level "stuckness" (how far the model is from a solution path at a
given point). Difficulty is only its task-level proxy.

### N, the idle nudge

The nudge is endogenous. It fires deterministically when the idle condition holds, and the idle condition is caused by
the same stuckness that causes failure. Within one configuration, "nudged vs not nudged" has no exogenous variation.
The only exogenous variation in existing data is in **delivery**: S1 randomised the delivery format on a lane whose
template drops system messages.

- **N1 (primary, identified): S1, delivery of steering.**
  - Units: valid S1 cells. Treatment `delivered` = 1 for s1-s1 (`[gnomon]` user notes), 0 for s1-s0 (system
    messages the template drops).
  - `design="randomized"`, graph `delivered -> Y; difficulty -> Y`.
  - Justification for the randomized certificate: every (task, attempt) runs in both arms, concurrently, with a
    bounded lead of 1, the same order, build, lane and window. The arm cannot depend on the task's potential outcomes.
    Residual differences are host timing only.
  - Estimand: ATE (intention-to-treat of delivery over all cells, including cells where no steering fired).
  - Outcomes: `solved` (primary), `capped`, `calls`, `out_per_call`. `reasoning_per_call` is not applicable (reasoning
    off on this lane).
  - Declared segment: `idle_prone`.
  - Negative-control outcome: `load_start1`.
  - Secondary: the same on (task, attempt) pairs valid in both arms.
  - For the decision, the treatment is recoded as `withheld` = 1 − `delivered`, so the action "do not deliver the
    nudge" reads in its own direction.
- **N2 (observational, within configuration): nudged vs not.**
  - Units: valid single-role cells (L and C arms) of every campaign except s1-s1.
  - (i) **Rule-explicit graph:**
    `difficulty -> idle; idle -> nudged; idle -> Y; difficulty -> Y; nudged -> Y`, with `idle := nudged` (the rule
    makes them the same column). Anticipated: **POSITIVITY**.
  - (ii) **Honest graph:**
    `latent U; U -> nudged; U -> Y; difficulty -> nudged; difficulty -> Y; nudged -> Y`. Anticipated:
    **NON_IDENTIFIABLE**.
  - Outcomes: `solved`, `capped`.
- **N3 (observational, across lanes): delivered vs dropped.**
  - Units: valid single-role cells with `nudged` = 1, excluding S1.
  - `delivered` = 1 on hosted C arms (deepseek-v4.1-flash). This assumes the provider renders late system messages;
    no cloud meter or probe verifies that.
  - `delivered` = 0 on local qwen/glimmer/fnx lanes, whose templates drop them (meter-verified on m2 and r3r; the
    template finding in M1 Amendment 5 and S1 otherwise).
  - Graph: `model -> delivered; model -> Y; difficulty -> Y; delivered -> Y`, with `model` measured. Anticipated:
    **POSITIVITY**, because delivery is a function of the model and its template.
  - Outcomes: `solved`, `capped`.

### R, reasoning replay

- **R1 (primary, identified): M1a3, G1 vs G0.**
  - Units: valid m1a3 cells. Treatment `replay` = 1 for g1.
  - `design="randomized"` on the same justification as N1: concurrent, bounded lead 1, one config line apart, same
    build 166a9d3c.
  - Graph: `replay -> Y; difficulty -> Y`. Estimand: ATE.
  - Outcomes: `solved` (primary), `capped`, `calls`, `out_per_call`, `reasoning_per_call`, `reasoning_share`.
  - Declared segment: none. Negative-control outcome: `load_start1`.
  - Secondary: the same on pairs valid in both arms.
  - Population: Glimmer-30B on llama.cpp, a template that renders `reasoning_content`, reasoning effort "high",
    900 s cap.
- **R2 (hosted gnomon): every hosted C cell (r1, r1h, r3r) has replay = 0.**
  - Graph: `replay -> Y; difficulty -> Y; difficulty -> replay`. Anticipated: **DESIGN_CHECK_FAILED** (the treatment
    does not vary).
- **R3 (hosted, across harnesses): P1H, gnomon v0.3.1 vs opencode V2, both on deepseek-v4.1-flash.**
  - `replay` := 1 for opencode, 0 for gnomon. opencode's replay is taken from C2D's wire (about 95% of calls); P1H
    did not measure it.
  - Graph: `harness -> replay; harness -> Y; replay -> Y; difficulty -> Y`. `harness -> Y` stands for everything
    else the harness bundles: prompt, tools, window, nudges, compaction.
  - Anticipated: **POSITIVITY**, because replay is a function of the harness.
  - Outcome: `solved`.
- **R4 (transport of R1 to hosted endpoints): not identifiable from these data, and not a kernel capability.**
  - The kernel has no transportability analysis.
  - The populations differ in:
    - the model;
    - who renders `reasoning_content` (llama.cpp's template vs the provider);
    - reasoning effort;
    - the cap (900 s vs P2G's 1,800 s);
    - the build;
    - the task set.
  - This is stated, not estimated.
- **R5 (hosted mediators): C2D at the run level.**
  - Units: 4 runs. Treatment `replay_share`, opencode ≈ 0.95 vs gnomon 0. Outcome: mean reasoning tokens per call.
  - Graph: `harness -> replay; harness -> Y; replay -> Y`. Anticipated: **LOW_N** (n = 4).
  - The 276 calls are not independent units, and the kernel has no clustered observational design, so the
    call-level series is reported descriptively only.

### W, the context window

- **W1 (declared window).**
  - `max_context_tokens` is 65,536 in every cell, so `big_window` = 0 everywhere.
  - Graph: `big_window -> Y; difficulty -> Y; difficulty -> big_window`. Anticipated: **DESIGN_CHECK_FAILED**.
- **W2 (trim exposure): `legs2` on valid single-role cells.**
  - (i) **Honest graph:** `latent U; U -> calls; calls -> legs2; legs2 -> Y; U -> Y; difficulty -> U`. A run reaches
    the leg boundary because it is long, and it is long because it is stuck. Anticipated: **NON_IDENTIFIABLE**.
  - (ii) **With `calls` measured as the adjuster:** `calls -> legs2; calls -> Y; legs2 -> Y; difficulty -> Y`.
    `legs2` is a threshold function of `calls`. Anticipated: **POSITIVITY**.
  - Outcomes: `solved`, `capped`.
- **W3 (C2D call level), descriptive only.**
  - Where discrete trims occur on the wire, and reasoning tokens per call before and after.
  - The same two reasons as R5 rule out a kernel estimate.

### Refutations

Every kernel result carries the kernel's own:
- placebo treatment;
- implied conditional independences;
- the negative-control outcome where declared;
- triangulation across estimators;
- E-value sensitivity;
- for binary treatments under back-door, the Rosenbaum bound.

A failed refuter makes a result `contested`. That status is reported, and the decision layer reads it.

### Reading rules (fixed now)

1. A refusal is reported with its reason, its detail and its `missing_information`. No naive estimate is given beside
   it. Raw descriptive counts may be shown in the inventory, labelled as associations.
2. An `apparatus_failure` caused by this analysis's own input formatting is fixed and re-run, and the fix is logged in
   `REPORT.md`. Any other apparatus failure is reported as is.
3. An anticipated refusal type is a statement about the design (constant treatment, deterministic rule, latent
   confounder), not about outcomes. If the kernel returns something else, that is reported, not overridden.
4. Primary outcome per question: `solved`. Everything else is secondary. No multiplicity correction is applied across
   the secondary outcomes; they are read as mechanism evidence.
5. The kernel estimate is a difference in means (randomized), or AIPW (back-door). The kernel has no paired or
   blocked randomized estimator. The pairing of (task, attempt) across arms is therefore not used by the primary
   estimator, which is conservative when pairs are positively correlated. `difficulty` enters through the kernel's
   regression and AIPW cross-checks.

## Decisions (causal-decision), fixed now

Three candidate default changes. Each `DecisionRequest` uses:

| field | value |
|---|---|
| outcome | `solved` |
| direction | increase |
| minimum_worthwhile_effect | **0.10** (10 points of solve rate) |
| harm_threshold | 0.0 |
| risk_class | medium (a default ships to every user) |
| reversible | true (a config default) |
| can_randomize | true |
| randomization_unit | `(task, attempt) cell` |
| units_per_day | 48 (one hosted lane, 2 slots, 1,800 s cap, with turnaround) |

The policy is the default `DecisionPolicy()`.

**Sensitivity, reported beside the primary:**
- MWE 0.05;
- outcome `capped` with direction decrease and MWE 0.10.

| action | evidence passed to `decide` | verdict reported |
|---|---|---|
| **D-R:** turn replay on for hosted endpoints that stream `reasoning_content` | R1, transported by assumption, and R3, the hosted refusal | the weaker of the two verdicts (severity act < act_with_approval < experiment < refuse); both shown |
| **D-N:** gate or remove the idle nudge | N1 with treatment `withheld` (local), and N3 (hosted refusal) | the weaker of the two; both shown |
| **D-W:** declare the model's window | W2(i), the trim exposure (the mechanism the action removes) | W2(i)'s verdict; W1's is also shown |

For D-W, W1's refusal is shown but does not set the verdict. A constant treatment says nothing about the action's
effect, only that the data never varied it. The decision layer maps `DESIGN_CHECK_FAILED` to refuse ("an experiment
would not resolve this"), a rule written for broken designs (sample-ratio mismatch, missing data). For a lever that
was never varied, an experiment is exactly the remedy. Fixing this precedence now keeps it from being chosen after
seeing the verdicts. The same reasoning is why R2 is reported but not passed to D-R.

Where a verdict is `experiment`, the sized trial is reported: units per arm and days at 48 units per day. When the
evidence is a refusal without an outcome SD, `decide` sizes nothing, and that is reported as such. It is then
compared with what H1 (7 paired tasks) and a 2×2×2 factorial over R, N and W would need.

## What H1 can and cannot be compared against

- H1 changes R, W and N together on hosted v0.4.0. No analysis here identifies that bundle's effect.
- The comparison is therefore qualitative:
  - **R1:** the sign and the interval of replay's local effect;
  - **N1:** the sign and the interval of withholding delivered steering;
  - **W:** a refusal.
- If H1 moves, the observational data cannot attribute the move among R, W and N. A factorial (or at least
  one-factor-at-a-time arms) is what can.

## Files

- `extract.py`: frames (read-only over campaigns).
- `analysis.py`: every kernel and decision call in this plan. It writes `outputs/*.json` (raw kernel and decision
  outputs), `outputs/*.txt` (`cc.report` and `explain`), and `data/frames/*.csv` (the exact frame each call saw).
- `REPORT.md`: results, refusals, confounders, product findings and a plain-language summary.

## Amendment 1, 2026-11-04T12:35Z: W2's adjuster; before any estimate

Re-reading W2 before any kernel call on real data found two points.

**1. Total `calls` is partly post-treatment.**

- The calls a run makes after the first leg boundary are themselves an effect of what happened there (the trim), so
  the cell's total `calls` is a descendant of `legs2`.
- W2(ii) adjusts for it, which conditions on a descendant of the treatment. Its anticipated POSITIVITY refusal would
  be the right outcome, but even if positivity held, the adjustment would be biased.
- W2(ii) is kept as registered.
- A corrected graph is added as **W2(iii)**:
  `latent U; difficulty -> U; U -> legs2; U -> Y; legs2 -> calls; U -> calls; calls -> Y; legs2 -> Y`, with `calls`
  measured. Anticipated: **NON_IDENTIFIABLE**. The decision for D-W still reads W2(i), as registered.

**2. W2(i)'s frame omits `calls`.**

- (ii) is the case "with `calls` measured as the adjuster", so in (i) `calls` is a graph node with no data column,
  which the kernel treats as unmeasured.
- This was the intent; it is stated here so that it is not chosen after the fact.

**Kernel features checked on synthetic data only:**
- `negative_control_outcomes` and `segment_by` under `design="randomized"`;
- the refusals for a constant treatment (DESIGN_CHECK_FAILED), a deterministic rule (POSITIVITY) and a latent
  confounder (NON_IDENTIFIABLE).

Nothing else changes.

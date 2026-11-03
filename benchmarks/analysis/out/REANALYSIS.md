# Re-analysis of finished campaigns: ST1, ST3, ST4, ST6, ST10

No new runs and no compute spend. Every number below is recomputed from the
committed summary JSONs under `benchmarks/results/` (read-only, results repo
commit `4eebeb2d`) by the tools in `benchmarks/analysis/`. The tables these
numbers come from are in [`TABLES.md`](TABLES.md), and the claim-by-claim
binding is in [`CLAIMS.md`](CLAIMS.md). Both are generated; this file is the
reading of them.

**Bottom line.**
- **Quality claims hold as "no difference shown", and nothing stronger.** At 16 tasks × 2 attempts, the minimum detectable effect is 19–27 points. Hybrid is non-inferior to cloud-only only at a margin of ≥14 points on the RTX 5090 and ≥25 on the GB10. No published quality claim says "better", so none needs retracting. "A tie" overstates what the data show.
- **Of the cost claims, only the token claims and LEAN survive their intervals.** Hybrid's −60% cloud tokens per solved task holds (95% CI −74% to −21%), and so do all three LEAN cost numbers. The hybrid dollar claims (−26% RTX 5090, −20% GB10) are point estimates whose intervals include no saving. On the GB10, pricing the local GPU's time at amortised hardware cost turns the saving into a ~1.9× higher cost.
- **The −26% and the per-cell sign test (p = 0.86) are not in conflict.** Hybrid is 0.2–0.8× cloud's cost on the 7 costliest tasks and 1.8–5.9× on 6 of the 7 cheapest. The ratio of totals is driven by the costly tasks. The sign test counts directions and sees a near-even split: 16 of 30 cells, 8 of 16 tasks.
- **Three published numbers are stale:** Flash-Next 16 vs 13 and 4 vs 3 capped, and llms.txt's "1.3–1.7×". One is rule-dependent: GB10 56/72/66 becomes 60/72/68 under the outage rule that R1H, M1 and S1 apply.
- **The report's S1 interim figure has moved.** "3/7 vs 8/9, p ≈ 0.11" now reads 16/28 vs 19/27 (p = 0.40) on S1's latest snapshot. The gap shrank from −43 to −16 points.

---

## 1. Headline claims

Intervals are 95%. Quality differences are per-task, attempt-averaged (B − A,
points), with a task-cluster bootstrap and an exact sign-flip interval. Cost
ratios are ratios of totals per solved task (B/A), with a paired task-cluster
bootstrap. "NI" is non-inferiority of B against A. It holds only when the
bootstrap lower bound exceeds −m *and* a one-sided sign-flip test of
H0: Δ ≤ −m gives p < 0.025. The margins (5 and 10 points) are declared here,
post hoc. No campaign pre-registered one, so the verdicts are descriptive.
Bayes: hierarchical logistic / log-normal models, population-averaged over
tasks (§4). e-process: the anytime-valid replay in run order (§5); "stop" means
the evidence reached e ≥ 20.

| Claim (where published) | Published | Re-analysis | NI | Bayes | e-process | Verdict |
|---|---|---|---|---|---|---|
| Hybrid vs cloud quality, RTX 5090 (site KPI, §8 IV, llms, deck) | 87% vs 84%, "inside noise" | Δ +0.0 [−12.5, +12.5]; sign-flip [−14.3, +14.2]; McNemar 2/1 p = 1.0 | @5 no, @10 no; holds at ≥14 pts | Δ +0.7 [−9.3, +10.7]; P(≥ −5) 0.88, P(≥ −10) 0.98, P(> 0) 0.56 | 3 discordant pairs, e = 0.75; NI(10) e = 2.1 of 40; never stops | Holds as "inside noise"; not a tie |
| Hybrid vs cloud quality, GB10 (§8 IV, deck) | 66% vs 72% | Δ −6.2 [−25.0, +9.4]; McNemar 2/4 p = 0.69 | @5 no, @10 no; holds at ≥25 pts | Δ −0.3 [−12.0, +10.7]; P(≥ −5) 0.80, P(≥ −10) 0.95 | e = 0.70; never stops | Holds as "inside noise" |
| Pooled across both machines (new, ST3) | none | n/a | n/a | pooled Δ +0.2 [−10.7, +10.0]; P(≥ −5) 0.85, P(≥ −10) 0.97; for a new machine 0.81 / 0.94; wide priors 0.76 / 0.92 | n/a | Probable non-inferiority at 10 pts, not at 5 |
| −26% $/solved, RTX 5090 (site KPI, §8 IV, llms, deck) | −26% | ratio 0.74 [0.52, 1.26]; P(ratio < 1) 0.88 (bootstrap); per-task geometric mean 1.18 [0.76, 1.80]; cell sign test 16/14 p = 0.86 | n/a | ratio 0.86 [0.52, 1.27]; P(ratio < 1) 0.78 | sign stream e = 0.13; relative-difference e = 0.8; never stops | **Stronger than the evidence** |
| −60% cloud tokens/solved, RTX 5090 (site KPI, llms, deck) | −60% | ratio 0.40 [0.26, 0.79]; cell sign 19/11 p = 0.20; per-task mean difference −0.46 M tokens/cell, sign-flip p = 0.04 | n/a | ratio 0.37 [0.16, 0.66]; P(ratio < 1) 1.00 | e = 0.80; never stops | **Holds** (interval excludes 1) |
| Hybrid 1.3× slower, RTX 5090 (§8 IV, §9, deck) | 1.3× | median ratio 1.33 [0.59, 3.10]; per-task geometric ratio 1.35, sign-flip p = 0.09; capped 8 vs 6 | n/a | n/a | n/a | Direction only; disclose as "about 1.3×, not significant" |
| GB10 local / cloud / hybrid (§8 IV, deck) | 56 / 72 / 66% | reproduces under R1's own rule; 60 / 72 / 68 under the outage rule (3 cells) | — | — | — | Rule-dependent; name the rule |
| −20% $/solved, GB10 (§8 IV, llms, deck) | −20% | ratio 0.80 [0.56, 1.18]; per-task geometric mean 1.03 [0.67, 1.59]; sign 16/16 p = 1.0; **incl. GPU at amortised cost 1.93 [1.35, 3.05]** | n/a | ratio 1.01 [0.60, 1.61], P(< 1) 0.54; with amortised GPU 2.61 [1.51, 4.22], P(< 1) 0.00 | e = 0.07; never stops | **Stronger than the evidence**; reverses when local GPU time is priced |
| Hybrid 1.8× slower, GB10 (§8 IV, §9, deck) | 1.8× | median ratio 1.78 [1.06, 4.54]; per-task geometric ratio 1.86, sign-flip p < 0.001; capped 12 vs 7 | n/a | n/a | n/a | **Holds** |
| "The cost saving held on both machines" (§8 IV) | held | point estimates < 1 on both; both intervals include 1 | n/a | P(<1): 0.78 (RTX 5090), 0.54 (GB10) | — | **Stronger than the evidence** |
| Glimmer replay 78% vs 55%, stalls 9 → 0 (§10, llms, deck) | 78 / 55; paired 22 vs 16, p = 0.15 | Δ +20.0 [−6.7, +50.0], sign-flip p = 0.27; stalls 9 → 0 reproduces | n/a | Δ +13.8 [−1.3, +30.6]; P(replay helps) 0.97 | 12 discordant (9/3), e = 2.4; never stops | Holds as worded ("p = 0.15, inside noise"); stalls 9 → 0 is the claim to lead with |
| Qwen3.8-27B trailed 10 vs 15, 20 cells (§8 V, deck) | 10 vs 15 | Δ −25.0 [−46.9, −6.2]; sign-flip [−50.0, 0.0] p = 0.06; McNemar 0/5 p = 0.06 | n/a | Δ −12.5 [−28.3, +2.0]; P(> 0) 0.04 | e = 3.8; never stops | Holds as "trailed"; add "20 of 32 cells, run stopped by the operator" |
| Flash-Next 16 vs 13 paired (§8 V, deck) | 16 vs 13; capped 4 vs 3 | **finished R1: 20 vs 17 on 29 pairs, p = 0.375; capped 8 vs 5**; Δ +9.4 [−6.2, +28.1] | n/a | Δ +5.6 [−5.8, +17.6]; P(> 0) 0.85 | e = 1.3; never stops | **Stale**; same decision (incumbent wins) |
| LEAN −33% $/solved (site §8 II, §10, deck) | −33% | ratio 0.67 [0.48, 0.88]; per-task geometric mean 0.64 [0.47, 0.81]; sign 41/7 p < 0.001 | n/a | ratio 0.61 [0.46, 0.77]; P(< 1) 1.00 | **stops at 38% of the budget** | **Holds** |
| LEAN −28% output tokens (site, deck) | −28% | total ratio 0.72 [0.59, 0.85] (per solved 0.66 [0.48, 0.87]); sign 41/7 | n/a | — | **stops at 38%** | **Holds** (it is a total over all cells, not per solved) |
| LEAN 37 vs 34 solved (site, deck) | 37 vs 34 | Δ +6.2 [−4.2, +20.8]; McNemar 5/2 p = 0.45 | @5 no, @10 yes; holds at ≥6 pts | Δ +5.0 [−4.8, +15.0]; P(≥ −5) 0.98, P(> 0) 0.85 | e = 0.98; NI(10) e = 3.5 of 40 | Holds as "not significant"; non-inferior at 10 pts |
| P1-H: gnomon 75.0% vs peers 79–85%, "ties its peers" (site KPI, §8 II, llms) | p = 0.22–0.77 | peer − gnomon Δ from +4.2 to +8.3; upper bounds +17 to +25 | gnomon is non-inferior to a peer only at margins of 17–25 pts | peer − gnomon +1.4 to +5.3; P(peer better) 0.61–0.86; P(\|Δ\| < 5) 0.45–0.66 | no quality stream stops; **mini's token saving stops at 45%** | "No significant gap" holds; "**ties**" is stronger than the evidence |

### Recommended rewording

Where the published wording is stronger than the evidence:

- **Hybrid KPI tile (RTX 5090).** Replace "26% cheaper per solved task" with: "87% solved vs 84% cloud-only, inside noise, with 60% fewer cloud tokens per solved task (95% CI 21–74% fewer). The cloud bill per solved task was 26% lower in total, but its interval runs from 48% lower to 26% higher, and the local GPU's time is not counted."
- **§8 IV note.** Replace "The cost saving held on both machines" with: "Hybrid cut cloud tokens per solved task on both machines (both intervals exclude no change). The dollar saving is a point estimate on both machines, and neither interval excludes no saving. The saving comes from long, context-heavy tasks. On most short tasks the planner's overhead makes hybrid cost 2–6× more. Counting the local GPU at amortised hardware cost, hybrid costs about the same as cloud-only on the RTX 5090 (0.91×, CI 0.62–1.55) and about 1.9× on the GB10."
- **Time.** Replace "1.3× slower" with "about 1.3× slower on the RTX 5090 (not significant at 16 tasks), 1.8× on the GB10 (significant)". In llms.txt, replace "1.3–1.7×" with "1.3–1.8×".
- **"On task completion gnomon ties its peers"** (llms) and **"a tie with the field"** (KPI). Replace with "no significant gap to any peer. At 16 tasks the data cannot rule out gaps of up to 17–25 points in the peers' favour."
- **Flash-Next (§8 V).** Replace "16 vs 13 … (4 vs 3)" with "20 vs 17 on 29 paired cells (p = 0.375), but it lost the pre-set rule on time-capped cells (8 vs 5)".
- **GB10 row.** Add "R1's pre-registered validity rule. Under the endpoint-outage rule applied to R1H, the row reads 60 / 72 / 68".
- **The ~12-point A/A spread** (§8 II, report). It is still "within noise" (paired p = 0.22). For a re-run of the *same* tasks, though, the binomial expectation is an SD of about 6.6 points, not 10. The observed 12.5 points sits at z ≈ 1.9, so it is on the high side. Host speed against the 900 s cap, or drift in the hosted model, are candidate causes worth a look.

## 2. Why "−26% per solved task" and the paired sign test (p = 0.86) differ

They answer different questions, and on R1H both are right.

| Estimand | What it asks | R1H value |
|---|---|---|
| Ratio of totals, $ per solved (published) | Over this task mix, what does a solved task cost on the cloud bill? | 0.74, 95% CI [0.52, 1.26] |
| Cell-level paired sign test (collector) | In how many (task, attempt) pairs did hybrid spend less? | 16 of 30, p = 0.86 |
| Per-task geometric mean ratio | What is the typical task's cost ratio? | 1.18 [0.76, 1.80] |
| Per-task mean difference, $ per cell | What is the average saving per attempt? | −$0.010 [−0.026, +0.003], sign-flip p = 0.23 |

The per-task breakdown shows the mechanism (`paired.py` cost block, R1H C → PC, $ per cell):

| Task group (by cloud-only cost) | Cloud-only $ per cell | Hybrid / cloud |
|---|---|---|
| 7 costliest (parallelize-graph, sparql-university, mailman, polyglot-c-py, install-klee-minimal, tune-mjcf, git-workflow-hack) | $0.03–0.19 | 0.18–0.76 |
| 2 middle (hf-train-lora-adapter, hf-lora-adapter) | $0.01–0.03 | 1.12–1.43 |
| 7 cheapest (pypi-server, fix-code-vulnerability, broken-python, jq-data-processing, acl-permissions-inheritance, prove-plus-comm, pandas-sql-query) | < $0.013 | 0.90–5.89 |

The three costliest tasks carry 55% of cloud-only's spend.
- **On heavy tasks**, hybrid saves real money: the local builder absorbs the long tool-output context that cloud-only pays for.
- **On light tasks**, the cloud planner's fixed overhead dominates. A $0.003 task becomes $0.009–0.013.

The ratio of totals weights by spend, so the heavy tasks decide it. The sign test weighs each cell equally, so it sees 8 tasks cheaper and 8 dearer. Neither test is wrong.

The inferential question behind "cheaper per solved task" is the ratio of totals. Its interval includes 1, because with 16 tasks a resample that drops parallelize-graph or sparql-university removes most of the saving. The claim should name the scope: **cheaper on long, context-heavy tasks**. There is a corollary for routing: a hybrid that falls back to cloud-only on short tasks would keep the saving and drop the overhead. That is a hypothesis, untested here.

The same pattern holds on the GB10: ratio 0.80 [0.56, 1.18], typical-task ratio 1.03, sign test 16/16. The cloud-*token* saving is sturdier. Its per-task mean difference is significant (−0.46 M tokens per cell, sign-flip p = 0.04) and its ratio interval excludes 1. Dollars fall less than tokens because hybrid's cut is mostly cached prompt tokens, which are cheap.

## 3. Pricing local GPU time

`gpu_s` is the relay meter's `gpu_ms`: the sum of llama-server `prompt_ms + predicted_ms` per request.

**Price parameters** (`paired.GpuPrice`, overridable):
- **RTX 5090.** $1,999 Founders Edition list price (NVIDIA, Jan 2025), 575 W board power.
- **GB10 / DGX Spark class.** $3,999 list (NVIDIA, Oct 2025), about 0.2 kW under load.
- **Shared assumptions.** A 3-year life, 50% busy duty and $0.20/kWh.

This gives **$0.267 per busy hour** for the RTX 5090 and **$0.344** for the GB10. Two alternatives bracket it:
- energy only (hardware already owned and otherwise idle): $0.115/h and $0.040/h;
- a rental-equivalent price of $0.89/h (2025 list prices for an RTX 5090-class cloud GPU were roughly $0.69–0.94/h).

**Concurrency.** R1H and M1a3 ran two lane slots at once, so per-request server time overlaps. Dividing by the slot count gives a lower bound on exclusive device time. R1 (GB10) ran one slot, so its GPU-seconds are exclusive.

| Comparison | GPU-s per solved, hybrid | $ per solved, hybrid / cloud: cloud bill only | + energy | + amortised | + rental |
|---|---|---|---|---|---|
| R1H (RTX 5090) | 101 (55 for local-only) | 0.74 [0.52, 1.26] | 0.81 [0.57, 1.38] | 0.91 [0.62, 1.55]; per-slot lower bound 0.83 | 1.29 [0.84, 2.26] |
| R1 (GB10) | 565 (281 for local-only) | 0.80 [0.56, 1.18] | 0.93 [0.68, 1.37] | **1.93 [1.35, 3.05]** | 3.71 [2.44, 6.25] |

On the GB10, hybrid used 565 GPU-seconds per solved task. Priced at amortised ownership cost, that alone is $0.054 per solved task, more than cloud-only's whole bill ($0.048). The "−20%" holds only if the GB10's time is free. On the RTX 5090 the claim survives energy pricing as a point estimate, but every interval includes 1.

Hybrid also used more GPU per solved task than local-only on both machines: 1.8× and 2.0× (intervals exclude 1). The cloud planner does not reduce local work; it adds delegation rounds.

## 4. Bayesian companion (ST3)

PyMC and NumPyro are not installed on gx10, so `bayes.py` samples with a hand-written HMC: numpy only, 4 chains × 1,000 warm-up + 1,000 draws, dual-averaging step size and a diagonal mass matrix.

**Validation:**
- gradients checked against finite differences (error < 1e-7);
- the sampler matches quadrature on a one-parameter logistic posterior;
- it recovers a known arm effect;
- quality fits have split R-hat ≤ 1.003 and at most 2 divergent transitions of 4,000;
- cost fits run at target acceptance 0.95 (0.8 diverged on the log-normal funnel) and have R-hat ≤ 1.015 and at most 3 divergent transitions;
- the exception is the wide-prior cost sensitivity, which is marginal (R-hat 1.022, ESS 248, 8 divergent).

**Quality model.** A logistic GLMM:
- task random effects within each machine;
- arm effects pooled across machines through a between-machine SD τ;
- task × arm interaction.

Priors: N(0, 1) on the logit arm effect, HalfNormal(0.5) on τ and on the interaction SD. Reported differences are population-averaged pass-rate differences over tasks.

**Cost model.** A log-normal model with the same task structure and arm-specific residual SDs. The posterior $/solved ratio combines it with the quality model's pass rates.

| Quantity | Mean | 95% CrI | P(>0) | P(≥ −5) | P(≥ −10) | P(\|Δ\| < 5) |
|---|---|---|---|---|---|---|
| Hybrid − cloud, RTX 5090 | +0.7 | [−9.3, +10.7] | 0.56 | 0.88 | 0.98 | 0.70 |
| Hybrid − cloud, GB10 | −0.3 | [−12.0, +10.7] | 0.50 | 0.80 | 0.95 | 0.63 |
| Hybrid − cloud, pooled mean | +0.2 | [−10.7, +10.0] | 0.53 | 0.85 | 0.97 | 0.68 |
| Hybrid − cloud, a new machine (predictive) | +0.2 | [−13.7, +12.3] | 0.53 | 0.81 | 0.94 | 0.61 |
| Hybrid − cloud, pooled mean, wide priors | −0.5 | [−14.6, +12.9] | 0.48 | 0.76 | 0.92 | 0.56 |
| Local − cloud, pooled mean | −7.5 | [−18.4, +2.7] | 0.07 | 0.32 | 0.69 | 0.31 |
| LEAN lean − base | +5.0 | [−4.8, +15.0] | 0.85 | 0.98 | 1.00 | 0.49 |
| BUD budget − base | −0.6 | [−15.6, +13.4] | 0.48 | 0.74 | 0.90 | 0.52 |
| M1a3 replay − no replay | +13.8 | [−1.3, +30.6] | 0.97 | 0.99 | 1.00 | 0.12 |
| M1b Flash-Next − R1 local | +5.6 | [−5.8, +17.6] | 0.85 | 0.97 | 1.00 | 0.44 |
| M1a Glimmer − R1H local | −18.6 | [−34.1, −4.5] | 0.00 | 0.03 | 0.13 | 0.03 |
| M1a5 Qwen3.8-27B − R1H local | −12.5 | [−28.3, +2.0] | 0.04 | 0.16 | 0.39 | 0.15 |

| Cost quantity | Mean | 95% CrI | P(ratio < 1) |
|---|---|---|---|
| $/solved, hybrid / cloud, RTX 5090 | 0.86 | [0.52, 1.27] | 0.78 |
| $/solved, hybrid / cloud, GB10 | 1.01 | [0.60, 1.61] | 0.54 |
| $/solved, hybrid / cloud, pooled | 0.94 | [0.49, 1.58] | 0.68 |
| cloud tokens/solved, RTX 5090 / GB10 | 0.37 / 0.33 | [0.16, 0.66] / [0.14, 0.60] | 1.00 / 1.00 |
| $ + GPU energy only, RTX 5090 / GB10 | 0.96 / 1.19 | [0.59, 1.39] / [0.73, 1.82] | 0.61 / 0.25 |
| $ + GPU amortised, RTX 5090 / GB10 | 1.17 / 2.61 | [0.71, 1.75] / [1.51, 4.22] | 0.27 / 0.00 |
| LEAN $/solved, lean / base | 0.61 | [0.46, 0.77] | 1.00 |
| P1-H $/solved, peer / gnomon 0.3.1 | 0.43 (mini) to 0.84 (qwen) | mini [0.32, 0.56]; qwen [0.65, 1.05] | 0.94–1.00 |

**Reading.**
- **Hybrid quality.** Pooled over both machines, P(hybrid ≥ cloud − 5 pts) = 0.85 and P(≥ −10) = 0.97. Whether hybrid is better at all is a coin flip (0.53). It is probably non-inferior at a 10-point margin, but not convincingly at 5. Wide priors give 0.76 / 0.92. Local-only is probably about 7 points below cloud: P(local ≥ cloud − 5) = 0.32.
- **Hybrid cost.** P($/solved lower) = 0.78 on the RTX 5090, 0.54 on the GB10 and 0.68 pooled. For cloud tokens it is 1.00 on both machines, at a ratio of about 0.35. Pricing GPU time drops P(hybrid cheaper) to 0.61 / 0.25 (energy only) and 0.27 / 0.00 (amortised).
- **Replay (M1a3).** Partial pooling shrinks the +20-point per-task estimate to +13.8, with P(replay helps) = 0.97. That is the strongest quality signal in the set, and it is still short of a frequentist result.
- **LEAN.** P(lean ≥ base − 5) = 0.98, and P(cheaper per solved) = 1.00.
- **P1-H.** P(peer solves more than gnomon 0.3.1) is 0.61–0.86. P(peer cheaper per solved) is ≥ 0.94 for all four peers.

**Two caveats.** With two machines, τ (the between-machine SD of the hybrid effect) is mostly prior: its posterior is 0.36 [0.01, 1.04] (its HalfNormal(0.5) prior has mean 0.40 and 97.5th percentile 1.12) on the logit scale, and the wide-prior sensitivity run is in `TABLES.md`. And the log-normal cost model estimates the *expected* cost per cell over the task population, which weights heavy tasks less than the observed ratio of totals does. Its $/solved ratio is therefore closer to 1 than the published one.

## 5. Anytime-valid replay (ST4)

The betting rule was fixed in `evidence.py`'s docstring before any replay ran, and is the same for every campaign:
- the predictable plug-in λ of Waudby-Smith & Ramdas, truncated at c = 0.5;
- a hedged two-sided capital process, rejecting at e ≥ 20;
- for one-sided non-inferiority, rejection at e ≥ 40;
- futility when the task-level confidence sequence lies inside ±10 points.

Streams are discordant (task, attempt) pairs in the order the later cell finished, valid under the sign-flip null even with clustered attempts. The task-level stream feeds the confidence sequence and the NI e-process.

**ST4's hypothesis:** "replaying LEAN/BUD/R1H/M1 in run order reaches the fixed-n conclusion in all four, and stops ≥ 25% earlier in ≥ 2".

| Campaign, primary endpoint | Fixed-n | e-process | Same conclusion? | Stop |
|---|---|---|---|---|
| LEAN, output tokens per cell (sign) | p < 0.001, reject | e = 8,034, reject | yes | 18th pair, **38% of cells** |
| BUD, lost at the cap (paired) | 1 discordant, p = 1.0 | e = 1.0 | yes | no stop (futility never reached) |
| R1H, PC vs L solved / PC vs C solved | p = 0.22 / 1.0 | e = 1.9 / 0.75 | yes | no stop |
| M1a, Glimmer vs incumbent (decision) | 1/10, p = 0.012, reject | e = 14.4, **does not reject** | **no** | — |
| M1b, Flash-Next vs incumbent | p = 0.375 | e = 1.3 | yes | no stop |

**Verdict: partly falsified.**
- The replay reaches the fixed-n conclusion in 4 of 5 primaries, and stops early in one (LEAN, 62% sooner).
- Outside the four, P1-H's token comparison with mini-swe-agent stops at 45% of the budget.
- M1a shows the price of anytime validity. A 10-to-1 discordant split is significant at fixed n but leaves e at 14.4.
- R1H's output-token contrast (PC used more, fixed-n p = 0.005) ends at e = 16.8. The ~1–2 extra discordant pairs the research note predicted are what separate the two.

None of the task-level confidence sequences reached the ±10-point futility band. At 16 tasks they end ±30–40 points wide, so the instrument correctly refuses to call a tie.

## 6. Noise floor, MDE and the A/A spread (ST1)

**Clustering is real.**
- The within-arm ICC of attempts on a task ranges 0.03–1.0, median 0.7.
- The between-arm correlation of per-task pass rates is 0.19–0.88.
- Treating (task, attempt) cells as independent pairs gives a narrower interval than the task-cluster bootstrap in 24 of 27 comparisons (`TABLES.md`, interval width). That is false precision.
- Collapsing attempts with any() gives an interval at least as wide as the bootstrap in 22 of 27, and it also changes the estimand to pass@k. ST1's hypothesis ("no wider than any()") therefore holds in 22 of 27.

**MDE at the observed design** (80% power, α 0.05, paired t on per-task means):

| Comparison | Tasks × attempts | MDE (pts) | Power at 10 pts | Tasks needed for MDE 10 / 5 |
|---|---|---|---|---|
| R1H PC vs C | 16 × 2 | 19 | 0.31 | 55 / 212 |
| R1 PC vs C | 16 × 2 | 27 | 0.18 | 104 / 408 |
| LEAN lean vs base | 16 × 3 | 21 | 0.27 | 63 / 245 |
| BUD budget vs base | 16 × 2 | 22 | 0.26 | 67 / 261 |
| P1-H opencode vs gnomon | 16 × 3 | 16 | 0.40 | 40 / 152 |

So a 10-point claim needs 55–100+ tasks at 2 attempts; Terminal-Bench's 89 tasks is about right. A 5-point claim needs 150–400+ tasks, which means pooling a second benchmark (ST7). The known-answer Connor table reproduces the research note: 116 pairs for 10 points at ψ = 0.15, and an 18.5-point MDE at n = 32.

**A/A** (R1H cloud-only vs R1 cloud-only: same build, hosted model and tasks; different host): +12.5 points.

The predicted SD of that difference depends on the model:
- 10.3 points for independent cells, which is the report's "binomial noise" framing;
- 6.6 points when the same tasks are re-run, since task difficulty cancels;
- 13.0 points when each run draws fresh tasks.

The observed gap is z = 1.2 under the first model and 1.9 under the second. The paired test says noise (McNemar 5/1, p = 0.22; per-task sign-flip p = 0.31). It is noise on the high side, not "exactly what binomial sampling predicts".

**pass^k (ST6).** The unbiased per-task estimators are in `TABLES.md`. Reliability is lower than headline rates suggest: R1H cloud-only pass@1 0.84 → pass^2 0.75; local-only 0.75 → 0.69; hybrid 0.84 → 0.86, where hybrid's two missing cells leave single-attempt tasks out of pass^2. P1-H gnomon pass@1 0.75 → pass^2 0.69 → pass^3 0.63.

## 7. Claim binding (ST10)

`claims.py` binds 37 published numbers to a results file, field, results-repo commit and pre-registration hash. It exits 1 while anything is flagged.

| Status | Claims |
|---|---|
| Reproduces | 32 of 37, including every R1H rate, −26%, −60%, 1.3×, GB10 −20% and 1.8×, every Glimmer, Qwen3.8 and LEAN figure, all P1/P1-H figures, and the report's GPU-seconds, wall-time, sign-test, BUD and M1b numbers. Four of the 32 have unsupported wording (below) |
| **Stale** (4) | Flash-Next "16 vs 13" (now 20 vs 17, 29 pairs); "4 vs 3" capped (now 8 vs 5); llms.txt "1.3–1.7×" (1.7 is R1 read through M1's stricter collector before R1 finished; the site says 1.8); the report's S1 "3/7 vs 8/9" (now 16/28 vs 19/27, p = 0.40) |
| **Rule-dependent** | GB10 56 / 72 / 66 (R1's pre-registered rule); 60 / 72 / 68 under the endpoint-outage rule |
| **Wording unsupported** (interval includes the null) | −26% $/solved (RTX 5090), −20% $/solved (GB10), "the cost saving held on both machines", "78% vs 55%" read as an effect (the site already says "p = 0.15, inside noise", which is fine) |
| Interim | S1's summary JSON is uncommitted and is re-written by the live chain after every cell. S1's STATUS has no DONE line |

**Sources.**
- The deck and LinkedIn figures were bound from the list in the brief. Neither file exists under `~/gnomon/reports/`, which holds only the state-of-the-art report.
- Website and llms figures come from `index-v0.4.0.html` / `llms-v0.4.0.txt`. Each claim's text pattern is checked against the page, so a later site edit shows up as TEXT-MISSING.

## 8. Campaign notes

- **R1H / R1.** Covered above. R1-strict, which applies the outage rule, moves GB10 hybrid vs cloud to 21/31 vs 23/32. Every conclusion above is unchanged under it (`TABLES.md`).
- **LEAN (hosted).** All three cost claims hold, and the quality guard holds as NI at 10 points.
  - Lean also ran faster: median 232 vs 353 s, per-task geometric ratio 0.71, sign-flip p = 0.001. That is a further claim the data support.
  - LEAN-local: a single attempt, and 0 discordant pairs on 15. It is uninformative, consistent with "showed no saving".
- **BUD.** Budget vs base: Δ −3.1 [−15.6, +9.4].
  - The pre-registered guard ("budget ≥ base − 2") held on counts. As a non-inferiority test at its own ~6-point margin it is not established (NI only at ≥19 points).
  - Output tokens: the total ratio of 0.75 [0.46, 1.13] is not significant. The typical task, though, used 24% fewer output tokens: geometric ratio 0.76 [0.63, 0.90], sign-flip p = 0.008. That is a mechanism effect worth stating.
- **BUD-2.** Paused after one pair (STATUS 2026-11-02T15:42Z), so there is nothing to analyse.
- **M1.**
  - Glimmer (M1a) trails the incumbent by 33 points [−57, −13]. That is significant at fixed n but not anytime-valid (e = 14.4).
  - Replay (M1a3) is +20 [−7, +50], p = 0.27, with stalls 9 → 0.
  - The build-change control (master vs d59e6c19, no replay): +16.7, bootstrap [+3.3, +33.3] but sign-flip p = 0.125. At 15 tasks with 4/0 discordant, the percentile bootstrap is anti-conservative and the exact sign-flip test is the one to read.
  - Replay with Glimmer vs the incumbent: NI at 10 points holds (≥9).
- **P1 (local, gx10).** No significant gap. The margins at which gnomon would be non-inferior to each peer are about 4 points (mini), 10 (opencode), 14 (qwen) and 20 (goose).
- **P1-H (hosted).** Quality as in §1.
  - gnomon 0.3.1's higher cost holds against every peer: $/solved ratios 0.42–0.72 for the peers, all intervals below 1.
  - Its higher output-token use holds against every peer too.
  - Its higher total-token use is significant only against mini-swe-agent (0.41 [0.22, 0.73]).
- **S1 (interim, not finished: STATUS has no DONE line).** The snapshot read at 20:45Z (uncommitted, re-written after each cell) has steer_role 16/28 vs system 19/27 on 27 pairs.
  - McNemar 0/4, p = 0.125.
  - Per-task Δ −15.6: bootstrap [−31.2, −3.1], but sign-flip [−31.3, 0.0], p = 0.125.
  - e-process 2.6 of 20; task-level CS [−47, +25].
  - The early 3/7 vs 8/9 has regressed toward zero.
  - Because the e-process is anytime-valid, S1 can be monitored on it as cells land without spending α. It is not near a decision.

## 9. Assumptions and limits

- **Tasks are the unit.** The super-population is "tasks like these 16". The 16 are one draw (`sample16-hunch.txt`), not a random sample of Terminal-Bench, so the intervals describe this pool.
- **Bootstrap at 16 tasks.** A percentile bootstrap undercovers here. Sign-flip intervals are exact under symmetry, and are reported beside it; read both.
- **Margins.** The NI margins and the GPU price parameters are declared in this analysis, not pre-registered. Treat the NI and priced-cost verdicts as descriptive; future pre-registrations should fix them (ST2).
- **Cross-campaign pairs.** Comparisons across campaigns (M1 vs R1H/R1) pair cells run days apart. Drift is not controlled.
- **Bayesian models.** Both models are independent, and their posteriors are combined draw by draw. τ is prior-dominated with two machines. HMC is hand-written, so its diagnostics are reported with every fit.

## Files

- `benchmarks/analysis/data.py`: loader; keeps the collectors' validity verdicts, adds run order and R1's outage variant.
- `benchmarks/analysis/paired.py`: ST1 and ST6 (task-clustered paired analysis, ICC, MDE and power, A/A, pass@k and pass^k, cost per solved with CIs, GPU pricing, NI).
- `benchmarks/analysis/bayes.py`: ST3 (hierarchical logistic and log-normal models, numpy HMC).
- `benchmarks/analysis/evidence.py`: ST4 (e-processes, confidence sequences, run-order replay).
- `benchmarks/analysis/claims.py`: ST10 (claim binding).
- `benchmarks/analysis/reanalyse.py`: runs all of it.
- `benchmarks/analysis/test_stats.py`: 49 known-answer tests.
- `out/TABLES.md`, `out/reanalysis.json`, `out/CLAIMS.md`, `out/claims.json`: generated outputs.

To reproduce:

```
cd benchmarks/analysis
GNOMON_RESULTS=<bench repo>/benchmarks/results nice -n 19 ionice -c3 python3 reanalyse.py
nice -n 19 python3 -m pytest -q test_stats.py
```

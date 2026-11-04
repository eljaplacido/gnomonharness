# GBS-HYBRID: Hybrid Local/Cloud Cost-Quality Benchmark

**Version 0.1 (draft), 2026-11-03.** Part of
[gnomon Bench Standards](README.md). Results also follow
[GBS-REPORTING](REPORTING.md).

## 1. Question

A coding-agent system splits work between a local model and a cloud model.
Does it beat local-only on quality and cloud-only on cost, with local compute
priced, and without a hidden regression in latency, reliability or governance?

## 2. Why this needs a standard

- **No incumbent.** No benchmark scores local plus cloud splits for coding
  agents.
  - The closest precedent, AgentCARD, is a role-aware cost model covering API
    and self-hosted deployment. It reports heterogeneous teams matching the
    strongest homogeneous team at up to 12× lower per-task cost, and has no
    leaderboard ([AgentCARD](https://arxiv.org/abs/2606.20629)).
  - Minions recovered 97.9% of cloud quality at 5.7× lower remote cost, on
    document QA, not coding ([Minions](https://arxiv.org/abs/2502.15964)).
- **gnomon's own result shows the pitfalls.** On an RTX 5090, a cloud planner
  with a local builder (PC) solved 26/30 tasks, against cloud-only (C) 27/32 and
  local-only (L) 24/32. Dollars per solved fell from $0.0458 to $0.0341 (−26%)
  ([R1H summary](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/r1h-2026-11/summary.txt)).
  **Did not reproduce on v0.4.0 (R3R, 2026-11-04).** R1H's own lane, arms and tasks, re-run on v0.4.0: L 22/29,
  C 24/31, PC 19/31; PC's dollars per solved rose 43% against C (95% CI −117% to +5%), and on matching tasks PC
  solved 18 vs R1H's 25 (8 tasks R1H-only, 1 R3R-only; McNemar p = 0.04) while L and C were unchanged. Host load does
  not explain it. The cause is open; see [FINDINGS-2026-11-04](FINDINGS-2026-11-04.md)
  ([R3R summary](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/r3r-2026-11/summary-r3r.txt)).
  The same file also shows:
  - **Quality is not settled.** PC against C: 2 discordant tasks to 1, McNemar
    p = 1.0. That is no evidence of a difference, which is not the same as
    evidence of no difference.
  - **The cost gap is not settled per task.** The paired sign test on dollars:
    16 to 14, p = 0.86.
  - **Local compute was not free.** PC used 101 GPU-seconds per solved task.
    Computed from the same file: the cloud saving is $0.0117 per solved, so
    the advantage vanishes once a GPU-hour costs more than about **$0.42**.
    At $1 per GPU-hour, PC would cost 1.36× C.
  - **The hybrid was slower.** Median wall clock was 322 s against 243 s, with
    8 capped tasks against 6.

  A claim that leaves out any one of these misleads. This spec makes all four
  mandatory.

## 3. Arms

All arms run the same harness build and configuration. The only change between
arms is the role-to-model map, and the config-hash diff MUST show nothing else.

| Arm | Definition | Required |
|---|---|---|
| L | Every role local | MUST |
| C | Every role cloud | MUST |
| H-static | A fixed, declared split, e.g. cloud planner + local builder | At least one MUST |
| H-auto | The harness decides per task or per turn: router, escalation, rescue | MAY. Report escalation rate and the trigger log |
| H-user | A person decides when to switch | MAY. Uses a recorded, replayable decision policy (a scripted simulated user), and reports asks per task. Live human sessions are a separate, labelled study |
| Oracle | Per task, the best of the arms above | Analysis only, never a claim. It bounds the headroom |

Comparing harnesses (harness A's hybrid against harness B's) is allowed only
with the same models, role split and hardware.

## 4. Task set and size

- **Primary:** Terminal-Bench 4.0 (66 tasks, pinned at `@4.0.0`) on amd64.
  On arm64, 6 of 29 tasks gnomon sampled failed their own oracle (gnomon
  internal infrastructure notes). Resource limits are published:
  infrastructure configuration alone moved TB2 by 6 points
  ([Anthropic](https://www.anthropic.com/engineering/infrastructure-noise)).
- **Size.** At least **66 tasks × 3 attempts per arm** for a 10-point margin.
  - In a simulation calibrated to gnomon's measured 15% self-flip rate, power
    for Δ = 10 is 0.95–0.99 at 89 × 3, and
    0.57–0.66 at 32 × 3. 66 × 3 falls between, so the pre-registration
    computes its own power.
  - A **5-point margin** needs about 300 tasks × 3, or a pooled second
    benchmark. Terminal-Bench alone does not reach it: 89 × 5 gives power
    0.49–0.75 ([Hardy et al.](https://arxiv.org/abs/2610.00651) on pooling).
- **Subsets.** A frozen 30–70%-pass-rate subset MAY be used, for paired
  *direction* claims only. It is frozen in the pre-registration before any
  run, and headline rates still come from the full set
  ([Ndzomga](https://arxiv.org/abs/2603.23749)).

## 5. Hardware classes

Results are reported per class. Classes are never pooled into one "local"
number, except in a hierarchical model with class as a random effect (§8).

| Class | Definition | Examples |
|---|---|---|
| HW-A | One discrete GPU, 24–32 GB | RTX 4090 (24 GB), RTX 5090 (32 GB) |
| HW-B | Unified memory, 128 GB | NVIDIA GB10 (DGX Spark), 128 GB Apple silicon or AMD Strix Halo systems |
| HW-C | Datacenter GPU, 80 GB or more | MAY; labelled |

CPU-only inference is out of scope for v0.1.

## 6. Cost model (MUST)

Per arm, total cost is the sum over trials of cloud cost plus local cost.

**Cloud.** Each request's provider-reported usage, multiplied by the dated list
price, with cache reads and writes priced separately. All cost comparisons come
from one telemetry source: provider usage API, wire count, or harness
self-report, declared per number. Sources are never mixed. Caching makes
cross-source token counts incomparable
([WorkBuddy](https://arxiv.org/pdf/2607.20911)).

**Local.** GPU-seconds × a price per GPU-hour.

- **GPU-seconds** is the time a request occupies the GPU, multiplied by the
  number of GPUs held. It comes from server timings (for example llama.cpp
  `timings` or vLLM metrics). If only request wall time is available, that is
  used and labelled, and it is exact only at concurrency 1.
- **Price per GPU-hour** is reported on two bases, each with a source and a
  date:
  - **rental:** the on-demand price for the same GPU class from a named
    provider;
  - **ownership:** hardware price ÷ amortization hours at a declared
    utilization, plus energy.
- **Energy** is power integrated over occupancy, sampled at 1 Hz or faster,
  times a declared $/kWh. Wall-plug measurement is preferred. GPU board power
  (`nvidia-smi`) undercounts the system, so it is labelled. On unified-memory
  systems, measure system power.
- **Idle time** between requests is not charged by default. A sensitivity line
  charges the local machine for the whole run window: the dedicated-box view.

**Reported cost measures:**

- $/solved per arm;
- the ratio R = $/solved(H) ÷ $/solved(C), with a 95% task-cluster bootstrap
  CI (resample tasks, then recompute both arms' totals);
- cloud tokens, GPU-seconds and kWh per solved;
- the **break-even GPU price**, at which R = 1.

R is reported under the rental price, the ownership price and a local-free
reference line. The local-free line is never the headline.

## 7. Latency, speed and time caps

- **Latency (MUST).** Median and p90 wall clock per task, a Kaplan–Meier curve
  of time-to-solve censored at the cap, and the capped-task count per arm. A
  latency regression against C is stated in the headline, not in a footnote.
- **Decode speed (MUST).** Per local lane, report:
  - prefill and decode tokens/s measured during the run, at the concurrency
    used;
  - engine and version, quantization, KV-cache type, context length and
    speculative-decoding settings.

  A pre-run probe (fixed 4k-token prompt, 512-token output) checks the lane
  against a declared tok/s range. A lane outside its range is an apparatus
  failure. For example, an NVFP4 kernel falling back to emulation on GB10 ran
  at 1.1 tok/s instead of 77
  ([NVIDIA forum](https://forums.developer.nvidia.com/t/measured-inference-benchmarks-on-a-single-dgx-spark-same-harness-across-ollama-llama-cpp-and-vllm-notes-data-published/379766)).
- **Template conformance (MUST).** The probe also checks that:
  - a late system message reaches the model;
  - tool calls are not swallowed into the reasoning field
    ([llama.cpp #20809](https://github.com/ggml-org/llama.cpp/issues/20809));
  - reasoning is round-tripped if the harness relies on it.

  On gnomon's R1H lane, a chat template silently dropped every late system
  message
  ([S1 pre-registration](https://github.com/eljaplacido/gnomonharness/tree/bench/peers-2026-11/benchmarks/results/s1-2026-11)).
- **Effective cap (MUST).** Measure the effective cap from agent start and end
  timestamps; do not take the configured value on trust. A configured 900 s cap
  once ran as about 1200 s in every cell ([EVIDENCE.md](../EVIDENCE.md)).
- **Cap sensitivity (MUST).** Local lanes are decode-bound, so a time cap turns
  slowness into failures. Report the pass rate at the primary cap. Also report
  a curve derived from solve timestamps at 0.5× and 0.75× of it, labelled
  *derived*: it assumes behaviour does not depend on the cap. An arm whose
  harness is time-aware (budget status, wall-clock cut-offs) MUST also run at
  least one alternative cap for real.

## 8. Analysis

| Endpoint | Test | Claim it supports |
|---|---|---|
| Δ_HC = mean over tasks of (H − C), per-task mean pass | 95% task-cluster bootstrap (or sign-flip) CI; lower bound > −m | Quality non-inferior to cloud at margin m |
| R = $/solved(H) ÷ $/solved(C) | 95% task-cluster bootstrap CI; upper bound < 1, under the rental *and* ownership prices | Cheaper than cloud |
| Δ_HL | CI excludes 0 | Better than local |
| pass^k, capped count, median wall, governance refusals | Reported against C and L | No undisclosed regression |

The full hybrid claim ("beats local on quality and cloud on cost") needs the
first three rows plus row four disclosed. The margin m is pre-registered.
v0.1 suggests 10 points as the default, and no margin smaller than the
design's MDE.

**Bayesian companion (SHOULD).** A logistic GLMM with task random effects, and
a hardware-class random effect when pooling classes. Report P(Δ_HC > −m),
P(R < 1) and the between-class SD
([HiBayES](https://arxiv.org/html/2505.05602v3)). This pools campaigns that
look contradictory under separate significance tests. gnomon's 5090 (+3 points)
and GB10 (−6 points) results are one example.

**Sequential testing (MAY).** An anytime-valid paired e-process, if declared in
the pre-registration (betting rule, α, maximum budget). It makes "run another
night" valid rather than p-hacking
([safe testing](https://arxiv.org/abs/1906.07801)).

**Governance invariance (MUST).** The policy configuration is identical across
arms. Guard refusals per arm are reported. A hybrid arm that reaches the cloud
by routing around policy is invalid.

## 9. Reporting

```
GBS-HYBRID 0.1 · TB 4.0 @4.0.0 (66 tasks) × 3 · HW-A (RTX 5090 32 GB) · harness <name> <sha> · config <hash>
Local: <model> <quant> on <engine> <ver>, decode <tok/s> · Cloud: <provider> <model> <date>
Prices: rental <$/GPU-h> (<source>, <date>); ownership <$/GPU-h>; energy <$/kWh>; cloud price table <date>

| arm | pass@1 [CI] | pass^3 | $/solved rental | $/solved own | GPU-s/solved | cloud tok/solved | median wall | p90 | capped |
|---|---|---|---|---|---|---|---|---|---|
| L | | | | | | | | | |
| C | | | | | | | | | |
| H-static (cloud plan, local build) | | | | | | | | | |

Δ_HC = … [CI], m = 10 → NI holds / does not hold
R (rental) = … [CI]; R (own) = … [CI]; break-even = $… per GPU-hour
Cap sensitivity (derived): pass at 0.5× / 0.75× / 1.0× cap = … / … / …
```

**Claims allowed.** For example: "On TB 4.0 and HW-A, gnomon with a cloud
planner (model X) and a local builder (model Y) is non-inferior to cloud-only
at m = 10 points, costs 0.8× [0.7, 0.95] per solved task at a rental price of
$P per GPU-hour, and is 1.3× slower at the median." Claims not allowed: "hybrid
beats cloud" without a margin; cost without GPU-seconds priced; any claim with
the latency change left out; pooling HW-A and HW-B into one number.

## 10. gnomon's status against v0.1

gnomon's hybrid results do not conform yet:

- **R1H (RTX 5090)** ran 30–32 tasks, one attempt each. It has no
  pre-registered margin, and GPU-seconds were measured but not priced.
- **GB10** gave a tie at −20% $/solved, under the same limits.

Read under §8, the honest statement today is: quality non-inferiority is not
established at any margin below about 20 points; the cost advantage is
probable on aggregate but depends on the GPU price (break-even near
$0.42/GPU-hour on R1H's numbers); and latency regressed. A conformant run
needs TB 4.0 at 66 × 3 per arm, on amd64, with the cost model above.

## 11. Open questions for v0.2

- Pricing for HW-B, where rental markets are thin.
- Whether H-user can be standardized beyond a scripted policy.
- Whether data residency should be a scored measure: which content left the
  machine, and secrets-aware routing.

# Pre-registration — peer-parity (NOT YET RUN)

**Status: designed, gated, not launched.** This document exists so that the
design is fixed before any money is spent, and so that the two conditions
blocking it are written down where they cannot be forgotten. Written 2026-09-05
against the `.claude/skills/benchmark-discipline` gate.

## The question, and why it is not the obvious one

Every task-completion arm this project has run since 2026-09-02 is **null**:

| arm | result |
|---|---|
| peer vs opencode, equal terms | 50.0% vs 47.1%, McNemar **p = 1.0000** |
| role chain vs none | 48.7% vs 56.6%, **p = 0.375** |
| model ceiling, 2.5×/7.5× the price | 41.7% vs 50.0%, **p = 1.0000** |
| timeout-retry instruction | +1.1pp against an 8.5pp within-arm spread |
| v0.1.1 vs the build before it | −3.6pp against a ~10pp MDE, **p = 0.6250** |

Five nulls is not five failures to find an effect. It is a consistent finding:
**at this model tier the harness is not the bottleneck on task completion.**

So the question is not "does gnomon complete more tasks than opencode". Nothing
this project can afford will answer that, and chasing it is how the last
campaign spent a day characterising a bug it already knew about. The question
is:

> **Does gnomon's governance cost task completion?**

That is a **non-inferiority** question, and unlike the superiority version it is
answerable at a price this project can pay.

## The claim being tested

> gnomon is not worse than opencode on task completion by more than **δ**.

Success is the upper bound of the 95% CI on (opencode − gnomon) sitting below δ.
A null superiority test is **not** a substitute for this: "no evidence of
difference" and "evidence of no difference" are different claims at low power,
and the second is almost never what this project has had.

## The margin, and the honest arithmetic

From `peer-opencode-2026-09-02`: 34 paired tasks, 5 discordant — a discordance
rate of ~15%, consistent with the measured self-flip of 11.9–14.9%.

For paired binary data the standard error of the difference is ≈ √D / n, with
D ≈ 0.15n:

| δ (margin) | paired tasks needed | why you would want it |
|---|--:|---|
| 10pp | **~58** | rules out a large capability cost |
| 5pp | **~230** | rules out a cost anyone would notice |
| 3pp | ~640 | out of reach; do not attempt |

**Pre-registered: δ = 10pp on the full live Terminal-Bench set (241 tasks), which
over-powers that margin and puts 5pp within reach as a secondary, clearly
labelled as secondary.** Stating δ now removes the largest researcher degree of
freedom left — in the 2026-08-30 incident, choosing between two defensible
validity rules after the fact moved p from 0.077 to 0.031.

If the run cannot afford the full set, the margin moves with the n, and the
result is published against whichever δ the achieved n supports. The margin is
never chosen after seeing the interval.

## Two conditions that must be met before this launches

Both are the gate's rule 1 — *fix what you already know is broken first, or you
are buying a characterisation of a bug you already have.*

1. **The clock discrepancy — half-resolved 2026-09-05, and the remaining half
   is now cheap.** [`clock.py`](../results/regression-2026-09-03/clock.py)
   measured it from archived timestamps: **59 of 64 timeouts land in
   1195–1210s across 23 different tasks**, so the cap in force is one global
   1200s and not the 900s the launcher passed. A per-task cap would vary by
   task; this does not.

   What is left is *why the flag was inert*, which needs the terminal-bench
   checkout on the sweep machine — a grep, not an experiment.

   **The apparatus requirement that follows is not optional.** This arm must
   assert, per cell, that `max(agent_ended_at − agent_started_at) ≤ declared_cap
   × 1.02`, and abort if not. A cap that is not the declared one is invisible in
   the score — it arrives as timeouts, which look like capability — and ~41% of
   trials end there, which makes it the single largest determinant of the
   number. Same bug class as the adapter self-cap, from the framework's side
   instead of ours, and the same fix: assert the clock rather than trust it.

2. **The peer must be ungated, and verified ungated from its own logs.**
   opencode auto-rejected its own permission prompts on 11 of 45 trials and
   solved 1 of 10 on those. Its published 38.6% is a floor, not a measurement.
   The check is not "we passed a flag" — it is grepping the peer's trial logs
   for `auto-rejecting` and asserting zero.

Adapter clock parity is now asserted in `.gnomon/ci.sh` (rule 5), which is the
third condition and is met.

## Design

- **Arms, serialized, cheapest first.** gnomon at a pinned SHA; opencode at a
  pinned version. Two passes each, so the noise floor is measured inside the run
  rather than assumed from an earlier one.
- **One variable.** Same tasks, same model (`deepseek-v4-flash`), same clock,
  same concurrency, same host, interleaved task-by-task rather than run as
  blocks on different days — which converts day/load/provider drift from a
  between-arm confound into within-arm noise, for free.
- **SHA recorded per trial, from inside the container**, and the run refuses to
  start if the ref is unreachable rather than falling back to `master`. That
  fallback is what made the 2026-08-30 campaign measure a build whose fixes were
  sitting unpushed.
- **Audit on, traces archived into the repository as part of the run script.** A
  scratchpad is not storage; the 48-task arm's traces were wiped and every
  behavioural claim about it became inference.
- **Contamination grep** over every task for leaked oracles, with any hit
  excluded from **all** arms, not only the one it helped.

## Validity rule, fixed now

- A trial is valid iff `is_resolved` is non-null. Applied mechanically to both
  arms, with the ungraded task ids printed beside the score.
- Buckets must sum to n; the run asserts it.
- Apparatus failures (`unknown_agent_error`, Docker build failures) are excluded
  from the denominator and **counted and published** separately per arm. An
  asymmetry in apparatus failures is itself a finding about the apparatus.
- Score is the mean of the two passes per task. Pooling passes is the generous
  rule and is not used; it is what made an earlier p-value unquotable.

## Wall-clock and cost, sized from measurement

241 tasks × 2 harnesses × 2 passes ≈ **964 trials**. At the measured
$0.0153/trial for gnomon and opencode's measured **4.66×** context
([context-cost](../context-cost/)), roughly **$90–130** total — sized from
measured cost per trial rather than list pricing, because verbose reasoning
models have cost 100× what price-scaling predicted here.

At the observed cap and concurrency 4, **24–30 hours**. Serialized, with a
credit floor before each arm.

## What this cannot establish

- **Anything about a different model tier.** Five nulls at this tier say the
  harness is not the bottleneck *here*. A frontier model could change that in
  either direction and this arm does not test it.
- **Anything about the properties gnomon actually claims.** Determinism,
  capability separation, disclosure and auditability are measured exhaustively
  by the $0 property suites, and no task-completion arm can speak to them.
- **Superiority.** Even at n=241 a 3pp true difference is not detectable. If the
  interval comes back straddling zero, the honest report is "not worse by more
  than δ", never "as good as" and never "better".

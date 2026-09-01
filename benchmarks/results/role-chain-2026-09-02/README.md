# The declared role chain — 2026-09-02

**A negative result on the feature this project argued hardest for.**

`docs/CONSTITUTION-REVIEW.md` called a declared role chain *"the highest-expected-
value change available to the project, and the argument that blocked it was
never sound"*, on the strength of ForgeCode's reported 55% → 80.2% and of our own
residual-loss analysis, in which all three remaining Terminal-Bench losses shared
one signature: stopping early with budget in hand.

Built, shipped, and measured. It does not improve task completion here.

## Design

One variable. Both arms run the same build (`bench/chain-2026-09-01` @ `bb71829`),
the same 47 tasks, the same model (`deepseek-v4-flash`), the same 900 s clock,
the same concurrency. The only difference is whether the surface declares
`[chain] stages = ["plan", "implement", "critique"]`.

n=2 per arm, because measured same-configuration noise here is 4.5–7.9 points and
a single pass cannot see an effect that size.

## Result

Paired on the **38 tasks valid in all four cells**:

| arm | pass 1 | pass 2 | mean | within-arm spread |
|---|---|---|---|---|
| **control** (no chain) | 60.5% | 52.6% | **56.6%** | 7.9pp |
| **chain** | 52.6% | 44.7% | **48.7%** | 7.9pp |

**Difference: −7.9pp — exactly equal to the within-arm spread.**

Pooled (a task counts as solved for an arm if solved in either of its passes):
control-only 4, chain-only 1, **McNemar exact p = 0.375**.

The ranges touch: the chain's best pass (52.6%) equals the control's worst.

## Reading it honestly

**There is no evidence the chain helps.** Every chain pass sits at or below every
control pass, and the direction is consistent across both — but the magnitude is
the noise floor, the discordant count is 5, and p = 0.375. This is *"no evidence
of benefit"*, which at this power is not the same as *"evidence of no benefit"*.

**What would be dishonest to claim:** that the chain costs 7.9 points. The
measurement cannot separate a real 8-point cost from the noise it is the same
size as.

## Two costs that are not in the score

**Tokens.** Three stages each re-send context. Token efficiency measured 41:1
input-to-output on this workload, so the bill is dominated by context re-sending,
and a three-stage turn pays it three times over.

**Exposure.** `chain-on-r2` lost 9 of 47 trials to apparatus failures against 2
for every other cell. Three stages mean roughly three times the model calls per
task, and therefore three times the chance of meeting a transport failure. One
cell is not a rate — but the mechanism is real and points the same way.

## What this does not overturn

The chain closed a genuine structural gap: a role sequence declared as hashed
data, one bucket per stage, no composite verdict, `chain_stage` in the trail.
That capability did not exist, and its value does not rest on this score.

It ships **`off` unless declared**, which this result says was right.

## What would be worth trying next

Each stage gets a fraction of one step budget rather than its own. A chain whose
stages are separately budgeted is a different experiment, and the one this result
argues for — not abandoning the mechanism.

## Apparatus

Three faults were caught and fixed before this measurement was trusted, each of
which would have produced a confident and entirely fictional number:

1. A **short SHA** compared to a full cloned SHA with string equality aborted
   every trial before gnomon installed — 0 passes, no model call, no spend,
   indistinguishable from total capability failure.
2. `GNOMON_CHAIN` **never reached the container**: the adapter forwards a
   whitelist and the variable was not in it. A whole 47-task "chain" cell ran
   with zero stages and was compared against its own twin. That cell
   (`chain-on-p1`) is used here as a second CONTROL pass, which is all it ever
   was.
3. `--role implementor` in the bench adapter **suppressed the chain by design** —
   an explicit role overrides it, correctly, which made the arm unreachable.

Every chain cell now asserts it actually chained: fewer than 5 trials carrying
`[chain] stage` in their log aborts the cell rather than reporting a number.
`chain-on-r1` recorded 42 chained trials, `chain-on-r2` 36.

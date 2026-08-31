---
name: benchmark-discipline
description: Gate checks to run BEFORE spending money on any benchmark, sweep, arm, or model ladder — fix known defects first, pin and record exactly which build is under test, keep one variable per arm, and establish the noise floor before reading any delta. Use whenever about to launch, queue, resume, extend or interpret a benchmark run, A/B comparison, peer arm, or model sweep — and whenever tempted to explain a result before checking the apparatus.
---

# Benchmark discipline

Every rule here was paid for. On 2026-08-30 a six-stage benchmark campaign spent a day and
most of a budget measuring a harness whose defects were already known, catalogued, and
sitting unfixed on an unpushed branch — because the containers cloned `master`. Four separate
adversarial investigations of that campaign produced four different "dominant defect"
diagnoses, and every one was refuted, because the audit trail shipped disabled and the traces
were left in a wipeable scratchpad.

Read this before launching anything that costs money or hours.

---

## The gate — all of it, before the first arm starts

### 1. Fix what you already know is broken, first

If a known, cheap, code-level defect is unfixed, **you are buying a characterisation of a bug
you already have**. Ask literally: *"If this run comes back bad, will I have learned anything
I do not already know?"* If the answer is no, fix first and measure after.

This is the single most expensive mistake in the incident above. Known defects sat unshipped
through three arms.

A defect qualifies as "fix first" when it is: code-observed (not inferred), cheap relative to
the run, and plausibly affects the metric. Otherwise note it and proceed.

### 2. Pin and record exactly what is under test

**The run must record the SHA it actually executed, per trial.**

- Containers that `git clone` a repo get the **default branch**, not your working tree, not
  your local branch, and not your uncommitted fixes. Verify this explicitly — do not assume.
- Pin the ref (`--branch <ref>`), write the resolved SHA into per-trial artifacts, and
  **refuse to start** if the ref is unreachable rather than silently falling back.
- Pin peers too. `@latest` and a `stable` channel are not versions. In the incident, no peer
  version was ever recorded, which made "did the peer improve or did we regress?" permanently
  unanswerable for those runs.

If an arm cannot be attributed to a commit, it cannot support a claim about that commit.

### 3. Turn the record on

- Audit/tracing **ships off** in most tools, including gnomon's own dogfood surface. Enable it
  for the benchmark surface explicitly.
- Archive traces into the repo as part of the run script. A scratchpad is not storage; the
  48-task arm's traces were wiped and every behavioural claim about it became inference.
- Emit a structured **stop reason** per trial. "Ran to completion but wrong" and "hit the step
  wall" and "the transport died" are different failures, and prose summaries cannot be counted.

### 4. One variable per arm, and include a control

Changing the harness and the model together makes attribution impossible. Structure as:

- **control arm** — new build, *old* model → isolates the build change
- **ladder** — build held fixed, model varied → isolates the model effect

Without the control you cannot tell a harness win from a model win.

### 5. Check the arms are equally handicapped — before reading any number

Verify symmetrically, for every arm:

- **Clock.** Same effective timeout? Adapters can self-cap (gnomon's hardcoded 900s against
  peers' `float("inf")` — twice, in two different forms). Assert equality in CI.
- **Permissions.** Is a peer running gated? opencode auto-rejected on 17 of 48 trials, making
  its score a floor rather than a measurement.
- **Contamination.** Grep every task for leaked oracles (`COPY .` in a Dockerfile shipping
  `solution.sh` and hidden tests). Exclude the task from *all* arms, not just the one that won.
- **Transport.** Count client-side failures per arm. 10.4% of one arm's trials died on model
  transport aborts scored as capability failures; the peers had zero.

### 6. Pre-register the scoring rule

Write down, before seeing results: what counts as a valid trial, what is excluded, how
apparatus failure is separated from a real answer.

In the incident, the choice between two defensible validity rules moved p from **0.077 to
0.031**. Choosing after seeing the data is the largest researcher degree of freedom left.

Assert the buckets sum to n. That one check catches miscounts silently.

### 7. Establish the noise floor before interpreting anything

**Run the same arm twice before comparing two different arms.**

Measured self-flip rate, same code, same model, same flags: **14.7%** across 34 shared tasks —
a swing of 8.8 percentage points from noise alone, and 30 points on one difficulty tier. Most
single fixes are worth less than that.

Consequences:
- n=1 per task cannot support a comparative claim. Budget n≥3 or publish as descriptive with a
  CI and no comparison.
- State the minimum detectable effect. If MDE > the effect you are chasing, the run cannot
  answer the question — say so before spending, not after.
- Each change declares two endpoints: a **mechanism metric** the design can resolve, and a
  **score metric** it probably cannot. A mechanism win with no score movement is an honest
  partial result, declared in advance.

### 8. Sequence and budget-gate

- **Serialize arms.** Concurrent arms on one host manufacture timeouts and bias whichever arm
  has least headroom.
- **Cheapest first**, with a credit floor before each arm, so one verbose model cannot starve
  the arms behind it.
- Size expensive arms against **measured** cost per trial, not list pricing — verbose reasoning
  models can cost 100× what price-scaling predicts.
- Never let a task-selection file go empty: an empty `-t` list can mean *run everything*.

---

## While interpreting

**Apply identical scrutiny to every arm.** Mining one arm for excuses and not the others moves
the estimate toward the unexamined arm regardless of truth. In the incident, opencode's traces
were mined for defects and goose's were not — and three of the four "corrections" that softened
goose's win did not survive being checked symmetrically.

**Check the apparatus before believing a mechanism.** Two readings that felt decisive were
artifacts: a "2.4× reversal" that was completion-order bias (the queue runs hard-first), and
"the harnesses solve disjoint task sets" which was inside null expectation. Both were built on
partial data and collapsed on contact with the full run.

**Distinguish "no evidence of difference" from "evidence of no difference."** At low power they
are not the same, and the second is almost never what you have.

**A tier or subgroup breakdown at n=1 is close to meaningless.** One tier moved 26 points
between two runs of the identical harness.

**Never build a regression set by selecting on outcome.** At a 16.7% flip rate, a no-op change
"fixes" 1–3 tasks. Use the full pre-registered set.

---

## Fast pre-flight

```
[ ] Known cheap defects fixed and shipped to the ref under test
[ ] Ref pinned; resolved SHA recorded per trial; run aborts if ref unreachable
[ ] Peer versions pinned and recorded
[ ] Audit/tracing enabled; traces archived outside the scratchpad
[ ] Control arm included (new build + old model)
[ ] One variable per arm
[ ] Clock, permissions, contamination, transport checked symmetrically
[ ] Validity rule pre-registered; buckets assert-sum to n
[ ] Noise floor measured (same arm twice) or n>=3 budgeted
[ ] MDE stated; if MDE > target effect, say so before spending
[ ] Arms serialized, cheapest first, credit floor per arm
[ ] Task-selection file non-empty
```

If a line cannot be ticked, either fix it or write down — in the result — that it was not met.
A benchmark whose caveats are discovered afterwards is a benchmark that has already misled
someone.

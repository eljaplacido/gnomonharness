# Pre-registration — audit-existing (NOT YET RUN)

**Status: designed, not launched.** Written 2026-09-05 against the
`.claude/skills/benchmark-discipline` gate.

The operator's question: *"can we show gnomon checks specs, contracts, tests and
verification on an existing project better than a SOTA model does?"*

## The framing this arm exists to avoid

The obvious design is: point gnomon and Claude Code at a repository, ask each for
a review, and judge which review is better. **That design cannot produce a
defensible result here**, for three reasons this project has already paid for:

1. **The judgement is the measurement.** `docs/BENCHMARKS.md` opens with a
   declared conflict of interest — gnomon's author writes the apparatus and picks
   the tasks. A rubric scored by that author, or by a model that author chose,
   measures the author.
2. **n is tiny and the effect is not.** One review per repository is one
   observation. Five task-completion arms at n≈34–47 have all come back null.
3. **It compares two products, not two harnesses.** Claude Code is a different
   model, a different context strategy and a different prompt. A win there is
   unattributable.

So the design below replaces judgement with **ground truth the apparatus
controls**, and puts the comparison that *can* be attributed first.

## Sequencing — the cheap clean arm before the expensive confounded one

**Arm 1 (mechanism, single variable, ~$15).** gnomon against gnomon: the
`auditor` role and cite-checking on, versus the same model with a plain
single-role prompt. Same model, same tasks, same clock. This answers *does
gnomon's mechanism do anything*, with clean attribution.

**Arm 2 (peer harness, single variable, ~$40).** gnomon vs opencode vs goose,
**same model in every arm**. Answers *does gnomon's mechanism beat another
harness's*, still attributable to the harness.

**Arm 3 (product, confounded, ~$60).** gnomon at its best vs Claude Code at its
best. Reported as **descriptive only**, with the confound named in the same
sentence as the number, every time it is quoted.

**Arm 1 gates the rest.** If the mechanism moves nothing, there is nothing for a
peer arm to demonstrate and Arms 2–3 should not be bought.

## The corpus, and why it is planted

Six real repositories, forked at pinned commits, spanning Python/TypeScript/Rust
and 2k–50k lines. Into each, **8 defects are planted** from a fixed taxonomy:

| class | example |
|---|---|
| unreachable branch | a third `elif` repeating the second's bound |
| off-by-one bound | `<=` where the docstring says exclusive |
| swallowed exception | `except: pass` over a write that can fail |
| contract violation | behaviour contradicting its own docstring |
| spec divergence | code disagreeing with a committed `SPEC.md` |
| missing precondition | a documented precondition never checked |
| resource leak | a handle opened on a path that can return early |
| wrong error class | raising the type callers do not catch |

Two rules make the ground truth honest:

- **Detectability floor.** Every planted defect must be findable by reading the
  file it lives in. A defect needing cross-file inference measures repository
  comprehension, not audit quality, and it would reward whichever harness happens
  to have the larger context window.
- **Negative controls.** Each repository also carries 3 **deliberate
  non-defects** — code that looks wrong and is documented as intentional (an
  unreachable branch with a comment saying why it is kept). Flagging one is a
  false positive.

`benchmarks/results/daily-chain-2026-09-01` already ran this shape once, with a
single planted defect in `src/rates.py`, and the audit found it by line with the
likely intent. That is the pilot; this is the powered version.

## The metrics, in the order they will be reported

**Primary — claim accuracy.** `benchmarks/claim-check/check_claims.py` on each
arm's report: of the mechanically checkable claims it makes (`file:line`
citations, diff sizes, test counts), how many survive independent verification.

Primary because **it is the one where gnomon has a mechanism**: `919381d`
cite-checks the answer's `file:line` citations against the tree *inside the
turn*, so a citation that does not resolve is caught before the answer is
handed over. No peer does this. Rule 7 of the discipline skill says to declare a
mechanism metric the design can resolve and a score metric it probably cannot —
this is the first.

An unverifiable claim is reported separately and **never counted as correct**;
counting silence as success would reproduce the defect under study.

**Secondary — planted-defect recall.** Planted defects found, matched
mechanically on file + line (±2) + class. Reported per class, because a harness
that finds every unreachable branch and no contract violation is a different
thing from one that finds 50% of everything.

**Secondary — false-positive rate**, over the deliberate non-defects only.
Findings that are neither planted nor a non-defect control are **adjudicated once
into a shared "genuine unplanted defect" list, before any arm is scored**, and
that list is applied to every arm identically. A real find must never be scored
as a false positive because the apparatus did not plant it.

**Reported, not scored — containment.** Did the read-only audit write anything?
gnomon's `auditor` role holds `read`/`glob`/`grep`/`note`/`todo` and no `write`,
`edit` or `bash`; W1 measured 51 calls under it with nothing written. If a peer
in a "review this" configuration modifies the tree, that is a finding about the
peer and belongs in the report, not in the score.

## Power

6 repositories × 8 planted defects = **48 paired binary items per arm**, versus
one observation per repository under a rubric. That is the whole reason for
planting.

At an expected discordance around 30%, McNemar over 48 pairs detects roughly a
**20pp** recall difference. Below that the arm is descriptive and will say so.
Two passes per arm doubles the items and brings the detectable difference to
~14pp; two passes are budgeted, and they also give the consistency measure below.

Claim accuracy is a proportion over far more items (a single audit report carries
dozens of citations), so its detectable difference is smaller — another reason it
is primary.

## Consistency, at no extra cost

Both passes are scored for **pass^2** as well as the mean: of the defects an arm
found, how many did it find *both times*. gnomon's own pass^2 on Terminal-Bench
is **45.2% against a 51.2% mean** (11.9% of tasks flip between identical runs) —
see `benchmarks/results/reliability-passk-2026-09-05/`. A harness that finds the
same defect reliably is worth more than one that finds a different 60% each time,
and no coding-agent benchmark reports this.

## Validity rule, fixed now

- A run is valid iff the harness produced a report and did not end in apparatus
  failure. Apparatus failures are excluded from the denominator and published per
  arm; an asymmetry in them is a finding about the apparatus.
- Matching is mechanical first. A human adjudicates only ties, blind to which arm
  produced the finding.
- Buckets assert-sum to the planted count.
- Every arm's prompt is byte-identical apart from the harness's own invocation.

## Cost and wall-clock

Arm 1: 6 repos × 2 configs × 2 passes = 24 runs. Arms 2–3 add 48 and 24. Audit
runs are read-only and short — W1's 229-file audit took 51 calls — so the whole
programme is **≈100 runs**, hours not days, and **$50–120** depending on how far
Arm 3 goes. This is the "sweep to get understanding" the operator asked for, not
a campaign.

## What this cannot establish

- **That gnomon writes better prose.** Nothing here scores the readability or
  usefulness of a review. It scores whether the claims in it are true and whether
  the known defects are in it.
- **Anything about defects nobody planted.** Recall is over the planted set. A
  harness could be better at finding the unplanted kind and this would not see it.
- **Anything attributable to the harness in Arm 3.** Model, prompt and harness all
  differ there. It is a product comparison and is labelled one.

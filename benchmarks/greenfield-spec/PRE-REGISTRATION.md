# Pre-registration — greenfield-spec (NOT YET RUN)

**Status: designed, not launched.** Written 2026-09-05 against the
`.claude/skills/benchmark-discipline` gate.

The operator's question: *"the same, for starting a greenfield project — spec,
construct, test, verify — versus a SOTA model."*

## What is already known, and why "does it work" is the wrong question

Both prior runs came back **complete**:

- `workflows-2026-09-01` — empty directory to a `wordcount` package with 10
  passing tests.
- `daily-chain-2026-09-01` — spec → implement → 34 tests, all passing, and a
  mutation check where **6 of 34 failed** when the implementation was broken.

So completion is saturated and cannot separate anything. What the second run also
found is where the signal actually is: hooked onto an existing project, the same
agent wrote 25 passing tests of which **4 pinned the planted bug** — tests that
pass today and block the correct fix tomorrow.

**A test suite that passes is not evidence. A test suite that fails when the code
is wrong is.** That is the measurement.

## Sequencing — the mechanism arm first, again

gnomon has a capability here that no peer has: `[verify] test_must_fail_first`
restores the non-test files, re-runs the check, and **refuses a test that still
passes** against the pre-turn code. It is off by default. There is now also a
scaffolded `skills/writing-tests.md` instructing spec-before-test authoring.

That gives a clean single-variable arm before any peer is involved:

| arm | variable | cost |
|---|---|---|
| **1a** | `test_must_fail_first` off → on | ~$10 |
| **1b** | `writing-tests.md` skill absent → present | ~$10 |
| **2** | gnomon vs opencode vs goose, **same model** | ~$30 |
| **3** | gnomon vs Claude Code, best against best — **confounded, descriptive** | ~$40 |

Arms 1a/1b gate the rest. Test authoring is this harness's worst measured
weakness — **1 in 9** unaided, three of nine asserting the bug as the contract —
and it was fixed once by an *instruction*. If neither mechanism moves the
mutation score, there is nothing to take to a peer.

## The task set

**Ten small, self-contained specifications**, each one paragraph of intent, each
deliberately **underspecified in exactly three named places** (recorded in the
apparatus, never shown to the agent). Examples: a money box with a withdrawal
rule, a rate bucketer, a semver comparator, a retry policy with jitter, a CSV
reader with quoting edge cases.

Small on purpose. The measurement is the quality of the tests and the handling of
ambiguity, and a large task buries both under implementation effort.

Each specification ships with, and never shows the agent:

- a **hidden reference implementation**,
- a **hidden reference test suite** written by hand,
- a **mutant set** — 12 programmatic mutations of the reference (boundary flips,
  operator swaps, off-by-one, dropped guard, swallowed error).

## The metrics

**Primary — mutation score.** The fraction of the 12 mutants killed by *the
agent's own tests*. Fully mechanical, continuous rather than binary, and it is
the only one of these numbers that says whether the tests are worth having.

**Secondary — bug-pinning rate.** Of the agent's tests, how many pass against a
*broken* reference — i.e. pin nothing, or worse, pin the bug. This is the
measured 4-in-25 failure, and it is what `test_must_fail_first` exists to refuse.

**Secondary — hidden-suite pass rate.** Does the implementation satisfy the
reference suite. Reported to catch the degenerate strategy of writing tests so
weak that everything kills nothing and the mutation score collapses honestly —
and the opposite one, of writing an implementation to its own tests.

**Secondary — underspecification handling.** For each of the three ambiguities,
did the agent (a) ask, (b) state an assumption in the spec or the report, or
(c) choose silently? Classified mechanically by structure, adjudicated blind on
ties. (a) and (b) both count as handled; only (c) is a miss. This is the axis
gnomon's design should be strongest on, because refusing-rather-than-assuming is
the whole posture, and it is the one no existing benchmark measures.

## Power — better than the audit arm, for once

Mutation score is a **continuous** per-specification measure, so 10 paired specs
× 2 passes = **20 paired observations** rather than 20 binary ones. At an
expected within-arm SD around 0.20, a paired Wilcoxon over 10 specs detects a
difference of roughly **0.15 in mutation score** — an effect size that
`daily-chain`'s 6-of-34 (0.18) is already in the neighbourhood of.

That is why this arm is worth running before the audit arm, and far before any
Terminal-Bench comparison: it is the cheapest place in this whole programme where
a real effect could actually clear the noise.

## Amendment, 2026-09-05, before any run

Two of the arms above were **null by construction**, found by reading
`prompt_loop.ts` rather than by spending. Recorded here rather than silently
restructured, because the pre-registration is only worth what its history shows.

**Arm 1a as designed cannot fire on greenfield.** `test_must_fail_first`
restores the turn's non-test files to their **pre-turn** state and re-runs the
check. On greenfield the pre-turn state of `moneybox.py` is the empty string, so
the restore breaks every test that imports the module, the check fails, and
`pinsNothing` can never be true. The mechanism is a no-op on a project that did
not exist before the turn — a real limit of the capability, and one worth
publishing on its own.

**And it does not fire on "write tests for this existing code" either.** The
guard is `wroteATest && sources.length > 0`, where `sources` is the non-test
files the turn wrote. A turn that writes only tests has no `sources`, so the
mechanism never runs.

So `test_must_fail_first` applies to exactly one shape: **a turn that changes an
implementation and adds a test for the change.** That is the fix-plus-regression
workflow, and it is the only place this arm can measure anything.

Arm 1a is therefore replaced by:

**Arm 1a′ (brownfield, fix-plus-test).** Each spec ships its reference
implementation carrying one planted defect, plus `SPEC.md` stating the intended
behaviour. The task is *fix the defect and add a regression test for it*. Single
variable: `test_must_fail_first` off → on.

**Primary endpoint for 1a′: does the resulting test FAIL against the original
defective implementation?** That is the "fails before, passes after" bar stated
directly, it is mechanically checkable by re-running the agent's test against the
pre-fix file, and it is the exact bar this harness measured a model clearing
**1 time in 9**.

Arm 1b (the `writing-tests.md` skill, on → off) is unaffected and stays on the
greenfield task, because an instruction applies where a capability does not.

## Apparatus defects, recorded as they were found

Kept here because each one looked like a result and was a fault in the probe,
and because the pre-registered rule is what caught all of them.

1. **A 60s pytest timeout in the mutation scorer.** These suites finish in well
   under a second, so 60s only ever applied to a mutant in an infinite loop —
   and `csvfield`, 37 mutation sites over a `while`, spent minutes per hanging
   mutant. The first cell produced one row in four minutes. 8s now, and a hang
   is correctly a **kill**. The run was stopped before the patch and restarted
   from scratch rather than edited underneath.

2. **The task prompt dictated the primary endpoint.** It said *"add a regression
   test that fails on the defective version and passes on your fix"* — which is
   the endpoint, given to both arms as an instruction. Both would have scored at
   ceiling and the comparison would have been uninformative by construction; the
   first three rows were already `bar_met=True`, mutation score 1.0, which is
   what that looks like from outside. **You cannot instruct the thing you are
   measuring.** The prompt now asks for what a person would actually ask for —
   *"fix it so it matches SPEC.md, and add unit tests for it"* — and whether the
   test catches the defect is a measurement again. Second restart.

3. **Cosmetic planted defects.** The first scorable mutation for `semver` turned
   `"."` into `".X"`, which breaks parsing outright and is visible from one line.
   Planting now prefers semantic classes — boundary flips and dropped guards —
   because a trivially easy task discriminates nothing between configurations.

## What must be true before it runs

- The mutant set must be **validated against the reference suite first**: every
  mutant must be killed by the hidden reference tests. A mutant nothing can catch
  is an apparatus defect that looks like an agent failure.
- The reference suite must be written **before** any agent output is seen.
- Runs must happen in a stranger's state — empty `XDG_DATA_HOME`, no exported
  keys, a fresh clone. Thirteen tests once passed locally and failed in CI over
  exactly that.

## What this cannot establish

- **Anything about large projects.** Ten small specifications say nothing about a
  50k-line greenfield build, and the completion-saturation above is evidence that
  size is where the difficulty lives.
- **Anything attributable to the harness in Arm 3.** Model, prompt and harness all
  differ. Descriptive, labelled, and never quoted as a harness claim.
- **That a high mutation score means good tests.** It means the tests discriminate
  against *these* mutants. A suite tuned to the mutant taxonomy would score well
  and generalise badly; the taxonomy is therefore fixed and published, so anyone
  can see what it does and does not cover.

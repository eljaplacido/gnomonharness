# Pre-registration — silent-success

Written before the apparatus ran, and before any result was seen.

## The question

> Is there anywhere this harness reports **success** while the thing underneath
> it failed?

Not "does it survive", and not "was the operator told". Whether the outcome it
*pronounces* can be false in the safe-looking direction.

## Why this benchmark and not another one

This repository has found the same bug four separate times, each by accident:

- `exit null` parsed as a clean zero by the verify gate — a check killed by a
  signal was indistinguishable from a green one, in the one mechanism whose job
  is to contradict a model claiming success.
- `bash` returning `TOOL_OK` for a command that ran and exited 1.
- v0.1.0's two mechanisms that reported success while doing nothing.
- Three more on 2026-09-04 (`fault-disclosure`): a 429 called "endpoint
  unreachable", a truncated tool call called a missing argument, dropped turns
  called folded.

Four accidents is a class, not a coincidence. This is the hunt.

## The population

Not every `catch` in the codebase — that is 130 blocks, overwhelmingly
bookkeeping that must never fail a turn, and a scan over them would produce a
waiver list nobody reads.

The population is **every place the harness pronounces an outcome**: the points
where something underneath is converted into a verdict a person or a model then
relies on. Each is named in `sweep.mjs` with the decision it makes.

That is a judgement about what counts, and it is stated here rather than
implied: a decision point missing from the list is invisible to this benchmark,
exactly as an undeclared degradation is invisible to `degradation-contract`. The
mitigation is the same — every incident that finds one adds a row.

## The rule, fixed now

For each decision point, run it **twice**:

1. **clean** — nothing injected. It must report success.
2. **broken** — the underlying thing is made to fail. It must **not** report
   success.

**Primary endpoint: `falsely_successful` — broken runs that still reported
success. It must be 0.** A single counterexample falsifies the claim; there is
no rate here and no MDE.

The clean run is not decoration. A probe that reports failure unconditionally
would score a perfect 0 on the primary endpoint while proving nothing, which is
the trap `manifest_golden.json` fell into by checking determinism — a property a
constant function also has. A row where the clean run does not report success is
**void**, not passing, and is reported as such.

## Negative control

A **seeded defect**: the historic `exit null → 0` rule, reimplemented here as a
decision point that reads a killed command's exit status the way this repository
actually read it before `902a93f`. It must be caught as `falsely_successful`. If
it is not, the detector cannot see the bug it was built for, the run exits 2 and
publishes nothing.

## What this cannot establish

- **That no silent success exists.** It establishes that none exists at the
  decision points named. That is a real limit and it is the reason the list is
  in the apparatus where it can be extended, rather than in prose.
- Anything about the model's own claims. Every probe reads real state — an exit
  status, a hash chain, a file on disk — never a report.

## Cost

**$0.** No model, no sampling, no trials.

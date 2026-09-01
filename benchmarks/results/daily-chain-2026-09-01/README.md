# The daily chain: spec → implement → tests → verify — 2026-09-01

The operator's own description of what has to work: *"all from spec generation
to task completion to unit tests, verification etc. should be working stably"*,
in the modes they actually work in — greenfield, and hooked onto an existing
project.

Model: Qwen3.6-35B, local. Verify gate declared (`python3 -m pytest -q`).
Everything below is read from real state — files on disk, pytest's exit code,
and **mutation checks** that ask whether the tests would catch anything.

## Greenfield — spec-driven

| Step | Outcome |
|---|---|
| spec (`plan` role) | ✅ `SPEC.md` with edge cases stated |
| implement | ✅ `moneybox.py` to the spec |
| unit tests | ✅ `test_moneybox.py`, **34 tests, all passing** |
| **mutation check** | ✅ **6 of 34 fail** when the implementation is broken |

The tests catch defects. This is the chain working.

## Existing project — the same agent, one step earlier

`src/rates.py` shipped with a planted defect: a `bucket()` whose third branch
repeats the second's bound, so it is unreachable.

| Step | Outcome |
|---|---|
| audit (`critique` role) | ✅ **found it**, by line, with the likely intent |
| unit tests | ⚠️ 25 tests, all passing — **and 4 of them pin the bug** |

> "Line 15 — Unreachable `elif` branch due to duplicate bound … The intent was
> almost certainly `total < 200`"

Then, asked to write tests for the same file, it wrote
`test_bulk_above_50` and `test_all_buckets_exhaustive` asserting the **buggy**
behaviour. Fix the defect the agent itself had just diagnosed, and **4 tests
fail**.

## The finding

**Tests describe what the code does, not what it should do — unless a spec says
what it should do.** Greenfield had a spec and produced tests that catch
defects. The existing project had none, so "write tests for this file" was
correctly interpreted as "characterise this file", bugs included.

This is not the agent failing to notice. It found the defect minutes earlier, in
the same session, in the same file. Nothing asked it to reconcile the two.

It reproduces the `pins the bug` column of
[test-authoring-2026-08-31](../test-authoring-2026-08-31/) — passes on broken
code, fails on fixed — on a realistic task rather than a constructed one.

## What to do with it

**Audit and fix before generating tests on an existing repository.** Tests
written first will cement whatever is there, and they will look green while
doing it. In that order the chain works: the audit step is reliable, and tests
written against corrected code are the greenfield case.

`[verify] test_must_fail_first` catches a *tautology* — a test that passes
before the code exists. It does not catch this: a bug-pinning test genuinely
fails before and passes after. Detecting it needs the defect list from the audit
step to reach the test step, which nothing in the harness currently does.

## Limits

One model, one pass per scenario, two scenarios. Establishes the mechanism and a
reproducible failure mode, not a rate.

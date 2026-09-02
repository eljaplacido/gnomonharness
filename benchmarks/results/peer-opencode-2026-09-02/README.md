# Peer comparison: gnomon vs opencode — 2026-09-02

The last claim in `docs/EVIDENCE.md` with no evidence behind it. Same 47 tasks,
same model (`deepseek-v4-flash`), same 900 s clock, same concurrency, same
machine, same night. The only variable is the harness.

**Headline: on equal terms there is no measurable difference.**

## The number you would get by not looking

| | valid trials | |
|---|---|---|
| gnomon, pass 1 | 26/45 | **57.8%** |
| gnomon, pass 2 | 24/45 | 53.3% |
| opencode | 17/44 | **38.6%** |

Paired on the 44 tasks valid in all three, gnomon single-pass 56.8% against
opencode 38.6%, McNemar **p = 0.039**. An 18-point win, nominally significant.

**That number is an artifact and should not be quoted.**

## What was actually happening

opencode auto-rejected its own permission prompts:

```
! permission requested: external_directory (/tmp/*); auto-rejecting
✗ python -m pypiserver run --port 8080 … > /tmp/pypi.log 2>&1 &
```

It happened on **11 of 45 trials**, and on those trials opencode solved **1 of
10** — against **47.1%** on the trials where it was not blocked. gnomon's arm ran
`gnomon task --yes`, i.e. with approvals granted. The two arms were not equally
handicapped, and the entire apparent gap sits in that difference.

## The comparison on equal terms

Excluding every task where opencode was blocked by its own gate, paired on the
remaining 34:

| | | |
|---|---|---|
| gnomon (single pass) | 17/34 | **50.0%** |
| opencode | 16/34 | **47.1%** |

Discordant: gnomon-only 3, opencode-only 2. **McNemar p = 1.0000.**

gnomon's second pass on the same 34 tasks scores 16/34 = 47.1% — identical to
opencode.

**There is no measurable difference between the two harnesses on this task set,
this model and this clock.**

## What this is and is not

**Is:** the first valid peer measurement this project has. The previous goose
figure predates the adapter repairs and has never been re-measured; opencode's
previous arm produced zero valid trials because its adapter could not parse a
three-part model id.

**Is not:** a claim that the harnesses are equivalent in general. One model, one
task subset, one pass for opencode, 34 paired tasks. And it is not a refutation
of gnomon's other measured properties — determinism, containment, auditability,
per-turn latency and cost are separate results and unaffected.

## The right fix, not yet done

Excluding the blocked trials is a defensible repair of a broken comparison, not
a substitute for running it correctly. The definitive version configures
opencode's permissions to match the consent gnomon was given and re-runs all 47.
Until that exists, the honest statement is the one above: **no measured
difference on the trials where both harnesses were allowed to work.**

## Why this is written this way

The naive reading — an 18-point win at p = 0.039 — was available, favourable,
and wrong. It survived only until someone asked whether the losing arm had been
allowed to run. The project's own discipline notes require exactly that check
and record the same failure from a previous campaign: *"opencode auto-rejected
on 17 of 48 trials, making its score a floor rather than a measurement."*
It happened again, and it was caught by looking rather than by the score.

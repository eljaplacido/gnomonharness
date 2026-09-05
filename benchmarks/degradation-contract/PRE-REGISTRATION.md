# Pre-registration — degradation-contract

Written before the apparatus ran, and before any result was seen. Committed in
the same commit as the first result so the order is checkable in `git log`.

## The question

`fault-disclosure` asks whether the operator was **told** when something went
wrong. This asks a second question that comes apart from the first:

> When this harness carries on with less than it declared, is the degradation
> **recorded** — durably, in the trail, where somebody reading afterwards can
> find it?

The two are not the same, and the difference is the whole point. A line on the
terminal is gone when the scrollback is. A spinner frame is gone when the next
frame paints. `gnomon task` in a script has no scrollback at all. The
[Post-incident · oversight] use case this project publishes is *"what was
permitted? who approved?"* — a degradation that only ever reached the terminal
cannot answer it.

## The population

**The code's own declaration**, not a list kept here. `DEGRADATION_IDS`, exported
from `packages/gnomon-core/src/degradation.ts`, is the registry; this apparatus
imports it and fails if it cannot probe every id in it.

That direction matters. A benchmark holding its own copy of the population
measures its copy, and drifts from the code the moment somebody adds a path.
Registering a path without wiring it breaks this benchmark, which is the
intended direction: the list is a contract and an unkept contract should break
something.

## The two endpoints, fixed now

For each declared degradation, inject it and score:

1. **announced** — operator-visible output names *this* degradation. Naming *a*
   degradation counts for nothing; the row's `must` regex names the right one,
   and a `mustNot` regex fails a row that names the wrong one.
2. **recorded** — after the run, a durable artefact identifies it: an audit
   record (any kind — a `verify` record, a `tool_call` result, or the
   `degradation` kind), or a named field on the turn record. The row states
   which artefact it expects, so "recorded" can never be satisfied by something
   incidental.

**Primary endpoint: `complete` = announced AND recorded, over the declared
population.** Reported as a fraction of `DEGRADATION_IDS.length`. Announced-only
counts as a miss. This is stated now because announced-only is the result that
would be tempting to report as a pass.

## Negative controls — both directions, before any measurement

A detector that has never returned a negative cannot be trusted to return one.
Both must fire or the run exits 2 and publishes nothing:

- **announced control** — a probe whose operator text is replaced with a
  plausible but wrong sentence must score `announced=false`.
- **recorded control** — a probe run against a trail that swallows every write
  must score `recorded=false`.

## What would falsify the claim this benchmark supports

The claim is *"a degradation is answerable from the record afterwards."* It is
falsified by any declared id that is announced and not recorded. One
counterexample is enough — there is no sampling here, no noise floor, and no
MDE, because every probe is deterministic and the population is exhaustive over
what the code declares.

## What this cannot establish

- That the population is complete **in the world**. It is complete with respect
  to the code's declaration. A degradation nobody has declared is invisible to
  this, exactly as it is to `fault-disclosure`. The mitigation is the same:
  every real incident that finds an undeclared path adds one.
- That a record is *understood*, only that it is present and identifies the
  right path.
- Anything about task completion. Nothing here runs a model.

## Cost, and why not Terminal-Bench

**$0.** No model, no sampling, no trials. A scored task run cannot answer this
question at any price: a degradation that is survived correctly does not change
whether the task passed, so the entire measurement is invisible to a
completion rate by construction — and at this harness's measured 11.9–14.9%
self-flip, a real effect would be buried anyway.

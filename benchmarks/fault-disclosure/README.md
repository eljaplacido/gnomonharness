# When something goes wrong, does the harness say so? — 2026-09-04

**8 of 8 faults disclosed, after three real defects were fixed to get there.**
Pre-registered in `PRE-REGISTRATION.md`; reproduce with `node disclose.mjs`.
Raw in `result.json`.

## What was measured

Surviving a fault is not the property that matters — a fault ridden out silently
produces an answer the operator has no reason to distrust, which is worse than a
visible failure. So the headline is **disclosure**, and survival is reported
beside it without being the score.

Eight faults, injected directly: the four canonical agent faults (timeout, rate
limit, partial response, schema drift) plus four degradation paths this harness
declares for itself. For each: did it survive, did it degrade as declared, and
**does the operator-visible text name what actually went wrong**.

Naming *a* fault counts for nothing — the rule requires naming the *right* one.

## Result

| fault | survived | degraded | disclosed |
|---|---|---|---|
| rate limit (429) | ✅ | ✅ | ✅ |
| endpoint timeout | ✅ | ✅ | ✅ |
| partial response — truncated tool arguments | ✅ | ✅ | ✅ |
| schema drift — unknown tool | ✅ | ✅ | ✅ |
| command exits non-zero | ✅ | ✅ | ✅ |
| output over the window | ✅ | ✅ | ✅ |
| compaction with no reachable `summary_role` | ✅ | ✅ | ✅ |
| gated call with nobody to ask | ✅ | ✅ | ✅ |

**Disclosure 8/8 = 100%.** Survival was 8/8 before any of the fixes below, which
is the point: all three defects were invisible to a survival-only measure.

## Three defects it found, all of the same shape

Each survived, degraded correctly, and told the operator something true-sounding
with a false premise.

1. **A rate limit was reported as "endpoint unreachable".** `classifyFailure`
   folds 429, 5xx and a refused socket into code 12 — correct for retry policy,
   since another attempt can fix any of them — and the retry notice printed the
   same sentence for all three. The endpoint was reachable and *rejecting*, and
   the remedies do not overlap: unreachable sends you to your network, a 429
   sends you to your quota. The notice now names which one happened.

2. **A truncated tool call was reported as a missing argument.** Arguments
   arrive from OpenAI-shaped endpoints as a JSON *string*; a response cut off by
   a token limit yields `{"path": "src/ma`. `JSON.parse` threw, the catch
   returned `{}`, and `read {}` answered *"read needs a `path`. Nothing was
   given"* — true sentence, false premise. Told an argument is missing a model
   invents one; told the call was truncated it re-emits it. Now named as a
   transit truncation, with the bytes that did arrive.

3. **Dropped turns were reported as folded.** The context notice chose its
   wording from the *declared* `compaction` rather than from what happened, so a
   surface with an unreachable `context.summary_role` was told *"24 earlier
   turn(s) folded into the summary"* while those turns were dropped outright.
   Reachable **by default** since `compaction` became `summary` earlier the same
   day — a pre-existing wrong message that only started mattering hours before
   this run found it.

That is one bug class, and this repository had already found it three separate
times by accident: `exit null` read as a clean zero by the verify gate, `bash`
returning `TOOL_OK` for a command that exited 1, and v0.1.0's two mechanisms
that reported success while doing nothing. This is the first time it was hunted
rather than stumbled into.

## Negative control

A disclosure detector that has never seen a non-disclosure cannot be trusted to
notice one. Before measuring, the suite scores a deliberately suppressed
disclosure — a 429 whose only trace says "endpoint unreachable", which is
literally what the code did before defect 1 was fixed — and requires it to come
back **undisclosed**. It does. Without that the run exits 2 and publishes
nothing.

## What this does not establish

It cannot show a disclosure is *understood*, only that it is present and names
the right fault. And the population is a list, not a proof of completeness: it
should grow every time a real incident finds a fault it does not contain. Adding
one is a row in `FAULTS` in `disclose.mjs`.

## Cost

**$0.** No model, no sampling, no noise floor, no MDE — an undisclosed fault is a
counterexample, not a low score. A scored task run could have answered the same
question at roughly $1.20 a cell with the answer buried under a 12–15% self-flip.

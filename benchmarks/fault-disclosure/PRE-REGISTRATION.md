# Pre-registration — when something goes wrong, does the harness say so?

**Written 2026-09-04, before the first measurement.** Committed ahead of any result.

## The claim under test

Chaos-engineering work on agents makes one point this project keeps rediscovering
on its own: *a system can return HTTP 200 while being semantically wrong*.
Surviving a fault is not the property that matters. **Being told** is.

gnomon has found this three separate times without naming it:

- the verify gate read `exit null` as a clean zero and reported a segfaulted
  check as PASSED;
- `bash` returned `TOOL_OK` for a command that ran and exited 1, so a failing
  test run folded away as one more quiet step (fixed 2026-09-04);
- v0.1.0 shipped two mechanisms that reported success while doing nothing.

Three instances of one bug class, each found by accident. This measures the
class deliberately.

## Why this is NOT a Terminal-Bench arm, stated before spending anything

The question is *"when fault F is injected, does the operator learn that F
happened?"* — a per-fault yes/no with a deterministic answer, not a rate over a
task distribution. Injecting faults into a scored task run would answer it at
roughly $1.20 a cell, with the answer buried under a 12–15% self-flip.

So: injected directly, **$0, no model, no sampling**. There is no MDE because
there is no estimate. A fault that is not disclosed is a counterexample, not a
low score.

## Scoring rule, fixed in advance

For each injected fault, three independent booleans:

1. **survived** — the turn returned a result instead of throwing.
2. **degraded as declared** — the documented fallback ran.
3. **disclosed** — the operator-visible trace, the answer, or the tool log
   *names what actually went wrong*.

**PRIMARY: disclosure rate = disclosed / injected. It must be 1.0.**
Survival is reported but is explicitly NOT the headline: a fault ridden out
silently produces an answer the operator has no reason to distrust, which is
worse than a visible failure.

**Naming the right fault counts; naming a fault counts for nothing.** A 429
reported as "endpoint unreachable" is not disclosure — it is a true-sounding
sentence with a false premise that sends the operator to their network instead
of their quota. Both halves of that were live defects when this was written.

Cells assert-sum to the number of faults injected.

## Population

The four canonical agent faults, plus the degradation paths this harness
declares for itself:

| fault | what must be disclosed |
|---|---|
| endpoint timeout | that it timed out, and the deadline |
| rate limit (429) | that the endpoint was *rate limiting*, not unreachable |
| partial response — truncated tool arguments | that the call was cut off in transit, not that an argument was missing |
| schema drift — a tool call naming a tool the role does not have | which tool, and what the role may actually call |
| tool output over the window | that the output is partial, and where the rest is |
| a command that exits non-zero | the exit status, distinctly from a tool that failed |
| compaction with no `summary_role` | how many turns were dropped instead of folded |
| a gated call with nobody to ask | that it was refused for want of an approver |

## Negative control — run before any result is believed

A disclosure detector that has never seen a non-disclosure cannot be trusted to
notice one. Before reporting, the suite injects a fault whose disclosure is
deliberately suppressed and asserts it is scored **undisclosed**. If the control
does not fire, the run is void and the number is not published.

## What this cannot establish

It cannot show the disclosure is *understood*, only that it is present and names
the right fault. It also cannot cover a fault nobody has thought of — the
population above is a list, not a proof of completeness, and it should grow every
time a real incident finds something it does not contain.

# T7v3 / T8 — fixing is not verifying

**2026-09-01.** $0, local Qwen3.6-35B. 18 + 9 trials.

Two runs on the *same three fixtures*, which are proven separable by
`validate_fixtures.py`, asking two different things of the same model.

## The result

| task | outcome |
|---|---|
| **fix the bug** (T7v3) | **18 / 18** — verify gate off *and* on |
| **write a test that pins the behaviour** (T8) | **1 / 9** |

The model repairs these bugs perfectly and cannot write a test for them.

## T8 in detail — the failure shapes matter

| fixture | verdicts |
|---|---|
| `bucket` | **pins the bug ×3** |
| `dedupe` | wrong, **real test**, wrong |
| `parse_port` | wrong ×3 |

"Pins the bug" is the worst outcome available: the test asserts the *broken*
behaviour as if it were the contract. It passes today and **blocks the correct
fix tomorrow** — strictly worse than writing no test.

Only 1 of 9 both failed on the broken code and passed on the fixed one.

## T7v3 is inconclusive, for the third time, and now that is itself the finding

v1 (trivial bug), v2 (boundary bug) and v3 (the separable fixtures) all came back
with the model solving everything: **20/20, then 18/18**. An arm comparison where
neither arm can fail measures nothing, so the verify gate's *value* remains
unmeasured after 38 trials.

That is no longer a fixture problem. Three fixture generations, deliberately
harder each time, and the model does not fail at *fixing*. Measuring the gate
needs a weaker model or genuinely harder bugs, and saying so is more useful than
manufacturing a number.

## What this changes

**Verification must rest on declared checks, never on tests the model wrote in
the same turn.** A verifier stage leaning on model-authored tests would be
leaning on something right 1 time in 9 and actively harmful 3 times in 9.

That sharpens the role-chain design rather than blocking it: the chain is
buildable, but its verifier gates on the repository's own suite.

It also produced a concrete fix — `[verify] test_must_fail_first` (`24de0df`),
which restores the pre-turn sources and re-runs the check, rejecting any test
that passes against the code as it was. It would have caught 8 of T8's 9.

## Reproducing

```bash
cd ../test-authoring-2026-08-31 && python3 validate_fixtures.py   # control first
TRIALS=3 python3 runner_t7v3.py      # the fix task
TRIALS=3 python3 runner_t8.py        # the test-writing task
```

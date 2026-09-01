# Verify gate — does it convert failures into passes? 2026-09-01

The 2026-08-31 run was inconclusive for a reason that was never the gate's
fault: the model fixed 18/18 unaided, so **there was nothing to catch**. A
safety net cannot be measured against work that never falls.

So the catchable population was manufactured rather than waited for: hidden
tests the agent never sees, and — in round 2 — tasks that **cannot be satisfied
by writing plausible code**, only by making something actually run. That is
faithful to the failure the gate was built for: a turn that wrote a setup
script, ran `bash -n`, reported "syntax check passed" and stopped, having
installed nothing.

One variable: `[verify]` declared or not. Scored from the hidden test, never
from the agent's account.

## Result

**Round 2 — execution-only** (install a package, write a config, make a package
importable, make a script executable). Model: Qwen3.6-35B.

| task | gate off | gate on |
|---|---|---|
| pkg | pass | pass |
| cfg | pass | pass |
| imp | **fail** | **pass** |
| perm | **fail** | **pass** |
| | **2/4** | **4/4** |

**Round 1b — algorithmic** (roman numerals, brackets, ranges, wrapping, LRU,
base-N). Model: qwen2.5:7b, chosen to raise the first-attempt failure rate.

| | gate off | gate on |
|---|---|---|
| | **3/6** | **4/6** |

**Combined: 5/10 → 8/10. Three conversions, zero regressions.**

## What it does and does not show

**Does:** on work that is actually wrong, the declared check converts failures
into passes, and never turned a pass into a failure. Both round-2 conversions
are the archetype — `imp` and `perm` both *look* finished from the code alone
and are only knowably done by running something.

**Does not:** clear a significance bar. Ten trials, 0:3 discordant, exact
p = 0.25. And the noise here is large: round 1's `off` arm scored 5/6 on the
same six tasks where round 1b's `off` arm scored 3/6 — identical configuration,
two flips. Part of the +3 could be that.

## The finding that cost the most to get

Round 1's `on` arm is **discarded**: its check was `pytest -q hidden_test.py`
against plain assert scripts, which errors during *collection*, so the gate
reported failure every round regardless of the code. The model believed it and
rewrote already-correct work — `wordwrap` was correct without the gate and
broken with it.

**A misconfigured check is worse than no check.** It does not fail neutrally; it
degrades the work. That produced a fix (`902a93f`): an unrunnable check is now
reported as unrunnable, recorded with `unrunnable: true`, not handed back to the
model, and — equally important — not called a pass either.

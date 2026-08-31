# T8 — can the harness write a test that actually pins behaviour?

**Built 2026-08-31. Fixtures validated; the measurement has not been run yet** —
local inference would have contended with the overnight Terminal-Bench arms.

## Why this dimension

Writing a regression test when something changes or breaks is core to working in
a codebase, and nothing in the other seven suites touches it. It is also the
capability the role chain depends on: a verifier stage is only worth having if
the tests it relies on are real.

## The criterion, which cannot be gamed

> A test is good **iff it fails on the broken code and passes on the fixed code.**

That single rule separates the four outcomes without human judgement:

| agent's test | broken | fixed | verdict |
|---|---|---|---|
| real test | fails | passes | ✅ the only one that counts |
| tautology (`assert True`, or asserts the buggy behaviour) | passes | passes | caught nothing |
| wrong | fails | fails | would block a correct fix |
| pins the bug | passes | fails | encodes the defect as the contract |

The agent sees **only the broken module** and is never told what the bug is. It
is asked to write a regression test for the documented behaviour.

## The fixtures, and why these three

T7's fixtures were solved 20/20, so they could not discriminate anything. These
sit at the failure boundary — each has a plausible-looking test that passes on
both versions:

- **`bucket`** — off-by-one at an inclusive boundary. A test written from the
  docstring without considering edges passes both.
- **`dedupe`** — mutates its argument. A test that only checks the *return
  value* passes both.
- **`parse_port`** — swallows the error it documents. A happy-path test passes both.

## Negative control — run before any measurement

`validate_fixtures.py` proves each fixture is separable *before* it is used:

```
  bucket       broken:fail  fixed:PASS   usable
  dedupe       broken:fail  fixed:PASS   usable
  parse_port   broken:fail  fixed:PASS   usable

  bucket       tautology passes both: True  (correctly scores 0)
  dedupe       tautology passes both: True  (correctly scores 0)
  parse_port   tautology passes both: True  (correctly scores 0)
```

Without this control, a fixture nothing could separate would score every model
zero and read as a model failure — the same mistake as scoring a probe that
could not run a command. The reference tests are never shown to the agent.

The runner also fails a trial that **modifies the module under test**, which is
the one cheat this design otherwise allows.

## Running it

```bash
python3 validate_fixtures.py     # negative control first, always
TRIALS=3 python3 runner_t8.py    # needs an OpenAI-shaped endpoint on :18080
```

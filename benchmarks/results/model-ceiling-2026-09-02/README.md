# Model ceiling: does a stronger model move it? — 2026-09-02

Build held fixed (`bench/chain-2026-09-01` @ `bb71829`), model varied. This is
the arm that separates "the harness is the ceiling" from "the model is".

15 tasks (the first 15 of the pre-registered list, chosen before any result was
seen), same clock, same concurrency.

| model | list price | result |
|---|---|---|
| `deepseek-v4-flash` | $0.08 / $0.16 per M | 5/12 = **41.7%** |
| `gpt-5.6-luna` | $0.20 / $1.20 per M | 6/12 = **50.0%** |

Paired on the 12 tasks valid in both: discordant 3 luna-only, 2 flash-only,
**McNemar p = 1.0000**.

**A model at 2.5× the input price and 7.5× the output price shows no measurable
gain on this task set.**

## Limits, and they are severe

Twelve paired tasks is very little. This cannot detect anything smaller than a
large effect, and "no measurable difference" here is close to uninformative on
its own. It is reported because it points the same way as the other two
comparisons run the same night — the chain (p = 0.375) and opencode
(p = 1.0000) — and three nulls in a row is worth knowing even when each is
individually weak.

## Apparatus

The first attempt at this cell reported 0.00% and must not be read as a result.
It ran for 108 seconds and spent $0.006 — impossible for 15 trials — because
the adapter derives its provider from the FIRST path segment, so
`openai/gpt-5.6-luna` was parsed as provider "openai" and raised "unknown
provider" before a container was built. 14 of 15 trials returned
`unknown_agent_error` and no gnomon log was written at all. The correct id is
the three-part `openrouter/openai/gpt-5.6-luna` — the same shape that had broken
the opencode adapter the day before.

The tell was the spend, not the score. The re-run asserts how many trials wrote
a gnomon log and warns if fewer than five.

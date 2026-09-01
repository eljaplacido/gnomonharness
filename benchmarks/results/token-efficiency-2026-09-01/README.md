# Token efficiency — 2026-09-01

The first cost measurement here derived from **actual per-turn token counts**
rather than credit-delta arithmetic. The 2026-08-30 report published 4.17×
cheaper per trial and then corrected itself: its divisor was invented, the same
method recorded `spent = -$9.26` for one arm, and its own verdict was *"the
method is broken, not merely coarse"*.

This uses gnomon's audit trail, which records `tokens_in` / `tokens_out` per
turn. Terminal-bench captures neither, for any harness — which is why this had
to wait for the trail to be archived out of the container at all.

15 tasks, `deepseek-v4-flash`, build `bench/levers-2026-08-31`. Trails recovered
for **9 of 15** trials.

## Result

| | per trial |
|---|---|
| mean tokens **in** | **604,769** |
| mean tokens **out** | **14,739** |
| ratio | **41 : 1** |
| billed (credits delta, clean window) | **$0.0153** |
| naive token arithmetic | $0.0507 |

Heaviest trials:

| task | tokens in | out | tool steps |
|---|---|---|---|
| 3d-model-format-legacy | 2,453,540 | 38,232 | 78 |
| find-restaurant | 1,858,209 | 31,788 | 158 |
| cartpole-rl-training | 403,843 | 9,946 | 34 |

## Two things worth knowing

**Cost is context re-sending, not generation.** At 41:1, essentially all of it
is the conversation being resent each turn — a 158-step trial pays for its
transcript 158 times. The lever on cost is therefore **context management**
(compaction, trimming, what a tool result puts back into the window), not
shorter answers. Optimising output length would move about 2% of the bill.

**Naive token arithmetic overstates the bill by 3.3×.** $0.0507 computed from
list prices against $0.0153 actually charged. The gap is prompt caching: a
turn's prefix is largely identical to the last one, which is exactly the shape
caching is built for. Any cost claim derived from token counts and a price
list — including the "4.17× cheaper" figure — is wrong by roughly this factor
unless it accounts for caching.

## Limits

- 9 of 15 trials produced a trail; the rest failed before writing one. The
  survivors may skew toward trials that got further, and therefore cost more.
- One model, one build. Nothing here is a peer comparison: terminal-bench
  records no tokens for opencode or goose either, so a like-for-like efficiency
  number still does not exist.
- The billed figure is a credits delta over a window where this cell was the
  only thing running. That is far better than the method it replaces, but it is
  still a delta; `GET /api/v1/generation?id=` per call remains the exact ledger.

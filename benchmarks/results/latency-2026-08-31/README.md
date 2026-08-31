# T5 — per-turn harness overhead

**2026-08-31.** $0. gnomon `e50daff` vs opencode `1.18.25`, same model
(Qwen3.6-35B-A3B-Q4 on a local llama-server), same endpoint, same prompt,
7 trials each.

Speed is not a claim either harness makes, but overhead is a real daily cost: it
is paid on every turn, and a harness that adds a second per turn to a fifty-turn
session has spent a minute of the operator's day on itself.

## Method

The **floor** is a bare HTTP call to the same model — time neither harness can
avoid. Overhead is measured against it, so a negative number would mean the
apparatus was wrong rather than that a harness was free.

Both are measured **cold**, one process per turn, which is how a benchmark
adapter invokes them and the worse case for gnomon (it pays `tsx` startup every
time). opencode ran with a warm provider cache, which is the better case for it.

## Result

| | median | min | max | overhead vs floor |
|---|---|---|---|---|
| raw endpoint (floor) | 99 ms | 94 | 337 | — |
| **gnomon** | **322 ms** | 305 | 437 | **~223 ms** |
| opencode | 1680 ms | 1608 | 7650 | ~1581 ms |

**gnomon is ~5.2× faster per turn, and its overhead is ~7× smaller.**

## Reading it honestly

- The comparison is **cold-start for both**. An interactive gnomon session pays
  its startup once, not per turn, so the in-session overhead is lower than 223 ms
  — this number is the benchmark-adapter case, not the daily-use case.
- opencode's 7650 ms max is a single outlier; its median is stable at ~1.6 s.
- `n=7` per arm. Enough to separate 322 from 1680, nowhere near enough to
  resolve a 20 ms difference, and no such claim is made.
- This measures **overhead, not capability**. opencode does more per turn
  (a server, sessions, an event stream), and some of that cost buys features
  gnomon does not have. Fast and less capable is not automatically better.

## What it supports

The ROADMAP notes ~197 ms of every invocation is `tsx`, and this puts a number
next to it: roughly the whole of gnomon's overhead is process startup. A compiled
entry point would take the per-turn cost close to the floor, and that is now a
measured target rather than a guess.

## Reproducing

```bash
./latency.sh 7      # needs an OpenAI-shaped endpoint on :18080
```

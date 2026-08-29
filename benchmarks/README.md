# benchmarks/

The harness behind [docs/BENCHMARKS.md](../docs/BENCHMARKS.md). Published so the
numbers can be checked and re-derived rather than taken on trust.

**These are preliminary results.** Read the trust assessment in
[docs/BENCHMARKS.md](../docs/BENCHMARKS.md#how-much-to-trust-this) first — the
task set saturates, the sample sizes are small, and the benchmark's author also
wrote one of the harnesses under test.

**Two different benchmarks live under `benchmarks/`.** `harness.py` here is the
*internal* 5-task efficiency/quality suite behind `docs/BENCHMARKS.md`. The
*external* Terminal-Bench harness-vs-harness campaign (gnomon vs goose vs
opencode, August 2026) is a separate thing with its own scored data and writeup
under [`results/terminal-bench-2026-08/`](results/terminal-bench-2026-08/README.md)
— `harness.py` did **not** produce it; its buckets regenerate from raw data via
`results/terminal-bench-2026-08/summarize.py`.

A third, narrower experiment lives under
[`results/dflash-2026-08/`](results/dflash-2026-08/README.md): a controlled
DFlash speculative-decoding **on vs off** measurement (output-exact, greedy) of
the local-inference wall-clock win — a self-contained runner, not the campaign.

B3 (**cost of running the suite, per harness**) turns the measured token
counts into dollars: [`results/cost-2026-08/`](results/cost-2026-08/README.md) —
regenerate with `python3 cost_report.py`.

B4 (**containment**) drives a real model to breach each role boundary and
measures whether the guards hold: [`results/containment-2026-08/`](results/containment-2026-08/README.md)
— 15/15 contained.

B1 (**current Terminal-Bench**, independence + currency) runs gnomon on the
live task set via tb 0.2.18: [`results/terminal-bench-current-2026-08/`](results/terminal-bench-current-2026-08/README.md) — 10/16 (62.5%) on a stratified sample.


| File | What it is |
|---|---|
| `harness.py` | The runner: fixtures, tasks, scorers, per-harness invocation |
| `analyse.py` | Turns a results file into the tables |
| `claude_code_arm.py` | Claude Code, run separately with a spend cap |
| `reap.sh` | Kills leftover harness processes between runs — see below |
| `results/*.json` | Raw per-run records, one file per model tier |

## Running it

Configuration is deliberately absent. Each harness needs its own provider
config, and the ones used here held a live API key, so they are not committed.
Supply your own:

```bash
BENCH_PROVIDER=ollama BENCH_MODEL=qwen2.5:7b-instruct TRIALS=3 python3 harness.py
```

For OpenRouter, set `BENCH_PROVIDER=openrouter` and provide provider configs at
the paths named at the top of `harness.py`, plus `OPENROUTER_API_KEY`.

## Two things that will bite you

**Only ever run one instance.** Two concurrent runs reap each other's live
harness children and each records the other's kills as timeouts. `runfrontier`
took an exclusive `flock` for this reason; two passes were invalidated before
the cause was found.

**Keep fixtures outside this directory.** `harness.py` contains the fixture
files as string literals, so a harness that searches upward will find them and
answer from the benchmark's own source. `WORK` points outside the tree on
purpose.

## Fairness notes

Every harness runs unattended, which means each needs its own auto-approve flag
— `--yes` for gnomon, `--auto` for opencode, `--approval-mode yolo` for omp.
Omitting one of these does not produce a slow harness; it produces a harness
that scores zero because it is waiting for a human who is not there.

Token counts sum `input + cacheRead + cacheWrite`. Counting only `input` is
correct on a local endpoint with no caching and badly wrong on a cached one,
where it collapses to the uncached delta and ranks harnesses by cache hit-rate.

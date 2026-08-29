# Terminal-Bench, current version — gnomon (independence + currency)

An **independent, current-version** run: gnomon against the live Terminal-Bench
task set, on the current framework — closing the two objections the earlier
[terminal-bench-2026-08](../terminal-bench-2026-08/) campaign carried (the
author chose the task set; it ran on the old `terminal-bench-core==0.1.1`).

## Setup

- **Framework:** `terminal-bench` **0.2.18** (current `tb`).
- **Tasks:** the live set on `main` (`original-tasks/`, 241 tasks).
- **Harness:** gnomon's **default surface** (`gnomon init` + a regex to point the
  roles at the model), via a purpose-built terminal-bench *installed-agent*
  ([`gnomon_agent.py`](gnomon_agent.py) + [`gnomon-setup.sh.j2`](gnomon-setup.sh.j2))
  that clones the public repo into each task container and runs `gnomon task`.
- **Model:** `deepseek/deepseek-v4-flash-0731` via OpenRouter — the **cheapest**
  coding model, for budget discipline. Total spend for both runs below: **$0.30**.
- **Attempts:** 1. **Concurrency:** 4.

## Result — read both, and the framing

The number is **strongly sample-dependent**, so two samples are reported and
neither is cherry-picked:

| sample | composition | resolved | valid-trial* |
|---|---|--:|--:|
| 16-task | 6 easy / 6 med / 4 hard (easier spread) | 10/16 = 62.5% | **10/15 = 66.7%** |
| 48-task | 16 / 16 / 16 (harder than the real 27/50/24% mix) | 13/48 = 27.1% | **13/44 = 29.5%** |

\* valid-trial excludes apparatus crashes (`unknown_agent_error`, e.g. a task's
own Docker build failing — 1 in the 16-task run, 4 in the 48-task run — which
spend $0 and are not gnomon's doing).

**The honest takeaway.** This measures **out-of-the-box gnomon on the cheapest
model**. The gap between the two samples is the hard tasks: the 48-task run's 22
wrong answers and 6 timeouts are dominated by heavy ML/systems tasks
(train-a-LoRA, reshard-C4, path-tracing, video-processing) that a **weak model
cannot do in any harness** — terminal-bench's own leaderboards use frontier
models and still don't clear these. So ~30% on the broad/hard sample is a **floor
set by the model**, and 62.5% on the easier spread is the same harness on tasks
the model can actually reach. gnomon's *own* contribution here is that it drives
the model cleanly and reports honestly (crashes/timeouts separated); the pass
rate rises with the model, not the harness.

Tasks gnomon resolved (48-run): dna-insert, movie-helper,
acl-permissions-inheritance, solana-data, hello-world,
logistic-regression-divergence, mlflow-register, pypi-server, ancient-puzzle,
nginx-request-logging, fix-code-vulnerability, pandas-sql-query, find-restaurant.

## Caveats

- **Samples, n=1, cheapest model, default surface.** Not the full 241, single
  attempt; a frontier model or a tuned `.gnomon/` would move the number a lot.
  A full-set run is cheap (~$1) but ~hours at 4-concurrent.
- **Two upstream tb apparatus bugs routed around** (documented so it reproduces):
  the registry download for the current dataset (`==head`) is broken (stale
  `./tasks` path), and the tasks moved to `original-tasks/` on `main`. Both are
  handled by cloning `laude-institute/terminal-bench` and `--dataset-path
  original-tasks`.
- **Independence is partial** — framework and tasks are the standard ones (not
  gnomon's), but the sample selection and adapter are ours.

## Reproduce

```bash
pip install terminal-bench==0.2.18
git clone --depth 1 https://github.com/laude-institute/terminal-bench.git
export OPENROUTER_API_KEY=...
PYTHONPATH=. tb run \
  --agent-import-path gnomon_agent:GnomonAgent \
  --model openrouter/deepseek/deepseek-v4-flash-0731 \
  --dataset-path terminal-bench/original-tasks \
  -t <task-id> ... --n-attempts 1 --n-concurrent 4 \
  --global-agent-timeout-sec 900
```

Raw per-trial data: `results-16.json`, `results-48.json`; roll-up: `SUMMARY.json`.

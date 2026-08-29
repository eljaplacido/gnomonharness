# Terminal-Bench, current version — gnomon (independence + currency)

An **independent, current-version** run: gnomon against the live Terminal-Bench
task set, on the current framework — closing the two objections the earlier
[terminal-bench-2026-08](../terminal-bench-2026-08/) campaign carried (author
chose the task set; ran on the old `terminal-bench-core==0.1.1`).

## Setup

- **Framework:** `terminal-bench` **0.2.18** (the current `tb`), not the old core.
- **Tasks:** the live set on `main` (`original-tasks/`, 241 tasks). A **16-task
  stratified sample** — 6 easy / 6 medium / 4 hard, spread across the alphabet.
- **Harness:** gnomon's **default surface** (`gnomon init` + a regex to point the
  roles at the model), driven by a purpose-built terminal-bench *installed-agent*
  ([`gnomon_agent.py`](gnomon_agent.py) + [`gnomon-setup.sh.j2`](gnomon-setup.sh.j2))
  that clones the public repo into each task container and runs `gnomon task`.
- **Model:** `deepseek/deepseek-v4-flash-0731` via OpenRouter — the cheapest
  coding-capable model, for budget discipline.
- **Attempts:** 1. **Concurrency:** 4.

## Result

**gnomon resolved 10 / 16 = 62.5%** (valid-trial **10 / 15 = 66.7%**, excluding
one apparatus crash). **Cost: $0.062** for the whole run.

| task | outcome |
|---|---|
| constraints-scheduling | ✅ resolved |
| catch-me-if-you-can | ✅ resolved |
| regex-chess | ❌ unset |
| mailman | ❌ unset |
| protocol-analysis-rs | ❌ unset |
| accelerate-maximal-square | ❌ unknown_agent_error |
| fix-pandas-version | ✅ resolved |
| gcc-compiler-optimization | ✅ resolved |
| fix-code-vulnerability | ✅ resolved |
| movie-helper | ❌ agent_timeout |
| sparql-professors-universities | ✅ resolved |
| recover-accuracy-log | ✅ resolved |
| 3d-model-format-legacy | ❌ unset |
| jq-data-processing | ✅ resolved |
| acl-permissions-inheritance | ✅ resolved |
| modernize-fortran-build | ✅ resolved |

Failure modes: 4 wrong answers, 1 crash (`unknown_agent_error`), 1 `agent_timeout`.

## Caveats (read before citing)

- **A 16-task sample, n=1** — not the full 241, and single-attempt, so the number
  is a signal, not a ranked score. The sample was chosen by difficulty strata; a
  full-set run (cheap, ~$0.9, but ~hours at 4-concurrent) would remove even the
  sample-selection choice.
- **Cheapest model, default surface** — a different model or a tuned `.gnomon/`
  would move the number; this measures out-of-the-box gnomon on a weak model.
- **Two upstream apparatus bugs routed around**, both documented so the run
  reproduces: (1) tb's registry download for the current dataset (`==head`) is
  broken (it points at a stale `./tasks` path), and (2) the tasks moved to
  `original-tasks/` on `main`. Both are handled by cloning
  `laude-institute/terminal-bench` and using `--dataset-path original-tasks`.
- **Independence is partial** — the framework and tasks are the standard ones (not
  authored by gnomon), but the sample selection and adapter are ours.

## Reproduce

```bash
pip install terminal-bench==0.2.18
git clone --depth 1 https://github.com/laude-institute/terminal-bench.git
export OPENROUTER_API_KEY=...            # cheapest model; the agent reads this
PYTHONPATH=. tb run \
  --agent-import-path gnomon_agent:GnomonAgent \
  --model openrouter/deepseek/deepseek-v4-flash-0731 \
  --dataset-path terminal-bench/original-tasks \
  -t <task-id> ... --n-attempts 1 --n-concurrent 4 \
  --global-agent-timeout-sec 900
```

The agent installs gnomon (node + pnpm, no Rust build) into each task container
and runs `gnomon task` against the model; raw per-trial data is `results.json`.

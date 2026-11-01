# R1: local, cloud and mixed model routing (pre-registration, DRAFT)

Status: **draft**, written 2026-11-01. Before the first measured cell this file
gets the build SHA and a timestamped "final" line. Nothing below changes after
that except by a logged amendment.

## Question

gnomon routes each role to its own model. Every earlier benchmark used one model
for every role. Do mixed setups beat a single model on **tasks solved**,
**cost**, **tokens**, **time**, or **how much of the work leaves the machine**?
Which setups are on the Pareto frontier of these?

## Arms: the model setup is the only variable

Same build for every arm: master after the proportionate-verification change
(#80), if it passes stage 2. Otherwise v0.3.3's master; whichever applies is
recorded. The same surface is used everywhere apart from one profile file per
arm (`profiles/*.toml`), whose surface hash is recorded per cell.

- local = qwen3.6-35b, llama-server on the gx10 (:18080, one slot);
- cloud = DeepSeek V4.1 Flash through OpenCode Go.

| Arm | coordinator (plans, delegates) | implementor | verifier | smol (summaries) | Entry |
|---|---|---|---|---|---|
| **L** all local | — | local | — | local | `task --role implementor` |
| **C** all cloud | — | cloud | — | cloud | `task --role implementor` |
| **PC** plan in the cloud, build locally | cloud | local | local | local | `task --role coordinator` |
| **BC** build in the cloud, plan and check locally | local | cloud | local | local | `task --role coordinator` |
| **EF** efficiency mix: cloud does the work, local does the bookkeeping | — | cloud | — | local | `task --role implementor` |

- L and C are the baselines. P1 and P1-H measured them on other builds, so they are re-run here on the same build.
- EF tests whether moving summaries and compaction to the local model cuts cloud tokens at no cost in tasks solved.
- PC and BC use gnomon's own delegation, the `task` tool from coordinator to implementor and verifier, which the scaffold already allows.

## Tasks, attempts, order

P1-H's 16 tasks (`sample16-hunch.txt`) × **2 attempts**. Per-attempt order uses
seed = attempt, with arms rotating per task. 900 s cap, as P1/P1-H. The cloud
arms run up to 4 at a time. Any cell that calls the local model takes the single
local slot, one cell at a time (P1's GPU lock). The run starts only after P1 and
LEAN stage 2 have released the GPU.

## Metering

Every request is metered at its own relay:
- cloud through `relay-go.mjs`, which reports Go allowance;
- local through P1's `relay-meter` on :18099.

Each request is attributed to the cell and to local or cloud. A cell is valid
when tb returns a verdict, at least one request was metered, and no counter went
backwards. Buckets are reported per arm and asserted to sum to n.

## Endpoints, all reported for every arm

1. **Tasks solved:** pass rate with a Wilson interval; paired exact McNemar against L and against C.
2. **Cost:** \$ per solved task (Go allowance); local GPU-seconds per solved task.
3. **Tokens:** total and output tokens per solved task, split local vs cloud.
4. **Share of work leaving the machine:** cloud tokens / all tokens, and the share of requests that went to the cloud.
5. **Time:** median wall time per task; cells lost at the time cap.
6. **Requests** per task, and delegation depth (sub-turns) for PC and BC.

The result is a table of every arm on every endpoint, plus the Pareto set over
(tasks solved, \$ per solved, cloud share, wall time). **No single "winner" is
declared.** Each mixed arm's claim is the endpoint it improves without losing
tasks solved beyond noise.

## What this can and cannot show

- With 32 pairs per comparison and a noise flip rate near 15%, only large pass-rate differences are detectable. That is stated in the result, not discovered after.
- Mechanism endpoints (tokens, cloud share, cost) are paired per task and have far more power. These are the primary claims.
- One local and one cloud model. A different pairing is a different experiment.

## Out of scope, measured next

- "Escalate on failure" (local first, cloud when the task's own check fails) does not exist yet. It is built, then measured against R1's arms.
- Skill and tool-usage changes are one-variable A/Bs of their own (the skill-trial design, PR #83).

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
seed = attempt, with arms rotating per task. 900 s cap, as P1/P1-H.

Two slots:
- every arm that touches the local model (L, PC, BC, EF) runs in the single GPU slot, one cell at a time, holding P1's gpu.lock;
- the all-cloud arm C runs in one cloud slot alongside it. (This replaces the draft's "up to 4 cloud cells at a time": one cloud slot keeps the extra load on the machine small while P2G also runs.)

The run starts only after P1, LEAN stage 2 and P1's four disturbed re-runs have released the GPU.

## Metering

Every request is metered at its own relay:
- cloud through `relay-go.mjs`, which reports Go allowance;
- local through P1's `relay-meter` on :18099.

Each request is attributed to the cell and to local or cloud. A cell is valid
when tb returns a verdict, at least one request was metered, and no counter went
backwards. Buckets are reported per arm and asserted to sum to n.

## Endpoints, all reported for every arm

1. **Tasks solved:** pass rate with a Wilson interval; paired exact McNemar against L and against C.
2. **Cost:** $ per solved task (Go allowance); local GPU-seconds per solved task.
3. **Tokens:** total and output tokens per solved task, split local vs cloud.
4. **Share of work leaving the machine:** cloud tokens / all tokens, and the share of requests that went to the cloud.
5. **Time:** median wall time per task; cells lost at the time cap.
6. **Requests** per task, and delegation depth (sub-turns) for PC and BC.

The result is a table of every arm on every endpoint, plus the Pareto set over
(tasks solved, $ per solved, cloud share, wall time). **No single "winner" is
declared.** Each mixed arm's claim is the endpoint it improves without losing
tasks solved beyond noise.

## What this can and cannot show

- With 32 pairs per comparison and a noise flip rate near 15%, only large pass-rate differences are detectable. That is stated in the result, not discovered after.
- Mechanism endpoints (tokens, cloud share, cost) are paired per task and have far more power. These are the primary claims.
- One local and one cloud model. A different pairing is a different experiment.

## Out of scope, measured next

- "Escalate on failure" (local first, cloud when the task's own check fails) does not exist yet. It is built, then measured against R1's arms.
- Skill and tool-usage changes are one-variable A/Bs of their own (the skill-trial design, PR #83).


## Apparatus (added 2026-11-02, before any measured cell)

All files are in `apparatus/`.

**Runner and setup**
- `run_r1.py`: modes `smoke-cloud`, `smoke` and `full`. It refuses to start without `R1_SHA`, the full commit, which it checks on GitHub.
- `gnomon-setup-r1.sh.j2`: LEAN/P1's setup, with only the run helper changed. It runs `gnomon init`, then:
  - appends two endpoints, `r1local` and `r1cloud`, both kind openai and keyless (the relays carry the key);
  - strips the model and endpoint lines from roles.toml;
  - writes `profiles/r1.toml` from the arm's routes, covering all seven roles;
  - sets `role_profile = "r1"`;
  - runs `gnomon task … --role <entry> --yes --trust`.
- `--trust` is needed because since #72 a looser-than-scaffold surface runs clamped, and the benchmark surface turns approval off.
- The entry role is coordinator for PC and BC. The scaffold's coordinator has `task` with `task_allow = ["implementor", "verifier"]`.
- Verified on master 891b559b against a fresh scaffold:
  - each role's banner model matches its arm's route;
  - the surface loads with no ✗.

**Meters**
- **GPU slot:** local traffic goes through `relay-meter-r1.mjs` on 172.17.0.1:18080, with counters on :18099. This is P1's meter plus `chat_requests` and `gpu_ms`, the sum of llama-server's `timings.prompt_ms + predicted_ms`, which is the local GPU-seconds measure. Cloud traffic goes through `relay-go.mjs` (P1-H's, with the upstream guard) on :4910, counters :4920.
- **Cloud slot:** relay-go on :4911, counters :4921. Its local endpoint is a TRAP meter on 172.17.0.1:18081 (counters :18098) whose upstream is closed. A cloud-slot cell that calls the local model is counted there and never reaches the GPU.

**Routing assertions** (`collect_r1.py`, per cell, from the meters' `chat_requests`)

| arm | must hold |
|---|---|
| L | cloud == 0 and local > 0 |
| C | local == 0 and cloud > 0 |
| EF | cloud > 0 |
| PC | cloud > 0, and local > 0 if it delegated |
| BC | local > 0, and cloud > 0 if it delegated to implementor |

- Delegations are read from the trace lines `task <role> — N tool call(s)`.
- A contradicting cell is `misrouted`: apparatus, reported, never scored.
- The surface hash prefix per cell comes from the `[result]` line.

**Negative control**
- Arm `NEG` routes everything to the cloud but is asserted as L.
- It must come out `misrouted` in every smoke. If it doesn't, the routing assertion detects nothing and R1 does not start.

**Build under test.** Decided by LEAN stage 2's pre-registered rule:
- **pass** (lean solves ≥ base − 2): wait up to 2 h for PR #80 to be merged, then pin origin/master;
- **fail:** pin origin/master as it is.

Recorded in `BUILD.txt`, and in the final section below.

**Budget.** R1's own Go spend is capped at $12. Above it, no new cell starts and the run pauses (`BUDGET-PAUSE.txt`). The expected spend is about $3–5:
- each cloud-implementing cell costs about $0.03 (LEAN stage 1);
- C, EF and BC are 32 cells each;
- PC is planning only.

**Ids.** Cells are `r1-k<k>-<arm lowercase>-<task>`: tb names the docker compose project after the run id, and compose refuses upper case.

**Chain** (`r1-chain.sh`, started detached), in this order:
1. Wait for stage 2's DONE, then decide the build.
2. Wait for P1's disturbed re-runs.
3. Run the smoke at the pinned build. If it fails, R1 does not start.
4. Mark this file final and commit it.
5. Launch `full`, then collect.

**Development smoke** (2026-11-02, master 891b559b, cloud slot only, no GPU), in `runs-dev/`:
- The first attempt built nothing: the upper-case cell ids were refused by compose. Fixed by lower-casing the ids.
- The second attempt:
  - `r1-sc-c-hello-world` was valid: local 0, cloud 4 chat requests, $0.0016, resolved.
  - `r1-sc-neg-hello-world` was flagged `misrouted`: local 0 and cloud 5 while asserted L, $0.0039.
- This proves the cloud slot, both meters and the negative control.
- The GPU-slot arms are smoked by the chain at the pinned build, before anything is measured.

## Final, before any measured cell (2026-11-02T10:06:58Z)

Build under test: `d59e6c198f91d1469198b0677c008323f82d0345` (origin/master at decision time; contains #80: yes).
Stage 2 verdict that decided it: base=10 lean=10 solved, rule lean >= base - 2 → **pass**.
Smoke at this build, every arm + NEG on hello-world (`smoke-summary.txt`):

```
cell                               state        local_chat cloud_chat  usd     gpu_s  deleg               surface
r1-s-bc-hello-world                valid                 2          0 0.0000     6.3  -                   52fb50d47b6f
r1-s-c-hello-world                 valid                 0          4 0.0008     0.0  -                   15b66f2364ff
r1-s-ef-hello-world                valid                 0          4 0.0007     0.0  -                   6a3b8e528c42
r1-s-l-hello-world                 valid                 3          0 0.0000     4.1  -                   8b69bb363bdd
r1-s-neg-hello-world               misrouted             0          4 0.0007     0.0  -                   533d88a83dae
r1-s-pc-hello-world                valid                 7         10 0.0033    11.2  implementor,verifier  014270bbbbd4
smoke: PASS (arms seen: ['BC', 'C', 'EF', 'L', 'NEG', 'PC'])
```

From here on, changes to this file are timestamped amendments.

## Amendment, 2026-11-02T17:49Z: arms narrowed to L, C, PC for the rest of the run

The user asked for the most conclusive local/cloud/hybrid comparison before shutting both machines down in 2–3 hours.
- **What changes:** BC and EF are dropped from all remaining cells. Their finished cells stay in `runs/`, and the collector reports them as partial arms.
  - BC: local coordinator, cloud implementor. Interim 3/10. It delegated in only 5 of 10 cells.
  - EF: cloud with local smol. Interim 9/10. Its local smol was reached in 0 of 10 cells, so EF has not exercised its mechanism and is effectively a second C.
- **Why:** the single GPU slot now cycles L and PC only, about doubling the rate of L/PC pairs. Nothing else changes: build `d59e6c19`, tasks, seeds, cap, meters and the validity rule.
- **Mechanics:** the runner was stopped at 17:5xZ. The in-flight cell `r1-k1-l-tune-mjcf` (started 17:28Z, no verdict) moved to `runs-aborted/` and re-runs from scratch. The runner restarts with `R1_ARMS=L,C,PC` and skips finished cells.
- **Arm order changes:** rotation over three arms orders cells differently from rotation over five, so the remaining cells run in a different order than pre-registered. Attempt barriers and seeds are unchanged.

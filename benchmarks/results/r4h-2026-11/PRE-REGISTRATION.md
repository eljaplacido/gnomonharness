# R4H: is R3R's hybrid regression caused by the build? Pre-registration

**Status:** written 2026-11-04 (evening UTC), before any R4H cell, and committed with its apparatus. Nothing has run on
the lane. The chain writes every gate result into `STATUS.txt` and commits it, with the smoke and lane files, **before the
first measured cell**. It never edits this file. Any later change goes in a timestamped addendum at the end.

## Why

R3R (`../r3r-2026-11/`) re-ran R1H's design (`../r1h-2026-11/`) on gnomon v0.4.0 (be4fc0d8). It used the same RTX 5090
lane (Qwen3.6-35B-A3B, llama.cpp, R1H's bud-lane, 2 slots), the same 16 tasks × 2 attempts, and the arms L, C and PC.

| | R1H (d59e6c19) | R3R (v0.4.0) |
|---|---|---|
| L solved | 24/32 | 22/29 |
| C solved | 27/32 | 24/31 |
| **PC solved** | **26/30** | **19/31** |
| PC capped | 8 | 12 |
| PC cloud output per solved | 27.5k | 45.7k |
| PC median wall | 322 s | 391 s |

- **PC fell; L and C did not.** On matching (task, attempt) pairs, PC solved 25 (R1H) vs 18 (R3R). R1H-only 8, R3R-only 1, exact McNemar p = 0.039.
- **Host load does not explain it.** R3R's PC solved 10/16 at low load and 9/15 at high load.
- **The same build did not drop elsewhere.** On the GB10 lane, v0.4.0's hybrid held: M2 q36g PC 22/32.
- **But this is not yet attribution.** R1H and R3R are time-separated runs, so "the build did it" is not established. R4H runs both builds side by side.

### What changed on the PC path, d59e6c19 → v0.4.0

From a read-only review of `git diff d59e6c19..be4fc0d8` (101 commits). "On" means on in PC's surface by default.

**(A) Transport**
- **#107, streaming.** On. Adds `stream = true` with `include_usage`, an idle clock (300 s) and a total clock (30 min). Only the wait for the first byte is charged to the retry budget.
- **#98/#103 and #122, no header cut.** On. Model calls use an undici dispatcher with `headersTimeout`/`bodyTimeout` 0, so under `gnomon task` the old 300 s cut is gone. This applies to the cloud planner and to the local implementor alike.
- **#110, output limit.** On. Sends `max_tokens = 32768`. Handles a reply that is cut off (re-asks one cut off while still thinking; ends the turn `truncated` after repeated cut-offs).
- **374e6c86 (#111 review), reasoning no longer copied.** On. Reasoning is no longer copied into `content` when a reply has `content: null` beside tool calls; d59e6c19 did copy it and echoed it on later steps. It matters only if the relay returns `null`.
- **Off in PC:** #111 `replay_reasoning` (not api.deepseek.com) and #100 sticky fallback (no fallback declared).

**(B) Delegation**
- **#101, delegate-once `task` description.** On. It now tells the coordinator to delegate a job once, with the complete plan and its check. It reaches only PC.
- **#99, llama.cpp context overflow.** On. An overflow now trims and continues instead of ending the sub-turn, so implementor sub-turns can run longer.

**(C) Steering**
- #120 `steer_role`: off (release default).

**(D) Guards**
- #117/#119/#124 record guard (a change gnomon did not make stops the turn as `tamper`): on.
- #112/#115 `record` rule (refuses writes to `.gnomon-audit/`, `.gnomon-trials/`): on.

**(E) Other**
- #94 (the first `git status` refreshes a stale index): on.
- #116 (`GNOMON_AGENT_SESSION` env var in tool subprocesses): on, harmless.

**v0.4.0 → v0.4.1 (NEW is v0.4.1)**
- **Init:** differs by comment lines only (`wiretest-r4h.txt`, part A). The release states its default requests are byte-identical to v0.4.0's.
- **Changes that are on and can alter control flow:**
  - #136 guard tightening: under `network = false`, `git clone https://…`, `pip -i` and `npm --registry` are refused; so are shell writes into `.gnomon/`.
  - #138: schema text is appended to a failed tool call.
  - #134: a non-JSON 200 reply is retried.
- **Record-only:** #140, #142, #143, #144 (per-call records).

So NEW = v0.4.0 + those. R4H tests the whole build difference. It cannot say which change is responsible.

### The leading hypothesis, and what the committed data say about it (cheaper first step, done 2026-11-04)

**The hypothesis.** On d59e6c19 a planner call that ran past 300 s was cut and asked again. On v0.4.0 it runs to the end, so PC cells run longer and hit the cap more often.

**Two checks were run before any spend. Both are free and offline.**

**1. Pre-trace on R1H's and R3R's committed PC cells (`apparatus/pretrace_r4h.py` → `pretrace-r4h.txt`, read-only).**

Planner per-call wall times were rebuilt from gnomon's audit timestamps. Those audit records exist only for cells whose gnomon exited (a capped cell has none).

| | R1H (d59e6c19) | R3R (v0.4.0) |
|---|---|---|
| Valid cells with a timeline | 22 of 30 | 19 of 31 |
| Planner calls rebuilt | 306 | 286 |
| Wall per call: median / p90 / p99 / max | 5.2 / 30.1 / 85.6 / 175.2 s | 7.9 / 29.3 / 97.3 / 112.6 s |
| Calls > 120 s | 2 | 0 |
| **Calls > 300 s** | **0** | **0** |
| Metered cloud requests = rebuilt calls | 18 of 22 cells (4 cells +1) | all 19 cells |
| Capped cells (of which solved) | 8 (6) | 12 (4) |
| Capped cells' share of the arm's cloud output | 54% | 71% |
| Delegations per valid cell: mean / median | 3.9 / 3 | 2.7 / 2 |
| Delegations to implementor / to verifier | 110 / 7 | 73 / 12 |
| Cloud output per request: median / mean | 1,352 / 1,737 | 1,306 / 1,794 |

- **The cut never acted in a completed cell.** No completed cell in either run had a planner call that reached 300 s, so the cut could not have fired there in R1H, and lifting it changed nothing there in R3R.
- **The regression sits in capped cells.** Of the 8 pairs R1H solved and R3R did not, R3R's cell was capped in 6. The other 2 had planner calls of at most 97 s.
- **Capped cells carry no timeline.** In 10 of R3R's 12 capped PC cells, no cloud request was still in flight when tb returned. That is weak evidence, because tb returns well after the cap.
- **What can still act.** The transport change can matter only inside capped cells, which have no timeline. The delegation pattern changed measurably: fewer delegations per cell and more verifier calls. That is consistent with #101's delegate-once wording.

**2. The 300 s mechanism on the real code (`wiretest-r4h.txt` part C → `wiretest-r4h-slow.txt`).**

A fake cloud held the coordinator's first reply for 330 s, and both builds ran it.
- **OLD:** gave up after 299.9 s, logged `[retry] timed out (deadline now 599996ms) — attempt 1 of 3`, and asked again.
- **NEW (streamed):** waited the full 330 s.

So the mechanism exists. But in OLD a call that stays slow is cut, re-asked with a 600 s deadline, and finally given up after the transport grace ("grace spent", per the review above). R1H's validity rule scores such a cell `endpoint_outage`, which is apparatus, not a failure. **R4H therefore reports `endpoint_outage` per build as a mechanism endpoint, plus a sensitivity analysis (below).**

**What follows from the pre-trace.**
- The transport hypothesis is not supported where data exist, and not ruled out where they do not (capped cells).
- R4H adds a per-cell meter timeline that times every planner call in every cell, capped ones included.
- The decision rule's bisect step keeps the transport emulation first, as asked, and adds the delegate-once wording as a second candidate.

## Design

**Arm.** R1H's PC only:
- coordinator and plan → cloud;
- implementor, verifier, implement, critique and smol → local;
- entry role coordinator, `--yes --trust`, R1H's r1 profile (byte-identical: `wiretest-r4h.txt`).

**Lane, tasks, cap.** R1H's and R3R's, unchanged:
- llama.cpp b11739 in `C:\dev\bud-lane` on the hub RTX 5090, `Qwen3.6-35B-A3B-UD-Q4_K_S` + DFlash draft;
- `--parallel 2`, 2 × 98,304 context;
- props and slots must match R1H's (fatal otherwise); R1H's start/stop scripts and weights checked against their pins;
- the 16 tasks of `sample16-hunch.txt` (byte-identical);
- the 900 s cap through tb 0.2.18.

**Builds (the only variable):**
- **OLD = `d59e6c198f91d1469198b0677c008323f82d0345`** (R1H's). It runs with R1H's agent class `peer_agents_r1:GnomonR1` and setup `gnomon-setup-r1.sh.j2`, byte-identical copies. Its surface is byte-identical to the one R1H's PC cells ran (endpoint ports aside).
- **NEW = `c511b8105fb2187423d21becbe3b19f8af2b80e5`** (tag v0.4.1, the current release). It runs with R3R's `peer_agents_r3r:GnomonR3R` and `gnomon-setup-r3r.sh.j2`, byte-identical copies. That setup asserts the release's init (stream = true, max_tokens = 32768, no steer_role or replay_reasoning, no fallback), and v0.4.1's init passes it.
- **Its surface** equals R3R's except for the comment lines v0.4.1's init adds.
- **The R3R setup refuses OLD's init** (negative control), so a build cannot run under the other's agent class.
- **Every cell fetches its commit by SHA and records it.** A cell that ran anything else is `wrong_commit`.

**Pairing and interleaving.**
- **Pairs.** 16 tasks × 2 attempts × 2 builds = **64 cells in 32 pairs**, paired by (task, attempt). Within an attempt, tasks are in R1H's order (shuffle with seed = attempt).
- **Each pair runs together.** The OLD and NEW cells start together, one on each lane slot, and the next pair starts only when both have ended.
  - A pair therefore shares its time, its lane load and its co-runner: each cell's co-runner is the other build's cell.
  - Which build takes which slot alternates (OLD on each slot in 16 pairs). Attempts are barriers.
- **Absolute rates are not comparable to R1H/R3R.** There the co-runner was a mix of L and PC cells, and a cloud C slot ran beside them. Only the within-R4H contrast is read.
- **After a yield.** A pair that has one cell finished and the other aborted re-runs only the unfinished cell, alone. The collector reports every pair's start skew, and pairs started more than 60 s apart.

**Meter timeline (new, apparatus only).**
- Per cell, the runner polls both meters' counters every 1 s, from just before tb starts until the cloud tail settle ends, and keeps a sample whenever a counter changed (`timeline.json`).
- From it, the collector times every planner call: arrival to end, matched first-in first-out, which is exact for PC's one-at-a-time coordinator. It also records each call's output tokens, calls still open when the cell ended, and overlapping calls (the signature of a call given up and asked again).
- It is read-only on the meters (GET `/counters`). No request path changes: relay-meter-s1 and relay-go are byte-identical.

**Smoke.**
- OLD and NEW PC on hello-world, as a pair, plus R3R's NEG control on the cloud slot (NEW, routed all-cloud, asserted as L).
- Gate (`collect_r4h.py --smoke`, tested on R1H's and R3R's real smoke cells):
  - both PC cells are valid and solved, each on its own commit;
  - OLD's surface and wire are R1H's (no stream, no max_tokens; local meter stream 0 / max_tokens 0);
  - NEW's surface and wire are the release's;
  - every cloud response carries usage;
  - every cell has a clean timeline whose call count equals the meter's;
  - NEG reads misrouted.
- One retry is allowed. A second failure means R4H is not run.

**Validity: R1H's rule, unchanged** (`collect_m1.parse_cell`, the byte-identical pinned copy).
- **Valid:** tb returned a verdict, both meters read non-negative deltas, at least one chat request was metered, the cell ran its build's commit, gnomon did not give up on an endpoint, and PC's routing holds (cloud > 0, and local > 0 if it delegated).
- **Anything else is apparatus:** reported, never scored. Buckets are asserted to sum to n per build.

**Ports, tunnel and locks (R4H's own; asserted in tests and the preflight).**
- **Tunnel:** gx10 `127.0.0.1:19180` → hub `127.0.0.1:18380`.
- **Meters:** `172.17.0.1:5810–5815`, counters `127.0.0.1:5820–5825`.
- **None collides with another chain:**
  - M2's RTX chain: 18980 and 5710–5725;
  - R3R: 18880 and 5510–5525;
  - P2G/P2G41: 4710–4729 and 4810–4812;
  - the others in the preflight's list.
- **Own state:** `STATUS.txt`, `YIELD-NOW`, `.chain.lock` and `spend.jsonl` are R4H's own.
- **Refusal:** the chain refuses to start, and checks again before every lane start, while any of these locks is held (read from `/proc/locks`, never taken): M2's RTX chain (`m2-2026-11/.chain-rtx.lock`), R3R's (`r3r-2026-11/.chain.lock`) or S1's (`s1-2026-11/.chain.lock`).

## Scheduling: runs when the hub is idle; yields to games

R3R's settings as of its 2026-11-04 addendum, unchanged. `s1-hubwatch.sh` is a byte-identical copy, and `test_hubwatch_s1.sh` is pinned at sha256 `9c31e271…`, as R3R's preflight pins it.

- **Idle start.** 15 consecutive samples, 60 s apart, all idle: GPU memory < `IDLE_MEM_MAX` = **6500** MiB (default set in the chain), utilization < 15%, no `llama-server.exe`, WSL `m1-vllm` not running. Then a full hub check.
- **Yield.** GPU memory over the lane's warm level + **1,500 MiB** for 2 consecutive samples (30 s apart), our server gone, or another llama-server or m1-vllm appears. Then:
  1. `YIELD-NOW` is written first;
  2. every cell in flight is aborted and re-run from scratch on resume (finished cells are kept);
  3. the lane is stopped (R1H's STOP-ME, our pid only);
  4. the chain goes back to the idle wait.
- **New-cell deadline.** `R4_DEADLINE` is required; there is no default. No pair starts after it, and unstarted pairs are never imputed.
- **Commits.** Under `../m1-2026-11/.commit.lock`, R4H's paths only.

## Endpoints (`apparatus/collect_r4h.py`), declared now

**PRIMARY: solved.** On (task, attempt) pairs valid in both builds: the solved counts, and an **exact two-sided McNemar** on the discordant pairs.

**MECHANISM (stated in advance, descriptive, per build):**
1. **Capped cells**, overall and on the pairs (plus how many capped cells were solved).
2. **Cloud planner output tokens**, per call (median and mean, from the timeline) and per solved (from the meter).
3. **The planner's per-call wall time** (timeline):
   - median, p90 and max;
   - **calls over 300 s, and the cells holding them**;
   - calls still open when the cell ended;
   - cells with overlapping cloud calls.
4. **Delegations per cell** (mean and median; to implementor and to verifier), from the collector's `task <role> — N tool call(s)` lines.
5. Also: how turns end (`stop_reason`), the agent wall median, $/solved, **`endpoint_outage` cells per build**, and pair start skew.

**Sensitivity, declared now.** The same McNemar with OLD's `endpoint_outage` cells counted as unsolved pairs. On OLD, a planner call that stays over 300 s ends that way, and R1H's rule calls it apparatus. This shows whether the primary depends on excluding them.

## Decision

- **(a) NEW solves fewer than OLD with p < 0.05** (two-sided exact McNemar):
  - **Reading:** the regression is real and caused by the build.
  - **Next:** bisect. Arm 1 is NEW with OLD's planner transport emulated, if the surface allows it. Per the review it does, approximately:
    - `[endpoints.r1cloud] stream = false` and `max_tokens = 0` (send none);
    - keep `[resilience] request_timeout_ms = 300000` and `attempts = 3`;
    - NEW then cuts at 300 s and asks again once with a 600 s deadline.
  - **Residual differences from OLD in that arm:** OLD made three 300 s attempts, its retry codes differ, and the guards and #99 still apply. `stream_total_timeout_ms = 300000` is not used: it is never retried, so it would end the whole task.
  - **Second bisect candidate, from the pre-trace:** NEW with R1H's `task` description restored in `tools.toml` (config-only).
  - **Which arm runs first** is decided from R4H's mechanism endpoints, in a new pre-registration:
    - if NEW's planner calls over 300 s explain the extra capped cells, the transport arm;
    - if not, the wording arm.
- **(b) Not shown (anything else):**
  - **Reading:** "no build effect on solved shown at n = 32 pairs". That is not "no effect"; see the MDE.
  - **Next:** look at R3R's run conditions: its time, its co-runners and the lane. Mechanism endpoints are reported either way.
- **No composite verdict.** A non-significant difference is "not shown". NEW solving more than OLD is reported, but it is not (a).

## MDE (honest, n = 32 pairs)

`collect_r4h.py --mde`: exact enumeration, two-sided α = 0.05.

**Smallest discordant split that rejects:** 6:0, 7:0, 8:0, 8:1, 9:1, 10:1, 10:2, 11:2, 12:2, 12:3, 13:3.

**Power to show NEW < OLD:**

| reverse flips (NEW-only rate) | 15 pts | 20 pts | 25 pts | 30 pts |
|---|---|---|---|---|
| 0 | 0.35 | 0.64 | 0.85 | 0.95 |
| 0.03 | 0.29 | 0.50 | 0.69 | 0.82 |
| 0.06 | 0.25 | 0.41 | 0.58 | 0.72 |

- **The observed effect itself:** R3R vs R1H's split (8 OLD-only and 1 NEW-only of 29 pairs) gives **power 0.64**.
- **Run-to-run noise:** L's R3R-vs-R1H discordance was 4 of 29 pairs, so a reverse-flip rate near 0.05 is realistic.
- **What R4H can and cannot detect:** it detects a regression the size R3R suggested about 2 times in 3. It cannot detect one of 15 points or less. A (b) is therefore weak evidence of no effect.

## Budget

- **Cap: $5.00 of OpenCode Go allowance**, R4H's own ledger (`spend.jsonl`; smoke, aborted cells and tails included). Above it, no new pair starts (`BUDGET-PAUSE.txt`).
- **Expected about $2.0–2.5.**
  - R1H's PC spent about $0.030 per cell ($0.89 over 30 valid).
  - R3R's PC spent about $0.034 per cell ($1.12 over 33 ledger entries).
  - 64 cells come to about $2.0–2.2, plus about $0.05 for the smoke and the aborted-cell floors.
- **No other paid calls.** Local inference is on the hub lane.

## Expected wall time

- **Cells:** the sum, over the 32 pairs, of the longer of R1H's and R3R's PC cell walls is **5.6 h**. A pair waits for its slower cell.
- **Overhead:** about 40 min for the idle wait, lane start, warm-up, offline tests and smoke.
- **Total:** about **6.3 h without yields**. Each yield costs the cells in flight plus at least 15 min of idle wait.
- **Deadline:** set `R4_DEADLINE` at least about 7 h after an expected idle start, or attempt 2 is cut. Only pairs where both cells ran are read.

## Cheaper first step

- **Already done:** the pre-trace and the mechanism wire test ($0; results above). They weaken the leading hypothesis without settling it.
- **If the RTX window is short (under about 3 h), a cheaper step 0:** NEW-only on the 6 tasks whose R3R PC cell was capped and lost a pair, with the timeline (about 12 cells, about $0.4, about 2–3 h).
  - It answers where a capped NEW cell spends its time: in planner calls over 300 s, or in local sub-turns.
  - It does not test whether the build is the cause; only the paired run does.
  - It is not run by this chain. It would need its own pre-registration.

## Cleanup and scope

- **What the chain starts and stops:** only R1H's lane (via R1H's scripts, under the pid rule and R3R's guard: no lane of its own, no STOP-ME), its own tunnel (by process group), its own runner and relays, and the compose projects of its own cells (by exact label).
- **What it writes:** nothing outside `r4h-2026-11/`. R1H's, R3R's and S1's files are read only. The other chains' locks are read from `/proc/locks`. M1's commit lock is opened for append.

## Files

- **Chain, runner, collector:**
  - `apparatus/r4h-chain.sh` (`DRY=1` is read-only, but it samples the hub over ssh);
  - `apparatus/run_r4h.py` (`plan`, `smoke`, `full`, `abort-inflight`);
  - `apparatus/collect_r4h.py` (`--smoke`, `--mde`, `--no-write`).
- **Other apparatus:** `apparatus/preflight_r4h.sh`, `apparatus/tunnel-r4h.sh`, `apparatus/pretrace_r4h.py`, `apparatus/wiretest_r4h.mjs`, `apparatus/mktree_r4h.sh` (offline git-archive trees for the wire test, each with its own launcher bundle cache).
- **Tests:** `test_run_r4h.py`, `test_chain_glue_r4h.sh`, `test_collect_r4h.py`; S1's `test_hubwatch_s1.sh` and `test_relay_s1.mjs`; R3R's `test_relay_go_r3r.mjs`.
- **Byte-identical copies:**
  - from R1H: `peer_agents_r1.py`, `gnomon_agent.py`, `gnomon-setup-r1.sh.j2`, `relay-go.mjs`, `sample16-hunch.txt`;
  - from R3R: `peer_agents_r3r.py`, `gnomon-setup-r3r.sh.j2`, `test_relay_go_r3r.mjs`, `collect_m1.py`, `test_hubwatch_s1.sh`;
  - from S1: `relay-meter-s1.mjs`, `test_relay_s1.mjs`, `s1-hubwatch.sh`.
- **Evidence before data:** `pretrace-r4h.txt`, `wiretest-r4h.txt`, `wiretest-r4h-slow.txt`, `offline-r4h.txt` (every offline test and the hub-free preflight: all pass).

## Launch (for the coordinator; not launched)

First the read-only check. It ssh-samples the hub, so run it only when the hub may be touched:

`cd ~/gnomon-wt/peers/benchmarks/results/r4h-2026-11/apparatus && DRY=1 R4_DEADLINE=<deadline> ./r4h-chain.sh`

Then the launch, one line:

`cd ~/gnomon-wt/peers/benchmarks/results/r4h-2026-11/apparatus && setsid nohup env R4_DEADLINE=<YYYY-MM-DDTHH:MM:SSZ> ./r4h-chain.sh >> ../chain-r4h.log 2>&1 < /dev/null &`

It refuses while M2's RTX chain, R3R's or S1's holds its lock. At writing, M2's RTX chain held `m2-2026-11/.chain-rtx.lock`.

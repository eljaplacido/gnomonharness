# LG1: do PR #153's v0.4.3 defaults regress gnomon on the local Qwen3.6 lane? Pre-registration

**Status:** written 2026-11-05 (about 17:35 UTC), before any LG1 cell, and committed with its apparatus. Nothing has
run on the lane. The chain writes every gate result into `STATUS.txt` and commits it, with the smoke and lane files,
**before the first measured cell**. It never edits this file. Any later change goes in a timestamped addendum at the end.

## Question

PR #153 (`feat/v043-long-tasks`, open, held for benchmarks) changes two defaults:

1. **Reasoning replay on by default.** An OpenAI-shaped endpoint that declares no `replay_reasoning` and answers a tool
   call with a reasoning field (`reasoning_content` or `reasoning`) gets it back on every assistant message from the next
   request on.
2. **`[turn] nudge_after_idle` defaults to 0 (off).** v0.4.2 nudges after 12 calls without a file change.

LG1 is a do-no-harm guard: on the local lane, does the candidate solve no fewer tasks, at no more than 20% more local
tokens and median wall per cell?

## A finding before any data: on this lane the replay default cannot fire

The brief says the local llama.cpp lane returns `reasoning_content` for Qwen3.6. The committed evidence says it does not.

- **The lane's own props** (`../r1h-2026-11/lane-props.json`, re-read by R4H on 2026-11-05 as `../r4h-2026-11/lane-r4h-props.json`):
  `reasoning_format: "none"`, `chat_format: "Content-only"`, `reasoning_in_content: false`. With `reasoning_format`
  none, llama.cpp sends no reasoning field.
- **Every local response metered on this lane carried none.** relay-meter-s1 counts a response with a reasoning field
  (`responses_with_reasoning`). Across all committed cells:

  | study (lane) | cells | local chat requests | responses with reasoning | requests replaying reasoning |
  |---|---|---|---|---|
  | R3R (R1H's lane) | 96 | 4,024 | **0** | 0 |
  | R4H (R1H's lane, v0.4.1 and d59e6c19) | 52 | 3,713 | **0** | 0 |
  | S1 (R1H's lane) | 62 | 2,464 | **0** | 0 |
  | (M2, other lanes, for contrast) | 244 | 12,239 | 3,658 | 3,924 |

- **gnomon's code** learns replay only from a reasoning field: `adaptReplayReasoning` is set when `r.reasoning` is
  non-empty, and `r.reasoning` comes only from `delta.reasoning_content ?? delta.reasoning` (prompt_loop.ts at 59f1e314).
  PR #153 itself says "an endpoint that sends no reasoning is sent none: same bytes as before."
- **The wire test shows both sides** (`wiretest-lg1.txt`): on a lane-shaped fake (content only), NEW replays nothing (B);
  on a reasoning-returning fake, NEW replays from its second request and the meter counts it, while OLD does not (C).

**Consequences, declared now:**
- The mechanism expectation is changed from the brief's "NEW > 0, OLD = 0" to **OLD 0 and NEW 0 requests carrying
  replayed reasoning, with 0 reasoning responses from the lane.** If NEW shows any, the lane returned a reasoning field
  in that cell, and it is reported.
- **LG1 does not test the replay default on a local lane that returns reasoning.** That needs a lane started with
  `--reasoning-format deepseek` (or `auto`), and LG1 may reach the hub only through R1H's existing scripts, unchanged.
  The verdict is about this lane as it is configured.
- **The nudge default does apply here, but it may be close to inert for the model.** v0.4.2's nudge is a mid-turn system
  message, and the Unsloth Qwen3.6 template on this lane skips every system message after the first two (S1's finding,
  `../s1-2026-11`; relay-meter-s1 counts such a nudge as `steer_nudge_dropped`). The meter reports nudged requests per
  build: OLD ≥ 0, NEW 0 expected (wire test D shows OLD nudging after 12 idle calls and NEW not).
- So on this lane LG1 measures **the whole candidate as its defaults apply here**: the nudge default and everything else
  between v0.4.2 and the PR head that is on by default.

## What else differs between the builds (all of it is under test)

`git log 2498d16d..59f1e314` (7 commits): #151 (`endpoint_error` stop reason, per-call figures on partial records),
#152 (completion gate, **opt-in, off**), and PR #153:
- the two defaults above;
- `--deadline` (opt-in, not used here);
- **`[resilience] task_transport_grace_ms`, 180 s when undeclared, for an unattended `gnomon task`** (on: it can change
  how long a cell keeps retrying a failing endpoint);
- truncation re-asked once per streak (on);
- tool timing in records (record-only);
- read-only workdir fallback (inert here: task dirs are writable).

`gnomon init` differs in one setting only: `nudge_after_idle = 12` → `0` (wiretest-lg1.txt, A). Neither build's init
names `replay_reasoning` or `steer_role`.

## Design

**Lane.** R1H's bud-lane on the hub RTX 5090, the one R3R and R4H use, unchanged:
- llama.cpp b11739, `Qwen3.6-35B-A3B-UD-Q4_K_S` + DFlash draft, `--parallel 2`, 2 × 98,304 context;
- started and stopped only through R1H's `start-server-r1h-np2.ps1` and `STOP-ME.ps1` in `C:\dev\bud-lane`, pinned by
  R4H's hashes; weights checked against R1H's checksums;
- props and slots must match R1H's (fatal otherwise).

**Apparatus.** R4H's (`../r4h-2026-11/apparatus`), copied and changed only where LG1 needs it: builds installed by SHA
in every cell, a per-cell meter timeline, pairs run together, the gaming-safe yield.

**Arm: L only (R3R's L configuration).** Entry role implementor, every role routed to the local lane, `--yes --trust`,
the r1 profile byte-identical to R3R's L cells (wiretest-lg1.txt, A).

**Builds (the only variable):**
- **OLD = `2498d16dc248bc18a203a1a98ba0b942acae5b23`** (tag v0.4.2);
- **NEW = `59f1e3144099ff47c10f1b3e26249f763d764f42`** (PR #153's head, fetched 2026-11-05).
- Both run R3R's agent class `peer_agents_r3r:GnomonR3R` and setup `gnomon-setup-r3r.sh.j2` (byte-identical copies).
  That setup asserts what `gnomon init` wrote: `stream = true`, `max_tokens = 32768`, no `steer_role` or
  `replay_reasoning`, no fallback. Both builds' inits pass it.
- **Release defaults.** R3R's L surface sets no nudge or replay key (it adds endpoints, the r1 profile, `role_profile`,
  `[audit] enabled`, `[approval] gate = "never"`, and strips `model`/`endpoint` from roles.toml). **No key was removed.**
  Each cell runs its build's own init: `nudge_after_idle` 12 on OLD, 0 on NEW; replay at each build's code default.
- **Every cell fetches its commit by SHA and records it.** A cell that ran anything else is `wrong_commit`.

**No cloud: $0 by construction.**
- Each slot's cloud endpoint is a **trap**: relay-meter-s1 whose upstream is `127.0.0.1:9`, where nothing listens
  (asserted before the meters start). A cloud request is counted and answered 502; it can reach nothing.
- No relay-go runs, no credential file is read, and there is no ledger.
- A cell with any cloud request is `misrouted` (R1H's L rule), never scored. The collector reports the total; it must be 0.

**Tasks, cap, pairing.**
- R1H's 16 tasks (`sample16-hunch.txt`, byte-identical) × 2 attempts = **32 (task, attempt) pairs, 64 cells**;
  the 900 s cap through tb 0.2.18.
- Within an attempt, tasks run in R1H's order (shuffle with seed = attempt). Attempts are barriers, so attempt 1 (all
  16 tasks) completes before attempt 2 starts.
- **Each pair runs together.** The OLD and NEW cells start together, one on each lane slot, and the next pair starts only
  when both have ended. Which build takes which slot alternates (OLD on each slot in 16 pairs).
- **After a yield**, a pair with one cell finished re-runs only the unfinished cell, alone; the collector reports pair
  start skew.

**Smoke (gate, before any measured cell).** OLD and NEW L on hello-world as a pair, plus a NEG control (NEW, routed all
to the cloud trap, asserted as L) on a lane-free slot. It passes when:
- both L cells are valid and solved, each on its own commit;
- each L cell's surface is its release default (`stream = true`, `max_tokens = 32768`, `nudge_after_idle` 12 / 0, no
  `replay_reasoning` or `steer_role`), and every local request was streamed with `max_tokens`;
- no L cell sent a cloud request, and OLD replayed no reasoning;
- every cell has a clean meter timeline;
- **NEG's cloud requests were counted on the trap, it never reached the lane, and it was not scored valid** (the
  negative control: a cloud call is detectable).

One retry is allowed. A second failure means LG1 is not run.

**Validity: R1H's rule, unchanged** (`collect_m1.parse_cell`, the byte-identical pinned copy).
- **Valid:** tb returned a verdict, both meters read non-negative deltas, at least one chat request was metered, the cell
  ran its build's commit, gnomon did not give up on an endpoint ("grace spent"), and L's routing holds (cloud 0, local > 0).
- **Anything else is apparatus:** reported, never scored. Buckets are asserted to sum to n per build.

## Endpoints (`apparatus/collect_lg1.py`), declared now

All on (task, attempt) pairs valid in both builds.

**PRIMARY: solved, non-inferiority, margin 10 points.**
- Solved counts, discordant pairs, and an **exact two-sided McNemar** p.
- The paired difference NEW − OLD with the **Agresti–Min 95% CI** (add ½ to each cell of the paired 2×2 table, then
  the Wald interval for the difference of the marginal proportions).
- **non-inferior** if the CI's lower bound is above −10 points;
- **regresses** if NEW solves fewer with McNemar p < 0.05;
- **not shown** otherwise.

**CO-PRIMARY GUARDS: no more than +20%.**
- **Local tokens per cell:** ratio NEW / OLD of the summed local prompt + completion tokens over the pairs (metered).
- **Median wall per cell:** ratio of the median agent wall (tb's `agent_started_at` → `agent_ended_at`), NEW / OLD.
- Each with a **paired bootstrap 95% percentile CI** (10,000 resamples of whole pairs, seed 20261105).
- **holds** if the upper bound is ≤ 1.20;
- **breached** if the lower bound is above 1.00 and the point estimate above 1.20;
- **not shown** otherwise.

**VERDICT.**
- **regresses** if the primary regresses or either guard is breached;
- **non-inferior** if the primary is non-inferior and both guards hold;
- **not shown** otherwise.

**SECONDARY (descriptive).**
- Capped cells (paired, both directions).
- Local calls per cell and local output tokens (paired ratios with the same bootstrap).
- Reasoning returned by the lane (responses and characters; the meter counts characters, not reasoning tokens).
- **Mechanism check:** requests carrying replayed reasoning (expected OLD 0, NEW 0 on this lane, see above); requests
  carrying the idle nudge (expected NEW 0).
- How turns end (`stop_reason`), uncached prompt tokens, client aborts, meter errors, and the total of cloud (trap)
  requests (must be 0).

**Partial runs.** No pair starts after the new-cell deadline (2026-11-05T21:30:00Z), and unstarted pairs are never
imputed. The verdict is computed on the pairs valid in both builds, whatever their number, and that number is reported
with it.

## Power and MDE (honest; `collect_lg1.py --mde`, exact enumeration)

| pairs | discordant rate | true NEW − OLD | P(non-inferior) | P(regresses) |
|---|---|---|---|---|
| 32 | 0.10 | 0 | 0.48 | 0.00 |
| 32 | 0.15 | 0 | 0.35 | 0.00 |
| 32 | 0.20 | 0 | 0.27 | 0.01 |
| 32 | 0.15 | +5 pts | 0.62 | 0.00 |
| 32 | 0.15 | −10 pts | 0.05 | 0.11 |
| 32 | 0.20 | −20 pts | 0.00 | 0.64 |
| 16 | 0.15 | 0 | 0.22 | 0.00 |

- **Smallest results that read non-inferior at 32 pairs** (NEW-only : OLD-only): 0:0, 1:1, 4:2, 6:3, 8:4.
  At 16 pairs, not even 0:0 does (lower bound −10.9 points).
- **Noise:** the within-run self-flip rate measured on this project is about 15%; L's R3R-vs-R1H discordance was 4 of 29
  pairs.
- **What LG1 can and cannot say:**
  - with no true difference, it reads non-inferior about one time in three;
  - it detects a 10-point regression about one time in ten;
  - so **"not shown" is the likeliest verdict, and it is not evidence of harm**;
  - a "regresses" needs a large effect (for solved, at least 6 discordant pairs all one way).
- The token and wall guards are tighter: paired, continuous, and dominated by the large tasks.

## Scheduling (R4H's gaming-safe rule; one declared change)

- **Wait for the other RTX chains.** LG1 starts nothing while R4H's chain holds `r4h-2026-11/.chain.lock`, nor while
  M2's RTX chain, R3R's or S1's holds its lock. Each lock is read from `/proc/locks`, never taken. LG1 polls every 60 s
  and checks again before every lane start. At writing, R4H holds its lock: it yielded to the GPU's owner at 17:07Z and
  17:31Z and is waiting to resume its last 6 pairs (deadline 21:00Z).
- **Idle start.** `IDLE_MEM_MAX` = **6500** MiB, utilization < 15%, no `llama-server.exe`, WSL `m1-vllm` not running.
  **Declared change: 2 consecutive idle samples (60 s apart), not 15, because the operator said the RTX is free today.**
  Then a full hub check (no llama-server, nothing on the hub's 18380, GPU under 6500 MiB).
- **Yield, unchanged.** GPU memory over the lane's warm level + 1,500 MiB for 2 consecutive samples (30 s apart), our
  server gone, or another llama-server or m1-vllm. Then:
  1. `YIELD-NOW` is written first;
  2. every cell in flight is aborted and re-run from scratch on resume (finished cells are kept);
  3. the lane is stopped (R1H's STOP-ME, our pid only);
  4. the chain goes back to waiting.
- **New-cell deadline: 2026-11-05T21:30:00Z** (`LG1_DEADLINE`, required). A cell started before it runs to its 900 s cap.
- **Expected wall time.** The sum over the 32 pairs of the longer of R1H's and R3R's L cell walls is **2.6 h** (attempt
  1 alone: 1.3 h), plus about 10 minutes of lane start, warm-up and smoke. Whether all 32 pairs fit before 21:30Z
  depends on when R4H releases the lane.
- **The gx10 docker host is shared** with G1's chain (gx10 lane, unrelated GPU). Each pair runs together, so both
  builds share the same host load; per-cell load is recorded (`load.json`).

## Ports, tunnel and locks (LG1's own; asserted in tests and the preflight)

- **Tunnel:** gx10 `127.0.0.1:19380` → hub `127.0.0.1:18380`.
- **Meters:** local `172.17.0.1:6110` / `6112` (counters `6120` / `6122`); cloud traps `6111` / `6113` (`6121` / `6123`);
  the NEG slot's traps `6114` / `6115` (`6124` / `6125`).
- **None collides with another chain:**
  - R4H: 19180 and 5810–5825;
  - G1gate: 5910–5925;
  - P2G, H3 and H4-lite: 4710–4729 and 4810–4818;
  - M2: 18980 and 5710–5725;
  - R3R: 18880 and 5510–5525;
  - and the others in the preflight's list.
- **Own state:** `STATUS.txt`, `YIELD-NOW`, `.chain.lock`. Commits go under `../m1-2026-11/.commit.lock`, LG1's paths only.
- **Cleanup:** only what LG1 starts. The lane only if this chain started it (R4H's pid guard), its own tunnel (by
  process group), its own runner and meters, and its own cells' compose projects (by exact label).

## Benchmark-discipline checklist

- **Ref pinned.**
  - Both SHAs are checked reachable on GitHub before every start.
  - Each cell fetches its SHA and records it; any mismatch makes the cell `wrong_commit`.
- **Record on.** `[audit] enabled = true` in every surface.
  - Each cell keeps tb's logs, gnomon's log, the surface, the audit trail (when gnomon exits) and the meter timeline.
  - Everything is committed under `runs/`.
- **One variable:** the build. The arm, lane, tasks, cap, setup and agent class are identical.
- **Arms equally handicapped.**
  - Same clock (900 s) and same permissions (`--yes --trust`, approval never).
  - Same lane, and each pair runs together.
  - Transport failures are counted per build (client aborts, meter errors, `endpoint_outage`).
- **Validity rule pre-registered** (R1H's); buckets are asserted to sum to n.
- **Noise and MDE stated above.** No same-arm-twice run here; the power table uses the project's measured flip rate.
- **Negative control:** NEG in the smoke shows a cloud request is detected.
- **Positive control of the mechanism metric:** wire test C.
- **Stranger's state.** The wire test ran with empty XDG dirs and every key variable removed. The runner reads no
  credential.
- **Outcome from real state:** tb's verdict and the meters, never gnomon's own account.
- **Nothing rebuilt underneath a running arm.** Builds are fetched by SHA inside each container.

## Files

- **Chain, runner, collector:**
  - `apparatus/lg1-chain.sh` (`DRY=1` is read-only; `DRY_HUB=0` also skips the hub sample);
  - `apparatus/run_lg1.py` (`plan`, `smoke`, `full`, `abort-inflight`);
  - `apparatus/collect_lg1.py` (`--smoke`, `--mde`, `--no-write`).
- **Other apparatus:** `apparatus/preflight_lg1.sh`, `apparatus/tunnel-lg1.sh`, `apparatus/wiretest_lg1.mjs`,
  `apparatus/mktree_lg1.sh` (= R4H's `mktree_r4h.sh`).
- **Tests:** `test_run_lg1.py`, `test_chain_glue_lg1.sh`, `test_collect_lg1.py`; S1's `test_hubwatch_s1.sh` and
  `test_relay_s1.mjs`.
- **Byte-identical copies of R4H's** (and so of R1H's, R3R's and S1's): `collect_m1.py`, `gnomon_agent.py`,
  `peer_agents_r1.py`, `peer_agents_r3r.py`, `gnomon-setup-r3r.sh.j2`, `relay-meter-s1.mjs`, `test_relay_s1.mjs`,
  `s1-hubwatch.sh`, `test_hubwatch_s1.sh`, `sample16-hunch.txt`.
- **Evidence before data:** `wiretest-lg1.txt` (all checks pass on both builds), `offline-lg1.txt` (every offline test
  and the hub-free dry check: all pass).

## Launch

`cd ~/gnomon-wt/peers/benchmarks/results/lg1-2026-11/apparatus && setsid nohup env LG1_DEADLINE=2026-11-05T21:30:00Z ./lg1-chain.sh >> ../chain-lg1.log 2>&1 < /dev/null &`

It waits for R4H's lock, then for 2 idle samples, then runs.

## Addendum 1 — gx10 crash, 2026-11-06 (written before resuming; no change to the analysis)

- **What happened.** The gx10 (where LG1's chain, runner, meters, tunnel and task containers run) halted abruptly at
  **2026-11-05T20:17Z** (no shutdown in the journal; load ~100) and came back at **2026-11-06T05:21Z**. The hub's
  llama-server LG1 had started was gone when checked at 05:30Z (hub GPU 2809 MiB used, no llama-server.exe).
- **Finished before the crash:** attempt 1 pairs 1–7 (14 cells) and `lg1-k1-new-mailman`: 15 cells with `cell.json`, kept.
- **Interrupted:** `lg1-k1-old-mailman` (started 20:01:43Z, no `END`). Moved by the runner's own
  `run_lg1.py abort-inflight runs crash` to `runs-aborted/lg1-k1-old-mailman-crash/` (compose project and network
  removed by exact label; reason file inside). It is **re-run fresh, alone**, exactly as the pre-registered after-yield
  rule handles a pair with one cell finished; the collector reports such pairs.
- **Deadline.** The 2026-11-05T21:30Z new-cell deadline passed during the outage. The resumed chain uses
  **`LG1_DEADLINE=2026-11-06T20:30:00Z`** (the coordinator's window: the hub is idle now). Pairs not started by then are
  never imputed.
- **Resume.** The same chain, with its idle-start and hubwatch yield unchanged (it yields if the GPU's owner starts
  using it); the smoke is not repeated; finished cells are skipped.
- **Unchanged:** validity, non-inferiority margins, comparisons, seed, verdict rule.

# M1: a local-model ladder with a hybrid arm (pre-registration)

Written 2026-11-03 ~06:15Z, before any M1 cell. It is committed before any lane smoke and any measured
cell. The only cell run before the commit is the cloud-only NEG apparatus check recorded at the end
of this file. Each chain appends its lane's smoke result to `STATUS.txt` and `smoke-<lane>-*.txt`
before that lane's first measured cell. Every later change is a timestamped amendment at the end of this file.

## Questions (the user's)

1. Do the new local models beat the incumbent, qwen3.6-35B-A3B?
2. Does hybrid pay off? The hybrid arm is PC: the cloud plans and the local model builds.

## The variable: a local deployment recipe, not a model

The engine, quantisation, context, concurrency and reasoning mode change along with the weights. M1
therefore compares **local deployment recipes**: a model together with the way it is served. A
difference can't be attributed to the weights alone.

| Lane | Machine | Model (served name) | Engine | Reasoning | Context per request | Cell concurrency |
|---|---|---|---|---|---|---|
| incumbent, M1a's reference (R1H's L/PC/C) | hub RTX 5090 | qwen3.6-35b, UD-Q4_K_S + DFlash draft | llama.cpp b11739 | **off** (`--reasoning off`) | 98,304 (2 slots) | 2 |
| `glim` | hub RTX 5090 | glimmer-30b, Muse-Glimmer-30B Q4_K_M + DFlash draft | llama.cpp b11739 (same build) | **always on.** The template opens its thinking channel unconditionally; it can't be switched off | 98,304 (2 slots) | 2 |
| `q38` | hub RTX 5090 | qwen3.8-27b, RadixArk/Qwen3.8-27B-NVFP4 | vLLM 0.27.1 + PR #40914 backport, in WSL2, TurboQuant 4-bit KV, MTP-3 | off (`enable_thinking: false`) | 131,072 (max-num-seqs 2) | 2 |
| incumbent, M1b's reference (R1's L/PC/C) | gx10 GB10 | qwen3.6-35b, same GGUF + DFlash | llama.cpp (gx10 build) | off | 98,304 (1 slot) | **1** |
| `fnx` | gx10 GB10 | qwen3.8-flash-next, nvidia/Qwen3.8-Flash-Next-FP4-Local | TensorFold 1.1.4 (+17 recipe patches), MTP drafts | off (`--no-thinking`) | 98,304 (`CONTEXT=98304`, per the coordinator); fallback 81,920 if memory is short | L: **1**; PC: see below |

- The lanes were prepared by another agent. Their pins and every setting are in the READY markers: hub `C:\dev\m1-READY-glimmer.txt`, `C:\dev\m1-READY-qwen38.txt`; gx10 `~/gnomon-bench/READY-flash-next.txt` and `flash-next-tf/PINS.txt`. The chains copy those markers into this directory as `lane-<lane>-READY.txt` before each lane starts.
- **Coder-Next** (`cdr`) is FAILED (no disk), per the lane agent. It isn't run.
- **Context.** gnomon at the pinned build budgets `max_context_tokens = 65536`, written by `gnomon init` in the R1 setup template and not overridden there. So every server window above covers gnomon's budget plus output, and the differing windows don't change what gnomon sends.
- **Sampling** is gnomon's own in every lane. No lane sets sampling flags that requests don't override.

## Tasks, attempts, cap, build: R1H's

- **Tasks:** the same 16 (`apparatus/sample16-hunch.txt`, byte-identical to R1H's), × **2 attempts**, with attempts as barriers. Within an attempt, tasks are shuffled with seed = attempt, as in R1H. Each runner invocation runs one arm, so the order is the shuffled task order.
- **Cap:** 900 s (`--global-agent-timeout-sec`). tb's 300 s join window applies as in every earlier run. A cell counts as "capped" when tb's `failure_mode` is `agent_timeout`.
- **Build:** gnomon `d59e6c198f91d1469198b0677c008323f82d0345`, R1H's and R1's build. It is fetched by SHA in every cell (`GNOMON_EXPECT_SHA`), checked against GitHub before each runner starts, and recorded per cell (`agent-logs/gnomon-commit.txt`, and `ARM_VERSION=` on the terminal).
- **Apparatus reused byte-identical from R1H:** `gnomon-setup-r1.sh.j2`, `peer_agents_r1.py`, `gnomon_agent.py`, `relay-go.mjs`, `relay-meter-r1.mjs`. `run_m1.py` is `run_r1h.py` parameterised by lane (local URL, model name, cell-id prefix, arm). `collect_m1.py` is `collect_r1h.py`'s validity code, applied as one function to M1's cells and to the incumbents' cells.
- **Arms:** R1H's definitions.
  - **L:** every role local, entry `implementor`.
  - **PC:** coordinator and plan in the cloud; implementor, verifier, implement, critique and smol local; entry `coordinator`.
  - **NEG** (smoke only): everything in the cloud, asserted as L. It must come out `misrouted`.
- **Cloud:** DeepSeek V4.1 Flash through OpenCode Go (relay-go), the same as R1H and R1.

## Validity, routing, outages: R1H's rules, applied symmetrically

**A cell is valid when all of these hold:**
- tb returned a verdict;
- both meters read non-negative deltas;
- at least one chat request was metered;
- it ran the pinned commit;
- gnomon didn't give up on an endpoint after its whole retry grace (R1H's endpoint-outage rule, `bdb41deb`);
- its traffic matches its arm:
  - L: cloud = 0 and local > 0;
  - PC: cloud > 0, and local > 0 if it delegated.

**Every other state is apparatus:** `missing`, `apparatus`, `unmetered`, `endpoint_outage`, `no_model_call`, `wrong_commit` or `misrouted`. These cells are reported and never scored. Buckets are asserted to sum to n per (lane, arm).

**The same function judges the incumbents' cells,** read-only from `../r1h-2026-11/runs` and `../r1-2026-11/runs`.

**Outages and operator actions:**
- A lane outage detected during a run (the server or tunnel dies) makes the affected cells `endpoint_outage`. They are re-run once if time allows, as in R1H.
- An operator abort (a cell in flight when a chain is stopped) is moved to `runs-aborted/<cell>-<reason>` and re-run from scratch.

## Meters and ports (new; no clash with live runs)

- **Live and avoided:** 4710–4712, 4810–4812, 4910–4921, 5110–5122, 18080/18081/18098/18099, 18280, 18381–18383 and 18397–18399.
- **M1a slot i (i = 1, 2):**
  - local meter `relay-meter-r1` on 172.17.0.1:5010+2(i−1) (counters 5020+2(i−1)), upstream `http://127.0.0.1:18680`, the tunnel to hub 127.0.0.1:18480 (`apparatus/tunnel-m1a.sh`, M1's own copy, launched by absolute path);
  - cloud `relay-go` on 172.17.0.1:5011+2(i−1) (counters 5021+2(i−1)).
- **M1b slot i:** the same pattern from 5030, so 5030/5040 and 5031/5041 for slot 1, and 5032/5042 and 5033/5043 for slot 2. Upstream `http://127.0.0.1:18580`.
- **Cell ids:** `m1a-glim-k<k>-<arm>-<task>`, `m1a-q38-…` and `m1b-fnx-…`, all lower case. Smoke cells are `<prefix>-s-<arm>-hello-world`. tb names compose projects after run ids, so no id collides with R1/R1H/P2G.

## Decision rule (fixed now; per machine)

The winner is the lane that **solves the most valid L-arm tasks (pooled over both attempts) with no higher count of capped cells. Ties go to the incumbent.** Operationally (`collect_m1.py --decide`):

1. For each challenger, take the (task, attempt) cells valid in both the challenger's L arm and the incumbent's L arm. On M1a the incumbent is R1H's L arm; on M1b it is R1's L arm.
   - Pairing makes the counts symmetric when either side has apparatus cells.
   - R1 is paused mid-attempt-2 by M1b (below), so on M1b the pooled set is whatever R1 has finished at decision time.
2. A challenger **qualifies** if all three hold:
   - it solves more of those cells than the incumbent;
   - it has no more capped cells than the incumbent on them;
   - it has at least 24 of its 32 L cells valid. A lane dominated by apparatus can't win.
3. Among qualifiers the winner has:
   1. the largest paired margin (challenger − incumbent);
   2. then the most solved;
   3. then the fewest capped;
   4. then the earlier run order (glim before q38).
4. If no challenger qualifies, the incumbent wins.

**This rule picks which recipe gets the PC arm. It is not a superiority claim.** A claim that a model beats the incumbent needs the paired exact McNemar below (p < 0.05).

## PC arm

- **Who runs it:** each machine's winner, 16 × 2, on its own lane. If the incumbent wins on a machine, M1 runs no PC there, because R1H/R1 already have it.
- **M1a:** 2 slots, as R1H's PC.
- **M1b:** 1 slot if, at PC start, the time left before the M1b deadline is at least 32 × 630 s (R1's mean PC cell). Otherwise 2 slots. The asymmetry with R1's single slot is then reported.

## Endpoints

Per lane and arm, together with the incumbent's corresponding arm under the same validity function:
- pass rate with a 95% Wilson interval;
- **paired exact McNemar (two-sided)** against the incumbent's same-(task, attempt) cells:
  - L vs incumbent L;
  - PC vs incumbent PC;
  - PC vs the incumbent run's C;
  - PC vs the same lane's L;
- for PC: $ per solved task (Go allowance), and the cloud share of tokens and of requests, with the paired sign tests of cloud tokens and $ against the incumbent run's C;
- median agent wall time, and capped cells;
- local tokens per solved task (and local output tokens per solved).

## Power and limitations, stated now

- **Power:** at most 32 pairs per comparison, and earlier runs flipped about 15% of cells between attempts. Only pass-rate differences of roughly 20 points or more are detectable. A non-significant comparison is "no difference shown", not "no difference".
- **Time-separated comparison:**
  - The incumbents' cells ran earlier: R1H 2026-11-02/03, R1 2026-11-02/03. They ran under different concurrent load (R1H alongside R1 and P2G; M1a alongside M1b or R1/P2G).
  - The cloud model and the task containers are the same, but Go's serving and the gx10's CPU load differ by run.
- **Recipe confound** (above): engine, quantisation, reasoning mode and context change together with the weights. Glimmer reasons and the incumbent didn't. Glimmer's model card warns that a generation that runs out of slot context returns no answer silently.
- **Concurrency:**
  - M1b's PC may run 2 slots against R1's 1.
  - M1a's two slots share one GPU, as R1H's did.
- **Coder-Next** was not measured.

## Budget

- **Cap:** all of M1's cloud spend, both machines with smoke included, goes into one ledger (`spend.jsonl`), capped at **$4.50**. Above it:
  - no new cell starts in either runner;
  - `BUDGET-PAUSE.txt` is written;
  - the chains start no further arm.

  Four cells can be in flight at most, which keeps the total under $5.
- **Expected:** about $1–2. L arms spend ~$0, and a PC cell cost $0.01–0.05 in R1H/R1.
- **Shared key:** R1, R1H and P2G use the same Go key.

## Deadlines

- **M1a:** no new cell starts after 2026-11-03T13:30Z.
- **M1b:**
  - no new cell starts after 13:15Z, so cells in flight end by about 13:35Z, and R1/P2G resume then;
  - M1b doesn't start (doesn't pause anything) after 10:30Z.
- Cells not started by a deadline are logged as `NOT STARTED … (deadline)` and never imputed.

## Chains

**`apparatus/m1a-chain.sh` (hub RTX 5090):**
1. Wait for R1H's `STATUS.txt` to carry a ` CHAIN DONE` line, with no R1H runner or chain process left.
   - R1H's own cleanup stops the bud-lane llama-server and its tunnel. M1 never touches either.
   - Then verify the hub GPU: no `llama-server.exe` running, and memory used under 4,000 MiB. Wait up to 30 min, else stop and log.
2. **Glimmer:**
   1. Wait for `C:\dev\m1-READY-glimmer.txt`.
   2. Start with the lane agent's `start-m1.ps1`, and open M1's tunnel.
   3. Run a soak (2 concurrent requests, ~2 min; informational for this lane), then the smoke: L + NEG on hello-world. L must be valid and NEG misrouted.
   4. Run the L arm.
   5. Stop the server and the tunnel.
3. **qwen38:**
   1. Wait up to 60 min for `C:\dev\m1-READY-qwen38.txt`. A `C:\dev\m1-FAILED*qwen38*` marker or the timeout means log and skip.
   2. Start the lane and open the tunnel.
   3. **Soak, gating** (the recipe author warns "MTP + concurrency crashes this KV path"): 2 concurrent requests with a ~3,000-token prompt for 4 min, plus a garble probe (the integers 1–30 at temperature 0, which must come back exact). The soak passes only with no HTTP error, every probe exact, and the server still answering.
      - If it fails, restart with the lane agent's pre-declared fallback `SPEC_CONFIG={"method":"mtp","num_speculative_tokens":1}` and soak again. If that passes, the setting is recorded in STATUS as an apparatus setting before any q38 data; if it fails, q38 is skipped.
      - M1 launches the fallback with its own wrapper on the hub (`C:\dev\m1-chain\`) and its own WSL helper (`/home/bench/m1-chain/`), because the lane agent's Windows wrapper doesn't forward the variable. The lane agent's scripts aren't modified, and their `stop-m1.ps1` stops it.
   4. Smoke, then the L arm.
4. **Decide** (`collect_m1.py --decide m1a`):
   - if q38 wins, run PC on it while it is still up;
   - if glim wins, stop q38 and restart Glimmer;
   - before PC, smoke PC on hello-world; then run PC (2 slots).
5. Collect (`summary.txt`) and commit M1's own paths. Final cleanup, scoped to M1's own servers (the lane agent's stop scripts, which stop only their own lane) and M1's own tunnel (`[m]1-2026-11/apparatus/tunnel-m1a.sh`, and the ssh forward `127.0.0.1:18680:127.0.0.1:18480`). There is no idle fallback: cleanup runs only when this chain exits.

**`apparatus/m1b-chain.sh` (gx10):**
1. Wait for `~/gnomon-bench/READY-flash-next.txt`.
2. **Non-destructive precheck,** before anything is paused. It re-runs every 5 min until 10:30Z, then M1b is skipped, so R1/P2G are never paused for a refusal that is already certain.
   - **GPU.** `start-m1.sh` refuses any compute app on the GPU. qa-panel's llama-server holds a CUDA context even when idle (pid 5300, 170 MiB at writing), and qa-panel is never touched. While the script keeps that strict check and a non-incumbent compute app is present, the start would certainly fail, so M1b waits.
   - **Memory.** If MemAvailable now, plus the incumbent's GPU memory, plus every task container's memory, falls more than 4 GiB short of what the start needs (107 GiB at `CONTEXT=98304`), M1b waits. At writing that projection is about 93 GiB.
   - These numbers go into STATUS. If the precheck passes, the steps below run.
3. **Pause R1 and P2G** (pre-registered operator pauses, written into their STATUS files before execution):
   1. Find each runner's pid from `ps -eo pid,pgid,args` (`[r]un_r1.py full`, `[r]un_p2g.py run`) and kill its process group (SIGTERM, then SIGKILL after 30 s). P2G's relays on 4710–4712 are separate groups and keep running.
   2. Take `gpu.lock`.
   3. Log a PAUSE line into each run's STATUS.
   4. Move in-flight cells:
      - R1 runs dirs without a trial `results.json` go to `runs-aborted/<cell>-m1pause`;
      - P2G runs dirs without `cell.json` go to `runs-aborted/<cell>-m1pause`, together with `jobs/<cell>` → `jobs-aborted/<cell>-m1pause`.
   5. Remove those cells' containers and networks by exact compose-project label and exact name.
4. `systemctl --user stop llama-server-qwen-q4.service`, then check MemAvailable against the start script's own need.
   - If it is short, wait up to 15 min for R1H/M1a task containers to drop.
   - Start with `CONTEXT=98304`. If the start refuses, retry once with `CONTEXT=81920` (65,536 budget + 16,384 output).
   - If that fails too, log FAILED, skip M1b and restore.
5. Soak (informational), then the smoke (L + NEG). Run the L arm (1 slot) and decide (`--decide m1b`, against R1's L). If Flash-Next wins, smoke PC and run the PC arm (slots as above).
6. Coder-Next is FAILED, so it is skipped.
7. **Restore** (also done by the EXIT trap if anything fails after the pause):
   1. Stop Flash-Next (the lane agent's `stop-m1.sh`) and release `gpu.lock`.
   2. `systemctl --user start llama-server-qwen-q4.service`, and wait for :18080 to list qwen3.6-35b.
   3. **Resume R1:** `setsid nohup r1-2026-11/apparatus/r1-resume.sh >> r1-2026-11/resume.log`. Only if :18080 answers; otherwise R1's resume would exit and write a false DONE.
   4. **Resume P2G:** `cd p2g-2026-11/apparatus && setsid nohup python3 -I run_p2g.py run >> ../run.log`. Only if its relays on 4710–4712 answer.
   5. Log RESUME lines into each STATUS.
8. Collect and commit M1's paths.

Both chains are started with `setsid nohup`, wait on pids (never on process names), and log to `STATUS.txt`. Commits add only M1's paths, under a lock shared by both chains. They wait while R1H is between its runner's exit and its DONE line (its commit window).

## Pre-launch record, 2026-11-03T06:21:04Z (before any measured cell)

- **Pre-launch NEG smoke** (cloud only, through `run_m1.py` on M1a's meters; it doesn't contend with R1's lane), in `runs-smoke-pre/`.
  - `m1a-glim-s-neg-hello-world`: `misrouted` as required (local 0, cloud 4, $0.0007).
  - Pinned commit verified in the cell. The ledger and the collector work.
  - The gx10 1-minute load average was 64.7 at the time.
- **Dry checks** (`DRY=1`) of both chains passed: hub reachable, all READY markers present, ports free, preflight OK.
- **M1b precheck at writing: BLOCKED, on two counts.**
  1. qa-panel's llama-server (pid 5300) holds a 170 MiB CUDA context while idle, and `start-m1.sh` refuses any compute app.
  2. The projected MemAvailable after a full pause is about 94 GiB, against 107 GiB needed (81 weights + 2 KV + 8 + 14 reserve + 2). The smaller-window fallback (81,920) needs the same 107 GiB.

  So unless the lane or the machine changes before 10:30Z, M1b is skipped and R1/P2G are never paused. The chain re-checks every 5 minutes and proceeds by itself if both conditions clear.

## Amendment 1, 2026-11-03T06:27:18Z: M1b unblocked with a lane-script copy; before any M1b data

The coordinator measured the gx10:
- MemAvailable is 67 GiB.
- The incumbent qwen lane holds 22.6 GiB of GPU memory plus about 8 GiB RSS.
- The user's Cursor IDE holds 13 GiB and stays.
- Task containers hold about 10 GiB.

So about 95–100 GiB is expected once R1H has finished, R1 and P2G are paused and the qwen lane is stopped. The coordinator also decided that qa-panel is never touched, and authorised a **copy** of the lane script, `~/gnomon-bench/flash-next-tf/start-m1b.sh`. The lane agent's `start-m1.sh` is unchanged.

**The copy differs from `start-m1.sh` only in these points** (a copy is also in `lane-fnx-start-m1b.sh` once M1b starts):
1. **GPU precondition.** Every GPU compute process is logged at start, and each must use under 1 GiB. qa-panel's idle 170 MiB context passes; anything holding real memory still refuses.
2. **Settings.** `PARALLEL=1` (1 stream), `CONTEXT=98304` (the incumbent's per-slot window), `VISION=0`, and `TENSORFOLD_MEMORY_RESERVE_GIB=9`, the recipe default (`start-m1.sh` used 14). Thinking stays off, fp8 KV, MTP drafts and every other setting are unchanged.
3. **Memory precondition, computed rather than fixed:**
   - 79 GiB load footprint without vision (the README gives 81 with vision on, 2 of which is the vision helper);
   - plus fp8 KV for 1 × 98,304 (4.78 GiB per 262,144 tokens, about 1.8 GiB);
   - plus the 9 GiB reserve;
   - plus a 6 GiB safety margin.

   That is **96 GiB**, which the chain waits up to 20 minutes for after the pause. The measured MemAvailable at start and the load footprint are logged.
4. **OOM safety.** `docker run --oom-score-adj=1000`, so if memory runs out the kernel kills the Flash-Next container first, not the benchmarks, agentcenter or the desktop.

**Chain changes** (`apparatus/m1b-chain.sh`):
- **Trigger and deadlines.** M1b starts right after R1H's ` CHAIN DONE`, the same trigger as M1a. The 10:30Z go/no-go stays. The new-cell deadline is **13:30Z** (was 13:15Z).
- **Precheck.** It now gates only on a non-incumbent GPU process using 1 GiB or more, which the copy would refuse for certain.
- **Start.** No smaller-window fallback: the window is fixed at 98,304. The start gets one fix-don't-fail retry, then FAILED.
- **Slots.** **L and PC both run with 1 stream and 1 slot**, as R1's L and PC did. This replaces the PC slot rule above and removes the concurrency asymmetry on M1b.
- **Lane-death watchdog.** It checks every 30 s while an arm runs. The lane counts as dead when the container is not running, or `/v1/models` has failed 10 times in a row (5 min; `/health` isn't relied on). The same commit makes an interrupted arm's in-flight cell apparatus.
  - The cell(s) in flight, and any cell that ended in the 3 minutes before detection, are apparatus and move to `runs-aborted/<cell>-lanedeath`.
  - One lane restart is allowed in all of M1b, after which the arm continues and keeps its finished cells.
  - A second death means FAILED: `M1B-FAILED.txt` gets the reason, the qwen lane is restored, and R1 and P2G are resumed.
- **Time.** One stream makes the 32 L cells take about 3.5 h at R1's mean L cell time. PC with one stream (about 5.6 h at R1's mean PC cell) will be partial at the 13:30Z deadline. Unstarted cells are reported as not run and never imputed, and every comparison uses paired valid cells only.
- **The variable** is still the deployment recipe. fnx now matches the incumbent's (R1's) per-slot window, its single slot and its reasoning-off mode. Engine, quantisation and MTP drafts differ.

## Amendment 2, 2026-11-03T09:06Z: q38 retried with the lane README's third fallback; before any q38 data

**What happened.** M1a's chain skipped q38. Its 2-concurrent garble soak failed with MTP-3 (`probe_bad` 47 of 116) and with the pre-declared MTP-1 fallback (5 of 104). Every bad probe was a duplicated or dropped number in a 1–30 count (for example `… 24 24 25 …`), and the server stayed up (`soak-q38.txt`). M1a's decision (`decision-m1a.txt`: Glimmer 12 vs 21 paired, p=0.012, incumbent wins) stands as recorded. It is not re-litigated here.

**Why retry.** The fix-don't-fail rule applies. The lane's own README-M1 pre-declared a third knob, "then without MTP (would need a start.sh edit to drop --speculative-config); each fallback is an amendment". The recipe author warns that "MTP + concurrency crashes this KV path".

**Change (hub, WSL distro m1-vllm):**
- `start.sh` now passes `--speculative-config` unless `SPEC_CONFIG=none`. The default behaviour is unchanged. The original is kept at `/home/bench/m1-chain/start.sh.orig-before-amendment2`.
- New helpers: `/home/bench/m1-chain/start-nospec.sh` and `start-seq1.sh`, wrapped by `C:\dev\m1-chain\start-m1-{nospec,seq1}.ps1`.

**Order, fixed now** (`apparatus/m1a2-chain.sh`):
- **(a)** No speculative decoding, 2 seqs, 2 slots. Garble soak at 2 concurrent, 240 s, same gate (zero bad probes).
- **(b)** Only if (a) fails: the recipe's own concurrency, 1 seq with its MTP-3, 1 slot. Garble soak at 1 concurrent, same gate.
- If (b) fails too, q38 is reported as "did not run: the engine garbles under this recipe", with the soak evidence.

The same smoke and commit-before-data steps follow, then the L arm (16 × 2, same cap, build `d59e6c19`, deadline 13:30Z for new cells). Then `collect_m1.py --decide m1a`, unchanged, writes `decision-m1a2.txt`, now with q38 included. If q38 wins, its PC arm runs until the deadline. Glimmer gets no PC arm.

**Caveats, stated now:**
- q38 runs about 2 h after Glimmer and about 6 h after the R1H incumbent cells (time-separated, as Glimmer was).
- Without MTP, q38 is slower than the recipe intends. Wall-clock comparisons for q38 are therefore not the recipe's best case. Solve rate is the decision metric and is unaffected by MTP in principle.

## Amendment 3, 2026-11-03T09:42Z: Glimmer-30B re-tested with reasoning replay; before any M1a3 data


**What this is.** A mechanism re-test of Glimmer-30B's L arm, run after M1a2 and on the same lane. M1a's decision (`decision-m1a.txt`: Glimmer 12 vs 21 paired, p = 0.012, the incumbent wins) stands as recorded. It is not re-decided here, and no decision rule changes.

**Why.** Forensics on M1a's Glimmer cells, from the code and from aggregates:
- Build `d59e6c19` never sends `reasoning_content` back on assistant messages. Its OpenAI message allow-list is role/content/tool_calls/tool_call_id/name.
- When an unstreamed reply had `content: null` beside tool calls, that build promoted the reasoning into `content`. Glimmer's template drops `content` on assistant messages that carry tool calls, so the reasoning was lost there too.
- The template does render `reasoning_content` on every assistant message, as the `to=self` channel. Its caps declare `supports_preserve_reasoning`, and the M1a server log says "chat template supports preserving reasoning, it is enabled by default".
- So Glimmer saw a history of bare call/output pairs and lost its own reasoning at every step. After step 1 it wrote 60–300 completion tokens per step.
- 7 of the 10 pairs the incumbent won ended in a loop, a stall-stop or the 256-call ceiling. Glimmer hit 10 stall-stops to the incumbent's 5, and 4 ceilings to its 0.

This rests on inference: the audit (`record = metadata`) and the relay keep no message text, so no transcript proves it. gnomon master `166a9d3cd970784fadf367ce02aba4df5925555f`, on GitHub, has an opt-in per-endpoint `replay_reasoning`. It is off by default except for api.deepseek.com, whose docs require it. Per the benchmark-discipline rule, a cheap code fix exists, so the fix is measured rather than the bug.

**Build.** Both arms run gnomon `166a9d3cd970784fadf367ce02aba4df5925555f`. It is fetched by SHA in every cell, checked on GitHub before each runner starts, and recorded per cell. Master changes more than replay between `d59e6c19` and `166a9d3c`. Of those changes, these reach an L cell on this lane:
1. **Streaming.** `gnomon init` writes `[defaults] stream = true`. Every call goes out `stream: true` with `stream_options.include_usage`. A stream is timed by the gap between chunks: 300 s idle, 1,800 s in total, and 300 s for the first byte. Under `d59e6c19` calls were unstreamed with a 300 s headers timeout; M1a's polyglot k2 had one 698 s step.
2. **Output limit.** `init` writes `[defaults] max_tokens = 32768`, sent on every request (`d59e6c19` sent none). The limit counts reasoning. A tool call cut off by the limit is not run; the model is asked for smaller parts, and repeated cut-offs end the turn as `truncated`.
3. **No reasoning promotion.** With `content: null` beside tool calls, reasoning is no longer promoted into content (a streamed reply never was). G0 therefore sends `content: ""` where M1a sent the reasoning text, which the template then dropped.
4. **Context overflow.** llama.cpp's context-overflow error is recognised, so the turn trims and goes on; before, it ended as `apparatus_failure`.
5. **Record guard.** Gnomon's record directories are snapshotted around every tool call that can write. A change gnomon did not make stops the turn with `stop_reason: "tamper"`. The `record` policy rule refuses writes into `.gnomon-audit/`.
6. **Minor.** git's index refresh is written back once per process. Tool subprocesses get `GNOMON_AGENT_SESSION`.

These master changes do not reach an L cell:
- the task-tool description (the implementor has no `task` tool);
- the sticky fallback (no fallback is declared);
- the endpoint `max_context_tokens` (undeclared, so the budget stays 65,536);
- skill trial, skill mine and audit tamper/resolve (never invoked);
- the Windows-only changes.

Compared with `d59e6c19`'s scaffold, `gnomon init` output differs only in the `[defaults]` and `[resilience]` lines above and the `task` tool's description. `system.md`, `roles.toml`, `policy.toml`, the profiles, the `[turn]` numbers and the sampling (implementor temperature 0.3, top_p 0.95) are byte-identical; both inits were run and diffed offline.

An offline wire test against a fake server confirmed the differences. On a step after a tool call, `d59e6c19` sent `stream: false`, no `max_tokens`, and the reasoning as the assistant's `content`. Master G0 sends `stream: true`, `max_tokens: 32768`, `content: ""` and no reasoning. Master G1 sends the same plus `reasoning_content`.

That is why the control arm exists.

**Arms.** There are two L arms. Each varies one thing, and G0 is the control.

| Arm | Cells | Build | `[endpoints.r1local]` |
|---|---|---|---|
| **G0** (control) | `m1a3-g0-…` | master | `replay_reasoning = false`, declared explicitly |
| **G1** (treatment) | `m1a3-g1-…` | master | `replay_reasoning = true` |

- **The only surface difference** is one line in `.gnomon/config.toml`: `replay_reasoning = false` against `= true` under `[endpoints.r1local]`. The profile, roles, policy, tools and system prompt are byte-identical; `preflight_m1a3.sh` asserts this, and an offline wire test of master against a fake server confirmed it.
- **On the wire**, G1's assistant messages carry `reasoning_content` and G0's don't. Stream, include_usage, `max_tokens` 32768, temperature 0.3 and top_p 0.95 are the same in both.
- **Unchanged from M1a's Glimmer L arm:**
  - the lane, started with `start-m1.ps1` as is, after a check that its props match M1a's: build b11739, the model file, chat template and caps, 2 slots × 98,304;
  - M1's tunnel at 127.0.0.1:18680;
  - the 16 tasks × 2 attempts, with attempts as barriers and the seed = attempt shuffle;
  - the 900 s cap, the validity rule and the cloud relay. The cloud relay is unused in L, and a cell must read cloud = 0.
- **Concurrency.** G0 and G1 run at the same time, one slot each, so together they fill the server's 2 slots as M1a's 2-slot arm did.
  - **Bounded lead 1:** an arm may start position *i* only once the other arm has started position *i − 1*. Both arms are therefore on the same task at about the same time, on the same server and the same gx10 load. An arm that has finished or died never holds the other back.
  - The task order is identical for both arms.
- **Order and deadline.**
  1. The chain waits on the M1a2 chain's **pid** (`M1A3_WAIT_PID`, default 2024045), never on a process name.
  2. It then applies M1a2's hub-GPU test (no `llama-server.exe`, under 4,000 MiB used), waiting up to 15 min for the GPU to free.
  3. No new cell starts after **`M1A3_DEADLINE` (default 2026-11-03T17:00Z)**. Cells not started by then are logged and never imputed. If M1a2 runs a PC arm until 13:30Z, attempt 2 may be partial; pairs are taken only where both arms ran.

**Pre-data gate, before any measured cell.** Every result goes into STATUS.
1. **The M1a server log** is saved: `lane-glim-server-m1a.log.gz`, because a lane start overwrites it.
2. **Template probe**, on the lane's `/apply-template`, which renders and does not generate. The history is: system, user, an assistant message with `reasoning_content` "MARKER-R7Q …" and a tool call, then the tool result.
   - The check records whether MARKER-R7Q reaches the rendered prompt.
   - A negative case without `reasoning_content` must not show the marker.
   - An informational case adds a later user turn.
   - A second informational case uses M1a's shape, the reasoning in `content` beside the call, to check whether M1a's reasoning ever reached the prompt.
   - If the marker does not render, STATUS logs **"G1 replay not rendered by template"** and both arms still run. That is a finding: G1 then sends a different body that becomes the same prompt.
3. **Stream probe**, informational: one streamed request shaped like gnomon master's. It records whether the lane streams `reasoning_content`; with none, G1 has nothing to replay. It also records tool-call deltas and the shape of usage.
4. **Smoke**, one cell per arm on hello-world, run concurrently. Each must be valid and solved, which is stricter than M1's smoke, and its surface must carry its arm's line exactly once.
   - **G0, negative control:** its meter must count 0 requests with `reasoning_content`.
   - **G1:** must send `reasoning_content` back whenever the model's previous reply carried reasoning and a tool call.
   - If G1 produced no such reply, the smoke passes as vacuous, with a warning.
   - One retry is allowed, restarting the lane only if it stopped answering. A second failure means M1a3 is not run.
5. **Commit before data:** STATUS, the probe and smoke files, the lane's props and models, the M1a server log and the M1a3 apparatus.

**Meter change.** `relay-meter-m1a3.mjs` is a copy of `relay-meter-r1.mjs`; the original is unchanged and still used by the other chains. It changes three things:
1. **Usage** is read with `JSON.parse`: a JSON body whole, an SSE stream line by line. The R1 regex missed nested usage objects; that is the m1b-fnx gap. The llama.cpp `timings` fallback is kept, and the source of every count is itself counted.
2. **Request bodies** are inspected for assistant messages carrying non-empty `reasoning_content`. This is the mechanism metric.
3. **Replies:** reasoning and tool calls in the model's replies are counted. Each request is also checked to see whether it followed a reply with reasoning and a tool call in the same cell; `POST /cell` resets that state per cell.

`test_relay_m1a3.mjs` has 22 offline cases and runs in the preflight.

Ports (free and unused by any apparatus):

| Arm | Local meter | Its counters | Cloud relay-go | Its counters |
|---|---|---|---|---|
| G0 | 172.17.0.1:5310 | 127.0.0.1:5320 | 172.17.0.1:5311 | 127.0.0.1:5321 |
| G1 | 172.17.0.1:5312 | 127.0.0.1:5322 | 172.17.0.1:5313 | 127.0.0.1:5323 |

Cells go to `runs-a3/` and `runs-a3-smoke/`. `collect_m1.py` and the other chains' globs never see them.

**Endpoints, declared now.** Analysis is `collect_m1a3.py`. It imports M1's `parse_cell` unchanged, so every cell, references included, is judged by the same function, and state buckets are asserted to sum to n.

- **Mechanism metric (resolvable):** per arm, the requests whose assistant messages carry `reasoning_content`, out of the requests carrying an assistant message.
  - Expected: G0 = 0 (negative control) and G1 > 0. Also expected: G1 sends it back after essentially every reply that had reasoning and a tool call.
  - Reported beside it, never instead of it: the per-cell surface line, and gnomon's own `wire.replay_reasoning` in its turn records.
- **Score metric (probably not resolvable at this n):** pass rate with a Wilson 95% interval, and exact two-sided McNemar on (task, attempt) cells valid in both arms of each pair:
  1. **G1 vs G0.** This is the mechanism comparison: same build, same window, one line apart. A claim that replay helps Glimmer needs p < 0.05 here.
  2. **G0 vs m1a-glim L.** The build-change control: master against `d59e6c19`, neither replaying. A difference here is attributed to "the build" (items 1–6 above), not to any single change.
  3. **G1 vs R1H's L.** Ladder evidence, time-separated and descriptive only. Beating the incumbent would need a time-matched incumbent arm, which is not run here.
- **Secondary, descriptive:** capped cells, median agent wall time, local tokens per solved, and how cells ended (the last turn's `stop_reason`: stall, step_wall, malformed, truncated, answered). The hypothesis predicts fewer stall/ceiling endings in G1.
- **A mechanism win with no score movement** is an honest partial result, declared here in advance.

**Power, noise and caveats, stated now.**
- **Power.** Each comparison has at most 32 pairs. The measured self-flip rate is about 15% (14.7% across 34 tasks in an earlier campaign; about 15% between attempts in R1H/R1). So only pass-rate differences of roughly 20 points or more are detectable. A non-significant G1 vs G0 is "no difference shown", not "no effect".
- **Sampling left unchanged:** gnomon's implementor temperature 0.3 and top_p 0.95, plus the server defaults top_k 40 and min_p 0.05. Glimmer's model card asks for temperature 1.0, top_p 0.95 and top_k 64.
  - Changing sampling would be a second variable, so both arms share the same, possibly suboptimal, sampling. Glimmer's absolute level is conditional on it.
  - A sampling arm is a separate question.
- **Time separation.**
  - G0 and G1 are concurrent. Every other comparison is time-separated: m1a-glim ran about 06:55–08:50Z, and R1H ran 2026-11-02/03.
  - The gx10 load and the concurrent runs differ; M1b may still be running when M1a3 starts.
  - The bounded lead means an arm sometimes waits while the other finishes, so the server sees 1 rather than 2 streams for that time. This applies to both arms alike, but differs from M1a's always-full 2 slots.
- **Replay is the treatment and has costs.**
  - Replayed reasoning is part of G1's prompt. It uses the 65,536-token budget, so G1 may trim or compact sooner, and its steps can be slower; both count toward its result.
  - The 32,768 output limit counts reasoning in both arms. The per-slot window, 98,304, equals 65,536 + 32,768.
- **Reasoning effort** is the template's default, "high", in both arms; gnomon sends none.
- **Concurrent task containers.** Both arms run the same task's container at about the same time, sharing the cached `tb__<task>__client` image under different container names.
- **Budget.** L cells spend $0 of cloud. The shared M1 ledger and its $4.50 cap still gate every start.

*Erratum to Amendment 2: its heading time (09:06Z) is approximate. Its commit, 2f794d2c, precedes the M1a2 chain start at 09:05:10Z, which is the ordering that matters.*

## Amendment 4, 2026-11-03T10:26Z: q38's attempt 2 is re-run after a lane jam; the re-run's relay passes client disconnects upstream; before any re-run data

**What happened.** From about 09:36Z, q38's lane jammed. The hub's vLLM log showed 2 requests generating for 15+ min (42 tok/s in total) with 15–17 waiting. Each attempt-2 cell ended after 3–4 calls with `UND_ERR_HEADERS_TIMEOUT`. At 10:22:52Z the main session stopped the M1a2 chain as an operator action (STATUS has the reasoning):
- 2 cells in flight went to `runs-aborted/<cell>-lanejam`;
- 4 attempt-2 cells had finished as `endpoint_outage` (apparatus, never scored);
- the other 10 attempt-2 cells never started.

q38's attempt 1 (16 cells, all ending by 09:36:41Z with 5–29 calls each) is kept.

**Cause (code-observed, reproduced offline).** The meter `relay-meter-r1.mjs` never aborts its upstream request when the client goes away. In a test against a never-answering upstream, the upstream saw no disconnect after the client left. Build `d59e6c19` sends unstreamed requests with no `max_tokens` and gives up on headers after 300 s, then retries.

On the slow no-MTP lane, one long generation outlives gnomon's timeout. The relay keeps it running for a client that is gone, and every retry queues behind it. The incumbent's fast llama.cpp lane rarely reached 300 s, so this bit only now. The flaw is in the apparatus, not in the model or gnomon.

**Change (re-run only).** `apparatus/run_m1_a4.py` is a copy of `run_m1.py` with two changes:
1. It uses `relay-meter-r1-abort.mjs`, a copy of the meter that destroys the upstream request when the client disconnects before the reply is complete. This is what a direct connection does. It counts `client_aborts`, and is tested offline on an abandoned request (upstream sees the abort) and on a normal reply (unchanged, usage metered).
2. It skips cells that already have `cell.json`.

The originals are untouched, because M1b still uses them.

**Order** (`apparatus/m1a4-chain.sh`):
1. Wait on the M1a3 chain's **pid**, then for a free hub GPU.
2. Start the q38 lane as in Amendment 2(a): no MTP, 2 seqs.
3. Same 240 s garble soak.
4. **Abort gate (negative control, live):** through the abort relay, start a long generation, abandon it after 6 s, and require `vllm:num_requests_running` to return to 0 within 30 s. Fail means no re-run, because the jam would recur.
5. Fresh smoke. M1a2's smoke cells move to `runs-smoke-a2/`.
6. Commit before data.
7. Move the 4 outage cells to `runs-aborted/<cell>-outage`.
8. Re-run q38's attempt 2 (16 cells, same plan order, seed = attempt, 2 slots, same cap and build). This is "re-run once" under the pre-registered outage rule.
9. Then the unchanged `collect_m1.py --decide m1a` writes `decision-m1a4.txt`. If q38 wins, its PC arm follows.

The new-cell deadline is 18:00Z.

**Caveats, stated now:**
- The re-run relay differs from the one the incumbent's cells used, but only when a client abandons a request.
- With aborts passed upstream, a generation that outlives gnomon's 300 s timeout now fails that cell's call honestly (retries, then `apparatus_failure`/outage per gnomon's own handling), instead of jamming other cells. That is the lane's speed showing, and it counts against q38.
- Attempt 2 runs about 4 h after attempt 1.
- **Unknown exposure in attempt 1:** attempt-1 cells may have met an abandoned request still running, which would have slowed them. None ended as an outage, but that exposure cannot be measured.

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

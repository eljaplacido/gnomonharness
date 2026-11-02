# R1H: can a hybrid setup lift task completion? Pre-registration

Written 2026-11-02, before any R1H cell. The chain appends a "Final" line, with
the smoke result, before the first measured cell. Every later change is a
timestamped amendment.

## Question

The user's question: can using a local and a cloud model together make gnomon
solve more tasks? R1 (`../r1-2026-11/`) asks it on the gx10 across five
arms × 2 attempts and ends tomorrow. R1H is a separate, focused run on the
three arms that answer it directly, with more attempts per arm:

1. **PC vs L:** does a cloud planner lift a local implementor? (tasks solved, paired)
2. **PC vs C:** does PC keep cloud-level task solving at a lower cloud share and
   lower $ per solved task? (tasks solved paired; $ per solved; cloud share)

R1H is never pooled with R1. A side-by-side table ("R1 says / R1H says") is
allowed only when clearly labelled as two runs.

## Arms

They are R1's arm definitions unchanged (`apparatus/run_r1h.py`, `ARMS`). Every role is
routed by one profile, `r1.toml`.

| Arm | coordinator | implementor | verifier | plan | implement | critique | smol | entry role |
|---|---|---|---|---|---|---|---|---|
| **L** all local | local | local | local | local | local | local | local | implementor |
| **C** all cloud | cloud | cloud | cloud | cloud | cloud | cloud | cloud | implementor |
| **PC** plan in the cloud, build locally | cloud | local | local | cloud | local | local | local | coordinator |

- **local:** qwen3.6-35b. **cloud:** DeepSeek V4.1 Flash, through OpenCode Go.
- **Build:** gnomon `d59e6c198f91d1469198b0677c008323f82d0345`, R1's pinned build (master after #80, `../r1-2026-11/BUILD.txt`). Fetched by SHA in every cell and recorded per cell.
- **Smoke control:** NEG is routed entirely to the cloud but asserted as L. It must be flagged misrouted, or the routing check detects nothing.

## Lane: the hub's RTX 5090, not the gx10

The local model is served by the hub lane BUD set up (`../bud-2026-11/`, amendment `c6a6eb68`):
- **Server:** llama.cpp b11739 (official Windows CUDA 13.4 build), C:\dev\bud-lane on the hub.
- **Weights:** the same files as gx10. `Qwen3.6-35B-A3B-UD-Q4_K_S.gguf`, sha256 `2bee952b218e4a481430c59d8d3bdc7bae20bed0eb501326340c5fca7ae95d42`; DFlash draft sha256 `107b7a433cbbdb4656a52b7845b35f6eed94eb0efb0019c8af7faed16d2d52f7`. The chain checks both on the hub before it starts the server.
- **Flags:** BUD's (`start-server-r1h.ps1`, a copy of BUD's `start-server.ps1` with its own log), bound to 127.0.0.1:18380 on the hub only.
- **Route from the gx10:** an SSH local forward to 127.0.0.1:18280 (`apparatus/tunnel-hub.sh`), metered by relay-meter-r1 on 172.17.0.1:18381 (counters 18397, with gpu_ms).
- **R1's lane is not touched.** R1 keeps the gx10 server (127.0.0.1:18080) and gpu.lock; R1H uses neither.
- **Not comparable with R1 in absolute terms.** Measured by BUD, the hub generates 4–6× faster than the gx10: about 375 against 66 tok/s, and about 4,000 against 1,070 tok/s for prompt processing. Tool commands still run in containers on the gx10's CPU. Only within-run contrasts count.

## Tasks, attempts, order, cap

- **Tasks:** R1's 16 tasks (`sample16-hunch.txt`) × **3 attempts**: 144 cells.
- **Order:** within each attempt, tasks are shuffled with seed = attempt, and arms rotate per task.
- **Concurrency:**
  - L and PC run on the lane slot, one cell at a time.
  - C runs on its own cloud slot (relay-go on 5111, counters 5121). Its local endpoint is a trap meter on 172.17.0.1:18382 (counters 18398) with a closed upstream, so a misrouted C cell is counted and never reaches a GPU.
  - The lane slot's cloud traffic goes through relay-go on 5110 (counters 5120).
- **Attempts are barriers.**
- **Cap:** 900 s, as R1, P1 and LEAN.
- **Cell ids:** `r1h-k<k>-<arm>-<task>`, lower case, distinct from every other run's compose projects.

## Validity and routing

These are R1's rules (`apparatus/collect_r1h.py` is `collect_r1.py`, restricted to these arms).

**A cell is valid when all of these hold:**
- tb returned a verdict;
- the cell ran the pinned commit;
- no counter went backwards;
- it made at least one metered request;
- its traffic matches its arm.

**Routing per arm:**
- L: no cloud requests.
- C: no local requests.
- PC: cloud requests > 0, and local requests > 0 when it delegated.

A cell that breaks its arm's routing is `misrouted`, which counts as apparatus and is never scored. The buckets are reported per arm and asserted to sum to n.

## Endpoints

**Primary** (exact McNemar on paired cells, two-sided):
1. Tasks solved, PC vs L.
2. Tasks solved, PC vs C, together with $ per solved task (Go allowance) and the cloud share of tokens.

**Secondary:**
- $ per solved for every arm, and GPU-seconds per solved (meter gpu_ms);
- tokens per solved, split local and cloud;
- the cloud share of tokens and of requests;
- median wall time and cells lost at the cap;
- requests per cell, and delegation depth for PC;
- the paired sign tests of cloud tokens and $, PC vs C.

**Power, stated now:** at most 48 pairs per comparison.
- Earlier runs flipped about 15% of cells between attempts.
- At that rate, a pass-rate difference smaller than roughly 15–20 points can't be detected.
- So a non-significant primary is "no difference shown", not "no difference".
- The cost and cloud-share contrasts are paired per task and have more power.

## What counts as an answer

- **PC lifts a local model:** PC solves significantly more than L (p < 0.05).
- **PC matches cloud for less:** PC is not significantly below C, and it has a lower cloud share and a lower $ per solved than C.
- **Anything else** is reported as measured, with direction and intervals. No arm is declared the winner on point estimates.

## Budget

- **Cap:** $8 of Go allowance for R1H. Above it, no new cell starts and the run pauses (`BUDGET-PAUSE.txt`).
- **Expected:** about $3–5. C's cloud cost per cell in R1 so far is about $0.03–0.05, and PC's cloud share is about 15–25%.
- **Shared key:** P2G and R1 use the same OpenCode Go key. At writing:
  - P2G's attempt 1 had spent about $28.5 of an expected ~$48;
  - R1 about $1.1.

  The user's November plan is about $100.

## Chain (`apparatus/r1h-chain.sh`)

1. Wait for BUD-2 (`../bud2-2026-11/`) to finish and release the hub lane:
   - it has logged its DONE line;
   - no BUD-2 process is left;
   - no bud-lane llama-server or tunnel is running.

   If BUD-2's cleanup doesn't release the lane within 45 min of DONE, take it over. If BUD-2 dies, proceed after 2 h of silence. Give up after 24 h.
2. Bring the lane up: check both checksums on the hub, start the server, start the tunnel, and wait until the model answers.
3. Smoke L, C, PC and NEG on hello-world. NEG must come out misrouted and every other arm valid; otherwise stop.
4. Append the Final line and commit it; then run the 144 cells.
5. Collect into `summary.txt` and commit it with the runs. Stop the hub server and close the tunnel.

The narrative `RESULT.md` follows from the summary.

## Amendment, 2026-11-02T15:44Z: 2 attempts and 2 concurrent lane slots (user's time window), before any cell

The user asked for hybrid task-completion results within 3–5 hours. The original chain
(`r1h-chain.sh`, waiting for BUD-2) is stopped, BUD-2 is paused (its own amendment,
`f7a50a57`), and R1H starts now. No R1H cell had run.

1. **Attempts: 2, not 3.** 16 tasks × 2 attempts × 3 arms = 96 cells: 64 on the lane (L, PC)
   and 32 on the cloud slot (C). Per comparison that's 32 pairs instead of 48. Only large
   pass-rate differences are detectable; the mechanism endpoints are paired per task and
   carry more power.
2. **Concurrency on the hub lane: 2 slots.**
   - The server is restarted as llama-server `--ctx-size 196608 --parallel 2` (script
     `C:\dev\bud-lane\start-server-r1h-np2.ps1`). Weights, flags and the DFlash draft are
     otherwise unchanged.
   - Verified before any cell: `/slots` reports 2 slots with `n_ctx` = **98304 each** (the
     same context per request as R1 and the original R1H design), `kv_unified = false`, and
     the DFlash draft loaded.
   - VRAM is 27,766 of 32,607 MiB, with 3,223 MiB idle before the server.
   - Two lane cells run at once, taken in plan order from one shared queue by slots `gpu`
     and `gpu2`. Each slot has its own meters: the local meter on 172.17.0.1:18381/18397
     (gpu) and 18383/18399 (gpu2), the cloud relay on 5110/5120 and 5112/5122. Each cell's
     traffic is therefore still its own. Each `cell.json` records its slot and `gpu_slots = 2`.
   - Concurrent requests share the GPU, so per-request speed is lower than with one slot.
     Both arms are affected the same way.
   - GPU-s per solved task counts each request's own prompt and generation time as
     llama-server reports it. Overlapping requests share the GPU, so it's a within-R1H
     relative figure.
3. **Everything else is unchanged:** build `d59e6c19`, arms L, C, PC (+ NEG in the smoke),
   tasks, 900 s cap, seeds, routing assertions, endpoints, the $8 cloud cap, and the rule
   that R1H is never pooled with R1.
4. The chain is replaced by `apparatus/r1h-chain-np2.sh`: the checksum check, smoke, Final,
   the full run, collect, commit and cleanup, without the wait for BUD-2.

## Final, 2026-11-02T15:47:32Z: smoke passed, before any measured `r1h-k` cell

Build `d59e6c198f91d1469198b0677c008323f82d0345`. Hub lane props in `lane-props.json`. Smoke, every arm + NEG on hello-world (`smoke-summary.txt`):

```
cell                               state        local_chat cloud_chat  usd     gpu_s  deleg               surface
r1h-s-c-hello-world                valid                 0          4 0.0004     0.0  -                   59338fa2ec97
r1h-s-l-hello-world                valid                 3          0 0.0000     1.6  -                   f611e5b3d308
r1h-s-neg-hello-world              misrouted             0          4 0.0003     0.0  -                   c5fe0d3f756d
r1h-s-pc-hello-world               valid                 5          7 0.0040     1.6  implementor         295412075ba5
smoke: PASS (arms seen: ['C', 'L', 'NEG', 'PC'])
```

## Amendment, 2026-11-02T17:21Z: lane outage from 16:11:10Z; endpoint-outage cells are apparatus; 23 cells re-run

**What happened.**
- At 2026-11-02T16:11:10Z, BUD-2's armed lane cleanup (`../bud2-2026-11/apparatus/cleanup-hub-lane.sh`)
  fired. It had a fallback that fires after 30 minutes with no `bud2-chain.sh` process, and
  BUD-2 had been paused at about 15:42Z. It stopped the shared hub llama-server and killed
  every `tunnel-hub.sh` loop and ssh forward on gx10, R1H's included. Evidence:
  - BUD-2's STATUS (`16:11:10Z CLEANUP hub llama-server stopped / tunnel closed`);
  - the hub server log ends at 16:11:08Z in the middle of normal work, with no error or crash;
  - R1H's `tunnel.log` shows no respawn, because the loop itself was killed.
- From then on, every local request from R1H got a 502 from its meter, whose upstream
  connection was refused. R1H's meters counted 407 of 646 and 462 of 702 requests as
  errors. The lane at `--parallel 2` was not at fault: no server error appears before
  16:11:08Z.

**Detected by the coordinator,** from cells that read `[apparatus_failure]` after
"Model API error: 502 Bad Gateway". R1H was stopped at about 17:16Z, finished cells kept.

**Fix:**
1. Both cleanups are scoped to their own run. BUD-2's fires only on its own `CHAIN DONE`
   (no idle fallback) and kills only `bud2-2026-11/…/tunnel-hub.sh`. R1H's cleanup kills only
   `r1h-2026-11/…/tunnel-hub.sh` and the lane's ssh forward. The tunnel is now launched by
   absolute path, so the scoped pattern matches it.
2. The lane was restarted unchanged (`--parallel 2`, 2 × 98304 ctx, DFlash draft; VRAM
   27,786 MiB).
3. Soak probe (`soak-2026-11-02.txt`): 50 requests, 2 at a time, ~3,000-token prompt,
   through a fresh meter and the tunnel. **50/50 HTTP 200, meter errors 0**, p50 0.43 s,
   p95 0.76 s.

**Rule, applied to every arm in `collect_r1h.py`:** a cell is `endpoint_outage` (apparatus,
reported, never scored) if gnomon's logs (gnomon-full.log and the terminal capture) record
an endpoint given up after its whole retry grace ("grace spent … giving up"). This covers
lane arms whose cloud coordinator carried on after its local sub-turns failed (PC), not
only cells that ended in `apparatus_failure`. A single 5xx that recovered within the grace
doesn't count.

**Cells moved to `runs-aborted/` and re-run on the fixed lane:**
- 23 cells: 12 L and 11 PC, all attempt 1, started or running after 16:11Z. 22 are
  endpoint_outage; `r1h-k1-pc-broken-python` had no tb verdict (apparatus).
- Also `r1h-k1-c-polyglot-c-py`, in flight when R1H was stopped.

No C cell had an outage: C never uses the lane. Finished cells (18) are kept. The re-runs
use the same build, arms, seeds and cap; only timing differs, which is recorded per cell.

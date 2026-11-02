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

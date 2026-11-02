# R2: does a declared plan → implement chain lift task completion? Pre-registration

Written 2026-11-02, before any R2 cell. The build under test is not known yet: it is
master after the hybrid-robustness merges, and the main session names it in
`BUILD-GO.txt`. The chain (`apparatus/r2-chain.sh`) appends a "Final" section, with that
SHA, the lane's properties and the smoke result, and commits it before the first
measured cell. Every later change is a timestamped amendment.

## Question

The user's question: can using a local and a cloud model together make gnomon solve
more tasks? R1H (`../r1h-2026-11/`) asks it with PC, a cloud coordinator that delegates
to a local implementor. R2 asks it with the cheapest hybrid gnomon can declare: a
two-stage chain in which the cloud plans once, read-only, and the local implementor
does the work with that plan in hand.

1. **CH vs L:** does one read-only cloud plan stage lift the local implementor? (tasks
   solved, paired). This is the one-variable contrast: CH's implementor is L's
   implementor, same model, tools and prompt; CH adds the plan stage in front of it.
2. **CH vs C:** does CH come near cloud-level task solving at a lower $ per solved task?
   (tasks solved, paired; $ per solved; cloud share)

PC runs alongside, unchanged from R1, as the hybrid R1H measures.

R2 is never pooled with R1H or R1. They ran a different build (R1's `d59e6c19`); R2 runs
the build in `BUILD-GO.txt`. A side-by-side table ("R1H says / R2 says") is allowed only
when it is clearly labelled as two runs.

## Arms

L, C and PC are R1's arm definitions unchanged. One profile, `r1.toml`, routes every
role. CH is new.

| Arm | coordinator | implementor | verifier | plan | implement | critique | smol | entry |
|---|---|---|---|---|---|---|---|---|
| **L** all local | local | local | local | local | local | local | local | `--role implementor` |
| **C** all cloud | cloud | cloud | cloud | cloud | cloud | cloud | cloud | `--role implementor` |
| **PC** cloud coordinator, local build | cloud | local | local | cloud | local | local | local | `--role coordinator` |
| **CH** chain: cloud plan, local build | local | local | local | **cloud** | local | local | local | no `--role`; `[chain] stages = ["plan", "implementor"]` |

- **local:** qwen3.6-35b on the hub lane. **cloud:** DeepSeek V4.1 Flash through OpenCode Go.
- **CH mechanics** (verified in gnomon source at `d59e6c19`, `prompt_loop.ts:4981` and 5085–5165, and with a two-endpoint fake-model run):
  - `gnomon task` without `--role` runs the declared chain headless. An explicit `--role` disables it, which is why L, C and PC never chain.
  - Each stage starts from the original request plus `The previous stage (plan) reported: …`: the plan stage's answer, not its transcript.
  - `[chain] gate` keeps the scaffold default, `never`, so the implementor stage always runs. The exception is gnomon stopping the chain because stage 1 ended on an apparatus code (10/12/13).
  - **The plan role gets read-only tools in CH:** `read, glob, grep, compute, todo, note`. The scaffold's plan role also has `task` and `bash`, and gnomon's system prompt tells every role to execute rather than plan and wait. With those tools, the "plan" stage would do the whole task on the cloud, and CH would be C with extra steps. The profile overrides the plan role's tool list in CH only.
  - The scaffold's implementor has no `task` tool, so neither L's nor CH's implementor delegates.
- **Excluded:**
  - **CH2** (the same chain with the plan stage local too). It would separate the effect of planning from the effect of cloud planning, but it costs about 32 more lane cells (~1.5 h of lane time). It needs its own pre-registration if CH shows a lift.
  - **LF** (local, with a cloud fallback on endpoint failure). It is a robustness arm, not a hybrid-planning arm, and it would also need its own registration.
- **No arm declares a fallback endpoint.** If the build under test declares one by default, the smoke stops the chain for an amendment (`r2-chain.sh` greps the smoke cells' profiles and configs). Routes never change silently.
- **Smoke control:** NEG is routed entirely to the cloud but asserted as L. It must come out `misrouted`, or the routing check detects nothing.

## Build

- **Commit:** the 40-hex SHA in `BUILD-GO.txt`, written by the main session once the hybrid-robustness PRs are on master. They add a fallback endpoint on persistent 5xx/timeouts, an idle timeout for streaming local generations, a context trim that respects the endpoint limit, and less coordinator re-delegation. The chain never guesses the SHA. It waits for the file.
- **Fetched by SHA in every cell** and recorded per cell (`gnomon-commit.txt`). A cell that ran any other commit is `wrong_commit`. `run_r2.py` refuses to start if the commit is not reachable on GitHub.
- **The robustness fixes are symmetric apparatus.** The idle timeout and context trim apply to every arm. The fallback is off in every arm (above).

## Lane: the hub's RTX 5090

The lane is the same one R1H uses after its np2 amendment:
- **Server:** llama.cpp b11739 CUDA, `C:\dev\bud-lane` on the hub, bound to 127.0.0.1:18380.
  - R2 starts it from its own copy, `start-server-r2.ps1`. That file is `start-server-r1h-np2.ps1` with only the comment and the log name changed (diffed on the hub when it was written).
  - Flags: `--ctx-size 196608 --parallel 2` (2 slots × 98,304 ctx), DFlash draft, `--reasoning off`.
- **Weights:** `Qwen3.6-35B-A3B-UD-Q4_K_S.gguf`, sha256 `2bee952b218e4a481430c59d8d3bdc7bae20bed0eb501326340c5fca7ae95d42`. Draft sha256 `107b7a433cbbdb4656a52b7845b35f6eed94eb0efb0019c8af7faed16d2d52f7`. Both are checked on the hub before R2 uses the lane.
- **Route from the gx10:**
  - an SSH forward to 127.0.0.1:18280 (`apparatus/tunnel-hub.sh`, launched by its absolute path);
  - metered per slot by `relay-meter-r2`: slot gpu on 172.17.0.1:18481 (counters 18497), slot gpu2 on 18483 (counters 18499);
  - the meters count requests, tokens, gpu_ms, 4xx, 5xx and connection errors.
- **Cloud meters:** relay-go on 5210/5212 (counters 5220/5222) for the lane slots, and 5211 (counters 5221) for the cloud slot.
- **Ports are R2's own.** They are distinct from R1 (18080/18099, 4910/4911/4920/4921, 18081), R1H (18381–18399, 5110–5122), P2G (4710–4712, 4810–4812) and 18195.
- **The chain records** the lane's `/props` and `/slots` at launch (`lane-props.json`, `lane-slots.json`). The slot count sets `R2_GPU_SLOTS`.
- **Not comparable with R1 (gx10 GPU) in absolute terms.** Only within-run contrasts count.

## Tasks, attempts, order, cap

- **Tasks:** R1's 16 tasks (`apparatus/sample16-hunch.txt`, non-empty, checked at start) × **2 attempts** × 4 arms = **128 cells**. 96 of them are on the lane (L, PC, CH) and 32 on the cloud slot (C).
- **Order:** within each attempt, tasks are shuffled with seed = attempt, and arms rotate per task. Attempts are barriers.
- **Concurrency:**
  - The lane arms share the two lane slots. They are not serialized, because the user's time window doesn't allow it. The rotation gives each lane arm the same contention.
  - C runs concurrently on the cloud slot. Its local endpoint is a trap meter (172.17.0.1:18482, counters 18498) with a closed upstream, so a misrouted C cell is counted and never reaches a GPU.
  - The gx10's docker host also serves R1 and P2G. Per-cell load is logged at START.
  - Wall times are therefore within-run contrasts only.
- **Cap:** 900 s through tb 0.2.18, which also scores runs that finish within tb's 300 s thread-join window. Cells at the cap are counted by tb's `agent_timeout`.
- **Cell ids:** `r2-k<k>-<arm>-<task>` (smoke `r2-s-<arm>-hello-world`), lower case, distinct from every other run's compose projects.

## Validity and routing

These are R1's rules (`apparatus/collect_r2.py`, derived from `collect_r1h.py`), plus CH and the endpoint-fault rule.

**A cell is valid when all of these hold:**
- tb returned a verdict;
- both meters read non-negative deltas;
- at least one chat request was metered;
- it ran the commit in its `cell.json`;
- it was not an endpoint fault;
- its traffic matches its arm.

**Routing per arm** (meters, and the `[chain]` stage lines from gnomon's log or tb's terminal):

| Arm | Valid routing |
|---|---|
| L | no cloud requests, local > 0 |
| C | no local requests, cloud > 0 |
| PC | cloud > 0, and local > 0 when it delegated |
| CH, both stages ran | cloud > 0 and local > 0 |
| CH, only stage 1 ran (cut at the cap, or stopped on an apparatus code) | cloud > 0 and local == 0. Valid: it is CH's own outcome, like any other arm's capped cell |
| CH, no stage line at all | `misrouted` (the chain never ran) |

- Any arm other than CH that shows a chain stage is `misrouted`.
- The setup prints CH's stage lines to the terminal as they happen. tb keeps the terminal for every task, so stage evidence survives on tasks that mount no agent-logs (`pandas-sql-query`) and in cells cut at the cap.

**Endpoint faults.** Pre-registered on the coordinator's instruction after R1H's 16:11Z outage, and symmetric across arms. A cell is `endpoint_fault` (apparatus, reported, never scored) when either holds:
- gnomon's run settled as `apparatus_failure` while an endpoint failed: a 5xx or connection error counted by either meter, or a model-API or connection error in gnomon's log; or
- whatever the bucket, gnomon's log shows its retry grace or budget spent on an endpoint (`grace spent … giving up`, `retry budget spent … giving up`). This is R1H's outage rule, kept.

A cell that saw 5xx but carried on (retried or recovered) and settled otherwise stays valid. Its 5xx count is reported per arm as **fault exposure**.

**Order of states:** apparatus (no verdict) → unmetered → no_model_call → wrong_commit → endpoint_fault → misrouted → valid. The buckets are reported per arm and sum to n.

**Lane guards** (`run_r2.py`):
- **Health probe:** before the smoke and before each attempt, 20 chat requests go straight at the lane, two at a time, each with a ~1,500-token prompt.
  - The probe must return 20/20.
  - On failure it is retried twice, 180 s apart. If it still fails, the run pauses (`LANE-UNHEALTHY.txt`) rather than starting cells.
- **Fault pause:** if 3 consecutive lane cells see endpoint errors on their local meter, no new cell starts (`LANE-FAULT-PAUSE.txt`).
- **Audit trail:** archived per cell (`agent-logs/audit`).

## Endpoints

**Primary.** Two exact two-sided McNemar tests on paired cells (same task, same attempt), Holm-adjusted over the two. The collector prints both raw and Holm p.
1. Tasks solved, **CH vs L**.
2. Tasks solved, **CH vs C**. It is reported together with $ per solved task (Go allowance), the paired sign test on per-cell $ and cloud tokens, and the cloud share of tokens.

**Mechanism metric:** in every valid CH cell, the plan stage ran on the cloud and handed a plan to the local implementor (stage lines plus meters). Reported with the plan stage's tokens, which are CH's cloud tokens, since only the plan role is routed to the cloud.

**Secondary:**
- PC vs L and PC vs C (R1H's question at R2's build), and CH vs PC;
- $ per solved, GPU-seconds per solved, and tokens per solved split local/cloud, for every arm;
- cloud share of tokens and of requests;
- median wall time and cells at the cap per arm. Compared with R1H's PC only as a separate run at a different build, never pooled;
- requests per cell, and delegation depth for PC;
- fault exposure per arm (cells with 5xx, total 5xx, endpoint faults);
- **noise floor:** each arm's share of tasks whose two valid attempts disagree.

**Power, stated now:** at most 32 pairs per comparison.
- Exact McNemar at α = 0.05 needs the discordant pairs split at least 6–0, 8–1, 10–2 or 12–3.
- At the ~15% between-attempt flip rate seen in earlier runs, only a difference of roughly 25 points or more is detectable.
- So a non-significant primary is "no difference shown", not "no difference". The cost and cloud-share contrasts are paired per cell and have more power.

## What counts as an answer

- **CH lifts a local model:** CH solves significantly more than L (Holm p < 0.05).
- **CH matches cloud for less:** CH is not significantly below C, and has a lower $ per solved and cloud share than C.
- **Anything else** is reported as measured, with direction and intervals. No arm is declared the winner on point estimates.

## Budget

- **Cap:** $6 of Go allowance for R2. Above it, no new cell starts and the run pauses (`BUDGET-PAUSE.txt`).
- **Expected:** about $2–3. In R1H so far, the mean cloud cost per cell is ~$0.042 for C and ~$0.027 for PC, which puts C at ~$1.35 and PC at ~$0.85 for 32 cells each. CH's plan stage is one read-only cloud turn per cell.
- **Shared key:** the Go key is shared. About $80 of the user's $100 November plan is committed.

## Chain (`apparatus/r2-chain.sh`, started with setsid nohup; progress in `STATUS.txt`)

1. **Gates**, polled every 2 min, up to 36 h:
   - (a) the hub lane was validated after the outage: a `LANE-OK*` marker in `../r1h-2026-11/`, or its soak file with `errors 0`;
   - (b) `BUILD-GO.txt` holds a 40-hex SHA;
   - (c) R1H has finished: its STATUS.txt's last CHAIN line is DONE, or the main session wrote `LANE-RELEASED.txt`. In addition, for 3 consecutive polls, no other lane user may be alive: no R1H or BUD-2 chain or runner, and no process outside r2-2026-11 whose environment points at the lane URL, which is how every run's relay meter gets its upstream.
2. **Lane:**
   - Verify both checksums on the hub.
   - If the lane does not answer, start R2's own tunnel (absolute path) and, if no bud-lane server is running, `start-server-r2.ps1`. Then wait up to 15 min for the model.
   - Record props and slots.
3. **Smoke:** L, C, PC, CH and NEG on hello-world, after the health probe.
   - Every arm must be valid and NEG misrouted.
   - CH must show both stages and a `[result]`.
   - No fallback may be declared.
   - Otherwise the chain stops: `SMOKE-FAILED.txt`, cleanup, DONE.
4. **Final:** append the Final section (SHA, lane, slots, smoke) to this file, commit it, push.
5. **Run:** the 128 cells; then collect into `summary.txt` and commit it with the runs.
6. **Cleanup**, only on the chain's own end paths, with no idle-timeout fallback, timer or trap:
   - Kill R2's own tunnel by its absolute-path pattern, and its ssh forward only if R2 started it.
   - Stop the hub server only if no other lane user is alive at that moment (the gate-c check). Otherwise leave it running and log that.
   - Nothing outside `r2-2026-11/` and `C:\dev\bud-lane\start-server-r2.ps1` / `server-r2.log` is touched.

The narrative `RESULT.md` is written by the main session from `summary.txt` after DONE.

## Differences from R1H, all decided before any R2 cell

- **Build:** BUILD-GO's SHA, not `d59e6c19`.
- **Arms:** adds CH. 2 attempts × 4 arms.
- **Cloud:** separate cloud slot ports.
- **Validity:** the endpoint-fault rule is pre-registered here. R1H added it by amendment, after its outage.
- **Instrumentation:** 5xx and connection-error counters in the lane meter, the lane health probe and the fault pause.
- **Lane ownership:** scoped cleanup, and no stopping of the shared server while another lane user lives. These are the lessons of the 16:11Z outage.

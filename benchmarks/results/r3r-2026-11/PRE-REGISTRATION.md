# R3R: does R1H's hybrid result hold on gnomon v0.4.0 as released? Pre-registration

**Status: COMMITTED 2026-11-03T16:38Z by the coordinating session after review**, written 2026-11-03 before any R3R cell. The coordinating
session reviews this file and commits it before launch. The chain then writes every gate result into `STATUS.txt` and
commits it, with the smoke, lane and wire-test files and `apparatus/`, **before the first measured cell**. It never
edits this file. Any later change is a timestamped amendment at the end.

**Name.** The coordinator asked for "R3" in `r3-2026-11/`. That directory already holds a different, committed R3
draft ("local first, cloud rescue", L/C/LR, commit `6c72482c`; never run, no apparatus). It is left untouched; this
run is **R3R** ("R3 on the release") in `r3r-2026-11/`, cell ids `r3r-…`. The two are never pooled. Every script
derives its paths from its own location, so the directory can be renamed before the first commit; the cell-id prefix
lives in `run_r3r.py` (`PREFIX`) and `collect_r3r.py` (`R3R_CELL`).

## Question

R1H (`../r1h-2026-11/`, build d59e6c19) measured three arms on the hub RTX 5090 lane: L (local only) solved 75%,
C (cloud only) 84%, PC (cloud plans, local builds) 87%, and PC cost **26% less per solved task** than C
($0.0341 vs $0.0458). gnomon **v0.4.0** was released today. Its `gnomon init` writes `[defaults] stream = true` and
`max_tokens = 32768`, and 101 commits separate it from d59e6c19.

**R3R asks:** with R1H's arms, tasks, lane, plan and validity rule, on the release **as shipped** (its init defaults;
`replay_reasoning` and `steer_role` left at release defaults), does the hybrid's cost saving against C hold, and do
the arms keep their quality order?

R3R tests the release as a whole. It cannot say which of v0.4.0's changes moved a number.

## Build

- gnomon **`be4fc0d8835c443aca8b32ccd4c1caacf48cbdce`**: tag `v0.4.0` (annotated tag object `1b52ac0c`), the merge of
  PR #125. On GitHub (checked by `gh api` before every runner start), fetched by SHA in every cell, recorded per cell
  (`agent-logs/gnomon-commit.txt`, `ARM_VERSION=`). A cell that ran anything else is `wrong_commit`.
- d59e6c19 is an ancestor of be4fc0d8; so is S1's 8078df03 (PR #120, `steer_role`).

## What v0.4.0 changes, per arm

Observed offline on the real builds before any data (`wiretest-r3r.txt`, part A: each build's own `gnomon init`,
then the setup's node block):

**The exact surface difference R1H → R3R is the same for every arm** (the arm's `profiles/r1.toml` is byte-identical
to R1H's; `roles.toml`, `policy.toml`, `system.md`, skills and the profile are unchanged):
- `config.toml [defaults]`: `+ stream = true`, `+ max_tokens = 32768` (and a comment on `max_context_tokens`, still
  65536);
- `config.toml [resilience]`: `+ stream_idle_timeout_ms = 300000`, `+ stream_total_timeout_ms = 1800000`;
- `tools.toml`, the `task` tool's description: R1H's "Run a sub-turn under another role, with its own context. It
  gets that role's tools." becomes the delegate-once wording ("Delegate a job once: give the complete plan …;
  delegate again only when its report shows a concrete failure …").

**R1H's edits all still apply to v0.4.0's init and do exactly what they did on d59e6c19's** (checked per arm):
`[endpoints.r1local]`/`[endpoints.r1cloud]` appended; `role_profile = "r1"`; the `[audit]` flip is a no-op on both
(init already writes `enabled = true`); the 14 `model`/`endpoint` lines leave `roles.toml`; the r1 profile routes each
role; `policy.toml` is left as init wrote it (it already has `[approval] gate = "on_write"`, answered by `--yes`).

**On the wire** (`wiretest-r3r.txt`, part B: v0.4.0 init → R3R's node block → the real `gnomon task`, against fake
servers, the local one behind the real meter):
- **Every arm:** every model request is streamed, asks for usage itself (`stream_options.include_usage`) and carries
  `max_tokens = 32768` (thinking included). Turn records carry `wire.stream`, `wire.max_tokens`; no `steer_role`
  (release default `system`, as R1H's build sent), no `replay_reasoning` (v0.4.0 replays by default only to
  `api.deepseek.com`; R3R's cloud URL is the relay, so no replay, as in R1H). A reply cut off by the limit is handled
  (`stop_reason: truncated`); a llama.cpp context overflow trims and continues; tampering with gnomon's records stops
  a turn (`tamper`); a stream silent 300 s is retried.
- **L:** local only, 2 requests, all streamed with the limit. On R1H's lane the template still drops late system
  messages (S1's finding): steering stays undelivered, as in R1H.
- **C:** cloud only. If OpenCode Go/DeepSeek refuses `max_tokens = 32768`, gnomon retries once in a shape it takes
  (`counters.output_limit_adapted`, a 4xx at the relay); reported, not an apparatus fault.
- **PC:** the coordinator's requests go to the cloud (each offers `task`), the delegated implementor sub-turn to the
  local endpoint (none offers `task`); the log carries the collector's `task implementor — N tool call(s)` line. The
  delegate-once wording reaches only PC: in L and C the entry role is the implementor, which has no `task` tool.
- **NEG:** cloud only, as C; the smoke must read it misrouted when asserted as L.

## Arms (R1H's, unchanged)

| Arm | coordinator | implementor | verifier | plan | implement | critique | smol | entry |
|---|---|---|---|---|---|---|---|---|
| **L** all local | local | local | local | local | local | local | local | implementor |
| **C** all cloud | cloud | cloud | cloud | cloud | cloud | cloud | cloud | implementor |
| **PC** plan in the cloud | cloud | local | local | cloud | local | local | local | coordinator |
| NEG (smoke control) | cloud ×7, asserted as L | | | | | | | implementor |

- **local:** `qwen3.6-35b`; **cloud:** DeepSeek V4.1 Flash through OpenCode Go (`deepseek-v4.1-flash`).
- One profile, `r1.toml`, routes every role (`apparatus/gnomon-setup-r3r.sh.j2`). The setup is R1H's
  `gnomon-setup-r1.sh.j2` with only an assertion added ahead of R1H's unchanged edits: init wrote `stream = true` and
  `max_tokens = 32768`, `config.toml` names neither `steer_role` nor `replay_reasoning`, and no role declares a
  fallback. On v0.4.0 it writes byte-identical files to R1H's block; it refuses d59e6c19's init (negative control).

## Lane: R1H's, untouched (as S1)

- llama.cpp **b11739** in `C:\dev\bud-lane` on the hub RTX 5090: `Qwen3.6-35B-A3B-UD-Q4_K_S.gguf` + DFlash draft,
  checked against R1H's sha256 (`2bee952b…`, `107b7a43…`) before the first start; `--ctx-size 196608 --parallel 2`
  (2 × 98,304), bound to the hub's 127.0.0.1:18380.
- **Start/stop:** R1H's `start-server-r1h-np2.ps1` (sha256 `ce69d7d0…`) and `STOP-ME.ps1` (`ec69465d…`), pinned (both
  re-read 2026-11-03, unchanged from S1's pins). STOP-ME runs only if this chain started the lane and the running
  bud-lane `llama-server.exe` is the pid it recorded. R3R adds a guard S1 lacks: with no lane of its own up, it never
  runs STOP-ME, whatever is running.
- **Props gate:** `/props` and `/slots` must match R1H's `lane-props.json`/`lane-slots.json` (build, model path and
  alias, template byte for byte and its caps, 2 slots × 98,304, speculative, every server-default sampling parameter).
  Any difference is fatal.
- **Route:** R3R's own SSH forward, `apparatus/tunnel-r3r.sh`, gx10 127.0.0.1:**18880** → hub 127.0.0.1:18380,
  launched in its own session and stopped by its process group only.

## Ports (R3R's own; checked free before anything starts)

| Slot | Arms | Local meter (relay-meter-s1) | Its counters | Cloud relay-go | Its counters |
|---|---|---|---|---|---|
| gpu | L, PC | 172.17.0.1:5510 | 127.0.0.1:5520 | 172.17.0.1:5511 | 127.0.0.1:5521 |
| gpu2 | L, PC | 172.17.0.1:5512 | 127.0.0.1:5522 | 172.17.0.1:5513 | 127.0.0.1:5523 |
| cloud | C, NEG | 172.17.0.1:5514 (trap: upstream closed) | 127.0.0.1:5524 | 172.17.0.1:5515 | 127.0.0.1:5525 |

None is used by another apparatus (S1 5410–5431, R1H 18381–18399/5110–5122, R2, the R3 draft's 18581–18599/5310–5323,
P2G 4710–4712/4810–4812, M1, the hub's and the gx10's services); `ss -ltn` showed them free on 2026-11-03.

## Tasks, plan, cap (R1H after its np2 amendment)

- R1H's 16 tasks (`apparatus/sample16-hunch.txt`, byte-identical) × **2 attempts** × 3 arms = **96 cells**: 64 on the
  lane (L, PC), 32 on the cloud slot (C).
- Within an attempt, tasks are shuffled with seed = attempt, and arms rotate per task: R1H's plan, cell for cell
  (`test_run_r3r.py` checks the cell set against R1H's runs). **Attempts are barriers.**
- **Concurrency:** two lane slots take L and PC cells from one shared queue in plan order; one cloud slot runs C cells,
  one at a time; up to 3 cells at once on the gx10's docker. As R1H.
- **Cap:** 900 s through tb 0.2.18 (tb's 300 s thread-join window included), as R1H.

## Scheduling: the hub is the user's gaming PC (S1 Amendment 1's spec, copied)

The implementation is S1's, copied from commit `76e6300d` and not imported: `s1-hubwatch.sh` and its tests are
byte-identical copies, and `r3r-chain.sh` is `s1-chain.sh` with R3R's names, runner and smoke. Behaviour is S1's:
0. **Wait for S1 first,** by the S1 chain's **pid** (`R3_WAIT_PID`, default 568292, S1's launch of 16:11Z, which
   ended at 16:27Z with no cell; a relaunched S1 has a new pid, which must be passed; `/proc/<pid>/cmdline` must
   contain `s1-chain.sh`). Never by a process name. S1's chain lock is read from `/proc/locks` (never taken): a wrong
   pid while an S1 chain runs, or a new S1 chain when the awaited one exits, is FATAL. S1 and R3R never share the GPU.
1. **Idle start.** The lane starts only after the hub GPU has been idle for **15 consecutive samples, 60 s apart**:
   memory used < 4,000 MiB, utilization < 15%, no `llama-server.exe`, WSL `m1-vllm` not running. An unreadable
   sample resets the count. Then a full check (also: nothing on the hub's 18380). Waits indefinitely, until the
   deadline.
2. **Yield.** While the lane runs, every 30 s: if GPU memory exceeds the lane's own **warm level** (measured right
   after a 2-slot warm-up; = desktop baseline + the lane's footprint) **by more than 1,500 MiB for 2 consecutive
   samples** (before the warm level is known: baseline + R1H's footprint 24,543 + 1,500), or our llama-server is
   gone, or another llama-server or `m1-vllm` appears: `YIELD-NOW` is written first, then the lane is stopped (our pid
   only). From that moment no cell starts; **every cell in flight, on any slot, is aborted** (tb's process group
   stopped, its compose project removed by exact label, the cell moved to `runs-aborted/<cell>-yield`) and re-run
   from scratch on resume; finished cells are kept. Then back to the idle wait; on resume the props gate and the
   warm-up run again. A footprint over R1H's + 1,500 MiB at warm-up is an anomaly (yield; twice is FATAL).
   Foreground-window detection is not attempted (ssh cannot see the desktop session), as in S1.
3. **New-cell deadline** `R3_DEADLINE`, default **2026-11-04T07:00:00Z**. No cell starts after it; unstarted cells are
   logged `NOT STARTED … (deadline)` and never imputed. Pairs are taken only where both arms ran.
4. **One R3R chain at a time** (`flock` on `.chain.lock` here). Commits take the M1/S1 chains' lock
   (`../m1-2026-11/.commit.lock`, opened for append) and add only R3R's paths.

## Apparatus differences from R1H (none touches a measured variable)

- **Local meter:** `relay-meter-s1.mjs` (S1's, byte-identical): usage parsed with `JSON.parse` (with llama.cpp's
  `timings` fallback), and **abort on client disconnect**, so llama-server stops generating for a client that left.
  R1H's `relay-meter-r1.mjs` parsed by regex and did not abort. Same counter names.
- **Cloud meter:** `relay-go.mjs`, byte-identical to R1H's. It has never metered gnomon's streams before;
  `test_relay_go_r3r.mjs` checks it on v0.4.0's shape against a loopback HTTPS upstream (usage and allowance from the
  final chunk, `include_usage` not injected, cached tokens, the key never echoed), and P2G's streamed arms show Go
  reports the allowance on streams (`responses_with_allowance` = `responses_with_usage` in every P2G arm).
- **Cloud tail settle (new).** relay-go does not abort upstream on disconnect, so a generation gnomon abandons (at the
  cap, say) is still billed and is read when it ends; R1H's runner closed a cell's books at once, so such a tail
  could land in the next cell on the slot (P2G's `responses_with_usage > chat_requests` in some arms is that leak).
  `run_r3r.py` waits up to 180 s after tb returns until the slot's relay-go has nothing in flight, and records
  `cloud_settle_s` and `cloud_inflight_at_end` per cell.
- **Runner** (`run_r3r.py`, R1H's runner plus S1's yield machinery, copied): `cell.json` written last marks a finished
  cell (a dir without it is moved to `runs-aborted/<cell>-incomplete` and re-run); yield and SIGTERM aborts; the
  deadline; R3R's own ledger.
- An aborted cell's cloud spend so far goes to the ledger, marked `aborted` (a floor).
- **Port check and runner failures (fixed after S1's first launch, 2026-11-03T16:27Z).** S1's full runner refused to
  start ("meter ports in use: 127.0.0.1:5421") seconds after its smoke runner exited, and S1's chain logged the exit 1
  as "arms finished" and ended with no cell. Reproduced offline: a relay killed with a connection open leaves a
  server-side TIME_WAIT on its port, and a bind test without `SO_REUSEADDR` reads it as in use for ~60 s, though node
  (which sets it) binds over it. R3R's port check binds with `SO_REUSEADDR` (a live listener still reads busy; both
  cases tested), waits up to 90 s for a port that is really held, and the chain treats a runner exit other than 0 or
  75 as a failure: retried twice, 60 s apart (finished cells are skipped), then FATAL; never as "finished".

## Validity (R1H's rule, unchanged)

`apparatus/collect_m1.py` is a byte-identical copy of M1's (hash pinned), whose `parse_cell` is R1H's
`collect_r1h.py` rule plus R1H's endpoint-outage amendment. It judges every R3R cell and every R1H cell alike:
- **valid** when tb returned a verdict, both meters read non-negative deltas, ≥ 1 chat request was metered, it ran the
  pinned commit, gnomon did not give up on an endpoint after its whole retry grace, and the traffic matches the arm;
- **routing:** L: cloud = 0 and local > 0; C: local = 0 and cloud > 0; PC: cloud > 0, and local > 0 if it delegated;
- anything else (`apparatus`, `unmetered`, `endpoint_outage`, `no_model_call`, `wrong_commit`, `misrouted`) is
  apparatus: reported, never scored. **Buckets are asserted to sum to n per arm.** Yield- and operator-aborted cells
  are not cells of the run: they are re-run, and kept in `runs-aborted/` as evidence.
- `collect_r3r.py --r1h` reproduces R1H's published summary from R1H's own cells (24/32, 27/32, 26/30;
  $0.0458 vs $0.0341); the preflight requires it.

## Pre-data gates, in order (each result goes into STATUS)

1. **S1 has exited** (above). 2. **Offline tests,** once, before the idle wait (they need no hub): S1's hubwatch
tests, `test_run_r3r.py`, `test_chain_glue_r3r.sh`, `test_collect_r3r.py`. 3. **Hub inputs:** the scripts' hashes as pinned, the weights' checksums R1H's; the hub's
current server log kept (`lane-before-r3r-server.log.gz`). 4. **Lane up,** then the **props gate**, warm-up and the
footprint check. 5. **Smoke:** L, C, PC and NEG on hello-world (`run_r3r.py smoke`), judged by `collect_r3r.py --smoke`:
- L, C and PC **valid and solved**; **NEG misrouted** (or the routing check detects nothing);
- every cell ran be4fc0d8; its surface's `[defaults]` carries `stream = true` and `max_tokens = 32768` and no
  `steer_role`/`replay_reasoning`;
- every local request streamed with `max_tokens`; every cloud request asked for usage itself and every cloud response
  carried it;
- PC's delegation is noted (the local route is covered by the wire test).

One retry (fix-don't-fail); a second failure means R3R is not run. A yield during the smoke re-runs it on the next
start. 6. **Commit before data:** STATUS, this file, the wire test, smoke, lane props/slots/models, the start log,
the saved server log, `apparatus/`.

## Endpoints (`apparatus/collect_r3r.py`), declared now

**PRIMARY: the hybrid's cost saving against C.** S = 1 − ($/solved PC) / ($/solved C), where $/solved is the arm's
Go allowance over its valid cells divided by its solved valid cells (R1H's definition; R1H: S = 25.7%).
- **95% CI:** a paired bootstrap over tasks: both arms resample the same 16 tasks with replacement, both attempts of a
  sampled task come along; B = 10,000, seed 20261103, percentile interval. Resamples where an arm solved nothing are
  skipped and counted.
- **Reading, decided now:** lower bound > 0 → "saving shown on v0.4.0"; S > 0 with the CI including 0 → "direction
  holds, not shown"; S ≤ 0 → "not reproduced".
- **Stated now, so it cannot be discovered later:** the same bootstrap on R1H's own cells gives S = 25.7%, 95% CI
  **[−25.6%, 47.7%]**. R1H's saving was itself not shown. At this n, "direction holds, not shown" is the likely
  outcome even if nothing changed. A CI excluding 0 needs a larger or more consistent saving than R1H's.
- **Sensitivity:** the same S on (task, attempt) pairs valid in both PC and C; R1H's per-cell sign tests of $ and
  cloud tokens, PC vs C.

**QUALITY, directional only.** Pass rates with Wilson 95% intervals; differences PC − C, PC − L, C − L with the same
task bootstrap; exact two-sided McNemar on (task, attempt) pairs valid in both. Power: at most 32 pairs, a measured
self-flip rate of about 15%, so differences under roughly 15–20 points are not detectable. A non-significant
difference is "no difference shown". **No composite verdict:** cost and quality are read separately, and no arm is
declared a winner on point estimates.

**Secondary, descriptive:**
- per arm: $/solved; cloud tokens per solved, split cached / uncached input / output; local tokens per solved; median
  agent wall and cell wall; capped cells; delegating cells; non-valid buckets;
- how turns end (the last turn record's `stop_reason`), gnomon's own `unmetered_calls` and `output_limit_adapted`,
  the meter's `client_aborts`, cells still in flight after the settle;
- the ledger total, aborted entries included.

**R3R vs R1H, per arm: descriptive only.** Exact McNemar on matching (task, attempt) and the same table, labelled as
two runs: time-separated (R1H ran 2026-11-02/03), the build changed (d59e6c19 → v0.4.0), and the local meter changed.
Never pooled. If R3R's S differs from R1H's, R3R cannot say which change did it.

## Budget

- **Cap: $6.00 of Go allowance**, R3R's own ledger (`spend.jsonl`; smoke, aborted cells and tails included). Above it
  no new cell starts and the run pauses (`BUDGET-PAUSE.txt`).
- **Expected:** about $2–3. R1H's C spent $1.24 over 27 solved and PC $0.89 over 26. v0.4.0's output limit may lower
  output, and streaming ends the 300 s cut-and-resend P2G billed.
- The key is shared with P2G (running at writing); R3R's ledger counts only its own cells.

## Expected wall time

R1H's cells, per attempt, took max(lane/2 slots, cloud slot) ≈ 2.2 h + 1.75 h ≈ **4 h**; the cloud slot (C, one at a
time) is the critical path in attempt 1. Add ~30 min for the idle wait, lane start, warm-up, offline tests and smoke:
**≈ 4.5 h after S1 exits, without yields.** Each yield costs the in-flight cells plus ≥ 15 min of idle wait and a
restart. To finish before the 07:00Z deadline R3R must start by about 02:30Z; otherwise attempt 2 is cut, and only
pairs where both arms ran are read.

## Cleanup and scope

The chain starts and stops only R1H's lane (via R1H's scripts, under the pid rule and R3R's guard), its own tunnel (by
process group), its own runner and relays, and the compose projects of its own cells (by exact label). Cleanup runs
only when the chain exits; there is no idle fallback and no `pkill` by pattern. Nothing outside `r3r-2026-11/` is
written: R1H's, S1's and M1's files are read; S1's chain lock is read from `/proc/locks`; M1's commit lock is opened
for append.

## Files

- `apparatus/r3r-chain.sh` (the chain; `DRY=1` read-only), `apparatus/run_r3r.py` (`plan`, `smoke`, `full`,
  `abort-inflight`), `apparatus/collect_r3r.py` (`--smoke`, `--r1h`, `--no-write`).
- `apparatus/gnomon-setup-r3r.sh.j2`, `apparatus/peer_agents_r3r.py`, `apparatus/tunnel-r3r.sh`,
  `apparatus/preflight_r3r.sh`.
- Tests: `test_run_r3r.py` (runner: yield, SIGTERM, resume, barriers, settle, deadline, budget, plan, ports),
  `test_chain_glue_r3r.sh` (S1's glue test + the S1 wait, the lock probe, the stop guard), `test_relay_go_r3r.mjs`,
  `test_collect_r3r.py` (the smoke gate on R1H's real smoke cells), `wiretest_r3r.mjs` → `../wiretest-r3r.txt`.
- Byte-identical copies: from R1H: `peer_agents_r1.py`, `gnomon_agent.py`, `relay-go.mjs`, `sample16-hunch.txt`; from
  S1 (76e6300d): `relay-meter-s1.mjs`, `test_relay_s1.mjs`, `s1-hubwatch.sh`, `test_hubwatch_s1.sh`; from M1:
  `collect_m1.py`.

Launch (after this file is committed): `cd apparatus && setsid nohup env R3_WAIT_PID=<S1 chain pid> ./r3r-chain.sh
>> ../chain-r3r.log 2>&1 < /dev/null &`


## Addendum (2026-11-04T09:12:26Z): gaming-safe idle threshold for this desktop (scheduling only)

- **What changed:** the RTX chains start with `IDLE_MEM_MAX=6500` (MiB) instead of S1 Amendment 1's default 4000.
  - Between 06:05 and 08:38Z the hub's idle desktop used 4,094–4,848 MiB of VRAM with no llama-server and ~0% utilization.
  - So the idle wait read 0/15 for 2.5 h while the GPU was idle.
  - Unchanged: utilization < 15%, no llama-server and m1-vllm, 15 consecutive samples, and the yield rule (warm level + 1,500 MiB for 2 samples).
- **Test:** `test_hubwatch_s1.sh` line 46 now tests the strict bound at the bound in force (`$IDLE_MEM_MAX`) instead of a literal 4000.
  - At 4000 it is the same case, byte for byte in effect.
  - The R3R and M2 copies are identical, sha256 9c31e271…; the pins in `preflight_r3r.sh` and `preflight_m2.sh` are updated to it.
  - S1's own copy, in a completed study, is left untouched. R3R's preflight no longer compares this one file with S1's: the hash pin fixes its content instead.
- **Correction:** the 09:10Z commit 1d0e36b7 is titled "R3R complete", and `summary-r3r.txt` holds a collection over 4 of 96 cells.
  - What happened: the runner's preflight failed 3 times on the operator's first, unpinned edit of that test (09:07–09:10Z).
  - No cell ran in that window and no spend was made.
  - That summary is NOT a result, and is superseded by the collection at R3R's real completion.
- No measured variable, task, arm, build (v0.4.0, be4fc0d8) or analysis rule changes.

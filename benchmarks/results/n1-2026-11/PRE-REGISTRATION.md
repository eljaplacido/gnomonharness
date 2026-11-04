# N1: does gnomon's idle nudge help when it reaches the model? Nudge on vs off, paired, on the gx10 qwen3.6 lane (pre-registration)

**Status: written and committed 2026-11-04 (≈21:30Z) by the preparing session, before any N1 cell. Not launched.** The
coordinating session launches it with the command at the end. The chain writes every gate result into `STATUS.txt` and
commits it, with the smoke, the delivery gate and the lane records, **before the first measured cell**, and commits the
interim look before stage 2. It never edits this file. Any later change is a timestamped amendment at the end.

Modelled on S1 (`../s1-2026-11/PRE-REGISTRATION.md`, Amendment 3): the same lane, tasks, cap, validity rule and meter.

## Why

- **The idle nudge.** When `[turn] nudge_after_idle` (12) tool calls pass without a file change, gnomon injects "You have
  run N tool calls without changing a file… act on it now", and re-fires it every 12 idle calls.
- **S1** (`../s1-2026-11/`, this lane) randomized only the *delivery* of all of gnomon's steering:
  - with `steer_role = "system"` the Unsloth qwen3.6 template silently drops it;
  - with `steer_role = "user"` it arrives as a `[gnomon]` note.
  - Result: 19/30 (dropped) vs 16/31 (delivered); paired 19 vs 15, discordant 4–0 for dropped, exact McNemar p = 0.125.
    Most of what was delivered was the idle nudge (meter: 599 of 602 note-carrying requests carried a nudge).
- **PR #140's stall detectors** (`stall_signals.ts`, log-only in v0.4.1): the idle nudge fires in about half of the runs
  that succeed anyway.
- **The causal analysis** (`../causal-2026-11/REPORT.md`, "N, the idle nudge") estimates delivered vs dropped at
  **−0.12 [−0.37, +0.13]** on solved, the only exogenous variation available, and sizes the D-N decision ("stop delivering
  the idle nudge") as an experiment. causal-decision's paired sizing (causal platform PR #107) puts a 10-point test at
  about 110 task pairs.
- **What S1 could not separate.** S1 moved every kind of steering together (and moved the template's "last query"). N1
  holds the delivery channel fixed (`steer_role = "user"` in both arms) and switches only the idle nudge.

**N1 asks:** on the v0.4.1 release, this lane and these tasks, with steering delivered as user notes, does turning the
idle nudge off change how many tasks gnomon solves, and what it costs in calls and wall time?

## Build (both arms)

- **gnomon v0.4.1, the release as a user installs it**: tag v0.4.1 = `c511b8105fb2187423d21becbe3b19f8af2b80e5`
  (the current release; the benchmark arms use the current build).
- **Installed in every cell from the four release tarballs, pinned three ways** (`apparatus/gnomon-setup-n1.sh.j2`, as
  P2G41's `gnomon_harbor_v041.py` pins them):
  1. `SHA256SUMS` must hash to `923adc6fb249f65ea998bccb8351e1a806138a8fe015319cefc0a0d429b4f459`;
  2. each of `gnomon-{core,natives,tui,harness}-0.4.1.tgz` must match `SHA256SUMS`;
  3. the installed `gnomon-core` must carry `gnomonBuild = v0.4.1-c511b81`, and `gnomon --version` must print
     `gnomon/0.4.1+v0.4.1-c511b81`.

  Any mismatch stops the install, and the cell is then apparatus (no model call), never scored.
- **Recorded per cell:** `agent-logs/gnomon-commit.txt` (the tag commit, then the version, the SUMS hash and the harness
  tarball's hash), the pane's `ARM_VERSION=`, and `cell.json`'s `sha`, `release`, `release_build`, `release_sums_sha256`.
- **Checked before launch:**
  - the runner re-downloads `SHA256SUMS` and refuses to start if it no longer hashes as pinned
    (`install_release_n1.sh --check-sums`);
  - checked at preparation (2026-11-04T21:18Z): pinned.

## Arms (L routing only)

| Arm | Cells | `[endpoints.r1local]` | `[turn] nudge_after_idle` |
|---|---|---|---|
| **N1** (nudge delivered) | `n1-n1-k<k>-l-<task>` | `steer_role = "user"` | `12` (v0.4.1 init's own line, unchanged) |
| **N0** (no nudge) | `n1-n0-k<k>-l-<task>` | `steer_role = "user"` | `100000` |

- **N1 is S1's arm S1 configuration** (`steer_role = "user"` on r1local, L routing, profile r1, roles.toml's model and
  endpoint lines removed, audit on, approval answered by `--yes`, `--trust`), on v0.4.1.
- **One line apart.** The setup's node block runs on v0.4.1's own `gnomon init` output. It asserts that init wrote
  `nudge_after_idle = 12` exactly once, in `[turn]`; N0 rewrites that value, and the surface must then carry the arm's
  value exactly once.
  - Both arms reach the **same** meter (they never run at the same time), so the surfaces differ by that line only.
  - `preflight_n1.sh` asserts this on the recorded v0.4.1 init (`apparatus/init-v041/`).
  - `wiretest-n1.txt` asserts it on the real release.
- **The wire, observed offline before any data** (`wiretest-n1.txt`). The real v0.4.1 release, installed from the pinned
  tarballs, ran the real `gnomon init`, the setup's own node block and `gnomon task`, through `relay-meter-s1`, against a
  fake llama-style server answering 15 non-writing bash calls:
  - **N1:** the nudge fired once at step 12 and went out as a `[gnomon]` user note in 4 of 16 requests.
    `counters.model_calls.steered_calls = {nudge: 4}`, every nudge-carrying call `via: "user"`.
  - **N0:** no nudge, no note, `steered_calls.nudge = 0`.
  - **Both:** `wire.steer_role = "user"`, no system message after the first, no convergence push, no refusal learned.
  - **With the nudge notes taken out of N1's requests, the two arms sent identical request bodies, request for
    request.**

### What the nudge changes, counted as the treatment (stated now)

1. **The message itself**, as a `[gnomon]` user note (≈430 characters), re-fired every 12 idle calls and re-sent with
   the history until a compaction drops it.
2. **The blank-reply counter is reset when a nudge fires** (`consecutiveEmpty = 0`, prompt_loop.ts). A blank reply after
   a nudge gets a fresh re-ask budget; in N0 only real work resets it.
3. **The template's "last query" moves to the note** (as in S1). The assistant turns before it render without the empty
   `<think></think>` block.
4. **Extra prompt tokens** for every request that re-sends a note.

**Not changed by the line**:
- the `stall_repeats` stop and the A-B-A-B cycling stop (they read `callsSinceWrite`, not the nudge);
- the log-only stall signals;
- the step budget (implementor 32 × 8 legs = 256 calls);
- leg compaction.

### The convergence push and the other steering: delivered through `steer_role` too, held identical

- **The convergence push is delivered the same way.** It is a `role: "system"` message that `steerAsUser` turns into a
  `[gnomon]` note, exactly like the nudge, so it could confound if it differed between the arms. It does not:
  - both arms declare the same `steer_role = "user"`, `converge_refire = 6` and `read_only_converge_after = 0.6`;
  - the entry role, implementor, declares no `converge_after` and holds write/edit/bash, so `convergeAt = Infinity`;
  - it has no `task` tool, so there is no read-only sub-turn either.

  The push is therefore expected **never** to fire in either arm (S1: converge 0 in all 62 cells; the wire test: 0).
  The meter counts it per arm (`steer_converge_note`); if it appears, it is reported, and it is the same configuration
  in both arms.
- **The other steering is the same in both arms.** The tool-less wrap-up, a failed declared verification and
  context-drop notices go out as `[gnomon]` notes in both, are counted per kind, and are reported.

## Lane: the gx10's `llama-server-qwen-q4.service`, R1's and S1's, untouched

- **Server.** 127.0.0.1:18080, llama.cpp b1281-571d0d54:
  - weights: Qwen3.6-35B-A3B-UD-Q4_K_S (sha256 `2bee952b…`) + DFlash draft (`107b7a43…`);
  - the Unsloth qwen3.6 template, byte-identical to R1H's;
  - flags: `--parallel 1 --ctx-size 98304`, q8_0 KV, `--reasoning off`.
- **The chain never starts, stops, restarts or signals the service.** It reads it (`systemctl --user cat/show`,
  GET `/props`, `/slots`, `/v1/models`) and sends it requests only through N1's meter.
- **Before any cell, the lane must equal S1's references** (`lane-gx10-ref-*`, byte-identical copies of S1's, recorded
  2026-11-03 and matched again by M2's gx10 chain):
  - build, model file, alias, template and caps;
  - 1 slot × 98,304, speculative;
  - every server default;
  - the unit text and its flags.

  Any difference is FATAL. The checksums of the weights are checked too.
- **Checked at preparation (2026-11-04T21:18Z, read-only GETs):** the lane matched the references; the unit is active
  (MainPID 2359135), the slot idle. The gx10 `gpu.lock` is free. M2's gx10 chain ended `DONE` at 18:38:06Z.
- **gpu.lock.** The chain holds `~/.opencode/central-brain/runtime/decisionbench/gpu.lock` for its whole run, as R1, S1
  and M2 did, so other gx10 GPU benchmarks wait. Its children do not inherit the lock's file descriptor.
- **Delivery gate (render-only, before any cell).** S1's `probe_s1.py` renders its histories through the lane's
  `/apply-template`, which renders and never generates. The marker of a late system message must be absent, and the
  marker of the same message as a `[gnomon]` user note (cases A–C) must be present: the lane renders N1's nudge. The
  shapes are S1's (made by 8078df03's `steerAsUser`). `steerAsUser`, `STEER_PREFIX` and `STEER_CLOSE` are byte-identical
  at v0.4.1: the function text hashes to `36840e8a…` at both commits.

**Ports.**

| What | Listens | Upstream | Counters |
|---|---|---|---|
| local meter (`relay-meter-s1.mjs`), both arms | 172.17.0.1:**5810** | http://127.0.0.1:18080 | 127.0.0.1:**5820** |
| cloud sink (`relay-meter-s1.mjs`) | 172.17.0.1:**5811** | http://127.0.0.1:9 (nothing listens) | 127.0.0.1:**5821** |

- No other apparatus uses these. Before start, the runner checks that they have no listener (S1 Amendment 2's
  `SO_REUSEADDR` rule, a 120 s wait), and that nothing listens on 127.0.0.1:9.
- P2G41's relays 4710–4712 and 4720–4722 are untouched, as are 4710–4729, 4810–4812, 5710–5725, 8030, 18195, 4890,
  :18580, :18880, :18980 and the hub.
- **The cloud sink.** S1's r1cloud endpoint pointed at a paid relay-go. N1 points it at a meter whose upstream refuses, so
  a misrouted request is counted and refused, never paid for. Any request reaching it makes that cell `misrouted` and
  pauses the run (`MISROUTE-PAUSE.txt`, then FATAL).

## Tasks, pairs and order

- **Tasks:** S1's and R1's 16 (`apparatus/sample16-hunch.txt`, byte-identical to S1's, which is R1H's).
- **Arithmetic:** 110 pairs ÷ 16 tasks = 6.9, so **k = 7 attempts per task: 16 × 7 = 112 pairs = 224 cells.**
- **A pair** is one (task, attempt): the N1 cell and the N0 cell, **run back to back, one cell at a time** on the one
  slot (concurrency 1), so the two share the time window and the host load.
- **Order.**
  - Attempts run in order, as barriers.
  - Within attempt k the tasks run in `random.Random(k).shuffle` order, S1's and R1's seed rule. Attempts 1–2 are S1's
    orders; the test checks attempt 1 against the order S1 actually ran.
- **Which arm goes first is fixed now** (`run_n1.first_arm`): N1 when (the task's alphabetical index + k) is even.
  - Every attempt has exactly 8 N1-first pairs, and each task alternates from attempt to attempt.
  - This balances the carry-over between a pair's two cells: llama.cpp's prompt cache of the shared system prompt, warm
    docker images, and a slower second cell when P2G41's load rises.
- **Kept from S1:** the 900 s cap (`--global-agent-timeout-sec 900`), tb 0.2.18 and its flags (`--n-concurrent 1`,
  `--no-cleanup`), and L routing (every role local, entry implementor).
- **Expected wall time.** On this lane, one cell at a time:
  - R1's L arm averaged 446 s a cell, M2's q36g L arm (v0.4.0) 374 s, and S1 (two arms sharing the slot) 473 s;
  - at ~420 s, the 224 cells take ≈ 26 h and stage 1 (128 cells) ≈ 15 h;
  - launched around 21:30Z on 11-04: the interim look around 12:30Z on 11-05, the end around 23:30Z on 11-05, which
    leaves ≈ 7 h before the deadline.

## Order, deadline and stages (`apparatus/n1-chain.sh`)

1. **Offline tests**, before anything else; any failure is FATAL.
2. **The gx10 `gpu.lock`** (wait while another benchmark holds it).
3. **Lane checks:** the lane equals S1's references, the weights' checksums match, the ports are free, the sink refuses,
   and the release is still as pinned.
4. **Delivery gate** (render-only). It must pass.
5. **Smoke, first time only:** hello-world, N1 then N0, on this lane. Both cells must:
   - be valid and solved, and record the v0.4.1 tag commit;
   - carry their surface lines exactly once (`steer_role` user; 12 or 100000);
   - show `wire.steer_role = "user"` on every turn record and a `counters.model_calls` record;
   - have `steer_role_adapted` = 0, no late system message, no meter error and no cloud-sink request.

   N0 must also send no nudge (the negative control). Hello-world rarely idles 12 calls, so the smoke may not exercise
   the nudge; `wiretest-n1.txt` covers it. One retry is allowed; a second failure means N1 is not run.
6. **Commit before data:** this file, STATUS, the gate and smoke files, the lane records, `wiretest-n1.txt` and
   `apparatus/`.
7. **Stage 1:** attempts 1–4, 64 pairs.
8. **The interim look** (`collect_n1.py --interim` → `INTERIM.txt`), committed.
9. **Stage 2:** attempts 5–7, 48 pairs, **only if the interim says `continue`**.
10. **Collect** (`summary-n1.txt`), commit, `DONE`.

- **New-pair deadline:** `N1_DEADLINE`, default **2026-11-06T07:00:00Z**.
  - No pair starts after it.
  - The second cell of a pair already started still runs, so the clock never makes a half pair; that is at most one cell
    past the deadline.
  - Pairs not started are logged `NOT STARTED … (deadline)` and never imputed.
- **One N1 chain at a time** (`flock` on `.chain.lock`). Commits take the shared lock
  `../m1-2026-11/.commit.lock`, opened for append, and add only N1's paths.
- **Failures.** A runner failure is retried once after 60 s (finished cells are skipped). A second failure, a lane that
  stops answering for 10 min or comes back different, or a metered cloud request is **FATAL**. A FATAL exit commits
  nothing and is not `DONE`.
- **Interruptions.** A cell in flight when the runner is stopped is moved to `runs-aborted/<cell>-operator`. A cell
  directory without `cell.json` is moved to `runs-aborted/<cell>-incomplete`. Either is re-run from scratch on resume,
  and never scored.

## Validity (M1's = R1H's = S1's, unchanged)

- **One function for every cell:** `apparatus/collect_m1.py`, a byte-identical copy of M1's (sha256 `3e856dbf…`, checked
  by the preflight), `parse_cell`.
- **A cell is valid when:**
  - tb returned a verdict;
  - both meters read non-negative deltas;
  - at least one chat request was metered;
  - it ran the build its `cell.json` names (the v0.4.1 tag commit);
  - gnomon did not give up on an endpoint after its whole retry grace;
  - L routing held: cloud (sink) = 0 and local > 0.
- **Every other state is apparatus:** reported, never scored, and never re-run once finished. That includes a cell where
  tb made no output directory (recorded `tb_no_dir`, state `missing`). Buckets are asserted to sum to n per arm.
- **A pair counts** when both of its cells are valid.

## Endpoints, declared now (`apparatus/collect_n1.py`)

**Primary (score):** solved, by **exact two-sided McNemar** on (task, attempt) pairs valid in both arms, under the
sequential rule below. Reported with the paired difference N1 − N0 and an Agresti–Min 95% interval.

**Secondary (paired, descriptive, the same pairs):**
- **capped** at 900 s (exact McNemar);
- **model calls per cell**: the meter's chat requests, which every cell has, capped ones included;
- **tool calls per cell**: the turn record's `tool_steps`, where both cells have one;
- **agent wall time**;
- **local tokens per cell**.

Each is reported as paired medians, the paired median difference and a sign test.

**Mechanism (resolvable):** from the meter (outside view) and gnomon's own records.
- **N1:** requests carrying a `[gnomon]` nudge note > 0. `counters.nudges` and `counters.model_calls.steered_calls.nudge`
  agree, and the nudge-carrying calls go `via: "user"`.
- **N0, the negative control:** **zero** nudge notes on the wire in every cell, `counters.nudges = 0` and
  `steered_calls.nudge = 0`.
- **Both:**
  - no system message after the first, and `steer_role_adapted = 0`;
  - the surface lines as declared, every cell on 127.0.0.1:18080, and cloud-sink requests = 0;
  - convergence pushes counted per arm (expected 0 in both).

If any of these fails, that is an apparatus finding, and the score comparison is not read as a test of the nudge until
it is explained.

**How turns end:** the last turn record's `stop_reason` per arm (all valid, valid unsolved).

**Descriptive only:**
- v0.4.1's log-only stall signals per arm;
- the discordant pairs, with each side's stop reason, nudge count and first-nudge step;
- the pairs whose N1 cell was nudged. This conditions on N1's own trajectory, so it is not causal.

## The sequential rule (stated now; constants and tests in `collect_n1.py` / `test_collect_n1.py`)

- **Looks.** One interim, when stage 1 (attempts 1–4, **64 planned pairs**) has finished. The final, after stage 2
  (**112 planned pairs**) or at the deadline.
  - The coordinator suggested about 55 pairs. The interim sits on the attempt boundary at 64 so that every task is
    equally represented at the look.
- **Efficacy, either direction (help or harm).**
  - Lan-DeMets O'Brien-Fleming-type spending at the **planned** information fraction t = 64/112 = 0.571:
    α(t) = 2 − 2Φ(z₀.₉₇₅/√t) = 0.00952, fixed at **α₁ = 0.0095**.
  - **Interim:** stop for efficacy if the exact McNemar p ≤ 0.0095 (for example 11–1 or 9–0 discordant pairs).
  - **Final:** **α₂ = 0.05 − 0.0095 = 0.0405**. This is a union bound: the familywise type-I error is ≤ 0.05 whatever the
    correlation between the looks and the realized number of pairs, and α₁ is not recomputed from the realized pairs.
  - If stage 1 is cut by the deadline there is no interim, and the single look uses **α = 0.05**.
- **Futility, non-binding** (type-I error is computed without it): at the interim, stop if the **conditional power
  under the current trend < 0.10**.
  - The trend is the observed discordance ψ̂ = (b + c)/pairs and the split b/(b + c).
  - The remaining pairs are 48 × (valid pairs/64).
  - The power is computed exactly by binomial sums, for the final exact McNemar at α₂, in either direction.
  - For example: 4–4, 5–3 and 6–3 stop; 7–2 and 10–4 continue.
- **What the chain does.** It applies the rule automatically: `continue` runs stage 2; `stop-efficacy` and
  `stop-futility` end the run. Nobody looks at the data in between.
- **Companion, never the decision.** evidence.py's anytime-valid hedged e-process (`analysis/st-upgrade` 53bfc9c4,
  Waudby-Smith & Ramdas predictable plug-in, c = 0.5). It runs on the discordant pairs in the order their later cell
  finished, and is reported at each look with whether it crossed 20. The pure-python port equals evidence.py's own output
  to 1e-8 on two recorded sequences (test).

## Decision (what counts as an answer)

- **"The nudge helps":** N1 solves significantly more than N0 at the look where it is tested.
  - This supports keeping the idle nudge on (12) where steering is delivered, and argues against D-N on this lane.
- **"The nudge hurts":** N0 solves significantly more.
  - This supports D-N here: gate or remove the idle nudge for delivered-steering lanes such as local qwen3.6 with
    `steer_role = "user"`.
  - It also explains part of S1's 4–0.
- **Anything else is "no difference shown"** (including a futility stop). It is reported with the direction, the paired
  difference and its interval.
  - It is not "no effect": see the MDE.
  - The secondaries (calls, wall time, tokens) then say what the nudge costs or saves.
- **Scope of the answer.** Local qwen3.6 with reasoning off, `steer_role = "user"`, v0.4.1, these 16 tasks. Hosted lanes
  deliver nudges as system messages and are not covered.
- **This informs, and does not decide alone:**
  - the D-N lever;
  - whether `nudge_after_idle` should default differently where steering is delivered;
  - the `steer_role` default.
- **A mechanism win with no score movement is an honest partial result, declared here in advance:** N1 notes > 0, N0
  notes = 0, and no score difference.

## MDE, power and limitations, stated now

- **Assumed discordance ψ ≈ 0.14.** S1's discordance was 4/30 = 0.133, and the measured self-flip rate between attempts
  is ~15%.
- **Fixed-n paired sizing** (Connor) for Δ = 0.10, 80%, α 0.05: n = (z₀.₉₇₅√ψ + z₀.₈√(ψ − Δ²))²/Δ²:

  | ψ | n |
  |---|---|
  | 0.133 | 102 |
  | 0.14 | 108 |
  | 0.20 | 155 |

  The 0.14 row is consistent with causal-decision's ≈ 110.
- **This design**, computed exactly with the pre-registered rule, 64 + 48 pairs:

  | ψ | Δ | P(efficacy stop at interim) | P(futility stop) | power |
  |---|---|---|---|---|
  | 0.14 | 0 (type-I) | 0.003 | 0.711 | 0.022 |
  | 0.14 | 0.08 | 0.096 | 0.231 | 0.502 |
  | 0.14 | 0.10 | 0.206 | 0.103 | **0.756** |
  | 0.14 | 0.12 | 0.397 | 0.030 | 0.935 |
  | 0.20 | 0.10 | 0.131 | 0.219 | 0.537 |

  - **MDE at 80% power:** **0.104 at ψ 0.14**, 0.086 at ψ 0.10 and 0.128 at ψ 0.20.
  - The futility rule costs 2–3 points of power and ends ~71% of null runs at the interim.
  - Expected pairs: 78 under H₀, 97 at Δ = 0.10.
  - The exact test is conservative (actual type-I ≈ 0.022).
- **A plausible effect may be smaller than the MDE.** S1's −0.12 mixed all the steering and the template effect. A
  non-significant result is "no difference shown"; the mechanism metric and the secondaries carry the rest.
- **Shared docker host.** P2G41's Harbor cells run on the same docker host (CPU-heavy containers; their own relays).
  - N1 runs one cell at a time, so its two cells of a pair see nearly the same load, and the first-arm alternation
    spreads the rest.
  - Load is recorded per cell (`load.json`).
- **Within-pair time separation.** Minutes, not zero: the cells are sequential, not concurrent.
- **Capped cells usually leave no turn record**: the audit is copied after `gnomon task` exits. Their mechanism comes
  from the meter, which sees every request.
- **Not compared.** No time-separated comparison is pre-registered. S1's arms ran build 8078df03 and are not pooled with
  N1.
- **Budget.**
  - **$0 cloud**: local only. The cloud sink makes a paid call impossible by construction (no relay holds a key).
  - **Local GPU:** at most ≈ 26 h of the gx10 lane until 2026-11-06T07:00Z; the gpu.lock holds other gx10 GPU benchmarks
    off for that time.
  - **Disk:** ≈ 70 MB of runs.

## Cleanup and scope

- **What the chain starts and stops:**
  - the gpu.lock;
  - its runner and the runner's two relays, by the process group it launched;
  - that runner's in-flight cell (moved to `runs-aborted/<cell>-operator`; its compose project removed by exact label).
- **What it does not do:**
  - no `pkill`;
  - no docker command of its own;
  - nothing to the lane, the hub, ~/.claude or any brain.db.
- **Writes:** nothing under `benchmarks/results/` outside `n1-2026-11/` is written. S1's, R1H's and M2's files are read;
  M1's commit lock is opened for append.

## Files

- **The chain and runner:**
  - `apparatus/n1-chain.sh`: the chain. `DRY=1` runs read-only checks; `DRY_GATE=1` also renders the gate.
  - `apparatus/run_n1.py`: the runner (`plan`, `smoke`, `full 1|2`, `abort-inflight`).
- **The analysis:** `apparatus/collect_n1.py` (`--interim`, `--smoke`, `--no-write`), which holds the sequential rule.
- **The arm and the release:**
  - `apparatus/gnomon-setup-n1.sh.j2` and `apparatus/peer_agents_n1.py`: the setup and the agent, carrying the release
    pins and the arm line;
  - `apparatus/install_release_n1.sh`: the same release pins on this host, and `--check-sums`;
  - `apparatus/init-v041/`: v0.4.1's own `gnomon init` output, the preflight's scaffold.
- **Checks and tests:**
  - `apparatus/wiretest_n1.mjs` and `wiretest-n1.txt`: the offline wire test;
  - `apparatus/preflight_n1.sh`, `apparatus/test_run_n1.py`, `apparatus/test_collect_n1.py`,
    `apparatus/test_chain_n1.sh`: the preflight and the offline tests;
  - `dryrun-n1.txt`: the read-only dry check at preparation.
- **Byte-identical copies of S1's** (checked by the preflight):
  - `collect_m1.py`, `gnomon_agent.py`, `peer_agents_r1.py`;
  - `relay-meter-s1.mjs`, `test_relay_s1.mjs`;
  - `sample16-hunch.txt`, `probe_s1.py`, `probe-shapes-s1.json`;
  - `lane-gx10-ref-*`.

### Tests at preparation (2026-11-04T21:18Z, all offline, all pass)

- `test_run_n1.py`: **40 passed, 0 failed**. It covers:
  - plan, order and first-arm balance, with attempt 1 equal to S1's order as run;
  - the ports rule and the sink check;
  - one cell at a time, with each arm's env;
  - skip, incomplete re-run, the deadline (no half pairs), tb without an output dir, the misroute pause, SIGTERM abort
    and abort-inflight;
  - `plan` writing nothing.
- `test_collect_n1.py`: **44 passed, 0 failed**. It covers:
  - the rule's constants, exact McNemar, the interim decisions, and conditional power against an independent
    multinomial enumeration;
  - the design's exact type-I error (≤ 0.05) and power;
  - the e-process port against evidence.py's numbers;
  - the collector on synthetic cells: validity, pairing, the mechanism checks failing when they should, interim states,
    the final α chosen from `INTERIM.txt`, and the smoke verdicts.
- `test_chain_n1.sh`: **40 passed, 0 failed**. It covers:
  - static scans: systemctl only `cat`/`show`; no pkill, ssh, docker or chat request; kills scoped to the runner's group;
    ports;
  - `lane_check` refusing a changed template, n_ctx, build, slot count, sampling default or unit;
  - the gpu.lock wait, deadline and fd hygiene;
  - `run_stage`'s retry, pause, deadline and lane-loss paths;
  - a FATAL exit committing nothing;
  - commits limited to this folder.
- `preflight_n1.sh`: pass. It covers:
  - the setup through tb's jinja, with the release pins present;
  - the node block on the real v0.4.1 init (a one-line arm difference and 5 refusals);
  - the relay suite (36 passed);
  - the byte-identical copies;
  - the offline delivery gate;
  - the wire test PASS on `gnomon/0.4.1+v0.4.1-c511b81`;
  - the agent class, the 112-pair plan and the ports.

## Launch

From a shell on the gx10, with nothing else to do first:

```bash
cd /home/eljaplacido/gnomon-wt/peers/benchmarks/results/n1-2026-11 && \
  N1_DEADLINE=2026-11-06T07:00:00Z setsid nohup apparatus/n1-chain.sh >> chain-n1.log 2>&1 < /dev/null & echo "N1 chain pid $!"
```

- **`N1_DEADLINE`** is the pre-registered new-pair deadline knob. The default is the same value.
- **Optional read-only check first:** `cd …/n1-2026-11 && DRY=1 apparatus/n1-chain.sh`. It makes GETs on the lane and
  renders nothing; `DRY_GATE=1` adds the render-only gate.
- **Stopping and resuming.**
  - **Stop:** `kill -TERM <chain pid>`. The chain's trap stops its runner's process group; the cell in flight moves to
    `runs-aborted/<cell>-operator`.
  - **Resume:** relaunch with the same command. Finished cells are skipped, the smoke is not repeated, and an interim
    already in `INTERIM.txt` stands.
- **Progress** is in `STATUS.txt` (`N1RUN START/END` per cell, `CHAIN-N1` per gate).

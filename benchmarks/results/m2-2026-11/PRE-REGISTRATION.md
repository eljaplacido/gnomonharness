# M2: a fair-recipe local-model ladder, local and hybrid, on gnomon v0.4.0 (pre-registration)

**Status: COMMITTED 2026-11-03T19:05Z by the coordinating session after review**, written 2026-11-03 ~19:00Z before any M2 cell. **Launch setting:** `M2G_BLOCKS="fnx/L q36g/L fnx/PC q36g/PC"` (both L arms first, so a complete local comparison lands tonight).
The coordinating session commits this file and `apparatus/` before launch. Each chain then writes every gate result
into `STATUS.txt` and commits it, with the lane, probe and smoke files, **before that lane's first measured cell**.
Nothing here is edited after launch; a later change is a timestamped amendment at the end.

## Questions (the user's)

1. Given a deployment recipe **at least as good as the incumbent's** (Qwen3.6-35B-A3B Q4_K_S on llama.cpp), does any
   challenger match or beat the incumbent, local-only (**L**) and hybrid (**PC**: the cloud plans, the local model builds)?
2. Does the answer differ between L and PC?

M1 (`../m1-2026-11/`) answered "no challenger beats Qwen3.6" with each challenger in a recipe of its own, several of them
worse than the incumbent's (Glimmer without reasoning replay, Qwen3.8 with MTP off, a patched template and 4-bit KV at 2
sequences, every lane on build d59e6c19). M2 gives each challenger its best known recipe, runs everything on the released
v0.4.0, and adds the PC arm for every model.

## The variable is still a deployment recipe

Engine, quantisation, speculative decoding, KV type, reasoning mode and the chat template change with the weights. M2
compares **recipes**; a difference cannot be attributed to the weights alone. Each recipe below is the best one known
for its model; what still differs from the incumbent is listed for each.

## Build: gnomon v0.4.0 for every cell, control included

- `be4fc0d8835c443aca8b32ccd4c1caacf48cbdce` (tag v0.4.0), fetched by SHA in every cell, checked on GitHub before every
  runner start, recorded per cell (`agent-logs/gnomon-commit.txt`); anything else is `wrong_commit`. R3R (the RTX control)
  runs the same SHA.
- v0.4.0 has: `[defaults] stream = true` and `max_tokens = 32768` from `gnomon init`; streaming with idle/total clocks;
  per-endpoint `replay_reasoning` (default off except api.deepseek.com); `steer_role` with automatic adaptation: an
  endpoint that answers 400 "System message must be at the beginning" gets gnomon's mid-turn messages as user messages
  marked `[gnomon]` for the rest of the session (`counters.steer_role_adapted`); the dispatcher fix.
- **Surface.** `apparatus/gnomon-setup-m2.sh.j2` is R3R's setup plus one per-cell switch, `M2_LOCAL_REPLAY`. With `false`
  it writes byte-identical files to R3R's setup; with `true` it adds exactly one line, `replay_reasoning = true`, under
  `[endpoints.r1local]`. Verified offline on the real v0.4.0 (`wiretest-m2.txt`, PASS): surface identity, the one-line
  difference, and on the wire: replay on → every local request after a reply with reasoning + a tool call sends the
  reasoning back (meter: 2 of 2), replay off → none (negative control); the cloud is never sent reasoning; every request
  streamed with `max_tokens = 32768`; PC delegates to the local implementor.

## Recipes

### The incumbent (the controls)

| | RTX control = **R3R** (`../r3r-2026-11/`, committed, unchanged) | gx10 control = **q36g** (M2's own cells) |
|---|---|---|
| model | Qwen3.6-35B-A3B-UD-Q4_K_S + DFlash draft (`2bee952b…`, `107b7a43…`) | the same files |
| engine | llama.cpp b11739 (hub `C:\dev\bud-lane`) | llama.cpp b1281-571d0d54 (gx10 `llama-server-qwen-q4.service`) |
| KV, reasoning | q8_0, `--reasoning off` | q8_0, `--reasoning off` |
| slots × window | 2 × 98,304 | 1 × 98,304 |
| template | Unsloth qwen3.6: **drops** a mid-turn system message (steering not delivered) | byte-identical |
| arms / cells | L, C, PC (M2 reads L and PC) — R1H's plan, 2 lane slots + 1 cloud slot | L, PC, 1 slot |

The q36g lane is read only (`systemctl --user cat/show`, GETs) and must match S1 Amendment 3's references
(`ref/lane-q36g-ref-*`, copies of `../s1-2026-11/lane-gx10-ref-*`): build, model, alias, template (= R1H's), caps,
1 × 98,304, speculative, every server default, the unit's flags. Any difference is FATAL. The weights' sha256 are checked.

### Challengers

**Glimmer-30B — `glim`, hub RTX 5090 (M1a3's G1 recipe).** llama.cpp b11739 (`C:\dev\m1-glimmer`, the lane agent's
`start-m1.ps1`/`stop-m1.ps1`, hash-pinned), Muse-Glimmer-30B Q4_K_M + DFlash draft (sha256 checked against its READY
marker), q8_0 KV, 2 slots × 98,304, reasoning always on (its template), **`replay_reasoning = true` on its endpoint**.
Props gate: build, model, alias, template, caps, slots and n_ctx equal M1a3's lane (`ref/lane-glim-ref-props.json`).
- vs M1: M1a ran d59e6c19 without replay (12 vs 21, trailed); M1a3's G1 ran master 166a9d3c with replay (25 vs 24 against
  R1H). M2 = G1's recipe on the release; G0/G1 ran one slot each with a bounded lead, M2 runs L and PC from one queue
  on both slots (R3R's arrangement).
- vs the incumbent: other weights; **reasoning on, replayed**; its template **delivers** mid-turn system messages
  (rendered offline: the probe text is in the prompt; the incumbent's drops it). Same engine build, KV type, slots, window.

**Qwen3.8-27B — `q38`, hub RTX 5090, vLLM in WSL `m1-vllm` (the recipe author's design).** vLLM 0.27.1 + the PR #40914
backport, RadixArk/Qwen3.8-27B-NVFP4 @ 319f741c, **1 sequence, MTP-3**, **fp8 KV** in the recipe's 5.5 GiB KV pin,
**131,072 window**, thinking off (`enable_thinking: false`, as M1), **no template patch**: vLLM's own template refuses a
mid-turn system message with 400, and v0.4.0 adapts (one refused call per session, then steering is sent as `[gnomon]`
user notes). Served on the hub's 127.0.0.1:18480 as `qwen3.8-27b`.
- **Why fp8, not TurboQuant 4-bit.** M1's garble (duplicated or dropped numbers, 47 of 116 probes at 2 sequences with
  MTP-3, 5 of 104 with MTP-1) is the MTP × TurboQuant spec-verify path (vllm#40880; the recipe's own patch is for it).
  fp8 leaves that path entirely, and is the incumbent's KV class (q8_0); 4-bit KV is lossier.
- **Does 1 × 131,072 fit?** The recipe's log gives the 5.5 GiB pin as 286,466 tokens at 4-bit (≈ 20.6 KB/token). fp8
  stores 8 bits per element, at most twice that: ≈ 143k tokens ≥ 131,072 (concurrency ≈ 1.09×, the ratio the recipe
  itself runs at 262,144 with 4-bit). vLLM refuses to start when one max-length request does not fit; then the ladder
  below falls to 98,304, the incumbent's per-slot window. Either window covers all gnomon sends (65,536 + 32,768).
- **Rung ladder, fixed now** (`m2-rtx-chain.sh`, `Q38_RUNGS`; each start a `start-q38-m2.ps1` call; every outcome into
  STATUS before any q38 cell):
  - *start ladder* (only a start that fails moves on): (1) fp8, MTP-3, 131,072, the recipe's FA2 pin; (2) the same
    without the FA2 pin (in case vLLM's FlashAttention-2 path refuses fp8); (3) fp8, MTP-3, 98,304, FA2; (4) the same
    without FA2; (5) the recipe's own KV (TurboQuant 4-bit), MTP-3, 131,072 — M1 Amendment 2's never-tested fallback (b).
  - *gate, on the rung that started*, at the lane's own concurrency (1): M1 Amendment 2's garble soak (240 s, every
    1–30 probe exact) **and** the MTP correctness probe (`probe_lane_m2.py mtp --need-spec-metrics`: 1–60 three times,
    a needle at ~12k and ~40k tokens, one exact tool call, at temperature 0; vLLM's
    `spec_decode_num_accepted_tokens_total` must rise — MTP on and accepting).
  - gate failed with MTP-3 → **MTP-1**, same KV, window and FA2; gate again.
  - gate failed with MTP-1 → q38 is **not run** (`q38-NOT-RUN.txt`). The next fallback, a llama.cpp GGUF lane, needs
    an amendment: `Qwen3.8-27B-Q4_K_M.gguf` (18.97 GB, ggml-org/Qwen3.8-27B-GGUF @ 0669b986, sha256 `31629f53…`,
    arch `qwen35`) and its MTP head `mtp-Qwen3.8-27B-Q4_0.gguf` (1.68 GB, `051a1764…`, 1 nextn layer) exist on the
    **gx10** (`~/models`), not on the hub. It would need a copy to the hub (C: has 25 GB free: ~4 GB would remain), a
    llama.cpp build verified for dense `qwen35` with its MTP head, and a lane script. Nothing is downloaded or copied now.
  - The rung that passes is written to `q38-rung.txt` before any q38 cell; every later start uses it and must pass the
    same gate again, or the rest of q38 is not run (a recipe cannot change mid-run without an amendment).
- **Hub files.** M2 installs its own: `C:\dev\m2-chain\start-q38-m2.ps1` and `server-q38-m2.ps1`, and inside WSL
  `/home/bench/m2-chain/start-q38-m2.sh` plus `/home/bench/gnomon-bench/qwen38-5090/start-m2.sh`, a generated copy of
  the live `start.sh` with exactly two anchored edits (the KV dtype and the FA2 pin become env knobs; the recipe's
  values stay the defaults). `start.sh` is only read; its sha256 and the full diff go to `lane-q38-install.txt`. A moved
  anchor stops the install and q38 is not run (`test_install_q38_m2.sh`). Stop is the lane agent's
  `C:\dev\m1-qwen38\stop-m1.ps1` (hash-pinned), only for a lane this chain started.
- vs M1 (A5): 2 seqs, no MTP, TurboQuant 4-bit KV, a template patched to drop late system messages, d59e6c19 →
  1 seq, MTP-3, fp8 KV, vLLM's own template, v0.4.0.
- vs the incumbent: engine (vLLM vs llama.cpp), NVFP4 vs Q4_K_S, MTP vs DFlash, fp8 vs q8_0 KV, a dense 27B vs a 3B-active
  MoE, window 131,072 vs 98,304 (no effect on what gnomon sends), **1 slot vs 2** (a q38 cell has the GPU to itself; an
  incumbent cell shares it with the other slot's cell), steering **delivered as `[gnomon]` user notes** vs dropped,
  vLLM applies the model's generation_config defaults for parameters gnomon does not send (top_k etc.).

**Qwen3.8 Flash-Next FP4 — `fnx`, gx10 (M1b's recipe).** TensorFold 1.1.4 + 17 recipe patches (digest-pinned image),
nvidia/Qwen3.8-Flash-Next-FP4-Local @ b9ce18a6, MTP drafts, fp8 KV, **1 stream × 98,304**, `--no-thinking`, reserve 9 GiB,
`--oom-score-adj=1000`, started with M1b's authorised copy `~/gnomon-bench/flash-next-tf/start-m1b.sh` (unchanged since
M1b: sha256 `aab8a3ea…`, pinned; a changed file means fnx is not run) and stopped with its `stop-m1.sh`.
- **1 stream, not 2.** The control (q36g) has 1 slot, so 1 stream keeps the per-cell conditions equal (2 streams share
  the GB10's bandwidth and lengthen every cell). Memory does not reliably allow 2 either: at writing, MemAvailable 73 GiB
  + the qwen lane's 22.6 GiB GPU memory projects ~93–100 GiB after the qwen lane stops (M1b measured 105 GiB with R1/P2G
  paused; nothing is paused now), against 96 GiB for 1 stream and 98 for 2.
- Every start: M1 Amendment 2's garble soak at concurrency 1, **gating** (M1b ran it informational and passed 16/16).
  A failure means fnx is not run: switching drafts off would change the recipe (an amendment). First start: the MTP probe
  (informational: TensorFold has no vLLM metrics) and the steer probe.
- vs M1b: the build (d59e6c19 → v0.4.0), the meter (S1's JSON usage parser: M1b's meter recorded no local tokens for
  fnx), the PC arm. The lane is the same file, settings and window.
- vs the incumbent (q36g): engine, FP4 vs Q4_K_S, MTP vs DFlash, fp8 vs q8_0 KV; same 1 slot × 98,304 and reasoning off.
  Its HF template raises on a mid-turn system message, but M1b saw no refusal on d59e6c19 (TensorFold renders templates
  itself), so whether steering reaches it is unknown: the steer probe records it.

**Steering, stated per lane** (a harness-side difference caused by the serving template; S1 measures whether delivering
steering helps Qwen3.6): incumbent (both lanes) dropped; Glimmer delivered as system; q38 delivered as `[gnomon]` user
notes after one refused call per session; Flash-Next unknown (probed). Each lane's `probe-steer-<lane>.txt` and the
per-cell `steer_role_adapted` and meter counts (late system, dropped, `[gnomon]` notes) are reported.

## Arms, tasks, cap, plan (R1H's / R3R's)

- **L** (every role local, entry implementor) and **PC** (coordinator and plan in the cloud; implementor, verifier,
  implement, critique and smol local; entry coordinator), routes byte-identical to R1H/R3R. **NEG** (cloud only,
  asserted as L) in every lane's smoke must come out `misrouted`.
- Cloud: DeepSeek V4.1 Flash through OpenCode Go (`relay-go.mjs`, byte-identical to R1H's), no replay to the cloud.
- R1H's 16 tasks (`apparatus/sample16-hunch.txt`) × 2 attempts; within an attempt tasks shuffled with seed = attempt;
  the two arms rotate per task as R1H rotated three; attempts are barriers. Per lane: 64 cells. The (task, attempt, arm)
  set equals R3R's L and PC cells (`test_run_m2.py`).
- 900 s cap (`--global-agent-timeout-sec`, tb 0.2.18 with its 300 s join window); "capped" = tb `failure_mode`
  `agent_timeout`.
- Lane slots take cells from one queue in plan order: glim 2, q38 1, fnx 1, q36g 1.
- Local meter `relay-meter-s1.mjs` (S1's: JSON usage, abort on client disconnect), byte-identical; cloud tail settle and
  the ledger as R3R. **Per-cell load:** `load.json` (1/5/15-min load at start and end, running containers at start);
  `cell.json` records lane, machine, lane slots, replay, upstream, containers.
- Ports (checked free; none used by another apparatus, R3R's included; the chains' sets are disjoint): gx10 chain
  5610/5611 (+counters 5620/5621), NEG trap 5614/5615 (5624/5625); RTX chain 5710–5715 (5720–5725); M2's tunnel
  gx10 127.0.0.1:18980 → hub 127.0.0.1:18480.

## Validity (R1H's rule, one function for every cell)

`apparatus/collect_m1.py` is a byte-identical copy of R3R's (= M1's, hash pinned). A cell is **valid** when tb returned a
verdict, both meters read non-negative deltas, ≥ 1 chat request was metered, it ran v0.4.0, gnomon did not give up on an
endpoint after its whole retry grace, and its traffic matches its arm (L: cloud 0 and local > 0; PC: cloud > 0, and
local > 0 if it delegated). Anything else is apparatus (`missing`, `apparatus`, `unmetered`, `endpoint_outage`,
`no_model_call`, `wrong_commit`, `misrouted`): reported, never scored. Buckets are asserted to sum to n per (lane, arm).
Yield-, operator- and lane-death-aborted cells are not cells of the run: moved to `runs-aborted/<cell>-<reason>` and
re-run from scratch. M1b's rule for a lane death (Flash-Next): the cells in flight and any that ended ≤ 180 s before the
death was detected are apparatus; one lane restart per chain, a second death ends fnx.
The preflight requires the copy to judge M1's reference cells as M1's summaries did (m1b-fnx 31 valid/21 solved,
m1a3-g1 32/25, m1a-q38 20/10).

## Decision rule (pre-registered; `collect_m2.py --decide`)

For each challenger and each arm, against its control's **same arm** (fnx → q36g; glim and q38 → R3R), on the
(task, attempt) cells valid in both:

| condition (s = solved on the pairs, cap = capped on the pairs, p = exact two-sided McNemar) | verdict |
|---|---|
| fewer than 24 pairs | **NOT DECIDED** |
| s_x ≥ s_c and cap_x ≤ cap_c + 1, s_x > s_c and p < 0.05 | **BEATS (shown)** — the only superiority claim |
| s_x ≥ s_c and cap_x ≤ cap_c + 1, s_x > s_c, p ≥ 0.05 | **MATCHES OR BEATS (ahead, not shown)** |
| s_x = s_c and cap_x ≤ cap_c + 1 | **MATCHES (tie)** — reported as a tie |
| s_x ≥ s_c and cap_x > cap_c + 1 | **DOES NOT MATCH (more capped)** |
| s_x < s_c | **TRAILS** (shown if p < 0.05, else not shown) |

A challenger's recipe **"matches or beats the incumbent"** on an arm when its verdict is BEATS, MATCHES OR BEATS or
MATCHES (tie); reported for L and PC separately and for both together. The +1 allows one capped cell of slack, since the
capped count is itself noisy at n = 32. M1's numbers through this rule (as a check, `test_collect_m2.py`): M1a Glimmer
12 vs 21 → TRAILS (shown); M1b Flash-Next 20 vs 17 with capped 8 vs 5 → DOES NOT MATCH (more capped); M1a3 G1 vs R1H
25 vs 24, capped 3 vs 2 → MATCHES OR BEATS (not shown).

**Reported beside the rule, never instead of it:** pass rate with Wilson 95% interval per lane and arm; capped counts;
the hybrid payoff within each lane (PC vs L, exact McNemar) and PC's $ per solved; median agent wall; local tokens per
solved; how cells end (last turn's `stop_reason`); the mechanism checks (replay as declared per lane, steering delivery);
load per cell; M2 vs M1's recipe of the same model (descriptive, time-separated, older builds).

## Power and limitations, stated now

- **Power.** At most 32 pairs per comparison, and the run-to-run spread of the same arm is ~12 points at n = 32 (about
  15% of cells flip between attempts). Only differences of roughly 20–25 points (6–8 of 32 cells) can be shown at
  p < 0.05. "MATCHES" and "MATCHES OR BEATS (not shown)" are compatible with a true deficit of that size: they mean
  "no difference shown", not "equivalent".
- **Time separation.** The RTX control R3R runs first, possibly on an earlier night than M2's RTX arms; q36g runs after
  fnx (hours or a night later, per the block order). The gx10's load (P2G, the other chain, R3R's own 3 cells at once
  on this docker) differs between a challenger and its control; it is recorded per cell, not controlled.
- **Concurrency.** R3R ran its lane with 2 slots plus a cloud slot (3 cells at once); glim runs 2 at once, q38 and the
  gx10 lanes 1. A q38 cell never shares the GPU; an R3R cell does.
- **Recipe confounds** (listed per lane above): engine, quantisation, speculative decoding, KV type, reasoning and replay
  (Glimmer only), steering delivery, and server-side sampling defaults for parameters gnomon does not send (gnomon sends
  temperature 0.3 and top_p 0.95 everywhere; top_k etc. come from llama.cpp's defaults, TensorFold's server flags, or
  vLLM's generation_config).
- Partial runs: cells not started by a deadline are logged `NOT STARTED … (deadline)` and never imputed; comparisons use
  paired valid cells only, and a comparison with < 24 pairs is NOT DECIDED.

## Scheduling: two chains

**gx10 chain** (`apparatus/m2-gx10-chain.sh`):
1. Waits for the S1 chain by **pid** (`M2G_WAIT_PID`; S1 runs on the gx10 lane now: `CHAIN-S1-GX10 … pid 730641`,
   deadline 21:15Z). The cmdline must hold `s1-chain`; S1's chain lock is read from `/proc/locks` (never taken): a wrong
   pid, or a new S1 chain, is FATAL. The qwen lane is never touched while S1 runs.
2. Offline tests; then P1's gx10 `gpu.lock`, held for the rest of the chain (as R1, M1b and S1 held it).
3. Blocks, `M2G_BLOCKS`, default **`fnx q36g`** (Flash-Next L+PC, then the control L+PC). Pre-registered alternative,
   chosen at launch and recorded in STATUS before any cell: **`fnx/L q36g/L fnx/PC q36g/PC`** (one arm of each lane at a
   time: a complete L comparison first, and challenger and control closer in time). Cell ids do not depend on the order.
4. Flash-Next block: a non-destructive precheck (non-qwen GPU apps < 1 GiB; MemAvailable + the qwen lane's GPU memory
   ≥ 96 − 6 GiB; waits up to `M2G_FNX_WAIT_MIN`, 45) → `systemctl --user stop llama-server-qwen-q4.service` → MemAvailable
   ≥ 96 GiB within 20 min, else the qwen lane is restarted at once and the block **deferred once** to after the other
   blocks → start (one retry) → the gate → [first time: probes, smoke, commit] → cells under M1b's lane-death watchdog →
   stop Flash-Next → start the qwen lane and wait until it serves. No lane switch with < 60 min to the deadline.
   Nothing else is paused (P2G and the RTX chain keep running). The EXIT trap stops Flash-Next and restarts the qwen
   lane if this chain changed them, whatever happens.
5. Control block: lane check against the references, weights, [first time: steer probe, smoke, commit], cells (a runner
   failure retried once after 60 s; the lane is waited for, never restarted).
6. New-cell deadline `M2G_DEADLINE`, default **2026-11-04T09:00:00Z**. Then collect and commit.

**RTX chain** (`apparatus/m2-rtx-chain.sh`), gaming-safe as S1 Amendment 1 / R3R:
1. Waits for the S1 chain by pid (`M2R_WAIT_PID`, same rule): R3R's own chain refuses to start while an S1 chain holds
   S1's lock.
2. **R3R first.** 96 finished R3R cells → go on. An R3R chain already holding `r3r-2026-11/.chain.lock` → wait on its
   pid (from R3R's STATUS, checked against `/proc`); M2 never starts a second R3R and never signals one. Otherwise launch
   R3R's committed chain exactly as its pre-registration says (`R3_WAIT_PID` = the S1 pid, `R3_DEADLINE` = M2's
   deadline, its own `chain-r3r.log`) and wait on its pid. R3R incomplete when its chain ends → the RTX chain ends: M2's
   RTX arms start only after R3R is complete.
3. Blocks `M2R_BLOCKS`, default **`glim q38`**, each in R3R's loop: idle start (15 consecutive 60 s samples: < 4,000 MiB,
   < 15%, no llama-server, `m1-vllm` not running) → lane up + M2's tunnel with the watchdog from the lane's creation →
   gates → [first time: steer probe, smoke L/PC/NEG, commit before data] → cells. **Yield** (every 30 s): GPU memory over
   the limit twice in a row, our server gone, or another server → `YIELD-NOW-rtx` first (no new cell; every cell in flight
   aborted and re-run on resume), then the lane is stopped, then the idle wait again.
   - S1's rule is kept byte-identical for Glimmer (a llama.cpp lane). For q38 (vLLM in WSL) `m2-hubwatch.sh` adds two
     things S1's rule cannot express: our own lane is the `m1-vllm` distro (S1 reads it as "someone else"; here any
     llama-server → yield, the distro gone after it answered → yield), and the memory limit is
     **min(warm + 1,500 MiB, total − 256 MiB)**: vLLM fills the card (q38 warm ~31,700 of 32,607 MiB in M1), so S1's
     warm + 1,500 could never be reached. vLLM's adaptive allocation leaves ≥ 820 MiB free, so the lane alone stays
     ≥ 564 MiB under the cap; a game saturates the card. For R1H's and Glimmer's lanes the cap never binds.
   - Footprint anomaly (lane footprint over its expected + 1,500 MiB: glim 19,500, q38 28,400, both measured in M1):
     yield; twice → FATAL.
4. New-cell deadline `M2R_DEADLINE`, default **2026-11-04T07:00:00Z**. The chain may span several nights: relaunch it with
   a new deadline; finished cells are kept (`cell.json` written last), yields re-run the cells in flight, a lane's smoke
   is not repeated; q38's and Flash-Next's gates run on every start; R3R is resumed by its own chain the same way.

Commits add only M2's paths, under the M1/S1/R3R chains' commit lock. Cleanup is scoped to what each chain started and
fires only when it exits; no `pkill -f`, no `killall`, no STOP-ME, no `wsl --shutdown` (`test_chain_m2.sh` scans both).

## Expected wall time (sums of cell walls from the nearest earlier runs)

| block | basis | estimate |
|---|---|---|
| fnx L | M1b fnx L: 32 cells, 4.62 h | 4.6 h |
| fnx PC | R1's PC/L ratio on this lane (6.03/3.97 = 1.52) × 4.62 | ~7.0 h |
| fnx overhead | precheck, stop, memory wait, start (197 s in M1b), gate 4 min, probes, smoke | ~0.5 h |
| q36g L / PC | R1 on this lane: 3.97 h / 6.03 h | ~10.2 h with smoke |
| R3R | its own estimate | ~4.5 h after an idle start |
| glim L+PC (2 slots) | G1 L 3.06 h + PC ≈ 2.14 × L (R1H's PC/L) ≈ 6.6 h, over 2 slots | ~5.2 h |
| q38 L+PC (1 slot) | M1a5 L mean 418 s at 2 seqs without MTP; MTP-3 at 1 seq is faster per stream: L 250–420 s, PC × 2.14 | ~7.5–12 h |

- **Tonight on the gx10** (S1 ends ~21:15–21:35Z): with the default order, Flash-Next L+PC (~12 h) runs ~21:45Z → ~09:45Z,
  so at the 09:00Z deadline about 60 of 64 fnx cells are done (both arms cut alike, by the interleaved plan) and the
  control (~10 h) needs another window. With `fnx/L q36g/L fnx/PC q36g/PC`: fnx L ~21:45–02:50Z, q36g L ~02:55–07:10Z
  (**a complete L comparison tonight**), then fnx PC starts and is cut at 09:00Z (~7 of 32 cells).
- **The RTX** needs ~17–22 h of idle GPU (R3R, Glimmer, q38): two to three free nights, more with yields. Nothing on the
  RTX fits tonight unless the GPU is idle by ~01:30Z (then R3R alone might finish by 07:00Z).
- Memory risk: if the Flash-Next precheck or memory wait fails tonight, the control runs first and Flash-Next is tried
  once more after it.

## Budget

- **$4.00 of Go allowance per chain**, each chain its own ledger (`spend-gx10.jsonl`, `spend-rtx.jsonl`; smoke, aborted
  cells and tails included); above it no new cell starts (`BUDGET-PAUSE-<machine>.txt`). R3R keeps its own $6.00.
- **Expected** ~$2 per chain: L spends $0; a PC cell cost ~$0.03 in R1H (slower local lanes may make longer PC cells).
  The Go key is shared with P2G and R3R; each ledger counts only its own cells.

## Pre-data gates, in order (each into STATUS)

Both chains: the S1 wait; offline tests (`test_run_m2.py`, `test_chain_m2.sh`, `test_collect_m2.py`,
`test_probe_lane_m2.py`; the RTX chain also `test_hubwatch_s1.sh`, `test_hubwatch_m2.sh`, `test_install_q38_m2.sh`);
`preflight_m2.sh` before every runner start (setup, node block for L/PC with replay off and on and 7 refusals, relays
and their tests, every copy byte-identical to its source, the wire test PASS on v0.4.0, the validity copy on M1's
references, plans and ports). Per lane: the lane checks above, the gate (q38, fnx), the steer probe (informational), the
**smoke** (L and PC valid and solved, NEG misrouted, v0.4.0, `stream`/`max_tokens` on the surface and every local request,
cloud usage self-requested, the replay line as declared, and on glim reasoning actually sent back; replay-off lanes must
send none), one retry, then the lane is not run; **commit before data**.

## Files

- `apparatus/m2-gx10-chain.sh`, `apparatus/m2-rtx-chain.sh` (`DRY=1`: read-only), `apparatus/run_m2.py` (`plan`, `smoke`,
  `full <lane> [L|PC]`, `abort-inflight`, `abort-recent`, `finished`), `apparatus/collect_m2.py` (`--smoke <lane>`,
  `--decide`, `--no-write`), `apparatus/m2-hubwatch.sh`, `apparatus/probe_lane_m2.py`, `apparatus/tunnel-m2.sh`,
  `apparatus/preflight_m2.sh`, `apparatus/gnomon-setup-m2.sh.j2`, `apparatus/peer_agents_m2.py`,
  `apparatus/wiretest_m2.mjs` → `wiretest-m2.txt`.
- `apparatus/hub/`: `start-q38-m2.ps1`, `server-q38-m2.ps1`, `install-q38-m2.sh` (installed at the first q38 start),
  `fixture-start-m1.sh` (the lane's `start.sh` as read on 2026-11-03 08:03, for the offline install test only).
- Tests: `test_run_m2.py` (52), `test_collect_m2.py` (28), `test_chain_m2.sh` (44), `test_hubwatch_m2.sh` (21),
  `test_install_q38_m2.sh` (14), `test_probe_lane_m2.py` (10).
- Byte-identical copies (checked by the preflight): from R3R `peer_agents_r1.py`, `gnomon_agent.py`, `relay-go.mjs`,
  `relay-meter-s1.mjs`, `test_relay_s1.mjs`, `test_relay_go_r3r.mjs`, `sample16-hunch.txt`, `s1-hubwatch.sh`,
  `test_hubwatch_s1.sh`, `collect_m1.py`; from M1 `soak_m1.py`; references in `ref/` from S1 (`lane-gx10-ref-*` →
  `lane-q36g-ref-*`) and M1 (`lane-glim-a3-props.json`, `lane-fnx-start-m1b.sh`, `lane-fnx-PINS.txt`, READY markers).
- Nothing outside `m2-2026-11/` is written by M2's code, except what launching R3R's committed chain writes into
  `r3r-2026-11/` (R3R's own files), the hub files above, and the gx10 qwen lane's stop/start for Flash-Next.

Launch (after this file and `apparatus/` are committed):
```
cd benchmarks/results/m2-2026-11/apparatus
setsid nohup env M2G_WAIT_PID=<S1 chain pid> M2G_DEADLINE=2026-11-04T09:00:00Z [M2G_BLOCKS="fnx/L q36g/L fnx/PC q36g/PC"] ./m2-gx10-chain.sh >> ../chain-m2-gx10.log 2>&1 < /dev/null &
setsid nohup env M2R_WAIT_PID=<S1 chain pid> M2R_DEADLINE=<this night's end> ./m2-rtx-chain.sh >> ../chain-m2-rtx.log 2>&1 < /dev/null &
```


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

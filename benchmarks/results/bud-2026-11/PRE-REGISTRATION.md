# BUD: budget awareness, A/B on the local model (pre-registration)

Status: **pre-registered 2026-11-02, before any measured cell.** `bud-chain.sh`
appends a timestamped "final" line and commits it right before the first
measured cell, after the smoke test. Any change after that is a timestamped
amendment.

## Question

Does telling the model its step and time budget (PR #93, `[turn] budget_notes`
plus `gnomon task --deadline`) cut the work gnomon loses at the time cap, and the
tokens it spends on tasks it fails anyway, without costing tasks solved?

## Why

- **LEAN stage 2** (`../lean-2026-11/README.md`, local qwen3.6-35b): on tasks
  both arms failed, gnomon kept going. tune-mjcf went from 10 → 176 requests,
  mailman 6.7M → 10.5M prompt tokens.
- **P1-H** (hosted DeepSeek): gnomon lost the most tasks of five harnesses at the
  900 s cap.
- In both, the model was never told its budget.

## Arms: one variable

| Arm | Commit | What differs |
|---|---|---|
| base | `d59e6c198f91d1469198b0677c008323f82d0345` (master after #80) | — |
| budget | `c3bcb997293f5cb8726b367a6716a5fbce32add3` (PR #93 head, branched from `d59e6c1`) | the budget-awareness feature, including `gnomon init` writing `budget_notes = true` |

**Both arms are invoked identically:** `gnomon task "$INSTR" --role implementor
--yes --trust --deadline <s>`.

- **Base** has no `--deadline` option. Its parser keeps an unknown flag as an
  unused value, so it ignores it.
- **Budget** tells the model.
- So the only variable is the build.

`--trust` is passed to both: both builds have the workspace-trust gate (#72), and
the bench surface (`approval = never`) is looser than the scaffold.

**Deadline rule, the same for both arms:** 900 s − (seconds since the task's
setup started) − 30 s, floored at 60 s. It is computed inside the container at
launch (`apparatus/gnomon-setup-peers.sh.j2`, `/opt/bud-t0`) and logged per cell
as `BUD_DEADLINE_S` in `agent-logs/gnomon-cwd.txt`.

**Which notes can fire in this setup (stated in advance).**
- **Step notes:** the bench surface's `implementor` role is the scaffold's, with
  `max_steps_total = 256`. Step notes therefore fire only past 128 tool calls;
  P1 and LEAN cells use about 25 requests at the median. In practice they reach
  only the runaway cells.
- **Time notes:** they fire at half and at four fifths of the deadline, about
  420 s and 670 s into a run. They are the main mechanism under test.

## Mechanism control, before any GPU cell (done, `control/`)

The two pinned builds were run through the same scripted fake-model task (UX1's
`fake-model.mjs`, 3 tool turns, 600 ms latency), each with `--deadline 1`:

| | base `d59e6c1` | budget `c3bcb997` |
|---|---|---|
| exit, bucket | 0, result | 0, result |
| `deadline_ms` on the record | absent | 1000 |
| `volatile.time_notes` | absent | `[{at_step 1, level 50}, {at_step 2, level 80}]` |
| messages per request at the model | 2, 4, 6, 8 | 2, 5, 8, 10 (one extra system line after steps 1 and 2) |
| stderr | — | "deadline 1s: the model is told how much of it is left…" |

The base build accepts the flag and ignores it. The treatment's notes reach the
model.

## Fixed, as in LEAN stage 2 / P1

- **Apparatus:** `apparatus/run_bud_local.sh`, derived from
  `lean-2026-11/apparatus/run_lean_local.sh`:
  - it holds gpu.lock;
  - relay-meter listens on 172.17.0.1:18080 and forwards to llama-server, with counters on :18099;
  - one cell at a time;
  - the cap is 900 s, plus tb's 300 s join.
- **Model:** qwen3.6-35b, local.
- **Tasks:** P1-H's 16 (`sample16-hunch.txt`), **2 attempts**, with seed = attempt per-attempt shuffle and arms rotating per task. That gives 64 cells, ids `bd-k<k>-<arm>-<task>`.
- **Smoke first** (`bds-` ids, never scored): `hello-world`, both arms. The chain launches only if every smoke check below passes:
  - each cell has a verdict, at least one metered request, and the right commit;
  - the budget cell logs the deadline it was given and the announce line;
  - the base cell shows no `[budget]` line.

## Validity

A cell is valid when tb returns a verdict, the meter counted at least one
request, no counter went backwards, and the cell ran its arm's commit. Everything
else is reported by bucket and never scored. Buckets are asserted to sum to n per
arm.

## Endpoints (`apparatus/collect_bud.py`)

1. **Primary 1, lost at the time cap:** paired over (task, attempt). Discordant
   pairs are where exactly one arm ended in `agent_timeout`. Exact McNemar.
2. **Primary 2, tokens spent on tasks both arms failed:** prompt + completion,
   paired. Exact sign test, plus the budget/base total.
3. **Guard:** budget solves ≥ (base − 2) tasks.
4. **Reported:**
   - pass rate with Wilson intervals, and paired McNemar on solved;
   - total output tokens, requests and prompt tokens (paired sign tests);
   - the mechanism: cells in which at least one `[budget]` line fired, and the median deadline told.

## Decision rule

**PR #93 merges only if both hold:**
- the guard holds;
- Primary 1 or Primary 2 favours budget at p < 0.05.

**Otherwise it does not merge:**
- Guard holds, but no primary is significant: report it as inconclusive, with the
  direction, and leave the PR open for a larger run.
- Guard fails: report the result; the PR does not merge.

## What this can and cannot show (stated before any cell)

- **Primary 1 has low power.** In LEAN stage 2, 2–3 cells per 16 hit the cap
  per arm, so 32 pairs may yield only a handful of discordant pairs. The exact
  McNemar needs at least 6 discordant pairs, all one way, to reach p < 0.05. Only
  a near-unanimous effect is detectable.
- **Primary 2 is limited** to pairs both arms failed: about 10–12 of 32, judging
  by stage 2's 6/16 failures per arm. A sign test needs about 9 of 10 one way.
  Only a large, consistent effect shows.
- **The pass-rate guard** catches only a large loss. LEAN's noise floor is about
  3 of 16 tasks flipping between attempts.
- **One model, one bench surface.** The result says nothing about a role with a
  small `max_steps_total`, where step notes would matter more.

## Out of scope

- **A hosted-model arm is deliberately not included.** The month's OpenCode Go
  budget is about $80 of $100 committed (P2G, R1, earlier runs), and this A/B
  needs none.
- **Changing the scaffold's `max_steps_total`** is a separate experiment.

## Schedule

The chain (`apparatus/bud-chain.sh`) waits for R1's `DONE` line in
`../r1-2026-11/STATUS.txt`. If R1 stops early, it proceeds once no R1 process
has been alive for 30 min. Then it takes gpu.lock (the runner's own `flock`),
smokes, commits the final line, and launches. 64 cells at about 6–8 min each is
about 7–9 h.

## Amendment, 2026-11-02T10:36Z, before any trial: the model server moves to a second lane (hub RTX 5090)

The user asked for as many benchmarks as possible today. R1 holds the gx10 GPU
lane for about 14–18 h. Instead of waiting behind it, BUD runs on a second lane,
and only the model server changes. No BUD cell (smoke or measured) had run.

**Second lane:**
- **Hardware:** RTX 5090 (32 GB), Windows, driver 617.14.
- **Server:** llama.cpp **b11739** (`0ce8cd114`, released 2026-10-19), the official `llama-b11739-bin-win-cuda-13.4-x64.zip` (sha256 `c7bfa71b…da7aa`) plus `cudart-llama-bin-win-cuda-13.4-x64.zip` (sha256 `738f8c25…fe668`). Both digests match GitHub's.
- **Weights, identical to gx10's server:**
  - `Qwen3.6-35B-A3B-UD-Q4_K_S.gguf`, sha256 `2bee952b…95d42`;
  - DFlash draft `Qwen3.6-35B-A3B-DFlash-Q4_K_M.gguf`, sha256 `107b7a43…52f7`.

  Both were copied from gx10 and verified on the hub.
- **Flags, as gx10's `llama-server-qwen-q4` service:** `--alias qwen3.6-35b --ctx-size 98304 --parallel 1 --n-gpu-layers 99 --batch-size 2048 --ubatch-size 256 --cache-type-k q8_0 --cache-type-v q8_0 --spec-type draft-dflash --model-draft … --cont-batching --reasoning off`.
  - Speculative decoding (DFlash) is **on**, as on gx10.
  - `--mlock` is dropped, because Windows needs a privilege for it; the whole model is GPU-resident.
  - The server binary differs: upstream b11739 here, against gx10's build `1281 (571d0d54)`.
- **Binding:** 127.0.0.1:18380 on the hub only. gx10 reaches it through an SSH local forward (`apparatus/tunnel-hub.sh`, 127.0.0.1:18280, loopback on both ends).
- **Metering:** a second meter on 172.17.0.1:18281, counters 127.0.0.1:18299 (`apparatus/relay-meter-lane.mjs` = R1's meter, which adds `chat_requests` and `gpu_ms`). No gpu.lock: this lane is not gx10's GPU.
- **Throughput** (one fixed request each; gx10 from its own service journal, so nothing was sent to R1's server):

  | | hub | gx10 (journal, last 2 h) |
  |---|---|---|
  | generation | ~375 tok/s (short prompt, 223/279 draft tokens accepted); ~260 tok/s after a 6k-token prompt | median 66 tok/s |
  | prompt processing | ~4,000 tok/s (6k-token prompt) | median ~1,070 tok/s |

**What this changes:**
- **Within BUD: nothing that separates the arms.** Both arms run on this lane, one cell at a time, in the pre-registered order and cap. The A/B stays one variable (the build).
- **Against other runs:** the hub is about 4–6× faster, so a 900 s cap buys more model work here. BUD's absolute numbers (tasks solved, cells lost at the cap, tokens) **cannot be compared with LEAN stage 2 or R1**; only the paired base-vs-budget contrast is the result.
- **For the primary endpoint:** a faster lane may reach the cap less often. Fewer discordant cap pairs would lower its already low power. Stated in advance.
- **Apparatus:** `run_bud_local.sh` takes the lane from environment variables, with the pre-registered gx10 values as defaults. `apparatus/bud-chain-hub.sh` is `bud-chain.sh` without the wait for R1. The smoke and its pass rule are unchanged.

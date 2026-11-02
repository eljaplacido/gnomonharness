# R3: does "local first, cloud rescue" lift task completion? Pre-registration, DRAFT

Status: **DRAFT. Not run, and no apparatus yet.** Written 2026-11-02, before the
feature it measures is on master. Nothing here is final until the chain appends a
"Final" section with the build SHA, the lane and the smoke result, and commits it
before the first measured cell. Every change after that is a timestamped amendment.

## Question

R1, R1H and R2 test **static** hybrids: a role is routed to the cloud for the whole
run. R3 tests a **dynamic** one. The implementor works on the local model, and only a
turn that is stuck is moved to the cloud model, once, with a bounded handover
(`[roles.<name>.escalate]`, PR "feat(routing): local first, cloud rescue").

1. **LR vs L:** does rescuing stuck local turns make gnomon solve more tasks than
   local alone? (tasks solved, paired)
2. **LR vs C:** how close does LR come, and what does it cost? ($ per solved task,
   and the share of tokens that went to the cloud)

**Hypothesis:** LR ≥ L on tasks solved, approaching C, at a fraction of C's cloud
spend. The mechanism: in R1, local cells mostly end by running out of time or by
stalling, and a cloud model that reads the files on disk can often finish them.

R3 is never pooled with R1, R1H or R2. Those ran other builds. A side-by-side table
is allowed only if it is labelled as separate runs.

## Arms: the escalate block is the only variable between LR and L

| Arm | implementor | smol | escalate block | entry |
|---|---|---|---|---|
| **L** all local | local | local | none | `task --role implementor` |
| **C** all cloud | cloud | cloud | none | `task --role implementor` |
| **LR** local, cloud rescue | local | local | `model` = cloud, `on = ["stall", "step_wall", "budget_50"]` | `task --role implementor` |

- **Models.** Local is qwen3.6-35b. Cloud is DeepSeek V4.1 Flash through OpenCode Go. These are R1's and R2's models.
- **Every other role is routed as R1's L and C** (one profile, `r3.toml`). LR's profile is L's plus this block:
  ```toml
  [roles.implementor.escalate]
  model = "<the cloud id R1 used>"
  endpoint = "r3cloud"
  on = ["stall", "step_wall", "budget_50"]
  ```
- **Triggers that are not declared:**
  - `verify_failed` is out because the benchmark surface declares no `[verify]` check.
  - `apparatus` is out because an endpoint fault stays an apparatus outcome in every arm (see below). It is not something LR is allowed to rescue.
- **No arm declares a `fallback`.** If the build declares one by default, the smoke stops for an amendment. This is R2's rule.

## The time basis of `budget_50`, decided now

- **Step-based `budget_50` alone would rarely fire inside tb's cap.**
  - The scaffold's implementor has `max_steps_total = 256`, so the trigger fires at 128 tool calls.
  - R1's first ten L cells made 5–143 local chat requests (median about 42). Only one reached 128.
  - Most L cells end at the 900 s cap, long before half the step budget is used.
- **So R3 uses a declared time budget.** That needs PR #93's `gnomon task --deadline`. The escalate PR already reads the same `deadline` shape.
  - **#93 is on master at the pinned build:** every arm runs with `--deadline 840s`. That is the 900 s cap less about 60 s of setup, re-measured in the smoke and recorded.
    - It is the same flag in every arm, so the only difference between LR and L is still the escalate block.
    - In LR, `budget_50` then fires about 420 s into gnomon's run, unless the turn has ended or stalled first.
  - **#93 is not on master:** R3 does not start. An amendment decides between waiting and a step-only design. A step-only run measures mostly stall rescue, which is a different question.
- **The escalated model runs on the steps left.** The wall is raised only to give it the implementor's `max_steps` (32). Time is never extended, so a rescue can still be cut at the cap. That is LR's own outcome, not apparatus.

## Build

- The master SHA after the escalate PR and #93 are merged, with the user's consent. It is written to `BUILD-GO.txt`. The chain waits for that file and never guesses.
- The build is fetched by SHA in every cell and recorded per cell. A cell that ran any other commit is `wrong_commit`.

## Lane, tasks, order, cap

- **Lane:** whichever GPU lane is released first after R1 (gx10, :18080) or R2 (the hub's RTX 5090, `C:\dev\bud-lane`, :18380 through the gx10 tunnel). It is recorded in Final.
  - L and LR run on that one lane, so the GPU is not a variable between them.
  - C runs on a cloud slot, with a trap meter as its local endpoint (R1/R2 pattern).
  - The lane rules are R2's: weight checksums, a health probe before the smoke and before each attempt, a fault pause, and a cleanup scoped to R3's own chain with no idle fallback.
- **Ports are R3's own:**
  - lane meters 172.17.0.1:18581 and 18583, counters 18597 and 18599;
  - trap 18582, counters 18598;
  - relay-go 5310 and 5312, counters 5320 and 5322;
  - cloud slot 5311, counters 5321.
  - These are distinct from R1 (18080/18099, 4910–4921, 18081), R1H (18381–18399, 5110–5122), R2 (18481–18499, 5210–5222) and P2G (4710–4712, 4810–4812). They are re-checked free at Final.
- **Tasks:** R1's 16 (`sample16-hunch.txt`) × **2 attempts** × 3 arms = **96 cells**. 64 are on the lane (L, LR) and 32 are on the cloud slot (C).
- **Order:** tasks are shuffled with seed = attempt, and arms rotate per task. Attempts are barriers.
- **Cap:** 900 s through tb 0.2.18, scored as in R1/R2, including tb's 300 s thread-join window.
- **Ids:** `r3-k<k>-<arm>-<task>` (smoke `r3-s-<arm>-hello-world`), lower case.

## Validity and routing

A cell is valid under R2's conditions: a verdict, non-negative meter deltas, at least one metered request, the right commit, not an endpoint fault, and routing that matches its arm.

**Escalation evidence** has two sources:
- the `[escalate] <trigger> — continuing on …` line, which gnomon prints to the terminal, and tb keeps the terminal for every task;
- the `escalation` audit record, archived per cell with `agent-logs/audit` where the task mounts it.

| Arm | Valid routing |
|---|---|
| L | cloud == 0, local > 0, no escalate line |
| C | local == 0, cloud > 0, no escalate line |
| LR, no escalate line | cloud == 0 and local > 0. Valid: the turn ended on its own. |
| LR, one escalate line | local > 0 and cloud > 0 |

- Anything else is `misrouted`: cloud traffic without a line, a line without cloud traffic, two lines in one turn, or a line in L or C.
- **Endpoint faults** use R2's rule unchanged, and the rule is symmetric across arms. LR does not declare `apparatus`, so a dead local endpoint can't be "rescued" into a solved cell.

**Smoke controls.** All of these run on hello-world after the health probe, and all must hold before R3 starts:
- **L, C, LR** are each valid.
- **NEG** is routed all-cloud but asserted as L. It must come out `misrouted`.
- **LRF** (forced rescue) is LR with `--deadline 4s`. It must show exactly one `[escalate] budget_50` line, cloud > 0, and an `escalation` record with `carried: handover`. This proves that the trigger, the meters and the evidence parser agree.

## Endpoints

**Primary.** Two tests, Holm-adjusted over the two. Raw and Holm p are both printed.
1. **Tasks solved, LR vs L:** an exact two-sided McNemar on paired cells (same task and attempt).
2. **Cloud spend, LR vs C:** a paired two-sided sign test on per-cell Go $ (same task and attempt). It is reported with $ per solved task and the cloud share of tokens for each arm, with bootstrap intervals over tasks.

**Mechanism metrics.** Without these, a null result can't be read. All are for LR:
- the escalation rate, per trigger;
- `at_step`, and the elapsed time at escalation;
- `handover_chars`;
- the **rescue rate**: solved cells among escalated cells;
- the count of pairs where L failed and LR's escalated cell solved, and the reverse.
- **If LR escalated in fewer than 15% of its valid cells,** R3 is reported as "the trigger did not fire enough to test the question". It is not reported as "no effect".

**Secondary:**
- tasks solved, LR vs C (McNemar). This is the "approaching C" part of the hypothesis;
- $ per solved, GPU-seconds per solved, and tokens per solved, split local and cloud, for every arm;
- `usage_before` and `usage_after` from the escalation record, against the meters;
- median wall time, and cells at the cap, per arm;
- fault exposure per arm;
- the noise floor: each arm's share of tasks whose two valid attempts disagree.

**Power, stated now.** There are at most 32 pairs.
- Exact McNemar at α = 0.05 needs the discordant pairs split at least 6–0, 8–1, 10–2 or 12–3.
- With a between-attempt flip rate of about 15%, only a lift of roughly 25 points or more is detectable.
- So a non-significant primary 1 means "no lift shown", not "no lift". Primary 2 is paired per cell and has much more power.

## What counts as an answer

- **Rescue lifts local:** LR solves significantly more than L (Holm p < 0.05) and the escalation rate is at least 15%.
- **Rescue is the cheap way to near-cloud:** LR is not significantly below C on tasks solved, and spends significantly less cloud $ per cell than C.
- **Anything else** is reported as measured, with direction and intervals. No arm is declared the winner on point estimates.

## Budget

- **Cap:** $5 of Go allowance for R3. Above it, no new cell starts and the run pauses (`BUDGET-PAUSE.txt`).
- **Expected:** about $2–2.5.
  - C is about $1.35 (32 cells × R1H's ~$0.042).
  - LR costs the escalated fraction × about $0.03.
- **The Go key is shared** with R1H, R2 and P2G. The remaining allowance is checked at Final, and R3 doesn't start if the cap doesn't fit.

## To build before Final

The apparatus is derived from R2's, with the differences listed:
- `run_r3.py`;
- `gnomon-setup-r3.sh.j2`, which adds the escalate block for LR, `--deadline` for every arm, and the forced-rescue smoke arm;
- `collect_r3.py`, which parses the escalate lines and records and applies the routing table above;
- `r3-chain.sh`.

The gates are R2's: a lane released by its previous user, `BUILD-GO.txt`, and no other lane user alive.

## Differences from R2, all decided before any R3 cell

- The hybrid is dynamic (escalation), not static (a cloud plan stage).
- Every arm runs with a declared `--deadline`, and every arm runs with it equally.
- The arms are L, C and LR, without PC or CH. Those are R1H's and R2's questions.
- The routing check is conditional on the escalate line, and there is a forced-rescue smoke control.

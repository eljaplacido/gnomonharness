# LEAN: proportionate verification, A/B — stage 1 result (2026-11-01)

Design and decision rule: `PRE-REGISTRATION.md`, committed before the first
trial. Base = gnomon v0.3.2 (`68abc51`); lean = `eb56ab0`, which differs only in
the scaffold `system.md`. 16 Terminal-Bench tasks × 3 attempts, DeepSeek V4.1
Flash, 900 s cap. **96 of 96 cells valid**, every cell on its arm's commit.

| | base (v0.3.2) | lean | lean / base |
|---|---|---|---|
| solved | 34/48 (70.8% [57–82]) | 37/48 (77.1% [63–87]) | +3 |
| $ per solved task | 0.0522 | 0.0351 | **0.67** |
| median requests per task | 27 | 21 | total 0.79 |
| median output tokens per task | 21,224 | 16,042 | total **0.72** |
| prompt tokens | | | total 0.69 |
| cells lost at the time cap | 14 | 10 | −4 |

Paired tests (48 pairs):
- output tokens: lean fewer in 41, base fewer in 7, sign test p < 0.0001;
- requests: 32 vs 15, p = 0.019;
- prompt tokens: 34 vs 14, p = 0.0055;
- pass rate: base-only 2, lean-only 5, exact McNemar p = 0.45 (no difference shown).

**Decision, stage 1: passes.** All three conditions hold:
- fewer output tokens, p < 0.05;
- solves ≥ base − 2 (37 vs 34);
- no more time-cap cells than base + 2 (10 vs 14).

**What this does not show.**
- The pass-rate gain (+3) is inside noise.
- The base arm (v0.3.2) solved 70.8%, against P1-H's 75.0% for v0.3.1 on the same tasks and model. That is also inside noise, and it is the only build difference between the two runs.
- Stage 2, the same A/B on the local qwen3.6-35b, has not run. It is pre-registered to run when P1 releases the GPU. The change does not ship before it passes.

Against the P1-H peers on the same tasks and model, lean's \$0.035 per solved
task is inside their range (\$0.019–0.032 → mid-pack instead of last), with the
caveat that the peers were measured in a different run.

## Stage 2 result: local qwen3.6-35b (2026-11-02, 05:45–09:08Z)

Base v0.3.2 against lean `eb56ab0`, 16 tasks × 1 attempt, P1's local apparatus.
31 of 32 cells are valid; lean's pypi-server cell is apparatus (tb returned no
verdict).

| | base | lean |
|---|---|---|
| solved | 10/16 (62.5%) | 10/15 (66.7%) |
| paired outcome (15 pairs) | base-only 0 | lean-only 0 (identical) |
| median requests per task | 26 | 25 |
| output tokens, total | — | 0.99 × base (sign test p = 0.61) |
| requests, total | — | 1.41 × base (p = 0.79) |
| prompt tokens, total | — | 2.00 × base (p = 1.0) |
| tasks lost at the time cap | 2 | 3 |

**Decision, stage 2: passes.** The pre-registered rule asks only that lean solve
at least (base − 2) tasks on the local model. It solved the same tasks.

**What it shows about cost on the local model:** no saving, and on failing tasks
the opposite.
- **Easy tasks:** lean is cheaper, for example git-workflow-hack 672k → 154k
  prompt tokens and hf-lora-adapter 280k → 120k.
- **Tasks both arms fail:** lean keeps trying longer. tune-mjcf went from
  10 → 176 requests, mailman 6.7M → 10.5M prompt tokens, and hf-train-lora-adapter
  1.0M → 3.1M. Those three drive the 2.0× total.
- **Caveat:** with one attempt per task, these are single observations. The median request count is unchanged.

The hosted-model saving (stage 1) does not carry over to the mid-size local
model, as stage 2 was built to check. Its pass-rate guard holds.

**The lever this points to:** bounding effort on tasks that are failing. Two
candidates:
- show the model its step and time budget;
- a stop-doomed-runs decision.

Each needs its own pre-registered A/B.

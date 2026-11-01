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

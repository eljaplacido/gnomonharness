# H2: does a verify-every-requirement rule turn gnomon's fast finishes into solves? (pre-registered 2026-11-04)

Committed before any H2 cell. Later changes go in timestamped addenda.

## Why

H1 (`../h1-2026-11/summary-h1.txt`) compared v0.4.0 as released (A) with v0.4.0 + the hosted recipe (B):
- **Timeouts and speed:** the recipe removed timeouts (3/7 → 0/7) and halved output per call and wall time (median
  1,213 s → 734 s).
- **Solves:** 2/7 for A vs 1/7 for B, which is within 1, so by its rule "the solve gap is not these three mechanisms".
- **Partial correctness:** about equal. Hidden tests passed: 137/161 for A vs 142/161 for B.
- **How B ended:** it ended its turn ("answered") with 15+ minutes of the cap unused, and wrong on 6 of 7.
- **Hypothesis:** gnomon's system prompt (`.gnomon/system.md`, v0.4.0) tells the model to "Check it once … Verify in
  proportion to the task: do not build test suites, helper scripts or extra checks nobody asked for, and do not re-check
  what already passed." That is right for lean daily work. On tasks graded by hidden tests, it may make the model stop at
  "seems to work". opencode has no such rule.

## Arms (all P2G apparatus: Harbor venv and flags, model, relays, 1,800 s cap; C2D's log relay in front of each slot)

- **B:** H1's arm B unchanged (`gnomon_harbor_h1.GnomonV040Hosted`: v0.4.0 release + replay_reasoning,
  max_context_tokens 1,000,000, nudge_after_idle 100000).
- **C:** B plus one change to `.gnomon/system.md`. That sentence becomes: "Before you end the turn, check the result
  against every requirement the task states -- each file, path, format, field, edge case and command it names -- and fix
  what fails. When the work will be graded by tests you cannot see, write a quick check for each stated requirement and
  run it. Do not end the turn while a stated requirement is unverified and time remains."
  - `gnomon_harbor_h2.GnomonV040HostedVerify`: B's script plus one line. The patch refuses unless the v0.4.0 text is
    found exactly once.
  - Wire test on the v0.4.0 build: the new rule is in the system prompt and the old one is gone.
- **O:** opencode V2 (`p2_agents:OpencodeV2`, P2G's adapter). A concurrent control: attempt 1's results were
  outcome-selected and time-separated.

## Tasks and schedule

- **Tasks:** H1's 7 (opencode solved them in attempt 1), plus the 5 another peer solved in attempt 1, in attempt 1's
  order: batched-eval-parity, biped-contact-dynamics, interleaved-vigenere, sound-change-cascade, shadow-relay. That makes
  12 tasks, each its own block.
- **Schedule:** one wave per task. B, C and O run concurrently on P2G relay slots 0–2, rotated each wave. 36 cells.
- **Budget:** $7.00 of Go allowance, from the wire. A wave starts only if spent + $1.20 ≤ $7.00.

## Endpoints and decision

- **Primary, C vs B (paired by task):**
  - (1) solved, with exact McNemar on the 12 pairs;
  - (2) hidden-test pass fraction (passed / tests from the verifier's ctrf.json): the paired mean difference with a
    task-bootstrap 95% interval (10,000 resamples, seed 20261104). Tasks with no ctrf are excluded from (2) and listed.
- **Mechanism checks:**
  - C's turns contain more test/check commands after the last write than B's;
  - C's wall time is longer;
  - C caps no more than 2 more cells than B.
- **Secondary:** gnomon (B and C) vs O on the same tasks at the same time, on solved and test fraction (descriptive);
  cost and wall per arm.
- **Decision:**
  - **C beats B** (solved +2 or more, or a test-fraction interval above 0): ship the rule as an opt-in "thorough"
    surface or profile for benchmark and CI use, never as the lean default. Re-run P2G's 29 tasks with it beside v0.4.0
    as released.
  - **C ≈ B:** the stop-early rule is not the gap. Report it, and compare B vs O traces for the next mechanism.
  - **C worse:** report it.
- **What this does not test:** whether the rule hurts daily-dev token budgets (C is opt-in by construction), and attribution
  inside the recipe (H1's factorial follow-up).

# C2D: why gnomon's steps are long on P2G (a diagnosis, pre-registered 2026-11-04)

Written and committed before any C2D data. Any later change goes in a timestamped addendum below; nothing above
it is edited.

## Context

- **P2G attempt 1** (Terminal-Bench 4.0, 29 tasks, deepseek-v4.1-flash via OpenCode Go, 1,800 s cap):
  - gnomon **v0.3.1** solved 1/29; opencode V2 and codex solved 7 each.
  - The root-cause notes rank the causes:
    - **C1, transport:** unstreamed calls cut at 300 s. Fixed in v0.4.0 (#114, #122).
    - **C2, long steps:** output per call is 2–8× opencode's.
    - **C3, context:** trimmed to about 39k tokens every 32 steps.
- **v0.4.0 probe** (2 tasks, 2026-11-04 06:20–07:24Z, $0.94):
  - C1 is gone.
  - Both cells still hit the cap, at 3,924 and 6,206 output tokens per call against opencode's 1,415 and 970. **C2 is
    now the dominant open cause.**
- **Exploratory, before this registration:**
  - **Step-1 A/B** (12 calls, $0.003): gnomon v0.4.0's captured first request on ontology-kg-querying. The first
    call has **0 reasoning tokens** and about 90 output tokens, with or without gnomon's temperature 0.3 / top_p 0.95.
  - **Attempt-1 audit timestamps:** several 100–245 s gaps precede short commands (a `sed -n`, a one-line
    `python -c`). So mid-task reasoning is the suspect, not file payloads alone. This is not established; that is
    what this study is for.
- **opencode V2's configuration in P2G** (`opencode-config.json`, attempt 1): an `@ai-sdk/openai-compatible` provider
  with no model options. What it actually puts on the wire (sampling, output limit, reasoning replay, system prompt)
  has never been captured.

## Questions

1. **Q1:** Mid-task, where do gnomon's output tokens go: reasoning, prose, or tool arguments? And opencode's?
2. **Q2:** What does opencode V2 send to the model?
3. **Q3:** On the same conversation states, which single change cuts gnomon's output per call?

## Stage 1: capture (4 Harbor cells)

- **Arms, both on P2G's unchanged apparatus** (Harbor venv and flags, model, slot relays, 1,800 s cap, `--force-build`):
  - gnomon **v0.4.0** (the release, `gnomon_harbor_v040:GnomonV040`, release defaults);
  - **opencode V2** (`p2_agents:OpencodeV2`, as in attempt 1).
- **Tasks:**
  - `atrx-vep-crispr`: opencode solved it in attempt 1; gnomon capped on v0.3.1 and v0.4.0.
  - `ontology-kg-querying`: opencode finished in 606 s, unsolved; gnomon capped on both builds.
- **Waves:** one wave per task. gnomon runs on relay slot 0 and opencode on slot 1, concurrently, with a 20 s stagger.
- **The only addition is `apparatus/log-relay.mjs`:**
  - one per cell, in front of the slot relay;
  - it stores every request body and reply stream (`runs/<cell>/wire/`) and a per-call summary (`calls.jsonl`);
  - it observes only, and the slot relay still meters and bills;
  - it aborts upstream when its client disconnects;
  - tested 2026-11-04 07:34Z (1 call, $0.0002), and containers reach it on 172.17.0.1:4720–4721.
- **Contention:** stage 1 starts only after M2's gx10 chain (pid 1041808) has exited and the host has at least 24 GB
  available. This keeps it from contending with M2's containers or its unified-memory model lane.
- **Validity:** a cell with 0 logged calls, or with more than 10% of its calls non-200, is an apparatus failure and
  is re-run once.
- **Use:** stage 1 is descriptive (n = 1 per arm and task). It is used for Q1, Q2 and as stage 2's input, and supports
  no claim about scores.

## Stage 2: single-call lever replay (cheap, paired)

- **States, rule S:** every gnomon stage-1 call that returned 200, was not aborted, and wrote ≥ 2,000 completion
  tokens. If there are more than 12, take 6 per cell, evenly spaced in call order. A cell with fewer than 6 gives its
  spare places to the other.
- **Variants:** each is one change from the stored request body. Definitions are in `apparatus/replay_c2d.py`.

| | change | the lever it tests |
|---|---|---|
| V0 | none (re-sampled) | the noise reference |
| V1 | `temperature` and `top_p` removed | gnomon's role sampling |
| V2 | each earlier assistant message carries the `reasoning_content` its reply streamed | reasoning replay (gnomon drops it on this endpoint by default) |
| V3 | opencode's system prompt (its first stage-1 request, same task) replaces gnomon's first system message; tools unchanged | gnomon's system prompt |
| V4 | system messages after the first non-system message removed | gnomon's mid-turn steering (nudges, convergence pushes) |

- V2 is not applicable to a state with no earlier reasoning, and V4 to a state with no late system message. Those
  states are left out of that variant's analysis.
- **Sampling:** 3 samples per state and variant, in a seeded random order (seed 7), 3 at a time, through P2G relay
  slot 2.
- **Primary metric:** completion tokens per call.
  - Per state, take the mean over 3 samples and the ratio to V0.
  - Across states, take the geometric mean of the ratios, with a bootstrap 95% interval over states (10,000
    resamples, seed 11).
- **Verdicts:**
  - **EXPLAINS:** geometric-mean ratio ≤ 0.70 and interval upper bound < 1.0.
  - **reduces:** upper bound < 1.0.
  - otherwise **no effect shown**.
- **Secondary:** reasoning-token share and the prose/tool-argument split, per variant.

## Budget (Go allowance, separate from P2G's paused gate)

| | |
|---|---|
| Stage 1 | ≤ $2.50; a wave starts only if spent + $1.20 ≤ $2.50 |
| Stage 2 | ≤ $1.50; checked against the slot counter before every call |
| Already spent on this diagnosis | $0.94 (v0.4.0 probe) + $0.003 (step-1 A/B) + $0.0002 (relay test) |

## What follows each outcome (stated now)

- **A lever EXPLAINS, and it is a gnomon default:**
  1. A gnomon PR changes the default, or makes it per-endpoint.
  2. A Harbor A/B, v0.4.0 against the PR build on 4 P2G tasks, runs under its own pre-registered amendment.
  3. The P2G gnomon arm is re-pinned to the release that carries the fix, and all 29 tasks are re-run.
- **Two or more levers reduce, none EXPLAINS alone:** the Harbor A/B tests their combination.
- **No lever has an effect:** this is reported as such. The P2G gnomon arm re-runs on v0.4.0 as released (the drafted
  amendment, capped so it completes). C3 (the context window) is fixed separately.
- **In every case:** the attempt-1 v0.3.1 row stays in every table; rows are never pooled.

## Out of scope

- **C3:** the 65,536-token default window for a hosted endpoint is known. Its fix is a separate PR.
- **C4:** `risk-scorer-replay`'s unwritable root.
- **Other peers.**
- **Any score claim.**

## Addendum 1 (2026-11-04T10:16:30Z), after stage 1 and before any stage-2 call

- **Runner bug:** `run_c2d.py` called `run_p2g.trial_of`, which assumes results live under `p2g-2026-11/`. So all 4 cells
  raised after Harbor returned. Each log relay was still stopped (its `finally` ran), and Harbor's job files and the
  wire logs are complete, but no `cell.json` was written and the waves booked $0.
- **Recovery:** `apparatus/finalize_c2d.py` writes each `cell.json` from Harbor's `result.json` and the wire log's
  per-reply provider allowance. The slot-counter deltas were never taken.
- **Stage 1 spend (wire): $1.2729**, within the $2.50 cap. The second wave started on a reserve check that saw $0, but
  the two waves together stayed within the cap.
- **Outcomes:**
  - gnomon v0.4.0: atrx 0 (cap), ontology 0 (cap).
  - opencode V2: atrx 1, ontology 0 (finished in time).
- **Stage 2 states (rule S):** pools of 31 and 34 calls ≥ 2,000 tokens, 6 states taken from each. All 5 variants apply to
  all 12 states, so 180 calls are planned.
- **Nothing about stage 2 changes.**

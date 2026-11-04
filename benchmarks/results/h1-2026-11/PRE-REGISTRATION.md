# H1: does a hosted-model recipe close gnomon's long-task gap on Terminal-Bench 4.0? (pre-registered 2026-11-04)

Committed before any H1 cell. Later changes go in timestamped addenda; nothing above them is edited.

## Why

- **P2G attempt 1:** gnomon v0.3.1 solved 1/29, against 7/29 for both opencode V2 and codex. Same model
  (deepseek-v4.1-flash via OpenCode Go), same 1,800 s cap.
- **C2D** (`../c2d-2026-11/`, 2026-11-04) on v0.4.0, on 2 tasks:
  - **Outcomes:** gnomon timed out on both. opencode solved atrx and finished ontology unsolved in time.
  - **Output per call:** about 2× opencode's. Both are about 90% hidden reasoning.
- **C2D also recorded three trajectory-level differences:**
  1. **Reasoning not replayed:** opencode sends the model's `reasoning_content` back on 54/56 and 57/60 calls; gnomon on 0/78 and 0/78.
  2. **Nudges:** gnomon's idle nudge ("act on it now") fired from call 11, and 68/78 and 72/78 of its requests carried it.
  3. **Context window:** gnomon's context is capped by the 65,536-token default window, peaking at 75k and 112k; opencode's grows to 160k and 172k.
- **C2D stage 2 (single-call replay):** on the same 12 recorded states, none of these levers had a *direct* effect on
  step length. Ratios vs as-sent: sampling removed 1.05, reasoning replayed 1.06, opencode's prompt 0.96, nudges
  removed 0.83; every interval crosses 1.
- **The remaining hypothesis is an *indirect* effect, through the trajectory:**
  - what the model keeps of its own work (reasoning, context);
  - when it is pushed to act (nudges);
  - which determine the state at step k, how long it reasons there, whether it converges, and whether it times out.

  Only a whole-run intervention can test that.

## Design

- **Arms**, both the v0.4.0 release (tag be4fc0d8), installed and pinned by `gnomon_harbor_v040`:
  - **A:** release defaults, exactly the drafted P2G amendment's arm (`GnomonV040`).
  - **B:** A plus the hosted-model recipe, three surface lines (`apparatus/gnomon_harbor_h1.py`; its script is A's
    plus one line, checked):
    - `[endpoints.bench] replay_reasoning = true`
    - `[endpoints.bench] max_context_tokens = 1000000` (Go's published window)
    - `[turn] nudge_after_idle = 100000` (the idle nudge never fires)
  - This is a **recipe**: three changes at once, on purpose. H1 asks whether the trajectory gap is closable at all.
    Attribution is a follow-up (below), not an H1 claim.
- **Wire test:** run offline against a fake server with the v0.4.0 build. The patch applies to v0.4.0's own `init`, the
  second request's assistant message carries `reasoning_content`, and the trust gate does not clamp.
- **Tasks:** the 7 tasks opencode V2 solved in P2G attempt 1, in attempt 1's order (`random.Random(1)`): session-window-debug,
  fin-saccr-rwa, mvcc-lsm-compaction, atrx-vep-crispr, react-lead-form, wal-recovery-ordering, html-js-filter.
  - Selection is on a peer's outcome, never gnomon's; both arms face the same set.
  - This is a solvable-by-a-peer set, so absolute rates are not P2G rates.
- **Pairing:** one wave per task. A and B run at the same time, one on P2G relay slot 0 and one on slot 1, swapped every
  wave. Provider load, time of day and host load are therefore shared within a pair.
- **Apparatus:** P2G's Harbor venv and flags, model, slot relays and 1,800 s cap. C2D's `log-relay.mjs` sits in front
  of each slot, so every request and reply is recorded. Cell ids are `h1-k1-gnomon{A,B}-<task>`.
- **Budget:** $5.00 of Go allowance, booked from the wire. A wave starts only if spent + $1.00 ≤ $5.00.
  - Expected: about $3 off-peak, or about $5–6 inside the 2× peak windows (weekdays 01–04 and 06–10 UTC).
- **Contention:** R3R's task containers may share the docker host when the RTX lane is up. Load is recorded per cell.

## Endpoints

- **Mechanism checks (must hold, or the cell is not evidence about B):**
  - B: requests carry `reasoning_content` after the first reasoned tool call;
  - B: no late system messages from the idle nudge;
  - B: some request's prompt exceeds 65,536 tokens, or the turn never needed it (reported).
  - A: no replay, and the nudge as released.
- **Primary (descriptive at n = 7):** solved and capped counts per arm. Paired table and exact McNemar on the 7 pairs.
  The MDE at n = 7 is very large; only an effect on the scale of 0/7 → 4/7 can show.
- **Mechanism metrics:** per cell, calls, output tokens per call (mean, median), reasoning share, wall per call and
  calls to the first passing self-check. B is expected to move them toward opencode's C2D values.
- **Decision, stated now:**
  - **B solves ≥ 2 more tasks than A and caps fewer:** the recipe closes a real part of the gap.
    1. Ship it as opt-in settings and a documented hosted recipe.
    2. Run the attribution follow-up.
    3. Re-run all 29 P2G tasks with the recipe arm beside a v0.4.0 as-released arm.
  - **B ≈ A (within 1):** the gap is not these three mechanisms. Say so, and look elsewhere (per-step reasoning
    effort, prompt and trajectory differences, environment).
  - **B < A:** the recipe hurts. Report it.

## Causal analysis plan (pre-registered here, run after the cells)

- **DAG:**
  - recipe settings (replay R, window W, nudge N)
  - → mediators per step: reasoning retained in history; context tokens; nudge present
  - → step length (reasoning tokens) and action quality
  - → steps to convergence
  - → timeout and reward.
- **Confounders:**
  - task difficulty: blocked, since each task is its own pair;
  - provider latency and load: shared within a pair, and measured as TTFT per call;
  - host load: recorded.
- **Mediation:** per-call regressions of output tokens on the logged mediators, with task fixed effects. Report how much
  of A→B's difference in output per call and calls-to-cap is carried by each mediator.
  - This is exploratory at this n and is labelled so.
- **Attribution follow-up, only if the decision above says so:** a factorial over R × W × N (or a resolution-IV
  fraction) on the same tasks, under its own amendment. Its priors come from the observational causal analysis of
  existing trails (nudge timing is endogenous to difficulty; adjust for it), run separately and committed before the
  follow-up's data.

## Not in scope

- Sampling (stage 2 showed no direct effect).
- Other peers (no new peer cells).
- Any claim beyond these 7 tasks.

## Addendum 1 (2026-11-04T12:05:48Z): launch fix, before any valid H1 cell

- **What failed:** the first launch (12:04Z) failed for arm B at import. `run_h1.py` passed Harbor only P2G's apparatus on
  `PYTHONPATH`, so `gnomon_harbor_h1` was not found (0 requests).
- **Arm A:** its pair was stopped by the operator about a minute in, after 5 model calls.
- **Where they went:** both cells moved to `runs-aborted/` and `jobs-aborted/` with reasons.
- **Fix:** `run_h1.py` now prepends its own apparatus directory to Harbor's `PYTHONPATH`. Both adapters import under
  Harbor's venv.
- **Re-run:** the wave is re-run from the start. Nothing else changes.

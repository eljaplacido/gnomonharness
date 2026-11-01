# Pre-registration — P2: nine harnesses on Terminal-Bench 4.0, one hosted model

**Written 2026-10-31 ~20:50Z, before the oracle check and before any P2 cell.**
The cost probe (`PROBE-RESULT.md`) came first. The user chose the size (30 tasks
× 3 attempts), the concurrency (6 slots on the hub) and the cap (30 minutes).

## Question

On the same hosted model, the same tasks and the same cap, how does gnomon
compare with eight peer harnesses on:
- resolving Terminal-Bench 4.0 tasks;
- what each resolved task costs;
- consistency over three attempts?

## Design

| | |
|---|---|
| arms (pinned, as probed) | gnomon 0.3.1 (release tarballs, checksum-verified) · Claude Code 2.1.316 · Codex 0.166.0 · opencode V2 2.2.5 (`run --standalone --auto`) · OpenHands SDK 1.59.0 · aider 0.86.2 · goose 1.57.0 · mini-swe-agent 2.4.6 with litellm 1.105.7 · pi 0.85.1 |
| model | `deepseek-v4.1-flash` on the user's OpenCode Go plan, for every arm, through `relay-go.mjs` (see the probe pre-registration for what the relay does and why) |
| tasks | 30 of TB 4.0's 63 CPU-only tasks: the 30 lowest `sha256("p2-2026-11:" + name)`. Chosen by name, never by outcome. The 3 GPU tasks are excluded. List: `apparatus/tasks-p2.json` |
| task validity | before any arm, each task runs once with Harbor's `oracle` agent (the reference solution, no model). A task whose oracle does not score 1 is broken. It is replaced by the next task in hash order, also oracle-checked, and the replacement is logged here |
| attempts | 3 per (arm, task): 810 cells |
| cap | 1,800 s of agent time (`--agent-timeout-multiplier 0.0625` against TB 4.0's 8 h). Not leaderboard-comparable, and reported as such. Every arm's instruction still says "You have 28800 seconds"; that is the same for all |
| order | attempt by attempt, each attempt a barrier. Within an attempt, tasks are shuffled with seed = attempt, and arms rotate per task. Cells are dispatched in that order to 6 slots |
| concurrency | 6 slots. Each slot has its own relay instance and runs one cell at a time, so per-cell metering is exact. A cell reserves its task's declared memory from a 24 GB budget |
| runner | Harbor 0.25.0 on the hub (Windows, Docker Desktop, amd64), `apparatus/run_p2.py` |

## Scoring, fixed now

- **Valid cell:** Harbor recorded a verifier reward, and the arm made at least
  one model request that returned usage. Anything else is apparatus: no verdict,
  an agent that never reached the model, or a crashed install. It is counted
  per arm and reported, and never scored.
- **Resolved:** verifier reward ≥ 1. Mean reward is reported beside it.
- **A pair is compared only where both arms have a valid cell** for that
  (task, attempt).
- A cell that hits the cap is a valid, unresolved cell (tb's convention),
  counted per arm.

## Analysis, fixed now

1. **Per arm:** resolved / valid, with a 95% Wilson interval; mean reward;
   apparatus count; cap hits.
2. **Paired, gnomon vs each of the 8 peers:** an exact McNemar test over the
   (task, attempt) cells both completed.
   - Three-valued: fewer than 6 discordant pairs is "cannot tell", never "no
     difference".
   - Raw p is reported with the Holm-adjusted p over the 8 comparisons. A
     difference is claimed only if the Holm-adjusted p < 0.05.
3. **Consistency, per arm:** pass@3 (any of 3 attempts) and pass^3 (all 3), and
   how many tasks flip across attempts. A between-arm difference smaller than an
   arm's own flipping is not read as one.
4. **Cost, per arm:**
   - Go allowance per valid cell and per **resolved task** (total allowance /
     resolved cells), listed first;
   - tokens per cell. Prompt tokens for the Anthropic-format arm are
     input + cache reads, as the probe found;
   - prompt-cache share.
   - Paired against gnomon: an exact sign test over cells both completed, on
     which spent less allowance.
5. **Go compatibility, per arm:** requests that carried the client's own
   `x-opencode-session` and user agent.

## Gates, fixed now

- **Floor and ceiling, after attempt 1** (270 cells): if the pooled resolved
  share of valid cells is below 10% or above 90%, attempts 2–3 are not run. The
  design is then at the floor or the ceiling and cannot resolve differences.
  The task set is reconsidered and this file amended. `run_p2.py` enforces it.
- **Budget:** about $30–50 of Go allowance expected (probe: $0.034 median per
  cell). If attempt 1 alone spends more than $25, the run pauses for the
  user's decision.

## What it can and cannot resolve

- 90 paired cells per comparison resolve differences of roughly 15–20
  percentage points, depending on how often the arms disagree. Smaller gaps
  will read "cannot tell".
- One model. A harness tuned for a different model family is measured off its
  home ground, and so is gnomon.
- Six concurrent cells share the hub and one Go key. Rate limiting (4xx/5xx
  from Go) is counted per cell and per arm. A cell whose arm received no
  successful model response is apparatus.

## Known asymmetries, stated, not removed

- Each arm runs through its Harbor adapter's own prompt framing. That is what
  the harness looks like under Harbor.
- Four arms needed our pinned subclasses (gnomon, opencode V2, aider,
  mini-swe-agent). The probe pre-registration says why for each. The other five
  are Harbor's stock adapters with a pinned version.
- Install time is outside the agent cap in Harbor (setup has its own timeout),
  unlike tb 0.2.18 in P1.

## Amendment, 2026-10-31 ~23:30Z, before any full-run cell: relay upstream guard

`apparatus/relay-go.mjs` now refuses any request target outside the configured
upstream (403, counted as `refused_off_upstream`). G2b's negative control
showed that an absolute-form target would otherwise have received the injected
Go key, and an `http:` target crashed the relay. Cells are unaffected: harnesses
send origin-form targets. Probe cells ran without the guard; nothing in their
traffic reached another host (each cell's requests all returned Go usage).

## The oracle check, 2026-11-01 06:44–07:11Z, before any arm

Harbor's `oracle` agent (the reference solution, no model) ran each of the 30
selected tasks once on the hub.
- **29 scored 1.**
- **`nextjs-performance` scored 0.** Its own reference solution fails, so it is
  broken and was replaced by the next task in hash order,
  `freecad-platform-drawing`. That task's oracle scored 1 (295 s).
- The final 30 are in `apparatus/tasks-p2.json`; the oracle records are in
  `runs-p2/oracle-*` on the hub.
- Docker Desktop had not started after the hub's reboot. It was started in the
  user's session through a one-off scheduled task, which was removed afterwards.

## Amendment, 2026-11-01T10:37Z: cumulative-layout-shift excluded from all arms

Harbor 0.25.0 refuses to start an agent on this task unless the agent
declares `capabilities.skills = True`. The aider, mini-swe-agent and gnomon
adapters do not, so those cells end in 6–7 s with `ValueError: Agent … does
not support skills` and no model request. The oracle check ran no agent, so
it could not see this. Under the symmetry rule the task is excluded from
every arm, including those that ran it. The run is not restarted; the
collector drops the task. Scoring now uses 29 tasks.

# Benchmark program, November 2026

What gnomon is measured on next, against whom, and which question each run
settles. Every run has its own pre-registration, written before its first trial.
Each is reported whether gnomon wins or loses: a win chosen after seeing the
data does not survive the first re-run.

**Standing constraints, from the user:**
- Benchmark the latest gnomon against peer harnesses and against the methods
  discussed (decision models; conformal, Bayesian and causal).
- Keep gnomon's own character: governance, reliability, transparency and
  traceability; lean on tokens and context; low latency; hybrid local/cloud. It
  should also work as a governance and orchestration layer *between* harnesses,
  not only as one.
- Daily dev must work perfectly whatever else is added.
- Every result is checked against the Six Rules (README). Any drift is measured
  and justified, never silent.

## The runs

| # | Run | Arms | Settles | Host / model | Status |
|---|---|---|---|---|---|
| **H7** | In-loop decision shadow | gnomon (`800ee65`) with `[shadow]` | Does the conformal abort hold inside the live loop, not just in replay? | gx10, local qwen3.6-35b | **done** 15:40Z: 44 trials, 17 resolved. Abort readout (agentcenter): no rates; the main key has 14 passing runs and needs 20. AUROC h2o 0.71 [0.50, 0.87], d1-3b 0.58 [0.38, 0.77] |
| **P1** | Peers, local model | gnomon v0.3.1, mini-swe-agent 2.4.6, goose 1.57.0, Qwen Code 0.26.4, opencode V2 2.2.5 (`--auto`) | Pass rate, tokens per resolved task, prompt-cache share, wall-clock, consistency over 3 attempts, timeout share | gx10, local qwen3.6-35b | pre-registered (`benchmarks/results/peers-2026-11/`). The smoke caught five apparatus faults, all fixed and logged as amendments. Floor gate passed: gnomon 9/16 in H7 |
| **P2** | Peers, hosted model | gnomon (local-only, and hybrid `frontier_plan`), opencode V2, OpenHands, Codex CLI, Aider, pi, Claude Code, goose | Same endpoints on a Terminal-Bench 4.0 subset (capped timeout, so not leaderboard-comparable), and cost per resolved task | hub (x86): Harbor for the TB 4.0 tasks, AgentLab's LiteLLM gateway metering every arm; hosted models under the user's OpenCode license. The user authorized Docker on the hub | cost probe pre-registered (`benchmarks/results/p2-2026-11/`); relay verified on all three APIs; first gnomon cell exposed compressed responses that could not be metered, fixed before the remaining arms |
| **P2-DM** | Decision-model routing, inside P2 | gnomon hybrid with a fixed profile, against gnomon hybrid with a decision model choosing local or cloud per turn | Does decision-model escalation lower cost per resolved task without losing passes? | as P2 | to pre-register |
| **G1** | Governance layer over other harnesses | each peer harness, alone and under `gnomon check` | Planted temptations: writes outside scope, edits to its own config, weakened tests, destructive shell. What the harness's own safeguards catch, what `gnomon check` adds, and false alarms, all from repository state | gx10 or hub | to design |
| **G2** | Property suites on the current release, extended to peers | gnomon, plus peers where a suite applies | Re-measures the published properties: containment, injection, determinism, auditability, degradations, silent success | gx10 | **model-free half done** (`benchmarks/results/g2-2026-11/`, v0.3.1): fidelity 13/13, degradations 14/14, fault disclosure 8/8, silent success 0/11, all as published. Determinism measured 10/10 only after repairing the suite: it had not parsed since 2026-09-07 yet printed 9/10 and exited 0 (fix: PR #59). Containment and injection need a model, so they come after P1 |
| **UX1** | Daily-dev overhead | every P1/P2 harness against one fake model server with fixed latency | Harness-only cost: cold start, time to first output, ms per turn, interruptions per task, recovery after a crash or Ctrl-C, same agent after a fresh clone | gx10, no GPU | pre-registered (`benchmarks/results/ux1-2026-11/`); runner probed on all five arms |
| **UX2** | Shadow cost in daily dev | gnomon with `[shadow]` on and off, real model | Does the shadow add latency to the user's own sessions? If it does, it comes off the daily surfaces | gx10, in a GPU gap | to run |

**Peers left out, and why:**
- Hermes and OpenClaw: always-on personal agents, not coding harnesses.
- TrueForge: enterprise CRM, judged on its vendor's own 14-task benchmark.
- "MetaHarness": the published numbers attributed to it could not be found. Two
  unrelated projects share the name.

## Decision models: the roles each run tests

| Role | Allowed form | Tested in |
|---|---|---|
| Stop a doomed run | Control flow only (abort, nudge); conformal threshold bound to `calib_key` | H7 (in-loop), P1 (tokens saved on failing runs) |
| Local vs cloud escalation | Chooses the route; records it | P2-DM |
| Role or harness choice | Suggests a shortlist; a declared rule or a person decides | the shadow on the user's daily surfaces (role records) |
| Governance flag | Tightens only: adds a prompt or a refusal, never removes one | the shadow on daily surfaces (approval records), G1 |
| Verdicts, outcome buckets | **Not allowed** (Rule 4) | — |

## The methods verdict, owed after H7, P1 and P2

| Method | What is known now | Settled by |
|---|---|---|
| Conformal thresholds | Coverage holds within one configuration (0.88–0.93). They break when the model × task cell changes, so they need the hash binding | H7 in-loop, then P1/P2 |
| Bayesian expected-loss gate | Did not beat simpler thresholds in the bench (H3) | P2-DM, the only asymmetric-cost decision on the list |
| Causal methods | gnomon's one-variable-per-surface-hash arms already give interventional evidence. The causal check that mattered retired a feature: "broken setups" were model × task confounds | no further run planned; the verdict states it |

The verdict goes in a table — keep, drop or needs more — with the measured
benefit beside each.

## Published claims this replaces or extends

The gnomonharness.com page still says v0.2.0. What changes:
- **The OpenCode tie** (50.0% vs 47.1%) becomes P1 with opencode V2 under equal
  consent. That is the "definitive version" the 2026-09-02 report named and never
  ran.
- **"goose is not a valid baseline"** becomes P1 with goose 1.57.0.
- **pass^k** becomes P1's three attempts for every arm.
- **"4.66x less context on the wire"** becomes P1/P2 tokens per resolved task.
- **The property suites** are re-run in G2.
- **New:** P2, G1, UX1 and the methods verdict.

The site is updated only from committed result files, losses included.

## Constitution, per run

- **H7, P1, P2, UX1, G2:** measurement only; gnomon unchanged. The one setting
  under test, `[shadow]`, is log-only by test.
- **P2-DM:** a decision model changes the route. It is declared in the surface,
  recorded per turn, and not bit-reproducible, stated as summary compaction's is.
  It is promoted only on a measured win.
- **G1:** `gnomon check` takes its rules from the base branch and seals its
  verdict in the audit trail. Consistent.
- **Orchestrating external harnesses** (a proposal, not built) would be the first
  deliberate drift. gnomon can pin an external harness's invocation, not its
  behaviour, the same limit it declares for MCP. It ships only with that limit
  in the record and measured.

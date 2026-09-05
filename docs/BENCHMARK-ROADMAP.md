# Benchmark roadmap

What gnomon's benchmarks can validly claim today, where they can't yet, and the
program to close the gap. Companion to [BENCHMARKS.md](BENCHMARKS.md) and
[BENCHMARK-POSTMORTEM.md](BENCHMARK-POSTMORTEM.md).

## Open benchmarks (Aug 2026)

| Suite | Measures | Supports |
|---|---|---|
| Internal (`benchmarks/harness.py`) | Token-efficiency + quality vs opencode/pi/omp | ~~13–43× leaner than opencode~~ — **RETRACTED**. That figure multiplied a token ratio by a *pass-rate* ratio from a suite whose comparative tables the post-mortem retracted. Superseded 2026-09-05 by [context-cost](../benchmarks/context-cost/), which counts bytes off the wire against a recording endpoint: **4.66×** total, 3.85× on messages |
| [Terminal-Bench 2026-08](../benchmarks/results/terminal-bench-2026-08/) | Capability vs goose/opencode, cheap cloud models, 8 tasks | **gnomon ≈ goose (parity) > opencode**, tested cell, default surface |
| [DFlash 2026-08](../benchmarks/results/dflash-2026-08/) | Local spec-decode speed, output-exact | **Free 1.3–1.5× wall-clock**, quality-neutral |

## Validly claimable today (with caveats)

Token-efficiency vs opencode/pi/omp; capability **non-inferiority** vs goose;
integrity (three-bucket, settle()); a free local speedup. Every one is scoped
"in the tested cell, default surface."

**Not yet claimable:** a capability *win* (n too small, p≈0.80); efficiency vs
goose (goose exposes no usage); safety/containment superiority (only unit-tested);
any large-repo, multi-language, or frontier-model-at-scale result.

## Gaps that block stronger claims

1. **Statistical power** — 7–24 valid trials/arm; differences are noise. Ranking claims unsupported.
2. **Independence** — gnomon authored the benchmark and chose the task subset. Biggest reviewer objection.
3. **Version currency** — ~~the current family is Terminal-Bench 3.0/4.0~~ **Corrected
   2026-09-01: that was unsupported.** `terminal-bench` **0.2.18 is the latest release
   on PyPI** (0.2.13–0.2.18 available, nothing higher), and BENCHMARKS.md already said
   so — "there is no 2.x or 3.x task set available through this channel". Two committed
   documents contradicted each other and the wrong one got repeated.

   What is actually true: the framework is current; the *dataset* is the variable. Early
   runs used `terminal-bench-core==0.1.1` via the registry, which **no longer resolves**
   (`registry.tbench.ai` has no DNS). The 2026-09-01 runs use the GitHub repo's
   `original-tasks` at HEAD `d28711d` (2026-07-10) — **241 tasks**, the current set.

   The live remaining gap is **coverage, not currency**: our arms score a 46-task
   pre-registered subset, not the full 241. That is a sample of the benchmark and must
   be labelled as one.
4. **Task breadth** — 8 self-selected, timeout-prone, Python-only; 2 non-discriminating. No large-repo / long-horizon (gnomon's weak axis).
5. **Efficiency vs goose unmeasured** — the headline claim has a hole against the strongest peer.
6. **Model coverage** — cheap cloud + one guardrail; claims are cell-specific.
7. **Safety/containment only unit-tested** — the actual differentiator, never benchmarked vs peers.
8. **DFlash timeout-flip not demonstrated** — lever quantified, conversion not shown.

## Program (priority-ordered)

**Tier 1 — make existing claims valid**
- **B1 · Independence + currency** ✅ *(first pass, [terminal-bench-current-2026-08](../benchmarks/results/terminal-bench-current-2026-08/))* — gnomon on the CURRENT tb (0.2.18, live task set), cheapest model, default surface: **66.7% valid** on a 16-task easier spread, **29.5% valid** on a broader 48-task sample; $0.30 total. Strongly sample-dependent — the low figure is a weak-model-on-hard-tasks floor, not a harness ceiling. Still open: full-set run, a frontier-model arm, goose/opencode arms, more attempts.
- **B2 · Power:** pre-register arms; trial counts fixed to a target CI (±10pt @95%); always ship the per-task matrix.
- **B3 · Cost/efficiency** ✅ *(done, [cost-2026-08](../benchmarks/results/cost-2026-08/))* — from measured tokens: opencode costs 3.6×–10.7× more than gnomon to run the suite. Still open: a shared usage-logging endpoint to include **goose**.

**Tier 2 — differentiator + weak axis**
- **B4 · Safety/containment** ✅ *(first pass, [containment-2026-08](../benchmarks/results/containment-2026-08/))* — gnomon contains **15/15** model-driven boundary attacks. Still open: the **vs-peers** comparison (do opencode/pi contain the same attacks?).
- **B5 · Large-repo / long-horizon:** stress the sliding-window gap honestly.
- **B6 · Multi-language:** JS/Rust/Go/shell, not just Python.

**Tier 3 — depth**
- **B7 · DFlash timeout-flip** on genuinely long/hard tasks at the real cap.
- **B8 · Frontier-model arm** at meaningful n.
- **B9 · Determinism** benchmark across harnesses.

## Immediate order of work

1. **B3** (cost comparison) — local models, no cloud spend, directly answers the token/$ point.
2. **B1** (re-run on current Terminal-Bench) — needs the framework install + Docker + a model budget; schedule deliberately, not unattended.
3. **B4** (containment) — turns the differentiator into a number.


## Attempted and learned (Aug 2026)

**Model-scaling ladder + hybrid — attempted, inconclusive (~$2.5 spent, stopped).**
On the *current* Terminal-Bench's hard tasks (the cheap model's failures), the
affordable tiers all cluster: deepseek-v4-flash 2/10, deepseek-v4-pro 1/10,
claude-sonnet-5 timed out ($1.87/task). No clean "cheap fails / strong passes"
band, so **scaling did not show** — it needs frontier-of-frontier models AND a
curated *medium*-difficulty task set (hard-for-cheap but solvable-by-strong),
which the hard-task selection here was not. The **local+cloud hybrid** (frontier
coordinator plans + delegates, local implementor executes) — the network is
fine (a tb container reaches the host :18080), but the coordinator↔implementor
delegation **flailed** (9 min on hello-world, unresolved). That is a gnomon-side
fix (delegation with a weak local implementor), not a benchmark. **Not
committed** as a result — a negative/broken run proves nothing and would mislead.
Redo when: (a) a small frontier budget for a curated medium-task band, and (b)
the hybrid delegation is debugged with a stronger local model.

# Benchmark roadmap

What gnomon's benchmarks can validly claim today, where they can't yet, and the
program to close the gap. Companion to [BENCHMARKS.md](BENCHMARKS.md) and
[BENCHMARK-POSTMORTEM.md](BENCHMARK-POSTMORTEM.md).

## Open benchmarks (Aug 2026)

| Suite | Measures | Supports |
|---|---|---|
| Internal (`benchmarks/harness.py`) | Token-efficiency + quality vs opencode/pi/omp | **13–43× leaner than opencode** (Pareto win). Harness-comparison tables partly **retracted** by the post-mortem |
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
3. **Version currency** — ran on `terminal-bench-core==0.1.1`; the current family is Terminal-Bench 3.0/4.0. Not comparable to the live leaderboard.
4. **Task breadth** — 8 self-selected, timeout-prone, Python-only; 2 non-discriminating. No large-repo / long-horizon (gnomon's weak axis).
5. **Efficiency vs goose unmeasured** — the headline claim has a hole against the strongest peer.
6. **Model coverage** — cheap cloud + one guardrail; claims are cell-specific.
7. **Safety/containment only unit-tested** — the actual differentiator, never benchmarked vs peers.
8. **DFlash timeout-flip not demonstrated** — lever quantified, conversion not shown.

## Program (priority-ordered)

**Tier 1 — make existing claims valid**
- **B1 · Independence + currency** ✅ *(first pass, [terminal-bench-current-2026-08](../benchmarks/results/terminal-bench-current-2026-08/))* — gnomon on the CURRENT tb (0.2.18, live task set): 10/16 = 62.5% on a stratified sample, cheapest model, $0.06. Still open: full-set run, goose/opencode arms, more attempts.
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

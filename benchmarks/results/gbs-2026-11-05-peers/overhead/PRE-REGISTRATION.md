# Pre-registration: GBS-OVERHEAD 0.2 (draft): opencode v2.2.5 and gnomon v0.4.2: CPU and wall per trial, cold-process, Linux aarch64

Committed before the first measured trial. Deviations are logged below, with time.

Spec: [OVERHEAD.md](../../../../docs/benchmarks/OVERHEAD.md) 0.2 (draft), with
[REPORTING.md](../../../../docs/benchmarks/REPORTING.md) 0.2 (draft). Level: **harness** (scripted
fake model). Result type: **profile** with paired within-harness differences against the null
harness; the two harnesses are reported side by side, not as a pre-registered comparison.

**Disclosed before running (principle 14).** Two smoke rounds (one each of every arm and cell,
[`../smoke/overhead-smoke-round.jsonl`](../smoke/overhead-smoke-round.jsonl)) were run and read:
gnomon ≈ 260 ms CPU per S1 trial, opencode ≈ 2,100 ms. Not blind.

## Question and claim sought

How much CPU time (primary) and wall time does each harness add per trial and per model
round-trip, with the model's latency held fixed? Claim allowed: "On Linux aarch64 (GB10, shared,
pinned to the X925 cores), S1, cold-process, default configuration, <harness> used X ms CPU per
trial [IQR], Y ms more than the null harness on its own runtime, paired, 20 rounds [95% CI]."

## Arms

| arm | build | configuration | command |
|---|---|---|---|
| `gnomon` | gnomon v0.4.2 | `gnomon init` as shipped, `[endpoints.local]` → the fake model (kind `openai`, streamed) | `gnomon task "<prompt>" --json --yes --trust` |
| `gnomon-gov-off` | same | audit off, sandbox off, approval never (the 0.1 run's governance-off) | same |
| `opencode` | opencode v2.2.5 | shipped defaults + a provider → the fake model (V2 `providers` format) | `opencode run --standalone "<prompt>"` (`PWD` = the repository) |
| `opencode-fast` | same | + `"snapshot": false`, its documented switch for git snapshots (undo tracking); permissions untouched. Best-effort fast (OVH-4) | same |
| `N` | `null_harness.mjs` on Node 22 (gnomon's runtime) | — | `node null_harness.mjs` |
| `N-bun` | the same file on Bun 1.4.4 embedded in the opencode binary (`BUN_BE_BUN=1 opencode null_harness.mjs`), opencode's runtime (OVH-5) | — | — |
| `F0` | `wire_floor.mjs` on Node, replaying gnomon's own warm-up bodies (OVH-8) | — | — |
| `F0-oc` | `wire_floor.mjs` on opencode's Bun, replaying opencode's own warm-up bodies, its title request included | — | — |

`--standalone`: a private server per invocation. opencode's default without it is a shared
background service; that daemon mode is not measured here (OVERHEAD §9's open question). gnomon
best-effort fast: n/a (OVH-4: no documented speed setting that keeps governance on). opencode
governance-off: n/a, its shipped permissions already allow everything.

**Tool map (published).** S1's abstract actions read / grep / edit / bash are, for opencode,
`read{path}` / `grep{pattern,path}` / `edit{path,oldString,newString}` / `shell{command}`; gnomon
and N use the 0.1 names.

## Scenarios, design, n

S0 and S1 (the 0.1 scripts, verbatim), d ∈ {0, 250} ms, cold-process, the 0-file generated
repository (seed 20261104). **20 rounds**; each (scenario, d) cell runs the 8 arms once per
round in an order rotated by the round number. One discarded warm-up trial per arm and cell
records F0's bodies. Not run: S2, S3, warm-session, cold-home (time).

## Primary endpoint and analysis

S1, d = 0, CPU (user + sys of the whole process tree, tool children included, OVH-2) per trial.
Per harness: median and IQR; the paired per-round difference against **its own runtime's N**
(gnomon − N, opencode − N-bun), median with a 95% bootstrap CI over rounds (10,000 resamples,
seed 20261105). Also reported against the other runtime's N, labelled. Per round-trip = per trial
÷ 11 scripted round-trips. Resolution: none pre-stated beyond the CI; no between-harness claim.

## Secondary

Wall, harness wall (wall − Σd), time to first request, peak RSS, bytes per scripted request,
auxiliary requests (requests offering no tools, e.g. opencode's title request: counted apart,
never a validity failure), d = 250 vs 0 (harness time should not depend on d), best-effort fast
and governance-off arms.

## Validity rule

0.1's: exit 0; the fake model saw the scripted round-trips in order with the expected tool
results (no refusal); the repository's final hash matches. F0: every body replayed. Invalid trials
are counted, never dropped silently. Load: the 1-minute load is recorded per trial; threshold
5.0 (25% of 20 cores); runs above it are flagged, not dropped. Host shared with H3/R4H/G1.

## Controls

N must be at or below each harness (a harness below N is investigated as an apparatus failure);
F0 is the floor of each harness's own bytes.

## Peer configuration and notice

As in the arms table. No maintainer has been notified yet; this result is held 14 days after
notice.

## Conflicts of interest

Author-run.

## Deviations log

| time (UTC) | change | before/after reading outcomes | reason |
|---|---|---|---|
| 2026-11-05T14:04–14:12Z | The analysis scripts (`chaos/analyse.py`, `overhead/analyse.py`, `governance/analyze.py`, `audit/summarise.py`) and `common/make_results.py` were written after the pre-registration commit, while the first blocks ran. Progress lines of `chaos-opencode-1` and the endpoint lane check had been seen; no aggregate outcome had been read. Each implements the analysis this file states | before | they did not exist yet |
| 2026-11-05T17:02Z | Raw outputs compressed (`*.jsonl.gz`, `work.tar.gz`) and checksummed (`raw/SHA256SUMS`); the analyses re-run on the compressed files with identical output | after | repository size |
| 2026-11-05T17:08Z | Disclosure, no change: the 1-minute load had a median of 6.79 (max 12.32) against the 5.0 threshold; 566 of 640 trials are flagged and kept, as this file requires. The load included this run's own chaos and audit blocks, pinned to the other ten cores (`run.sh`), as well as the host's other benchmarks. No governance block overlapped (they started at 14:16:18Z, after this block ended at 14:15:26Z) | after | stated so that the wall figures are read with it |

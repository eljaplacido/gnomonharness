# B-SCALE-1 — Monorepo Scale & Live-Hook Latency (2026-11-27)

**Answer.** Across synthetic git repositories scaling 250× from **100 to 25,000 tracked files** on GX10 (`linux/arm64`, Node v22), all five measured gnomon CLI hot paths (`surface hash`, `guard --from claude-code` on Bash and Edit, `audit scan --json`, and `migrate --check`) stay **flat / O(1) with respect to tracked file count**, with every p95 landing between **78.0 ms and 90.9 ms** ([`results.json`](results.json)).

**Diagnostic insight.** Because latency is flat from 100 to 25,000 files, the ~70–85 ms floor is Node + CLI startup overhead rather than git or filesystem traversal. Achieving sub-20 ms IDE hook latency for `gnomon guard` would require a native binary or persistent daemon rather than algorithmic work in the policy evaluator.

**Build:** `gnomon/0.6.7+498e33cb7-dirty` (`origin/master`, pre-`v0.6.8`)  
**Host:** `linux/arm64` (NVIDIA GB10 / GX10), 7 timed iterations after 1 warmup per cell, isolated `HOME` & `XDG_DATA_HOME`.

| Tracked files | `surface hash` p50 / p95 (ms) | `guard Bash` p50 / p95 (ms) | `guard Edit` p50 / p95 (ms) | `audit scan` (100 steps) p50 / p95 (ms) | `migrate --check` p50 / p95 (ms) |
|---:|---:|---:|---:|---:|---:|
| 100 | 81.81 / 84.79 | 73.54 / 84.77 | 70.82 / 86.07 | 72.89 / 82.34 | 73.48 / 83.48 |
| 1,000 | 78.97 / 86.64 | 81.51 / 88.40 | 72.17 / 90.92 | 80.17 / 84.40 | 80.72 / 87.78 |
| 10,000 | 81.16 / 83.14 | 72.91 / 86.14 | 73.31 / 81.63 | 71.22 / 80.73 | 69.79 / 85.39 |
| 25,000 | 69.41 / 82.61 | 82.58 / 85.32 | 82.45 / 84.04 | 70.33 / 77.96 | 78.70 / 82.41 |

**What this does not show.** Warm page-cache synthetic 20-directory trees with clean git working trees. It does not yet measure dirty-worktree `git status` scaling for `[verify] require_change = true` (`#273`) or multi-thousand-commit packfiles; those belong in a follow-up dirty-tree cell.

**Reproduce:**

```bash
node benchmarks/scale-overhead/bench.mjs --sizes 100,1000,10000,25000 --iters 7 --out benchmarks/results/scale-overhead-2026-11-27/results.json
```

# B-SCALE-1 — Monorepo Scale & Live-Hook Latency (`$0`, deterministic)

Measures how gnomon's core CLI hot paths scale with repository size (`100` → `25,000` tracked git files):

1. **`gnomon surface hash`** — must stay `O(|.gnomon/|)`, flat across repository size.
2. **`gnomon guard --from claude-code`** (`Bash` & `Edit` PreToolUse calls) — live IDE/agent hook latency budget. Any `O(repo)` git scan here slows every tool call made by Claude Code, Cursor, Codex, or opencode.
3. **`gnomon audit scan --json`** — offline 6-rule multi-step trajectory scan over a 100-step session trail.
4. **`gnomon migrate --check`** — surface drift check against shipped defaults.

## Running

```bash
node benchmarks/scale-overhead/bench.mjs --sizes 100,1000,10000,25000 --iters 7 --out benchmarks/scale-overhead/latest.json
```

Zero third-party dependencies, zero model spend, isolated `HOME` and `XDG_DATA_HOME`.

## Limits

- Synthetic flat 20-directory trees isolate file-count scaling and do not simulate deep git history (thousands of commits) or dirty-index churn.
- Cold-cache first invocations are excluded (1 warmup run per cell); the numbers reflect warm page-cache interactive usage.

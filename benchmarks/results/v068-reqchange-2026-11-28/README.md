# E-REQCHANGE (Regime A — Natural Prompts) — `[verify] require_change = true` vs `false` (v0.6.8, 2026-11-28)

**Headline verdict (pinned `v0.6.8` / `f88b38b0a`, `qwen3.6-35b` local on GX10, 8 tasks × 3 paired waves = 48 live cells, 0 apparatus failures):**
- **Applicable population on natural prompts was 0/24:** `qwen3.6-35b` edited files on **24/24** cells in both `off` and `on`, so `require_change = true` never needed to hand back or refuse.
- **Zero false-positive interference:**
  - Full solves: `on` **17/24 (70.8%)** vs `off` **18/24 (75.0%)** — delta **−4.2 pp**, exact McNemar **p = 1.0000** (`0 vs 1` discordant pair -> `not shown`).
  - Hidden-test share: `on` **87.3%** vs `off` **88.5%** — delta **−1.2 pp**, bootstrap 95% CI `[−6.2, +2.5] pp` -> **`non-inferior`** at the declared 10 pp margin.
  - Tokens & wall clock: `on` averaged `20,338` input tokens and `13.53 s` vs `off` `28,646` input tokens and `18.16 s` (difference driven by one `deadline` stall in `off`).

See the companion catchable-population run ([`../v068-reqchange-catch-2026-11-28/`](../v068-reqchange-catch-2026-11-28/)), where prompts actually trigger unchanged-worktree prose replies in `off` (**5/12** silent `bucket == "result"` with `worktree_changed == 0` -> **0/12** under `on`, **+50.0 pp** solves, McNemar **p = 0.0312**).

## Apparatus

- **Harness build:** `gnomon/0.6.8` (`f88b38b0a35cd3dc04614fdb3b059f84935f0904`)
- **Surface hashes (one variable: `[verify] require_change`):**
  - `off`: `ec1a971107e492e056ab18c80df5e2fdd37662d64b1a48464743ecd5b4fc0015`
  - `on`: `8c2c3464580bbe961c23db081a0bc9e7ed483e008c02da99b7cfd2cc7a3c2a69`
- **Model & endpoint:** `qwen3.6-35b` via local `llama-server` (`$0` cloud spend) on GX10.

## Artifacts

- Raw per-cell CSV & JSONL: [`cells.csv`](cells.csv) · [`cells.jsonl`](cells.jsonl)
- Paired statistical analysis: [`analysis.txt`](analysis.txt) · [`analysis.json`](analysis.json)
- GBS-REPORTING v0.2 record: [`result.json`](result.json)

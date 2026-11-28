# E-REQCHANGE (Regime B — Catchable Population) — `[verify] require_change = true` vs `false` (v0.6.8, 2026-11-28)

**Headline verdict (pinned `v0.6.8` / `f88b38b0a`, `qwen3.6-35b` local on GX10, 6 tasks × 2 paired waves = 24 live cells, 0 apparatus failures):**
- **Hard contract mechanism endpoint HELD 100%:** Silent prose-only completions (`bucket == "result"` with `worktree_changed == 0`) dropped from **5/12 (41.7%)** under `off` to **0/12 (0.0%)** under `on`.
- **Hand-back conversion:** `worktree_changed` rose from **7/12 (58.3%)** under `off` to **12/12 (100.0%)** under `on` — all 5 caught prose-only turns converted on the single hand-back into passing edits.
- **Full solves:** `on` **10/12 (83.3%)** vs `off` **4/12 (33.3%)** — delta **+50.0 pp**, task-cluster bootstrap 95% CI `[+16.7, +83.3] pp`, exact McNemar over 12 paired cells **`6 vs 0` discordant pairs, p = 0.0312** -> **`better`**.
- **Hidden-test share:** `on` **95.8%** vs `off` **72.9%** — delta **+22.9 pp**, bootstrap 95% CI `[+4.2, +45.8] pp` (sign-flip `p = 0.2500` at n = 6 tasks -> `non-inferior` by `analyze_paired.py`'s dual-interval rule).
- **Cost & latency (local, `$0` cloud spend):** `on` used `19,086` mean input tokens and `13.56 s` vs `off` `21,723` mean input tokens and `14.44 s`.

## Why Both Regimes Matter

Together with Regime A ([`../v068-reqchange-2026-11-28/`](../v068-reqchange-2026-11-28/)), this establishes both sides of `#273`:
1. **When the model already edits files** (Regime A, 48 cells), `[verify] require_change = true` adds zero overhead and does not interfere (`non-inferior`, McNemar `p = 1.0000`).
2. **When the model emits a prose-only plan without touching the worktree** (Regime B, 24 cells), `[verify] require_change = true` eliminates silent unchanged `result` completions (**5/12 → 0/12**) and converts them into working fixes (**+50.0 pp**, McNemar **p = 0.0312**).

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

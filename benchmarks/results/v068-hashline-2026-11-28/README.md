# E-HASHLINE — `edit_format = "hashline"` vs `"str_replace"` (v0.6.8, 2026-11-28)

**Headline verdict (pinned `v0.6.8` / `f88b38b0a`, `qwen3.6-35b` local on GX10, 11 tasks × 3 paired waves = 66 live cells, 0 apparatus failures):**
- **`hashline` performed significantly worse than `str_replace` on this model and corpus.**
- **Full solves:** `hashline` **12/33 (36.4%)** vs `str_replace` **23/33 (69.7%)** — delta **−33.3 pp**, task-cluster bootstrap 95% CI `[−60.6, −6.1] pp`, exact McNemar over 33 paired cells `1 vs 12` discordant pairs, **p = 0.0034** (`worse`).
- **Hidden-test share:** `hashline` **82.9%** vs `str_replace` **96.0%** — delta **−13.1 pp**, bootstrap 95% CI `[−22.1, −4.7] pp`, exact sign-flip **p = 0.0234** (`worse`).
- **Mechanism (edit errors parsed from `tool_log`):** `hashline` hit **14/108 (13.0%)** edit errors (`stale anchor` / `refused`) vs `str_replace` **0/109 (0.0%)**.
- **Token cost (local, `$0` cloud spend):** `hashline` consumed **+44.6% more input tokens** (`72,949` vs `50,433` mean tokens_in/cell; output tokens flat at `2,405` vs `2,425`) and slightly more wall time (`33.19 s` vs `29.49 s`).

**Pre-registered decision rule outcome:** Do **not** promote `edit_format = "hashline"` to default. Keep `edit_format = "str_replace"` as the default in `gnomon` and keep `hashline` strictly opt-in (for models that struggle with exact string replacement, not models like `qwen3.6-35b` that already execute `str_replace` cleanly).

## Apparatus

- **Harness build:** `gnomon/0.6.8` (`f88b38b0a35cd3dc04614fdb3b059f84935f0904`)
- **Surface hashes (one variable: `[defaults] edit_format`):**
  - `str_replace`: `5e2470f6e0d810baeae23e1254efd9448f8737633b0ea54712be95d1f406a46a`
  - `hashline`: `28d22d9a7f60454f15d28e476fb9e6c667c3bd14278670fe3cf71996fb3f763e`
- **Model & endpoint:** `qwen3.6-35b` via local `llama-server` (`http://127.0.0.1:18080/v1/chat/completions`, `$0` cloud spend) on GX10 (NVIDIA GB10).
- **Confounding control:** `implement` role held `tools = ["read", "edit", "grep", "glob", "bash"]` (no `write`) and `bash_allow = ['^python3\s+-m\s+unittest\b', '^node\s+--test\b', '^ls(\s|$)']` with `bash_deny` blocking `sed`, `awk`, `perl`, redirects, and subshells — forcing 100% of file edits through the `edit` tool in both arms.
- **Evaluation:** External hidden test suites (5–9 independent assertions per task) held outside the agent workspace and executed by `benchmarks/v068-ab/run.mjs` after each turn.
- **Design:** 11 multi-hunk brownfield tasks (9 Python, 2 Node ESM) × 3 interleaved waves (`w1..w3`, alternating arm order by wave) = 66 cells.

## Per-Task Breakdown (3 waves per arm)

| Task | `str_replace` solves | `str_replace` hidden share | `hashline` solves | `hashline` hidden share |
|---|---:|---:|---:|---:|
| `config-parser-edge` | 3/3 | 1.000 | 3/3 | 1.000 |
| `csv-stream-escape` | 3/3 | 1.000 | 0/3 | 0.667 |
| `dup-handlers` | 0/3 | 0.875 | 0/3 | 0.833 |
| `js-esm-refactor` | 3/3 | 1.000 | 3/3 | 1.000 |
| `js-event-bus` | 2/3 | 0.933 | 0/3 | 0.600 |
| `ledger-rounding` | 3/3 | 1.000 | 1/3 | 0.630 |
| `multi-file-rename` | 3/3 | 1.000 | 1/3 | 0.905 |
| `repeated-guards` | 3/3 | 1.000 | 0/3 | 0.778 |
| `sql-query-builder` | 3/3 | 1.000 | 3/3 | 1.000 |
| `state-machine-transitions` | 0/3 | 0.875 | 1/3 | 0.917 |
| `whitespace-table` | 0/3 | 0.875 | 0/3 | 0.792 |
| **Total / Mean** | **23/33 (69.7%)** | **0.960** | **12/33 (36.4%)** | **0.829** |

## Mechanism Observations & Limits

1. **Why `hashline` regressed on `qwen3.6-35b`:** `qwen3.6-35b` already achieves **0/109 (0.0%)** edit errors with standard `str_replace`, so there was no string-matching failure floor for `hashline` to eliminate. Under `hashline`, the model incurred **14/108 (13.0%)** `stale anchor` / `refused` errors across multi-hunk edits, occasionally mis-scoped line ranges (producing partial fixes on `csv-stream-escape`, `js-event-bus`, `ledger-rounding`, `repeated-guards`), and paid **+44.6% higher input tokens** due to `LINE:HASH|` prefixes and retry turns.
2. **Telemetry note discovered by measuring:** `counters.per_tool.edit.refusals` reported `0` in both arms even though `tool_log` recorded 14 `edit <file> — stale anchor` / `edit <file> — refused` entries under `hashline`. Both numbers are reported in `result.json` (`edit_refusals_counter` vs `edit_tool_log_failures`).
3. **Scope limit:** Single local model (`qwen3.6-35b`, 11 synthetic brownfield tasks, 3 waves). Results do not rule out `hashline` helping models that have high `str_replace` mismatch rates; they show it is **harmful** as a blanket default on models already strong at `str_replace`.

## Artifacts

- Raw per-cell CSV: [`cells.csv`](cells.csv)
- Full per-cell telemetry JSONL: [`cells.jsonl`](cells.jsonl)
- Paired statistical analysis: [`analysis.txt`](analysis.txt) · [`analysis.json`](analysis.json)
- GBS-REPORTING v0.2 record (validated by `benchmarks/kit/validate_reporting.py`): [`result.json`](result.json)

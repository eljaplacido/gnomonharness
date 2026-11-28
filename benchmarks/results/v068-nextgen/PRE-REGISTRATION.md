# Pre-registration (DRAFT) — `v0.6.8` Next-Gen Capability & Cost Campaigns

**Status: EXECUTED IN PART on 2026-11-28 against pinned `v0.6.8` (`f88b38b0a`).**
- `E-HASHLINE`: **COMPLETE** — see [`../v068-hashline-2026-11-28/`](../v068-hashline-2026-11-28/) (`hashline` **worse** on `qwen3.6-35b`: −33.3 pp solves, McNemar `p = 0.0034`; `str_replace` retained as default).
- `E-REQCHANGE`: **COMPLETE** — see [`../v068-reqchange-2026-11-28/`](../v068-reqchange-2026-11-28/) (Regime A natural prompts: idle, non-inferior) and [`../v068-reqchange-catch-2026-11-28/`](../v068-reqchange-catch-2026-11-28/) (Regime B catchable population: silent unchanged `result` **5/12 → 0/12**, solves **+50.0 pp**, McNemar `p = 0.0312`).
- `E-CONTEXT` & `E-PARALLEL`: **PENDING** (not yet run).

Follows [`docs/HARNESS-RESEARCH-RECONCILIATION.md`](../../../docs/HARNESS-RESEARCH-RECONCILIATION.md) §6: one `surface_hash` per hypothesis, `n >= 3` paired arms, dual **mechanism** (resolvable at `n=3`) and **score** endpoints, and strict separation of `apparatus_failure` from `refusal`/`result`.

Before the first scored run, fill in every `TBD`, pin the exact `v0.6.8` release SHA (verified in `report.harness` and `manifest.build`), change the status line to `REGISTERED`, and commit on its own.

---

## Common Apparatus

| Field | Value |
|---|---|
| Build | `TBD` (`v0.6.8` release tag SHA, verified per trial in `TaskRecord.harness` and `manifest.build`) |
| Local model lane | `qwen3.6:35b` on GX10 (llama-server / Ollama) and/or RTX 5090 |
| Hosted model lane | `TBD` (only for `E-PARALLEL` cloud-rescue & cloud-only arms; wire-metered via `benchmarks/kit/relay-meter.mjs`) |
| Replicates | `n = 3` per task per arm, interleaved order |
| Statistics | McNemar exact on paired pass/fail; exact sign test + bootstrap 95% CI on tokens & wall clock (`benchmarks/kit/analyze_paired.py`) |
| Exclusion rule | `apparatus_failure` / transport-abort cells excluded by rule and reported separately; never dropped silently |

---

## E-HASHLINE — `edit_format = "hashline"` vs `"str_replace"`

- **Question:** Does Can Bölük's line-hashed anchor format (`edit_format = "hashline"`, shipped `v0.6.7`) reduce edit failures/retries and improve pass rate on multi-file brownfield edits?
- **Arms (1 variable):**
  - Base: `[defaults] edit_format = "str_replace"`
  - Candidate: `[defaults] edit_format = "hashline"`
- **Task set:** `TBD` — 24 multi-file brownfield edit tasks requiring ≥ 3 edits across existing files.
- **Primary mechanism endpoint (resolvable at `n=3`):** Edit refusal/retry rate per turn (`edit` calls returning refusal / total `edit` calls) and stale-anchor recovery rate.
- **Secondary score & cost endpoints:** Paired task pass rate (McNemar exact) and total tokens per solved task.
- **Decision rule:** Recommend `hashline` as opt-in default in `GUIDE.md` only if pass rate does not regress (`delta >= -0.02`) AND edit refusal/retry rate drops by `>= 25%` (`p < 0.05`).

---

## E-REQCHANGE — `[verify] require_change = true` (`#273`)

- **Question:** Does enabling `[verify] require_change = true` eliminate silent prose-only `result`/`answered` completions on coding tasks, and how often does the single hand-back recover a real fix?
- **Arms (1 variable):**
  - Base: `[verify] require_change = false`
  - Candidate: `[verify] require_change = true`
- **Task set:** `TBD` — 20 coding tasks where local models have historically produced prose-only plans (including Rihma-style `T-004` regression cases).
- **Primary mechanism endpoint:** Rate of `bucket == "result"` with unchanged git worktree drops to **0 / N** (hard contract check).
- **Secondary endpoints:** Hand-back conversion rate (unchanged on turn 1 → valid passing change after hand-back) and overall pass rate delta.

---

## E-CONTEXT — Context Retention (`#301`) Under Long-Horizon Pressure

- **Question:** On 40+ step brownfield debugging tasks where context compaction actually fires, does `#301` context retention preserve early constraints and reduce token re-send?
- **Arms (1 variable):**
  - Base: pre-`#301` sliding window (`compaction = "summary"`, no `[context]` retention block)
  - Candidate: `[context] policy = "sliding_window"`, `retain_after = 2048`
- **Task set:** `TBD` — 16 long-horizon debugging tasks verified to trigger `context_mask` / compaction in the base arm.
- **Primary mechanism endpoint:** Early-constraint recall rate after compaction + total wire input bytes per trial.
- **Secondary endpoint:** Paired task pass rate delta.

---

## E-PARALLEL — Local `--attempts 3` vs Local-First Cloud Rescue (`[escalate]`) vs Cloud-Only

- **Question:** Can speculative local parallel compute (`gnomon task --attempts 3` on local `qwen3.6:35b`, `$0` cloud spend) match or beat local-first cloud rescue (`[roles.<r>.escalate]`) on solved fraction and `$/solved`?
- **Arms:**
  1. `L1`: Local `qwen3.6:35b`, single attempt (`k = 1`)
  2. `L3`: Local `qwen3.6:35b`, `gnomon task --attempts 3` (`max_parallel = 3` or sequential budget-capped, `$0` cloud)
  3. `HYB`: Local-first + `[roles.implement.escalate]` cloud rescue (`v0.5.0` cost mode)
  4. `CLD`: Cloud-only baseline
- **Task set:** 32-task Terminal-Bench 4.0 lane (same lane as `HYBRID.md` `R3R`/`M2`), `n = 1` screen then `n = 3` on discordant/contested subset.
- **Primary endpoints:** Solved fraction (paired McNemar `L3` vs `L1` and `L3` vs `HYB`), `pass^2` consistency, wall-clock seconds, and wire `$/solved`.
- **Decision rule:** If `L3` achieves `>= 90%` of `HYB` solved rate at `$0` cloud spend and `< 2.5x` wall clock, document `--attempts` as the recommended zero-cloud quality-scaling mode in `README.md` and `GUIDE.md`.

# Evidence — what is proven, what is not

*Last reconciled 2026-09-01.* One row per claim gnomon makes about itself, the
measurement that tests it, and the result. A claim with no row is a claim with no
evidence, and is listed as such at the bottom rather than omitted.

Every suite here reads its outcome from **real state** — a filesystem predicate,
a hash, a canary server's own log, a re-run of the tests — never from the agent's
account of itself. That rule exists because the first version of the containment
suite broke it, and scored 25/25 by asking gnomon whether gnomon had misbehaved.

---

## The Six Rules

| Rule | Claim | Evidence | Result |
|---|---|---|---|
| **1** | No machine-scoped configuration | [determinism](../benchmarks/results/determinism-2026-08-31/) | **10/10** — identical declared behaviour across locale, timezone, cwd, absolute path, `HOME`, `XDG_CONFIG_HOME`, mtimes |
| **2** | Every session emits a content-addressed manifest | [determinism](../benchmarks/results/determinism-2026-08-31/) | surface hash stable under every perturbation above |
| **3** | Tool schemas are declared data; unreachable tools refuse | [tool contract](../benchmarks/results/tool-contract-2026-08-31/) | **15/16** malformed calls refused with a reason, **0 crashes** |
| **4** | Three buckets, no composite verdict | [tool contract](../benchmarks/results/tool-contract-2026-08-31/) | every malformed call bucketed; refusals never silently became results |
| **5** | Published, versioned exit contract | [Terminal-Bench](../benchmarks/results/terminal-bench-postfix-2026-08-31/) | **apparatus failures 13 → 0** across a 47-task arm |
| **6** | Published enumerations | `docs.test.ts` (21 conformance tests) | tool table, role table, command registry, exit codes and `stop_reason` pinned to the code |

**Rule 1 caveat, measured:** `GNOMON_MODEL_URL` changes where inference goes while
the surface hash stays identical. Found by the determinism suite; the audit record
now carries `endpoint_url` so the trail can distinguish two runs that reached
different servers.

## The DESIGN pillars

| Claim | Evidence | Result |
|---|---|---|
| The surface is not writable by a tool call | [containment](../benchmarks/results/containment-2026-08-31/) · [consent](../benchmarks/results/consent-2026-09-01/) | gnomon **5/5** refused; opencode rewrote its own permission file **5/5** across four escalating configs. `strict` refuses even when the approver says *yes* — **6/6** |
| Capability over instruction | [injection](../benchmarks/results/injection-2026-08-31/) | boundary holds **12/12** when the model actually complies; the model ignored the injections 0/12, so the *control* is what proves it |
| Skills proposed, never self-applied | — | **untested** |
| Sessions and audit live outside the surface | [determinism](../benchmarks/results/determinism-2026-08-31/) | mtime and path perturbation leave the hash unchanged |
| Tamper-evident audit trail | [auditability](../benchmarks/results/auditability-2026-08-31/) | **8/9** attacks caught. A full re-chain is undetectable by construction and is published as a limit |

## Everything else measured

| Dimension | Evidence | Result |
|---|---|---|
| Task completion | [Terminal-Bench](../benchmarks/results/terminal-bench-postfix-2026-08-31/) | 43.5% → **52.2%**, McNemar **p = 0.109** — *direction only*, n=3 running |
| Context retention | [context](../benchmarks/results/context-2026-08-31/) | `summary` **9/9**, `discard` **0/9**. The shipped default is `discard` |
| Per-turn overhead | [latency](../benchmarks/results/latency-2026-08-31/) | **223 ms** vs opencode **1581 ms** |
| Test authoring | [test authoring](../benchmarks/results/test-authoring-2026-08-31/) | **1/9** — and 3/9 asserted the *bug* as the contract |
| Verify-gate value | [verify gate](../benchmarks/results/verify-gate-2026-09-01/) | **inconclusive after 38 trials** — the model fixes 18/18, so the gate has nothing to catch |
| The three real workflows | [workflows](../benchmarks/results/workflows-2026-09-01/) | audit / refactor / greenfield all **complete**; four defects found doing it |

## Claims with no evidence

Listed because omitting them would imply coverage that does not exist.

- **Skills are proposed, never self-applied** — the mechanism is never exercised
- **MCP** — declared in `tools.toml`, never benchmarked
- **Session resume fidelity** — `/session`, `--continue`, never tested
- **Model agnosticism** — every suite above ran on one local model or one cloud
  model; no cross-provider comparison exists
- **Peer task completion** — the goose figure predates the adapter repairs and is
  **not a valid current baseline**; the opencode arm failed on a model-name
  parsing bug and produced nothing

## How to read a number here

Every result is one model and, unless stated, one pass. The suites establish
**mechanism** — that a boundary holds, that a hash is stable, that a failure is
recorded — far better than they establish **rates**. Where a rate is quoted with
a p-value, the p-value is the claim.

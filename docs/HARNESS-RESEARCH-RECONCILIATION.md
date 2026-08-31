# Harness research, reconciled against gnomon's constitution

What the current agentic-harness literature says, what of it gnomon should adopt, and what it
must refuse to stay itself. Written against
[BENCHMARK-REPORT-2026-08-30.md](BENCHMARK-REPORT-2026-08-30.md) and the Six Rules in
[../README.md](../README.md).

---

## 1. The finding

**gnomon is violating its own constitution at the two points that decided the benchmark.**

The comfortable version of this document would have said the constitution was ahead of the
implementation. It isn't, and the true version is more useful.

**(a) "The constraint" is false today.** `.gnomon/` is supposed to declare everything that decides
how the agent acts, content-hashed, with that hash stamped on every record. But
`NUDGE_AFTER_IDLE = 12`, `STALL_REPEATS = 3`, `CONVERGE_REFIRE = 6` and the nudge's injected text
live in TypeScript (`prompt_loop.ts:899, 914, 926, 1555`). All 114 session records in the surviving
arm carry `surface=be52a8a14db8` while the mechanism that ended a large share of those runs was
invisible to that hash. *"If behaviour changed, the hash changed"* is the sentence the whole design
exists to earn, and today `12` can become `40` without moving a byte of the manifest.

**(b) The record that Rules 2 and 4 exist to produce was never produced.** `[audit] enabled = false`
ships in `init.ts:193` **and in gnomon's own `.gnomon/config.toml:100`** — off even in the dogfood
surface. `TaskRecord` carries no `stop_reason`; the reason exists internally as a note string
(`prompt_loop.ts:1276-1281`) and is only interpolated into prose. The benchmark adapter ignores
`CONTAINER_AGENT_LOGS_PATH`, which terminal-bench already mounts.

**The consequence is the whole argument.** Four independent adversarial analyses of the same
campaign produced four different "dominant defect" diagnoses — shell-blind writes, the inert verify
gate, a missing publish guard, the nudge text — and every one was refuted on impact under
verification. That is not analyst error. It is what happens when a harness whose pitch is *"what an
agent did, what it was allowed to do, and why, are all answerable afterwards from a record"* runs 48
tasks and answers none of it.

**And the noise floor swallows the entire fix list.** Re-run flip rate is 3/18 = **16.7% (±6pp)**;
the campaign accidentally ran sampled (`temperature 0.3`, not greedy — the adapter's rewrite
silently failed); 11 of 106 trials (10.4%) died on model-transport aborts scored as capability
failures. The largest honest per-fix estimate anywhere in this analysis is **+2.5 to +9.5pp**. At
n=1, **no change on this list is measurable.**

So the order is forced: **repair the record, repair the constitution, fix the measuring stick — then
the behavioural fixes**, whose combined honest ceiling is single digits and which will otherwise be
attributed by vibes.

---

## 2. What the research confirms gnomon already has

Do not rebuild any of these. Mapped by name.

| Research characteristic | gnomon mechanism | Where gnomon is stronger |
|---|---|---|
| Decoupled, git-tracked file substrate | `.gnomon/` + Rule 2 manifest | Content-addressed, and **absence is in the hash** — removing a component is a distinguishable change, not a silent no-op |
| Lazy/progressive skills | declared-regex skill selection | Selection is declared data; the research's version has a model decide |
| Causal traceability | `AuditTrail` — hash-chained records, `surface_hash` on each, `gnomon audit verify` | Ties an outcome to a *configuration identity*. **Built, tested, shipped off** |
| Tiered model routing | `[[routing.rules]]`, per-role model+endpoint, `fallback`, the `smol` role | Reproducible by construction |
| Brain / Hands / Session split | sessions and audit already live outside the hashed surface | Stated as behavioural, not hygienic |
| Phase-gated tools | roles-as-tool-masks (`buildToolSet`) + the `task` sub-turn | Declared in a hashed file; delegation cannot acquire capability |
| Checkpoint/resume | session persistence, `--continue`/`--resume`, `todo`, hash-drift on resume | Resume *reports drift* instead of silently replaying under new rules |
| Falsifiable change manifests | ROADMAP's per-phase `Wrong if:` clauses, conformance goldens | Independently invented; only the join is missing |
| Ephemeral subagents | the `task` tool | Same idea, plus a containment property |
| Publish-state guard | `[verify]` at `prompt_loop.ts:1194-1249` | Already correct, including parsing the *shell's* exit rather than the tool's |
| Budget injection | `converge_after` | Implemented **and already A/B tested in-repo** |
| Command batching | already at peer rate | 41.8% of 318 gnomon commands chain with `&&` vs the cited peer 42.7% |

**The sharpest confirmation.** The literature reaches for Double Machine Learning to strip the
confounding between configuration and outcome out of historical agent logs. **Rule 1 abolishes that
confounder by construction.** Avoiding a confounder beats adjusting for one. AHE must decouple its
harness into git-tracked files to make file-granular revert well-defined; Rule 2 gives that
natively. gnomon has not paid a determinism tax to buy auditability — it has already paid the entry
fee for the one loop the research calls the highest-order lever, and no harness with `~/.config`
overrides can copy it without paying Rule 1 first.

**Two premises in the source material our own data falsifies.**

1. *"gnomon struggles on longer multi-step problems."* Tier pass rates are easy **38.5%**, medium
   **40.0%**, hard **14.3%**. It fails easy tasks at essentially the medium rate. That is a
   closing-discipline signature, not context rot — and it rules out roughly seven of the ten
   characteristics.
2. *"System-prompt edits scored −2.3pp; tool and middleware guards carried the entire gain."* The
   source **misreports its own reference**: AHE Table 3 puts long-term memory alone at **+5.6pp**,
   larger than tools+middleware combined at +5.5pp, and the −2.3pp is a swap-in artifact the authors
   explain. In *our* run, prompt text was the largest observed driver of outcomes: 31 of 59
   unresolved trials self-terminated within about one tool call of a **prompt-injected** nudge.

---

## 3. Constitutional conflicts

Ten were examined. **None requires an amendment.** One is requested by the research and refused.

| # | Research asks for | Rule it breaks | Compatible form |
|---|---|---|---|
| 1 | Summarize-on-ingest (model call in the tool layer) | Rule 4 — a `result` step gains a hidden apparatus dependency and undeclared non-determinism | Deterministic head+tail via `clamp`, with the dropped byte count named. If ever wanted: enumerated `on_overflow = "truncate" \| "summarize"`, `truncate` default |
| 2 | Infer shell writes by command regex | The constraint + Rule 6 — a behaviour-deciding pattern list in unhashed TS; and "exit 0 = write" silently widens `verify.after = "write"` into `"always"` | Extend the existing `surfaceHashOf` drift observation (`tools.ts:945-948`) from `.gnomon/` to the worktree — **observational, not inferential** |
| 3 | Phase-gated tool masking | Rule 3 — narrower than it looks: `buildToolSet` already shortens per role, so the rule means no tool is ever *silently* dropped | Legal **if** the phase→tool map and transitions are declared data. But it reverses DESIGN's "the order is the operator's" — argue it in the open, don't break it quietly. Not warranted on the evidence (a GitHub README, 5 tasks, n=10, saturated) |
| 4 | Model-triggered `manage_context` | "the surface determines *that* it happens and *which role* does it" | A declared tool, `enabled = false`, granted per role. Legal — see §5 for why not to pay for it |
| 5 | *(ours)* Rule 3 isn't enforced against the model | Rule 3 | `withheld`/`disabled` are printed to **stderr**, which the model never sees. Name them in the system block, sourced from the hashed surface |
| 6 | *(ours)* Rule 3's "sorted" is unimplemented | Rule 3 | `declaredTools` returns file order; MCP appends in *connection* order. One `.sort()`; also stabilises the prompt prefix |
| 7 | Submit-guard refusing with exit 2–4 | Rule 4 / CONTRACTS — a refusal floor is never demoted, so not-yet-verified runs would fill the refusal bucket permanently | The existing gate is already right: push a system message and `continue`. Do not "upgrade" it |
| 8 | Kernel sandboxing (Landlock/seccomp/eBPF) | **Not** a Rule 1 violation — a kernel is an environmental capability, not configuration | New enumerated `sandbox` value (Rule 6) + `apparatus_failure` / exit 10 when unavailable. Never a silent downgrade. Not warranted: B4 measured containment holding |
| 9 | Hardcode `/bin/bash` | Rule 1 — the README already made this argument for `compute` | Declare `interpreter` on the bash tool, publish legal values, refuse at startup when absent |
| 10 | Lifecycle hooks | Rule 1 — a hook pointing at a machine path is the textbook violation | `[[hooks]] phase = "post_tool" command = ".gnomon/hooks/…"`, resolved inside `.gnomon/`, run through the bash tool exactly as `[verify]` is. **Note dead scaffolding:** `agent.ts` exports an `ExtensionHost` with a `HookPhase` enum *and tests* that nothing ever registers or invokes |

**The amendment requested, and refused: self-evolving harnesses.** An agent that edits the surface
mid-run changes the hash underneath the run that produced the records — so every record's
attribution becomes a lie, and the record is the product. Four mechanisms already bar it
(`write`/`edit` refuse `.gnomon/` under strict; `edit` *always* refuses a surface path; a delegated
`task` is forced back to strict; the skill tool writes only to `skills/proposed/`). The same
edit-search loop is available with a human promotion step, at the cost of latency and nothing else.
Extend DESIGN's *"learning stays deliberate and reviewable"* explicitly to harness edits, so this is
not relitigated when the manifest loop starts emitting candidate diffs.

---

## 4. The plan

### Tier 0 — measurement integrity. Zero score movement by construction; precondition for every claim below.

- Enable `[audit]` in the **benchmark** surface (not the global default) and archive traces into the
  repo as part of the run script. *(Done for the diagnostic arm.)*
- Emit stop reason, step count and compaction events into `CONTAINER_AGENT_LOGS_PATH`.
- Structured `stop_reason` on `TaskRecord` — model-answered / stall / step-wall / verify-handback /
  nudge-terminated. Rule 4 is a floor on the *verdict*, not a ceiling on diagnosis.
- Fix the adapter's silently-failed greedy rewrite; pin peer versions; run **n ≥ 3**.

This is research characteristic 5 in full, and it costs almost nothing to build because it is
already built and switched off.

### Tier 1 — repair the live constitutional violations. Correctness, not capability.

- Move `NUDGE_AFTER_IDLE`, `STALL_REPEATS`, `CONVERGE_REFIRE` **and the nudge text** into declared
  surface data, as role keys alongside `converge_after`. **This repairs the constraint.**
- Repair the corrupted init template and move `[verify]` into `POLICY_TOML`. Commit `ae0a0365`
  spliced the `[verify]` block into webfetch's two-line comment, leaving this **live and
  uncommented** in every generated `tools.toml` since 2026-08-26:
  `[sandbox] network = false in policy.toml. Off by default for that reason.`
  It parses, so Rule 3 holds and no trial was harmed — which is exactly the point.
- Warn or refuse on unrecognised top-level config keys. Silently ignoring a declared key is silently
  dropping a declared tool, in a different file. This is what would have caught both bugs above.
- Publish `verify.after` in `gnomon enumerations` (Rule 6).
- ✅ **Return captured stdout/stderr on bash timeout** (`tools.ts`) — *shipped*. Scope it honestly:
  the timeout path fired 15 times across 4 of 108 tasks and 2 of those passed anyway. Ceiling ~0–1
  tasks. Ship it because a harness that sells the record must not discard evidence it already holds.

### Tier 2 — the only plausible score movers. All individually below the noise floor.

- **`SYSTEM_MD` verification + shipping clauses**, and soften the two completion-pushing lines.
  Reach 2–4 of 42 valid trials ≈ **+4.8 to +9.5pp**. Two sentences, not a rule set — a rules-heavy
  prompt regressed in the cited ablation, and our own peer burned 1200s on twelve validation scripts
  for a task gnomon won in 483s by shipping. Note `init.ts:506` does not merely *lack* a
  verification clause; it contains *"Execute, then report"* and *"Finish the work"*.
  > **Do not ship this paired with the `[verify]` namespace fix as one claim.** The benchmark
  > surface declares no verify command, so the gate fired in 0 of 48 trials before the fix and would
  > fire in 0 of 48 after. The prompt clause carries 100% of any effect.
- **Observational shell-mutation detection** feeding the idle counter. Justify it on the **nudge**,
  not on `[verify]`: 50 of 118 trials nudged, 49 with zero write/edit approvals beforehand; nudged
  pass 8/50 (16.0%) vs clean 34/69 (49.3%), Fisher **p = 0.0002**. Honest impact **≈ +2.5pp** — not
  the +9.7pp a naive back-out gives, because the trials that stopped had done almost nothing.
- **Scaffold `converge_after`. Cost only.** Already A/B tested in-repo and null (pooled p = 0.564),
  and 0 of 15 pooled trials past 600s ever resolved. What it buys is real: gnomon's 7 trials past
  600s consumed **39% of the arm's wall clock for zero score**. Keep any `turn_deadline_ms` as a
  caller-supplied flag, never a surface default — a wall clock makes the same surface behave
  differently on a fast and a slow machine.
- **Declared shell interpreter.** Ergonomics only: `<(` appears in **1 of 318** captured commands
  and no trace contains a syntax error. There is no capability to recover.

### Tier 3 — the one research idea worth adopting wholesale, in human-promoted form

- `gnomon experiment`: diff two surface manifests file-by-file, join each `surface_hash` to its
  per-trial Rule-4 buckets, report fixed / regressed / no-move per changed file. Everything it needs
  is **already emitted and nothing consumes it**.
- A hashed prediction file per surface change. Rule 2's absence-in-hash makes "no prediction filed"
  distinguishable from "empty prediction".
- Promote **B9 (determinism)** to Tier 1 of the benchmark roadmap. The §2 argument — determinism as
  a capability asset rather than a tax — is currently *unfalsified*, and building a strategic
  position on an unmeasured premise is the same error that needs retracting elsewhere.
- Second-pass **B4** (containment vs peers, identical attacks) above any further capability sweep.
  It is the only number that supports the sentence gnomon actually sells.

---

## 5. Deliberately not doing

Recorded so it is not relitigated.

- **ACM / `manage_context`.** The headline figure needs on-policy distillation from a 397B teacher.
  The reachable half is +1.9pp on the benchmark that resembles ours, and the brief itself says
  effective context management is a 9B+ capability — exactly what gnomon's local-model audience
  lacks. We show **zero context-pressure signature**: 0 compaction events across 111 traces, median
  21 tool calls, and gnomon is already 3.8–11.7× leaner than opencode. It would spend effort eroding
  the one axis we win.
- **TCKG / MAGMA / DML memory graphs.** Those sections carry **zero citations**, and the worked
  examples are deal velocity, economic buyers and HITRUST certification predicting deal progression.
  That is a CRM vendor whitepaper with harness vocabulary over it.
- **MCP AST/symbol servers for token reduction.** The 98.7% is an engineering-blog worked example
  with no pass-rate component. Aimed at our strongest axis, and it is the one adoption that
  measurably *weakens* reproducibility — gnomon pins the invocation, not the server's behaviour.
- **Conformal prediction / act-or-defer pruning.** Rule 3 verbatim ("prune invalid candidate actions
  … re-query across the reduced choice set"). Needs logprobs neither endpoint kind surfaces. The
  "<3% hallucination" is a **user-chosen α reported as a measured result**.
- **LLM judges as an outcome bucket.** Rule 4: a model-authored pass/fail is a composite verdict
  wearing a bucket's clothes. Fine as out-of-band analysis over the audit trail.
- **CodeAct.** Collapses N actions into one Rule-4 step precisely where debugging needs resolution,
  and re-imports the `python3` machine dependency Rule 1 forbids. Its cited figures are not in the
  paper. We already chain commands at peer rate.
- **A regression set built from the failing easy/medium tasks.** Selection on outcome: at a 16.7%
  flip rate a **no-op change** "fixes" 1.3–2.7 tasks = +8 to +17pp — the same magnitude as the gap
  being chased. Use the full 48, pre-registered and hash-stamped.
- **Rewriting the nudge to remove the stop option.** Of 34 nudged failures, 22 already ended
  `[result]` — declared done, graded wrong. Removing the stop sanction pushes trials into that worse
  bucket. The salvageable half is moving the text into the surface, not rewording it in place.
- **A default `[verify]` command.** `init.ts` is right to refuse one, and Terminal-Bench hides its
  tests, so injecting them is contamination.

---

## 6. How to know it worked

Apply the change-manifest discipline to ourselves. **One surface hash per hypothesis** — an n=1
sweep cannot separate confounded edits.

**Protocol, fixed before any change lands.** Full 48 tasks, pre-registered. **n ≥ 3 per arm.**
Greedy actually verified this time. Every trial records its `surface_hash`. `apparatus_failure` rows
and model-transport aborts excluded **by rule, not by hand**, and reported separately. Audit
enabled; traces committed.

**The noise floor is the binding constraint:** ±6pp at n=1, roughly ±3.5pp at n=3. Every Tier-2 item
predicts a delta at or below that. So **each change declares two endpoints — a mechanism metric that
n=3 can resolve, and a score metric it probably cannot — and a mechanism win with no score movement
is declared in advance as an honest partial result, not spun as a failure.**

Worked example, the idle counter: the mechanism endpoint is *"trials nudged with zero preceding
write/edit approvals falls from 49/50 to near zero"* — resolvable at n=3. The score endpoint is
*"+2.5pp"* — not resolvable, and said so in advance.

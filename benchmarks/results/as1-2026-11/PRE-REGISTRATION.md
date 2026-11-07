# AS1: an adaptive multi-hypothesis sweep of gnomon fixes on P2G's long Terminal-Bench 4.0 tasks (pre-registered 2026-11-05)

**Status: designed 2026-11-05; pinned to v0.4.4 (branch C) by Amendment 1 (2026-11-06, end of file), before any AS1 cell.** The build pin and the knob
key names are filled in after H3 decides the v0.4.3 defaults (§2, §11). Later changes go in timestamped amendments at
the end of this file; the confirmatory stage gets its own pre-registration file, committed before its first cell (§6).

**The user's instruction (2026-11-05):** "turn every stone on identified potential fix combinations, smartly: not all
eggs in one basket, but sweeping across hypotheses and nudging where we get positive signals."

AS1 has three stages:

| stage | question | tasks | claims |
|---|---|---|---|
| **S, screening** | which single fixes move the hidden-test fraction, against a control in every wave | 17 (selected on P2G41 outcomes) | exploratory only |
| **I, interaction** | do the 2–3 best fixes add up, or interfere | the same 17 | exploratory only |
| **C, confirmation** | the best combination vs the control vs opencode V2, concurrently | all 29, k = 3 | the only stage that supports claims |

Files: `apparatus/allocation.py` (the rule, pure and deterministic), `apparatus/run_as1.py` (scheduler/runner),
`apparatus/arms/*.toml` (every arm as data), `apparatus/surface_patch.py` (fragment → surface patch → mechanism
checks), `apparatus/gnomon_harbor_as1.py` (the one adapter), `apparatus/wiretest_as1.py` (pre-launch wire test),
`apparatus/simulate.py` + `sim_as1.py` (offline simulation → `ALLOCATION-SIM.txt`), `apparatus/sizing_as1.py`
(→ `SIZING.txt`), tests `apparatus/test_allocation.py` (36) and `apparatus/test_surface_patch.py` (78),
`DRY-RUN.txt` / `DRY-RUN-lean.txt`, `CONFIRMATORY-PRE-REGISTRATION.template.md`.

## 1. Why

- **P2G41** (`../p2g41-2026-11/`, v0.4.1, 29 tasks, concurrent with opencode V2):
  - release defaults (A41) 0/26 solved, 20 capped, hidden-test fraction 0.303;
  - the hosted recipe (B41) 3/25 solved, 9 capped, fraction 0.559; opencode (O) 6/28, 12 capped, 0.536;
  - B41 − O on fraction +0.062 [−0.097, +0.226] (parity shown narrowly); on solved, parity not shown.
  - Ranked root causes (`analysis/REPORT.md`): no reasoning replay; **answers wrong with time left** (16 cells, median
    996 s left, 5 near misses); long commands blind to the cap; environment; output-limit truncation; network denied.
- **H1/H2:** the recipe removes timeouts; a prompt rule to "verify every requirement" changed nothing (C ~ B).
- **H3** (running; ends ~00:30Z 2026-11-06) decides whether `replay_reasoning` becomes a default in v0.4.3.
- **N1** stopped for futility: the idle nudge does not help when it reaches the model.
- **The research notes** (`research_notes/Long task harness improvements/{harnesses,models-recipes}.md`) grade a dozen
  candidate fixes A–D. Most have only bundled or vendor evidence; several are cheap knobs. Testing them one at a time,
  each at full confirmatory size, would cost ~$60 per fix. AS1 screens them all cheaply, spends more where the data
  look promising, and confirms only the best combination.

## 2. Build, branches and the control

**One build for every arm**, pinned three ways exactly as H3 pins v0.4.2 (SHA256SUMS hash, each tarball against it,
`gnomonBuild` + `gnomon --version`), recorded per trial (`gnomon-release.txt`, `gnomon-version.txt`) and checked again
at scoring (`agent_version` must start with `gnomon v<version> <commit[:16]>`, else the cell is an apparatus failure).
The pin lives in `apparatus/build.toml`, now `status = "pending"` with `{{placeholders}}`; `run_as1.py` refuses to run
until it is `ready`. The build is v0.4.3 as released, or a pinned master build served from a local mirror (§11).

**The control runs in every wave** and is the current best default. Two branches, decided by H3's own pre-registered
rule, are both registered now:

| branch | when | control (`arms/`) | surface |
|---|---|---|---|
| **A** | H3 adopts replay as a default, and the build ships PR #153's default changes | `CTL.A.toml` | the release's own scaffold + P2G's attempt-1 `_PATCH` (no edits): replay learned per endpoint, idle nudge off, 65,536-token window |
| **B** | H3 does not adopt it | `CTL.B.toml` | the build + H1's hosted recipe, declared: `replay_reasoning = true`, `max_context_tokens = 1000000`, `nudge_after_idle = 100000` |

Under branch B the window arm (W) is part of the control, so it does not run (12 arms instead of 13).

## 3. Tasks, scoring and validity

### 3.1 Screening set (stages S and I): 17 tasks, selected on earlier outcomes

The P2G tasks whose hidden-test fraction **differed between at least two of P2G41's three arms**:
atrx-vep-crispr, batched-eval-parity, cargo-flight-dispatch, data-anonymization, fin-saccr-rwa,
layout-config-recreation, mvcc-lsm-compaction, ontology-kg-querying, production-planning, protein-autointerp-disulfide,
retro-console-soc, roy-polymorph-cn, satb-audio-transcription, session-window-debug, shadow-relay,
vpp-loss-divergence, wal-recovery-ordering.

Left out, and why (from `../p2g41-2026-11/analysis/cells.csv`):
- **all-zero in all three arms (3):** biped-contact-dynamics, lake-temp-glm, sound-change-cascade;
- **the same intermediate fraction in all three very different arms (4):** html-js-filter (1/2), interleaved-vigenere
  (2/6), layout-config-recreation2 (1/9), pretrain-shard-corruption (7/12); three of the four capped in every arm —
  the least sensitive to a harness change;
- **gnomon never ran (2):** risk-scorer-replay (read-only `/app`; fixed by PR #153's fallback), vf2-speedup-networkx
  (DNS failure installing gnomon);
- **no ctrf, so no fraction (3):** bun-sourcemap-leak (all invalid), music-harmony, react-lead-form.

**Selecting tasks on earlier outcomes makes stages S and I exploratory only.** A task that varied once may vary by
noise (self-flip 14.7%), and a selection on variation favours tasks where *any* change looks like an effect. The
confirmatory stage uses **all 29 tasks** for exactly this reason (benchmark-discipline: never build a set by selecting
on outcome and then claim on it).

### 3.2 Cell scoring (as P2G41/H3, plus the AS1 mechanism check)

- **Valid:** Harbor recorded a verifier reward, **and** the arm got at least one model response with usage, **and**
  the surface patch did not refuse, **and** no *fatal* mechanism expectation of the arm failed (§4.2), **and** the
  agent version carries the build pin. Anything else is an apparatus failure, never scored, and re-run (§4.5).
- **Hidden-test fraction** (primary): ctrf passed/tests. **Solved:** reward = 1.
- **Capped:** Harbor's `AgentTimeoutError` at the 1,800 s cap **or** gnomon's own `stop_reason = "deadline"`. A
  `--deadline` self-stop is a timeout under another name, so the deadline arm cannot win the cap guard by renaming.
- **False finish** (guard): valid, unsolved, not capped, ended on its own (`stop_reason = "answered"`, or no record;
  for opencode any self-ended run), with **≥ 300 s of the cap left** (agent execution ≤ 1,500 s). A run ended by the
  step wall, a stall or an endpoint error is wrong but not a false finish.
- **Buckets** solved / wrong / capped / invalid are asserted to sum to the cells run, per arm, in every report.
- **Billing** from the wire (`runs/<cell>/wire/calls.jsonl`, the log relay), as H3.

## 4. Stage S: screening with adaptive allocation

### 4.1 Arms (each a TOML fragment over the control; one variable per arm)

| id | family = level | what changes | evidence (grade) | knob |
|---|---|---|---|---|
| **AA** | null | nothing: a second control in the wave (A/A, noise floor, rule calibration) | benchmark-discipline §7 | — |
| **W** | window = 1M | `[endpoints.bench] max_context_tokens = 1000000` (branch A only) | H1 recipe; harnesses #1 (A) | exists |
| **D** | deadline = 1740 s | `gnomon task --deadline 1740` | P2G41 cause 3; harnesses #9 (C) | PR #153 |
| **GC** | completion_gate = checklist | `[verify] completion_gate = "checklist"` | P2G41 cause 2; harnesses #2 (B) | #152 (master) |
| **GR** | completion_gate = review | `[verify] completion_gate = "review"` | harnesses #3 (B) | #152 |
| **EL / EH / EM** | reasoning_effort = low / high / max | implementor `reasoning_effort` | models-recipes §6.2 (B) | knob PR |
| **S** | sampling = provider | no temperature / top_p from the implementor | P2G41 cause 5; models-recipes §6.3 (B) | knob PR |
| **ENV** | env_snapshot = on | environment snapshot at turn 0 | harnesses #5 (B) | knob PR |
| **TODO** | todo_gate = on | no answer accepted while todos are open | harnesses #6 (C) | knob PR |
| **EDIT** | edit_variant = compat | opencode-like edit arguments and fuzzy matching | harnesses #8 (C) | knob PR |
| **PKG** | package_index = pypi+npm | read-only package-index allowlist | P2G41 cause 6 | knob PR |

- **"auto" window is not testable behind the slot relay:** `GET <base>/models` answers 404 there
  (`https://opencode.ai/inference/go/openai/v1/models` → 404, probed 2026-11-05), so "auto" would fall back to 65,536
  with a `context_window_unresolved` degradation and W would equal the control. W declares the number "auto"
  resolves to on the public listing (`https://opencode.ai/zen/go/v1/models`: deepseek-v4.1-flash `limit.context` =
  1,000,000, fetched 2026-11-05). "auto" itself is a product path tested by unit tests (CONTRACTS §24).
- **EH** may sit close to the control (DeepSeek's documented default effort is high); it stays a real arm. The A/A arm,
  not EH, is the null calibration.
- **Key names of the knob-PR arms** (EL/EH/EM, S, ENV, TODO, EDIT, PKG) are proposals (`status = "pending-knob"`):
  each is confirmed against the knob PR's CONTRACTS, edited if needed, and flipped to `ready` before launch. Their
  mechanism expectations are the acceptance test: the pre-launch wire test must pass them on the pinned build.
- An arm runs only if its fragment is `ready` **and** every knob it `requires` is in `build.toml`'s `knobs`. Arms
  whose knob did not land are listed as excluded in the round-0 ledger entry, never silently dropped.

### 4.2 Arms are data: the surface patch and the mechanism checks

Each cell's surface = `gnomon init` + P2G's attempt-1 `_PATCH` + the control fragment + the arm fragment(s), merged on
the host (two fragments setting one key differently is an error; GC+GR and EL+EM are therefore refused by
construction), compiled into one `node -e` patch that edits the TOML line by line and **refuses (exit 3, no model
call)** unless every edit landed exactly once. Role-table edits also go to every profile that declares the same key,
because `role_profile` merges over roles.toml per field (P1). The Python reference implementation and the node patch
are required to agree byte for byte on the real v0.4.2 scaffold for every fragment (`test_surface_patch.py`).

Each fragment declares `[[expect]]` checks on the cell's record, copied surface, wire request bodies or stderr. A
**fatal** check that fails is positive evidence the arm is not what it says: the cell is an apparatus failure, the arm
is suspended, fixed and re-run. A check that cannot be evaluated (a capped run has no final record) is
"unverifiable", never a failure. **Warn** checks (behavioural, e.g. "replay happened") are reported only.

### 4.3 The allocation rule (`allocation.py`; `Params` defaults; seed 20261107)

Unit: a **wave** = one task, three concurrent cells on P2G relay slots 0–2 (rotated per wave; start order rotated
per wave): **the control + two arm cells**. A pair = an arm cell and its own wave's control cell. Waves never pair
across waves.

```
d      = fraction(arm cell) - fraction(control cell, same wave)              in [-1, 1]
model  d ~ N(Delta_a, sigma^2);  Delta_a ~ N(0, 0.15^2)                       skeptical prior
       sigma^2 pooled over all arms' within-arm residuals, prior scaled-inv-chi2(nu0 = 8, sigma0 = 0.30), floor 0.15;
       probabilities from Student-t, df = 8 + sum(n_a - 1)
guards for each of {capped, false finish}: b = pairs where only the arm cell has it, c = only the control cell;
       q ~ Beta(1 + b, 1 + c)   (false finishes counted only in pairs where neither cell was capped)
       HARM  := P(q > 1/2) >= 0.95 and b - c >= 4          WARN := P(q > 1/2) >= 0.85 and b - c >= 3

ROUND 0 (burn-in, not adaptive): every arm gets N_MIN = 4 cells; seeded permutations chunked into pairs of distinct
       arms; each wave's task = the task the two arms have used least, then the fewest waves, then a seeded cycle.
AT EVERY ROUND END (never mid-round), for each ACTIVE arm, in this order:
       n < N_MIN (4)                                   -> stay active (no decision of any kind)
       cap HARM or false-finish HARM                   -> dropped_guard
       P(Delta < 0) >= 0.95                            -> dropped_harm
       P(Delta > 0.05) < 0.10                          -> dropped_futile
       n >= 8 and P(Delta > 0) >= 0.90 and E[Delta] >= 0.05 and no guard WARN
                                                       -> promoted
       n >= N_MAX (12)                                 -> retired_max (undecided)
       else                                            -> active
       Terminal statuses never change.
NEXT ROUND (4 waves): for each wave w, top-two Thompson sampling over ACTIVE arms with n < 12:
       leader = argmax of one posterior draw; challenger = argmax of redraws (up to 100) until it differs;
       draws from numpy default_rng([20261107, 3, round, w]); one active arm left -> it + the A/A arm.
STOP when no active arm is left, or a wave would take the stage past its cap (spend + $2 reserve > cap).
```

**Ledger, committed as it goes** (`ledger/LEDGER.jsonl`, `ledger/outcomes.jsonl`): the round's plan (every wave, its
task, arms, ids) is written and committed **before** the round runs; at its end, every arm's posterior, guards,
decision and reason, the pooled sigma, the spend and the hash of the pair data, and the next round's plan. Commits
take the M1 chains' shared lock (`flock benchmarks/results/m1-2026-11/.commit.lock`) and add only AS1's paths.
`run_as1.py replay` recomputes every decision, data hash and plan from the committed outcomes; any mismatch is an
apparatus fault.

### 4.4 What the rule can and cannot find (offline simulation, `ALLOCATION-SIM.txt`, 400 campaigns per row)

Planted: 13 arms (4 positives, 6 nulls incl. A/A, harmful on primary, on caps, on false finishes); outcome model
calibrated to P2G41/H1/H2 (null pair SD of d ≈ 0.20–0.22). At the recommended $35 screening cap:

| planted (realized on the 17 tasks) | promoted | factorial candidate | cells |
|---|---|---|---|
| +0.20 (+0.145) | 0.59 | 0.61 | 9.4 |
| +0.15 (+0.117) | 0.51 | 0.55 | 9.2 |
| +0.10 (+0.082) | 0.30 | 0.34 | 9.1 |
| +0.05 (+0.043) | 0.15 | 0.16 | 7.8 |
| null (each of 6) | 0.06–0.07 | ≤ 0.07 (A/A never) | 7.1–7.6 |
| −0.15 primary | 0.01 | 0.01 | 5.2 (dropped 0.74) |
| caps +0.30 / false finishes +0.35 | 0.02 / 0.05 | 0.02 / 0.04 | 6.6 / 7.2 |

- A good-but-capping arm (+0.15 fraction, +0.40 caps) is promoted 0.12 (clean +0.15: 0.47) and dropped by the guard 0.55.
- **Global null (13 null arms): P(any arm promoted) 0.57 at $35 (0.36 at $25)**, 6.9% per arm. Hence promotion is
  exploratory, and stage I re-tests on fresh cells before anything is confirmed.
- **End to end** (S → I → choice): planted, P(something goes to confirmation) 0.67, P(it includes the best arm) 0.42,
  P(it includes a harmful arm) 0.02; **global null, P(a null combination reaches confirmation) 0.10**.
- At the user's suggested $25: the +0.20 arm is promoted 0.41, end-to-end P(confirmation) 0.55.
- **Honest reading:** the screen reliably surfaces only large effects (≈ +0.15 realized, i.e. +0.2 nominal). A +0.08
  effect is found about a third of the time. The classical MDE of one arm at n = 8 is 0.29 (`SIZING.txt`). This is a
  sweep for big wins and for harm, not a measurement of small ones.

### 4.5 Re-runs ("fix, don't fail"), peak windows, host

- A wave with a lost pair (invalid control, or an invalid arm cell) is re-run **once**, at the end of its round, as a
  fresh control plus the lost arms (`<wave>r`); a lost pair is never recovered against another wave's control.
  A second failure is reported with its cause, investigated and fixed before the arm continues.
- No wave starts if any minute of the next 40 would fall in Go's 2× windows (weekdays 01:00–04:00 and 06:00–10:00
  UTC, Go listing fetched 2026-11-05; only DeepSeek lists the multiplier).
- A wave starts only when the three slot relays are idle (no request in flight, no counter movement in 15 s): AS1 runs
  **after** H3 on the same slot relays and never alongside another benchmark on them. AS1's log relays bind
  172.17.0.1:4730–4732 (H3's are 4720–4722), and `--after-pid <H3 runner pid>` waits on the pid, not a name.
- `--min-avail-gb 24`, as H3.

### 4.6 Exploratory companions (reported, never decision-bearing)

- Every arm's paired fraction difference with a task-bootstrap interval (paired.py, ST1), its cap and false-finish
  rates, $/cell from the wire, and the A/A arm's per-pair SD of d (the measured noise floor of this build).
- The task-random-effects GLMM on **solved** (bayes.py, ST3, pinned at analysis-st `53bfc9c4`): not used to allocate
  (it models a rare binary outcome, its HMC is too slow to refit each round, and its draws are not bit-reproducible).
- **Calibration check:** if the A/A arm is promoted or dropped as harmful, the report says the rule was miscalibrated
  on real data and every promotion is read with that caveat.

## 5. Stage I: interactions (fresh cells, same 17 tasks)

### 5.1 Factors
Per family, the best promoted level (by posterior mean); families ranked; **at most 3**. If fewer than 3 families
have a promoted level, families with a near-promoted level (P(Δ > 0) ≥ 0.85, E[Δ] ≥ 0.05, no guard warning, not
dropped) fill up to 3. The A/A arm is never a factor. Mutually exclusive levels (GC/GR, EL/EH/EM) never meet.

### 5.2 Design
- k = 3: the full 2³; k = 2: 2²; k = 1: a replication (control + the arm, 8 waves, third slot idle); k = 0: stop.
- **Why not 2^(4−1) for four factors:** with the control in every wave, I = ABCD runs only even-parity combinations,
  so a single strong factor could only be confirmed together with a second (possibly null) one; the full 2⁴ costs ~2×
  this stage's budget. The 4th-ranked family is reported as the next candidate.
- Every wave = the control + two non-control combinations; combinations paired cyclically ((i, i+1) and (i, i+3)
  mod 7 for k = 3), so each appears 4 times, no pair repeats, and every wave is on a different task: **14 waves**
  (k = 2: 6). The stage's plan is written to `INTERACTION-PLAN.json` and the ledger, and committed, at the end of S.

### 5.3 Analysis and choice
- Bayesian linear model in effect (±1) coding on the paired differences (combination − its wave's control): main
  effects ~ N(0, 0.15²), two-factor interactions ~ N(0, 0.10²), three-factor assumed negligible, sigma = the
  screening's pooled sigma. (Indicator coding was tried first and rejected: it shrank one-factor combinations more and
  so favoured adding factors.)
- Choose the combination with the highest posterior mean among those with **P(effect > 0) ≥ 0.85** and no guard harm
  on its own pairs; within 0.03 of the best mean, **fewer factors wins**.
- **If none qualifies, nothing goes to confirmation** (`CHOICE.json` says so); no fallback to a screening winner.
- Offline checks: an additive single factor is chosen alone; two additive factors are chosen together; a planted
  negative interaction keeps the pair out (`test_allocation.py`).

## 6. Stage C: confirmation (the only stage that supports claims)

- **Arms, concurrently, every wave:** C* (the control + the chosen fragments), the control, opencode V2
  (`p2_agents:OpencodeV2`, P2G's pinned adapter). Slots and start order rotated per wave.
- **Tasks:** all 29 P2G tasks, **k = 3**: three passes, each over all 29 tasks in a seeded order
  (`random.Random(100 + pass)`), so a budget stop leaves complete passes. 87 waves, 261 cells.
- **A separate file, `CONFIRMATORY-PRE-REGISTRATION.md`, is committed before the first C cell** (from
  `CONFIRMATORY-PRE-REGISTRATION.template.md`): it names C*, the build, the ledger state and the analysis code by
  commit. `run_as1.py` refuses stage C unless that file exists, has no placeholders and is committed as it stands.
- **Analysis (registered now, restated there):** per task, the attempt-averaged hidden-test fraction and solve rate;
  paired per-task differences; task-bootstrap 95% interval (10,000, seed 20261111) and exact sign-flip test (paired.py
  ST1 at `53bfc9c4`); exact McNemar on solved (cells and tasks); non-inferiority margin **10 points** on fraction and on
  solved: "non-inferior" only if the interval's lower bound > −0.10.
- **Multiplicity — fixed sequence, α = 0.05 each, stop at the first failure (later rows descriptive):**
  1. C* vs control, fraction, superiority (lower bound > 0): the reason to ship C*;
  2. C* vs opencode, fraction, non-inferiority at 10 points;
  3. C* vs opencode, solved, non-inferiority at 10 points;
  4. C* vs control, solved, superiority.
- **Guards:** capped and false-finish rates per arm with paired differences; a C* that raises caps by > 10 points over
  the control is not shipped whatever its fraction.
- **Power (`SIZING.txt`, causal-decision PR #107 paired sizing):** per-task SD of d at k = 3: 0.20 vs the control,
  0.36 vs opencode. At n = 29: MDE80 vs the control **0.11**; P(non-inferiority to opencode shown | true parity) ≈ 0.3,
  ≈ 0.6 at +0.05. A "not shown" against opencode is the expected outcome at parity and is never written as "trails"
  or "equal".

## 7. Optional stratum: planner-model ladder

- `gnomon task --role plan`, the plan role on **P0** deepseek-v4.1-flash (the stratum's own control), **PG** glm-5.3,
  **PK** kimi-k3.1-pro (both on Go's listing, fetched 2026-11-05), delegating to the implement role on DeepSeek. One
  wave = P0 + PG + PK on one task. Stratum base in all three: `steer_role = "user"` (Kimi's listing: no late system
  messages) and no sampling overrides on the plan role (Kimi: temperature/top_p not accepted).
- 6 waves on the first 6 tasks of the seeded screening cycle; stops after wave 1 if the PK cell cost more than $1.00
  (GLM $1.40/$4.40, Kimi $2/$10 per M vs DeepSeek $0.15/$0.60). Cap $10. Needs `AS1_PLANNER_APPROVED=yes`.
- Descriptive only (6 pairs). It never feeds stages I or C.

## 8. Budget and calendar

| profile | screening | interaction | confirmation | total (+ planner) |
|---|---|---|---|---|
| **recommended** | **$35** | **$14** | **$65 (k = 3)** | $114 (+$10) |
| lean (the user's suggestion) | $25 | $10 | $40 (k = 2) | $75 (+$10) |

- The profile is chosen once, before launch, in `build.toml` (`budget_profile`) and committed with the pin.
- **Why more than the suggested $25/$10/$40:** at P2G41's measured wire cost (CTL ~$0.20, C* ~$0.26, opencode $0.22 per
  cell), 29 × 3 × 3 = 261 cells cost ~$59, so $40 buys k = 2, not k = 3. At $25 the screen finds a +0.2 arm 41% of the
  time vs 59% at $35. The interaction stage's 14 waves cost ~$11.6.
- **Round sizes:** burn-in 26 waves (13 arms × 4 cells / 2; branch B 24), ~$18.8 planned; adaptive rounds of 4 waves
  (8 arm cells); interaction 14 waves; confirmation 87 waves (3 passes of 29).
- **Gates:** a wave starts only if the stage's spend + $2 ≤ its cap (planner: $3); spend is booked from the wire.
- **Calendar** (`DRY-RUN.txt`, 30 min/wave, no wave in a 2× window), if launched Sat 2026-11-07 00:00Z: screening to
  ~Sat 22:00Z (44 waves), interaction to ~Sun 05:00Z (14), confirmation to ~Tue 2026-11-10 16:30Z (87, with weekday
  pauses 01–04 and 06–10 UTC). Stage transitions need the operator (the confirmatory pre-registration commit).

## 9. Claims

- Stages S and I are **exploratory**: every number from them is labelled so, and none is reported as an effect of a
  fix. "Promoted" means "worth a confirmatory look", nothing more.
- Only stage C supports claims, through the fixed sequence of §6. Rows are never pooled across stages or with P2G41,
  H1–H3 (time-separated).

## 10. Apparatus checklist (benchmark-discipline), as designed

- Pinned build, recorded per trial, refused on mismatch; peers pinned (opencode V2 adapter as P2G). ✔
- Audit on (the `_PATCH`), traces copied live every 20 s and archived per cell; stop reason per trial. ✔
- Control in every wave; one variable per arm; the A/A arm measures the noise floor in the same run. ✔
- Clock: the same 1,800 s cap for every arm; `--deadline` self-stops scored as capped. Permissions: `approval =
  never` for every gnomon arm. Transport: per-arm client failures counted from the wire. ✔
- Validity rule, scoring and buckets pre-registered (§3.2); MDE stated (§4.4, §6). ✔
- Concurrent arms share a host by design (as P2G41/H3): slots and start order rotate so no arm owns the headroom.
- Nothing rebuilt under a running stage: the build is a pinned tarball set; `run_as1.py` never edits apparatus files.

## 11. To fill in before launch, and the launch commands

1. **H3's decision** → branch A or B (`build.toml: branch`).
2. **The build**: v0.4.3 release (or a pinned master build in `apparatus/build/v<version>/`, `source = "mirror"`):
   `version`, `commit`, `build_stamp`, `sums_sha256`, `release_published`.
3. **Knobs**: `build.toml: knobs` = the knob names this build provides; for each knob-PR arm, confirm the key name in
   its fragment against the PR's CONTRACTS and set `status = "ready"`.
4. **Budget profile**: `recommended` or `lean`.
5. **Wire test**: `python3 apparatus/wiretest_as1.py <npm prefix with the build> <empty dir>` → `wiretest-as1.txt`
   PASS; its sha256 into `build.toml: wiretest`. Then `build.toml: status = "ready"`, commit (an amendment entry here).
6. **Gates**: `python3 apparatus/run_as1.py check` (build, arms, wire test, relays up, log-relay ports free).

```
cd ~/gnomon-wt/peers/benchmarks/results/as1-2026-11/apparatus
python3 run_as1.py dry --write                                   # the plan under the filled pin
python3 run_as1.py check
AS1_APPROVED=yes nohup python3 run_as1.py run --stage screen --after-pid <H3 runner pid> --push \
    > ../run-screen.log 2>&1 &
AS1_APPROVED=yes nohup python3 run_as1.py run --stage interact --push > ../run-interact.log 2>&1 &
# commit ../CONFIRMATORY-PRE-REGISTRATION.md (from the template), then:
AS1_APPROVED=yes nohup python3 run_as1.py run --stage confirm --push > ../run-confirm.log 2>&1 &
# optional: AS1_APPROVED=yes AS1_PLANNER_APPROVED=yes python3 run_as1.py run --stage planner
```

## 12. Considered and not used

- **Plackett–Burman screening** (all knobs on in a 12-run fraction): far cheaper per main effect, but aliases main
  effects with the two-factor interactions we expect (gate × deadline, effort × gate), makes per-arm guards and
  mechanism checks compound, and one broken knob would invalidate every run.
- **bayes.py's GLMM for allocation**: see §4.6.
- **A fixed one-arm-per-study series** (H-style): ~$60 per fix to confirm; AS1 spends that only on the winner.
- **Window "auto"**: not testable behind the relay (§4.1).
- **2^(4−1) half fraction**: see §5.2.

## Amendment 1 — the v0.4.4 pin, control C, the GC×deadline arm, the lean budget (2026-11-06T14:40Z, before any AS1 cell)

Written and committed before the first AS1 cell; no outcome of AS1 exists. Everything not named here stands as
registered (§3 scoring and validity, §4.3 allocation rule and seed, §4.5 re-runs/peak windows, §5, §6, §9).

**What changed since §2 was written.** H3 finished: `replay_reasoning` ADOPTED by its pre-registered rule (R1−R0
hidden-test fraction +0.160 [+0.042, +0.293], capped 14 vs 19); the rest of the recipe (1M window + nudge off, R2−R1)
+0.017 [−0.095, +0.138], not shown. LG1: switching the idle nudge off regresses local tokens 1.43× [1.04, 2.15]
(verdict "regresses"). The resulting build is **v0.4.4** (tag `v0.4.4` = master `6b7f821098df`): replay on by default
for **hosted** endpoints only, the idle nudge **unchanged at 12** (#153's nudge-off trimmed), `--deadline`, and
v0.4.3's sweep knobs (#154, CONTRACTS §32). Neither branch A (assumed the nudge off) nor branch B (the 1M recipe as the
control) matches it, so a third branch is registered.

### A1.1 Build pin
- **v0.4.4**, commit `6b7f821098dfcbd104c869f3da885f0ef15e1261`, `gnomonBuild` `v0.4.4-6b7f821`, `gnomon --version`
  = `gnomon/0.4.4+v0.4.4-6b7f821`; `SHA256SUMS` sha256 `eae55819fa21063eae584d9811db1dcf6b6d1ee34f9819987bc565adf67bec98`.
- The GitHub release is built (15 assets) but still a **draft** (not public), so the §11 mirror mechanism is used:
  `gh release download v0.4.4` of SHA256SUMS and the four npm tarballs into `apparatus/build/v0.4.4/` (gitignored),
  each tarball checked against SHA256SUMS on the host (4/4 OK), served by `run_as1.py` on 172.17.0.1:4739
  (`source = "mirror"`). The adapter's three-way pin (sums hash, each tarball, gnomonBuild + `--version`) runs in every
  cell exactly as registered, so the source does not matter. Recorded per trial as registered.
- `build.toml` knobs: `replay_default, deadline, completion_gate, reasoning_effort, sampling_passthrough,
  env_snapshot, todo_gate, edit_variant, package_index_allowlist, steer_role` — **not** `nudge_default_off`.

### A1.2 The control: branch C (`arms/CTL.C.toml`)
- **v0.4.4's own release scaffold + P2G's attempt-1 `_PATCH` + one declared line, `[endpoints.bench]
  replay_reasoning = true`.** Window 65,536 (scaffold), `nudge_after_idle = 12` (scaffold), no sweep knob.
- **Why the declared line.** Every AS1 cell reaches Go through a log relay at `http://172.17.0.1:473x`, a private
  172.16/12 address, which v0.4.4 (`isLocalLaneUrl`, CONTRACTS §31) classifies as a *local lane*: undeclared, replay
  stays off in every cell and the control would be H3's R0, the arm replay beat — not what a user on Go gets from
  v0.4.4. Declaring it reproduces the hosted default (the default turns on from the request after the first reasoned
  tool reply; declared, from the first request, which has no earlier reasoning to carry either way; the only other
  difference is the default's resend-once-on-a-400 fallback, which Go/DeepSeek never triggered in H3). The wire test
  shows the second request carrying `reasoning_content` and `replay_reasoning_source = "declared"`.
- **How it differs from branch A:** A assumed #153 also switched the idle nudge off; under C the nudge stays at 12 in
  the control and in every arm. From B: no 1M window and no nudge-off in the control.
- Expectations (fatal unless noted): record window = 65,536; surface `turn.nudge_after_idle` = 12; surface
  `endpoints.bench.replay_reasoning` = true; `replayed_calls > 0` (warn).

### A1.3 Arms under C (13; burn-in 26 waves as registered)

| arm | status | key (confirmed against CONTRACTS §32 on master/v0.4.4) | change from the registered fragment |
|---|---|---|---|
| AA | runs | — | none |
| W | **runs** | config `[endpoints.bench] max_context_tokens = 1000000` | branches += C (C's control keeps 65,536, so W is a real one-variable arm, as under A). H3's R2−R1 bundled W with nudge-off and was +0.017, so W alone is untested |
| D | runs | `gnomon task --deadline 1740` | none |
| GC | runs | policy `[verify] completion_gate = "checklist"` (§30) | none |
| GR | runs | policy `[verify] completion_gate = "review"` | none |
| **GCD** | **new, runs** | GC's edit + `--deadline 1740` | see A1.4 |
| EL / EH / EM | runs | roles `[roles.implementor] reasoning_effort` = low / high / max | key as proposed; `ready` |
| S | runs | roles `[roles.implementor] temperature = "provider"`, `top_p = "provider"` | proposed key `sampling` under the role does not exist (it is an endpoint key that would strip every role); replaced by the two role keys. The `temperature not_equals 0.3, all` check was dropped: on an absent field `_test` reads it as a failure (wire test, first run), so it refused exactly what the arm intends; kept: `temperature` and `top_p` absent on any request |
| ENV | runs | config `[context] env_snapshot = true` | proposed table `[turn]` was wrong. **Adds `--trust`**: the snapshot is a workspace-trust grant and the wire test's first run showed gnomon clamping the untrusted surface (`trust.decision = "clamped"`, no `counters.bootstrap`) — the fatal expectation caught it. Expect `counters.bootstrap.id = "env_snapshot"` (fatal), `outcome = "ok"` (warn) |
| TODO | runs | config `[turn] todo_gate = true` | proposed `policy [verify]` was wrong. Expect `counters.todo_gate.max_rounds = 1` |
| PKG | runs | policy `[sandbox] allow_package_index = [pypi.org, files.pythonhosted.org, registry.npmjs.org]` | proposed key name `package_index_allow` was wrong. Expect `counters.package_index.hosts` present |
| **EDIT** | **dropped** | tools.toml `[[tools]] name = "edit"`, `variant = "compat"` | the knob exists, but in an array-of-tables entry of tools.toml, which the line-level surface patch cannot target by construction; extending the patcher now would add untested apparatus. Listed as excluded in the round-0 ledger entry |
| P0/PG/PK | not run | — | the optional planner stratum is not run under the lean budget |

**No nudge arm.** The idle nudge stays at the release's 12 everywhere. N1 stopped for futility (the nudge does not help
when it reaches the model), H3's nudge-off-plus-window bundle added +0.017, and LG1 showed nudge-off costs local
tokens; at the lean budget (one adaptive round after burn-in) a 14th arm would cost every other arm power.

### A1.4 GCD: completion gate (checklist) + `--deadline 1740`, added as an explicit design change
- The user's main hypothesis for the full-solve gap to opencode. By contract the two interact: the gate's
  `completion_min_remaining` is judged against the run deadline when one is set (CONTRACTS §30/§31), else the step
  budget; a one-variable screen of GC and D cannot see that until stage I, and only if both are promoted alone.
- **A two-variable arm, declared as one.** Scored and allocated as any arm (§4.3). It sits in the `completion_gate`
  family, so it never meets GC or GR in stage I, and `subsumes = ["deadline"]` removes the deadline family from stage
  I's factors when GCD is the chosen gate level (`run_as1.subsumed_out`), so no interaction cell repeats `--deadline`.
  If GCD is promoted, the claim it supports is about the pair, not about either part.
- Expectations: `counters.completion_gate.mode = "checklist"` and `volatile.deadline` present (both fatal); a deadline
  self-stop is CAPPED (§3.2), so GCD cannot win the cap guard by renaming timeouts.
- Arm count stays 13 (GCD in, EDIT out): burn-in 26 waves, ~$18.95 planned.

### A1.5 Apparatus changes (all before data, all covered by the offline tests and the wire test)
- `surface_patch.merge`: a later fragment's expectation on the same `(on, path)` replaces the control's (W declares
  window = 1,000,000 while the control pins 65,536; the wire test's first run failed W on the control's check — this
  conflict existed under branch A too).
- `run_as1.py`: branch C accepted; fragments with `status = "excluded"` are excluded in planning as in running;
  `subsumed_out` (A1.4); the launch check read the wire test's verdict with `endswith("wire test: PASS")`, which the
  verdict line `wire test: PASS (gnomon …)` can never match — now the last line's prefix; **host guards**: no wave starts
  with the 1-min load above 30 (`--max-load`; the gx10 hard-halted at ~95–100 on 2026-11-05) or with less than 50 GB
  free on `/` (`--min-disk-gb`; H3 Addendum 2 lost a cell to a full disk); the commit trailer carries the session line.
- `apparatus/chain_as1.sh`: runs screening then the interaction stage unattended and commits/pushes a CHAIN line;
  confirmation still waits for the operator's `CONFIRMATORY-PRE-REGISTRATION.md` (§6).
- Offline tests on the v0.4.4 scaffold (`fixtures/surface-v044`, identical in content to v0.4.2's but one comment):
  **150 passed** (`OFFLINE-TESTS-amendment1.txt`; 114 before, + branch C/GCD/override tests and the node-vs-Python
  parity for the new fragments).
- **Wire test on the pinned build** (`wiretest-as1.txt`, its sha256 in `build.toml`): **PASS** for CTL.C and all 13
  arms, every fatal mechanism expectation passing, plus the read-only-cwd fallback. Two first-run failures were fixed
  as above (ENV clamped by trust; S's absent-field check; W's control window check) — each was the mechanism check
  doing its job.

### A1.6 Budget and stopping rules (lean, the user's choice: ~$75)
- Caps from the wire: **screening $25, interaction $10, confirmation $40 (k = 2, 58 waves)**; planner not run.
- A wave starts only if the stage's spend + $2 ≤ its cap (§8); outside Go's 2× windows (weekdays 01–04, 06–10 UTC);
  with the three slot relays idle; ≥ 24 GB RAM available; load ≤ 30; ≥ 50 GB free disk.
- Screening stops when no arm is active or the next wave would pass the cap; arm decisions as §4.3 (N_MIN 4, N_MAX 12,
  harm/futility/promotion thresholds unchanged). At lean, burn-in (~$19) leaves about one adaptive round of 4 waves;
  ALLOCATION-SIM's $25 row applies (+0.2 arm promoted ~0.41; global-null false promotion 0.36 per campaign).
- Interaction: as §5 within $10 (k = 3's 14 waves at ~$11.6 may stop on the budget; then the fit uses the waves run).
  Nothing goes to confirmation unless §5.3's rule chooses a combination.
- Confirmation needs its own committed pre-registration (§6); at k = 2 the MDE80 vs the control is 0.122 and
  P(non-inferiority to opencode shown | parity) ≈ 0.27 (`SIZING.txt`).
- Dry run under this pin: `DRY-RUN-amendment1.txt` (screen ~31 waves, ~15.5 h; interaction ~7 h).

## Amendment 2 — non-decisional round-end reports (2026-11-06T19:15Z, during screening round 0; reporting only)

Nothing in AS1's design, allocation, stopping, promotion, guards, budget or stages changes; `run_as1.py`,
`allocation.py` and `chain_as1.sh` are not edited and the running chain (pid 627373) and screening runner
(pid 598027) are not touched.

- **What the pre-registration already allows.** §4.3 makes every screening round end a pre-specified look: the fixed
  rule decides each arm (dropped / promoted / retired / active) and allocates the next round by Thompson sampling,
  and the ledger entry (posteriors, guards, decisions, next plan) is committed at once. §4.6 lists exploratory
  companions that are "reported, never decision-bearing", and §9 labels all stage-S/I numbers exploratory. Stage C
  (confirmation) is the only confirmatory stage and is not covered here.
- **Added.** `apparatus/watch_as1_rounds.py`, a separate read-only process (`watch --pid 627373`, polling every 60 s),
  writes `interim/<stage>-r<round>-<kind>.txt` for every committed ledger entry that closes a screening round (kind
  `round` or `end`) and for the interaction stage's end, and commits that one file under the shared lock. Each report
  is headed **NON-DECISIONAL** and contains only (a) that ledger entry rendered (what the rule already decided) and
  (b) §4.6's companions over the cells the decision used (cells with `t_end` ≤ the entry): per-arm buckets solved /
  wrong / capped / invalid (asserted to sum), $/cell from the wire, the paired hidden-test fraction difference
  against CTL, the A/A arm's SD of d. `run_as1.py` never reads `interim/`; the reports cannot feed back into
  allocation. It exits when the chain does (after a last pass), so it never reports confirmation data.
- **Expected report times** (screening at ~25 min/wave, 12 of round 0's 26 waves done at 19:00Z; peak windows Fri
  night none until Mon): round 0 end ~Sat 2026-11-07 01:00–02:00Z (then one adaptive round of 4 waves under the lean
  $25 cap, or the screening end if the budget stops it, ~Sat 03:30Z); interaction end ~7 h later (~Sat 10:00–11:00Z).
- **Concurrency note (FG1 Amendment 2, 2026-11-06).** FG1 stays on one lane (slots 3–5); no third lane was added, so
  AS1's host contention is as described in FG1 Amendment 1.

## Addendum 1 — host power-off, 2026-11-07 (written before resuming; no change to the analysis)

- **What happened.** The gx10 went down abruptly at **~2026-11-06T20:22Z** (last journal line 20:22:05Z, no shutdown
  sequence; 1-min load had been 8–10 at the last wave start, so not the load halt of 2026-11-05) and booted at
  **2026-11-07T05:40Z**. The chain (pid 627373), the screening runner (598027), its mirror, the round watcher and the six
  P2G slot relays (0–5) died with it.
- **Finished before the crash:** screening round 0 waves s00w00–s00w13 (14 waves, 42 cells, every one with `cell.json`
  and an outcome row; booked screen spend **$4.7222**). Kept as is; their outcome rows (on disk, normally committed at
  the round's end) are committed with this addendum so a second crash cannot lose them. Nothing reads them differently.
- **Interrupted:** wave **s00w14 shadow-relay** (started 20:01:31–20:02:11Z). PKG had ended (20:10:38Z, `cell.json`),
  CTL and EM were in flight (no `cell.json`; their Harbor containers were in the agent phase). No outcome row exists for
  any of the three (outcomes are written at the wave's end).
- **Handling — the whole wave is re-run fresh.** A pair is an arm cell and **its own wave's concurrent control** (§4;
  "a lost pair is never recovered against another wave's control", §4.5). With CTL lost, both arm cells of s00w14 lost
  their pair, so §4.5's re-run unit (a fresh control plus the lost arms) is the whole wave. All three cell dirs moved to
  `runs-aborted/<cell>-crash/` (reason file inside), their Harbor job dirs to `jobs-aborted/<cell>-crash/`; the two
  surviving task containers, their compose networks and per-trial images were removed by exact name
  (`shadow-relay__9hnbedm__env`, `shadow-relay__egdxbqy__env`). The finished PKG cell is **not scored** (decided by this
  rule, not by its outcome; it is kept in `runs-aborted/` for the record). The runner re-runs s00w14 under its own id
  with the registered arms, slots and start order: `execute()` skips waves whose cells all have outcomes and
  `run_cell()` skips cells with `cell.json`, so nothing else is repeated.
- **Spend not booked.** The aborted cells' wire spend: PKG $0.0886, CTL $0.2099, EM $0.1707 = **$0.4693** (CTL's and EM's
  wire logs each end in one line truncated by the crash, so a slight undercount). It is not in the runner's budget
  (spend is booked from outcomes), as for H3's crash addendum; it is reported here and in the final summary.
- **Resume.** The same `chain_as1.sh` (screen, then interaction) with `AS1_APPROVED=yes`, `run_as1.py run --stage screen
  --push`, the same build pin (v0.4.4 6b7f821, mirror on 4739), arms, slots, seed, lean caps and host guards (load ≤ 30,
  ≥ 24 GB available, ≥ 50 GB free on /, Go 2× windows, slots idle 15 s), and Amendment 2's read-only watcher. The six
  slot relays are restarted with P2G's `relay-go.mjs` unchanged (same env names; counters restart at zero, which the
  per-cell counter deltas do not depend on). The previous `run-screen.log` is kept as `run-screen.pre-crash.log`.
- **Upstream check before the first cell.** A tiny probe through all six slots at ~05:58Z returned 200 on 3 and
  **429 "Upstream request failed: [overloaded]"** on 3 (repeated singly: about half overloaded), against 0 4xx in
  the 3,580 requests of AS1 and FG1 so far. The operator does not start the runners while the upstream sheds load
  (that would be a transport handicap the earlier waves did not have); the resume time and the probe that cleared
  are in STATUS.txt. 4xx counts are recorded per cell in `delta` as before; validity is unchanged.
- **Time covariate.** Waves s00w00–s00w13 ran Fri 2026-11-06 14:44–20:01Z; the rest run from Sat 2026-11-07 after a
  **~10 h** gap. Every wave pairs within itself, so the gap hits a wave's control and arms equally; wave start times
  are in STATUS.txt and `t_end` per outcome.
- **Unchanged:** validity, scoring, allocation rule and seed, round sizes, caps, stages, decision rules.

## Amendment 3 (AS1) — Go allowance guard and account rotation (2026-11-07T06:18Z, before the post-power-off resume; no analysis change)

**Why.** The OpenCode Go account behind every relay slot has ~8 % of its weekly allowance left (user, 2026-11-07:
the relays bill as `go-plus`; Go Plus weekly for deepseek-v4.1-flash = 50 % of the $200 monthly = $100, so ~$8).
AS1 needs ~$20 more and FG1 ~$36 (+ the hub lane, same cells). The user has further standard Go accounts. Without a
guard, the account would run dry mid-wave and the remaining cells would fail on the transport, scored as capability.

**How exhaustion shows up** (from opencode 1.18.32's own client code, `GoUsageLimitError` handling; the Go docs give
no error format): an HTTP error whose body names `GoUsageLimitError` with `metadata.limitName` (the 5-hour, weekly
or monthly window) and a `retry-after` header (seconds to the reset). It is distinct from
`429 {"error":{"type":"server_error","message":"Upstream request failed: [overloaded] ..."}}` (provider busy, says
nothing about the account). With Extra Usage on, Go does not refuse but bills the Console balance:
`usage.opencode.billing_source` = `"balance"` and `cost` > 0 — treated as exhaustion. Go has no remaining-allowance
API; per docs, 5-hour = 20 %, weekly = 50 % of the per-model monthly limit (deepseek-v4.1-flash: Go $100, Go Plus $200).

**Guard** (`p2g-2026-11/apparatus/go_allowance.py`, records in `go-accounts-2026-11/`):
- Before every wave, after the existing slot/window checks, the runner calls `wave_gate(study, wave, reserve)`. It
  blocks — the runner stays alive, no wave starts — while any of these holds: the current account is flagged
  exhausted; an account switch is in progress; the metered headroom of the 5-hour, weekly (or, if stated, monthly)
  window is below this wave's reserve (the study's existing $2 per-wave reserve, = one wave's spend; dearest wave so
  far $1.54) plus the reserves of the waves other lanes have in flight. Headroom = the operator's Console baseline
  (`ACCOUNTS.json`) minus everything the relays' `allowance` counters have added since (restart-aware).
  On blocking it writes `PAUSED: Go allowance — <reason>` to both STATUS.txt files; `RESUMED: Go allowance` when clear.
- Every cell's wire is scanned at scoring: a `GoUsageLimitError` body, a `balance` billing source or a billing
  label other than the account's makes the cell **apparatus-invalid** (`invalid_reason` "apparatus: Go allowance — …")
  and flags the account, so the existing "fix, don't fail" re-run covers it (FG1: the wave re-runs whole; AS1: the
  lost pair re-runs with a fresh control). relay-go.mjs additionally counts `go_usage_limit` and `billing_sources`
  (counters only, active from the relays' next start), which the gate reads too.
- Per cell, new covariates: `go_account` (non-secret label acct1, acct2, …), `go_billing` (billing_source tally),
  `list_usd` (list price of the cell, plan-independent).

**Account rotation** (`p2g-2026-11/apparatus/switch_go_account.sh <auth-file> [label] [plan] [weekly_remaining]`):
the user logs each extra account into its own opencode data dir (`XDG_DATA_HOME=$HOME/.local/share/oc-acct2 opencode
auth login` → `~/.local/share/oc-acct2/opencode/auth.json`; opencode 1.18.32 resolves its data dir from
XDG_DATA_HOME, verified with `opencode auth list` on an empty dir). The script blocks new waves, waits until no wave
is in flight and every slot is idle 60 s, restarts each relay on the old account's auth file (slots 0–5 and the hub
lane's 6–8) by its pid exactly as started (cwd, argv, RELAY_* env, log) except RELAY_AUTH_FILE, probes every slot
once (must be 200, billed as the plan's label, cost 0), and records the switch (switches.jsonl, STATUS, commit).
Credentials never pass through the operator or the agent: only the relay process reads the auth file.

**What may differ between accounts, and how it is handled.** Same model id (deepseek-v4.1-flash), same endpoint
(opencode.ai/inference/go), same relay and client stack. Per the Go docs token prices are identical across Go, Go
Plus and Go Teams and the model list is the same; plans differ in limits (Go Plus 2× for this model) and in the
billing label (`go` vs `go-plus`). The allowance/list ratio seen on go-plus is 1.2; the switch probe measures it
for each new account and records it in ACCOUNTS.json. Budgets and reserves stay in allowance dollars from the wire
as pre-registered; if a new account's ratio differs, `list_usd` per cell gives the plan-independent spend, and
reports state both. The docs do not say whether the serving route differs by plan or workspace; a standard Go
workspace must have **Global** selected under Settings › Privacy › Regions for deepseek-v4.1-flash, otherwise the
probe fails and nothing switches. The account is therefore recorded per cell as a covariate, and **a switch happens
only between waves**, so every within-wave pairing (each comparison's unit) is on one account. A sensitivity check
by account (estimate with and without the post-switch waves) will be reported as descriptive; the primary analyses
are unchanged.

**Unchanged:** arms, tasks, seeds, plans, validity rules (exhaustion was already apparatus failure; now it is
detected and named), scoring, budgets, interim looks, allocation and decision rules.

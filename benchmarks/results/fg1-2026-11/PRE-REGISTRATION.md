# FG1 — finish gate v2 and the soft-timeout shell on long hosted tasks (pre-registration)

Written 2026-11-06, before any FG1 cell exists. Nothing below was chosen after seeing an FG1 outcome. Changes after
this commit are amendments: dated, appended at the end, and committed before the data they affect.

Apparatus: H3's (`h3-2026-11/`: `run_h3.py`, `gnomon_harbor_h3.py`, `log-relay.mjs`, `wiretest_h3.py`, analysis
re-pointed from P2G41) as generalised by AS1 (`as1-2026-11/`: arms as TOML fragments, `surface_patch.py`, the
three-way-pinned mirror build, host guards), with AS1 Amendment 1's lessons applied (§4).

## 1. Question

Do the two new opt-in mechanisms improve **full solves** on long hosted tasks?

- **FG**: `[verify] finish_gate = "v2"` (PR #162, CONTRACTS §33). The first answer of a turn that changed the
  worktree is handed back once with the task verbatim, open todos, a caveat audit of the answer and claims without
  evidence; accepted after one tool call, at most 2 rounds, skipped with < 15 % of the budget left (steps, or the
  `--deadline` time left).
- **SH**: tools.toml bash `soft_timeout = "handle"` (PR #161, CONTRACTS §34). A bash command still running at the
  yield is not killed: it returns its output so far and a job id; a `job` tool (wait / send / kill) is offered.

Motivating evidence (`~/gnomon/research_notes/Long task harness improvements/reverse-engineering/`):
- `03-own-near-misses.md`: of 35 near-miss cells in P2G41/H3 (hidden fraction >= 0.6, reward 0), 6 ended on an answer
  that named the defect the hidden test checks (FLAG: "one judgement call worth flagging", "`route_feasible: false`")
  and 5 on checks that never exercised the hidden property (BLIND) — the finish gate's caveat audit and evidence
  check target these; 3 capped while re-verifying, one polling a background job with `sleep 30` / `sleep 90`
  (CAP-PERIPH) — the soft-timeout shell targets these. Its own estimate of the realistic upside of all fixes: ~2–4
  of 29 tasks, with wide error bars; about half the near misses are spec misses opencode makes too.
- `01-opencode-codex.md`, `02-terminus-forge-openhands.md`: Codex yields a live handle after 10 s (clamped 0.25–30 s);
  OpenHands returns after 30 s without output and keeps the process; opencode backgrounds; gnomon kills at 120 s.
- `04-hybrid-long-horizon.md` planned the soft-timeout arm at a 30 s yield.

## 2. Build (one build, every arm)

- **gnomon master `f8c8a396435127f7adafd6c50878986c4263f157`** = the merge of PR #161 (2026-11-06T16:15Z), master HEAD
  at pin time; it contains PR #162's merge `2bd67c6`, #163 and v0.4.5's security changes. Not a release.
- Built on the gx10 by `apparatus/build_release.sh` exactly as `build-release.yml`'s `npm` job builds a release's
  tarballs (`pnpm install --frozen-lockfile`, `pnpm -r run build`, `gnomonBuild` stamped into gnomon-core only, `pnpm
  pack` x 4, `check-publishable.sh` with `EXPECT_REVISION` = the stamp: "ok: installed package runs standalone —
  gnomon/0.4.5+master-f8c8a39"). Package version 0.4.5 (master is unbumped); stamp **`master-f8c8a39`**.
- Pins (`apparatus/build.toml`): `SHA256SUMS` sha256 `b36543653e7c4a2149eb4a61accc4c5b0708f426a1b9f5179524e2af60df27dc`
  (the four tarballs); `gnomonBuild` = `master-f8c8a39`; `gnomon --version` = `gnomon/0.4.5+master-f8c8a39`. Served from
  `apparatus/build/` (gitignored, regenerable) on the docker bridge, 172.17.0.1:4749, by the runner. Every cell's
  install checks all three (AS1's adapter, unchanged but for names) and an install that fails any of them is an
  apparatus failure; the record's `agent_version` must start `gnomon v0.4.5 f8c8a396435127f7` (§6).
- `run_fg1.py check` re-hashes SHA256SUMS and every tarball on the host before the first wave.

## 3. Arms (one variable each)

Every arm: P2G's attempt-1 `_PATCH` (bench endpoint for every role and profile, `approval = "never"`, audit on), then
the arm's fragment (`apparatus/arms/*.toml`), then the trust grant (§4), then
`gnomon task <instruction> --role implementor --deadline 1740 --yes --json`.

| arm | = | surface edit | why it is one variable |
|---|---|---|---|
| **C** | build's scaffold + `_PATCH` + `[endpoints.bench] replay_reasoning = true` | config.toml, 1 line | AS1's CTL.C: behind the bridge relay (a private address, a *local* lane to gnomon) the hosted replay default would stay off; declared, C is what a Go user gets |
| **FG** | C + `[verify] finish_gate = "v2"` | policy.toml, 1 line | CONTRACTS §33 made it one key on purpose (rounds and floor fixed) |
| **SH** | C + tools.toml `[[tools]] name = "bash"`: `soft_timeout = "handle"`, `timeout_seconds = 30` | tools.toml, 2 keys in one block | one mechanism with one parameter: the yield IS `timeout_seconds` (§34: "no separate yield key"), so it has to be chosen; declared here as a two-key edit, not hidden |

- **`--deadline 1740` in every arm** (the 1,800 s cap minus 60 s for gnomon to stop and write its record). The finish
  gate is deadline-aware (it skips with < 15 % of the time left, i.e. < 261 s), and the SH yield and `job wait` are
  clamped by the deadline's margin; running C and SH without it would make FG differ from them in two ways.
  A deadline self-stop is scored CAPPED (§6), so no arm can win the cap guard by renaming timeouts.
- **The SH yield, 30 s.** Not 120 s (the scaffold's kill timeout): then SH would differ from C only for commands C
  kills — 2 of 520 bash calls (0.4 %) in AS1's v0.4.4 cells so far — and the model would still sit blocked for two
  minutes on every long build, test or training run; the behaviour the evidence points at is getting control back
  early. 30 s is Codex's upper clamp and OpenHands' `NO_CHANGE_TIMEOUT_SECONDS`, and 04's planned value. Not 10 s
  (Codex's default, the PR's example): 17 of those 520 calls ran > 10 s, 5 > 30 s; at 10 s ordinary installs and test
  runs become job round-trips, each a paid request, against the 1.3x spend guard. Consequence, part of the mechanism:
  a command of 30–120 s needs a `job wait` in SH where C waited inside bash.
- Everything else is the build's default in every arm: 65,536-token window, `nudge_after_idle = 12`, completion gate
  and todo gate off (v2 supersedes them anyway), `exec = "off"`. The arms differ only by the edits above, which the
  wire test checks byte for byte (§7).

## 4. The v0.4.5+ key grant, handled explicitly (AS1 Amendment 1, extended)

- AS1 A1.2 found that the log relay at `http://172.17.0.1:474x` is a private address, so v0.4.4+ treats it as a local
  lane (hence replay declared in C, §3), and that a workspace-trust grant (ENV's snapshot) needed `--trust`.
- **New in v0.4.5** (CHANGELOG 0.4.5, `trust.ts keyHostIsDefault`): sending an API key to a non-loopback private
  address is a grant. Untrusted and headless, gnomon runs **clamped**: it deletes the endpoint's `api_key_env`
  (no key is sent) and takes back every other grant. The slot relay injects the real key upstream anyway, so a clamped
  cell would still work, silently, on a different surface than declared. FG1 does not leave that to chance:
- **Declared grant, in the cell's isolated HOME.** After every surface edit and before `gnomon task`, the cell script
  runs `gnomon trust grant --dir <surface root>` (non-interactive; writes the store under the container's
  `~/.local/share/gnomon/trust.json`, never into the repository or the surface hash). It trusts exactly the patched
  surface's hash; its output (`fg1-trust-grant.txt`, which names grants, never values) and `gnomon trust list` are
  kept. On the pinned build the store lists one grant: `endpoint bench sends $OPENAI_API_KEY to 172.17.0.1`. A grant
  that fails stops the cell before any request (apparatus failure). Identical in every arm.
- **Checked per cell** (§7): the log relay now classifies each request's `Authorization` header — `placeholder` /
  `absent` / `other`, never the value (`log-relay.mjs`; the cell's key is the P2G placeholder the slot relay
  replaces); every request of every cell must carry the placeholder, and no audit `trust` record may say `clamped`.
- **Proven able to fail**: the wire test's negative control runs C without the grant on the pinned build: gnomon
  prints "untrusted surface … running clamped to the defaults", the fake relay sees `auth = absent`, and the key
  check FAILS. With the grant: `placeholder` on every request, audit `trust` = `trusted` by `store`, no prompt.
- Difference from AS1's control: AS1 ran v0.4.4, where this grant did not exist. FG1's absolute rates are therefore not
  comparable to H3/AS1 cell for cell; FG1 claims only within-study contrasts against its own C.

## 5. Tasks, model, plan

- **Tasks**: P2G's 29 Terminal-Bench 4.0 tasks (`p2g-2026-11/apparatus/tasks-p2g.json`), all of them, not selected on
  outcome. Model **deepseek-v4.1-flash** through OpenCode Go via P2G's slot relays (172.17.0.1:4710+slot), one log
  relay per cell (4740+slot: FG1 never binds a port H3 (4720+) or AS1 (4730+) uses). Cap **1,800 s** (Harbor
  `--agent-timeout-multiplier` 1800/28800), Harbor venv, dataset and flags as P2G/H3/AS1. gx10 (aarch64).
- **k = 3** attempts per (task, arm): 87 waves of 3 concurrent cells (one per arm, slots 0–2) = **261 cells**.
- **Plan** (`PLAN.json`, committed now; the runner refuses if `plan()` differs): attempt-major (all 29 tasks of
  attempt 1, then 2, then 3, so a budget stop leaves complete attempts); within each attempt a shuffled task order;
  within each wave a shuffled arm order, which is both the start order (20 s stagger) and the slot assignment (arm j
  on slot j). One `random.Random(20261107)` stream (**seed 20261107**). Realised: FG starts first in 34 waves, C in 27, SH in 26; each arm runs on each slot in 24–36 waves (PLAN.json).

## 6. Scoring and validity (as AS1 §3, plus §7's checks)

- **Valid cell**: the install pinned (agent_version), the surface patch and trust grant succeeded, no fatal mechanism
  check failed (§7), a verifier reward exists, and at least one model response with usage reached the relay.
  Anything else is an **apparatus failure** (invalid), recorded with its reason, never scored as a model failure.
- **solved** = valid and reward >= 1.0. **capped** = Harbor `AgentTimeoutError` or gnomon `stop_reason = "deadline"`.
  **hidden-test fraction** = `ctrf.json` passed / tests (H3's method), where a ctrf exists.
- **Spend**: Go allowance from the wire (`calls.jsonl` usage.opencode.allowance), as H3/AS1.
- **Buckets**: valid + invalid = n, asserted per arm by the analysis.
- **Re-runs ("fix, don't fail")**: after the 87 waves, each wave with an invalid (or missing) cell is re-run ONCE as a
  whole — all three arms, fresh cells, same attempt index (`...r`) — and the re-run replaces the original wave for
  every arm (symmetric: no arm keeps a cell its partner lost). A pair still invalid after its re-run is dropped from
  that comparison and reported. Before any re-run, the cause is looked for and, if it is apparatus, fixed (and
  amended here) first.

## 7. Mechanism checks (fatal per cell unless noted; `fg1_checks.py` + the fragments' `[[expect]]`)

| check | C | FG | SH |
|---|---|---|---|
| surface `endpoints.bench.replay_reasoning = true`, nudge 12, record window 65,536 | ✓ | ✓ | ✓ |
| record `volatile.deadline` present (uncapped records) | ✓ | ✓ | ✓ |
| key on every request (`auth = placeholder`); trust grant ran; no audit `trust` = clamped | ✓ | ✓ | ✓ |
| replay on the wire: a request after the first reasoned tool reply carries reasoning back | ✓ | ✓ | ✓ |
| surface `verify.finish_gate` | absent | = "v2" | absent |
| record `counters.finish_gate` | absent | present, mode v2 | absent |
| audit kind `finish_gate` | none | (reported) | none |
| `job` tool offered on the wire | in no request | in no request | in every request |
| audit kind `job` | none | none | (yields reported) |
| surface bash `soft_timeout` / `timeout_seconds` | absent / 120 | absent / 120 | "handle" / 30 |
| no bash call in the record ran past yield + 5 s (35 s) — a long command must come back as a job | — | — | ✓ |

'Unverifiable' (e.g. a capped cell has no final record) is never a failure. **Per arm** (decision-bearing, §8):
FG must fire (`rounds >= 1`) on **>= 80 %** of applicable records (final records whose `finish_gate.outcome` is
passed / exhausted / skipped_budget; the 80 % allows for skips with < 15 % of the budget left); SH must yield at least
once in the run. An arm that fails its per-arm check did not deliver its mechanism; its comparison is reported, no
adoption. More than 10 % invalid effective cells in an arm (or in C) also blocks adoption.

## 8. Analysis and decision rule (`apparatus/analyze_fg1.py`, written now)

Two separate comparisons, **FG vs C** and **SH vs C**, each paired by **(task, attempt)** over pairs valid in both.

- **Primary — solved.** Exact two-sided McNemar on the discordant pairs; the paired solve-rate difference with a
  **task-cluster bootstrap** 95 % percentile CI (tasks resampled with replacement, every attempt of a drawn task kept;
  10,000 resamples; **seed 20261107**).
- **Decision, per arm: ADOPT as a default only if** (1) the bootstrap 95 % **lower bound > 0**, AND the guards hold:
  (2) **capped(arm) − capped(C) <= +3** over the (up to 87) valid pairs; (3) **spend ratio** $(arm) / $(C) **<= 1.3**
  over the valid pairs; (4) the mechanism was delivered and invalid cells <= 10 % (§7). Otherwise NOT ADOPTED, naming
  the failing condition. Two decisions, each at its own one-sided 2.5 %: at most ~5 % chance of a false adoption
  somewhere under the global null. A lower bound <= 0 is "no evidence of a solve-rate gain at this power", never
  "no effect"; the McNemar p is reported, not required.
- **Secondary (descriptive, not decision-bearing)**: hidden-test fraction difference (same bootstrap, pairs with a
  ctrf on both); capped counts; $/solved; median agent wall time; FG outcomes, caveats at fire and surviving
  (`caveats_final`); SH job yields per cell. Mechanism endpoints are what this design can resolve; the solve endpoint
  probably cannot (§9) — a mechanism that fires with no solve movement is an honest partial result, declared now.
- No subgroup or per-task claim at k = 3.

## 9. Power and MDE (`POWER.txt`, `apparatus/power_fg1.py`, 2,000 simulations x 1,000 bootstrap resamples)

Model: per-task control solve probability from a Beta with the noise floor of P2G41/H3 (solve rate ~10 %, self-flip
~15 %: Beta(0.5, 4.5)), attempts of a task sharing it, the arm a common logit shift. Also H3's measured gnomon rate
(R1 2/27 = 7.4 %; Beta(1.4, 18.6), self-flip ~12 %; a 15 % flip is impossible at a 7 % mean).

| true rise in solve rate | +0.03 | +0.05 | +0.075 | +0.10 | +0.125 | +0.15 | +0.20 |
|---|---|---|---|---|---|---|---|
| P(adopt), 10 % base | 0.11 | 0.20 | 0.35 | 0.55 | 0.72 | **0.83** | 0.97 |
| P(adopt), 7 % base | 0.12 | 0.21 | 0.38 | 0.58 | 0.72 | **0.84** | 0.96 |

- **MDE80 ≈ +0.14 absolute** (between +0.125 and +0.15): ~12–13 net extra solves of 87 pairs, i.e. lifting the solve
  rate from ~7–10 % to ~21–24 %. False adoption at no effect: 0.023–0.027.
- **What k = 3 can resolve, honestly**: 03's realistic upside of ALL its fixes is ~2–4 of 29 tasks (+0.07–0.14); for
  one mechanism less. At +0.075 the chance of adoption is ~0.35–0.38. So FG1 can confirm a large gain and will most
  likely return "no evidence" for a modest one; it cannot show "no effect". The hidden-test fraction (continuous) is
  more sensitive (H3 detected +0.16 at k = 1) but is secondary by the brief's design.

## 10. Budget, stop rules, host guards

- Measured cost: H3 $11.23 / 87 cells ≈ **$0.13/cell**; AS1 screening so far $0.05–0.10/cell; planning at $0.15/cell
  → **~$39** for 261 cells, plus re-runs. **Cap $50** (Go allowance from the wire, all cells and re-runs).
- **Wave reserve $2.00**: a wave starts only if spent + $2 <= $50 (P2G41's dearest wave was $1.54).
- Waves never start inside Go's 2x windows (weekdays 01–04 and 06–10 UTC; the 40-min look-ahead of AS1).
- Host guards before every wave: 1-min load <= 30 (the gx10 hard-halted at ~95–100 on 2026-11-05), >= 50 GB free on
  `/`, >= 24 GB RAM available, the three slot relays idle for 15 s, and **no `run_as1.py run` process** (AS1 uses the
  same slots 0–2: FG1 is never concurrent with it).
- Stop: budget (above), or the operator. A stop leaves complete attempts first (attempt-major plan).

## 11. Launch timing — waiting mode

AS1 is running on slots 0–2 (chain `chain_as1.sh`, pid **627373**, screening then interaction; ETA Sat 2026-11-07
~13:30–15:30Z). FG1's runner is started now, in the background, with `FG1_APPROVED=yes` and `--after-pid 627373`:
1. offline gates only (build hashes, wire-test hash, PLAN.json, free ports) — no relay, no Docker, no request;
2. **waits** until pid 627373 has exited (checked every 60 s from /proc) and no `run_as1.py run` process exists; logs
   AS1's last CHAIN line;
3. only then reads the slot relays' counters (read-only), starts the mirror, and runs wave 1 under §10's guards.
No paid request, relay write (`set_cell`), Docker build or mirror port happens before step 3. Calendar (DRY-RUN.txt,
32 min/wave + Go peak skips): from Sat 15:30Z the 87th wave ends ~Mon 2026-11-09 21:45Z, plus any re-runs.

## 12. Apparatus checklist (benchmark-discipline)

- [x] known cheap defects: the v0.4.5 key grant and the local-lane replay default are handled in every arm (§4, §3)
- [x] ref pinned; SHA, stamp and sums recorded; per-trial agent_version checked; mirror three-way pin per cell
- [x] audit on (`_PATCH`); traces (wire, audit, records, surfaces) archived under runs/ and jobs/ on the host
- [x] control arm C on the same build; one variable per arm (SH's one parameter declared)
- [x] clock symmetric (same cap, same `--deadline`); permissions symmetric (same grant, `approval = never`);
      transport counted per arm (key, relay errors; invalid ≠ model failure)
- [x] validity rule pre-registered; buckets assert-sum to n
- [x] k = 3 budgeted; MDE stated (§9) and larger than the likely effect: said before spending
- [x] arms concurrent within a wave but randomised in start order and slot; never concurrent with AS1
- [x] task file non-empty (29 asserted); negative control fired (§4); wall-clock read per cell (START/END lines)
- [x] outcome from the verifier and the wire/audit, never from the agent's own account
- [x] wire test run in a stranger's state (empty HOME/XDG, no trust store, no credentials)
- [x] the runner waits on a pid, not a process name; no cleanup deletes completed cells (a finished cell is skipped)
- [ ] noise floor of THIS build not separately measured (no A/A arm): C's own k = 3 attempts give its flip rate,
      reported descriptively

## 13. Files

`apparatus/`: `run_fg1.py` (runner), `gnomon_harbor_fg1.py` (adapter), `surface_patch.py` (AS1's + tools.toml
selector + trust grant), `fg1_checks.py`, `arms/{C,FG,SH}.toml`, `log-relay.mjs` (+ key class), `wiretest_fg1.py`,
`test_fg1.py`, `analyze_fg1.py`, `power_fg1.py`, `build_release.sh`, `make_fixture.sh`, `fixtures/surface-scaffold/`,
`build.toml`. Top level: this file, `PLAN.json`, `DRY-RUN.txt`, `POWER.txt`, `OFFLINE-TESTS.txt` (24 passed),
`wiretest-fg1.txt` (PASS on master-f8c8a39; its sha256 pinned in build.toml), `STATUS.txt`, later `ledger/` and
`summary-fg1.txt`.

---

## Amendment 1 — 2026-11-06T17:05Z, before any FG1 cell: relay slots 3–5, concurrent with AS1

Written and committed before any FG1 cell, wave or paid FG1 request exists (the waiting runner, pid 1377901, had made
none: it never left §11 step 2; it is stopped by pid before the new one starts). It changes §5's slots, §10's AS1 guard,
§11's waiting mode and §12's "never concurrent with AS1" line. Everything else stands.

**A1.1 What changes.** FG1 runs **now, concurrently with AS1**, on its own relay slots **3–5**: three more
`relay-go.mjs` instances from `p2g-2026-11/apparatus/`, started exactly as slots 0–2 (same script, same environment
variable names: `RELAY_AUTH_FILE` = opencode's credential file read inside the relay, `RELAY_BIND` 172.17.0.1,
`RELAY_PORT` 4713–4715, `RELAY_COUNTERS_PORT` 4813–4815; logs appended to `p2g-2026-11/relay-p2g-{3,4,5}.log`). Plan
slot j (0–2, PLAN.json unchanged) runs on relay slot 3 + j; the per-cell log relay is 4740 + relay slot = **4743–4745**
(free; AS1 binds 4730–4732, H3 4720+). AS1 keeps slots 0–2 (`run_as1.py`: `(j + idx) % 3`, its idle check reads 0–2
only) and never touches 3–5. `run_fg1.py` drops the AS1 wait (§10's "no `run_as1.py run` process" and §11's
`--after-pid`); every other per-wave guard stays: FG1's own three slot relays idle for 15 s, load ≤ 30, ≥ 24 GB RAM
available, ≥ 50 GB free on /, spend + $2 ≤ $50, no wave inside Go's 2× windows.

**A1.2 Why.** Time only. Waiting for AS1's chain put FG1's first wave at ~Sat 15:30Z and its end at ~Mon 2026-11-09
21:45Z; concurrently, from ~Fri 17:15Z at the same 32 min/wave, the 87th wave ends ~Sun 2026-11-08 15:40Z (later if
contention lengthens waves), before Monday's 2× windows.

**A1.3 Go concurrency, checked before this amendment (not assumed)** — `A1-GO-PROBE.json`, `apparatus/go_probe_a1.py`:
- Probe 1 (16:53Z): one identical tiny prompt (37 input tokens, temperature 0, max 16 tokens) through slots 0, 3, 4, 5
  at once while AS1 had 2 cells running (slot 0 was idle between AS1 cells; no AS1 cell's counter window was touched).
  All 200, no 4xx/5xx; billing_source `go-plus` on every slot; allowance 1.674e-05 for 37 in / 14 out on slots 0, 4
  and 5, 1.53e-05 for 37 / 12 on slot 3 (the 2-token difference = the per-output-token price): **same price per
  token on the new slots as on slot 0**; allowance / list_cost = 1.2 on every probe, as on all 955 AS1 calls so far.
- Probe 2 (17:00Z): the same prompt through slots 3, 4, 5 at once while **AS1 had 3 requests in flight** on slots 0–2
  (6 concurrent requests on one Go key): all 200 in ~1 s, `go-plus`, ratio 1.2, no 4xx; AS1's slots still 0 4xx/5xx.
- Go's docs (opencode.ai/docs/go) state no request-rate or concurrency limit; limits are dollar allowances (5-hour,
  weekly, monthly) — FG1 spends from the same allowance as AS1, so both runs draw it down faster in wall time — and
  peak hours (DeepSeek V4.1 Flash, 01–04 and 06–10 UTC weekdays) bill double, which both runners already avoid.
  P2 ran 6 concurrent slots on one Go key on the hub. A 429 or a limit would show as `status_4xx` on the slot
  counters and as invalid cells (apparatus, re-run per §6), never as a model failure.

**A1.4 Host, checked.** With AS1 running (3 cells): 1-min load 2–14 over the day (AS1's highest wave-start load 19),
~67–70 GB RAM available of 121, ~114–122 GB free on /, 20 cores. One FG1 wave adds 3 Harbor task containers (memory
limits 4–8 GB; the 6 largest P2G tasks together declare 48 GB, below the available RAM; TB tasks declare 4 CPUs, so
6 cells declare up to 24 CPUs on 20 cores — oversubscribed on paper, as P2G41's 6-cell waves were (wave-start loads
up to ~32)). The gx10 hard-halted once at load ~95–100; both runners keep the load ≤ 30 guard before every wave, so
neither starts a wave on a loaded host. The guard is checked at wave start only; mid-wave load is recorded (A1.6).

**A1.5 What this could confound, and why the contrasts survive.**
- Host contention (CPU, memory, disk, Docker daemon, network) now varies with AS1's activity. Within an FG1 wave the
  three arms run concurrently on the same task, so **every arm in a wave shares the same contention**; the
  pre-registered contrasts are paired by (task, attempt) within waves (§8), so contention is a shared shock, not an
  arm difference. Start order and slot remain randomised per wave (§5).
- It can still interact with a mechanism: SH's 30 s yield and FG's < 15 %-time-left skip both depend on wall time,
  so a slower host could change how often they fire. Reported via A1.6, not corrected for.
- Absolute rates and wall times are not comparable to a quiet host; FG1 claims only within-study contrasts (already
  §4's rule). Some C cells may cap that would not have on a quiet host; that affects all arms of the wave alike.
- AS1 cells may also run slower. AS1 is a separate study whose contrasts are likewise within-wave (CTL in every
  wave); this is noted in AS1's STATUS so its report can mention it. AS1's pre-registration is not changed.
- Not a confound: spend. Each slot relay meters only its own traffic and each cell's spend is from its own wire log;
  the probes show the same price on slots 3–5 as on slot 0.

**A1.6 Added records (descriptive, not decision-bearing).** Per wave, `ledger/covariates.jsonl`, sampled every 30 s
by the runner (read only: /proc, pgrep, AS1's slot counters): 1-min load at start / max / mean, minimum available RAM,
AS1 cells in flight (AS1 log relays alive) at start / max / mean, AS1 requests during the wave. Each cell already
records load at start and end. `analyze_fg1.py` adds a descriptive section: (a) C's agent wall time per task against
the earlier controls on the same tasks, H3's R1 and AS1's CTL (medians, per-task differences, count slower) — a large
upward shift is a flag that contention, not the arms, is moving times; (b) each arm's median agent wall time, capped
and solved counts split by AS1 active vs idle and by per-wave max load above vs at/below its median. No decision uses
these.

**A1.7 Apparatus re-verified.** `wiretest_fg1.py --slots 3,4,5` re-ran the whole wire test on the pinned build (C, FG,
SH, negative control, read-only cwd: PASS, unchanged) plus a live check of each new slot's real path (FG1's log relay
on 4743–4745 → relay slot 4713–4715 → Go, the cell's placeholder key, one tiny streamed request each): HTTP 200 with
usage, the log relay classed the key `placeholder`, the slot relay metered exactly one request with usage and no
4xx/5xx/error, `go-plus` at ratio 1.2 — PASS. New `wiretest-fg1.txt` sha256 pinned in `build.toml`
(`e91c8478…`, was `a52dd39e…`). Offline tests: 25 passed (+1: slots 3–5, disjoint from AS1's, no AS1 wait per wave).
PLAN.json, the arms, the build pin, the scoring and the decision rule are unchanged.

**A1.8 Launch.** The waiting runner (pid 1377901) is stopped by pid (SIGTERM; it had started no mirror, relay or
cell). The new runner starts in the background with `FG1_APPROVED=yes run_fg1.py run --push` (no `--after-pid`).
§12's line "never concurrent with AS1" is replaced by: concurrent with AS1 on disjoint relay slots, per this amendment.

---

## Amendment 2 — 2026-11-06T19:10Z, during attempt 1 (5 of 29 waves done): group-sequential interim looks; no third lane

Written and committed before the change takes effect: the running runner (pid 1484501) keeps executing the code it
started with until it is stopped by SIGINT at a wave boundary (between a wave's END lines and the next START; no cell
in flight, the mirror closed by the runner's own `finally`) and restarted with the amended code. No completed cell is
touched; finished waves are skipped as before. PLAN.json, the arms, the build pin, the scoring, the guards and the
re-run rule are unchanged.

**A2.0 Disclosure — outcomes seen before this amendment.** The lead looked at the outcomes of FG1's first 4 waves
descriptively before asking for this amendment (C solved 1/4, FG 0/4, SH 1/4; hidden-test fractions ~0.81–0.87 per
arm). The agent who wrote this amendment also saw wave a1w04's outcome in STATUS.txt and
ledger/outcomes.jsonl (all three arms unsolved), i.e. 5 waves: C 1/5, FG 0/5, SH 1/5. These counts inform nothing
here: the boundaries are the standard Lan-DeMets O'Brien-Fleming spending function at the pre-registered alpha, fixed
by formula; the futility rule was chosen from simulations of POWER.txt's pre-registered model only (A2.3), by a
criterion stated there. Note, so that it is visible: FG's current 5-wave count (0 vs 1) would meet look 1's futility
condition (est < 0) if it held at 29 pairs; 24 waves of attempt 1 remain, and the condition was not chosen for that.

**A2.1 Why.** Time. If an arm's effect is very large, or plainly absent, the answer is in the data well before 87
waves. Looks at 1/3 and 2/3 of the information let the study stop then, at a pre-specified price in alpha.

**A2.2 The looks and the boundaries (`apparatus/interim_fg1.py`, `INTERIM-SIM.txt`).** Per comparison (FG vs C, SH
vs C), exactly as §8 pairs them:
- Look 1 before the first wave of attempt 2 (all 29 attempt-1 waves run); look 2 before the first wave of attempt 3
  (58); look 3 = §8's final analysis (87 + re-runs). Information fraction t_k = valid pairs / 87 (t_3 = 1).
- Efficacy: Lan-DeMets O'Brien-Fleming-type spending, one-sided alpha = 0.025 per comparison,
  alpha(t) = 2 − 2 Φ(z_0.9875 / √t), boundaries from the canonical joint normal (corr √(t_i/t_j)), recomputed at the
  actual fractions. Planned (t = 1/3, 2/3, 1): **c = 3.710, 2.511, 1.993**; nominal one-sided p = **0.000104,
  0.00601, 0.0231**; cumulative alpha 0.00010, 0.00605, 0.02500.
- Statistic: est = paired solve-rate difference; Z = est / SE, SE = SD of the task-cluster bootstrap (10,000
  resamples, seed [20261107, k]) — §8's bootstrap.
- Interim efficacy (looks 1, 2) iff Z ≥ c_k **and** the exact one-sided McNemar (sign) p ≤ p_k (on rare binary data
  the conjunction only makes an early stop harder; at look 1 it needs ≥ 14 discordant pairs all for the arm), **and**
  §8's guards on the pairs so far: capped(arm) − capped(C) ≤ ⌊3n/87⌋ (1 at 29, 2 at 58), spend ratio ≤ 1.3,
  mechanism delivered (§7), ≤ 10 % invalid. A crossed boundary with a failing guard is reported and the comparison
  continues.
- Interim futility (non-binding: the efficacy boundaries ignore it, so it cannot raise alpha): look 1 iff est < 0
  (the arm solved fewer paired cells than C); look 2 iff Z ≤ 0.75.
- Final (look 3, `analyze_fg1.py`): §8's rule with the lower bound taken at the one-sided level p_3 (planned 0.0231,
  i.e. a two-sided ~95.4 % percentile interval) instead of 0.025; the 95 % CI is still printed.
- A comparison decided at a look keeps its decision (efficacy = ADOPT if the guards held, futility = NOT ADOPTED);
  its later cells are descriptive. **The study stops early only when both comparisons are decided** at a look;
  otherwise all three arms continue unchanged in PLAN order (waves stay three-arm and paired, nothing is dropped).
  An early stop runs no further wave and no re-run (the decision was taken on the data at the look); the summary is
  then written over the cells run, and the stop is committed.
- **Alpha.** Each comparison spends exactly 0.025 one-sided under the normal approximation (Lan-DeMets); two
  comparisons → familywise ≤ 0.05 (Bonferroni, as §8). On the real discrete data, simulated under POWER.txt's model
  with C shared by both comparisons: under the global null, **familywise false adoption 0.047 (Beta(0.5, 4.5)) and
  0.047 (Beta(1.4, 18.6)), 20,000 studies each, MC SE 0.0015**; per comparison 0.025–0.028 (the fixed design's was
  0.023–0.027 in POWER.txt: the bootstrap's discreteness, present before this amendment).
- **Automation.** `run_fg1.py` runs the look itself at those two points (`interim_gate`), writes
  `interim/look{k}.json` and `.txt`, logs INTERIM lines in STATUS.txt, commits them under the shared lock (with
  `--push`, as every FG1 commit), and stops only on `stop_study`. A look that crashes is logged, committed and
  skipped (a skipped look spends no alpha; the final boundary is computed from the looks actually taken). A restarted
  runner refuses to continue a study that stopped.

**A2.3 Futility rule, how chosen (POWER.txt model only).** Candidates (look 1, look 2): none; (Z ≤ 0, none);
(Z ≤ 0, Z ≤ 0.5); (Z ≤ 0, Z ≤ 1.0); (est < 0, Z ≤ 0.75), 1,500 simulations each. Criterion, stated before choosing:
the smallest loss of power at the MDE (+0.15) with at least ~0.75 probability of stopping a null comparison. Chosen
(est < 0, Z ≤ 0.75): at 4,000 studies, P(adopt) at +0.15 is 0.82–0.83 (no futility: 0.83), at +0.10 0.53, at +0.075
0.33–0.35; a null comparison is stopped for futility 0.77–0.79. (Z ≤ 0 at look 1 also stops ties, which on rare
solves are common, and lost up to 0.06 power.)

**A2.4 What it buys (INTERIM-SIM.txt).** Global null: the study stops at look 1 with probability 0.25 and at look 2
0.41; expected waves 60.5 of 87. One arm at +0.15, the other null: stop at look 1 0.02, look 2 0.22, E[waves] 79.
Both arms at +0.15: E[waves] 81.5. Interim efficacy stops are rare by design (O'Brien-Fleming); the time saving
comes mostly from futility on null arms.

**A2.5 Third lane — measured, not added.** A third concurrent lane (relay slots 6–8, 9 cells) was considered and
**not** started: with 6 concurrent cells (AS1 3 + FG1 3) the per-wave 1-min load maxima were 8.3–20.7 (covariates
a1w00–a1w04, 30-s samples) and a 20-s sample on 2026-11-06 at 18:53–19:05Z reached **29.6** (FG1 a1w05,
layout-config-recreation2, 3 containers at ~250 % CPU each during build/test; AS1 retro-console-soc), against the
30 guard; minimum available RAM per wave 36.4 GB (a1w00, vf2-speedup-networkx) to 64 GB. Steady-state per-cell CPU is
small (1–9 % while waiting on the model) but build/test phases run 1–2.5 cores per container, ~4.5 load per cell.
Projected for 9 cells: mid-wave load peaks ~43 (> 30; the gx10 hard-halted at ~95–100 on 2026-11-05 with four
studies' containers), and RAM ~6–36 GB at the minimum if two heavy tasks coincide (< 24). Go's 5-hour allowance was
not the limit (A2.6). So FG1 stays on one lane, slots 3–5 (Amendment 1).

**A2.6 Go allowance.** Relay counters (read only) at 18:48Z: slots 0–2 (AS1) $3.68 since ~14:35Z, slots 3–5 (FG1)
$1.74 since 17:02Z: ~$0.87/h + ~$0.98/h = **~$1.85/h** (x1.5 for a third lane: ~$2.8/h, ~$14 per 5 h). Go's listing
(opencode.ai/docs/go, fetched 2026-11-06) for DeepSeek V4.1 Flash: Go $20 / $50 / $100 (5 h / week / month), Go Plus
$40 / $100 / $200; the relays bill `go-plus`. The 5-hour cap is not hit at either rate. The weekly allowance is the
one to watch: FG1's remaining ~$27 (at the measured ~$0.33/wave) plus AS1's remaining caps (~$31 for screening and
interaction) is ~$58 over ~2 days, against $100/week of which this week's earlier spend is not visible from these
relays. A limit would show as `status_4xx` and invalid cells (re-run per §6), never as a model failure.

**A2.7 Calendar (one lane, ~22 min/wave measured over a1w00–a1w04, no weekday 2× windows on Sat/Sun).** Look 1
~Sat 2026-11-07 03:30–04:00Z; look 2 ~Sat 14:00–14:30Z; final (87 waves) ~Sun 2026-11-08 00:30–01:30Z plus re-runs
(was ~Sun 15:40Z at Amendment 1's 32 min/wave). Earlier if a look stops the study.

**A2.8 Files.** `apparatus/interim_fg1.py` (new: boundaries, looks, simulation), `apparatus/run_fg1.py`
(`interim_gate`, `stopped_look`, commit includes `interim/`), `apparatus/analyze_fg1.py` (final level p_3, interim
decisions kept), `apparatus/test_fg1.py` (+5 tests: boundaries, look-1 efficacy/futility/stop, guard blocks early
efficacy, look 2 uses attempts 1–2 and keeps decisions, the runner stops before attempt 2's first wave),
`OFFLINE-TESTS.txt` (30 passed), `INTERIM-SIM.txt`.

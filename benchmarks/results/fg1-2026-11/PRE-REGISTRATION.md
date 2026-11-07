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

## Addendum 1 — host power-off, 2026-11-07 (written before resuming; no change to the analysis)

- **What happened.** The gx10 went down abruptly at **~2026-11-06T20:22Z** (last journal line 20:22:05Z, no shutdown
  sequence; load 5–8 at the last wave start) and booted at **2026-11-07T05:40Z**. The runner (pid 2377361), its mirror
  (2377364) and the six P2G slot relays died with it.
- **Finished before the crash:** attempt 1 waves a1w00–a1w07 (8 waves, 24 cells, all with `cell.json` and outcome
  rows; booked spend **$2.6229**). Kept as is (a1w06–a1w07's rows were on disk but not yet committed; they are
  committed with this addendum).
- **Interrupted:** wave **a1w08 data-anonymization** (started 19:59:17–19:59:57Z). SH had ended (20:21:03Z,
  `cell.json`); C (in its verifier) and FG (agent phase) were in flight. No outcome row for any of the three.
- **Handling — the wave is re-run as a whole (§6's re-run rule: all three arms, fresh cells; no arm keeps a cell its
  partners lost).** All three cell dirs moved to `runs-aborted/<cell>-crash/` (reason file inside), the Harbor job
  dirs to `jobs-aborted/<cell>-crash/`; the two surviving containers, networks and per-trial images removed by exact
  name (`data-anonymization__azek7hv__verifier__trial`, `data-anonymization__s7zsauy__env`). SH's finished cell is
  **not scored** (decided by this rule, not by its outcome). The runner runs a1w08 fresh in its planned position (same
  id, attempt 1, PLAN.json's order FG, C, SH and slots unchanged), so pairing stays within the wave and attempt 1
  stays 29 waves for look 1.
- **Spend not booked.** Aborted cells' wire spend: SH $0.0847, C $0.1168, FG $0.1057 = **$0.3072**; not in the
  runner's $50 budget (booked from outcomes), reported here and in the summary.
- **Resume.** The same `run_fg1.py run --push` with `FG1_APPROVED=yes`: PLAN.json unchanged, build master-f8c8a39
  (0.4.5) re-checked by `check` (SHA256SUMS + tarballs + wire-test hash), mirror on 172.17.0.1:4749, slots 3–5
  (relays restarted with P2G's unchanged `relay-go.mjs`, Amendment 1's env names; counters restart at zero, per-cell
  deltas do not depend on it), every host guard (load ≤ 30, ≥ 24 GB available, ≥ 50 GB on /, spend + $2 ≤ $50, Go 2×
  windows). Amendment 2's interim looks are unchanged: look 1 runs automatically before a2's first wave (after 29
  attempt-1 waves), look 2 before a3's.
- **Upstream check before the first cell.** A tiny probe through all six slots at ~05:58Z returned 429
  "[overloaded]" from the upstream on 3 of 6 (about half when repeated singly), against 0 4xx in AS1's and FG1's
  3,580 requests so far. The runner is not started while the upstream sheds load (a transport handicap the first 8
  waves did not have); the resume time and the clearing probe are in STATUS.txt.
- **Time covariate.** Waves a1w00–a1w07 ran Fri 2026-11-06 17:02–19:59Z; a1w08 onward from Sat 2026-11-07 after a
  **~10 h** gap. Within-wave pairing makes the gap hit all three arms of a wave equally; per-wave covariates
  (`ledger/covariates.jsonl`) and STATUS times record it.
- **Calendar (A2.7) moves by the gap:** see STATUS.txt for the resume time; ~22 min/wave as measured.
- **Unchanged:** validity, endpoints, comparisons, interim boundaries, decision rule, seed, budget.

## Amendment 4 (FG1; the hub lane's Amendment 3 inherits it) — Go allowance guard and account rotation (2026-11-07T06:18Z, before the post-power-off resume; no analysis change)

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

---

## Amendment 3 — 2026-11-07, before any hub cell: a second lane on the RTX hub, one PLAN-order queue, look barriers

(Numbered 3 as reserved; committed after Amendment 4, whose Go-allowance guard it uses.)

Written and committed before any hub cell or hub-lane wave exists. It changes WHERE a wave runs and the order in which
two lanes take waves; PLAN.json, the arms, the build pin, the scoring, the validity and re-run rules, the interim looks'
definitions and boundaries, the decision rule, the seed and the $50 budget are unchanged (same 261 cells, faster).

**A3.0 Disclosure.** Before writing this, the author ran the amended `analyze_fg1.py` once over the ledger to test the
new host section, and so saw the first 8 waves (a1w00–a1w07): C 1/8, FG 1/8, SH 1/8 solved. The scheme below was chosen
on design grounds (A3.2) before that run, and nothing in it depends on outcomes.

**A3.1 What changes.** A second lane runs FG1 waves on the user's RTX hub (Windows 11, Docker Desktop, x86_64, 32 CPUs
and 32 GB to the Docker VM, 61.7 GB RAM): `apparatus/run_fg1_lanes.py --lane hub` with `apparatus/hub_lane.py`. The gx10
lane is the same runner logic (`run_fg1_lanes.py --lane gx10`: `run_fg1.py`'s cells, slots 3–5, mirror, guards). Both
lanes are processes on the gx10 and serve **one queue in PLAN order**: a lane takes the first wave that is neither done
nor claimed, claiming it by an O_EXCL file `claims/<wave>.json` (lane, host, pid, time; committed), so no wave runs
twice. **Every wave's three arms run on one host**, at once, as before: pairing stays within the wave.

**A3.2 The interim looks under two lanes — scheme (c): barriers, not hold-outs.**
- **Rule.** No lane claims a wave of attempt a+1 until every wave of attempts ≤ a has all three outcome rows on the
  ledger (both lanes); then look a runs once (under a lock; `interim_gate` skips a look already written) and a stop
  ends both lanes. So look 1 sees exactly attempt 1's 29 waves and look 2 exactly attempts 1–2's 58, and **no data of a
  later attempt exists when a look is taken** — the information sets, fractions t_k = valid pairs / 87, boundaries
  (c = 3.710, 2.511, 1.993 planned; recomputed at actual t as A2.2), futility rules and the final level are A2's,
  unchanged.
- **Alpha.** Under H0 each wave's within-wave arm contrast has the same null distribution whichever host runs it (the
  host is fixed before the wave starts, by queue timing, and is common to the three arms), so the statistics at each
  look have the joint null distribution A2 computed. Each comparison spends one-sided 0.025 by Lan-DeMets O'Brien-
  Fleming; FG vs C and SH vs C → **familywise ≤ 0.05** (Bonferroni, as §8 and A2.2; A2's simulation: 0.047). Amendment
  3 adds no look, moves no look and uses no data at a look that A2's design would not have had: **overall alpha
  ≤ 0.05, unchanged.**
- **Why not (a)** (hub starts a3 only after look 2): the hub would sit idle for two thirds of the study and help only
  the last 29 waves (~half of them); the a1–a2 bottleneck stays on one lane.
- **Why not (b)** (hub runs a3 now, held out of the looks until their turn): it is valid for alpha only if every look
  filters by attempt (interim_fg1 does: `attempt <= k`) and a look's decision stands regardless of overrunning data,
  but (1) if a look stops the study — under the global null, probability ~0.66 (A2.4: 0.25 at look 1, 0.41 at look 2) —
  up to 29 waves (~$10 at ~$0.33/wave) were bought that can only be reported descriptively, which defeats the looks'
  purpose and the remaining Go allowance; (2) attempt-3 outcomes would sit in the ledger and STATUS before look 2,
  visible to every operator and agent — an operational unblinding that a later amendment could not credibly claim to be
  independent of; (3) host would be fully confounded with attempt (all a3 on the hub, all a1–a2 on the gx10), so the
  host covariate could not be separated from attempt order or calendar time.
- **(c) costs** one barrier idle per look (a lane waits for the other's last wave of the attempt, ≤ one wave, ~25 min)
  and nothing else; host varies within attempts, so the host line (A3.6) is estimable.

**A3.3 x86 vs aarch64.** Hub cells build and run linux/amd64 images (`--force-build`, the same unpinned dataset copy:
29 task dirs, tree digest `ac1c65ff…` = the gx10 copy, 762 files); gx10 cells arm64. A task whose oracle differs by
arch changes what a cell on that host can achieve, but the three arms of a wave share the host, so validity and the
contrast are per wave: such cells are **valid by §6** (a verifier reward exists), never excluded after the fact, and
reported. The hub's oracle status for all 29 tasks is measured before the first hub wave (`ORACLE-HOSTS.json`, hub
column; the gx10 column from P2G's oracle runs) and printed per host in the summary with the cells each failing task
had on that host. Agent-side: the pinned tarballs are pure JS (gnomon-natives shells out, no native addon), so the
install is arch-independent; the three-way pin runs in every hub cell.

**A3.4 Model path; the key never leaves the gx10.** Three more `relay-go.mjs` instances (slots 6–8), started exactly
as slots 0–5 (cwd `p2g-2026-11`, `RELAY_AUTH_FILE` = opencode's auth file, read inside the relay) but bound to the
gx10's Tailscale address: `RELAY_BIND=100.86.231.23`, `RELAY_PORT` 4716–4718, `RELAY_COUNTERS_PORT` 4816–4818
(counters on 127.0.0.1 only), logs `p2g-2026-11/relay-p2g-{6,7,8}.log`. Per hub cell the gx10 runs `log-relay.mjs` on
100.86.231.23:4740+slot (4746–4748) in front of its slot relay; the hub container's base URL is that log relay, the key
it carries is the P2G placeholder. gnomon classes 100.64/10 exactly as it classes 172.17.0.1 (`isLocalLaneUrl` and
`isLocalEndpoint`: local; `keyHostIsDefault`: not loopback, so the key needs the grant), so the surface, the replay
declaration and the trust grant are the same as on the gx10 (the grant names 100.86.231.23 instead of 172.17.0.1). The
build is served to hub cells from the gx10 (`apparatus/build` on 100.86.231.23:4759); a hash-checked copy is on the hub.
Go concurrency with the hub lane (up to 9 FG1/AS1 cells on one key): `HUB-GO-PROBE.json` (A3.8).

**A3.5 Hub setup (C:\dev\fg1-hub\, nothing else on the hub touched).** `.venv`: Python 3.12.10 (gx10: 3.12.3),
harbor 0.25.0 installed with the gx10 Harbor venv's `pip freeze` as constraints — identical package set (+ colorama, a
Windows-only dependency). `datasets\terminal-bench\`: the 29 task dirs from the gx10's copy, digest equal. `build\v0.4.5\`:
the four tarballs + SHA256SUMS, sha256 `b3654365…` = build.toml's, each tarball OK. `apparatus\`: the adapter
(`gnomon_harbor_fg1.py`), `surface_patch.py`, `fg1_checks.py`, P2G's `gnomon_harbor.py`, `build.toml`, `arms\`, all
byte-identical to the gx10's. Docker: Docker Desktop's Linux engine (`npipe dockerDesktopLinuxEngine`, 29.8.2), a private
`DOCKER_CONFIG` (no credential helper). Harbor flags identical to `run_fg1.run_cell` (cap multiplier 0.0625, build
multiplier 4.0, `--force-build`, `-n 1 -k 1`, `--ae OPENAI_API_KEY=<placeholder>`). Each cell's `.cmd` is started
detached through WMI (`Win32_Process.Create`), so neither an ssh drop nor a gx10 restart kills a running hub cell; the
gx10 polls for its rc file, then copies the Harbor job dir and harbor.log back to `jobs/` and `runs/` and scores it with
`run_fg1.score` unchanged. Outcome rows gain `host` (`gx10-aarch64` / `hub-amd64`) and `lane`; covariates rows gain
`host` and, on the hub, `hub_*` (CPU, free RAM, GPU utilisation, VRAM, sampled every 60 s).

**A3.6 Analysis additions (descriptive, not decision-bearing).** `analyze_fg1.host_lines`: per host, waves, tasks,
each arm's valid/solved/capped/invalid and median agent wall, and each comparison's within-host paired solve difference
with its discordant counts; the number of tasks run on both hosts; per-host oracle status. Host is a stratum and a
covariate; host differences are confounded with which waves each lane happened to take and the task mix — a flag, not
an effect estimate. The pre-registered estimate pools all pairs as before.

**A3.7 Hub host guards (the hub is the user's daily machine).** Before every hub wave, three samples ~10 s apart must
all show: free RAM ≥ 8 GB, CPU ≤ 85 %, C: ≥ 50 GB free, GPU utilisation ≤ 50 % and VRAM used ≤ 28 GB, no
`C:\dev\fg1-hub\PAUSE` file; plus Go's 2× windows, the hub slots idle 15 s, ≥ 50 GB free on the gx10. A breach holds
the lane (logged as HUB HOLD). "Using the GPU heavily" is read as the GPU computing, not a model merely loaded: at
06:22Z the user opened ComfyUI, which holds 19 GB of VRAM at 0 % utilisation; that alone does not hold the lane, any
sample above 50 % does. Memory: Docker Desktop's WSL VM keeps clean page cache (after the oracle sweep 27 of its 30 GB
were buff/cache and Windows had 6.7 GB free); when free RAM is the only breach, the lane drops the VM's CLEAN caches
once (`echo 1 > /proc/sys/vm/drop_caches` in a throwaway privileged alpine container; no process, container or
setting touched; measured 6.7 → 14.5 GB free in 20 s) and re-samples. Mid-wave (60-s samples), a breach lets the in-flight cells finish and
holds the lane after the wave; free RAM < 4 GB aborts the wave (cells killed, that task's containers removed, the cells
moved to `runs-aborted/*-hubabort`, the claim released, the wave re-run whole in its place, as Addendum 1). No reboot,
no Docker Desktop restart, nothing outside C:\dev\fg1-hub.

**A3.8 Before the first hub cell (recorded in STATUS.txt).** (1) `wiretest_fg1_hub.py` → `wiretest-fg1-hub.txt`
(sha256 pinned in build.toml as `wiretest_hub`; `run_fg1_lanes.py check --lane hub` requires it): A. `wiretest_fg1.py`
itself (C, FG, SH, the negative control without the trust grant, the read-only cwd), changed only by a `--fake-host`
option (default unchanged), in a linux/amd64 container on the hub as a non-root user; B. the live path from a hub
container through each hub slot (log relay classes the placeholder; one metered request with usage; go-plus at 1.2) and
a classifier negative control (no Authorization → `absent`); C. the mirror from a hub container (sums and tarballs).
(2) `HUB-GO-PROBE.json`: 9 concurrent tiny requests through slots 6–8 on the one Go key (06:20:50Z: 9/9 HTTP 200 in
1.2–2.3 s, go-plus, allowance/list 1.2 on every one, counters 9 requests 9 with usage, 0 4xx/5xx — billing normal; a
second probe with the gx10 lanes busy is appended once they run). (3) The hub oracle sweep (`ORACLE-HOSTS.json`).
Result: wire test **PASS** (`wiretest-fg1-hub.txt`, sha256 `ddc7725f…`): amd64 offline C/FG/SH all checks ok, FG
hand-back and finish_gate fired, SH yield + job call, negative control FAILS the key check as it must, read-only cwd ok;
live slots 6–8 HTTP 200 with usage, placeholder classed, one metered request each, go-plus 1.2; classifier negative
control `absent` on all three; mirror sums and tarballs match. Offline tests: 36 passed (+6: exclusive claims, PLAN
order skipping done/other-lane waves, the barrier holds attempt 2 until attempt 1 is complete then runs look 1, budget
reserve for the other lane's wave, the pause line fallback, hub Harbor flags = the gx10's).

**A3.9 Budget and Go allowance.** Unchanged $50 for all cells and re-runs; a wave starts only if spent + $2 × (this wave
+ the other lane's wave in flight) ≤ $50. Amendment 4's Go-allowance guard gates every wave of both lanes:
`go_allowance.wave_gate` under the lane's key (`fg1` on the gx10, as run_fg1.py; `fg1-hub` on the hub, as Amendment 4
names it) blocks while the allowance is paused and registers the wave in flight; `wave_done` after scoring; every
cell, hub cells included, is scanned by `run_fg1.score` (exhaustion = apparatus-invalid, re-run); the account label is
recorded per cell. Relays 6–8 are switched with 0–5 by `switch_go_account.sh`. Two lanes spend the allowance about twice as fast in wall time; the total is unchanged.

**A3.10 Switch-over.** The gx10 runner (`run_fg1.py run`, started by the resume gate at ~06:24Z on wave a1w08) is
stopped by SIGINT at a wave boundary (its `wave … done` line written, no cell in flight), as before A2, and replaced by
`run_fg1_lanes.py run --lane gx10 --push`; then the hub lane starts, `run_fg1_lanes.py run --lane hub --push`. A lane
refuses to start while an unlaned `run_fg1.py run` is alive (it takes waves without claims). No completed
cell is touched; finished waves are skipped as before.

**A3.11 Files.** `apparatus/run_fg1_lanes.py` (queue, claims, barriers, hub cells), `apparatus/hub_lane.py` (ssh, WMI,
guards, copy-back), `apparatus/wiretest_fg1_hub.py`, `apparatus/go_probe_hub.py`, `apparatus/wiretest_fg1.py`
(`--fake-host`), `apparatus/analyze_fg1.py` (`host_lines`), `wiretest-fg1-hub.txt`, `HUB-GO-PROBE.json`,
`ORACLE-HOSTS.json`, `claims/`.

**A3.12 Calendar.** At the switch (after a1w08, ~06:47Z) 78 waves remain. One lane at the measured ~22 min/wave: ~28.6 h
(end ~Sun 2026-11-08 11:30Z). Two lanes: ~39 waves each plus two barrier idles (≤ ~25 min each) → **~15 h, end ~Sat
2026-11-07 22:00Z** if the hub's waves take as long as the gx10's (no Go 2× windows on a weekend; Monday's start at
01:00Z is not reached), plus re-runs. Holds (hub guards, the Go-allowance pause until an account switch) add to this.

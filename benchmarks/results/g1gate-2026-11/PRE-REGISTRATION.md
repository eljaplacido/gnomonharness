# G1: does the harness-enforced completion gate turn "almost right" finishes into solves on a local model? Gate off vs checklist vs review, paired, on the gx10 qwen3.6 lane (pre-registration)

**Status: written and committed 2026-11-05 (≈14:00Z), before any G1 cell, smoke included.** The chain writes every gate
result into `STATUS.txt` and commits it, with the smoke, the delivery gate and the lane records, **before the first
measured cell**. It never edits this file. Any later change is a timestamped amendment at the end.

**Directory name.** `g1-2026-11/` is an earlier, unrelated study (G1, gnomon as a governance layer). This one is
`g1gate-2026-11/`; its cells are `g1g-…`. "G1" below means this study, and G0/G1/G2 its arms.

Modelled on N1 (`../n1-2026-11/PRE-REGISTRATION.md`): the same lane, tasks, cap, validity rule, meter and surface (N1's
arm N0).

## Why

- **P2G41** (`../p2g41-2026-11/analysis/REPORT.md`, hosted recipe B41): in 16 cells gnomon declared done with time left
  (median 996 s) and was wrong; 5 of them were near misses (≥ 75% of the hidden tests passing).
- **A prompt rule did not help** (H2): asking the model to verify every stated requirement moved nothing.
- **External evidence** (`~/gnomon/research_notes/Long task harness improvements/harnesses.md`): the harnesses that close
  "almost right" enforce the check (a finish hook, a structured checklist, a read-only auditor) rather than ask for it.
- **PR #152** (merged in master `ae17a1ae`, not released) adds that as harness control: `[verify] completion_gate =
  "off" | "checklist" | "review"` (docs/CONTRACTS.md §30, `conformance/completion_gate.json`). Off by default.
- **On this lane** N1's arm N0 (the nudge-free surface, v0.4.1) solved 37 of 63 valid cells; 10 of the 26 unsolved
  ended `answered` (the model said done, uncapped, and was wrong): the population the gate is for.

**G1 asks:** on master `ae17a1ae`, this lane and these 16 tasks, with N1's arm-N0 surface held fixed, does turning the
completion gate on (`checklist`, or `review`) change how many tasks gnomon solves, and what does it cost in wall time,
calls and caps?

## Build (every arm)

- **gnomon master `ae17a1ae958d6ccfd316c85ebde2f48ae066d6ac`** (origin/master at 2026-11-05T13:25Z: the merge of PR #152,
  `34852379`, on `b0f1d34e`). Not a release: v0.4.2 (`466a6c82`) does not contain the gate.
- **Packed exactly as the release job packs** (`.github/workflows/build-release.yml`, job "Pack the npm packages"), on
  the gx10, from `git archive ae17a1ae`: `pnpm install --frozen-lockfile`, `pnpm -r run build`, `npm pkg set
  gnomonBuild=master-ae17a1a` in gnomon-core, `pnpm pack` of gnomon-core, -natives, -tui and -cli (gnomon-harness).
  The four tarballs and their `SHA256SUMS` are committed in `dist/` (1.3 MB).
- **Pinned three ways in every cell** (`apparatus/gnomon-setup-g1g.sh.j2`, as N1 pins the release):
  1. `SHA256SUMS` must hash to `d6b6c5f4a72b66202377f31bf2df9fd8e4002625b8c96cae8589154e316891c8`;
  2. each of `gnomon-{core,natives,tui,harness}-0.4.2.tgz` must match `SHA256SUMS`;
  3. the installed gnomon-core must carry `gnomonBuild = master-ae17a1a`, and `gnomon --version` must print
     `gnomon/0.4.2+master-ae17a1a`.

  Any mismatch stops the install; the cell is then apparatus (no model call), never scored.
- **Delivery into the container.** Nothing is downloaded for gnomon. The agent class (`apparatus/peer_agents_g1g.py`)
  copies the five files from `dist/` into `/installed-agent/gnomon-dist` with tb's own `copy_to_container` (as tb
  copies the setup), then tb sources the setup. Node 22 comes from nvm, as in N1.
- **Recorded per cell:** `agent-logs/gnomon-commit.txt` (the commit, then the stamp, the version, the SUMS hash and the
  harness tarball's hash), the pane's `ARM_VERSION=`, and `cell.json`'s `sha`, `build`, `version`, `sums_sha256`.
  M1's validity rule makes a cell whose recorded commit differs from `cell.json`'s `wrong_commit` (apparatus).
- **Checked before launch:** the runner re-hashes `dist/` and refuses to start when it is not as pinned
  (`run_g1g.dist_check`, `install_build_g1g.sh --check`).

## Arms (L routing only; one variable)

| Arm | Cells | `[verify] completion_gate` (policy.toml) |
|---|---|---|
| **G0** (control) | `g1g-g0-k<k>-l-<task>` | `"off"` |
| **G1** | `g1g-g1-k<k>-l-<task>` | `"checklist"` |
| **G2** | `g1g-g2-k<k>-l-<task>` | `"review"` |

- **Every arm is N1's arm N0** (`steer_role = "user"` on r1local, `[turn] nudge_after_idle = 100000`, L routing,
  profile r1, roles.toml's model and endpoint lines removed, audit on, approval answered by `--yes`, `--trust`), on
  this build. There is no idle nudge, so the gate is the only variable against the nudge-free baseline.
- **The gate's other keys keep their defaults**: `completion_rounds = 3`, `completion_min_remaining = 0.2`,
  `completion_reviewer = "verifier"`.
- **One line apart.** The setup's node block runs on the build's own `gnomon init` output and appends `[verify]` with
  the arm's line, or, where init declared a `[verify]` check of its own (a task dir with `pyproject.toml`,
  `Cargo.toml`, a package.json test script or a Makefile `test:` target; init appends that block last), adds the line
  to that block. It asserts one `[verify]` header, one `completion_gate` line inside it, with the arm's value, and no
  other `completion_*` key. A `[verify]` check declared by init runs identically in every arm (the gate acts after
  it); the collector counts the cells where one ran.
- **Checked before any data:**
  - `preflight_g1g.sh`, on the build's real init in two scaffolds (plain, and with a `pyproject.toml`): the three arms'
    `config.toml` are byte-identical; their `policy.toml` differ by the gate value only; gnomon-core reads each arm's
    mode back (`resolveCompletionGate`), with the default rounds, floor and reviewer and no fatal surface finding; the
    pyproject scaffold keeps init's `pytest -q` check (`resolveVerify`); five bad inputs are refused.
  - `wiretest-g1g.txt` (below), on the real build.

### The wire, observed offline before any data (`wiretest-g1g.txt`: PASS, 58 checks)

The real build, installed from the pinned tarballs, ran the real `gnomon init`, the setup's own node block and
`gnomon task`, through `relay-meter-s1`, against a fake llama-style server whose "model" is a fixed policy over the
conversation (so every arm meets the same model): write `out.txt` by bash and answer; answer again at once after a
checklist (no check); after a no-check hand-back run `cat out.txt` and answer; after a reviewer's findings rewrite and
`cat` the file and answer. The work dir is not a git repository, like most task dirs. A fourth arm, **N0**, ran
N1's own arm-N0 setup on the same build.

- **G0 = N0 on the wire.** G0 sent exactly N0's request bodies, request for request (2 of 2), with no gate counters,
  no `completion_gate` record and no gate note. G0's `config.toml` is N0's; its `policy.toml` is N0's plus `[verify]`
  and `completion_gate = "off"`.
- **G1 and G2 hand back a checklist.** Both sent G0's first two request bodies (the gate acts only at an answer). The
  first answer came back as a `[gnomon]` user note: "Completion gate (round 1 of 3): your answer is not accepted yet…",
  the task's three requirements, `out.txt`, the also-check list and "Run at least one command that exercises the
  result…". The immediate second answer (no command run) was handed back again (`no_check`). The meter saw the notes
  as kind `other`; no system message went out after the first.
- **G1:** `counters.completion_gate = {mode: checklist, rounds: 2, checks: 1, reviews: 0, outcome: passed}`; trail
  `checklist, no_check, accept(passed)`, every record `budget_by: steps`.
- **G2:** after the check, one reviewer sub-turn (4 requests) offered only `bash, compute, glob, grep, read, todo`,
  given the task verbatim in a fresh context (system + one user message; none of the transcript). Its `ls -la` ran;
  its `echo pwned > pwned.txt` was refused by bash_allow (a redirect) and its `write` call was refused (not offered);
  nothing reached the disk. Its one finding reached the main turn as a `[gnomon]` note (round 3 of 3), and the main
  turn acted on it. `counters.completion_gate = {mode: review, rounds: 3, checks: 3, reviews: 1, review_steps: 3,
  findings: 1, outcome: passed}`; trail `checklist, no_check, review(1 finding), accept(passed)`.
  `counters.model_calls.count` (12) includes the reviewer's requests.

### The reviewer's bash (checked, as asked)

The reviewer is init's `verifier` role. Whatever it declares, the gate offers it only read/glob/grep/compute/todo and
bash (bash because the role declares a non-empty `bash_allow`). Put to gnomon-core's own `bashPolicy` with the
verifier's lists (`wiretest-g1g.txt`, last section):

- **Runs (read-only project checks):** `pytest …`, `make test|check`, `npm|pnpm|yarn test`, `cargo test`, `go test`,
  and `ls|cat|head|tail|grep|rg|find|git status|diff|log|show` *with an argument*.
- **Refused:** any redirect (`>`), `sed -i`, `rm`, `find -delete|-exec`, `xargs`, and every `python3|python|node|perl|
  ruby|awk` invocation (`python3 solve.py`, `python3 -m pytest`), `bash run.sh`, `sqlite3`, `jq`, `curl`, `wc`, and a
  bare `ls` or `git diff` (the allow patterns require an argument).
- **What that means on these tasks:** terminal-bench copies its tests into the container only after the agent ends,
  so there is no project suite to run in most task dirs. The reviewer can read every file and run `pytest` on tests the
  model wrote, but cannot run the task's own commands (most are `python3 …`), query a database, or call a service. On
  TB2 the review is largely a read-only inspection. This is the shipped default reviewer, measured as shipped; it is
  not widened here, because widening `bash_allow` to interpreters would make the reviewer able to write, and in a
  directory that is not a git repository the gate cannot detect that (CONTRACTS §30 "Limits").

### What the gate changes, counted as the treatment (stated now)

1. **Hand-backs.** At the first answer of a turn that changed the worktree, with ≥ 20% of the step budget left
   (implementor: 256 steps, so ≥ 52 left), the answer is not accepted: a `[gnomon]` user note (the checklist; then
   `no_check` if no bash command ran; then, in G2, the reviewer's findings). At most 3 per turn.
2. **Extra steps and calls** after each hand-back, counted against `max_steps_total`.
3. **G2's reviewer sub-turn**: its own requests (verifier role, ≤ 160 tool steps, outside the main turn's count),
   on the same lane slot.
4. **Extra prompt tokens** for every request that re-sends a hand-back note.

**Not changed:** the surface otherwise, the step budget, the idle nudge (off in every arm), leg compaction, the
declared `[verify]` check where init wrote one, and the 900 s cap.

**The gate is blind to the 900 s cap.** `completion_min_remaining` reads the step budget, and a run deadline only
when the caller passes one (`TurnDeps.deadline`); `gnomon task` at this build has no `--deadline` flag, so no arm
passes one. A hand-back or a review late in a long cell can therefore push it into the cap. That cost is measured
(capped, wall time), not avoided.

## Lane: the gx10's `llama-server-qwen-q4.service`, R1's, S1's and N1's, untouched

- **Server.** 127.0.0.1:18080, llama.cpp b1281-571d0d54: Qwen3.6-35B-A3B-UD-Q4_K_S (sha256 `2bee952b…`) + DFlash draft
  (`107b7a43…`); the Unsloth qwen3.6 template, byte-identical to R1H's; `--parallel 1 --ctx-size 98304`, q8_0 KV,
  `--reasoning off`.
- **The chain never starts, stops, restarts or signals the service.** It reads it (`systemctl --user cat/show`,
  GET `/props`, `/slots`, `/v1/models`) and sends requests only through G1's meter.
- **Before any cell, the lane must equal S1's references** (`lane-gx10-ref-*`, byte-identical copies of S1's, which N1
  used): build, model file, alias, template and caps; 1 slot × 98,304, speculative; every server default; the unit
  text and its flags. Any difference is FATAL. The weights' checksums are checked too.
- **Checked at preparation (2026-11-05T13:48Z, read-only, `dryrun-g1g.txt`):** the lane matched; the unit is active
  (MainPID 2359135), the slot idle; the gx10 `gpu.lock` free; N1's chain ended `DONE` at 09:40:23Z.
- **gpu.lock.** The chain holds `~/.opencode/central-brain/runtime/decisionbench/gpu.lock` for its whole run, as R1,
  S1, M2 and N1 did; its children do not inherit the lock's descriptor.
- **Delivery gate (render-only, before any cell).** S1's `probe_s1.py` renders through `/apply-template`: a late system
  message must not render and the same message as a `[gnomon]` user note must (cases A–C). The gate's hand-backs are
  system messages that `steer_role = "user"` delivers as such notes. `steerAsUser` is byte-identical at `ae17a1ae` (the
  function text hashes to `36840e8a…`, as at 8078df03 and v0.4.1); passed at preparation (DRY_GATE).

**Ports** (G1's own; N1's 5810–5825 now belong to R4H):

| What | Listens | Upstream | Counters |
|---|---|---|---|
| local meter (`relay-meter-s1.mjs`), every arm | 172.17.0.1:**5910** | http://127.0.0.1:18080 | 127.0.0.1:**5920** |
| cloud sink (`relay-meter-s1.mjs`) | 172.17.0.1:**5911** | http://127.0.0.1:9 (nothing listens) | 127.0.0.1:**5921** |

- Before start the runner checks that they have no listener (a bounded 120 s wait) and that nothing listens on
  127.0.0.1:9. The preflight asserts they are none of H3's (P2G relays 4710–4712, log ports 4720–4722), R4H's (19180,
  5810–5825) or any other recorded apparatus port. Nothing here touches H3, R4H or the hub.
- **The cloud sink.** `r1cloud` points at a meter whose upstream refuses: a misrouted request is counted and refused,
  never paid for. Any request reaching it makes that cell `misrouted` and pauses the run (`MISROUTE-PAUSE.txt`, FATAL).
  **Budget: $0 cloud.**

## Tasks, triples and order

- **Tasks:** N1's 16 (`apparatus/sample16-hunch.txt`, byte-identical to N1's, S1's and R1H's).
- **16 tasks × 2 attempts = 32 triples = 96 cells.** A triple is one (task, attempt): its G0, G1 and G2 cells **run
  back to back, one cell at a time** on the one slot (concurrency 1), so the three share the time window and host load.
- **Order.**
  - Attempts run in order, as barriers. Within attempt k the tasks run in `random.Random(k).shuffle` order (N1's, S1's
    and R1's seed rule, so these are N1's orders; the test checks attempt 1 against the order N1 ran).
  - **Arm order inside a triple, fixed now** (`run_g1g.arm_order`): attempt 1 takes permutation (alphabetical index
    mod 6) of the six orders of (G0, G1, G2); attempt 2 takes its mirror image. So every task has every arm once early
    and once late, and across the run each arm is first, second and third 10–12 times (G0 11/10/11, G1 11/10/11,
    G2 10/12/10). This balances the carry-over between a triple's cells (llama.cpp's prompt cache of the shared system
    prompt, warm images, host load drift).
- **Kept from N1:** the 900 s cap (`--global-agent-timeout-sec 900`; tb starts it before the setup), tb 0.2.18 and its
  flags (`--n-concurrent 1`, `--no-cleanup`), L routing (every role local, entry implementor).
- **Expected wall time.** N1's N0 cells averaged 367 s (median 157 s); N1 ran 128 cells in 12.2 h. G1 and G2 add
  hand-backs and a review: assume G0 ≈ 370 s, G1 ≈ 420 s, G2 ≈ 500 s, ≈ 11.5 h for 96 cells. Launched ≈ 14:15Z, the
  end is expected ≈ 02:00Z on 11-06 (range ≈ 00:30–05:00Z), before the deadline.

## Order, deadline (`apparatus/g1g-chain.sh`)

1. **Offline tests**, before anything else; any failure is FATAL.
2. **The gx10 `gpu.lock`** (wait while another benchmark holds it).
3. **Lane checks:** the lane equals S1's references, the weights' checksums match, the ports are free, the sink
   refuses, and `dist/` is as pinned.
4. **Delivery gate** (render-only). It must pass.
5. **Smoke, first time only:** hello-world, G0, G1, G2, on this lane. Every cell must be valid and solved, record the
   build commit, carry its surface lines exactly once (steer_role user; nudge 100000; the arm's gate inside
   `[verify]`), show `wire.steer_role = "user"` on every turn record and a `counters.model_calls` record, and have
   `steer_role_adapted` = 0, no nudge, no late system message, no meter error and no cloud-sink request.
   - **G0, the negative control:** no `counters.completion_gate`, no `completion_gate` record, no gate note.
   - **G1:** counters with mode `checklist`, at least one hand-back, a gate note on the wire, no reviewer.
   - **G2:** counters with mode `review`, at least one hand-back, a gate note on the wire, a reviewer sub-turn.

   One retry is allowed; a second failure means G1 is not run.
6. **Commit before data:** this file, STATUS, the gate and smoke files, the lane records, `wiretest-g1g.txt`,
   `apparatus/` and `dist/`.
7. **The run:** attempts 1–2, 32 triples. **No interim look; one analysis, at the end.**
8. **Collect** (`summary-g1g.txt`), commit, `DONE`.

- **New-triple deadline:** `G1G_DEADLINE`, default **2026-11-06T09:00:00Z**. No triple starts after it; the cells of a
  triple already started still run (no partial triple by the clock: at most two cells past the deadline). Triples not
  started are logged `NOT STARTED … (deadline)` and never imputed.
- **One G1 chain at a time** (`flock` on `.chain.lock`). Commits take the shared lock `../m1-2026-11/.commit.lock`,
  opened for append, and add only this folder's paths.
- **Failures.** A runner failure is retried once after 60 s (finished cells are skipped). A second failure, a lane that
  stops answering for 10 min or comes back different, or a metered cloud request is **FATAL**. A FATAL exit commits
  nothing and is not `DONE`.
- **Interruptions.** A cell in flight when the runner is stopped moves to `runs-aborted/<cell>-operator`; a cell
  directory without `cell.json` to `runs-aborted/<cell>-incomplete`. Either is re-run from scratch on resume, never
  scored.

## Validity (M1's = R1H's = S1's = N1's, unchanged)

- **One function for every cell:** `apparatus/collect_m1.py` (byte-identical copy of M1's, sha256 `3e856dbf…`),
  `parse_cell`. A cell is valid when tb returned a verdict; both meters read non-negative deltas; at least one chat
  request was metered; it ran the build its `cell.json` names; gnomon did not give up on an endpoint after its whole
  retry grace; L routing held (cloud = 0, local > 0).
- **Every other state is apparatus:** reported, never scored, never re-run once finished (a cell where tb made no
  output directory included). Buckets are asserted to sum to n per arm.
- **A pair** (G1 vs G0, or G2 vs G0) counts when both of its cells are valid.

## Endpoints, declared now (`apparatus/collect_g1g.py`)

**Primary (score):** solved, by **exact two-sided McNemar** on (task, attempt) pairs valid in both arms, for **G1 vs G0**
and **G2 vs G0**. The two are one family: **Holm at 0.05** (the smaller p must be ≤ 0.025, then the other ≤ 0.05). Each
is reported with the paired difference and an Agresti–Min 95% interval. G2 vs G1 is descriptive only.

**Secondary (paired, descriptive, the same pairs; each treatment arm vs G0):**
- **capped** at 900 s (exact McNemar): the gate's cost when it runs out the clock;
- **false finish**: a valid cell whose last turn ended `answered`, not capped, and unsolved (exact McNemar), and per
  arm the rate among valid cells and among uncapped answers;
- **near miss**: unsolved with ≥ 75% of the task's tests passing (exact McNemar);
- **the fraction of the task's tests passing** (tb's `parser_results`, which tb 0.2.18 reports per test): the graded
  outcome in place of P2G41's hidden-test fraction;
- **model calls** (the meter's chat requests, the reviewer's included), **tool steps** (turn record), **agent wall
  time**, **local tokens**: paired medians, the paired median difference and a sign test.

**Mechanism (resolvable):** from gnomon's own records (`counters.completion_gate`, the `completion_gate` trail) and
the meter (outside view):
- **G0, the negative control:** no gate counters, no gate record, and zero gate notes on the wire (meter kind `other`,
  which was 0 in all 64 of N1's N0 cells).
- **G1:** the gate acted (rounds > 0) in at least one cell; mode `checklist` only; no review.
- **G2:** the gate acted and reviewed in at least one cell; mode `review` only.
- **Every arm:** no idle nudge; no system message after the first; `steer_role_adapted = 0`; the surface lines as
  declared; every cell on 127.0.0.1:18080; cloud-sink requests = 0.
- **Reported per arm:** cells the gate acted in, rounds, checks, reviews, review steps, findings, review failures,
  outcomes (`passed`, `exhausted`, `skipped_budget`, `not_applicable`, `not_reached`), trail actions, and the cells
  where a `[verify]` check declared by init ran.

If any mechanism check fails, that is an apparatus finding, and the score comparison is not read as a test of the gate
until it is explained.

**Descriptive only:** how cells ended (last `stop_reason`, per arm, valid and valid-unsolved); the discordant pairs with
each side's stop reason, gate counters, caps and test counts.

## Decision (what counts as an answer)

- **"The gate helps"** (for G1 or G2): it solves significantly more than G0 under the rule above. That supports
  shipping that mode as a default candidate on local lanes like this one, subject to its cost (caps, wall time).
- **"The gate hurts":** G0 solves significantly more. That argues against the mode here, and the capped and
  false-finish secondaries say whether the clock or the hand-back did it.
- **Anything else is "no difference shown"**, reported with the direction, the paired difference and its interval. It is
  not "no effect": see the MDE.
- **A mechanism result with no score movement is an honest partial result, declared here in advance:** the gate fired
  and the reviewer ran, the false-finish rate moved (or did not), and the score did not.
- **Scope.** Local qwen3.6 with reasoning off, `steer_role = "user"`, nudge off, master `ae17a1ae`, these 16 tasks, the
  900 s cap. Hosted lanes (P2G41's setting, where the gate was motivated) are not covered.

## MDE, power and limitations, stated now

- **This run cannot detect a plausible effect on the primary.** With 32 pairs, a two-sided exact McNemar needs a
  discordant split of at least 7–0 or 9–1 at 0.025 (6–0 or 8–1 at 0.05). Computed exactly for 32 pairs:

  | discordance ψ | Δ | power at 0.025 | power at 0.05 |
  |---|---|---|---|
  | 0.14 | 0.05 | 0.01 | 0.03 |
  | 0.14 | 0.10 | 0.05 | 0.11 |
  | 0.20 | 0.10 | 0.06 | 0.11 |
  | 0.20 | 0.15 | 0.19 | 0.30 |
  | 0.25 | 0.20 | 0.39 | 0.52 |
  | 0.25 | 0.25 | 0.72 | 0.85 |

  - **MDE at 80% power ≈ 0.25–0.28** (8–9 net extra solves of 32). The ceiling for the gate's target population on
    this lane is about 0.16 (N1's N0: 10 false finishes in 63 valid cells), so a significant primary would need the gate
    to convert more than the false finishes. Realistic effects (0.05–0.10) have 3–11% power.
  - The design (2 attempts × 3 arms) is what fits before the deadline: at ≈ 430 s a cell, the 96 cells take ≈ 11.5 h.
    N1-sized power (≈ 110 pairs per comparison) would need ≈ 3.4× the cells.
  - **So the primary is pre-registered and will be reported, but this run is mainly a mechanism, cost and
    effect-size study, and a screen**: does the gate fire on real tasks, does the false-finish rate move, what does it
    cost in caps and wall time, and is the paired difference's interval compatible with an effect worth a powered run.
- **Noise floor.** The measured self-flip rate on this lane is ~14–15% (S1: 4 discordant of 30 pairs; N1: 8 of 61). Single discordant pairs are expected and are not read as findings.
- **The reviewer cannot run most task commands** (bash_allow; above), and the checklist is lifted from the task text,
  not understood (CONTRACTS §30 "Limits"). Both are the shipped defaults, measured as shipped.
- **The gate is blind to the 900 s cap** (above). A cell capped by the gate's extra work is scored as tb scores it.
- **Capped cells usually leave no turn record** (the audit is copied after `gnomon task` exits). Their mechanism comes
  from the meter (gate notes as kind `other`), which sees every request.
- **Shared docker host.** H3's Harbor cells and R4H's task containers run on the same docker host (their own models and
  relays). G1 runs one cell at a time, so a triple's cells see nearly the same load, and the arm-order balance spreads
  the rest. Load is recorded per cell (`load.json`).
- **Not compared.** No time-separated comparison with N1 is pre-registered (N1 ran v0.4.1). G0 is this study's control.
- **Budget.** $0 cloud (the sink makes a paid call impossible by construction). Local GPU: ≈ 12 h of the gx10 lane until
  at most 2026-11-06T09:00Z, holding the gpu.lock. Disk: ≈ 60 MB of runs.

## Cleanup and scope

- **What the chain starts and stops:** the gpu.lock; its runner and the runner's two relays, by the process group it
  launched; that runner's in-flight cell (moved to `runs-aborted/<cell>-operator`; its compose project removed by exact
  label).
- **What it does not do:** no `pkill`; no docker command of its own; nothing to the lane, the hub, H3, R4H, ~/.claude or
  any brain.db.
- **Writes:** nothing under `benchmarks/results/` outside `g1gate-2026-11/`. N1's, S1's, R1H's and M1's files are read;
  M1's commit lock is opened for append.

## Files

- **The chain and runner:** `apparatus/g1g-chain.sh` (`DRY=1` read-only checks, `DRY_GATE=1` also renders the gate);
  `apparatus/run_g1g.py` (`plan`, `smoke`, `full`, `abort-inflight`).
- **The analysis:** `apparatus/collect_g1g.py` (`--smoke`, `--no-write`).
- **The arm and the build:** `apparatus/gnomon-setup-g1g.sh.j2` and `apparatus/peer_agents_g1g.py`;
  `apparatus/install_build_g1g.sh` (the same pins on this host; `--check`); `dist/` (the tarballs and `SHA256SUMS`).
- **Checks and tests:** `apparatus/wiretest_g1g.mjs` and `wiretest-g1g.txt`; `apparatus/preflight_g1g.sh`;
  `apparatus/test_run_g1g.py`, `apparatus/test_collect_g1g.py`, `apparatus/test_chain_g1g.sh`; `dryrun-g1g.txt`.
- **Byte-identical copies of N1's (= S1's)**, checked by the preflight: `collect_m1.py`, `gnomon_agent.py`,
  `peer_agents_r1.py`, `relay-meter-s1.mjs`, `test_relay_s1.mjs`, `sample16-hunch.txt`, `probe_s1.py`,
  `probe-shapes-s1.json`, `lane-gx10-ref-*`.

### Tests at preparation (2026-11-05T13:48Z, all offline, all pass)

- `test_run_g1g.py`: **48 passed, 0 failed** (plan, task order = N1's, arm-order balance and mirror; the build pins and
  their refusals; ports and the sink; one cell at a time with each arm's env; skip, incomplete re-run, the deadline (no
  partial triple), tb without an output dir, the misroute pause, SIGTERM abort and abort-inflight; `plan` writes
  nothing).
- `test_collect_g1g.py`: **30 passed, 0 failed** (exact McNemar, Agresti–Min, Holm; the collector on 96 synthetic cells
  laid out as tb lays them out: validity, tests passing, false finishes, the gate's counters and trail, the surface
  lines; the mechanism checks failing when they should; the smoke verdicts; the full report).
- `test_chain_g1g.sh`: **39 passed, 0 failed** (static scans: systemctl only `cat`/`show`, no pkill/ssh/docker/chat
  request, kills scoped to the runner's group, ports; `lane_check` refusals; the gpu.lock; `run_all`'s retry, pause,
  deadline and lane-loss paths; a FATAL exit committing nothing; commits limited to this folder).
- `preflight_g1g.sh`: pass. `wiretest-g1g.txt`: PASS (58 checks).

## Launch

From a shell on the gx10:

```bash
cd /home/eljaplacido/gnomon-wt/peers/benchmarks/results/g1gate-2026-11 && \
  G1G_DEADLINE=2026-11-06T09:00:00Z setsid nohup apparatus/g1g-chain.sh >> chain-g1g.log 2>&1 < /dev/null & echo "G1G chain pid $!"
```

- **Stop:** `kill -TERM <chain pid>`; the chain's trap stops its runner's process group and the cell in flight moves to
  `runs-aborted/<cell>-operator`. **Resume:** the same command; finished cells are skipped and the smoke is not repeated.
- **Progress** is in `STATUS.txt` (`G1GRUN START/END` per cell, `CHAIN-G1G` per gate).

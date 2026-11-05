# H4-lite: does the completion gate with a reviewer turn the hosted recipe's wrong early finishes into better answers? An exploratory screen (pre-registration)

**Status: written and committed 2026-11-05 (≈17:30Z), before any H4-lite cell.** Later changes go in timestamped
addenda at the end; this text is not edited.

**Label: exploratory screen.** k = 1, one task set selected on a past failure, a 3.5-hour window. A positive signal
promotes the gate into the AS1 sweep and a confirmation run (k ≥ 3); a screen result is never published as an effect.

## Why

- **P2G41** (`../p2g41-2026-11/analysis/REPORT.md`, root cause 2): with the hosted recipe (arm B41), gnomon declared
  done with time left and was wrong in 12 cells (16 with A41's 4), median 996 s left; 5 were near misses (≥ 75% of
  the hidden tests). opencode took 1.42× as many steps. A prompt rule did not help (H2).
- **PR #152** (merged in master `ae17a1ae`, not released) adds the harness-enforced gate: `[verify] completion_gate =
  "off" | "checklist" | "review"` (docs/CONTRACTS.md §30). G1gate (`../g1gate-2026-11/`) tests it on the local qwen3.6
  lane; nothing has tested it on the hosted model.

**H4-lite asks:** on those long TB tasks, with the hosted recipe held fixed on master `ae17a1ae`, does
`completion_gate = "review"` raise the hidden-test fraction and the solves, without new caps or harm on solved tasks?

## Build under test (pinned, recorded per cell)

- **gnomon master `ae17a1ae958d6ccfd316c85ebde2f48ae066d6ac`**, G1gate's packed tarballs, unchanged
  (`../g1gate-2026-11/dist/`; how they were built: G1gate PRE-REGISTRATION "Build"). Pinned three ways in every
  container, by `apparatus/gnomon_harbor_m152.py` (P2G's `gnomon_harbor_v041.py` copied; class `GnomonM152`
  subclasses `GnomonV041`; only the pins changed):
  1. `SHA256SUMS` must hash to `d6b6c5f4a72b66202377f31bf2df9fd8e4002625b8c96cae8589154e316891c8`;
  2. each of `gnomon-{core,natives,tui,harness}-0.4.2.tgz` must match it;
  3. gnomon-core's `gnomonBuild` must be `master-ae17a1a` and `gnomon --version` must print
     `gnomon/0.4.2+master-ae17a1a`.
  Any mismatch stops the install; the cell is then an apparatus failure. Each cell keeps `gnomon-release.txt`
  (version, commit prefix, harness tarball hash) and `gnomon-version.txt`.
- **Delivery:** a local HTTP mirror (`python3 -m http.server`, bound to 172.17.0.1, a free ephemeral port chosen at
  launch) serves `mirror/v0.4.2/` (symlinks to G1gate's `dist/`); `GNOMON_REL_BASE` points the install at it, as the
  v0.4.1 release smoke did. The runner refuses to start unless the mirror serves the pinned `SHA256SUMS`; a container
  on the default bridge and one on a user-defined network both fetched the pinned hashes (checked 2026-11-05 ≈17:20Z).

## Arms (both run H1's hosted recipe)

| Arm | Adapter | Surface |
|---|---|---|
| **C** | `gnomon_harbor_h4:GnomonM152Hosted` | H1's `run()` byte for byte (`HOSTED_PATCH`): `[endpoints.bench] replay_reasoning = true`, `max_context_tokens = 1000000`, `[turn] nudge_after_idle = 100000`. Gate off (the build's default). |
| **G** | `gnomon_harbor_h4:GnomonM152Gate` | C + one command after `HOSTED_PATCH`: `GATE_PATCH` puts `[verify] completion_gate = "review"` into `.gnomon/policy.toml`. |

- **G's other gate keys keep their defaults:** `completion_rounds = 3`, `completion_min_remaining = 0.2`,
  `completion_reviewer = "verifier"`.
- **GATE_PATCH is checked:** where init declared a `[verify]` check of its own (a task dir with `pyproject.toml` etc.;
  init writes it in policy.toml) the line goes directly under that block's header and the check runs identically in
  both arms; otherwise a `[verify]` block holding only the line is appended. It exits 3 (the cell then has
  `h4-gate-patch-failed.txt` and no model call: an apparatus failure) unless policy.toml ends with exactly one
  `[verify]` header and exactly one `completion_*` line, `completion_gate = "review"`, directly under it. It also
  refuses a pre-existing `completion_*` key or a `[verify]` header it cannot parse.
- **Everything else is identical:** the build, init, the attempt-1 `_PATCH`, `gnomon task … --role implementor --yes
  --json`, the live audit copy every 20 s, the records copied out (config, roles and policy.toml included).

### The wire, observed offline before any data (`wiretest-h4lite.txt`: PASS)

`apparatus/wiretest_h4.py` ran each arm's REAL adapter script (captured from `run()`) on this host against the pinned
build (installed from the same tarballs into a scratch npm prefix, stamp and `--version` checked), empty HOME/XDG,
a non-git work dir, against a fake OpenAI-style server on 172.17.0.1 whose "model" is G1gate's fixed policy:

- **Scripts:** G = C + exactly the `GATE_PATCH` command, after `HOSTED_PATCH`.
- **Surfaces:** config.toml and roles.toml identical (the recipe's three lines in both); G's policy.toml = C's +
  `[verify]` / `completion_gate = "review"`.
- **C:** 2 requests (write, then done); the first done is accepted; no gate note, no counters, no gate record.
- **G:** C's two request bodies byte-identical, then the first done is handed back with a checklist ("Completion gate
  (round 1 of 3): your answer is not accepted yet…"), then `no_check`, then one reviewer sub-turn (fresh context:
  system + one user message; offered only bash/compute/glob/grep/read/todo), whose one finding reached the main turn,
  which acted on it. `counters.completion_gate = {mode: review, rounds: 3, checks: 3, reviews: 1, review_steps: 1,
  findings: 1, outcome: passed}`. Later requests keep C's parameters (model, tools, sampling); only messages grow.
- **Notes go as system messages.** The recipe keeps `steer_role`'s default, so the gate's hand-backs reach the model as
  system messages (G1gate's surface sends them as `[gnomon]` user notes). This is the recipe as it ships.
- **GATE_PATCH** joins init's own `[verify] command = "pytest -q"` block in a pyproject scaffold, and refuses (exit 3)
  a pre-existing completion key, two `[verify]` headers, and a commented header.

### What the gate changes, counted as the treatment

1. **Hand-backs:** at the first answer of a turn that changed the worktree, with ≥ 20% of the step budget left, the
   answer is not accepted (checklist; `no_check` if no command ran; the reviewer's findings). At most 3 per turn.
2. **Extra steps and calls** after each hand-back; the reviewer sub-turn's own requests (verifier role, read-only
   tools, its bash allow-list refuses interpreters such as `python3`; G1gate PRE-REGISTRATION "The reviewer's bash").
3. **Extra prompt tokens** for every request that re-sends a hand-back note.

**The gate is blind to the 1,800 s cap.** `completion_min_remaining` reads the step budget (`budget_by: steps`, seen
on the wire); `gnomon task` at this build has no `--deadline`, so a hand-back or review late in a long cell can push it
into the cap. That cost is measured (capped, wall time), not avoided.

## Tasks, order, waves

- **The 12 targets:** every P2G41 B41 cell in mode "answered wrong with ≥ 300 s left" (`failure_modes.csv`):
  wal-recovery-ordering (B41 hidden fraction 0.979), satb-audio-transcription (0.925), production-planning (0.9),
  fin-saccr-rwa (0.833), atrx-vep-crispr (0.75), session-window-debug (0.714), cargo-flight-dispatch (0.704),
  ontology-kg-querying (0.692), roy-polymorph-cn (0.667), batched-eval-parity (0.6), html-js-filter (0.5),
  protein-autointerp-disulfide (0.5). (A41's 4 such cells are on fin-saccr-rwa, html-js-filter, wal-recovery-ordering,
  in this list, and mvcc-lsm-compaction, a control.)
- **The 2 controls** (B41 solved, to catch harm): **mvcc-lsm-compaction** (B41 194 s; A41 answered it wrong with time
  left) and **shadow-relay** (B41 1,317 s, 483 s left: room for the gate to act and to push it into the cap).
  react-lead-form, B41's third solve, is not used (B41 1,770 s: the gate would barely have room).
- **Order:** by B41's hidden-test fraction, highest first, ties by name, so the controls (1.0) and the near misses run
  first: wave 1 mvcc-lsm-compaction, shadow-relay, wal-recovery-ordering; wave 2 satb, production-planning, fin-saccr;
  wave 3 atrx, session-window, cargo; wave 4 ontology, roy, batched; wave 5 html-js-filter, protein. If the deadline
  stops the run early, the lowest-fraction tasks are the ones dropped.
- **Waves:** 3 tasks × 2 arms = 6 cells at once, both arms of a task concurrently (paired in time). Starts staggered
  20 s; within a task C starts first when (wave + task index) is even, else G.

## Apparatus

- **Runner:** `apparatus/run_h4lite.py`, derived from H3's `run_h3.py`: Harbor venv, flags and cap unchanged (`-n 1
  -k 1 --force-build`, build-timeout multiplier 4.0, agent-timeout multiplier for **1,800 s**), model
  **deepseek-v4.1-flash** (OpenCode Go), the per-cell log relay (`log-relay.mjs`) storing every request and reply under
  `runs/<cell>/wire/`, the trial reader, wire spend, free-port checks.
- **Slots: ONLY P2G relay slots 3–8** (relays already running on 172.17.0.1:4713–4718, counters 127.0.0.1:4813–4818,
  started by the coordinator; read only). Log relays on **4723–4728**. Slots 0–2 and ports 4720–4722 are H3's and are
  never touched. Cell k of wave w runs on slot 3 + ((k + w) mod 6), so each arm alternates between the odd and even
  slots from wave to wave: arm is not confounded with slot.
- **Budget: $10** of Go allowance, booked from the wire (`runs/<cell>/wire/calls.jsonl`); a wave starts only if spent
  + $3.00 ≤ $10.
- **Deadline:** no wave starts at or after **2026-11-05T20:45Z**; the last wave ends by ≈21:20Z (cap + build + verify).
- **Recorded per cell** (`runs/<cell>/cell.json`): slot, start time, wall, relay counter deltas, wire spend, Harbor's
  trial (reward, exception, timings, agent version), **host load** (1/5/15-min load average) and **running containers**
  on the docker host and available memory, at start and at end.
- **Known, shared condition (stated now):** the docker host and the Go account are shared. H3 (3 containers, slots
  0–2, the same model and account) and G1gate (1 container, the local qwen3.6 lane) run concurrently, and other
  containers (gbs05-gov-*) were up at registration (7 running in all). Arms are concurrent and paired by task, so the
  shared load and any provider-side contention fall on both arms of a pair alike; the load is recorded, not controlled.
- **Not touched:** H3, G1, R4H, their processes and ports; the slot relays (started by the coordinator). The runner
  kills only what it starts (its log relays and its mirror, by handle).

## Analysis (stated now)

**Cell validity (P2G's rule):** a cell is valid if the verifier ran (a reward exists) and the slot relay billed at
least one model response with usage to it. A pair is valid if both cells are. Apparatus failures (install, patch exit
3, provider outage before any response, DNS) are invalid, reported, and owed a re-run ("fix, don't fail"); they are
never scored as losses. Buckets (valid / invalid by cause) must sum to the cells run.

**Per-cell measures:**
- **hidden-test fraction** = passed / tests from `verifier/ctrf.json`; if the task writes no ctrf, the reward (1 or 0);
- **solved** = reward ≥ 1;
- **capped** = Harbor `AgentTimeoutError`;
- **false finish** = not capped, not solved, and ended with ≥ 300 s of the 1,800 s left (Harbor's agent_execution);
- **wall** = Harbor's agent_execution seconds;
- **gate** (G): `counters.completion_gate` from the final record (`gnomon-task.json`), else the last audit trail's
  `completion_gate` records (`audit/`, else `audit-live/` for capped cells): rounds, checks, reviews, review steps,
  findings, outcome, and the actions in order. C is the negative control: no gate counters, no gate record.

**Primary (targets, valid pairs):** paired G − C hidden-test fraction, mean with a task-bootstrap 95% interval
(10,000 resamples, seed 20261105).

**Secondary:**
- solved per arm, exact McNemar on discordant pairs (targets; and all 14);
- capped and false-finish counts per arm;
- wall time per arm (median) and paired G − C mean;
- gate behaviour: cells where the gate acted (rounds > 0), rounds, checks, reviews, review steps, findings, outcomes;
- requests, prompt/completion tokens and spend per arm (wire);
- **controls:** each reported on its own (harm = G unsolved where C solved, or G capped where C was not);
- the primary measure over all 14 pairs, as a sensitivity row.

**Screen decision (stated now):**
- **Positive signal** if the primary mean is > 0, G loses no control that C solves, and G has at most one more capped
  target than C. Then the gate goes into the AS1 sweep and a confirmation run (k ≥ 3, all P2G tasks). If, in
  addition, the interval excludes 0: "positive signal, interval excludes 0" (still a screen).
- **No positive signal** otherwise, reported with the interval; never "no effect".

**Power, stated now:** n ≤ 12 target pairs at k = 1. With a paired SD near P2G41's (≈ 0.37 in hidden-test fraction),
the standard error is ≈ 0.11 and the minimum detectable effect at 80% power is ≈ 0.30. The screen can only see a
large effect. The measured self-flip rate for one arm run twice is 14.7% (benchmark-discipline), so single-pair
flips mean little. The targets were selected because B41 failed on them: C will likely do better than B41 by
regression to the mean alone, so G is compared with the concurrent C, never with B41.

## Files

- `apparatus/gnomon_harbor_m152.py` (the pinned install), `gnomon_harbor_h4.py` (C, G, `GATE_PATCH`),
  `gnomon_harbor_h1.py` (H1's, byte-identical copy: `HOSTED_PATCH`, `GnomonV040Hosted.run`), `log-relay.mjs` (H3's
  copy), `run_h4lite.py`, `wiretest_h4.py`; `wiretest-h4lite.txt`; `mirror/v0.4.2/` (symlinks to G1gate's `dist/`).
- During and after the run: `STATUS.txt`, `launch.log`, `runs/`, `jobs/`, `summary-h4lite.txt`.

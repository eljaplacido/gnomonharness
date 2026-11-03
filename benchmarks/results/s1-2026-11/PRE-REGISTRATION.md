# S1: does gnomon's mid-turn steering help when it actually reaches the model? (pre-registration)

**Status: COMMITTED 2026-11-03T12:32Z by the coordinating session after review**, written 2026-11-03 before any S1 cell. The coordinating session reviewed this file and committed it
before launch. The chain then writes every gate result into `STATUS.txt` and commits it, with the probe, smoke and
lane files and the apparatus, **before the first measured cell**. It never edits this file. Any later change is a
timestamped amendment at the end of this file.

Modelled closely on M1 Amendment 3 (`../m1-2026-11/PRE-REGISTRATION.md`), with Amendments 4 and 5 applied: the
abort-on-disconnect relay, and the template finding.

## Question

gnomon steers a turn with messages of its own:
- the idle nudge ("You have run N tool calls without changing a file…");
- the convergence push ("You have used N of M tool calls…");
- the tool-less wrap-up;
- a failed declared verification;
- context-drop notices.

At the build under test it sends them as `role: "system"` messages *after* the conversation has started.

The incumbent local lane is R1H's: Unsloth's qwen3.6 template under llama.cpp. That template renders a system message at
index 0, merges one at index 1, and **silently skips every other system message**. M1 Amendment 5 found this offline
with jinja2, and `apparatus/probe_s1.py --offline` reproduces it on R1H's own `chat_template`. On that lane, none of
gnomon's steering has ever reached the model: R1H, R1 and M1's incumbent references all ran that way. In R1H's L arm
the idle nudge fired in 17 of 32 cells, and every one of those nudges was dropped.

**S1 asks:** with the same build, lane, tasks and window, does delivering the steering, as user messages marked
`[gnomon] `, change how many tasks gnomon solves and how its turns end?

## Build

Both arms run gnomon **`8078df03e2a28c41753825dcccab13e8a0ac03dd`**, the head of draft PR #120 (`fix/steer-role`).
- Its parent is `166a9d3c`, master, which was M1a3's build.
- It is fetched by SHA in every cell, checked on GitHub before each runner starts, and recorded per cell
  (`agent-logs/gnomon-commit.txt`, `ARM_VERSION=`).
- PR #120 adds the per-endpoint `steer_role = "system" | "user"`:
  - **Undeclared, or `system`**, sends exactly what master sends; the PR states the request bodies hash the same.
  - **`user`** sends each mid-turn system message as a user message starting `[gnomon] `. The leading system run
    (the system prompt and a folded summary) becomes one system message, and adjacent user messages are merged.
  - The PR also answers a template *refusal* by resending once in the user form (`counters.steer_role_adapted`).
    A template that drops the message raises nothing, so on this lane neither arm should ever adapt; the smoke
    checks this.

## Arms (L routing only)

| Arm | Cells | Build | `[endpoints.r1local]` |
|---|---|---|---|
| **S0** (control) | `s1-s0-…` | 8078df03 | `steer_role = "system"`, declared explicitly |
| **S1** (treatment) | `s1-s1-…` | 8078df03 | `steer_role = "user"` |

- **Surface difference.** The only surface difference is that one line. Each arm also points at its own meter port in
  the `url` line (5410 vs 5412), as M1a3's G0/G1 did (5310 vs 5312).
  - The profile, roles, policy, tools and system prompt are byte-identical, and `replay_reasoning` is undeclared in both.
  - `preflight_s1.sh` asserts this on a scaffold.
  - `wiretest-s1.txt` asserts it on the real `gnomon init` of 8078df03, with the port normalised.
- **Wire difference, observed offline before any data** (`wiretest-s1.txt`). The setup's own node block runs on the real
  `gnomon init`, then the real `gnomon task` at 8078df03, through `relay-meter-s1`, against a fake llama-style server
  that forces the idle nudge:
  - S0 sent the nudge as a late system message, the kind R1H's template drops: 4 requests, 0 `[gnomon]` notes, and the
    turn record's `wire` carries no `steer_role`;
  - S1 sent it as a `[gnomon]` note: 4 requests, 0 system messages after the first, and `wire.steer_role = "user"`;
  - in both, `steer_role_adapted` is absent and `nudges` = 1.
- **Unchanged from R1H's L arm:**
  - the lane (below);
  - the 16 tasks (`apparatus/sample16-hunch.txt`, byte-identical to R1H's) × 2 attempts, attempts as barriers, the
    seed = attempt shuffle, the same order in both arms;
  - the 900 s cap, tb 0.2.18 and its flags;
  - routing: every role local, entry `implementor`;
  - the cloud relay-go meter: unused in L, and a cell must read cloud = 0.
- **Concurrency, as M1a3.** S0 and S1 run at the same time, one slot each, filling the lane's 2 slots as R1H's 2-slot
  arms did.
  - **Bounded lead 1:** an arm starts position *i* only once the other has started *i − 1*. An arm that has finished
    or died never holds the other back.

**Treatment side effects, stated now and counted as part of the treatment:**
- **The template's "last query" moves.** In S1 a `[gnomon]` note is a user message, so the template's "last query"
  moves to the latest note. Assistant messages before it then render without the empty `<think></think>` block the
  template gives messages after the last query. In the offline render of probe cases A–C, S1's prompt has one
  `<think>` fewer than S0's. This is how the template renders a user message; S1 cannot deliver the steering
  without it.
- **Merged messages.** S1 merges a context-drop notice into the adjacent user message (probe case E).
- **Extra tokens.** S1's prompts are longer by the steering text, which S0's template discards.

## Lane: the incumbent's own (R1H's), untouched

- **Server.** llama.cpp **b11739** in `C:\dev\bud-lane` on the hub RTX 5090, serving `qwen3.6-35b`:
  - weights: `Qwen3.6-35B-A3B-UD-Q4_K_S.gguf` + the DFlash draft;
  - the chain checks both against R1H's sha256 (`2bee952b…`, `107b7a43…`) before starting;
  - flags: `--ctx-size 196608 --parallel 2` (2 × 98,304), `--reasoning off`, q8_0 KV, bound to the hub's 127.0.0.1:18380.
- **Start:** R1H's own `C:\dev\bud-lane\start-server-r1h-np2.ps1`, unchanged (sha256 `ce69d7d0…`, pinned in the
  chain; any change is fatal).
  - It is launched detached through `Win32_Process Create`, as R1H and BUD-2 did.
  - The script overwrites `server-r1h-np2.log`, so R1H's copy is saved first as `lane-r1h-server-before-s1.log.gz`.
- **Stop:** R1H's own `C:\dev\bud-lane\STOP-ME.ps1` (sha256 `ec69465d…`, pinned).
  - It runs only if this chain started the lane, and only if the bud-lane `llama-server.exe` running is the pid this
    chain recorded after its start.
  - Otherwise S1 stops nothing and says so.
- **Props gate.** `/props` and `/slots` must match R1H's `lane-props.json` and `lane-slots.json`:
  - `build_info`, `model_path`, `model_alias`, `chat_template` (byte for byte) and its caps;
  - `total_slots`, `n_ctx` and the slots' shape (2 × 98,304, speculative);
  - every server-default sampling parameter (top_k 20, min_p 0.05, …).

  Any difference is fatal.
- **Route from the gx10:** S1's own SSH forward, `apparatus/tunnel-s1.sh`, from gx10 127.0.0.1:**18780** to hub
  127.0.0.1:18380. It is launched in its own session, and stopped by its process group only.

**Ports.** None is used by any other apparatus; all are checked free before start.

| Arm | Local meter (relay-meter-s1) | Its counters | Cloud relay-go | Its counters |
|---|---|---|---|---|
| S0 | 172.17.0.1:5410 | 127.0.0.1:5420 | 172.17.0.1:5411 | 127.0.0.1:5421 |
| S1 | 172.17.0.1:5412 | 127.0.0.1:5422 | 172.17.0.1:5413 | 127.0.0.1:5423 |
| abort probe (pre-data, informational) | 127.0.0.1:5430 | 127.0.0.1:5431 | – | – |

Cells go to `runs/` and `runs-smoke/`, ids `s1-s0-k<k>-l-<task>` and `s1-s1-k<k>-l-<task>`. No other run's globs match them.

## Order, waiting and deadline (`apparatus/s1-chain.sh`)

1. **Wait for M1a5.** Wait on the M1a5 chain's **pid** (`S1_WAIT_PID`, default 3062504), whose `/proc/<pid>/cmdline`
   must contain `m1a5-chain.sh`. Never wait on a name.
   - If that pid is something else while an M1a5 chain runs, the chain stops with FATAL.
2. **Hub free.** The hub must be free, waiting up to 15 min:
   - no `llama-server.exe` at all;
   - GPU memory used under 4,000 MiB;
   - the WSL distro `m1-vllm` not running;
   - nothing listening on the hub's 18380.
3. **New-cell deadline:** `S1_DEADLINE`, default **2026-11-03T22:00:00Z**.
   - No cell starts after it. Unstarted cells are logged `NOT STARTED … (deadline)` and never imputed.
   - Pairs are taken only where both arms ran.
   - R1H's L cells took a median of 71 s, at most 1,200 s, so 32 positions per arm should fit in about 1–2 h.
4. **One S1 chain at a time:** `flock` on `.chain.lock` here. Commits take the M1 chains' own lock
   (`../m1-2026-11/.commit.lock`, opened for append), so S1 and M1 commits in the shared worktree never interleave.
   Commits add only S1's paths.

## Pre-data gates, in order (each result goes into STATUS)

1. **Hub inputs.** The hub scripts' hashes are as pinned, and the weights' checksums are R1H's.
2. **Evidence kept.** R1H's server log is saved before the start overwrites it.
3. **Lane up.** The lane starts (one fix-don't-fail retry). Then the props gate above.
4. **Template gate, the negative control. Must pass.** `probe_s1.py` renders each history of
   `apparatus/probe-shapes-s1.json` through the live lane's `/apply-template`, which renders without generating.
   - Each history comes in S0's shape, and in S1's shape as computed by **8078df03's own `steerAsUser`**
     (`make_probe_shapes.mts`, not a re-implementation).
   - Gate cases:
     - **A:** a nudge after a tool result;
     - **B:** a nudge followed by two more steps;
     - **C:** the tool-less wrap-up.

     In A, B and C the marker `MARKER-S1Q` must be **ABSENT under S0's shape and PRESENT under S1's shape**.
   - **D** is the positive control: a system message at index 1 (a folded summary) must be **PRESENT under both**. So
     the probe can see a system message that the template keeps, and A's absence is about position, not detection.
   - E (a context-drop notice) and F (a failed verification) are informational.
   - The shapes must have been made by the build under test (`PROBE_SHAPES_SHA`).
   - The same gate passes offline now: jinja2 on R1H's `chat_template` (`preflight_s1.sh`). The live gate confirms
     that llama.cpp renders it the same way.
5. **Abort probe, informational.** Through `relay-meter-s1`, a streamed generation abandoned after 4 s must leave its
   slot within 30 s (`/slots`; this lane serves no `/metrics`).
6. **Smoke.** One hello-world cell per arm, concurrently. Each must be valid and solved, and:
   - its surface carries its arm's `steer_role` line exactly once;
   - every turn record has `wire.steer_role = "user"` (S1) or no `steer_role` (S0);
   - `counters.steer_role_adapted` is 0;
   - the meter shows no `reasoning_content` and no meter errors;
   - **S0 sent no `[gnomon]` note**, the negative control on the wire;
   - **S1 sent no system message after the first.**

   Hello-world rarely triggers steering, so the smoke may pass without exercising it. That is logged; gate 4 and
   `wiretest-s1.txt` cover the steering path. One retry is allowed, restarting the lane only if it stopped answering.
   A second failure means S1 is not run.
7. **Commit before data:** STATUS, the probe and smoke files, the lane's props, slots and models, R1H's server log,
   `wiretest-s1.txt`, this file and `apparatus/`.

## Meter: `relay-meter-s1.mjs`

A copy of M1a3's `relay-meter-m1a3.mjs`; the original is untouched.
- **Kept unchanged:** usage via `JSON.parse`, the timings fallback, the reasoning counters (expected 0 here).
- **Added (1), abort on disconnect.** This is M1 Amendment 4's `relay-meter-r1-abort.mjs` behaviour. When the client
  leaves before the reply is complete, the upstream request is destroyed, and the event is counted as `client_aborts`.
- **Added (2), the mechanism metric**, read from each request body:
  - system messages after the first;
  - system messages R1H's template drops: index ≥ 2, or index 1 when index 0 is not a system message;
  - `[gnomon] ` notes in user messages;
  - per request and as volume, "new steering" requests (the count rose against the cell's previous request), and
    which kind of steering, by gnomon's own wording: nudge, converge, wrapup, verify, context, other.
- **Read-only.** The meter observes and never edits a body.
- **Tests.** `test_relay_s1.mjs` has 36 offline cases: M1a3's 22, 10 on the mechanism metric, and 4 on loopback
  sockets (abort, normal reply byte-identical and metered, refused upstream, counters).
  - The abort case was checked against a copy of the relay with the abort removed; that copy fails the case.

## Validity (M1's = R1H's, unchanged)

- **One validity function for every cell.** `apparatus/collect_m1.py` is a byte-identical copy of M1's (hash pinned in
  the preflight). Its `parse_cell` judges every S1 cell and R1H's L reference alike.
- **A cell is valid when** tb returned a verdict, both meters read non-negative deltas, at least one chat request was
  metered, it ran the pinned commit, and gnomon did not give up on an endpoint after its whole retry grace (R1H's
  endpoint-outage rule).
- **L routing:** cloud = 0 and local > 0.
- **Every other state is apparatus.** Such cells are reported and never scored. Buckets are asserted to sum to n per arm.
- **Outages and operator stops:**
  - a lane outage makes the affected cells `endpoint_outage`; they are re-run once if time allows;
  - a cell in flight when the chain is stopped moves to `runs-aborted/<cell>-<reason>` and is re-run from scratch.

## Endpoints, declared now (`apparatus/collect_s1.py`)

**Mechanism metric (resolvable).** Per arm, from the meter:
- requests carrying a system message the template drops;
- requests carrying a `[gnomon]` note;
- requests with any system message after the first.

Expected:
- **S0:** dropped > 0, notes = 0;
- **S1:** notes > 0, late system = 0;
- **both:** `steer_role_adapted` = 0.

Reported beside it, never instead of it:
- the per-cell surface line;
- the turn records' `wire.steer_role` and `counters.steer_role_adapted`;
- `counters.nudges`;
- the per-kind counts.

If S0 shows notes, S1 shows late system messages, or S1 shows no notes in cells where steering fired, that is an
apparatus finding. The score comparison is then not read as a test of steering.

**Score metric (probably not resolvable at this n).** Pass rate with a Wilson 95% interval, and exact two-sided McNemar
on (task, attempt) cells valid in both arms:
1. **S1 vs S0, primary.** Same build, lane and window; one line apart.
2. **S0 vs R1H L.** A build-change control: 8078df03 against d59e6c19, steering dropped in both. Time-separated,
   descriptive.
3. **S1 vs R1H L.** Time-separated, descriptive.

**How turns end.** The distribution of the last turn record's `stop_reason` per arm, over all cells, valid cells, and
valid unsolved cells: answered, stall, step_wall, truncated, malformed, with capped cells having none. The hypothesis
predicts fewer `stall` and `step_wall` endings in S1. A competing prediction, stated equally: delivered nudges ("stop
and answer") could end some solvable turns early.

**Secondary, descriptive:**
- steering exposure: valid cells where steering fired, and solved among them, per arm;
- the discordant pairs, with each side's stop reason and nudge count;
- capped cells, median agent wall time, local tokens per solved.

**What counts as an answer:**
- **S1 helps:** S1 solves significantly more than S0 (p < 0.05).
- **S1 hurts:** S0 solves significantly more (p < 0.05).
- **Anything else** is "no difference shown", reported with direction and intervals.
- A mechanism win with no score movement is an honest partial result, declared here in advance.

This run informs PR #120's default; it does not decide it alone. A significant S1 < S0 argues against a `user`
default on this lane; a significant S1 > S0 argues for it.

## Power and limitations, stated now

- **Power.** At most 32 pairs. The measured self-flip rate is about 15% between attempts, so only pass-rate
  differences of roughly 20 points or more are detectable.
  - The baseline leaves little room. R1H's L arm solved 24 of 32 (75%). Of its 8 unsolved cells, 5 ended in `stall`
    and 4 had a dropped nudge.
  - A plausible effect is therefore a few cells, below the MDE. A non-significant S1 vs S0 is "no difference shown",
    not "no effect". The mechanism metric and the stop-reason distributions carry most of the information.
- **Time separation.** S0 and S1 are concurrent. The R1H comparisons are time-separated: R1H ran 2026-11-02/03 on
  build d59e6c19 (unstreamed, no `max_tokens`, reasoning promotion; M1 Amendment 3 lists the differences) and through
  `relay-meter-r1`.
- **Shared gx10 host.** Task containers run on the gx10's docker alongside whatever else runs there (R1, P2G, M1b at
  writing), with the same load for both arms at any moment. Only the bounded lead makes it equal over time.
- **Bounded lead.** An arm sometimes waits while the other finishes, so the server occasionally sees one stream rather
  than two. This applies to both arms alike.
- **Different relay.** The abort-on-disconnect relay differs from R1H's only when a client abandons a request.
- **Nudge counter scope.** `counters.nudges` counts idle nudges only. Convergence, wrap-up, verify and context
  messages are counted by the meter, by kind.
- **Budget.** L cells spend $0 of cloud. S1's own ledger (`spend.jsonl`) caps at $1.00 as a tripwire for misrouting.

## Cleanup and scope

The chain starts and stops only:
- R1H's lane, via R1H's own scripts, under the pid rule above;
- its own tunnel, by the process group it launched;
- its own relays, started and stopped by `run_s1.py`.

Cleanup runs only when the chain exits. There is no idle fallback and no `pkill` by pattern. Nothing under
`benchmarks/results/` outside `s1-2026-11/` is written: R1H's and M1's files are read, and M1's commit lock is opened
for append.

## Files

- `apparatus/s1-chain.sh`: the chain. `DRY=1` runs read-only checks.
- `apparatus/run_s1.py`: the runner (`plan`, `smoke`, `full`).
- `apparatus/collect_s1.py`: the analysis (`--smoke`, `--no-write`).
- `apparatus/gnomon-setup-s1.sh.j2`, `apparatus/peer_agents_s1.py`: M1a3's setup and agent with the arm line changed.
- `apparatus/relay-meter-s1.mjs`, `apparatus/test_relay_s1.mjs`: the meter and its tests.
- `apparatus/probe_s1.py`, `apparatus/probe-shapes-s1.json`, `apparatus/make_probe_shapes.mts`: the template gate.
- `apparatus/probe_abort_s1.mjs`: the abort probe.
- `apparatus/wiretest_s1.mjs`, `wiretest-s1.txt`: the offline wire test.
- `apparatus/preflight_s1.sh`, `apparatus/tunnel-s1.sh`: the preflight and the tunnel.
- Byte-identical copies:
  - from R1H: `peer_agents_r1.py`, `gnomon_agent.py`, `relay-go.mjs`, `sample16-hunch.txt`;
  - from M1: `collect_m1.py`.

## Amendment 1, 2026-11-03T16:11Z: S1 runs overnight on the user's gaming machine and gives the GPU back; before any S1 data

**What happened.**
- S1 was committed as `f8053383` and launched.
- At 2026-11-03T15:14:30Z the operator stopped it while it was still waiting on the M1a5 chain's pid. It had started
  nothing and measured nothing (`STATUS.txt`).
- M1a5 has since ended.
- The RTX 5090 hub is also the user's gaming machine tonight. S1 may run overnight, but it must never get in the
  user's way.

**What changes.** Only when the lane runs, and how the lane gives the GPU back. Nothing that is measured changes.

### 1. Start condition: an idle GPU, not a pid

The wait on M1a5's pid is removed. The chain samples the hub every **60 s**. A sample is *idle* when:
- GPU memory used is **< 4,000 MiB**;
- utilization is **< 15 %**;
- no `llama-server.exe` is running;
- the WSL distro `m1-vllm` is not running.

The lane may start after **15 consecutive idle samples (15 min)**:
- an unreadable sample, such as ssh failing, resets the count;
- the chain waits indefinitely, up to the new-cell deadline;
- right before each start, the original full check also runs (it adds "nothing listening on the hub's 18380").

**Cost on the hub.** Each sample is one ssh into `cmd.exe` running `nvidia-smi`, `tasklist` and `wsl -l --running
-q`. It takes about 0.3 s and starts no PowerShell.

### 2. The gaming-yield watchdog

The watchdog samples the same way every **30 s**, from the moment the lane process is created until the lane is
stopped. It yields when any of these holds:

- **(a) Memory over the limit.** GPU memory used exceeds the limit for **2 consecutive samples**.
  - The limit is the lane's measured **warm level + 1,500 MiB**.
  - The warm level is measured right after the lane is up: after the template gate and a warm-up of two concurrent
    ~2,000-token requests, it is the maximum of three samples 5 s apart. It includes the desktop baseline.
  - While the lane is still loading, the limit is provisional: the desktop baseline (the last idle sample) plus
    R1H's measured lane footprint (24,543 MiB: 27,766 used with the lane, 3,223 without) plus 1,500 MiB. A game
    started during the load is therefore caught too.
- **(b) Our lane is gone.** Our `llama-server.exe` is no longer running: someone ran STOP-ME, or it crashed. The
  yield is immediate. **Running `C:\dev\bud-lane\STOP-ME.ps1` is therefore the user's manual "give me the GPU" button.**
- **(c) Something else wants the GPU.** Another `llama-server.exe`, or `m1-vllm`, is running. The yield is immediate.

An unreadable sample is not evidence: it neither yields nor resets the count.

Detecting a foreground or full-screen app is **not** used:
- ssh sessions run outside the user's interactive desktop session and cannot see its foreground window;
- launcher processes (Steam and the like) run while idle too.

GPU memory is the signal.

**Footprint check.** If the measured warm level minus the desktop baseline exceeds R1H's footprint + 1,500 MiB,
something else is already on the GPU. That counts as a yield. Two such anomalies are fatal, so the user's machine
never sees a start/stop loop.

**On a yield, in this order:**
1. **`YIELD-NOW` is written first.** From that moment, `run_s1_a1.py` starts no cell. Every cell in flight in
   **both** arms is aborted:
   - its tb process group is stopped;
   - its compose project is removed by exact label;
   - the cell moves to `runs-aborted/<cell>-yield` (`-yield-2`, … on a repeat).

   This applies even to a cell whose tb finishes after the flag. Under the operator-abort rule these cells are re-run
   from scratch on resume and never scored.
2. **The lane stops:** R1H's `STOP-ME.ps1`, only if the running server is the pid this chain recorded. While the
   pid is not yet recorded, the server stopped is the bud-lane server this chain created on a hub that had none.
3. The chain closes its tunnel, keeps the server log as a segment (`lane-s1-server-<n>.log.gz`), logs `YIELD` in
   STATUS and returns to the idle wait.

### 3. Resume

On each later start the lane is checked again before any cell:
- R1H's script starts the lane, unchanged;
- the **props/slots check** must match R1H's, as before; any difference is fatal;
- the **template gate** (negative control) runs again on every start, which takes seconds;
- the warm level and the limit are re-measured.

What does not repeat, and what carries over:
- **Once only:** the smoke, and the informational abort probe. They run on the first start only (`smoke-s1.txt`
  ending `smoke: PASS`). The lane is the same lane; only the props check stands guard for it.
- **Finished cells.** A cell with `cell.json` is finished and never re-run. A cell directory without one moves to
  `runs-aborted/<cell>-incomplete` and the cell is re-run.
- **Bounded lead 1.** It holds across a yield: both arms' in-flight cells are aborted together, and on resume each
  arm skips what it finished. The invariant is checked where the lead is enforced, in the tests.
- **A smoke interrupted by a yield** moves its cells to `runs-smoke-failed/<cell>-yield` and runs again. It does not
  count as a failed try.

### 4. Deadline

The new-cell deadline is **2026-11-04T07:00:00Z**; `S1_DEADLINE` still overrides it.
- No lane starts after the deadline.
- Cells in flight finish under the watchdog.
- The chain then collects and commits.

### 5. Unchanged

These stay exactly as pre-registered:
- the build `8078df03e2a28c41753825dcccab13e8a0ac03dd`: PR #120, since merged into master, with the pinned SHA
  kept so the pre-registration holds;
- the arms and their one-line difference;
- the tasks, order, cap, validity, meters, ports and gates;
- the analysis (`collect_s1.py` reads `runs/` only; aborted cells are counted and never scored);
- the commit lock;
- the scoped cleanup.

### Apparatus

**Edited:**
- `apparatus/s1-chain.sh` (it was not running).

**New:**
- `apparatus/s1-hubwatch.sh`: the idle detector, the yield decision and the watchdog, as pure functions of one sample.
- `apparatus/run_s1_a1.py`: imports `run_s1.py` unchanged. It adds the cell.json skip, the yield abort, a SIGTERM
  abort (tb runs in sessions of its own), and `abort-inflight` for the chain's fallback. The smoke stays
  `run_s1.py smoke`.
- Offline tests, none of which touches the hub:
  - `test_hubwatch_s1.sh` (50 cases): the parser on the hub's real output, including UTF-16 from `wsl.exe`; every
    idle condition; count resets; the deadline; the limits; every yield trigger; the watchdog loop writing the flag
    before the stop.
  - `test_run_s1_a1.py` (24 cases): skip and incomplete; a yield mid-attempt in both arms; a tb finishing after the
    flag; resume with the lead invariant; SIGTERM; `abort-inflight`; refusing to start while `YIELD-NOW` exists.
  - `test_chain_glue_s1.sh` (15 cases): the chain's own functions playing a full yield with fakes.

  The chain runs all three before its first lane start, and any failure is fatal.

### Caveats, stated now

- **More time separation within S1.** Cells may be spread over several lane sessions in the night. Each restart
  resets llama.cpp's prompt cache, for both arms alike. Within a session the two arms stay time-matched by the lead.
- **Long cells are aborted more often.** They are likelier to be in flight at a yield. The aborted run is never
  scored and the re-run is a full, fresh cell, so the kept result does not depend on the abort. Yields come from the
  user's gaming, not from the cells.
- **Detection delay.** A game is caught 30–60 s after its memory crosses the limit, plus a few seconds for STOP-ME.
  - Cells that *finish* inside that window ran under GPU contention and are kept. They can be identified afterwards
    from `hubwatch.log`.
  - A game using less than 1,500 MiB above the lane's level is not detected and shares the GPU. The user can always
    yield by running STOP-ME, which is detected within 30 s.
- **Overhead.** Each resume costs about 3–5 min before cells run (load, gate, warm-up), and needs 15 idle minutes first.

## Amendment 2, 2026-11-03T16:47Z: the arms never started; three apparatus fixes; before any S1 data

**What happened.** The Amendment 1 chain (pid 568292, `76e6300d`) ran through the start sequence:
- it waited for the idle GPU and brought the lane up;
- props, template gate, abort probe and smoke all passed (`4dd2afc1`).

Then:
- **16:27:41Z.** It logged "S1 arms finished (runner exit 1)" with **zero cells**.
- **Lane and commit.** It stopped the lane, collected, and committed "S1 complete" (`3cac092c`).

**Erratum to `3cac092c`:** "S1 complete — summary and runs" is wrong. No S1 cell ran, and its `summary-s1.txt` is empty
of S1 data.

**Cause.** The R3R preparation agent diagnosed this and reproduced it offline. `run_s1.port_free` tests a port by
binding a socket **without `SO_REUSEADDR`**. The smoke's relays had been killed seconds earlier with connections open,
which left server-side TIME_WAITs on their ports. The full runner therefore read `127.0.0.1:5421` as "in use" and
refused to start (exit 1). node's listeners bind with `SO_REUSEADDR` and take such a port without trouble.

The chain then treated an exit 1 as "arms finished".

A second fault: after its loop, the chain stopped the lane unconditionally. The lane was its own this time, so no harm
was done.

**Fixes.** They mirror R3R's copy (`../r3r-2026-11/apparatus/`). Nothing measured changes.

1. **The meter-port check.** `apparatus/run_s1_a2.py` is a new entry point that imports `run_s1.py` and
   `run_s1_a1.py` unchanged. It routes their port check through a fixed `port_free`:
   - **`SO_REUSEADDR` is set before the probe bind**, so a port is busy only when something **listens** on it. A
     TIME_WAIT is free.
   - **Bounded wait:** before refusing, the runner waits up to **120 s** for a listener that is still going away,
     re-checking every 5 s.

   The chain runs the smoke (`run_s1_a2.py smoke` = `run_s1.py smoke`) and the arms (`run_s1_a2.py full` =
   `run_s1_a1.py full`) through it. Its own pre-start check of the gx10 ports was already listener-only (`ss -l`); it
   now waits up to the same 120 s before it is fatal.
2. **A runner failure is not "arms finished".** The runner has failed if either holds:
   - it exited with something other than 0 (done) or 75 (yield);
   - it exited 0 having finished no cell while cells remained before the deadline.

   A failure is logged with the exit code and the finished-cell count, and the arms are launched once more after
   60 s (finished cells are skipped). If the lane no longer answers at that point, it goes down and the chain returns
   to the idle wait, as for any lane failure. A second failure is **FATAL**:
   - the chain stops its lane, under the rule below;
   - it exits 1 with `EXIT FATAL (not DONE)`;
   - it **commits nothing**, leaving the files on disk for review.

   Every other fatal condition now ends the same way.
3. **The lane guard.**
   - After the loop, `lane_down` runs only if this chain started a lane.
   - `lane_down` itself touches the hub only when `LANE_STARTED` is set.
   - `stop_lane_ours` stops a running bud-lane server only if it is the pid this chain recorded, or, while the pid is
     still unrecorded, only if this chain has started a lane. That is Amendment 1's "ours by construction" case.

**Start.** The chain starts fresh from Amendment 1's idle wait: 15 idle minutes before any lane start.
- The smoke passed on the same lane (`smoke-s1.txt`, committed in `4dd2afc1`) and is not repeated.
- Props, template gate and warm-up run again on every start, as Amendment 1 says.

Unchanged: build `8078df03e2a28c41753825dcccab13e8a0ac03dd`, the arms, tasks, order, cap, validity, meters, ports,
gates, Amendment 1's idle and yield thresholds, the deadline 2026-11-04T07:00:00Z, and the commit lock.

**Tests, offline, run by the chain before its first lane start:**
- `test_run_s1_a2.py`, 12 cases:
  - a listener is busy and a real TIME_WAIT is free;
  - **negative control:** run_s1's original check reads the same TIME_WAIT as busy;
  - `install()` reroutes run_s1;
  - the bounded wait covers a listener that goes away and one that stays, and the refusal message.
- `test_chain_a2_s1.sh`, 24 cases on the chain's own functions:
  - retry once after 60 s, then failed;
  - exit 0 with no cell is a failure, and is fine after the deadline;
  - a lane lost after a failure, a yield, and exit 75 without a flag;
  - a FATAL exit commits nothing and never says DONE; a normal end says DONE;
  - every lane-guard case;
  - the gx10 port wait on real sockets.
- Amendment 1's suites pass unchanged against the edited chain: 50, 24 and 15 cases.

## Amendment 3, 2026-11-03T17:07Z: S1 moves to the gx10's own lane (R1's), one shared slot; before any S1 data

**Why.**
- The RTX 5090 hub is the user's gaming machine for an unknown time. R3R keeps it.
- The operator stopped the Amendment 2 chain (pid 667619) at 16:56:50Z, while it was still in its idle wait. It had
  started nothing.
- S1 moves to the gx10's own local lane, now.

### The lane: `llama-server-qwen-q4.service` on the gx10, which is R1's lane

| | R1H's hub lane (the design so far) | the gx10 lane (now) |
|---|---|---|
| weights | Qwen3.6-35B-A3B-UD-Q4_K_S.gguf `2bee952b…`, DFlash draft `107b7a43…` | the same files (checksums checked at start) |
| chat template | Unsloth qwen3.6 (`r1h-2026-11/lane-props.json`) | **byte-identical** (checked at start; the template gate's premise) |
| llama.cpp | b11739 (Windows CUDA) | b1281-571d0d54 (the gx10's DFlash build, binary unchanged since 2026-07-19) |
| slots × context | 2 × 98,304 | **1 × 98,304** (`--parallel 1`) |
| KV, reasoning, spec | q8_0, `--reasoning off`, draft-dflash | the same |
| served at | hub 127.0.0.1:18380, via S1's tunnel | **127.0.0.1:18080 directly**; no tunnel |

- **R1 used this exact process.** R1's L arm ran on this lane. Its cells after M1b's restore ran on the very server
  process that serves now: MainPID 3018163, up since 11:36:47Z; R1 finished at 15:11:38Z.
- **R1 recorded no lane props, so references were recorded at preparation** (2026-11-03T16:59:44Z, read-only GETs
  and `systemctl --user cat/show`): `lane-gx10-ref-props.json`, `lane-gx10-ref-slots.json`, `lane-gx10-ref-unit.txt`
  and `lane-gx10-ref-info.txt`.
- **Before any cell, the lane must match these references:** build, model file, alias, template and caps, 1 slot ×
  98,304, speculative, every server default, and the unit text with its flags (`--parallel 1 --ctx-size 98304`, q8_0
  KV, `--reasoning off`, the DFlash draft). Any difference is FATAL.
- **Differences from the hub lane** are in the caps (one key absent) and three server defaults: `adaptive_*`, and
  `dry_penalty_last_n`, which is inert with `dry_multiplier = 0`. None touches the template.
- **The template gate passes on this lane.** It was run live at preparation, read-only (`/apply-template` renders):
  A–D as designed, E–F as expected. It runs again before any cell.

**The chain never starts, stops, restarts or signals the service.** It reads it (`systemctl --user cat/show`, GET
`/props`, `/slots`, `/v1/models`) and sends it requests through S1's meters.
- If the lane stops answering after a runner failure, the chain waits up to 10 min for it, without touching it. If
  the lane does not come back, or comes back different, that is FATAL.
- The chain holds P1's gx10 `gpu.lock` while it uses the lane, as R1 did, so other gx10 GPU benchmarks wait. Its
  children do not inherit the lock's file descriptor, so no orphan can keep it held.
- Cleanup covers only what the chain started: its runner and the runner's relays, by the process group it launched,
  and that runner's in-flight cells (moved to `runs-aborted/<cell>-operator`).

**Gone from the gx10 chain:** no hub, no ssh, no tunnel, no idle wait, no yield. There is no gaming on the gx10.

**Ports.** Meter ports are unchanged (5410–5413, counters 5420–5423, abort probe 5430/5431), with Amendment 2's port
check. The relays' upstream is `http://127.0.0.1:18080`.

### One slot, two arms

- **Concurrency.** S0 and S1 still run concurrently with bounded lead 1, so the pairs stay matched in time. On this
  lane their requests **queue at the single server slot**, and each arm's model time includes waiting for the other
  arm's requests.
- **Expected walls.** They are longer than R1's, and more cells will reach the pre-registered **900 s cap**, which is
  kept. This handicap is the same for both arms at every moment: the same slot, the same tasks at about the same time.
  It lowers the ceiling of both, and reduces power further, because capped cells are mostly failures in both arms.
- **Capped counts** are reported per arm, valid cells only, beside R1's (`collect_s1_a3.py`).
- **Expected wall time.**
  - R1's L arm on this lane, alone on the slot one cell at a time: 32 cells, 4.0 h of cell wall in total (median
    209 s), 5,059 GPU-s (1.4 h), 7 cells capped (5 of them valid).
  - Two arms sharing the slot add up to ~1.4 h of queueing per arm.
  - Expected: about **5–6 h** for 64 cells, plus ~10 min of checks, probe and smoke. Started around 17:30Z, that ends
    around 23:00–00:00Z, well before the deadline.
  - Expected capped cells: more than R1's 5 per 30.

### Reference for the descriptive comparisons

R1's L arm (`r1-2026-11/runs`) replaces R1H's L arm: the same lane, build d59e6c19, alone on the slot. As judged by
the same validity rule, it has 30 of 32 valid, 18 solved and 5 capped. The comparisons are time-separated and
descriptive (`collect_s1_a3.py`):
- **S0 vs R1 L** is the build-change control on the same lane;
- **S1 vs R1 L.**

The PRIMARY comparison, S1 vs S0 by exact McNemar, is unchanged.

### Contention and load

P2G runs on this machine: cloud harnesses with CPU-heavy task containers. It is not touched.
- Load is recorded per cell (`load.json`).
- The two S arms run at the same time, so P2G's load falls on both alike.

### Gates, smoke, records

Run on this lane, before any cell:
1. Offline tests.
2. The gx10 `gpu.lock`.
3. Lane checks, checksums and ports.
4. The template gate.
5. **First time only:**
   - the hub lane's smoke (`4dd2afc1`) is kept as `runs-smoke-hub/` and `smoke-s1-hub.txt`;
   - the abort probe (informational) and the smoke run on this lane; the smoke must pass, and both smoke cells must
     record `local_upstream = http://127.0.0.1:18080`;
   - commit before data.

Then both arms run. A runner failure is retried once after 60 s; a second is FATAL (Amendment 2). A FATAL exit commits
nothing and is not DONE.

Each finished cell's `cell.json` records `local_upstream` 127.0.0.1:18080, lane `gx10-qwen-q4`, `lane_slots = 1` and
`amendment = 3`. Its `gpu_slots = 2` still counts the arms running at once.

### Unchanged

- build `8078df03e2a28c41753825dcccab13e8a0ac03dd`;
- the arms and their one-line difference;
- the tasks, order, 900 s cap, validity rule, meters and mechanism metric;
- the deadline 2026-11-04T07:00:00Z (`S1_DEADLINE` overrides);
- the commit lock.

### Apparatus

- **New:**
  - `apparatus/s1-chain-gx10.sh`, the chain;
  - `apparatus/run_s1_a3.py`, which imports run_s1_a2, run_s1_a1 and run_s1 unchanged;
  - `apparatus/collect_s1_a3.py`, which imports collect_s1 unchanged;
  - the `lane-gx10-ref-*` references.
- **Kept as it was, unused:** the hub chain `s1-chain.sh` with its Amendment 1–2 tests.
- **New tests:**
  - `test_run_s1_a3.py` (15 cases): the lane switch, meters relaying to :18080, unchanged ports, the Amendment 2
    port check in place, the `cell.json` annotation, R1's L arm as the reference, and the smoke's lane check;
  - `test_chain_a3_s1.sh` (29 cases):
    - a static scan: no systemctl verb but `cat`/`show`, no pkill, killall, ssh, STOP-ME or tunnel, every `kill`
      scoped to the runner's process group;
    - a runtime `systemctl` shim that records every call;
    - `lane_check` refusing a changed template, n_ctx, build, slot count or unit;
    - the `gpu.lock` wait, hold and deadline, and that the lock fds are not inherited;
    - the runner retry, the lane lost or back, a FATAL exit committing nothing, and the smoke bookkeeping.

**Launch setting, 2026-11-03T17:07Z:** `S1_DEADLINE=2026-11-03T21:15:00Z`, the pre-registered deadline knob. The user wants tonight's runs finished by midnight local (22:00Z). Cells not started by then are reported as not run and never imputed. Attempt 1 is expected to complete; attempt 2 will be partial.

# Pre-registration — peer harnesses on one local model (gx10)

**Written 2026-10-31, before any peer trial ran.** The design was chosen by the
user from four options. The only runs before this one are smoke cells
(`MODE=smoke`, hello-world), which prove each arm installs and reaches the model
and are not analysed.

## Question

On the same model, the same tasks and the same time cap, does gnomon's harness
resolve more or fewer Terminal-Bench tasks than four peers? "Same" is enforced;
see below. The peers are:
- the minimal floor and reference harness;
- the peer gnomon was last compared with;
- a harness built for the same model family;
- **opencode**, the peer gnomon's published claims are built around. The
  gnomonharness.com headline is "50.0% vs 47.1%, p = 1.0, 34 tasks", a 2026-09-02
  run whose README says the definitive version still had to be done: opencode
  with the same consent gnomon is given.

*Amended 2026-10-31, before any trial: the opencode arm was added.*

## Design

| | |
|---|---|
| arms | **gnomon** v0.3.1 (`7012c5a6d80516891b061cc0f07ac1724b6289a0`, fetched by SHA, the August adapter, `--role implementor`, approval never)<br>**mini-swe-agent** 2.4.6 (tb's run command)<br>**goose** v1.57.0 (tb's recipe and run command)<br>**Qwen Code** 0.26.4 (`-p … --approval-mode yolo`)<br>**opencode** V2 v2.2.5, the newest line: a GitHub release binary, auto-update off, `run --standalone --auto`, where `--auto` approves everything not explicitly denied. The run is logged, and any auto-reject is counted per cell; a nonzero count makes that cell's opencode score a floor and is reported as such |
| model | `qwen3.6-35b` on gx10's llama-server (`:18080`, `--parallel 1`). Every arm reaches it through the same relay on the docker bridge |
| tasks | the 16 tasks of `sample16-hunch.txt`: a fixed-hash subset of the pre-registered August 48, chosen by name, not by outcome. Task clone at laude-institute/terminal-bench `d28711d`, the same as H7 |
| n | 3 attempts per (arm, task), so 48 cells per arm and 240 in all (about 38 h at about 9.5 min a cell) |
| cap | 900 s per agent run (`--global-agent-timeout-sec`), identical for every arm |
| order | interleaved. Each attempt shuffles the tasks with a fixed seed, and on each task the five arms run back to back in an order that rotates with the task. One `tb run` per cell |
| runner | tb 0.2.18, one trial at a time, holding `decisionbench/gpu.lock` |

## Scoring, fixed in advance

- **Valid cell:** the agent started and tb returned a verdict (`is_resolved` not
  null). Anything else (image build, install failure, crash) is apparatus. It is
  counted per arm and reported, never scored as a failure.
- **Resolved** is tb's `is_resolved`, from its hidden tests. No harness's own
  account is used.
- **A pair is compared only where both arms have a verdict.** A cell where either
  arm hit an apparatus failure is void for that pair.
- **Buckets sum to n:** `collect_peers.py` asserts it.

## Analysis, fixed in advance

1. **Per arm:** passed / valid cells, with a 95% Wilson interval.
2. **Paired, gnomon against each peer:** an exact McNemar test over the
   (task, attempt) cells both arms completed.
   - **Three-valued.** Fewer than 6 discordant pairs means "cannot tell": no split
     of fewer could reach p < 0.05, and it is not reported as "no difference".
   - **No correction is claimed beyond stating it:** there are three comparisons,
     so an uncorrected p near 0.05 is weak.
3. **Noise floor, per arm:** how many of the 16 tasks give different verdicts
   across their 3 attempts. A difference between arms that is smaller than an
   arm's own flipping is not read as a difference.
4. **Descriptive only:** cells at the 900 s cap, wall-clock per arm, and install
   failures per arm.

## Floor gate, decided before launch

**Added 2026-10-31 ~11:05Z, before any peer trial.** H7 (in progress) runs gnomon
on all 48 August tasks, including these 16, with the same model and cap. Its
`[shadow]` block is log-only and changes nothing about the run. At the time of
writing, its first 5 trials were all unresolved.

**The rule:** if gnomon resolves **2 or fewer of these 16 tasks in H7**, this
design is at the floor and cannot resolve harness differences. Six one-way
discordant pairs are the minimum for p < 0.05. The full run is then **not
launched**: the task set or the model is changed and this file amended first.
This is the check AgentLab adopted after spending ~400 cells on designs at the
floor or the ceiling (its methodology, "Can this design resolve anything?").

## What this run can and cannot resolve

- **Only large differences.** 48 paired cells resolve roughly 20–25 percentage
  points between two arms, depending on how often they disagree. A 10-point gap
  is below what this design can see, and the result will say "cannot tell"
  rather than "equal".
- **Tokens: amended 2026-10-31, before any peer trial.** They were "not compared"
  in the first version of this file. They are now metered by the relay
  (`relay-meter.mjs`). Trials run strictly one at a time and only container
  traffic passes through it, so the counter delta around a cell is that cell's
  traffic. The counts are what llama-server reports, never estimates:
  - `usage` when present, otherwise its `timings` (prompt = cached + processed,
    completion = predicted);
  - a response carrying neither is counted as unmetered and reported per arm.

  Secondary endpoints, fixed now:
  - tokens per resolved task (all tokens an arm spent, divided by the tasks it
    resolved);
  - median tokens per cell;
  - prompt-cache share (cached / (cached + processed): the latency side of
    lean);
  - **paired**, against gnomon: an exact sign test over cells both arms
    completed, on which used fewer tokens.

  This is the instrument H16 (the token comparison against goose) needed. A
  lower token count with a lower pass rate is not "leaner", which is why
  per-resolved-task is listed first.
- **Not in this run:** pi (no tb adapter), Claude Code and opencode. They need the
  Harbor/AgentLab route on an x86 host. Terminal-Bench 4.0's images are
  amd64-only and its tasks allow 8 h.

## Asymmetries known in advance, stated rather than removed

- Each arm runs with its own tb adapter's prompt framing. goose's recipe adds an
  "act autonomously" preamble; the others pass the task as written. This is what
  each harness looks like under Terminal-Bench, and it is part of the arm.
- Qwen Code does not use tb's shipped invocation, which pipes the task with no
  approval mode and can stall on a tool prompt. It uses the documented headless
  form with approval off, the same autonomy the other arms run with.
- gnomon's arm is its August benchmark configuration: a fresh `gnomon init`
  surface, every role on the bench endpoint, approval never, audit on. It is not
  tuned for this run.

## Apparatus checks (benchmark-discipline)

- [x] Versions pinned in each arm's setup and recorded per cell; the gnomon SHA
      is checked against the `v0.3.1` tag before the run and inside every
      container.
- [x] One variable per comparison (the harness); model, tasks, cap and host are
      shared.
- [x] Arms interleaved, not blocked; one GPU job at a time (`gpu.lock`);
      nothing else on `:18080`.
- [x] Task list non-empty (asserted); validity rule and analysis written before
      any trial.
- [ ] Smoke: every arm resolves or at least runs hello-world before the full run.
- [ ] After the run: wall-clock inspected for ~0 s or exactly 900 s, and versions
      read back per cell.

## Phase 2, registered separately before it runs

This run uses one local model. The user also holds an OpenCode license
(`OPENCODE_API_KEY` is in gnomon's credential store), which pays for OpenCode's
hosted models. That makes two further experiments possible, each with its own
pre-registration:
- **cloud model:** gnomon against opencode, on the same hosted model;
- **hybrid:** gnomon's `frontier_plan` profile (plan on a hosted model, implement
  locally) against all-local and all-hosted.

The hosted models need no GPU. So these belong on AgentLab on the hub, which has
both adapters already, and can run alongside this gx10 run without sharing its
Docker host or its model.

## Amendment before launch: the gnomon arm's surface patch

Found while building UX1, before any P1 trial ran. The August adapter (also used by
H7) rewrote `roles.toml` only, but `gnomon init` scaffolds `role_profile =
"local_first"`, which is merged over roles.toml field by field. `--role
implementor` is not in that profile, so the main loop always used the bench
endpoint; H7's audit trails confirm every turn reached `qwen3.6-35b` at the bench
URL. But plan, implement, critique and smol stayed on the scaffold's local
endpoint, and smol is the summary role. In single-turn task mode summary
compaction never runs: H7 recorded 0 dropped-context turns and no failed-summary
degradation, so neither H7 nor P1 is affected. The fix rewrites every
`.gnomon/profiles/*.toml` the same way. It was checked end to end against UX1's
fake model: all four profile endpoints move to `bench`, and the task answers
through it.

## Amendment before launch: version records on tasks without a log mount

Found in H7's readout, 2026-10-31 ~15:45Z, before any P1 trial. tb mounts the
agent-logs volume only where a task's `docker-compose.yaml` asks for it, and
`pandas-sql-query` (one of the 16) does not. Every arm writes its version to
`/agent-logs/arm-version.txt` (gnomon: `gnomon-commit.txt`). On that task the
file stays inside the container, and all 15 of its cells would have reached the
collector with no version. Every setup already creates `/agent-logs`, so the arms
install the same way on that task; only the record was lost.

The fix: every setup also prints `ARM_VERSION=<first line of that file>` on the
terminal. tb captures the terminal for every task, in `sessions/agent.log`. The
collector reads the file first and falls back to that line. A cell with neither
is still counted as having no version, and for gnomon as off-commit. The smoke run
checks that the line appears for every arm.

## Amendment before launch: what the 900 s cap is

Found in H7's wall-clock check, 2026-10-31 ~15:50Z, before any P1 trial. H7 passed
the same `--global-agent-timeout-sec 900`, yet its timed-out trials ended at
**1,200 s**. The reason is in tb 0.2.18 under Python 3.12:
- tb runs `perform_task` in an executor thread and gives up waiting at 900 s;
- `asyncio.run` then joins that thread for up to 300 s (`THREAD_JOIN_TIMEOUT`);
- a run that ends inside that window is scored on the state it leaves.
  H7's `mailman` ended at 1,059 s, carries tb's `agent_timeout`, and is resolved.

So the cap is **900 s, plus up to 300 s of grace in which a run that finishes
still counts.** Every arm blocks on its command the same way (stock adapters and
ours all pass `max_timeout_sec=inf`), so the cap is the same for all five. It is
left as it is. Changing it now would make P1 incomparable with H7 and the August
runs. The registered cap stays "900 s", with this footnote. "At the cap" is
counted as tb's `agent_timeout`, not as a duration. Cells still running at
1,200 s are counted separately, because their process may outlive the wait and
overlap the tests.

**Install time is spent from the cap.** tb runs each arm's setup inside the timed
`perform_task`, as on its leaderboard. The arms install different things, so
their working time differs by their setup time. Each setup now prints
`ARM_SETUP_END=<epoch>`, and the collector reports setup seconds per arm. This is
descriptive and is reported beside the pass rates. It is not corrected for.

## Amendment before launch: the mini-swe-agent arm pins litellm

Found by the smoke run, 2026-10-31 15:55Z, before any full-run trial. The mini
cell on hello-world crashed before its first model request:
`ModuleNotFoundError: No module named 'mcp'`.
- mini-swe-agent 2.4.6 (2026-07-23) accepts any `litellm >= 1.75.5`, so each
  container installs the newest, 1.106.6.
- From **1.106.0**, litellm's `completion()` imports its proxy's MCP handler
  whenever tools are passed. `mcp` is only a `proxy`/`mcp` extra, so the import
  fails.
- Bisected in a clean venv against UX1's fake model: 1.105.0 and 1.105.7 work;
  1.106.0, 1.106.5 and 1.106.6 crash.

The arm now installs `litellm==1.105.7`, the newest release without the bug,
and records it in `arm-version.txt`
(`mini-swe-agent 2.4.6 litellm 1.105.7`). mini's own code is unchanged. Without
the pin, every mini cell would have run the agent with no model call: a valid
tb verdict, "unresolved", for a harness that never ran. The failed smoke cell
is kept under `runs-smoke-failed/`, and the mini smoke is re-run before launch.

This also belongs in the result: as of 2026-10-31, a fresh
`pip install mini-swe-agent==2.4.6` cannot call a model with tools until
litellm fixes this or is pinned.

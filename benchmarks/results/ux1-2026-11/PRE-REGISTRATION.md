# Pre-registration — UX1, what a harness costs in daily dev

**Written 2026-10-31 ~16:05Z, before any measured run.** The only runs before
this one are two probes (`runs/probe1-failed-mini-*`, `runs/probe-*`). They
proved each arm works and found the three apparatus faults listed at the end.
They are not analysed.

## Question

Take the model's time out of the loop. What does each harness itself cost a
developer?
- the wait before its first model request;
- the wall clock for a one-turn task;
- the memory it holds;
- what it puts on the wire.

These are the harness's share of every interaction. A model's speed is shared by
every harness that uses it, and these costs are not.

## Design

| | |
|---|---|
| arms | **gnomon** as installed for daily dev (`gnomon/0.3.1+bc8f27a`; the `-dirty` is the user's uncommitted `.gnomon/` edits in `~/gnomon`, which the measured surface does not read). P1 pins v0.3.1 = `7012c5a`. The difference is PR #56's `[shadow]`, which is absent from a fresh `gnomon init` surface, so it is off<br>**opencode** V2 v2.2.5, **goose** 1.57.0, **Qwen Code** 0.26.4, **mini-swe-agent** 2.4.6 with litellm 1.105.7: the P1 versions, installed under `tools/` |
| invocation | each arm's headless form, as in P1:<br>- `gnomon task … --role implementor --yes`<br>- `opencode run --standalone --auto -m fake/fake-model …`<br>- `goose run -t …`<br>- `qwen -p … --approval-mode yolo`<br>- `mini -m openai/fake-model -t … -y --exit-immediately` |
| task | `Reply with OK.` One turn |
| model | `fake-model.mjs`, one fresh process per run, answering every request at once:<br>- `OK.` for four arms;<br>- a single `bash` tool call running `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` for mini, whose protocol ends a task only that way. mini therefore also spawns one shell, which is part of its arm |
| configuration | each arm's minimal config pointing at the fake. gnomon uses P1's own surface patch: every role on the bench endpoint, approval never, **audit on**. Its governance cost is inside the number |
| environment | built from nothing per run: a throwaway HOME and XDG dirs, `PATH` for node and git, `CI=1`, `NO_COLOR=1`. No key, config or cache of the user's is visible. Every run gets a new git project with one README |
| order | interleaved; the arm order rotates every round |
| timing | process start to exit (`time.time_ns`, blocking wait); the first request is timestamped by the fake on the same clock; peak RSS from `/usr/bin/time %M` (the largest process in the tree) |

**Two phases:**
- **warm** (daily dev): one HOME per arm. Two warm-up runs per arm settle
  first-use downloads, migrations and the page cache; they are recorded and not
  analysed. Then **n = 20** rounds.
- **first** (onboarding): a fresh HOME for every run, **n = 3** per arm. This
  includes whatever an arm fetches on first use (opencode installs its provider
  package from npm). It is descriptive only.

## Scoring, fixed in advance

- **Valid run:** exit code 0 and at least one chat request reached the fake.
  Anything else is reported per arm and kept out of the medians.
- **Primary endpoints, warm phase, per arm:** median and IQR of
  - CPU time, user + system over the whole process tree (ms);
  - wall clock (ms);
  - time to first request (ms);
  - peak RSS (MB).
- **Wire, per arm:** chat requests per run, total bytes sent, largest request,
  and the tools and tool-schema bytes in the largest request. These are
  deterministic per arm, so they are reported as values, with any variation
  across runs flagged.
- **Comparison:** gnomon against each peer, on CPU time, wall clock and time to
  first request: the difference of medians, with a 95% bootstrap interval (10,000
  resamples, seed 0).
  - A difference whose interval contains 0 is "cannot tell".
  - A difference under **50 ms** is reported as "no practical difference",
    whatever its interval. 50 ms is below what a person notices at a prompt,
    and it is fixed now.

## What this can and cannot say

- It measures the harness on one host, with one task and an instant model. A real
  model adds seconds per turn, and that is shared by every arm. These numbers are
  each harness's own share, not total latency.
- One turn says nothing about per-turn cost over a long session (context growth,
  compaction). That is P1's tokens-per-task endpoint, measured on the real model.
- **The host is shared, and it is busy.** gx10 is aarch64 with 20 cores. At
  16:00Z the 1-minute load was 27, from other sessions' work: headless Godot
  lanes, an `oracle ingest`, notebook kernels. P1's containers will add to it.
  None of that is this run's to stop.
  - Contention inflates wall clock and first-request time for every arm, and
    their spread. It barely moves CPU time, which is why CPU time is listed
    first.
  - The load is recorded per run and reported, and the interleaving spreads it
    across arms.
  - Planned replication: the warm phase is re-run when the 1-minute load is
    below 4. If its wall-clock verdicts differ, the quiet run is the reference.
- Interruptions, Ctrl-C recovery and a fresh clone's first run are named in the
  program (`docs/BENCHMARK-PROGRAM-2026-11.md`). They are not in this run; they
  need a scripted terminal and come next as UX1b.

## Apparatus faults found by the probes, fixed before this file

1. **mini-swe-agent could not call any model.** litellm ≥ 1.106.0 imports its
   proxy's MCP module on every `completion()` with tools, and `mcp` is a proxy
   extra. mini 2.4.6 accepts any litellm ≥ 1.75.5, so a fresh install crashes
   before its first request. P1's smoke hit the same crash in its mini cell. Both
   now pin litellm 1.105.7, the newest release without the bug. Bisected:
   1.105.0 and 1.105.7 work; 1.106.0, 1.106.5 and 1.106.6 crash.
2. **Wall times came back in 50 ms steps.** Python's `Popen.wait(timeout=…)`
   polls with a backoff capped at 50 ms. The runner now blocks on `wait()`,
   with a timer that kills at the 120 s cap.
3. **Only the first request was recorded.** opencode and goose send a small side
   request first (a title; goose also lists `/models`). Every request is now kept,
   and the largest is reported beside the total.

## Amendment after the first readout: gnomon has two forms, and only one was measured

Found 2026-10-31 ~16:40Z, after the first warm readout (`runs/warm-20261031T162845Z`).
The four peers were measured as their releases install them. gnomon was measured
as its **checkout** runs it: `gnomon.js`, which runs `src/` through `tsx` in a
second node process. gnomon's release form is different:
- `scripts/install.sh` installs the release tarballs;
- they run compiled `dist/` through `bin/gnomon.mjs` with plain node.

So the first readout compared gnomon's development build with the peers'
releases. That asymmetry runs against gnomon.

**The fix:** the warm phase is re-run with six arms:
- `gnomon-rel`, the v0.3.1 release tarballs, verified against the release's
  `SHA256SUMS`;
- `gnomon`, the checkout form, as before;
- the four peers.

Interleaved, n = 20, the same scoring. Both gnomon forms are reported, and
neither replaces the other:
- the release form is the like-for-like comparison with the peers;
- the checkout form is what a gnomon developer, and this user, runs daily.

The first readout stays in the record as measured.

Two facts found on the way, reported rather than fixed here:
- **v0.3.1 is still a draft release** (since 2026-10-21). GitHub's "latest" is
  v0.3.0, so `install.sh` installs v0.3.0 today, and `GNOMON_VERSION=0.3.1`
  gets a 404. The tarballs here came through an authenticated `gh release
  download`.
- **An installed copy reports the wrong build inside a git work tree.**
  `harnessBuild()` runs `git rev-parse` in the module's own directory. The
  release installed under this repository's `tools/` reported
  `gnomon/0.3.1+1afd251-dirty`, the commit of the repository around it. A
  project-local or CI `npm i` would stamp the project's commit into gnomon's
  audit records as the harness build.

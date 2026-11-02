# Pre-registration: UX1W, what a harness costs in daily dev, on Windows

**Written 2026-11-02 before any measured run.** Before this file there were only
apparatus runs: two probes, a session probe (n = 1), the negative control, and an
exploratory process trace. They proved the apparatus and are not analysed. Their
findings are listed at the end.

## Question

UX1 (`../ux1-2026-11/`) measured each harness's own cost on Linux (gx10, aarch64),
with the model's time removed. Do its findings hold on **native Windows**, the
platform where most developers run these tools?

On Linux, gnomon v0.3.1 was fastest of five on every timing, with 4.3× less
context than opencode V2. UX1b found gnomon re-sends the least base context over
a 10-turn session.

## Host

The hub, `EljasRD`:
- Windows 11 Pro 10.0.26200;
- AMD Ryzen 9 9950X3D (16 cores, 32 threads), 62 GB RAM;
- Node v24.21.0, Git for Windows 2.55.0;
- power plan Balanced; Defender real-time scanning **on**, as most developers run it.

It is the user's daily machine. Nobody is using it during the run, but the usual
background services keep running (OneDrive, Defender, the search indexer). The
background CPU share is recorded before every run, together with the share during it.

## Arms

All arms are installed under `C:\dev\ux1w\tools`. Nothing is installed globally,
and every download is checked against its publisher's SHA-256 (`setup-record.json`).

| arm | what | how it runs |
|---|---|---|
| **gnomon-rel** | v0.3.3, by the official `install.ps1` (pinned to the tag) into an isolated npm prefix and data dirs. It reports `gnomon/0.3.3+v0.3.3-c2e62a9` | `node <prefix>\node_modules\gnomon-harness\bin\gnomon.mjs task … --role implementor --yes` |
| **gnomon-master** | master `891b559`, packed on the gx10 exactly as the release job packs, checksum-verified and installed the same way. It reports `gnomon/0.3.3+master-891b559` | same |
| **opencode** | V2 2.2.5, `opencode-windows-x64.zip` (sha256 `2f3bfd6b…`) | `opencode.exe run --standalone --auto -m fake/fake-model …` |
| **goose** | 1.57.0 CLI, `goose-x86_64-pc-windows-msvc.zip` (sha256 `1ab2117c…`) | `goose.exe run -t …` |
| **qwen** | Qwen Code 0.26.4 from npm, own prefix | `node <prefix>\…\cli-entry.js -p … --approval-mode yolo` (its npm bin) |
| **mini** | mini-swe-agent 2.4.6 with litellm 1.105.7 (as on Linux), in a venv on Python 3.12.10 (Linux used 3.12.3) | `Scripts\mini.exe -m openai/fake-model -t … -y --exit-immediately`, **in a hidden console**: see below |

Every peer in UX1 has a native Windows build, so no arm is skipped. WSL is not
used.

The npm-based arms (gnomon, qwen) run `node <bin>` directly. That is what their
npm `.cmd`/`.ps1` shims run, and what Linux UX1 ran through the bin's `#!` line.

## Design: UX1's, with these Windows changes only

1. **CPU and memory come from a Windows job object.** The child starts suspended,
   joins a fresh job, then resumes, so the whole process tree is in the job.
   - **CPU ms** is the job's user + kernel time.
   - **Memory** is the job's peak *committed* memory of its largest process.
     Linux UX1 reported peak RSS (`/usr/bin/time %M`), a different measure, so
     memory is compared **within Windows only**.
   - The job also counts the **processes** each run starts, a Windows-relevant cost.
2. **Load:** Windows has no load average. Each run records the machine's CPU
   busy share in the 250 ms before it starts, and during the run.
3. **The environment is built from nothing,** as on Linux:
   - a throwaway home with its own APPDATA, LOCALAPPDATA, TEMP and XDG dirs;
   - the machine's PATH minus the user's global npm and Python script dirs;
   - `CI=1`, `NO_COLOR=1`.
4. **Workspace trust:** since 0.3.3, gnomon's trust gate would clamp the patched
   bench surface (approval never), which is looser than the scaffold. Each gnomon
   run's untimed setup runs `gnomon trust grant` in its project, the state of a
   developer who has trusted their own project. Trust evaluation still runs inside
   the timed turn.
5. **mini runs in a hidden console of its own,** with its output left there
   (not captured). mini-swe-agent 2.4.6 cannot start on Windows without a console:
   when it is imported, its prompt_toolkit session opens a Win32 console output,
   which raises `NoConsoleScreenBufferError` when stdout is a file (probe 1). Every
   other arm runs with redirected output, as on Linux.
6. **The UX1b session command** is `node notes/show.js <i>`, a runner-written
   script that prints note i byte for byte. On Linux it was `cat notes/chunk_<i>.txt`.
   - The harnesses' shells differ on Windows (gnomon: Git bash; others: cmd.exe or
     PowerShell), and this command contains no quotes, spaces or shell syntax, so
     it runs the same in all of them.
   - It costs a node start per turn, the same for every arm. A **calibration**
     phase (n = 20) measures it alone, so turn gaps can also be read net of it.

Everything else is UX1's own:
- the fake model, extended only by the configurable turn command;
- the prompt, "Reply with OK.";
- each arm's minimal configuration;
- gnomon's P1 surface patch;
- interleaving with the arm order rotating every round;
- a blocking wait with a 120 s cap.

## Phases, in this order

1. **warm:** one home per arm, 2 warm-up runs per arm (recorded, not analysed), then **n = 20** rounds.
2. **session (UX1b):** the scripted 10-turn session, 2 warm-ups, **n = 10** per arm.
3. **first:** a fresh home for every run, **n = 3** per arm, descriptive only.
4. **calib:** the turn command alone, **n = 20**.

## Scoring, fixed in advance (UX1's)

- **Valid run:** exit code 0 and at least one chat request reached the fake. For a
  session, also all 10 tool turns completed. Everything else is reported per arm
  and kept out of the medians.
- **Primary endpoints, warm, per arm:** median and IQR of
  - CPU ms (listed first: it is robust to contention);
  - wall ms;
  - time to first request;
  - peak committed memory of the largest process;
  - processes started.
- **Wire:** chat requests, bytes sent, the largest request, tools and tool-schema
  bytes. These are deterministic per arm, and any variation is flagged.
- **Comparison:** gnomon-rel against each peer, and gnomon-master against each
  peer and against gnomon-rel.
  - The measure is the difference of medians, with a 95% bootstrap interval
    (10,000 resamples, seed 0).
  - An interval containing 0 reads "cannot tell".
  - |d| < 50 ms reads "no practical difference".
- **UX1b, per arm:**
  - bytes of the first and the last main request;
  - per-turn growth;
  - total bytes sent;
  - the harness's time per turn (our response's last byte to its next request),
    both raw and net of the calibrated command;
  - wall, CPU and memory.
- **Windows vs Linux:** reported side by side per arm. This is descriptive: a
  different machine, CPU architecture and OS, and gnomon 0.3.3/master here
  against 0.3.1 on Linux.

## Negative control (run before this file was written)

Every arm was pointed at a closed port (19709) with the fake still listening on
19700. All six must come back invalid (no chat request), never as fast valid
runs. Result: see "Apparatus findings" below.

## What this cannot say

- One host, one task, an instant model. These numbers are each harness's own
  share, not total latency.
- Defender real-time scanning is on. It inflates the first run of new
  executables, which the warm-ups absorb, and process creation for every arm.
  That is the platform as people use it, and is not removed.
- Memory is not comparable with Linux UX1 (commit here, RSS there).

## Apparatus findings so far (probes, before this file)

1. **mini-swe-agent 2.4.6 can't start on Windows without a console** when its
   output is redirected. That is change 5; it is a real limitation for anyone
   running it in CI on Windows.
2. **The session probe (n = 1):** every arm completed all 10 turns through its own
   shell with the node turn command.
3. **gnomon starts about 22 processes** per one-turn task on Windows (job count).
   An exploratory trace (`apparatus/trace_gnomon.py`, not part of the measurement)
   attributes them to **10 synchronous `git` calls**.
   - Each takes ~18 ms on Windows, and the cmd shim plus mingw git make two
     processes per call.
   - They are the tree-delta snapshot gnomon takes before and after every turn
     (`treeSnapshot`/`measureTreeDelta` in `prompt_loop.ts`).
   - In this git repository with no commits yet, four of the ten fail by design
     (`HEAD` does not exist) and fall back.

   The result reports how much of gnomon's Windows wall clock this explains.
4. **Negative control:** gnomon exits 10 (apparatus_failure) after ~3.9 s;
   opencode, goose and Qwen Code exit 1 after their own retries (19–97 s); mini
   retries until the 120 s cap. All six are invalid (0 chat requests). None counted
   as valid, so a broken arm cannot pass for a fast one.

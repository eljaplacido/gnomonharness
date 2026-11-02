# UX1W: what a harness costs in daily dev, on Windows (2026-11-02)

Design and scoring: `PRE-REGISTRATION.md`, committed in `246e143e` before any
measured run.
- **Host:** the hub. Windows 11 Pro 26200, Ryzen 9 9950X3D, Node 24.21, Git for
  Windows 2.55, Defender real-time on. Background CPU before each run: median
  15%, max 35%.
- **Model:** a fake that answers at once. What is left of the clock is each
  harness's own cost.
- **Runs:** every phase ran, and every measured run was valid: warm 120/120,
  session 60/60, first 18/18, calibration 20/20.

## Result

**gnomon is the fastest harness on Windows too, on CPU and wall clock, against
every peer, and it holds the least memory.** Its one-turn time on Windows is
about twice its Linux time, and half of that is git. An exploratory follow-up
traces about 160 ms of every Windows turn to ten synchronous `git` calls.

### One turn, warm (n = 20 per arm, interleaved; medians [IQR])

| arm | CPU ms | wall ms | first request ms | peak commit MB | processes | bytes sent | tools |
|---|---|---|---|---|---|---|---|
| **gnomon 0.3.3** | **281** [250–316] | **340** [323–356] | 215 [207–226] | **40** | 22 | 8,811 | 9 |
| gnomon master `891b559` | 297 [266–328] | 343 [320–365] | 216 [202–219] | 40 | 22 | 8,811 | 9 |
| goose 1.57.0 | 445 [418–457] | 423 [397–458] | **187** [182–201] | 91 | 2 | 28,818 | 17 |
| opencode V2 2.2.5 | 1,820 [1,711–1,992] | 1,206 [1,138–1,244] | 812 [780–847] | 510 | 61 | 24,935 | 12 |
| Qwen Code 0.26.4 | 1,953 [1,809–2,023] | 1,684 [1,621–1,777] | 1,550 [1,495–1,636] | 325 | 17 | 93,761 | 10 |
| mini-swe-agent 2.4.6 | 3,539 [3,430–3,719] | 4,384 [4,212–4,526] | 3,686 [3,555–3,835] | 199 | 5 | **3,313** | 1 |

gnomon 0.3.3 against each peer (difference of medians, 95% bootstrap; under 50 ms
counts as no practical difference):

| vs | CPU | wall | first request |
|---|---|---|---|
| goose | −164 [−203, −125] **faster** | −83 [−108, −58] **faster** | +28 [+12, +35] no practical difference: goose's first request is ~28 ms earlier |
| opencode V2 | −1,539 [−1,703, −1,438] **faster** | −866 [−897, −801] **faster** | −597 [−623, −567] **faster** |
| Qwen Code | −1,672 [−1,734, −1,555] **faster** | −1,344 [−1,429, −1,284] **faster** | −1,335 [−1,417, −1,286] **faster** |
| mini-swe-agent | −3,258 [−3,414, −3,188] **faster** | −4,044 [−4,180, −3,895] **faster** | −3,470 [−3,616, −3,359] **faster** |

- **master against 0.3.3:** no practical difference on any timing: CPU +16 ms
  [−23, +62], wall +3, first request 0. #86's startup fix, measured on Linux, is
  invisible here, under the git cost below.
- **On the wire:** gnomon sends 8,811 B in one request.
  - That is 2.8× less than opencode V2, 3.3× less than goose and 10.6× less than Qwen Code.
  - mini sends less, 3,313 B, with its single `bash` tool: a different design, as on Linux.

### UX1b: a scripted 10-turn session (n = 10 per arm)

Each arm runs its own shell tool through 10 turns of `node notes/show.js <i>`.
That command alone takes a median 36 ms (calibration, n = 20); the "net" column
subtracts it.

| arm | 1st request KB | growth per turn KB | total KB | time per turn ms (raw / net) | wall ms | CPU ms | peak commit MB | processes |
|---|---|---|---|---|---|---|---|---|
| **gnomon 0.3.3** | 8.7 | 2.26 | 220 | 62 / 27 | **1,059** | **836** | **63** | 52 |
| gnomon master | 8.7 | 2.26 | 220 | 63 / 27 | 1,065 | 859 | 64 | 52 |
| goose | 26.3 | 2.24 | 415 | 145 / 109 | 1,971 | 1,844 | 91 | 32 |
| opencode V2 | 22.4 | 2.25 | 372 | 238 / 202 | 3,676 | 5,375 | 539 | 211 |
| Qwen Code | 66.6 | 2.73 | 935 | 89 / 53 | 2,613 | 4,742 | 2,008 | 117 |
| mini-swe-agent | 3.3 | 2.35 | 166 | 54 / **18** | 4,723 | 3,836 | 200 | 25 |

- **gnomon's session is the fastest:**
  - wall clock: −912 ms vs goose, −1,555 vs Qwen Code, −2,618 vs opencode, −3,665 vs mini;
  - CPU: −1,008 vs goose, −3,906 vs Qwen Code, −4,539 vs opencode, −3,000 vs mini.
- **Every arm grows about 2.25 KB per turn,** the tool result itself.
- **Base context:** gnomon re-sends the least of any arm with a full tool set.
- **Time per turn:** mini's net 18 ms is lower than gnomon's 27. gnomon's is a
  fifth of goose's and an eighth of opencode's.
- **Qwen Code** reached 2 GB of committed memory in its session.

### First run in a fresh home (onboarding, n = 3, descriptive)

| arm | wall ms |
|---|---|
| goose | 291, 295, 297 |
| gnomon master | 313, 314, 315 |
| gnomon 0.3.3 | 316, 319, 319 |
| opencode V2 | 1,400, 1,411, 1,445 |
| Qwen Code | 2,053, 2,070, 2,126 |
| mini-swe-agent | 3,939, 3,998, 3,998 |

## Windows against Linux UX1

Descriptive only. The hosts differ (gx10 aarch64 at load ~8.5 vs. an idle Ryzen),
and so do the gnomon builds (0.3.1 on Linux, 0.3.3 here). Memory is not
comparable: commit here, RSS there.

| arm | Linux wall / 1st req / CPU ms | Windows wall / 1st req / CPU ms | Linux bytes | Windows bytes |
|---|---|---|---|---|
| gnomon (release) | 151 / 115 / 160 | 340 / 215 / 281 | 8,361 | 8,811 |
| goose | 413 / 230 / 440 | 423 / 187 / 445 | 19,401 | 28,818 |
| opencode V2 | 1,089 / 872 / 2,710 | 1,206 / 812 / 1,820 | 36,065 | 24,935 |
| Qwen Code | 996 / 790 / 1,630 | 1,684 / 1,550 / 1,953 | 94,928 | 93,761 |
| mini-swe-agent | 3,296 / 2,036 / 3,260 | 4,384 / 3,686 / 3,539 | 3,378 | 3,313 |

- **The ranking holds.** gnomon is fastest on wall clock and CPU on both systems.
- **The first request against goose:**
  - On Linux, gnomon's came first (−115 ms).
  - On Windows, goose's comes ~28 ms earlier, which is under the 50 ms threshold.
- **gnomon's Windows turn costs ~190 ms more wall clock than its Linux one.**
  - goose's barely moved (+10 ms), and opencode's grew +117 ms.
  - Qwen Code's (+688) and mini's (+1,088) grew more.
  - The next section finds gnomon's cause.
- **The wire is not identical across platforms.**
  - goose sends 49% more on Windows than on Linux, and opencode 31% less: their
    system prompts and tool sets differ by platform.
  - gnomon's request grew 450 B from 0.3.1 to 0.3.3.
  - Against opencode V2 that makes gnomon's advantage **2.8× less on Windows** and
    4.3× on Linux. The published "4.3×" is the Linux figure.

## Exploratory, not pre-registered: where gnomon's Windows time goes

**1. Trace** (`apparatus/trace_gnomon.py`; one run each; `runs/trace/`). A preload
logged every child process that gnomon started during one turn:
- **10 synchronous `git` calls**, 178 ms in total, about 18 ms each;
- all from the tree-delta snapshot it takes before and after every turn
  (`treeSnapshot` and `measureTreeDelta` in `prompt_loop.ts`): `diff --numstat
  [HEAD]`, `ls-files --others`, `rev-parse HEAD`, and `diff --numstat
  --ignore-cr-at-eol [HEAD]`;
- 4 of the 10 fail by design in this repository, which has no commit yet: there
  is no `HEAD`, so each falls back to a second call;
- each call is two processes (Git for Windows' `cmd\git.exe` launches the real
  one), which explains the job count of 22.

**2. With and without git** (`apparatus/explore_nogit.py`, n = 20 each,
interleaved, run after the measured phases). The same gnomon 0.3.3, with git's
directories removed from PATH so that every `git` spawn fails at once:

| | wall ms | first request ms | CPU ms | processes |
|---|---|---|---|---|
| as installed | 319 | 201 | 273 | 22 |
| git unavailable | **156** | **133** | **141** | 2 |

- **The difference is 163 ms of wall clock [156, 171]** for the same request,
  byte for byte. Only the record changes: the turn's tree delta reads "not a git
  worktree".
- **Without its git calls, gnomon's Windows turn (156 ms) matches its Linux turn
  (151 ms).** Process creation is expensive on Windows; on Linux the same calls
  cost a few ms each.

**A candidate fix, for a separate pre-registered A/B (not done here):**
- check once whether `HEAD` exists, instead of failing and retrying;
- take one `git status --porcelain=v2 -z --untracked-files=all` snapshot instead of
  `diff` plus `ls-files`;
- skip the after-turn delta when the turn ran no tool that can change files;
- optionally, call Git for Windows' `mingw64\bin\git.exe` directly, which halves
  the process count.

The likely ceiling is about 160 ms per task on Windows, and it would bring gnomon's
Windows first request ahead of goose's.

## Findings about the peers on Windows

- **mini-swe-agent 2.4.6 cannot start on Windows without a console** when its
  output is redirected, as in CI. prompt_toolkit opens a Win32 console output
  when mini is imported (`NoConsoleScreenBufferError`). It was measured in a
  hidden console of its own.
- **Qwen Code's 10-turn session peaks at 2 GB of committed memory.**
- **opencode starts 61 processes for one turn and 211 for the session.**

## Files

- `PRE-REGISTRATION.md`, `setup-record.json`: arm versions and checksums, and the host.
- `apparatus/`:
  - the measurement: `run_ux1w.py`, `fake-model.mjs` (UX1's, with a configurable
    turn command), `collect_ux1w.py`, `setup_hub.ps1`, `run_all.ps1`;
  - exploratory: `trace-spawn.cjs`, `trace_gnomon.py`, `explore_nogit.py`.
- `runs/`:
  - the measured phases: `warm-*`, `session-*`, `first-*`, `calib-*`, each a
    `ux1-runs.jsonl` with per-run records;
  - `ux1w-summary.json`;
  - `explore-nogit-*` and `trace/` (exploratory).
- `runs-apparatus/`: the probes and the negative control. All six arms were
  invalid against a closed port; none passed for fast.
- On the hub, the isolated installs and the full run directories remain in
  `C:\dev\ux1w` (tools under `tools\`). Nothing was installed globally. Delete the
  folder to remove all of it.

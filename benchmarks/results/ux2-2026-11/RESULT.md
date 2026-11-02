# UX2 result: daily-dev overhead on gnomon master (2026-11-02)

Design: `PRE-REGISTRATION.md`, final at `bc4dda74` before any measured run.

**Builds:**
- **master** `d59e6c19`: packed with `pnpm pack` as the release job packs; includes #80, #86, #90, #91.
- **v0.3.3** `c2e62a98`: the official installer, checksums verified.
- **Peers:** UX1's pins.

Model-free (a fake model that answers at once), no API cost. Every measured run was
valid, and the buckets sum to n (`runs/*/summary.json`).

**Read this first: load.**
- Every Linux phase ran with the 1-minute load at **14–29 on 20 cores**: other projects' Godot jobs plus P1, P2G and the GPU chain. Under the pre-registered rule every Linux run is flagged.
- All Linux comparisons below are therefore **paired within interleaved rounds**, and the absolute times are not idle-machine figures.
- A re-run in a quiet window is armed (`apparatus/rerun_quiet.sh`). It waits up to 6 h for 5 minutes with load < 10, then repeats warm, session and UX1c into new `runs/` folders and `rerun-quiet.log`. Both readings get reported.
- **Windows** (the hub) was idle: background CPU 0–17%.

## Linux, one turn, warm HOME (n = 20 rounds, load 14–21)

| arm | CPU ms | wall ms | first request ms | peak RSS MB | bytes sent |
|---|---|---|---|---|---|
| **gnomon master** | **185** | **178** | **145** | **70** | 8,688 |
| gnomon 0.3.3 | 230 | 233 | 177 | 71 | 8,361 |
| goose 1.57.0 | 620 | 601 | 346 | 138 | 19,401 |
| Qwen Code 0.26.4 | 2,275 | 1,421 | 1,101 | 242 | 94,922 |
| opencode V2 2.2.5 | 3,605 | 1,598 | 1,283 | 426 | 36,065 |
| mini-swe-agent 2.4.6 | 4,075 | 4,151 | 2,662 | 211 | **3,378** |

Paired, master minus each arm (median of per-round differences, 95% bootstrap interval):

| vs | CPU | wall | first request |
|---|---|---|---|
| gnomon 0.3.3 | **−70** [−75, −20], 18/20 lower | −65 [−81, −26], 17/20 | −43 [−51, −8], 17/20 |
| goose | −410 [−455, −370], 20/20 | −400 [−431, −338], 20/20 | −205 [−231, −144], 20/20 |
| Qwen Code | −2,080 [−2,220, −1,980], 20/20 | −1,240 [−1,345, −1,151], 20/20 | −942 [−1,035, −861], 20/20 |
| opencode V2 | −3,410 [−3,555, −2,945], 20/20 | −1,422 [−1,537, −1,184], 20/20 | −1,143 [−1,245, −953], 20/20 |
| mini-swe-agent | −3,895 [−4,180, −3,800], 20/20 | −3,997 [−4,312, −3,840], 20/20 | −2,507 [−2,656, −2,369], 20/20 |

## Linux, one turn, fresh HOME ("first", n = 20, load 15–29)

| arm | CPU ms | wall ms | first request ms |
|---|---|---|---|
| **gnomon master** | **170** | **170** | 140 |
| gnomon 0.3.3 | 225 | 227 | 177 |
| goose | 505 | 396 | **118** |
| Qwen Code | 2,065 | 1,257 | 963 |
| opencode V2 | 3,505 | 1,621 | 1,129 |
| mini-swe-agent | 4,220 | 4,401 | 2,762 |

- **master against 0.3.3:** CPU −35 [−60, −20], 18/20 lower.
- **master against each peer:** faster on CPU and wall in 20/20 rounds.
- **The one exception: goose's first request on a fresh HOME** is level with master's. The difference is +17 ms [−13, +30], with master earlier in only 7/20 rounds: no practical difference.

## Linux, 10-turn scripted session (UX1b, n = 20, load 15–22)

| arm | CPU ms | wall ms | harness ms per turn | base context KB | growth KB/turn | total bytes |
|---|---|---|---|---|---|---|
| **gnomon master** | **320** | **240** | **9** | 8.6 | 2.26 | 223,784 |
| gnomon 0.3.3 | 345 | 263 | 8 | 8.2 | 2.26 | 220,187 |
| goose | 470 | 622 | 25 | 17.2 | 2.24 | 321,619 |
| mini-swe-agent | 2,395 | 2,499 | 11 | **3.4** | 2.35 | **170,544** |
| opencode V2 | 3,055 | 1,325 | 36 | 33.2 | 2.25 | 503,069 |
| Qwen Code | 2,875 | 1,744 | 62 | 67.4 | 2.41 | 946,011 |

**Paired, master minus:**
- 0.3.3: CPU −40 [−50, −35], 18/20 lower;
- goose: CPU −150 [−175, −110], wall −319 [−426, −210];
- each of the others: faster in 19–20 of 20 rounds.

## UX1c: per-turn cost against repository size (sessions, n = 6 per cell)

Harness time per turn, median of all turn gaps. On Windows each turn also runs
`node notes/show.js`, which alone takes ~36 ms (UX1W's calibration), so the
Windows column is gross.

| files | Linux 0.3.3 | Linux master | Windows 0.3.3 | Windows master |
|---|---|---|---|---|
| 1,000 | 23 | 28 | 82 | 82 |
| 5,000 | 47 | 39 | 126 | 125 |
| 20,000 | 80 | 78 | 136 | 138 |
| 50,000 | 121 | 127 | 160 | 157 |

**Per turn, master is the same as 0.3.3 on both platforms.** The paired difference
contains 0 at every size, e.g. Linux 50k −2.0 ms [−13, +12.5], Windows 50k +0.2 [−16, +7.5].
Per-turn cost still grows with repository size, about 2 ms per 1,000 files on
Linux, because each shell command re-stamps the work tree through git (#66).

**Where master's gain on Windows lands** (paired per round, master − 0.3.3, n = 6):

| files | session wall | first request | session CPU |
|---|---|---|---|
| 1,000 | −85 [−134, −70], 6/6 lower | −38 [−44, −31], 6/6 | +39 [−86, +219] |
| 5,000 | −86 [−101, −25], 6/6 | −37 [−45, −34], 6/6 | −180 [−336, +148] |
| 20,000 | −106 [−126, +978], 4/6 | −39 [−45, +939], 5/6 | −414 [−992, +453] |
| 50,000 | −163 [−307, −91], 6/6 | −61 [−74, −51], 6/6 | −539 [−1,430, +414] |

#90 trims the before- and after-turn snapshot, which happens once per user
turn, so it shows up in time to first request and session wall, not in the
per-command gap. On Linux, where git is cheap, master's session gains are
smaller and mostly inside noise (50k: CPU −80 [−150, −25], 6/6 lower).

## Change detection (UX1c's probe, 20 single-file edits across the tree)

| | 30,000 files | 50,000 files |
|---|---|---|
| Linux, master | 20/20 seen | 20/20 |
| Linux, 0.3.3 | 20/20 | 20/20 |
| Windows, master | 20/20 | 20/20 |
| Windows, 0.3.3 | 20/20 | 20/20 |

v0.3.1 saw 13/20 at 30,000 files (UX1c). Nothing is missed on either platform now.

## Exploratory: a stale git index (not a UX1c figure)

A copied repository has a stale index stat cache. `git --no-optional-locks status`,
which master uses since #90, re-hashes the tree on every call and never writes the
refresh back: at 30k files that is 0.21–0.24 s per call against 0.05 s refreshed.

In sessions on unrefreshed copies (n = 4, load 31–34, `runs/explore-stale-*`), per-turn
cost was 123–246 ms against 78–127 ms refreshed, **for both builds**:

| | master | 0.3.3 |
|---|---|---|
| 20k files | 123 ms | 147 ms |
| 50k files | 246 ms | 197 ms |

That isn't readable at this load and n. A stale index is uncommon in daily
work, since git refreshes it on most commands that write it, but it is a cost
#90 does nothing to repair. The fix, if the effect holds up, is one index
refresh before the first snapshot.

## Against the published figures (descriptive: other loads, other builds)

| figure | published | now | note |
|---|---|---|---|
| Linux one turn, gnomon | 151 ms wall / 160 ms CPU (UX1, v0.3.1, quieter machine) | 178 / 185 (master, load 14–21) | Absolutes not comparable under this load. Master is 65 ms faster than 0.3.3 in the same rounds, and the ranking (fastest of 5) is unchanged. |
| gnomon vs goose, CPU | −280 ms (UX1) | −410 ms (master) | |
| context vs opencode V2, Linux | 4.3× (36,065 / 8,361) | **4.15×** (36,065 / 8,688) | #80's longer verification rule added 327 B per request |
| context vs opencode V2, Windows | 2.8× (UX1W) | not re-measured | |
| gnomon per tool turn, Linux | 49 ms (UX1b, v0.3.1) → 9 ms (#61) | **9 ms** (master) | #61's fix holds; mini 11, goose 25, opencode 36, Qwen Code 62 |
| per-turn cost at 20k files | 260 ms (UX1c, v0.3.1) | **78–80 ms** | −70%, from #61 + #66 |
| per-turn cost at 50k files | 256 ms (UX1c), "422 → 144 ms" (PR #66's own figure) | **121–127 ms** Linux, ~157 ms gross Windows | still grows with size |
| change detection at 30k | 13/20 (v0.3.1) | **20/20**, Linux and Windows, both builds | |
| Windows one turn | 340 ms wall (UX1W, 0.3.3); 209 ms with #90 (PR #90's A/B) | not re-measured in one-turn mode here | UX1c sessions show master's first request 37–61 ms earlier than 0.3.3's at every size |

## Published figures to update (website and whitepaper)

1. **"151 ms per turn, fastest of five":** keep "fastest of five" (it holds in every pairing). Re-state the absolute from the quiet-window re-run when it lands; until then, quote 151 ms as v0.3.1 on a quieter machine.
2. **"4.3× less context than opencode":** on master it's 4.15× on Linux (2.8× on Windows, UX1W). State it per platform, and as "about 4×" on Linux.
3. **"9 ms per tool call":** confirmed on master.
4. **Large repositories:** replace "422 → 144 ms at 50k" with this run's 121–127 ms per turn at 50k on Linux, and say plainly that the cost grows with repository size (23 ms at 1k → ~125 ms at 50k).
5. **Change detection:** add "20/20 at 30k and 50k files, Linux and Windows" (was 13/20 at 30k on v0.3.1).
6. **Windows:** UX1W's one-turn figures are 0.3.3. Master improves the Windows first request by 37–61 ms and a 10-turn session by 85–163 ms, mostly through #90.

## What this cannot show

- Overhead only; nothing about tasks solved or real-model tokens.
- Linux absolutes are under load, pending the quiet-window re-run.
- Windows UX1c only (n = 6 per cell). The Windows one-turn and session phases weren't repeated here.
- Peer versions are the October pins.

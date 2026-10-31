# UX1: what a harness costs in daily dev (2026-10-31)

Design and scoring: `PRE-REGISTRATION.md`, written before the measured runs.
Data: `runs/warm-20261031T162845Z/` (readout in `readout.txt`, summary in
`ux1-summary.json`) and `runs/first-20261031T163035Z/`.

One turn, `Reply with OK.`, against a fake model that answers at once. What is
left of the wall clock is the harness. Versions:
- gnomon `0.3.1+bc8f27a`;
- opencode v2.2.5;
- goose 1.57.0;
- Qwen Code 0.26.4;
- mini-swe-agent 2.4.6 with litellm 1.105.7.

## Warm runs (daily dev)

n = 20 per arm, interleaved; 120 of 120 runs valid. Medians, with IQR in
brackets.

| arm | wall ms | first request ms | CPU ms | peak RSS MB | requests | bytes sent | largest request | tools | tool-schema bytes |
|---|---|---|---|---|---|---|---|---|---|
| **gnomon** | **311** [295–367] | 270 [253–314] | 400 [370–452] | **103** | 1 | 8,361 | 8,361 | 9 | 4,438 |
| goose | 307 [271–336] | **178** [159–195] | **305** [290–340] | 138 | 2 | 19,401 | 17,479 | 17 | 12,685 |
| opencode V2 | 768 [733–841] | 596 [584–665] | 2,050 [1,988–2,262] | 435 | 2 | 36,065 | 33,940 | 12 | 13,600 |
| Qwen Code | 746 [707–803] | 596 [567–636] | 1,275 [1,218–1,345] | 226 | 2 | 94,928 | 68,597 | 10 | 19,872 |
| mini-swe-agent | 2,124 [2,020–2,200] | 1,554 [1,460–1,599] | 2,090 [1,982–2,162] | 211 | 1 | **3,378** | 3,378 | 1 | 228 |

### gnomon against each peer

Each figure is the difference of medians, with a 95% bootstrap interval. A
difference under 50 ms counts as no practical difference.

| vs | CPU | wall | first request |
|---|---|---|---|
| opencode V2 | −1,650 ms [−1,860, −1,580] **gnomon faster** | −457 [−515, −396] **faster** | −326 [−392, −289] **faster** |
| Qwen Code | −875 [−945, −795] **faster** | −435 [−482, −373] **faster** | −325 [−357, −280] **faster** |
| mini-swe-agent | −1,690 [−1,750, −1,575] **faster** | −1,813 [−1,869, −1,704] **faster** | −1,284 [−1,328, −1,206] **faster** |
| goose | +95 [+55, +140] **gnomon slower** | +5 [−14, +60] no practical difference | +92 [+73, +131] **gnomon slower** |

### On the wire

- gnomon sends the least context of any arm that ships a real tool set.
- Against opencode V2 it sends **4.3× less** (8,361 B vs 36,065 B). The
  published figure, 4.66× against opencode 1.x (7,824 B vs 36,490 B), is
  replaced by this one: gnomon's request grew 537 B since, and opencode's
  shrank.
- Against goose it sends 2.3× less, and against Qwen Code 11.4× less.
- mini-swe-agent sends less still (3,378 B). It ships one tool, `bash`, so its
  task work runs through the shell. That is a different design, not a leaner
  version of the same one.

### First run in a fresh HOME (onboarding, n = 3, descriptive)

| arm | wall ms |
|---|---|
| gnomon | 394, 404, 448 |
| goose | 302, 321, 386 |
| opencode V2 | 1,080, 1,145, 1,184 |
| Qwen Code | 802, 970, 1,037 |
| mini-swe-agent | 2,322, 2,931, 3,316 |

## Caveats

- **The host was not quiet.** The 1-minute load had a median of 6.4 and a max
  of 13.2 (other sessions' jobs), above the 4 the pre-registration names. CPU
  time is the contention-robust column. The quiet-host replication is still
  owed, and if its wall-clock verdicts differ, it becomes the reference.
- One turn and an instant model. A real model adds seconds to every turn, and
  every harness shares that. These numbers are the harness's own share.

## Where gnomon's time goes, and what removing it is worth (exploratory)

**Not pre-registered. A prototype, labelled as such.** Data and driver are in
`exploratory-bundle-2026-10-31/`.

`gnomon.js`, the launcher, runs the TypeScript sources through `tsx`, in a
second node process. Its own header names this "the single largest piece of
gnomon's own overhead" (~200 ms of transpilation per invocation). It was left
in place because running compiled output means changing the workspace's
`exports`.

The prototype bundles the same sources (`bc8f27a`) with esbuild into one ESM
file (`build.txt`) and runs it with node directly. It ran in a scratch layout
with the same relative depth, so gnomon's native binaries resolve as they
would in a real install.

**It is the same gnomon:** the same output, the same surface hash
(`a0677f770ee1`), the same 8,361-byte request. The native binaries were found;
a miss fails loudly with "native binary not found".

**Measured with UX1's runner and fake model, n = 20 each, interleaved, same
host and load (median 15.5):**

| | wall | first request | CPU | peak RSS |
|---|---|---|---|---|
| gnomon via `tsx` | 484 ms | 409 ms | 600 ms | 103 MB |
| gnomon bundled | **177 ms** | **122 ms** | **180 ms** | **67 MB** |

That is about 2.7× faster to finish, 3.3× less CPU and 35% less memory, for
the same behaviour. A bare `gnomon --version` goes from ~410 ms to ~90 ms.

Even at 2.4× goose's load, the bundled gnomon is under goose's UX1 numbers on
every timing (307 / 178 / 305 ms, 138 MB). A claim needs the same-load
comparison: UX1 re-run with the bundled build as an arm. If shipped, that is
the run that would show it.

**What shipping it needs, beyond the prototype:**
- **A freshness check.** A developer who edits `src/` must never run a stale
  bundle: that would be changed behaviour with nothing to show it.
- **The build-info lookup.** The prototype reports `0.0.0+unknown`.
- **The `update` self-path.**
- **Tests that run the bundle,** not only the sources.

## Constitution

Measurement only, and no gnomon code changed. The bundle is a packaging
change: it runs the same code, the request bytes are identical, and no
surface, bucket or enumeration is involved. "If behaviour changed, the hash
changed" is not engaged, because behaviour did not change. The freshness
check above is what keeps that true once the bundle ships.

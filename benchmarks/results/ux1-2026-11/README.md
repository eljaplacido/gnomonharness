# UX1: what a harness costs in daily dev (2026-10-31)

Design and scoring: `PRE-REGISTRATION.md`, written before the measured runs, and
its amendment, written before the six-arm rerun.

One turn, `Reply with OK.`, against a fake model that answers at once. What is
left of the wall clock is the harness.

## Result: the six-arm rerun (`runs/warm-20261031T163708Z/`)

n = 20 per arm, interleaved; 120 of 120 runs valid. 1-minute load: median 8.5,
max 9.5. Medians, with IQR in brackets.

gnomon is measured in both of its forms:
- **gnomon-rel**: the v0.3.1 release tarballs, as `install.sh` installs them,
  running compiled `dist/` with plain node;
- **gnomon (checkout)**: the repository launcher, running `src/` through `tsx`.

| arm | wall ms | first request ms | CPU ms | peak RSS MB | bytes sent | tools |
|---|---|---|---|---|---|---|
| **gnomon-rel** (v0.3.1 release) | **151** [127–166] | **115** [97–124] | **160** [130–170] | **69** | 8,361 | 9 |
| goose 1.57.0 | 413 [292–429] | 230 [170–260] | 440 [318–452] | 138 | 19,401 | 17 |
| gnomon (checkout, tsx) | 368 [339–394] | 302 [290–321] | 470 [438–510] | 103 | 8,361 | 9 |
| Qwen Code 0.26.4 | 996 [779–1,022] | 790 [632–803] | 1,630 [1,268–1,670] | 226 | 94,928 | 10 |
| opencode V2 2.2.5 | 1,089 [785–1,118] | 872 [630–896] | 2,710 [2,080–2,772] | 427 | 36,065 | 12 |
| mini-swe-agent 2.4.6 | 3,296 [2,178–3,500] | 2,036 [1,575–2,207] | 3,260 [2,142–3,475] | 211 | **3,378** | 1 |

**gnomon as released is faster than every peer on every timing.** Each
interval excludes 0 (difference of medians, 95% bootstrap):

| gnomon-rel vs | CPU | wall | first request |
|---|---|---|---|
| goose | −280 [−300, −200] | −262 [−281, −175] | −115 [−142, −72] |
| Qwen Code | −1,470 [−1,520, −1,160] | −846 [−872, −655] | −675 [−694, −525] |
| opencode V2 | −2,550 [−2,615, −2,205] | −939 [−968, −754] | −757 [−785, −621] |
| mini-swe-agent | −3,100 [−3,300, −2,465] | −3,145 [−3,331, −2,508] | −1,921 [−2,071, −1,662] |

It also holds the least memory of any arm: 69 MB, half of goose's 138.

**The checkout form costs ~200 ms per invocation, all of it the launcher.**
Against gnomon-rel it is +217 ms wall [+193, +244], +187 ms to the first
request and +310 ms CPU. Against goose it ties on wall and CPU (no practical
difference) and loses on the first request, +72 ms [+47, +116]. This is what
gnomon's own developers pay, and what this user runs daily.

**On the wire** (deterministic; identical in both runs):
- gnomon sends 8,361 B in one request: 4.3× less than opencode V2, 2.3× less
  than goose and 11.4× less than Qwen Code.
- mini-swe-agent sends less (3,378 B). It ships a single `bash` tool: a
  different design, not a leaner version of the same one.
- The published "4.66× less context than OpenCode" (vs opencode 1.x) becomes
  4.3× against opencode V2.

## Caveats

- The load was above the 4 the pre-registration names: other sessions' jobs,
  plus P1's containers in the rerun. CPU time is the contention-robust column.
  The quiet-host replication is still owed.
- One turn and an instant model. A real model adds seconds to every turn,
  shared by every harness. These numbers are the harness's own share.
- v0.3.1 is the release form of the code P1 measures, but it is **still a
  draft**. Until it is published, `install.sh` installs v0.3.0, which this run
  did not measure.

## The first readout, checkout form only (`runs/warm-20261031T162845Z/`)

Kept as measured. It compared gnomon's checkout form with the peers' releases;
the amendment explains why that was the wrong comparison to lead with. Load:
median 6.4.

### Warm runs

n = 20 per arm, interleaved; 120 of 120 runs valid. Medians, with IQR in
brackets.

| arm | wall ms | first request ms | CPU ms | peak RSS MB | requests | bytes sent | largest request | tools | tool-schema bytes |
|---|---|---|---|---|---|---|---|---|---|
| **gnomon** | **311** [295–367] | 270 [253–314] | 400 [370–452] | **103** | 1 | 8,361 | 8,361 | 9 | 4,438 |
| goose | 307 [271–336] | **178** [159–195] | **305** [290–340] | 138 | 2 | 19,401 | 17,479 | 17 | 12,685 |
| opencode V2 | 768 [733–841] | 596 [584–665] | 2,050 [1,988–2,262] | 435 | 2 | 36,065 | 33,940 | 12 | 13,600 |
| Qwen Code | 746 [707–803] | 596 [567–636] | 1,275 [1,218–1,345] | 226 | 2 | 94,928 | 68,597 | 10 | 19,872 |
| mini-swe-agent | 2,124 [2,020–2,200] | 1,554 [1,460–1,599] | 2,090 [1,982–2,162] | 211 | 1 | **3,378** | 3,378 | 1 | 228 |

#### gnomon (checkout) against each peer

Each figure is the difference of medians, with a 95% bootstrap interval. A
difference under 50 ms counts as no practical difference.

| vs | CPU | wall | first request |
|---|---|---|---|
| opencode V2 | −1,650 ms [−1,860, −1,580] **gnomon faster** | −457 [−515, −396] **faster** | −326 [−392, −289] **faster** |
| Qwen Code | −875 [−945, −795] **faster** | −435 [−482, −373] **faster** | −325 [−357, −280] **faster** |
| mini-swe-agent | −1,690 [−1,750, −1,575] **faster** | −1,813 [−1,869, −1,704] **faster** | −1,284 [−1,328, −1,206] **faster** |
| goose | +95 [+55, +140] **gnomon slower** | +5 [−14, +60] no practical difference | +92 [+73, +131] **gnomon slower** |

#### On the wire

- gnomon sends the least context of any arm that ships a real tool set.
- Against opencode V2 it sends **4.3× less** (8,361 B vs 36,065 B). The
  published figure, 4.66× against opencode 1.x (7,824 B vs 36,490 B), is
  replaced by this one: gnomon's request grew 537 B since, and opencode's
  shrank.
- Against goose it sends 2.3× less, and against Qwen Code 11.4× less.
- mini-swe-agent sends less still (3,378 B). It ships one tool, `bash`, so its
  task work runs through the shell. That is a different design, not a leaner
  version of the same one.

#### First run in a fresh HOME (onboarding, n = 3, descriptive, checkout form)

| arm | wall ms |
|---|---|
| gnomon | 394, 404, 448 |
| goose | 302, 321, 386 |
| opencode V2 | 1,080, 1,145, 1,184 |
| Qwen Code | 802, 970, 1,037 |
| mini-swe-agent | 2,322, 2,931, 3,316 |

## The checkout launcher: where its time goes (exploratory)

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

The bundle lands where the release form does (151 / 115 / 160 ms in the
rerun), as it should: both run compiled code with no transpiler. So the
bundle's value is for the checkout form only. It would give gnomon's
developers, and this user's daily `gnomon`, the release's speed without a
manual build step.

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

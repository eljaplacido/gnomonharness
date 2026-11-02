# UX2: daily-dev overhead refreshed on gnomon master (pre-registration)

Status: **final** (see the end). Written 2026-11-02 before any measured run;
later changes are timestamped amendments.

## Question

UX1, UX1b and UX1c (Linux) measured v0.3.1, and UX1W (Windows) measured
v0.3.3. Master now also contains:
- #80, proportionate verification. A prompt change; with a fake model it should not move timings.
- #86, the trust-check startup fix.
- #90, fewer git calls per turn.
- #91, the `check --format gnomon` reader.

Do the published overhead figures still describe the build people will get
next, and by how much did they move?

## Builds under test

| Arm | Build | Form |
|---|---|---|
| gnomon-master | master `d59e6c198f91d1469198b0677c008323f82d0345` | four npm tarballs packed from that commit with `pnpm pack` after `pnpm -r run build`, as the release job packs them; `npm i -g --prefix` into an isolated prefix |
| gnomon-033 | v0.3.3 `c2e62a98d0bac4c81e7ea90cba56460eb497f52a` | the release, via the official `scripts/install.sh` (`GNOMON_VERSION=0.3.3`) into an isolated HOME and prefix; downloads checked against the release `SHA256SUMS` |
| opencode V2 2.2.5, goose 1.57.0, Qwen Code 0.26.4, mini-swe-agent 2.4.6 (+ litellm 1.105.7) | UX1's pinned installs | reused from `../ux1-2026-11/tools/`, unchanged |

Both gnomon arms run `gnomon task "<p>" --role implementor --yes --trust`.
`--trust` is needed since #72, or the benchmark's loosened surface (P1's patch:
every role on the fake endpoint, approval never) would be clamped to the
scaffold. The audit's latency harness did the same.

## Measurements (Linux, gx10)

The apparatus is UX1's own (`../ux1-2026-11/apparatus/run_ux1.py`: `one_run`, the
fake model, rusage, request logs). It is imported unchanged, and only the arm
table is replaced (`apparatus/run_ux2.py`).

1. **warm:** one HOME per arm, warmed by 2 runs; n = 20 rounds; arms interleaved, order rotating per round.
2. **first:** a fresh HOME for every run; n = 20.
3. **session (UX1b):** the scripted 10-turn shell session; n = 20.
4. **UX1c (repo size):** the scripted 10-turn session in a repository of N committed files (~200 B each, in 100-file directories). N = 1,000 / 5,000 / 20,000 / 50,000. Arms gnomon-master and gnomon-033 only; n = 6 sessions per cell, interleaved. The repository is built once per N and copied with `cp -a` per run, untimed.
5. **Change detection:** for each gnomon build, `worktreeStampOf` from that build's own dist on a 30,000-file and a 50,000-file tree; 20 single-file modifications sampled across the tree, counted seen / missed. This is UX1c's `stamp-cap-probe.mjs` logic.

## Measurements (Windows, the hub)

UX1W's apparatus and isolated installs, in `C:\dev\ux1w`, are reused. Added:
- master's packed build, installed into its own folder there;
- the UX1c repo-size session for gnomon-master and gnomon-033 at N = 1,000 / 5,000 / 20,000 / 50,000, n = 6, interleaved.

Nothing outside `C:\dev\ux1w` is touched.

## Endpoints and reporting

- **CPU ms (user + sys of the whole process tree) is reported first.** The gx10 is shared with P2G (3 Harbor containers) and a GPU chain, and CPU time barely moves under contention.
- **Wall time and time to first request** are reported with the 1-minute load recorded per run.
- **Comparisons:** paired, per interleaved round, master − 0.3.3 and gnomon-master − each peer, with a 95% bootstrap interval of the median paired difference.
- **Absolute times** are never presented as idle-machine figures. The UX1/UX1b/UX1c/UX1W figures were measured under other loads, so their comparisons are descriptive only.
- **Session:** harness time per turn (`turn_gap_ms`, net of the fake model), base context and growth per turn, and total bytes.
- **UX1c:** median per-turn gap per N and build, and the slope across N.
- **Change detection:** seen / missed out of 20, at 30k and at 50k.

**Validity:** UX1's rule. A run is valid when the harness exits 0 after at least
one chat request (session: all 10 turns). Invalid runs are counted per arm and
never scored. The buckets sum to n.

**Negative control:** before any measured run, every arm is pointed at a closed
port once. Each must come back invalid; a fast "pass" there would mean the
apparatus measures nothing.

**Load handling:** if the 1-minute load goes above 14 (of 20 cores) during a
phase, that phase's runs are kept and flagged. If more than a third of a phase
is flagged, the phase is re-run in a quieter window, and both readings are
reported.

## What this cannot show

- Overhead only. A fake model answers at once, so nothing here says anything about tasks solved or tokens with a real model.
- One machine per OS.
- Peer versions are the UX1 pins (October), not their latest releases.

## Apparatus notes, logged before the first measured run (2026-11-02T09:48Z)

1. **Probe:** every arm ran once and was valid, Linux and Windows (`runs/probe-*`, and `C:\dev\ux1w\runs\ux2-probe-*`).
   - Master sends 8,688 bytes in its one request, against 8,361 for v0.3.3: #80's verification rule is longer.
2. **Negative control:** every arm, pointed at a closed port, came back invalid (`runs/neg-*`). Both gnomon builds exited 10 in 3.7 s; opencode and Qwen Code exited 1 after ~90–105 s of retries; goose exited 1; mini hit the 120 s cap.
3. **Templates:** each template repository is packed once (`git gc`) with auto-gc off. A background `git gc` had raced a copy of the 50k template.
4. **Index refresh:** each copied repository gets an untimed `git update-index -q --refresh` before the run.
   - A copy has new inodes and ctimes, so git's index stat cache is stale and every `git --no-optional-locks status` re-hashes the tree, since it never writes the refresh back. At 30k files that is 0.21–0.24 s per call, against 0.05 s refreshed.
   - A developer's own repository has a fresh index, so the measured runs use refreshed copies.
   - The stale-index cost is reported separately as an exploratory observation, not as a UX1c figure.
5. **Change-detection probe:** it runs at 30,000 and 50,000 files, as UX1c's original probe ran at 30,000. Its first, setup-time run (20/20 seen for both builds at both sizes) was an apparatus check; it is repeated after this point and only the repeat counts.
6. **Trust on Windows:** the Windows gnomon arms reach the trusted state through UX1W's untimed `gnomon trust grant` in setup, rather than `--trust` on the command line. Same effect.

**Final:** this file as committed now (2026-11-02T09:48Z), before any measured run of UX2.

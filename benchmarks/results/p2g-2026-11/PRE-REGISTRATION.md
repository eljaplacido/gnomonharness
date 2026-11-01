# Pre-registration — P2G: P2 on the gx10 (aarch64)

**Status: DRAFT.** It becomes final with a timestamped line below, written after
the oracle check and the probe and before any measured cell.

## Why this run exists

P2 (`../p2-2026-11/`) ran on the hub (Windows, Docker Desktop, amd64). On
2026-11-01 around 19:20Z the hub was shut down for the foreseeable future, with
attempt 1 at about 109 of 270 cells. Those cells are on the hub's disk and could
not be copied before it went offline. P2G runs P2's design on the gx10 instead.

**The hub's partial attempt-1 cells are not pooled with P2G.** Different host,
different CPU architecture, environments built rather than pulled. They stay an
archived partial, copied into `../p2-2026-11/` when the hub returns, and are never
merged into P2G's numbers.

## Design: P2's, with these changes only

| | P2 (hub) | P2G (gx10) |
|---|---|---|
| host | Windows, Docker Desktop, amd64 | Linux, Docker 29, aarch64 (NVIDIA GB10, 20 cores, 121 GB unified memory) |
| task environments | prebuilt images pinned by TB 4.0 (`docker_image`, amd64 only) | built here from each task's own `environment/Dockerfile` and `tests/Dockerfile` (`apparatus/unpin_images.py` removes the pins; nothing else in a task changes) |
| tasks | 30 (29 after excluding cumulative-layout-shift) | the same 29, minus any whose oracle fails on arm64, each replaced by the next task in P2's hash order (oracle-checked first). List: `apparatus/tasks-p2g.json` |
| slots | 6, 24 GB memory budget | 3, 36 GB memory budget (see Load) |
| relays | `relay-go.mjs`, 4010+slot | the same file, 172.17.0.1:4710+slot, counters 127.0.0.1:4810+slot |
| cell ids | `p2-k…` | `g2-k…` (no compose project can collide with P1's `p-` or LEAN's `l-`) |
| build timeout | TB 4.0's own (900 s) | ×4, since building from source on arm64 is slower. Builds are outside the agent's cap in Harbor, so this changes no measured time |

Unchanged from P2:
- the arms and their pins (gnomon 0.3.1 release tarballs · Claude Code 2.1.316 · Codex 0.166.0 · opencode V2 2.2.5 · OpenHands SDK 1.59.0 · aider 0.86.2 · goose 1.57.0 · mini-swe-agent 2.4.6 with litellm 1.105.7 · pi 0.85.1);
- the model (`deepseek-v4.1-flash`, OpenCode Go) and the 1,800 s agent cap;
- 3 attempts, each a barrier; order by seed = attempt, with arms rotating;
- the validity rule and the scoring and analysis sections;
- the floor/ceiling gate after attempt 1 and the $25 budget gate.

The text of those sections in `../p2-2026-11/PRE-REGISTRATION.md` applies
verbatim, with "270 cells" read as 261 (29 tasks × 9 arms).

## Load

P2G shares the gx10 with P1, which takes the GPU and one tb cell at a time
(about 35 cells left at launch), and later with LEAN stage 2 and R1 on the GPU.
Every P2G cell records the host's load average at start and end (`load.json`).
Slots stay at 3 for the whole run, so the load does not change by design partway
through. Wall time and cap hits are read with the load beside them. A cell is
never re-run because the load was high.

## Oracle check on arm64, 2026-11-01 19:40–20:13Z, before any arm

Harbor's `oracle` agent (the reference solution, no model) ran once per task with
`--force-build`. Times are seconds as Harbor recorded them: `env` is environment
setup including the first build, `verifier` includes building the verifier
environment.

| task | oracle | env (s) | verifier (s) | wall (s) | status |
|---|---|---|---|---|---|
| atrx-vep-crispr | 1 | 91 | 96 | 199 | used |
| batched-eval-parity | 1 | 4 | 111 | 127 | used (replacement) |
| biped-contact-dynamics | 1 | 34 | 46 | 94 | used |
| bun-sourcemap-leak | 1 | 13 | 28 | 55 | used |
| cargo-flight-dispatch | 1 | 3 | 20 | 36 | used |
| data-anonymization | 1 | 22 | 457 | 491 | used |
| fin-saccr-rwa | 1 | 4 | 18 | 34 | used (replacement) |
| freecad-platform-drawing | no reward | 59 | 46 | 117 | **fails on arm64**: verifier build, the same `vtk 9.2.6` error |
| freecad-spring-clip | no reward | 70 | 51 | 133 | **fails on arm64**: verifier build; arm64 conda resolves a distutils-installed `vtk 9.2.6` that pip cannot replace |
| glycan-ms2-elucidation | 1 | 22 | 19 | 54 | passes; not needed (next in order) |
| heat-pump-warranty | no reward | 22 | — | 23 | **fails on arm64**: compose services pinned by digest to prebuilt amd64 images |
| html-js-filter | 1 | 9 | 162 | 183 | used |
| interleaved-vigenere | 1 | 2 | 29 | 42 | used |
| ks-solver-cpp | no reward | 18 | 30 | 60 | **fails on arm64**: the verifier vendors an x86 numpy (`/tmp/ks_verifier_site`); `_multiarray_umath` cannot load, so no reward file |
| lake-temp-glm | 1 | 62 | 69 | 270 | used |
| layout-config-recreation | 1 | 218 | 125 | 369 | used |
| layout-config-recreation2 | 1 | 22 | 32 | 68 | used |
| legacy-utility-triage | no reward | 28 | — | 29 | **fails on arm64**: main and two sidecars pinned by digest to prebuilt amd64 images in the task's compose file |
| music-harmony | 1 | 2 | 25 | 50 | used (replacement) |
| mvcc-lsm-compaction | 1 | 14 | 249 | 283 | used |
| ontology-kg-querying | 1 | 15 | 25 | 54 | used |
| payments-pipeline-fix | no reward | 25 | — | 27 | **fails on arm64**: compose sidecars (`seeder`, `customer`) are prebuilt amd64 images; the seeder exits 255 |
| pretrain-shard-corruption | 1 | 33 | 45 | 269 | used |
| production-planning | 1 | 10 | 18 | 46 | used |
| protein-autointerp-disulfide | 1 | 16 | 24 | 106 | used |
| react-lead-form | 1 | 9 | 38 | 61 | used |
| retro-console-soc | 1 | 72 | 240 | 323 | used |
| risk-scorer-replay | 1 | 9 | 33 | 54 | used (replacement) |
| roy-polymorph-cn | 1 | 37 | 27 | 78 | used |
| satb-audio-transcription | 1 | 35 | 21 | 140 | used |
| session-window-debug | 1 | 9 | 16 | 37 | used |
| shadow-relay | 1 | 9 | 38 | 59 | used (replacement) |
| sound-change-cascade | 1 | 9 | 25 | 49 | used |
| vf2-speedup-networkx | 1 | 48 | 39 | 101 | used |
| vpp-loss-divergence | 1 | 193 | 191 | 424 | used (replacement) |
| wal-recovery-ordering | 1 | 3 | 202 | 217 | used |
| wdm-design | no reward | 23 | — | 25 | **fails on arm64**: conda-forge has no `pymeep=1.29` for linux-aarch64 |

**Result:** 23 of P2's 29 tasks pass on arm64. The six that fail are replaced
under P2's own rule, by the next tasks in P2's hash order
(`sha256("p2-2026-11:" + name)`, reproduced here from the downloaded dataset,
and its first 30 match P2's list). That order is freecad-platform-drawing
(already in the list, and itself failing), music-harmony, shadow-relay,
vpp-loss-divergence, batched-eval-parity, risk-scorer-replay,
heat-pump-warranty (fails), fin-saccr-rwa. So the six replacements are
**music-harmony, shadow-relay, vpp-loss-divergence, batched-eval-parity,
risk-scorer-replay and fin-saccr-rwa**, all oracle 1. The 29 tasks are in
`apparatus/tasks-p2g.json`.

**What this changes, stated:**
- P2G's task set is not P2's. 23 tasks are shared and 6 differ, so P2G and P2 are
  two runs, never one pooled sample.
- The tasks lost on arm64 are not a random sample: two FreeCAD tasks, three with
  amd64 sidecars, and two with arm64 packaging gaps.
- **Images:** the largest built images were vpp-loss-divergence's environment
  (8.05 GB), layout-config-recreation's environment and verifier (4.81 and
  4.88 GB) and html-js-filter's verifier (2.64 GB); most were 0.15–1.3 GB.
  After the check the BuildKit cache held 82 GB, with 163 GB of disk free.
- **Disk during the run:** Harbor tags a built image per trial and removes it with
  the trial (its default `--delete`, which P2 used too). Each cell therefore
  rebuilds from the layer cache, in seconds and outside the agent's cap, and the
  disk does not grow per cell.

## Probe, one task, every arm once

(filled in after the probe)

## Amendments

(none yet)

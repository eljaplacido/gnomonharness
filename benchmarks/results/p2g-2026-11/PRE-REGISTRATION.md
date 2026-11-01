# Pre-registration — P2G: P2 on the gx10 (aarch64)

**Status: FINAL as of 2026-11-01T21:16:00Z, commit c9a40e72** (see the last line). Written after
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

## Probe, one task, every arm once, 2026-11-01 19:43–21:15Z

`interleaved-vigenere` (TB 4.0's expert estimate is 2 h), every arm once,
through the relays, 3 slots, with the oracle check running alongside (load up to
17.5). The probe's purpose is apparatus, not score: every harness must install
and run on arm64 and be metered.

| arm | version recorded by Harbor | install (s) | wall (s) | requests | with usage | 4xx | Go $ | reward | exception |
|---|---|---|---|---|---|---|---|---|---|
| aider | 0.86.2 | 14 | 608 | 4 | 5 | 0 | 0.041 | 0 | – |
| claude-code | 2.1.316 | 74 | 1906 | 92 | 91 | 0 | 0.269 | 0 | AgentTimeoutError |
| codex | 0.166.0 | 72 | 1491 | 113 | 106 | 7 | 0.205 | 0 | NonZeroAgentExitCodeError |
| gnomon | v0.3.1 `16954919e21165e8` | 10 | 1842 | 38 | 36 | 0 | 0.150 | 0 | AgentTimeoutError |
| goose | v1.57.0 | 12 | 1843 | 65 | 64 | 1 | 0.170 | 0 | AgentTimeoutError |
| mini | 2.4.6 | 31 | 1861 | 95 | 94 | 0 | 0.196 | 0 | AgentTimeoutError |
| opencode-v2 | v2.2.5 | 8 | 1838 | 123 | 123 | 0 | 0.323 | 0 | AgentTimeoutError |
| openhands | 1.59.0 | 9 | 1839 | 80 | 81 | 0 | 0.213 | 0 | AgentTimeoutError |
| pi | 0.85.1 | 9 | 1838 | 76 | 77 | 0 | 0.142 | 0 | AgentTimeoutError |

**Result:**
- **Every arm installed its pinned version on arm64 and reached the model through its relay,** with usage on every response. No adapter needed a change for arm64: opencode V2's installer already chooses the arm64 tarball, and every other installer resolves the architecture itself. Total $1.71.
- **No arm solved the task; eight hit the 1,800 s cap.** On a 2-hour task that is plausible and says nothing about the arms. The probe tests the apparatus.
- **codex ended early on a Go incompatibility, not on arm64.** Its "remote compaction" step failed (`remote compaction v2 expected exactly one compaction output item, got 0`). Its 7 4xx are Responses-WebSocket upgrades that Go refuses, after which codex falls back to HTTP. Both come from OpenCode Go's Responses API, not from this host. Under P2's validity rule such a cell is valid (verifier reward plus metered usage) and counts as unresolved. Compaction failures are counted per arm in the analysis.

## Amendments, all logged before the first measured cell

1. **Unpinned images** (`apparatus/unpin_images.py`). Harbor 0.25.0 starts the separate verifier environment with `force_build=False` (`harbor/trial/trial.py`), so with the pins in place it pulled the amd64 verifier image, which failed. The first smoke oracle cell showed exactly that. Removing the `docker_image =` lines makes Harbor build both environments from the task's Dockerfiles. Nothing else in any task changes. Dataset fingerprint (the script's own): `302c0df93c9a32da` before, `1d61f143bbf7051c` after; 66 tasks unpinned.
2. **Per-trial cleanup:** Harbor's default `--delete`, as in P2. The oracle and the probe ran with `--no-delete`, which left one image per trial; those images were removed after the check.
3. **Tasks:** six replacements under P2's rule; see the oracle table.
4. **Concurrency:** 3 slots and a 36 GB memory budget. P1 still shares the machine, and later GPU runs will too. Nine harnesses at P2's 6 slots plus P1's cell exceed the 20 cores, since a TB 4.0 task declares 4 CPUs.
5. **Build timeout:** ×4. Builds sit outside the agent's cap.
6. **The run's ETA,** derived from the probe and P2's hub pace (about 40 slot-minutes per cell): one attempt of 261 cells at 3 slots is roughly 36–58 hours. Three attempts take several days. The run is not shortened to fit; the floor/ceiling and budget gates after attempt 1 apply as pre-registered.

**Final:** this file is the P2G pre-registration as of commit `c9a40e72` (2026-11-01T21:16:00Z), before
any measured `g2-k*` cell. Changes after this point are timestamped amendments.

## Amendment, 2026-11-01T21:17Z: timestamp correction only

The "final" lines above first read 21:20Z, an estimate written before the
commit. The pre-registration was committed as `c9a40e72` at 21:16:00Z, and
attempt 1 started at 21:16:09Z, so the file was final before the first measured
cell. Only the timestamp text changed.

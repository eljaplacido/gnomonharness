# GBS-AUDIT 0.1: gnomon v0.4.1: 2026-11-04

**Answer.** Under GBS-AUDIT 0.1, gnomon v0.4.1's documented verifier
(`gnomon audit verify`, scored by exit status) detected, per adversary level:

| configuration | A1 editor | A2 forger | A3 anchor-aware forger |
|---|---|---|---|
| `off` (the `gnomon init` surface: chained trail, no signer, no anchor) | **5/7** [0.36–0.92] | **1/3** [0.06–0.79] | **0/2** [0–0.66] (4 N/A) |
| `attest` (Ed25519 signer, key file on the same machine) | **6/7** [0.49–0.97] | **2/3** [0.21–0.94] | **3/5** [0.23–0.88], 2 of them unlocalised and collateral (see below) |
| `git` anchor (local bare-repository stand-in for the witness) | **7/7** [0.65–1] | **2/3** [0.21–0.94] | **5/5** [0.57–1]; forced pushes and ref deletions refused 10/10 |
| `rfc3161` anchor (loopback stand-in TSA, receipts on this machine) | **7/7** [0.65–1] | **2/3** [0.21–0.94] | **3/5** [0.23–0.88], 2 of them unlocalised and collateral |

Wilson 95% intervals. Each cell is a handful of deterministic cases, so read
the intervals as a statement of how little a k/n of 3 or 5 can carry.
False positives: **0/48** untampered sessions, Wilson [0–0.074]. On the
default surface alone the figure is 0/24, [0–0.14]. Both controls held:
every control trail verified clean, and the `exit 0` verifier scored 57/57
applicable cases undetected.

**What this does not show.**
- **A correctly forged append after the seal is accepted in every
  configuration (I1, 4/4 missed).** The attacker adds a record whose
  `prev`, `seq` and hash are computed the way gnomon computes them. The
  verifier prints `NOT SEALED`, and with an anchor also "1 later record(s) not
  anchored yet", but it **exits 0**. A gate that reads the exit status passes
  a trail that grew after its `session_end`. The 2026-11-03 run's
  "append-forged-tail" was caught only because its forged record copied a
  stale `prev`.
- **Truncation is printed, not failed, without a signer or anchor (T1,
  `off`).** `NOT SEALED`, exit 0.
- **The attest and rfc3161 A3 "catches" of R2 and C1 are collateral.** The
  attacker deleted all the local heads (attest) or receipts (rfc3161), so
  *other* trails lost their evidence and the verifier failed on them. The
  forged target itself verified `SIGNED` or `ANCHORED`. An attacker who
  re-signs only the target is not caught: K1 on attest, undetected. The
  pre-registered rule scores these "detected, unlocalised", and they are
  reported that way. Read attest and rfc3161 A3 as **1/5 against a careful
  attacker**, as pre-registered: R2 is the published limit of a witness whose
  evidence lives on the attacked machine.
- **Witnesses are local stand-ins.** The git witness is a local bare
  repository, and the TSA runs on loopback. A hosted remote's protection
  rules and a real TSA were not exercised.
- **Trails come from scripted sessions.** A deterministic fake model wrote
  them through the real v0.4.1 harness (gap AUDIT-1). The false-positive
  corpus is the same kind.
- **gnomon only.** No peer was run, and peer results are not published.
- **Only integrity after the fact is measured.** Nothing here says whether
  the record was complete when it was written.

| Pre-registration | [PRE-REGISTRATION.md](PRE-REGISTRATION.md) @ `73e3709c` (file SHA-256 `45f291d4…`), pushed 21:08:00Z | first measured trial 2026-11-04T21:10:42Z (run 2; run 1 aborted, see incidents) |
|---|---|---|
| Builds | gnomon `gnomon/0.4.1+v0.4.1-c511b81`, release tarballs SHA256SUMS-checked ([INSTALL](../common/INSTALL.md)) | config: surface hash per arm in `result.json` |
| Models | none: scripted `fake_model.mjs`, no inference | |
| Hardware | Linux aarch64, GB10, 20 cores ([hardware.json](../common/hardware.json)) | load 2.2–2.5 (timing plays no part) |
| n | 16 cases × 4 configurations = 64 slots, 1 attempt; 57 applicable, 7 N/A | valid 64/64; buckets sum to n: yes |
| MDE / margin | n/a: deterministic conformance cases, no between-arm claim | |

## Per case

D = detected (exit ≠ 0). L1 = the unit is named, L2 = a seq or seq range,
L3 = a time bound. D-unl = detected but the failing line names another unit.
U (text) = exit 0 although the output prints a non-success word for the
unit. Expectations were stated per case in the pre-registration.

| arm | E1 | E2 | E3 | I1 | I2 | D1 | D2 | D3 | T1 | O1 | R1 | R2 | C1 | K1 | K2 | B1 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| level | A1 | A2 | A1 | A2 | A1 | A1 | A1 | A3 | A1 | A1 | A2 | A3 | A3 | A3 | A3 | A3 |
| off | D L1L2 | D L1L2 | D L1L2 | U (text) | D L1L2 | D L1L2 | U | U | U (text) | D L1L2 | U | N/A | N/A | N/A | N/A | U |
| attest | D L1L2 | D L1L2 | D L1L2 | U (text) | D L1L2 | D L1L2 | U | D | D L1L2 | D L1L2 | D L1L2 | D-unl | D-unl | U | N/A | U |
| git | D L1L2 | D L1L2 | D L1L2 | U (text) | D L1L2 | D L1L2 | D L1 | D | D L1L2 | D L1L2 | D L1L2 | D L1L2L3 | D L1L2L3 | N/A | D L1L2L3 | D L1 |
| rfc3161 | D L1L2 | D L1L2 | D L1L2 | U (text) | D L1L2 | D L1L2 | D L1 | U (text) | D L1L2 | D L1L2 | D L1L2 | D-unl | D-unl | N/A | D L1L2L3 | U |

**Against the pre-registered expectations:** all A1 and A2 cells came out as
predicted (I1 missed everywhere, as predicted). Three A3 cells differ.
- **attest R2 and C1, rfc3161 R2 and C1:** predicted U, scored D-unl. These
  are the collateral catches described above.
- **git D3:** predicted U, scored D. Deleting `checkpoints/` with the anchor
  state made the verifier report the newest anchored checkpoint as gone: "a
  rollback". The trail's records were untouched, so no unit is localised.

**Which layer caught what.** The chain and seal caught E1, E2, E3, I2, D1
and O1 in every arm. The signed head caught R1 and T1 in attest. The
external anchor caught D2, T1, R1, R2, C1, K2 and B1 in git, and D2, T1, R1
and K2 in rfc3161. Those are "the anchor caught it" claims (§7.5). They
depend on the witness's configuration, which the chain alone does not.

**Localisation of the re-chain (git).** `RE-CHAINED — seq 15 was anchored as
…, the trail now holds … The change is in seq 0–15 and was made after that
anchor; the rewrite itself was anchored later (…)`. That names the unit, a
seq range and a time bound. The range spans the whole sealed trail, because
there was one anchor per trail at seal.

**Witness moves (§6).** Every A3 case in the git arm also tried a forced
push of a history without the original anchor, and a deletion of
`refs/heads/gnomon-anchors`. Both were refused, 5/5 each. For rfc3161 the
authority is a third party with no write path, and for attest and off there
is no witness off the machine.

## Incidents and deviations

- **Run 1 aborted (apparatus).** At attest R2 the runner's re-sign wrote into
  the `heads/` directory it had just deleted (ENOENT). It was fixed and the
  whole run repeated. Run 1's log is in `raw/aborted-run-1/`.
- **Capture order.** The verifier prints some failing lines on stderr. Run 1
  captured the two streams separately, which detached those lines from their
  trail. Run 2 captures `2>&1`. Exit statuses are unaffected.
- **v0.4.1 finding: stale `anchors/flush.lock`.** In 22 of 22 anchored
  sessions, `gnomon task` exited leaving `flush.lock` behind with no delivery
  process alive. `gnomon audit anchor` then answered "A delivery is already
  running" until the lock aged past 120 s, so the session's heads waited
  undelivered. The runner removed such locks after 5 s, and counted each
  removal. The root cause was not investigated (the detached
  `audit anchor --background` child may not survive the parent's exit here).
  The heads were delivered once the lock was cleared.
- **C1 clock.** The attacker's clock was set back through gnomon's own
  delivery code (`flushAnchors` with `now` an hour back), because the
  apparatus has no root. The effect on a git anchor is the same: a committer
  date an hour early.
- **Post-hoc localisation correction.** B1 was re-scored against session 3,
  the unit B1 removes; D3's L1–L3 were set to n/a. Detection is unchanged.
  Logged in the pre-registration and reported as gap AUDIT-6.
- All rows, with times and before/after status:
  [PRE-REGISTRATION.md § Deviations](PRE-REGISTRATION.md#deviations-log).

## Traces

`traces.tar.gz` · SHA-256 `357602cb7faec64e397946f6563973e4d1270c2a3e3830d9299231c8f83473a4`.
It holds every arm's pristine project and witness, the post-case working
copies, the false-positive projects and `raw/`. The throwaway signing key's
private half is left out; its public key is in the archive.

Chain heads of the control target trails, and the git witness tip at
control, are in `result.json` → `traces`.

| File | What it is |
|---|---|
| `run_audit.mjs` | the runner: setup, controls, cases, false positives |
| `adapter.mjs` | the mutation adapter: `load`, `save`, `rehash`, `anchor_state`, `resign` |
| `fake_model.mjs`, `fake_tsa.mjs` | the scripted model and the stand-in authority (loopback, ephemeral ports) |
| `summarise.py` | `raw/cases.json` → `result.json` |
| `raw/cases.json`, `raw/runlog.jsonl` | per-case results and the run log |
| `raw/verifier/*.txt` | the verifier's full output and exit status for every case, misses included |
| `raw/control-trail-*.jsonl` | each arm's untampered target trail |
| [GAPS.md](GAPS.md) | spec gaps |

Reproduce: install per [INSTALL.md](../common/INSTALL.md), then
`GBS_SCRATCH=<dir> nice -n 19 node run_audit.mjs <workdir> <outdir>` and
`python3 -I summarise.py …`. About 4 minutes, $0.

# Pre-registration: GBS-AUDIT 0.1: gnomon v0.4.1: tamper evidence of the audit trail, four configurations

Committed before the first measured trial. Deviations are logged below, with time.

## Question and claim sought

Can a v0.4.1 audit trail be changed or removed after the fact without
gnomon's documented verifier, `gnomon audit verify`, detecting it? The
answer is given per adversary level (A1 editor, A2 forger, A3 anchor-aware
forger) and per configuration, never merged. The claim a positive result
supports: "Under GBS-AUDIT 0.1, gnomon v0.4.1's `gnomon audit verify`
detected k/n required cases at level Ax in configuration C (Wilson 95% CI),
with the localisation given." The claim is about this build, this platform
and these configurations, with a local stand-in witness. It is not a
compliance claim and it says nothing about write-time completeness.

## Arms

| arm | harness @ build | config | what differs from `off` |
|---|---|---|---|
| `off` | gnomon v0.4.1 release (`gnomon/0.4.1+v0.4.1-c511b81`, install in [../common/INSTALL.md](../common/INSTALL.md)) | the `gnomon init` surface, endpoint pointed at the fake model (`kind = "openai"`, `stream = false`) | — (`[audit]` on, chained, as `init` scaffolds it) |
| `attest` | same | + `[audit.attest]`: an Ed25519 signer script reading a key file on the same machine (an unattended key), public key pinned | heads signed at seal, kept beside the trail |
| `git` | same | + `[audit.anchor] backend = "git"`, remote = a **local bare repository** (stand-in for a hosted witness) with `receive.denyNonFastForwards` and `receive.denyDeletes` | sealed heads anchored off the trail directory |
| `rfc3161` | same | + `[audit.anchor] backend = "rfc3161"`, url = a **loopback fake TSA** (EC P-256, `fake_tsa.mjs`), `tsa_cert` pinned | receipts kept on this machine |

The surface hash of each arm is recorded in `result.json` (it depends on
the ephemeral ports and scratch paths written into the surface).

## Task set and size

- **Trail provenance:** real trails written by the pinned build. Each arm's
  project runs three scripted `gnomon task --yes --json` sessions against
  `fake_model.mjs` (a deterministic script, no language model). Session 2
  (script v4: glob, write, edit, read; ≥ 6 records) is the **target unit**.
  Sessions 1 and 3 stay beside it, so deleting a unit leaves other trails to
  verify. A copy of the audit directory taken after session 2 is the B1
  rollback state.
- **Cases:** E1 E2 E3 I1 I2 D1 D2 D3 T1 O1 R1 R2 C1 K1 K2 B1 (AUDITABILITY
  §4), each against a fresh copy of the arm's control, restored at the same
  path (the anchor scope hashes the path).
- **Mutations** (`run_audit.mjs`, adapter `adapter.mjs`): the middle record
  is m = ⌊records/2⌋. E1 changes `ts` of m. E2 is E1 plus m's own hash
  recomputed. E3 deletes m's `hash`. I1 appends a record **correctly chained**
  after the seal (`prev` = last hash, `seq` = last + 1, hash computed with
  gnomon's own `recordHash`): the strongest A2 append. I2 inserts a hashless
  copy after m. D1 deletes m. D2 deletes the target `.jsonl` and its
  `.record.json` (A1 knows nothing of heads or anchors). D3 deletes the local
  integrity state (`anchors/`, `heads/`, `checkpoints/`), not the records. T1
  drops the last 3 records. O1 swaps m and m+1. R1 is E1 plus every hash from
  m on recomputed. R2 is R1, the local anchor state deleted, then re-signed
  (attest: the declared signer) or re-anchored through gnomon's own queue and
  `gnomon audit anchor`. C1 is R2 with the time an hour back: the re-signed
  head's `ts`, or the anchor delivered through gnomon's own `flushAnchors`
  with a clock an hour slow (no root to set the system clock). K1 is R1
  re-signed with the unattended key, heads replaced. K2 is R1 plus the
  forgery anchored through the witness's append path, removing nothing. B1
  restores the post-session-2 audit directory.
- **Witness moves (every A3 case, git arm):** a forced push of a history
  without the original anchor, and a ref deletion. Reported refused/accepted.
- **n:** 4 arms × 16 cases = 64 case slots, one attempt each (the apparatus
  is deterministic; repetition adds no information). Then the same 64 under
  the `exit 0` verifier.

## Primary endpoint and analysis

- **Detected:** `gnomon audit verify` (run in the project, as a user runs
  it, with the surface trusted via `gnomon trust grant`) exits non-zero. The
  exit status is the verdict a gate reads; the command has no `--json`.
- **Localisation**, secondary, read from the verifier's own output:
  L1 a failing line names the target unit; L2 a seq or seq range is named
  for it; L3 a time bound ("after T") is given. A non-zero exit that does not
  name the target scores **detected, unlocalised**.
- **Undetected, text flag:** exit 0 while the output still prints a
  non-success word for the target (e.g. `NOT SEALED`). Counted as
  undetected, reported in its own column.
- **Headline:** caught / required cases per adversary level per arm, Wilson
  95% intervals. N/A counted separately and never as a pass.
- **Levels** follow the §4 taxonomy: A1 = E1 E3 I2 D1 D2 T1 O1 (7);
  A2 = E2 I1 R1 (3); A3 = D3 R2 C1 K1 K2 B1 (6).

## MDE / margin

n/a: a deterministic, single-attempt conformance suite with no comparison
between arms and no claim of difference. Intervals are given so a k/n is not
read as more than it is.

## Expected outcome of every case (AUDITABILITY §7.2), stated before running

D = detected (exit ≠ 0), U = undetected (exit 0), N/A = case meaningless here.

| case | level | off | attest | git | rfc3161 |
|---|---|---|---|---|---|
| E1 | A1 | D | D | D | D |
| E2 | A2 | D | D | D | D |
| E3 | A1 | D | D | D | D |
| I1 | A2 | U (text: NOT SEALED) | U | U | U |
| I2 | A1 | D | D | D | D |
| D1 | A1 | D | D | D | D |
| D2 | A1 | U | U | D | D |
| D3 | A3 | U | D | U | U |
| T1 | A1 | U (text: NOT SEALED) | D | D | D |
| O1 | A1 | D | D | D | D |
| R1 | A2 | U | D | D | D |
| R2 | A3 | N/A (≡ R1) | U | D | U |
| C1 | A3 | N/A (≡ R1) | U | D | U |
| K1 | A3 | N/A (no signer) | U | N/A (no signer) | N/A (no signer) |
| K2 | A3 | N/A (no witness) | N/A (no witness) | D | D |
| B1 | A3 | U | U | D | U |

Expected headlines: off A1 5/7, A2 1/3, A3 0/2; attest A1 6/7, A2 2/3, A3
1/5; git A1 7/7, A2 2/3, A3 4/5; rfc3161 A1 7/7, A2 2/3, A3 1/5. Witness:
every forced push and ref deletion refused.

## Secondary endpoints

Localisation columns; witness moves; false positives (below); which layer
caught each case (chain/seal, signed head, external anchor), read from the
output.

## Validity rule

A case is valid when its mutation applied (the file changed as described)
and the verifier ran to an exit status. A case whose mutation threw, or an
arm whose control does not verify clean, is an apparatus failure: the
apparatus is fixed and the case re-run under this pre-registration, and the
event is listed. Setup sessions that do not end `answered` abort the run.

## Stopping rule

Fixed n: one pass of every case in every arm, plus the controls and the
false-positive sessions below.

## Negative and positive controls

1. Each arm's untampered control verifies clean (exit 0). If not, nothing in
   that arm is scored.
2. The same scorer with the verifier replaced by `sh -c 'exit 0'` must score
   every applicable case undetected.
3. False positives: 24 untampered sessions on the `off` surface (scripts
   v0–v4 in rotation) and 8 on each other arm, each verified by name;
   reported as non-success k/n with a Wilson interval. Expected 0.

## Peer configuration and notice

n/a: gnomon only. Peer requirements are in PEER.md; no peer is run.

## Conflicts of interest

Author-run. gnomon's authors wrote GBS-AUDIT, the harness, and this runner.

## Deviations log

| time (UTC) | change | before/after reading outcomes | reason |
|---|---|---|---|
| 2026-11-04T20:58Z | One smoke `gnomon audit verify` on a throwaway untampered project (`$S/audit/smoke`) while building the fake model | before (no tampered trail was verified) | apparatus build |
| 2026-11-04T21:06Z | `--setup-only` dry runs of the setup phase. They found that every anchored session left `anchors/flush.lock` behind with no delivery process alive (6/6), so `gnomon audit anchor` answered "already running" for up to 120 s. The runner now removes a lock no live process holds, after 5 s, and counts each removal in `result.json` | before (no verifier run) | apparatus; also reported as a finding |
| 2026-11-04T21:06Z | C1 sets time through gnomon's own delivery code with a clock an hour slow (attacker-side), not by setting the system clock | before | no root on the apparatus |
| 2026-11-04T21:09Z | First measured run (started 21:08:12Z) aborted at attest R2: the runner deleted `heads/` and the re-sign wrote into the missing directory (apparatus failure, ENOENT). Fixed (`mkdir -p`); the whole run repeated from setup under this pre-registration. The aborted run's partial log is kept as `raw/aborted-run-1/` | after reading the partial per-case verdicts of `off` and `attest` E1–R1 | validity rule: apparatus fixed and re-run |
| 2026-11-04T21:10Z | The verifier's stdout and stderr were captured as two streams and concatenated, so a failing line gnomon prints on stderr (e.g. `anchor: BROKEN — seq 15 …`) lost its place under the trail it belongs to, and attest R1 scored "detected, unlocalised". The runner now captures both on one pipe (`2>&1`), the order a terminal shows. Detection (exit status) is unaffected; only the L1–L3 columns can move | after reading attest R1's output | apparatus: the capture, not the verifier, split the output |
| 2026-11-04T21:16Z | Localisation re-targeted in `summarise.py`: for B1 the unit the attack removes is session 3's trail, not the session-2 target the runner scored against; for D3 no unit's records change, so L1–L3 are n/a. Detection (exit status) is unchanged for both | after reading outcomes | the runner's single target did not fit these two cases; recorded as gap AUDIT-6 |
| 2026-11-04T21:16Z | Not changed, reported: attest and rfc3161 R2/C1 scored "detected, unlocalised" as pre-registered, but only because the attacker deleted ALL local heads/receipts and other units lost theirs; the forged target itself verified SIGNED / ANCHORED. The README says so beside the number | after reading outcomes | the scoring rule stays; the reading is added |

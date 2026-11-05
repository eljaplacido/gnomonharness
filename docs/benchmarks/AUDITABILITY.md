# GBS-AUDIT: Auditability & Tamper-Evidence Suite

**Version 0.2 (draft), 2026-11-05.** Part of
[gnomon Bench Standards](README.md). Results also follow
[GBS-REPORTING](REPORTING.md). Proposed by the gnomon project. Comments and
other harnesses' results are welcome as issues or pull requests. The
reference apparatus is
[`benchmarks/results/auditability-2026-11-03/tamper.mjs`](../../benchmarks/results/auditability-2026-11-03/tamper.mjs),
and the first run under this spec is
[gbs-2026-11-04](../../benchmarks/results/gbs-2026-11-04/audit/README.md)
(GBS-AUDIT 0.1). The changes from 0.1 are listed in the
[changelog](#changelog).

## 1. What it measures

**Can the record of what a coding agent did be changed or removed after the
fact without the change being detected?** The suite also asks against whom
that holds, and how precisely the detection says what happened.

It does not measure whether the agent behaved well, whether the log is
complete at write time, or whether a deployment is compliant with anything.
A harness that keeps no record scores **"no trail"**, not zero. Write-time
completeness is a separate question for a separate suite.

Why a suite at all: harness logs are often deletable by the agent that wrote
them ([Qin et al.](https://arxiv.org/abs/2609.30266)), and there is no
cross-harness measurement of tamper evidence. Related framing:
[Auditable Agents](https://arxiv.org/abs/2604.05485) (five auditability
dimensions) and the IETF draft
[agent-audit-trail](https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/).
This suite covers one of those dimensions, integrity after the fact, and
tries to measure it well.

**Conformance levels** ([README.md](README.md#conformance-levels)). The
taxonomy, the controls, the per-case scoring and a false-positive corpus of
scripted sessions are **harness level**: trails may come from sessions driven
by a scripted model (§6). A false-positive corpus of sessions driven by a real
model is **system level** (§5).

## 2. Terms

| Term | Meaning |
|---|---|
| **Trail** | The harness's record of a session's actions: a file, a set of files, a database or a log stream |
| **Real trail** | A trail the pinned build wrote, every record of it, in the course of a session that ended normally. The session MAY be driven by a scripted model; the result states the driver |
| **Unit** | The smallest thing the harness verifies as a whole: a trail file, a session |
| **Affected unit** | The unit a case changes, per §4's column. Localisation is scored against it |
| **Record** | One entry in a unit |
| **Verifier** | The harness's *documented* check, run by a third party who holds only the trail directory and the documented witness access. Undocumented internals do not count |
| **Verdict** | The verifier's machine-readable outcome: its exit status, or a named field of a documented structured output |
| **Witness** | Anything off the attacked machine that the verifier consults: a remote repository, a transparency log, a time-stamp authority's signature, a printout |
| **Control** | The untampered trail. It must verify clean, or the run is an apparatus failure and nothing is scored |

## 3. Adversaries

Scores are reported **per level**, never merged.

| Level | Who | Can |
|---|---|---|
| **A1 editor** | someone with write access to the log files | edit, delete or reorder records as text, with no knowledge of the integrity mechanism |
| **A2 forger** | A1 who knows the format | recompute hashes and rebuild chains: everything a published format allows |
| **A3 anchor-aware forger** | A2 with the whole machine | delete or replace local integrity state (heads, receipts, caches). Use any key the machine signs with unattended. Use the harness's own credentials to *append* to the witness. Set the clock |
| **A4 witness owner** | can rewrite the witness itself | **out of scope**: reported as the boundary, never scored |

**A3's best move.** An A3 case is run with the attacker's best move: deleting
or replacing only the evidence about the target unit. A whole-directory
variant (deleting every unit's evidence) MAY be reported beside it, labelled.

**Setting the clock** (C1) MAY be done by injecting the skewed time at the
harness's own time source: a library clock, a faketime shim, or a VM clock.
The method is stated. What is tested is that the forgery's evidence claims an
earlier time, not how that was arranged.

## 4. Attack taxonomy

This table is normative. Tables elsewhere in this document are illustrative.

Each case is run against a fresh copy of the control. A case marked
**required** must be reported. A harness whose format makes a case
meaningless reports it **N/A**, with the reason. For example, with no
integrity field, E2 is the same as E1.

| Id | Family | Case | Level | Required | Affected unit |
|---|---|---|---|---|---|
| E1 | edit | change one field of a record in the middle of the unit | A1 | yes | the edited unit |
| E2 | edit | E1, then recompute that record's own integrity value | A2 | yes | the edited unit |
| E3 | edit | remove one record's integrity value | A1 | yes | the edited unit |
| I1 | insert | append a forged record with a valid-looking integrity value | A2 | yes | the edited unit |
| I2 | insert | insert a record with no integrity value | A1 | yes | the edited unit |
| D1 | delete | remove one record from the middle | A1 | yes | the edited unit |
| D2 | delete | remove a whole unit | A1 | yes | the deleted unit |
| D3 | delete | remove the integrity evidence (signatures, heads, receipts), not the records | A3 | yes | none: localisation n/a |
| T1 | truncate | remove the last records | A1 | yes | the edited unit |
| O1 | reorder | swap two records | A1 | yes | the edited unit |
| R1 | re-chain | E1, then recompute every integrity value after it (full rewrite) | A2 | yes | the edited unit |
| R2 | re-chain | R1, delete the local anchor state, then re-sign or re-anchor the forgery as the harness would | A3 | yes | the edited unit |
| C1 | clock | R2 with the local clock set back, so the forgery's anchor claims to predate the original | A3 | yes | the edited unit |
| K1 | key | R1, then re-sign with a key the machine uses unattended | A3 | if the harness signs | the edited unit |
| K2 | key | use the witness's append credentials to add forged anchors (but not remove any) | A3 | if the harness anchors | the edited unit |
| B1 | rollback | restore an older, internally complete state of the whole trail directory | A3 | yes | every unit absent from the restored state |

gnomon's original nine attacks map onto the table as follows:

| gnomon's nine | Ids |
|---|---|
| edit-a-field | E1 |
| edit-and-rehash-one | E2 |
| strip-one-hash | E3 |
| append-forged-tail | I1 |
| insert-hashless | I2 |
| delete-a-record | D1 |
| truncate-the-tail | T1 |
| reorder-records | O1 |
| full-rewrite | R1 |

The 2026-11-03 run adds R2, C1, D2, K2 and B1. B1 is covered by the unit
tests (a rolled-back checkpoint).

## 5. Scoring

- **Detected:** the verifier returns a non-success **verdict**, a
  machine-readable outcome (§2), and the verdict names the affected unit.
  A verdict that fails but names nothing, or names the wrong unit, scores
  **detected, unlocalised**.
- **Flagged, not failed:** the verifier printed a warning a person must read
  (for example `NOT SEALED`) but its verdict was success. A CI gate reading
  the exit status passes such a trail. This is reported in its own column and
  never counted as detected.
- **Collateral:** a non-success verdict that names only units the attack did
  not target (for example after a whole-directory A3 deletion). Scored
  *collateral*, not *detected*.
- **Localisation**, reported as secondary columns and never folded into the
  headline:
  - L1: the unit is named.
  - L2: the record range is named.
  - L3: a time bound is given ("after T").

  A harness SHOULD expose its verdict as structured output that names the
  unit, the record range and the time bound. Where it does not, the adapter
  publishes the patterns it used to read localisation, and localisation is
  marked *read from text*.
- **Headline:** caught / required cases, **per adversary level**. No
  weights, and no composite across levels. A harness that catches every A1
  case and no A2 case reports exactly that.
- **Compare case by case.** The cases are deterministic, so repeating one adds
  nothing, and the per-level ratio's interval is too wide to separate
  configurations (2/3 against 3/3 overlaps). Configurations and harnesses are
  compared case by case, never by the ratio's interval. Variation comes from
  more units: at least 3 trails of different shapes, with mutation points at
  the start, middle and end, each reported (SHOULD).
- **Controls, both directions, before scoring:**
  1. The control trail verifies clean.
  2. A verifier replaced by `exit 0` scores every case undetected. If it
     does not, the apparatus is measuring itself.
- **N/A and unsupported** are counted separately, and never as passes.
- **False positives:** run the verifier over N ≥ 20 untampered real trails,
  and report the number of non-success verdicts. At harness level the
  sessions may be scripted, and the result says so. At system level the
  corpus SHOULD include at least 20 sessions driven by a real model, from at
  least two task types.

**Validity buckets** ([REPORTING.md](REPORTING.md) §2.2): `pass` = detected,
`fail` = undetected (including *flagged, not failed* and *undetected, no
verifier*), `excluded` = N/A or unsupported, with the reason. `timeout` is
n/a.

## 6. Running it against another harness

The suite needs three things per harness:

1. **A real trail** (§2). At least six records, from a session that ended
   normally, produced by a pinned build. The session may be driven by a
   scripted model, and the result says which driver it used. A synthetic
   trail, written by anything but the harness, is not accepted: it tests the
   adapter, not the harness.
2. **A mutation adapter for the format.** It has four operations:
   - `load(unit) → records`
   - `save(unit, records)`
   - `rehash(records)`, which recomputes the integrity values the way the
     format defines them. It is absent when the format has none.
   - `anchor_state()`, the local files A3 is allowed to delete.

   The adapter mutates the harness's own store on disk, never an export: an
   export is a copy, and tampering with a copy proves nothing about the
   record. The reference adapter for gnomon's JSONL is about 20 lines of
   `tamper.mjs`. A JSONL transcript adapter is the same shape. An SQLite log
   needs `UPDATE`, `DELETE` and the harness's own hashing, if it has any.
3. **The documented verifier and witness.** It is run exactly as a user
   would run it. When a harness documents no verifier, every case is scored
   **undetected, no verifier**. That is not N/A: the trail exists and can be
   changed silently.

**Delivered evidence.** Before any case, the control's evidence is confirmed
delivered: for an anchored harness, every sealed head is on the witness. A
head still queued is an apparatus failure, not a miss. (gnomon v0.4.1 left a
stale anchor lock after every anchored session; without a drain step, R1 and
R2 would have run against a witness that never received the genuine head.)

Every A3 case also runs the attacker's best move against the witness: a
forced push, a deletion, or a replacement. The result is reported: refused,
or accepted. An accepted one is a configuration finding about the witness,
and is reported beside the score.

Results live where every GBS result lives
([README.md](README.md#how-to-submit-results)).

## 7. Reporting rules

1. **Pin everything:**
   - the harness version and commit or artifact digests;
   - the OS;
   - the witness configuration (what makes it append-only, and whether it
     was real or a local stand-in);
   - the trail's provenance, including the session driver (scripted or a
     named model).
2. **State the expected outcome of every case before the run**, in the
   commit that adds the apparatus, or in a pre-registration.
3. **Publish the evidence:**
   - the control trail;
   - the mutation code;
   - the raw per-case results (JSON);
   - the verifier's output for every miss.
4. **Never drop a case.** A miss is reported as a miss, an unsupported case
   as unsupported, and a changed figure with the date it changed.
5. **Separate what caught it:** "the chain caught it" and "the witness caught
   it" are different claims, and the second depends on a configuration the
   first does not.
6. **No composite.** Report one row per adversary level, and the per-case
   table beside it.
7. **Re-run on change.** A figure is tied to the build that produced it.

## 8. Reference results — gnomon, 2026-11-03

From [`auditability-2026-11-03`](../../benchmarks/results/auditability-2026-11-03/),
with the witness a local bare repository that has `receive.denyNonFastForwards`
and `receive.denyDeletes` set. The 0.1 version of this table showed D2 under
A3; §4 makes it an A1 case, so it has its own column here. The outcomes are
unchanged.

| Configuration | A1 (E1 E3 I2 D1 T1 O1) | A1: D2 | A2 (E2 I1 R1) | A3 (R2 C1 K2) | Localisation of R1/R2 |
|---|---|---|---|---|---|
| no anchor | 6/6 | missed | 2/3 (R1 missed) | 0/2 (R2, C1 missed) | — |
| `[audit.anchor]` git | 6/6 | caught | 3/3 | 2/2 + forced pushes refused 11/11 | L3: unit, seq range, after T |
| `[audit.anchor]` rfc3161, receipts local | 6/6 | not run | 3/3 | R2 missed (receipt deleted, forgery re-stamped); C1 not run | L3 while the receipt survives |

**K2 for git:** an attacker holding the append credentials adds forged
anchors. They cannot remove the original, which no longer matches. That is
R2's mechanism, and it is caught. **K1:** gnomon's `[audit.attest]` with a key
file is defeated, as documented. The anchor does not depend on any key gnomon
holds. **B1:** the newest anchored checkpoint going missing is reported as a
rollback (unit tests in `anchor.test.ts`).

The first results under this spec, for gnomon v0.4.1 (GBS-AUDIT 0.1, partially
conformant), are in
[gbs-2026-11-04](../../benchmarks/results/gbs-2026-11-04/audit/README.md).

## 9. Versioning

This document is versioned. A change to the taxonomy, the scoring or the
reporting rules bumps the draft number, and results name the version they
were scored under. Open questions for 0.3:

- a fixed corpus of ordinary sessions for the false-positive rate;
- adapters for at least two other harnesses' native logs;
- a K1 case with a person-present signer.

## Changelog

### 0.2 (draft), 2026-11-05

Gap IDs are those of
[audit/GAPS.md](../../benchmarks/results/gbs-2026-11-04/audit/GAPS.md), found
running 0.1 on gnomon v0.4.1.

**Resolved**

- **AUDIT-1.** A *real trail* is one the pinned build wrote in a session that
  ended normally; the session may be scripted, and the driver is stated. The
  false-positive corpus may be scripted at harness level, and SHOULD include
  ≥ 20 real-model sessions from ≥ 2 task types at system level (§1, §2, §5,
  §6).
- **AUDIT-2.** The verdict is machine-readable (exit status or a documented
  field); printed-only text is *flagged, not failed* and never detected (§2,
  §5).
- **AUDIT-3.** §4 is normative; §8's table now shows D2 as an A1 case, with
  the same outcomes.
- **AUDIT-4.** A3 cases use the attacker's best move, target-only; a
  whole-directory variant MAY be reported; detections naming only other units
  are *collateral* (§3, §5).
- **AUDIT-5.** C1 may inject the skewed time at the harness's own time
  source, with the method stated (§3).
- **AUDIT-6.** An affected-unit column in §4; localisation is scored against
  it.
- **AUDIT-7.** Every sealed head is confirmed on the witness before any case;
  a head still queued is an apparatus failure (§6).
- **AUDIT-8.** Results are compared case by case, never by the ratio's
  interval; at least 3 trails of different shapes and three mutation points
  (SHOULD) (§5).
- **AUDIT-9.** Results live at the family's one results path (§6;
  [README.md](README.md#how-to-submit-results)).
- **AUDIT-10.** A verifier SHOULD give structured output naming unit, record
  range and time bound; otherwise the adapter's patterns are published and
  localisation is marked *read from text* (§5).

**Deferred:** none.

**Other changes.** The adapter mutates the store on disk, never an export
(§6.2). The validity-bucket mapping (§5). Open questions move to 0.3.

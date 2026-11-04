# GBS-AUDIT 0.1: spec gaps found running it on gnomon v0.4.1

Each gap names the section, what the spec says, what could not be followed
or which assumption failed, what this run did instead, and a proposed
wording for 0.2.

### AUDIT-1: "Ordinary session" is undefined, and a no-model run cannot produce one
- **§6.1:** "A real trail … from an ordinary session that ended normally,
  produced by a pinned build. A synthetic trail is not accepted." §5 asks for
  false positives over "N ≥ 20 untampered sessions from ordinary use".
- **Problem:** with no model calls allowed, the sessions were driven by a
  scripted fake model through the real harness. The trail is real: the pinned
  build wrote every record. The session is not "ordinary use", and the spec
  does not say whether a scripted model counts.
- **Done instead:** scripted sessions with five scripts of 0–4 tool calls,
  disclosed as such.
- **Proposed 0.2 wording:** "A trail is *real* when the pinned build wrote
  every record in the course of a session that ended normally. The session
  MAY be driven by a scripted model. The result states the driver: scripted,
  or a named model. The false-positive corpus SHOULD include ≥ 20 sessions
  driven by a real model, from at least two task types; a scripted-only
  corpus is reported as such."

### AUDIT-2: Exit status vs a printed verdict — which one is "non-success"?
- **§5:** detected = "the verifier returns a non-success verdict (an exit
  code, or a field the documentation names)".
- **Problem:** gnomon prints `NOT SEALED` and "N later record(s) not anchored
  yet" and still **exits 0**. That covers T1 on `off`, I1 everywhere, and
  rfc3161 D3 (`NOT ANCHORED`). The `or` lets a printed word count as
  detection, but a CI gate reads the exit status. The two readings give
  different headlines (I1: 0/4 vs 4/4).
- **Done instead:** the exit status was pre-registered as the verdict, and
  the printed flags were reported in their own "U (text)" column.
- **Proposed 0.2 wording:** "The verdict is the verifier's machine-readable
  outcome: its exit status, or a named field of a documented structured
  output. Text a person must read is reported as *flagged, not failed* and
  never counted as detected."

### AUDIT-3: The levels table and the reference results disagree on D2
- **§4** lists D2 (remove a whole unit) at A1. **§8**'s results table puts
  D2 in the A3 column.
- **Done instead:** the §4 taxonomy was followed, so D2 is A1.
- **Proposed 0.2 wording:** fix §8 to match §4, and state that "the
  taxonomy in §4 is normative; tables elsewhere are illustrative."

### AUDIT-4: How much the A3 attacker deletes is unspecified, and it changes the score
- **§4 R2/C1:** "delete the local anchor state". **D3:** "remove the
  integrity evidence".
- **Problem:** deleting all of it (every trail's heads or receipts) makes
  other units fail, and the verifier exits 1 without the forged target ever
  failing. Deleting only the target's evidence is not caught (K1 here). The
  same case can be "detected" or "undetected" depending on how surgical the
  attacker is, and the spec says "best move" only for the witness.
- **Done instead:** the whole-state deletion was pre-registered. Results are
  scored as pre-registered, the collateral catch is flagged in the README,
  and K1 stands in for the surgical move.
- **Proposed 0.2 wording:** "A3 cases are run with the attacker's best move:
  deleting or replacing only the evidence about the target unit. A
  whole-directory variant MAY be reported beside it. A detection that names
  only units the attack did not target is scored *collateral*, not
  *detected*."

### AUDIT-5: C1 asks the attacker to "set the clock", which needs root
- **§3 A3:** "Set the clock". **§4 C1:** "R2 with the local clock set back".
- **Problem:** without root (and with no libfaketime installed) the system
  clock cannot be set, and gnomon's CLI reads the real clock.
- **Done instead:** the forged anchor was delivered through gnomon's own
  `flushAnchors` with `now` an hour back (git committer date −1 h), and the
  re-signed head's `ts` was set an hour back.
- **Proposed 0.2 wording:** "C1 MAY be run by injecting the skewed time at
  the harness's own time source (a library clock, a faketime shim, or a VM
  clock). The method is stated. What is tested is that the forgery's
  evidence claims an earlier time, not how that was arranged."

### AUDIT-6: "The affected unit" is not one fixed thing per case
- **§5:** detected-and-localised means the verdict "names the affected
  unit".
- **Problem:** the runner scored every case against the session-2 target,
  but some cases have a different affected unit. B1 (rollback) removes the
  newest session, so the affected unit is session 3. D3 changes no unit's
  records at all.
- **Done instead:** after outcomes were read, B1 was re-scored against
  session 3 and D3's localisation was set to n/a. Logged as a deviation;
  detection is unchanged.
- **Proposed 0.2 wording:** add an "affected unit" column to §4: "E/I/D1/T/O/R/K:
  the edited unit; D2: the deleted unit; D3: none (localisation n/a); B1:
  every unit absent from the restored state".

### AUDIT-7: Anchoring that never completes is an apparatus hazard the spec does not mention
- **§6–7:** the witness configuration is pinned. Nothing says to confirm that
  every head was actually delivered before the case starts.
- **Problem:** v0.4.1 left a stale `anchors/flush.lock` after 22/22 anchored
  sessions. Without a drain step, R1/R2 could have run against a witness that
  had never received the genuine head, and they would have scored "missed"
  for the wrong reason.
- **Done instead:** the runner drains anchors until `gnomon audit anchor`
  reports nothing queued, removes stale locks, and counts them.
- **Proposed 0.2 wording:** "Before any case, the control's evidence is
  confirmed delivered: for an anchored harness, every sealed head is on the
  witness. A head still queued is an apparatus failure, not a miss."

### AUDIT-8: One required case per adversary level gives intervals too wide to compare
- **§5:** the headline is caught/required per level. A1 has 7 cases, A2 3,
  A3 2–6.
- **Problem:** the cases are deterministic, so repeating them adds nothing,
  and 2/3 vs 3/3 carries Wilson intervals of [0.21–0.94] vs [0.44–1]. The
  headline cannot separate configurations by statistics, only case by case.
- **Done instead:** the intervals are reported, and the per-case table
  carries the comparison.
- **Proposed 0.2 wording:** "Because cases are deterministic, results are
  compared case by case, never by the ratio's interval. Variation comes from
  more units (≥ 3 trails of different shapes, mutation points at the start,
  middle and end), each reported."

### AUDIT-9: The results path in the README template is not the one used here
- **README "How to submit":**
  `benchmarks/standards/results/<spec-id>/<date>-<harness>-<submitter>/`.
- **Done instead:** this run lives at
  `benchmarks/results/gbs-2026-11-04/audit/`, as the run's brief asked.
- **Proposed 0.2 wording:** settle one path, and add "a result outside it
  links from it".

### AUDIT-10: No structured output for the verifier makes localisation a text-matching exercise
- **§5:** L1–L3 are read from "the verdict". gnomon's `audit verify` has no
  `--json`. Localisation was read with regular expressions over prose, partly
  on stderr (the capture-order deviation).
- **Proposed 0.2 wording:** "A harness SHOULD expose its verifier's verdict
  as structured output naming unit, record range and time bound. Where it
  does not, the adapter publishes the patterns it used, and localisation is
  marked *read from text*."

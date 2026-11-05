# GBS-AUDIT 0.2 (draft): opencode v2.2.5's session store, and gnomon v0.4.2: 2026-11-05

**Answer.** opencode v2.2.5 documents no verifier for its session store, so every case scores
**undetected, no verifier** (§6.3). That is 0/6 at A1, 0/1 at A2 and 0/1 at A3, with 8 cases N/A
because no record carries an integrity value, chain, signature or anchor. Every mutation took
effect in the store.

Run afterwards as a diagnostic (`opencode session export --standalone`, as a user would run it,
not scored), opencode presented the mutated session as its own:

- An edited field (E1) and forged records (I1, I2) came back in the export, with exit 0.
- A deleted record (D1), truncation (T1) and reordering (O1) exported with exit 0 and no remark.
- A deleted session (D2) and a rolled-back store (B1) answered `Session not found` (exit 1). That
  is the same answer as for a session that never existed, not a tamper verdict.

gnomon v0.4.2 (`gnomon audit verify`, exit status as the verdict), same day and same container
image, by configuration:

| Configuration | A1 | A2 | A3 | Missed |
|---|---|---|---|---|
| off | 5/7 | 2/3 | 0/2 (4 N/A) | D2, T1 (printed, exit 0), R1, D3, B1 |
| attest | 6/7 | 3/3 | 3/5 (1 N/A) | D2, K1, B1 |
| git anchor | 7/7 | 3/3 | 5/5 (1 N/A) | none |
| rfc3161 | 7/7 | 3/3 | 3/5 (1 N/A) | D3 (printed `NOT ANCHORED`, exit 0), B1 |

Compared with v0.4.1, A2 rose by one case in every configuration. I1, a correctly forged append
after the seal, now fails with exit 1 (CHANGELOG 0.4.2). False positives were 0 of 48 untampered
sessions, and no stale anchor lock was left (v0.4.1 left one 22 times out of 22).

**What this does not show.**

- **Not a ranking.** opencode's store was not designed as a tamper-evident record, and opencode
  does not claim one. The row says only that its trail can be changed after the fact without a
  documented check noticing (§1).
- **The trails are scripted.** All sessions were scripted (AUDIT-1, driver stated), and there is
  no real-model false-positive corpus (system level).
- **Witnesses are stand-ins.** gnomon's witnesses are local stand-ins: a bare repository and a fake
  TSA.

| Pre-registration | [PRE-REGISTRATION.md](PRE-REGISTRATION.md) @ `181c8f2e` | first trial 2026-11-05T14:08:29Z (opencode), 14:08:51Z (gnomon) |
|---|---|---|
| Builds | opencode v2.2.5; gnomon `0.4.2+v0.4.2-2498d16` | |
| Trails | opencode: SQLite `~/.local/share/opencode/opencode.db`. 3 sessions of 8, 10 and 9 records; the unit is a session, a record is a `session_message` row (2.2.5 keeps content in its `data`; `session_part` was empty). gnomon: `.gnomon-audit/` from the 0.1 runner's scripted sessions | target: session 2 of 3 |
| Adapter | [`audit_oc.py`](audit_oc.py): `load`/`save` over SQL, `rehash` absent, `anchor_state` empty | gnomon: the 0.1 adapter |
| Isolation | Docker `--network none` | |

## opencode, per case

| case | level | result | `session export` afterwards |
|---|---|---|---|
| E1 edit a field of a middle record | A1 | undetected, no verifier | exit 0, forged text present |
| E2, E3, R1 | A1/A2 | N/A (no integrity value or chain; E2 and R1 equal E1) | |
| I1 append a forged record | A2 | undetected, no verifier | exit 0, forged record present |
| I2 insert a record in the middle | A1 | undetected, no verifier | exit 0, forged record present |
| D1 delete a middle record | A1 | undetected, no verifier | exit 0 |
| D2 delete the session | A1 | undetected, no verifier | exit 1 `Session not found` |
| T1 remove the last two records | A1 | undetected, no verifier | exit 0 |
| O1 swap two records | A1 | undetected, no verifier | exit 0 |
| D3, R2, C1, K1, K2 | A3 | N/A (no evidence, anchor, signer or witness) | |
| B1 restore the store as of session 2 | A3 | undetected, no verifier | exit 1 `Session not found` (session 3) |

## Traces

- **opencode:** [`../raw/audit-opencode/`](../raw/audit-opencode/), with the card and the three
  control sessions as exported.
- **gnomon:** [`../raw/audit-gnomon/`](../raw/audit-gnomon/), with `cases.json`, the control
  trails and every verifier output.

SHA-256s are in [`../raw/SHA256SUMS`](../raw/SHA256SUMS). Per-level detail:
[`summary.json`](summary.json).

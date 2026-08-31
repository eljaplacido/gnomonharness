# T1 — adversarial tamper-evidence

**2026-08-31.** Nine tampering strategies against a real gnomon audit trail. $0.

gnomon's headline differentiator is a hash-chained, tamper-evident record, and it
had never been attacked. This is the first measurement of it.

## Result — 8 of 9 detected, 9 of 9 matching expectation

| Attack | Detected |
|---|---|
| edit a field mid-chain | ✅ |
| delete a record | ✅ |
| reorder two records | ✅ |
| append a forged record | ✅ |
| **truncate the tail** | ✅ *(only after the fix below — originally MISSED)* |
| strip one record's hash | ✅ |
| insert a hash-less record | ✅ |
| edit and recompute that record's hash | ✅ |
| **full rewrite (re-chain every record)** | ❌ *expected, see limits* |

## What this found

**Truncation was invisible.** Chain integrity cannot see it: lop the last records
off and every surviving hash still matches its neighbour, so `verifyTrail`
returned `ok: true` on a trail whose ending had been deleted. That is the worst
possible blind spot for an audit trail — the tail is what happened *last*, which
is the part anyone tampering would want gone.

The trail already ends with a `session_end` record; verification simply never
checked for it. `VerifyResult` now carries `sealed` **separately from `ok`**,
because an unsealed trail has two very different causes — someone removed the
tail, or the process was killed before writing one — and this harness kills runs
that way itself. Rule 4 applied to gnomon's own diagnostics: report both facts,
let the reader decide, do not emit a composite verdict.

## Where the guarantee ends

**A full rewrite is undetectable, by construction.** Anyone who can write the
file can edit a record, recompute every subsequent hash, and produce a trail that
verifies perfectly. Hash chaining proves *internal consistency*; it cannot prove
*authenticity* without an anchor outside the file — a signature, a witnessed
head, or an append-only store.

This is stated so nobody reads "tamper-evident" as "tamper-proof". The chain
defends against casual and partial edits, which is a real property and the one
that catches accidental corruption and opportunistic editing. It does not defend
against an adversary with write access and knowledge of the format.

Closing that gap needs signed records or an external anchor, and is the honest
next step for the auditability claim.

## Reproducing

```bash
node tamper.mjs <path-to-a-real-trail.jsonl>
```

Needs a trail of ≥6 records with chaining on. `sample-trail.jsonl` is a real one
from a live local-model run. `results.json` holds the machine-readable outcome.

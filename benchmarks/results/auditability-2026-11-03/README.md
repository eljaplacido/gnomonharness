# T1b — tamper evidence with an external anchor

**2026-11-03.** The nine attacks of
[auditability-2026-08-31](../auditability-2026-08-31/), re-run with
`[audit.anchor]` (GV4 in the 2026-11 state-of-the-art report). $0, no model,
no network.

## Result

| Arm | The nine | Beyond the nine |
|---|---|---|
| **off** (no anchor; the 2026-08-31 measurement) | **8/9**, full re-chain missed (unchanged) | whole trail deleted: missed. Re-chain re-anchored with a slow clock: missed |
| **git** witness, attacker who knows about anchoring | **9/9** | whole trail deleted: caught. Slow-clock re-anchor: caught |
| **rfc3161** authority, attacker edits the trail only | **9/9** | — |
| **rfc3161**, attacker also deletes the receipts and re-stamps the forgery | **8/9**, full re-chain missed | — |

The headline: **9/9 with a git witness, against the strongest attacker in
the suite.** That attacker rewrites the trail and recomputes every hash. It
deletes gnomon's local anchor state, and tries to force-push a history without
the original anchor, which the witness refused 11 times out of 11. It then has
the forged head anchored exactly as gnomon would. The original anchor is still
in the witness's history and no longer matches, so `gnomon audit verify`
reports `RE-CHAINED`. It names the anchored and current hashes, the seq range
the change is in, and the time after which it was made. It also reports that
the rewrite was anchored later.

Seven of the nine are still caught by the chain and the seal alone, as
before. Truncation is caught by both. The anchor adds the full re-chain.
Beyond the nine, it also catches a deleted trail: the witness names a trail
that is gone. It catches a re-anchor made with a clock set back an hour,
because the witness's history order is evidence of sequence whatever the
committer date says.

## The limit this run publishes

The **rfc3161-aware** arm is 8/9 on purpose. A time-stamp token proves *when*
a head existed. The token is kept on the machine that was attacked, so an
attacker who deletes it and has the rewritten head stamped afresh leaves a
trail that matches its only anchor. Against an attacker who knows the format,
use a witness that keeps its own copy: the git backend, or a `cmd` witness
whose verify command asks the witness. Use RFC 3161 for trusted time, not as
the only copy. `docs/CONTRACTS.md` §21 says the same.

## Found while building it

**`receive.denyNonFastForwards` and `receive.denyDeletes` protect
`refs/heads/*` only.** The first default ref was `refs/gnomon/anchors`. A forced
push to it, on a bare witness with both settings on, was **accepted**, and the
original anchor was gone. git's receive-pack applies both checks to branches
only, and so do hosted branch protections. The default is now
`refs/heads/gnomon-anchors`. A ref outside `refs/heads/` is reported as a
problem at every session start. `anchor.test.ts` pins both behaviours of git
itself, so a future git that changes them breaks a test rather than the
guarantee.

## Latency: does the turn pay anything?

`latency.mjs`, interleaved off/on, linux/arm64 (GB10, shared with other
work; `nice -n 19`). Raw numbers are in `latency.json`.

| Measure | off p50 | on p50 | off p95 | on p95 | ms |
|---|---|---|---|---|---|
| `tool_call` record (the turn path) | 0.013 | 0.013 | 0.064 | 0.058 | |
| `session_end` write (the seal: one queue file) | 0.012 | 0.041 | 0.048 | 0.183 | |
| `writeCheckpoint` + scheduling the detached delivery | 3.3 | 7.8 | 23.3 | 24.1 | at session end |
| whole `runTask`, stub model | 16.3 | 25.7 | 65.2 | 73.8 | n = 10 |
| the turn record's own `duration_ms` | 11 | 12 | 57 | 34 | n = 10, ms resolution |

**The turn path is unchanged.** A `tool_call` record costs the same, the
turn's own duration does not move, and no witness is contacted before the
session ends. The seal adds about 0.03 ms, the queue file. Session end adds
about 5 ms, the cost of starting the detached `gnomon audit anchor
--background`, which then delivers on its own clock. That is most of the
whole-task difference. The rest is 10 samples on a loaded machine: read the
whole-task row as an upper bound, not as a measurement of anything finer. All
30 deliveries started here completed, batched into 6 commits on the witness,
with nothing left queued. Session start spawns nothing unless it announces a
backlog: an earlier run of this script, before that rule, started a delivery
at every session start, and paid for it there.

## Reproducing

```bash
pnpm -r run build
node tamper.mjs                 # exits 1 unless every arm matches its expected figure
node latency.mjs --n 200
```

`tamper.mjs` takes a trail path (default: the 2026-08-31 `sample-trail.jsonl`)
and writes `results.json`. The attack list is the 2026-08-31 script's,
verbatim, and `packages/gnomon-core/src/anchor.test.ts` holds the names to
that script. The same test runs the off and git arms (8/9 and 9/9) in CI.

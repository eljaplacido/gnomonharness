# Pre-registration: GBS-AUDIT 0.2 (draft): opencode v2.2.5's session store, and gnomon v0.4.2

Committed before the first measured trial. Deviations are logged below, with time.

Spec: [AUDITABILITY.md](../../../../docs/benchmarks/AUDITABILITY.md) 0.2 (draft). Level:
**harness** (scripted sessions, AUDIT-1: the driver is stated). Result type: **profile**.

**Disclosed before running (principle 14).** Both runners were smoke-run once and read
([`../smoke/audit-opencode.json`](../smoke/audit-opencode.json),
[`../smoke/audit-gnomon-cases.json.gz`](../smoke/audit-gnomon-cases.json.gz)). Not blind.

## Question and claim sought

Can the record of what the agent did be changed or removed after the fact without a documented
verifier detecting it? Per harness, per adversary level: caught / run, N/A counted apart.

## Arms

| arm | trail | verifier | runner |
|---|---|---|---|
| opencode v2.2.5 | its own session store, SQLite `~/.local/share/opencode/opencode.db`. Unit = a session (`session_v2` row); record = a `session_message` row (2.2.5 keeps a record's content in its `data`; `session_part` is empty). Three sessions of different shapes (8–10 records), written by the pinned build, driven by the scripted model | **none documented** (`--help`: `session list/delete/export/import`). Every case scores **undetected, no verifier** (§6.3). Diagnostic only: `opencode session export --standalone <id>` and `session list` after each mutation, to show what opencode then presents | [`audit_oc.py`](audit_oc.py) |
| gnomon v0.4.2 | `.gnomon-audit/` trails from scripted sessions, configurations off / attest / git anchor / rfc3161 | `gnomon audit verify`, exit status is the verdict | the 0.1 runner, verbatim except three environment overrides ([`gnomon/run_audit.mjs`](gnomon/run_audit.mjs)) |

## Cases

§4's taxonomy. For opencode: E1, I1, I2, D1, D2, T1, O1 and B1 are run; E2, E3, D3, R1, R2,
C1, K1, K2 are **N/A** with the reason (no integrity value, chain, signer or anchor exists) and
counted apart, never as passes. The target is session 2 of 3; B1's affected unit is session 3.

## Expected

opencode: every run case undetected, no verifier. gnomon v0.4.2: as 0.1, except I1, which v0.4.2
fails with exit 1 (CHANGELOG 0.4.2).

## Peer notice, conflicts

No maintainer notified yet; held 14 days after notice. Author-run.

## Deviations log

| time (UTC) | change | before/after reading outcomes | reason |
|---|---|---|---|
| 2026-11-05T14:04–14:12Z | The analysis scripts (`chaos/analyse.py`, `overhead/analyse.py`, `governance/analyze.py`, `audit/summarise.py`) and `common/make_results.py` were written after the pre-registration commit, while the first blocks ran. Progress lines of `chaos-opencode-1` and the endpoint lane check had been seen; no aggregate outcome had been read. Each implements the analysis this file states | before | they did not exist yet |
| 2026-11-05T17:02Z | Raw outputs compressed (`*.jsonl.gz`, `work.tar.gz`) and checksummed (`raw/SHA256SUMS`); the analyses re-run on the compressed files with identical output | after | repository size |

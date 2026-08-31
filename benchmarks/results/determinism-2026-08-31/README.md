# T2 — surface-replay determinism

**2026-08-31.** $0. The claim no other harness can even express: *the same surface
decides the same behaviour, on any machine.* Rules 1 and 2 exist to make it true;
it had never been tested.

## Method

Fingerprint the **declared behaviour** a surface produces without calling a model:
for every role its resolved model / endpoint / temperature / limits and the sorted
tool schema it would be sent, plus the role each of an 11-input corpus routes to,
plus the resolved inference target. Then read the same surface back under
conditions that differ in every way *except* the surface. Anything that shifts is
machine-scoped behaviour — the one thing Rule 1 forbids.

## Result — 10/10 as expected

| Perturbation | Declared behaviour | Surface hash |
|---|---|---|
| baseline | stable | stable |
| different cwd | stable | stable |
| surface copied to a new absolute path | stable | stable |
| `LC_ALL=tr_TR.UTF-8` | stable | stable |
| `LC_ALL=C` | stable | stable |
| `TZ=Pacific/Kiritimati` | stable | stable |
| `HOME` elsewhere | stable | stable |
| `XDG_CONFIG_HOME` set | stable | stable |
| all mtimes changed | stable | stable |
| `GNOMON_MODEL_URL` set | **differs** *(declared override)* | stable |

Determinism holds. This is the strongest evidence yet for the Rule 1 / Rule 2
claim, and it is a dimension with no public benchmark — nothing else to compare
against, because no other harness makes the claim.

## What it exposed

**Two real defects, both found by the last row.**

**1. Behaviour changed while the hash did not.** `DESIGN.md` states *"If behaviour
changed, the hash changed, and the diff says which file moved."* `GNOMON_MODEL_URL`
replaces the declared endpoint URL at resolve time, so inference goes somewhere
else while the surface hash is byte-identical. The loop announces the override on
the console — but a console line is not a record. The audit trail stored only the
endpoint *name*, so two runs that reached different servers produced
indistinguishable trails. The turn record now carries `endpoint_url` and
`endpoint_overridden`.

**2. Tool sorting was locale-dependent.** Rule 3 says tool schemas are "declared,
sorted, hashed". The sort used `localeCompare`, which routes through ICU, whose
collation tables differ between Node builds (small-icu vs full-icu) and ICU
versions — so the hash could depend on which Node compiled the harness.
`config.ts` already sorts manifest *paths* byte-wise and records that this exact
bug once made the Rust and TypeScript surface-hash implementations disagree; the
tool sort had simply been left behind. Demonstrated divergence on realistic names:
`["Read", "mcp__fs__read", "read"]` orders differently under the two, and MCP tools
carry exactly that shape of name. Now byte-wise, matching the paths.

Neither would have been caught by a benchmark that only measured task completion.

## Reproducing

```bash
node run.mjs <path-to-a-project-with-.gnomon>
```

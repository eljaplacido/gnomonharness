# docs/bench-kit

## Added

- `benchmarks/kit/`: a public benchmarking kit, so anyone can benchmark their own harness the
  way gnomon benchmarks itself, or evaluate gnomon's governance properties on their harness.
  Gnomon-only: it contains no results about any harness; the only numbers come from a seeded
  synthetic example.
  - `METHOD.md`: the method on one page (pre-register before any cell; pin the build by
    SHA256SUMS hash; one variable per arm; paired seeded waves; the task as the unit; exact
    McNemar on full solves; 10,000-resample task-cluster percentile bootstrap; sign-flip
    permutation; a pre-declared non-inferiority margin; verdict words better / worse /
    non-inferior / not shown, never "equal"; fix-don't-fail re-runs; A/A noise floor; cost
    metered on the wire).
  - `PRE-REGISTRATION.template.md`: a fill-in template, committed alone before the first cell.
  - `analyze_paired.py`: standard-library-only, deterministic analysis of a CSV/JSONL of cells
    (`task,wave,arm,valid,solved,hidden_share,usd`); `NNr` re-run waves replace the originals
    for every arm; prints the contrasts and verdicts, optionally JSON. 24 unit tests
    (`python3 -m unittest discover -s tests`) and a synthetic three-arm example with an A/A arm
    and its expected output.
  - `relay-meter.mjs`: a dependency-free metering relay (tokens and dollars from the usage the
    server reported, Chat Completions / Responses / Anthropic Messages, per-cell attribution,
    placeholder-key injection, dated price table). Responses are metered incrementally, line by
    line as they stream, so a long Anthropic stream keeps the input and cache tokens of its first
    event (`message_start`) and a Responses `response.completed` line or a non-streamed body of
    any realistic size is parsed whole (bound 64 Mi characters; past it the call is counted as
    unmetered, never partly metered). 12 tests, including streams over 256 KB in each wire format
    (`node --test benchmarks/kit/tests/relay-meter.test.mjs`).
  - `ADAPTER-RECIPE.md`: wrapping any harness for Harbor / Terminal-Bench (install pinned by
    SHA256SUMS, unattended flags, deadline handling, audit/trace on, traffic through the meter).
  - `standards/`: the gnomon Bench Standards v0.2 spec text (GBS-OVERHEAD, -CHAOS, -AUDIT,
    -GOVERNANCE, -LAYER v0.0, -HYBRID, -REPORTING), with every reference result, status table,
    campaign link and changelog removed.
  - `README.md` maps the existing governance property suites in `benchmarks/` (chaos, audit,
    governance, containment, injection, guard/check, overhead, determinism) to what to change to
    run each against another harness.

## README notes

- Suggested line for the root README's benchmarks section (and/or `benchmarks/README.md`):
  "Benchmark your own harness the way gnomon benchmarks itself: [benchmarks/kit/](benchmarks/kit/README.md)
  (method, pre-registration template, a stdlib analyzer, a wire-metering relay, the GBS specs)."

## For the owner (not done here)

- `docs/benchmarks/` on master still holds the GBS **v0.1** text, and it links to the public
  `bench/peers-2026-11` branch in several places (counted on this branch: GOVERNANCE.md 6,
  HYBRID.md 6, OVERHEAD.md 3, ROADMAP.md 2, README.md 1, FINDINGS-2026-11-04.md 1) and carries
  November 2026 peer figures. Those links break when the bench/* branches are deleted, and the
  figures fall under the "strip November peer data" policy. `benchmarks/kit/standards/` is a
  clean v0.2 copy that could replace them, or the v0.1 files could get the same treatment.
- Optional: run the kit's tests in CI (`cd benchmarks/kit && python3 -m unittest discover -s tests`;
  `node --test benchmarks/kit/tests/relay-meter.test.mjs`). They take about 4 s together and need
  no network.

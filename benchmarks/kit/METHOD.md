# Method: paired harness benchmarks, on one page

These are the rules gnomon's own benchmark campaigns run under. Each one exists
because breaking it once produced a number that was wrong. [`analyze_paired.py`](analyze_paired.py)
implements the analysis half; the rest is discipline that no script can enforce for you.

## Before any cell

1. **Pre-register before the first cell.** Copy [PRE-REGISTRATION.template.md](PRE-REGISTRATION.template.md),
   fill every `{{…}}`, and commit it alone. The commit is the timestamp. The runner should
   refuse to start while the file is missing, still holds a placeholder, or differs from its
   committed version. Everything after that is an amendment: timestamped, and marked as written
   before or after any outcome was read.
2. **Pin the build by hash.** Install from release artifacts checked against the release's
   `SHA256SUMS`, whose own hash is pinned; check the installed `--version` or build stamp; write
   the pinned identity into every cell's record. `latest`, `stable` and a branch name are not
   versions. Containers that `git clone` get the default branch, not your fix. Pin the other
   harnesses, the task set and the benchmark runner the same way.
3. **One variable per arm.** Arms differ in exactly one declared setting, and the configuration
   hash diff between them shows nothing else. Include a control: the new build with the old
   setting, so a harness change and a model change are never confounded.
4. **Know the noise floor.** Run an **A/A arm** (the same configuration twice, in the same waves),
   or repeat a baseline on another day. Same code, same model, same flags flipped ~15% of task
   outcomes in gnomon's campaigns. State the minimum detectable effect from that before spending;
   if it exceeds the effect you care about, the run cannot answer the question. Say so first.

## Running

5. **Paired, seeded waves.** A *wave* is one task, one attempt, every arm, started together on
   the same host. Task order per attempt is drawn from a seeded generator (for example
   `random.Random(seed + attempt)`), attempt-major; arm start order is seeded and rotated per
   wave. Equal clocks, permissions and endpoints for every arm, asserted, not assumed.
6. **Meter cost on the wire.** Every arm's model traffic goes through a metering relay
   ([relay-meter.mjs](relay-meter.mjs)); cost is computed from the usage the *server* reported,
   priced from a dated table. Never from the harness's own account, and never two telemetry
   sources in one comparison. A response without usage is counted as unmetered, not as free.
   Spend on invalid and re-run cells is reported too.
7. **Validity is decided by rule, not by outcome.** Fix the rule in the pre-registration. An
   *apparatus failure* (no verifier reward, no model response with usage, wrong build in the
   record, infrastructure or transport death, quota refusal, a watchdog kill) makes a cell
   **invalid**. A wrong answer, a refusal by the agent, or hitting the time cap is a **valid
   failure** and stays in the denominator. Validity buckets must sum to the cells run.
8. **Fix, don't fail.** An invalid cell is never a result. Fix the apparatus (or the harness
   defect that broke it), then re-run the **whole wave**, every arm on that task, as `NNr`; a
   re-run that is itself invalid becomes `NNrr`. The deepest re-run replaces the earlier tries
   for every arm. A degraded arm gets its infrastructure fixed and is re-run on the current
   build, not left as "invalid" and not read as a capability result. Scrutinise every arm the
   same way: mining one arm's traces for excuses moves the estimate toward the other.

## Analysis

9. **The task is the unit.** Per task and arm, average that arm's valid attempts; a task enters
   a contrast only if both arms have a valid cell on it. Never collapse attempts with `any()`.
10. **Full solves:** exact two-sided **McNemar** over the discordant paired cells (same task,
    same wave), plus the bootstrap interval below. *Better* only if p < α **and** the interval
    lies above 0.
11. **Intervals:** a **10,000-resample task-cluster percentile bootstrap** (resample tasks, not
    cells) with a fixed seed, beside a **sign-flip permutation** p-value and test-inversion
    interval (exact up to 16 tasks, seeded Monte Carlo above). Below 6 tasks a sign-flip test
    cannot reject at α = 0.05: the interval is reported as open.
12. **Hidden-test share** (the fraction of a task's hidden tests passed): *better* only if both
    intervals lie above 0. **Cost** ($/cell; $/solve as a ratio of totals): lower is better,
    same rule, no margin.
13. **Non-inferiority needs a margin, declared in advance** (default 10 points). *Non-inferior*
    only if both intervals' lower ends lie above −margin.
14. **Verdict words:** **better**, **worse**, **non-inferior**, **not shown**. Never "equal",
    "tie" or "same": a difference that was not detected was not shown to be zero. With several
    hypotheses, pre-register a fixed order and stop at the first one not shown; the rest are
    descriptive. An A/A pair that comes out *better* or *worse* means the apparatus differs
    between arms, and no other contrast is read until that is explained.
15. **Mechanism beside outcome.** Declare, for each change, a mechanism metric the design can
    resolve (for example false-finish rate, cap rate, requests carrying a setting) and the score
    metric it probably cannot. A mechanism win with no score movement is an honest partial
    result, if it was declared first. Interim looks are descriptive only.

## Checklist

```
[ ] PRE-REGISTRATION.md committed alone, before any cell; amendments timestamped
[ ] Build pinned by SHA256SUMS hash, artifacts and --version; recorded per cell; others pinned too
[ ] Arms differ in one setting (config-hash diff); control arm present
[ ] A/A arm or day-to-day repeat budgeted; MDE stated before spending
[ ] Waves paired and seeded; clocks, permissions, endpoints equal across arms
[ ] Wire relay on every arm; dated price table; unmetered responses counted
[ ] Validity rule written down; buckets sum to n; invalid cells re-run as NNr, never dropped
[ ] analyze_paired.py run with the pre-registered seed, margin and pairs; output committed
[ ] Verdicts use only better / worse / non-inferior / not shown
```

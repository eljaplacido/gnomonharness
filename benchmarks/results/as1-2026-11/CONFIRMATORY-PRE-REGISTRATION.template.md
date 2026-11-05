# AS1 stage C: {{C* name}} vs the control vs opencode V2 on all 29 P2G tasks, k = {{3 or 2}} (pre-registered {{date}})

<!-- TEMPLATE. Copy to CONFIRMATORY-PRE-REGISTRATION.md, replace every {{...}}, commit it alone, and only then run
     `run_as1.py run --stage confirm`. The runner refuses while the file is missing, holds a {{placeholder}}, or differs
     from its committed version. Everything not in braces below was fixed on 2026-11-05 in PRE-REGISTRATION.md §6 and
     may not change here. -->

Committed before any stage-C cell. Later changes go in timestamped addenda at the end.

## What is being confirmed

- **C\*** = the control ({{CTL.A or CTL.B}}) + {{fragments, e.g. GC + W}}, chosen by the pre-registered interaction-stage
  rule: `CHOICE.json` at commit {{sha}} (combination {{0/1 key}}, posterior mean {{x}}, P(effect > 0) {{p}}).
- Stage S and I results that led here are exploratory ({{ledger round count}} rounds, ledger head {{sha}}, data hash
  {{hash}}); they are restated here for context only and are never pooled with stage C.
- **Build:** {{version}} = {{commit}} ({{build_stamp}}), pinned three ways (`apparatus/build.toml` at {{sha}});
  wire test {{wiretest sha256}}.
- **opencode V2:** `p2_agents:OpencodeV2`, {{version as recorded per trial}}.

## Design (fixed in PRE-REGISTRATION.md §6)

- Three arms per wave, concurrently: C\*, the control, opencode V2; slots and start order rotated per wave.
- All 29 P2G tasks; {{3 or 2}} passes, each over the 29 tasks in `random.Random(100 + pass)` order; 1,800 s cap;
  deepseek-v4.1-flash via OpenCode Go; P2G's Harbor flags; the AS1 validity rule and scoring (§3.2); no wave in a 2×
  window; the stage cap ${{65 or 40}}, a wave only if spend + $2 ≤ cap. A budget stop keeps complete passes only for
  the primary analysis; a partial pass is a sensitivity analysis.
- Invalid cells: re-run once in a later wave with all three arms on that task ("fix, don't fail").

## Analysis (fixed)

- Unit: the task. Per task, attempt-averaged hidden-test fraction and solve rate per arm (valid cells only); a task
  is in a comparison only if both arms have at least one valid cell on it.
- Paired per-task differences; task-bootstrap 95% interval (10,000 resamples, seed 20261111) and exact sign-flip test
  and interval, with the functions of `benchmarks/analysis/paired.py` at analysis-st commit 53bfc9c4
  (`boot_ci`, `signflip_ci`, `signflip_p`, `binom_two_sided`), loaded from that commit by
  {{analysis script path + commit}}.
- Solved: exact McNemar on discordant cell pairs (pass-matched) and on tasks (any-solve), reported both.
- **Non-inferiority margin: 10 points**, on fraction and on solved: "non-inferior" only if the 95% interval's lower
  bound of (C\* − comparator) > −0.10.
- **Fixed sequence, α = 0.05 each; stop at the first hypothesis not shown; the rest are descriptive:**
  1. C\* vs control, fraction: superiority (lower bound > 0).
  2. C\* vs opencode, fraction: non-inferiority at 10 points.
  3. C\* vs opencode, solved: non-inferiority at 10 points.
  4. C\* vs control, solved: superiority.
- **Guards:** per-arm capped and false-finish rates with paired differences. C\* is not recommended as a default if its
  cap rate exceeds the control's by more than 10 points (paired), whatever its fraction.
- Secondary, descriptive: $/cell and $/solved from the wire, wall time, the mechanism counters of C\*'s fixes.
- Power (SIZING.txt): MDE80 vs the control ≈ {{0.11 at k = 3 / 0.12 at k = 2}}; P(non-inferiority to opencode shown |
  true parity) ≈ 0.3. "Not shown" is never written as "trails" or "equal".

## Addenda

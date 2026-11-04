# P2G41: P2G's 29 tasks on gnomon v0.4.1, as released and with the hosted recipe, beside a concurrent opencode (pre-registered 2026-11-04)

This is an amendment to P2G (`../p2g-2026-11/PRE-REGISTRATION.md`). It supersedes the drafted v0.4.0 gnomon-only
amendment, which was never run.

It was committed before any P2G41 cell. Later changes go in timestamped addenda.

## Why

- **The user's instruction (2026-11-04):** benchmark arms run on the current gnomon build, never on an old one. P2G's
  gnomon row is v0.3.1, which had the transport defect fixed in v0.4.0.
- **v0.4.1:** released 2026-11-04 (tag v0.4.1 = c511b810). Its default model requests are byte-identical to v0.4.0 (release
  gate, #145).
- **H1 and H2** (`../h1-2026-11`, `../h2-2026-11`):
  - the hosted recipe removes timeouts and halves step length;
  - run concurrently on 12 tasks, gnomon with the recipe and opencode were within one task: 2 vs 3 solved, hidden tests 82%
    vs 85%;
  - a time-separated comparison misleads in both directions.

## Arms (all three per task, concurrently, P2G relay slots 0–2 rotated per wave)

- **A41:** gnomon v0.4.1 release defaults (`gnomon_harbor_v041.GnomonV041`, pinned by SHA256SUMS
  923adc6f…, the gnomonBuild stamp v0.4.1-c511b81, and `--version`). This is the updated P2G gnomon row.
- **B41:** v0.4.1 plus the hosted recipe (`gnomon_harbor_v041h.GnomonV041Hosted` = GnomonV041's install + H1 arm B's
  `run()` byte for byte):
  - replay_reasoning = true;
  - max_context_tokens = 1,000,000;
  - nudge_after_idle = 100000.
- **O:** opencode V2 (`p2_agents:OpencodeV2`, P2G's pinned adapter), the concurrent control.
- **Everything else is P2G's:**
  - the 29 tasks in attempt 1's order (`random.Random(1)`);
  - deepseek-v4.1-flash via OpenCode Go;
  - the 1,800 s cap;
  - Harbor flags;
  - P2G's validity rule (a cell with no model response is not valid);
  - C2D's log relay in front of each slot.
- **Budget:** $22 of Go allowance (wire). A wave starts only if spent + $1.50 ≤ $22.
  - Waves pair the arms in time, so the 2× peak windows (weekdays 01–04 and 06–10 UTC) hit all three arms alike.

## Analysis (stated now)

- **Primary: B41 vs O.** The parity question, paired by task:
  - solved, with exact McNemar on discordant pairs;
  - hidden-test pass fraction, with the paired mean difference and a task-bootstrap 95% interval (10,000, seed 20261105).
  - **Non-inferiority margin, stated before data:** 10 points of solve rate or of hidden-test fraction.
    - "Parity shown" only if the 95% interval's lower bound of B41 − O exceeds −0.10.
    - Otherwise "no difference shown" (if the interval crosses 0) or "trails".
- **Secondary:**
  - A41 vs O, the release-default row;
  - B41 vs A41, the recipe's effect, paired;
  - timeouts, $/solved, wall time;
  - the new v0.4.1 per-call records as mechanism data.
- **Reporting:** n = 29 at k = 1 has low power for a 10-point margin; the result is reported with its interval, never as
  "equal". The P2G attempt-1 rows (v0.3.1 and peers, time-separated) stay in every table; rows are never pooled.

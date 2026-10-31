# P2 cost probe — result (2026-10-31)

Design: `PRE-REGISTRATION-probe.md`, with the amendments it lists. Per-cell
records: `probe/<arm>/cell.json`, plus each arm's Harbor log. Every failed
attempt is kept beside its arm (`*.failed-*`, `*.unmetered-*`).

One Terminal-Bench 4.0 task (`session-window-debug`), every arm once, on
DeepSeek V4.1 Flash through the user's OpenCode Go plan, with a 1,800 s cap.
Harbor 0.25.0 ran on the hub (Windows, Docker Desktop, amd64), one cell at a
time.

**The probe compares no arms.** At n = 1 a pass or a fail is one draw, and a
token count belongs to that one trajectory.

## All nine arms run

| arm | wall s | model requests | prompt tokens | cache share | completion | **Go allowance** | result |
|---|---|---|---|---|---|---|---|
| gnomon 0.3.1 | 1,323 | 63 | 2.71M | 97% | 132k | **$0.059** | not solved |
| Claude Code 2.1.316 | 664 | 28 | 1.44M¹ | 95% | 66k | **$0.033** | not solved |
| Codex 0.166.0 | 423 | 32 | 1.18M | 94% | 53k | **$0.027** | not solved |
| opencode V2 2.2.5 | 826 | 32 | 1.58M | 95% | 68k | **$0.035** | not solved |
| OpenHands SDK 1.59.0 | 1,839 | 31 | 1.22M | 94% | 159k | **$0.066** | hit the cap |
| aider 0.86.2 | 860 | 6 | 0.09M | 78% | 88k | **$0.034** | **solved** |
| goose 1.57.0 | 1,521 | 66 | 3.32M | 95% | 129k | **$0.068** | not solved |
| mini-swe-agent 2.4.6 | 794 | 30 | 1.31M | 94% | 59k | **$0.030** | not solved |
| pi 0.85.1 | 231 | 4 | 0.02M | 62% | 17k | **$0.007** | not solved |

¹ Anthropic's format reports cache reads apart from `input_tokens`. The relay
recorded 75,593 input + 1,361,152 cache reads; the total is shown. Go's
allowance is computed by Go and is unaffected. The full run's collector
normalises this.

- **Cost:** median $0.034 per cell, mean $0.040, max $0.068. The whole probe,
  failed passes included, spent about $0.50 of the plan's $100/month allowance
  for this model.
- **Go's client policy, natively** (no relay help needed):
  - sends `x-opencode-session` itself: **gnomon** and **opencode V2**;
  - sends its own session header, which Go's docs say it recognises: Claude
    Code;
  - sends no session header: Codex, OpenHands, aider, goose, mini and pi;
  - sends its own user agent: gnomon, Claude Code, Codex, opencode V2 and pi;
  - sends a generic SDK agent or none: OpenHands, aider and mini
    (`OpenAI/Python`), and goose (empty).
- **Not a result:** aider solved the task in 6 requests, and the others did
  not. At n = 1 that is one draw. The task's expert estimate is 8 hours.

## What it took to get nine arms running

Seven apparatus faults, each found from Harbor's own records and fixed before
its arm counted (see the amendments):
- gnomon's adapter did not declare `base_url`;
- compressed responses could not be metered;
- Harbor on Windows wrote agent output in cp1252;
- mini's unpinned litellm hit the `mcp` import bug, as in P1;
- Harbor's OpenHands adapter targets a layout that openhands-ai 1.11 dropped;
- aider's PATH file was missing in an image that already had uv;
- opencode V2's base URL was read from the wrong place, and goose doubled
  `/v1` in its URL.

## What it means for the full P2

- **Money is not the constraint.** 9 arms × 30 tasks × 3 attempts = 810 cells,
  at about $0.04 each, is roughly $30–50: a third to a half of one month's
  allowance for this model. That is about $10–15 per Go 5-hour window, under
  the window's $20.
- **Time is.** Strictly serial, 810 cells at ~15 min is about 9 days. Parallel
  slots, each with its own relay instance (port), keep per-cell metering exact.
  With 4 slots it is ~2–2.5 days, at 8 CPUs and 16 GB of the hub's Docker VM.
- **The floor is a risk.** One of eight working arms solved the probe task
  within 30 minutes. If most TB 4.0 tasks sit near 0 for every arm, the run
  cannot resolve differences (H7's lesson). The full pre-registration needs a
  floor gate after the first attempt.

# Apparatus — post-audit Terminal-Bench comparison

Archived here rather than left in a scratchpad, because the scratchpad is
wipeable and a previous 48-task arm lost every trace it produced, turning every
behavioural claim about it into inference.

| file | what it is |
|---|---|
| `gnomon_agent.py` | the terminal-bench adapter. **Requires `GNOMON_REF`** — it raises rather than defaulting to `master`, because a run that cannot say which commit it executed cannot support a claim about that commit |
| `gnomon-setup.sh.j2` | container setup. Aborts if the pinned ref is unreachable or resolves to a different SHA than `GNOMON_EXPECT_SHA`; enables the audit trail, which shipped off for all 224 prior trials |
| `overnight.sh` | the full comparison. One `tb` invocation per (arm, pass) so a crash costs one cell, not the night; completed cells are skipped on restart; docker networks pruned between cells |
| `analyze_night.py` | aggregates passes, applies the pre-registered scoring rule, reports mechanism events and discordant pairs |
| `run_hunch.sh` / `analyze_hunch.py` | the 16-task probe run |
| `sample48.txt` | the pre-registered task set |
| `sample16-hunch.txt` | 16-task subset, chosen by a fixed hash of the task name — **not** by outcome |

## Environment gotchas that cost a run each

- **`registry.tbench.ai` no longer resolves.** `--dataset terminal-bench-core`
  fails with a `FileNotFoundError` on a temp `tasks/` dir. Clone
  `laude-institute/terminal-bench` and pass `--dataset-path <clone>/original-tasks`.
- **`deepseek/deepseek-v4-flash-latest` is not a valid OpenRouter model id.** It
  returns HTTP 400 per trial — free, and scores every trial an apparatus failure.
  A 48-task arm came back 0/48 in 14 minutes before this was spotted.
- `tb` takes repeated `--task-id`, not `--task-ids-file`.
- **`GNOMON_REF` must reach the container**, not just the launching shell. Set
  outside and not forwarded, the clone inside takes its default and the trial
  silently measures `master`.

The tell for all of these was wall-clock: 48 tasks cannot finish in 14 minutes
when p90 is 920s.

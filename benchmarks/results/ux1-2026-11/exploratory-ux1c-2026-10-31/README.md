# UX1c (exploratory): gnomon's per-command cost grows with the repository

Not pre-registered. It came out of UX1b's profile and is labelled exploratory.

The scripted 10-turn session of UX1b (`cat notes/chunk_<i>.txt` through each
harness's own shell tool) ran in repos with N committed files (~200 B each, in
100-file directories). n = 5 sessions × 10 turns per cell; gnomon is the v0.3.1
release. `driver.py` is the runner and `readout.txt` the table.

| files | gnomon, per tool turn | goose | opencode V2 |
|---|---|---|---|
| 0 | 50 ms | 23 ms | 34 ms |
| 5,000 | 104 ms | 25 ms | 72 ms |
| 20,000 | 260 ms | 20 ms | 60 ms |
| 50,000 | 256 ms | 25 ms | 94 ms |

**Cause:** `worktreeStampOf` (tools.ts) walks and stats every file of the
project before AND after every shell command, to answer "did this command
change anything". The anti-flailing nudge and the audit field
`worktree_changed` read that answer. The walk is O(files) in JS and stops at
`WALK_MAX_FILES = 20_000`, hence the plateau.

**The cap is also a correctness bug** (`stamp-cap-probe.mjs`, run against the
release's own `worktreeStampOf`):
- on a 30,000-file tree, 7 of 20 single-file modifications sampled across the
  tree did not move the stamp, because the walk never reached them;
- in a large repository, gnomon can therefore record `worktree_changed: false`
  for a command that changed files, and count it toward the nudge's "calls
  without changing a file".

Filed as an issue with design options; not fixed here.

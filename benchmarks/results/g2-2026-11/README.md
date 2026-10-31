# G2: the five model-free property suites, re-run against released v0.3.1 (2026-10-31)

**Measurement only. Nothing in gnomon was changed.** Four of the five suites
reproduce their published number exactly. The fifth, determinism, **cannot run
as shipped in v0.3.1**: its fingerprint module has a syntax error. The suite
still prints `9/10 matched expectation` and exits 0, but all ten rows are the
same import error compared with itself, so that number measures nothing. With a
two-line apparatus fix, which is labelled below and recorded as a diff, it
measures 10/10 on both surfaces it was run against.

| | |
|---|---|
| date | 2026-10-31, 19:17 to 19:21 +02:00 |
| ref under test | tag `v0.3.1` = `7012c5a6d80516891b061cc0f07ac1724b6289a0` (`git rev-parse HEAD` in the worktree, also written into every `logs/*.meta`) |
| host | gx10 (`gx10-cd1b`), aarch64, Linux 6.17.0-1014-nvidia, 20 cores |
| toolchain | node v22.22.2, pnpm 9.0.0, tsx 4.23.15, tsc 7.0.2, cargo 1.94.1 |
| host load | load average about 11 on 20 cores. The 38-hour P1 benchmark was running on the same host. Every suite ran at `nice -n 19` |
| cost | $0. No model was called and no network was used (see "Stranger's state") |

## Result

| suite | published | measured | delta | wall, run 1 / run 2 | exit |
|---|---|---|---|---|---|
| surface fidelity | 13/13 | **13/13** faithful (0 FP, 0 FN, 0 unmeasurable) | 0 | 31.3 s / 23.6 s | 0 |
| degradations | 14/14 | **14/14** complete (announced 14, recorded 14) | 0 | 1.27 s / 1.68 s | 0 |
| fault disclosure | 8/8 | **8/8** disclosed (survived 8/8) | 0 | 0.85 s / 0.84 s | 0 |
| silent success | 0/11 | **0/11** falsely successful, 0/11 void | 0 | 1.46 s / 1.43 s | 0 |
| determinism, **as shipped** | 10/10 | **did not run**: 0/10 valid rows. Self-reports `9/10`, exit 0 | n/a | 23.1 s / 0.32 s (scaffold), 0.41 s (dogfood) | 0 |
| determinism, **minimal apparatus fix** | 10/10 | **10/10** (scaffold surface), **10/10** (dogfood surface) | 0 | 8.29 s / 4.50 s (scaffold), 4.62 s (dogfood) | 0 |

Every negative control fired, in every suite that has one:

- surface fidelity: both the false-positive and the false-negative detector.
- degradations: the wrong-sentence control and the swallowed-trail control.
- fault disclosure: the suppressed-429 control.
- silent success: the seeded `exit null` defect, which was caught.

The determinism suite has no negative control of its own. Its `GNOMON_MODEL_URL`
row, which is expected to differ, is the only row that can show the detector
working. With the fix it fires (`behaviour:DIFF`). As shipped it does not, and
that is the visible symptom of the defect.

### Run 2 (repeat, same build, fresh stranger state)

Every suite reproduced its verdicts. The repeat JSON is in `repeat/`, and it is
byte-identical to run 1 except for `fault-disclosure` `endpoint-timeout`. In
that row the evidence string carries a computed deadline, `1199999ms` in run 1
and `1199998ms` in run 2. That is timing text, and the verdict is unchanged.

### Compared with the `result.json` committed at v0.3.1

- `degradation-contract` and `silent-success` are identical to the committed
  files once both are normalised (keys sorted).
- `surface-fidelity` has identical verdicts on all 13 paths, but a different
  `baseHash` (`3217574004f4…` committed, `2fe1e1f8833e…` here). The base hash is
  the hash of the surface that `gnomon init` scaffolds. Here init found no model
  host (nothing listens on 127.0.0.1:11434) and wrote its placeholder tags. The
  cause of the difference was not investigated further.
- `fault-disclosure` has identical verdicts. The `rate-limit` evidence now opens
  with three more lines (`Model API error: 429 Too Many Requests` /
  `rate limit exceeded` / `Retrying for up to 60s in case it is starting up.`)
  before the same six `[retry] endpoint rate limiting (429)` lines.

## Determinism failure details (verbatim)

As shipped, `run.mjs` spawns `node -e "import(determinism.mjs)…"` once for each of
its 10 conditions. Every spawn dies before it measures anything. stderr, which
repeats 10 times (`logs/determinism-asis-scaffold.stderr`):

```
file:///home/eljaplacido/gnomon-wt/g2/benchmarks/results/determinism-2026-08-31/determinism.mjs:74
  } catch (e) { return `ERR:${String(e).slice(0, 60)}`; }
                        ^^^

SyntaxError: Unexpected identifier 'ERR'
```

stdout (`logs/determinism-asis-scaffold.stdout`):

```
  baseline                 behaviour:same  surface:same   stable
  different-cwd            behaviour:same  surface:same   stable
  copied-to-new-path       behaviour:same  surface:same   stable
  LC_ALL=tr_TR.UTF-8       behaviour:same  surface:same   stable
  LC_ALL=C                 behaviour:same  surface:same   stable
  TZ=Pacific/Kiritimati    behaviour:same  surface:same   stable
  HOME=elsewhere           behaviour:same  surface:same   stable
  XDG_CONFIG_HOME set      behaviour:same  surface:same   stable
  mtimes changed           behaviour:same  surface:same   stable
  GNOMON_MODEL_URL set     behaviour:same  surface:same   STABLE (unexpected)

9/10 matched expectation
PROBLEMS: GNOMON_MODEL_URL set
```

The "stable" rows are not a measurement. `run.mjs` catches the spawn failure,
records `hash: "ERR:<first 80 chars of the error>"`, and compares that string
with the baseline's identical error string. So every row reads `same`, and the
one row that must differ is the only row that fails. `run.mjs` has no non-zero
exit for a failed row, so the process exits 0.

**Two defects in `determinism.mjs`.** Both were introduced by `65274f6`
(2026-09-07, "fix(install): …"), which replaced the hardcoded
`/home/eljaplacido/Desktop/gnomon` paths:

1. Line 72 opens a template literal with `` ` `` and closes it with `"`
   (`` [`${REPO}/packages/gnomon-cli/gnomon.js", "surface", … ``), so the
   module does not parse.
2. `REPO` is declared on line 26 (`const REPO = new URL(…)`), but the top-level
   `await import(`${REPO}/…`)` calls on lines 14 to 16 use it first. With
   defect 1 alone fixed, loading the module fails with
   `ReferenceError: Cannot access 'REPO' before initialization`. This was checked.

`git tag --contains 65274f6` lists v0.2.2, v0.2.3, v0.3.0 and v0.3.1, and
master `bc8f27a` still has both lines. So this script cannot have produced the
published 10/10 at any tag from v0.2.2 on. The 10/10 dates from the original run
on 2026-08-31 (`10c9c04`).

**Minimal apparatus fix** (`apparatus/determinism-apparatus-fix.diff`). The fix
closes the template literal with `` ` `` and moves the unchanged `const REPO = …`
line above the imports. Nothing else changed, including `run.mjs`, the
conditions and the expectations. The fixed copy ran from a sibling directory at
the same depth (`benchmarks/results/determinism-g2fix/`), so `REPO` still
resolves to the worktree root. The shipped file was left as it is.

**The fixed run measured real values.** `apparatus/det_diag.mjs`, a diagnostic
outside the suite, prints the values behind `run.mjs`'s booleans
(`logs/determinism-diag-*.stdout`):

- On the scaffold surface, the fingerprint has 25 parts, none of them errors,
  and its hash is `4e57e234…`. With `GNOMON_MODEL_URL` set, every role's target
  URL becomes `http://127.0.0.1:9/v1/chat/completions` and the hash becomes
  `510dcd7d…`. The surface hash is `2fe1e1f8833e…`, which matches the
  surface-fidelity base hash for the same scaffold.
- On the dogfood surface, the fingerprint hash is `add4a45e…` and `3cbb0d9b…`
  with the override. The surface hash is `01ba646f…`.

**Surfaces.** `run.mjs` takes `<project-with-.gnomon>`, and the original run does
not record which project it used. It ran against two:

- **scaffold**: a fresh `gnomon init` written by the worktree's own `gnomon.js`
  in the stranger environment, as a stranger's project would be.
- **dogfood**: a directory holding only a copy of the worktree's committed
  `.gnomon/` at v0.3.1. It is not the user's daily checkout, which has
  uncommitted `.gnomon/` edits. Only `.gnomon/` was copied, because `run.mjs`
  `cpSync`s the whole project for two of its rows, and that would include
  `target/` and `node_modules/`.

## Stranger's state, and what was not met

Each suite run got a new temp root (`apparatus/run_suite.sh`). The command ran
under `env -i` with only these variables:

- `PATH=<root>/bin:/usr/local/bin:/usr/bin:/bin`. `<root>/bin` holds `node`
  (v22.22.2) and a `gnomon` wrapper that execs
  `node /home/eljaplacido/gnomon-wt/g2/packages/gnomon-cli/gnomon.js`. The
  user's global `gnomon` lives in `~/.local/share/pnpm`, which was not on PATH.
- `HOME=<root>/home` and `XDG_DATA_HOME=<root>/xdg-data`, both new and empty,
  so the user's `~/.local/share/gnomon/credentials.json` was not visible.
- `TMPDIR=<root>/tmp`
- `LANG=C.UTF-8`

No API key variables were set. The calling shell exports `OPENROUTER_API_KEY`
and `AZURE_AI_FOUNDRY_API_KEY`, and `env -i` stripped both. Neither the
`xdg-data` nor the `home` directory had any files in it after a run (recorded in
each `.meta`).

The run made no network contact:

- The four suites that run a turn replace `globalThis.fetch` with a scripted
  responder.
- `gnomon init` GETs `127.0.0.1:11434/api/tags`. Nothing listens there on gx10,
  so the socket was refused and init wrote placeholder tags, which is what a
  stranger without Ollama gets.
- The GPU, `:18080`, `:18195`, docker and `gpu.lock` were not touched.
- Network-namespace isolation (`unshare --net --map-current-user`) was tried
  and refused with `write failed /proc/self/uid_map: Operation not permitted`.
  The host sets `kernel.apparmor_restrict_unprivileged_userns=1`. So isolation
  rests on the facts above, not on a sandbox.

Not met, or worth knowing:

- **The TypeScript packages must be built.** All five suites import
  `packages/gnomon-core/dist/*.js`. `dist/` is not committed, and
  `pnpm install` plus `cargo build --release` do not create it. `pnpm run build`
  (tsc) was run as an extra setup step. It is part of the repository's own
  documented `pnpm run setup`, and no suite file was changed for it. Without it,
  each suite's first `import` fails.
- **`tr_TR.UTF-8` is not installed as a libc locale on gx10** (`locale -a` lists
  `C.utf8` and `es_EC.utf8`). Node's ICU still takes the default locale from the
  variable (`Intl…resolvedOptions().locale` = `tr-TR` was checked), so that
  determinism row exercises ICU but not libc collation.
- **Wall-clock read.** The sub-second suites (degradations, fault disclosure,
  silent success) do one `gnomon init` each, which measured 0.54 s on its own.
  Their endpoints are mocked with 1 ms backoffs. Degradations also runs three
  real 300 ms bash timeouts. Those durations fit the work. Their negative
  controls fired, and their evidence strings (in the JSON) are real harness
  output. Surface fidelity takes 23 to 31 s because it scaffolds and mutates
  each path. The first determinism runs (23.1 s as shipped, 8.3 s fixed) were
  much slower than the repeats (0.3 s and 4.5 s) for identical work. This is
  attributed to host contention from P1 and not investigated further. The
  23.1 s is not evidence of work: that run measured nothing.
- **n = 1 per condition per run, twice.** These are deterministic property
  checks, where a discrepancy is a counterexample, not an estimate. The repeat
  runs establish only that the verdicts were stable on this host.

## Exact commands

```bash
# setup (worktree at the tag)
cd /home/eljaplacido/gnomon && git worktree add /home/eljaplacido/gnomon-wt/g2 v0.3.1
cd /home/eljaplacido/gnomon-wt/g2
git rev-parse HEAD                             # 7012c5a6d80516891b061cc0f07ac1724b6289a0
nice -n 19 pnpm install --frozen-lockfile      # 1.2 s, 57 packages reused
nice -n 19 cargo build --release               # 7.0 s
nice -n 19 pnpm run build                      # 1.3 s, tsc -> packages/*/dist (needed by every suite)

# every line below runs through apparatus/run_suite.sh <label> <cwd> <cmd…>,
# i.e.  env -i PATH=… HOME=<fresh> XDG_DATA_HOME=<fresh> TMPDIR=<fresh> LANG=C.UTF-8 nice -n 19 <cmd…>
B=/home/eljaplacido/gnomon-wt/g2/benchmarks
run_suite.sh surface-fidelity     $B/surface-fidelity     node fidelity.mjs --json <out>/surface-fidelity.json
run_suite.sh degradation-contract $B/degradation-contract node contract.mjs --json <out>/degradation-contract.json
run_suite.sh fault-disclosure     $B/fault-disclosure     node disclose.mjs --json <out>/fault-disclosure.json
run_suite.sh silent-success       $B/silent-success       node sweep.mjs    --json <out>/silent-success.json

# determinism: two surfaces
run_suite.sh init-scaffold <proj>/scaffold node /home/eljaplacido/gnomon-wt/g2/packages/gnomon-cli/gnomon.js init
mkdir <proj>/dogfood && cp -r /home/eljaplacido/gnomon-wt/g2/.gnomon <proj>/dogfood/.gnomon
#   as shipped  (run.mjs writes ./results.json; copied out after each run)
run_suite.sh determinism-asis-scaffold  $B/results/determinism-2026-08-31 node run.mjs <proj>/scaffold
run_suite.sh determinism-asis-dogfood   $B/results/determinism-2026-08-31 node run.mjs <proj>/dogfood
#   minimal apparatus fix: run.mjs unchanged + determinism.mjs patched per apparatus/determinism-apparatus-fix.diff
run_suite.sh determinism-fixed-scaffold $B/results/determinism-g2fix      node run.mjs <proj>/scaffold
run_suite.sh determinism-fixed-dogfood  $B/results/determinism-g2fix      node run.mjs <proj>/dogfood
#   diagnostic (not a suite): raw values behind the booleans
run_suite.sh determinism-diag-scaffold  $B/results/determinism-g2fix node det_diag.mjs $B/results/determinism-g2fix/determinism.mjs <proj>/scaffold

# run 2: the same four suites, plus determinism as shipped and fixed on the scaffold, label suffix .r2
```

## Files

- `surface-fidelity.json`, `degradation-contract.json`, `fault-disclosure.json`
  and `silent-success.json` are the run 1 raw output (`--json`).
- `determinism-{asis,fixed}-{scaffold,dogfood}.json` are run 1 raw output, from
  `run.mjs`'s `results.json`.
- `repeat/*.r2.json` holds the run 2 raw output.
- `logs/<label>.{meta,stdout,stderr}` hold, for every invocation: the command,
  SHA, start and end, exit code, wall seconds, and the files left in the fresh
  `HOME` and `XDG_DATA_HOME`, plus full stdout and stderr. Empty stderr files
  are kept on purpose.
- `apparatus/run_suite.sh` is the stranger-state runner. `apparatus/det_diag.mjs`
  is the determinism value dump. `apparatus/determinism-apparatus-fix.diff` is
  the only change made to any suite file, and it applied only to a copy.

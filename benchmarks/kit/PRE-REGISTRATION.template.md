# {{RUN-ID}}: {{one-line question}} (pre-registration)

<!-- TEMPLATE. Copy to <your results dir>/PRE-REGISTRATION.md, replace every {{...}}, delete the comments,
     and COMMIT THIS FILE ALONE before the first cell runs. Your runner should refuse to start while the
     file is missing, still contains "{{", or differs from its committed version (`git diff --quiet`).
     After the commit, nothing above "Amendments" changes; changes go in timestamped amendments. -->

Written {{YYYY-MM-DD HH:MMZ}}, **before any {{RUN-ID}} cell**. Author: {{name or handle}}; authorship:
{{author-run | third-party}}; conflicts of interest: {{e.g. "the authors build harness A"}}.

## 1. Question and the claim it can support

{{The question in one or two sentences. Name the one variable that differs between arms.}}

The strongest claim this design can support: "{{e.g. On <task set> with <model>, arm B solves more tasks than
arm A}}". It cannot support: {{e.g. claims about other models, other task sets, or the cost of hardware not used}}.

## 2. Builds (pinned by hash)

| What | Version | Pin |
|---|---|---|
| Harness under test | {{version}} | commit {{sha}}; `SHA256SUMS` sha256 {{hash}}; each artifact checked against it; `--version` must print {{exact string}} |
| Other harness(es), if any | {{version}} | {{artifact digest or commit}}; version recorded per cell |
| Benchmark runner | {{e.g. Harbor <version>}} | {{commit or wheel sha256}} |
| Task set | {{name@version}} | {{dataset commit or archive sha256}}; contamination check done: {{yes/how}} |
| Model(s) | {{provider/model id, snapshot}} | sampling: {{temperature/top_p or "provider default, none sent"}} |
| Analysis | `analyze_paired.py` | {{commit sha of benchmarks/kit}} |

A cell whose recorded build differs from this table is invalid (§6).

## 3. Arms

Every arm runs the same build, model, task set, clock and permissions. The configuration-hash diff between
arms shows only the declared setting.

| Arm | Differs from control by | Config hash |
|---|---|---|
| **{{CONTROL}}** | nothing (control) | {{hash}} |
| **{{CONTROL}}-again** | nothing: A/A arm, the noise floor | {{same hash}} |
| **{{ARM-B}}** | {{the one setting, with its exact value}} | {{hash}} |

Unattended flags per arm: {{e.g. gnomon `task --yes --json --deadline 1740`}}. Audit / trace: {{on, where archived}}.

## 4. Tasks, waves and size

- Tasks: {{all N tasks | the frozen subset in <file> (sha256 …), frozen before any run}}.
- Attempts: k = {{k}}, **attempt-major**: attempt j runs the tasks in `random.Random({{seed}} + j)` order.
- Waves: one task, one attempt, every arm, started together on one host; arm start order seeded per wave
  ({{seed rule}}), {{stagger}} s apart. {{N × k}} waves, {{N × k × arms}} cells.
- Time cap: {{seconds}} per cell, the same for every arm; the harness's own deadline {{seconds}} (cap minus
  margin, so it can stop itself and seal its record). The effective cap is measured from timestamps.
- Concurrency: at most {{n}} cells at once per host; guards: {{free memory, load, disk}}; a cell that a
  guard or watchdog stops is invalid and re-run.
- Budget: stop at ${{cap}}; a wave starts only if spend + ${{per-wave estimate}} ≤ cap. A budget stop keeps
  complete attempts only for the primary analysis.

## 5. Cost metering

All model traffic of every arm passes through `relay-meter.mjs` (commit {{sha}}), one relay per {{lane | cell}}.
Usage is what the server reported; prices from the table dated {{date}} ({{file, sha256}}). Streamed Chat
Completions requests get `stream_options.include_usage` on every arm alike. Reported: $/cell, $/solve, tokens
by kind, unmetered responses, and spend on invalid and replaced cells.

## 6. Validity and re-runs (fix, don't fail)

A cell is **invalid** (apparatus failure) if any of: {{no verifier reward; no model response with usage;
recorded build ≠ §2; infrastructure, container or transport failure; quota or account refusal; watchdog stop;
a mechanism check failed — list every one}}. A wrong answer, a refusal by the agent, or the time cap is a
**valid failure**.

An invalid cell is re-run with its **whole wave** (every arm on that task) as `<wave>r`; a re-run that is itself
invalid as `<wave>rr`, at most {{3}} re-runs. The deepest re-run replaces earlier tries for every arm. Apparatus
defects found during the run are fixed and logged as amendments before any outcome is read.

## 7. Analysis (`analyze_paired.py`, fixed now)

```
python3 analyze_paired.py cells.csv --baseline {{CONTROL}} --aa {{CONTROL}}-again:{{CONTROL}} \
    --margin {{0.10}} --alpha {{0.05}} --seed {{seed}} --json analysis.json
```

- Unit: the task (mean over its valid attempts); a task enters a contrast only if both arms are valid on it.
- **Primary: {{ARM-B}} − {{CONTROL}} on full solves.** Exact McNemar over paired cells and a 10,000-resample
  task-cluster percentile bootstrap (seed {{seed}}). "Better" iff p < α and the interval lies above 0; "worse"
  iff p < α and below 0; "non-inferior" iff both intervals' lower ends lie above −{{margin}}; else "not shown".
  Never "equal".
- **Secondary, in this fixed order, stopping at the first not shown:** {{1. hidden-test share … 2. $/solve …}}.
- **Guards:** {{e.g. B is not recommended as a default if its cap rate exceeds the control's by more than
  10 points, whatever its solve rate}}.
- **Mechanism metric(s):** {{what the change should move, e.g. false-finish rate, requests carrying X}}.
- **Noise floor:** the A/A contrast is reported beside every result; an A/A verdict of better or worse halts
  interpretation until explained.
- **Power:** with {{N}} tasks × k = {{k}}, at the A/A or prior discordance, the MDE is ≈ {{x}} points; an effect
  smaller than that will read "not shown", which is the honest outcome.
- Descriptive only: {{wall time, interim looks, per-host and attempt-1 sensitivity}}.

## 8. Wire test and smoke runs (before data)

- Wire test against a scripted fake model, per arm: {{each request carries / omits what the arm declares; the
  record shows the build, the setting and the audit trail}}. Controls: {{the control arm does NOT show the
  setting}}. Output: {{file}}, sha256 pinned here.
- Smoke runs already made: {{list, with seeds; whether any value was read}}. Smoke runs are never pooled.

## 9. Other harnesses (if any)

Each runs its documented best-effort unattended configuration ({{published config, sha256}}), its maintainers
notified on {{date}} ({{link}}), or "n/a: no other harness is named".

## Amendments

<!-- **Amendment N ({{YYYY-MM-DD HH:MMZ}}; written BEFORE | AFTER reading any outcome).** What changed, why, and
     which cells it affects. Never edit text above this line after the pre-registration commit. -->

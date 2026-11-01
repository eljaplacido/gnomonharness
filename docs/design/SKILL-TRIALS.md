# Design: governed skill trials

Status: **proposal**, 2026-11-01. Nothing here is implemented. The release
freeze holds at 0.3.3; whatever lands from this goes to `master` unreleased.

## The question

Hermes Agent (Nous Research) learns as it works. It creates skills from
experience, refines them in use, and nudges itself to keep what it learned
([docs](https://hermes-agent.nousresearch.com/docs)). Can gnomon learn the same
way without giving up what makes it worth using: one hashed surface that names
the behaviour, and records you can check?

Short answer: yes, if two things are true.
- The step from "the agent thinks this helps" to "this is part of the agent" is
  **measured**, not assumed.
- That step stays a **human act**, recorded with its evidence.

Hermes automates both steps. gnomon automates the first and proves the second.

## What exists today

| Piece | Where | What it does |
|---|---|---|
| Active skills | `.gnomon/skills/*.md` (hashed) | TOML front matter (`name`, `description`, `match`, `roles`) plus a body. Matching skills are appended to the system prompt, below `system.md`, marked as learned notes. Dormant ones are listed by name. |
| Proposals | `.gnomon/skills/proposed/*.md` (**not** loaded, **not** hashed) | Written by the `skill` tool. Only `coordinator` holds it in the scaffold. The filename is derived from the name, so a proposal cannot be aimed at another path. |
| Accept / reject | `gnomon skill accept ID`, `gnomon skill reject ID` | Accept moves the file into `skills/`. That changes the hash on purpose and applies from the next session. |
| Startup audit | `auditSurface` | Reports a skill whose `match` cannot compile, a misspelled role, and YAML front matter. |

Two gaps matter for this design:
1. **Accept and reject write no audit record.** The trail shows the surface
   hash moved, not that a person accepted a named skill, or on what evidence.
2. **Nothing measures a proposal.** It is accepted on reading alone.

## Hermes, read critically

| Hermes does | Keep? | Why |
|---|---|---|
| Creates skills from experience, unprompted | **Yes, as candidates** | Learning that waits for someone to ask never happens. |
| Refines skills while using them | **No, not in-session** | It changes behaviour under the run that changed it. The hash would no longer name the behaviour (Rule 2). |
| Nudges itself to persist knowledge | **Yes, as one line to the operator** | A nudge to a person costs nothing. A nudge to the model costs a turn. |
| Keeps skills in `~/.hermes/skills/` | **No** | That is machine-scoped behaviour (Rule 1). Two machines would run two different agents. |
| Builds a model of the user across sessions | **No** | Behaviour from outside the repository, which no hash covers. |
| Trusts its own judgement that a skill helped | **No** | The known failure: bad habits that entrench and are hard to undo. Secondary sources also note it lacks signed governance and audit logging. |

## The design

Five parts. Each is useful alone, in this order.

### 1. Candidates: mined from the record, not invented

`gnomon skill mine` reads the audit trails and saved sessions. It writes
**candidates**: evidence, not skill text. It is deterministic, makes no model
call and costs nothing.

| Signal | Read from | The candidate it suggests |
|---|---|---|
| The same rule refused the same role three or more times across sessions | `tool_call` / refusal records with the same `rule` | Teach the rule up front: "this repo forbids X; do Y instead". |
| A `verify` that failed, then passed after a specific fix, on the same check more than once | `verify` records plus the tool calls between them | The fix pattern ("run `make gen` before the tests"). |
| An approval the operator declined, followed by a different call they approved | `approval` records | The operator's preferred route. |
| The same exploration commands at the start of many sessions | the first N `tool_call` records of each session | The answer itself ("tests run with `pytest -q tests/`"). |
| Turns that ended `stall` or at the step wall on the same kind of task | turn `stop_reason` | A warning, or a decomposition hint. |

Candidates go to `.gnomon-skills/candidates/<id>.json`. That is a run directory
beside `.gnomon/`, gitignored and never hashed, like `.gnomon-audit/`. Each
candidate holds the signal, its counts, and pointers to the records:
`{trail, seq, hash}` triples a reader can verify with `gnomon audit verify`.

**Drafting** turns a candidate into a proposal. `gnomon skill draft CANDIDATE`
asks a model, by default the `smol` role, to write the skill from the evidence
only. The draft lands in `.gnomon/skills/proposed/` with a `[provenance]` table
in its front matter: the candidate id and its record pointers. The existing
in-loop `skill` tool stays as it is; its proposals carry `provenance = "agent"`.

**The nudge.** At session end, if `mine` would find new candidates, gnomon
prints one line: `2 skill candidates — gnomon skill list --candidates`. Mining
runs only when `[skills] mine = "session_end"`. Drafting never runs on its own
unless `[skills] auto_draft = true`, because it costs a model call.

### 2. Trials: `gnomon skill trial ID`

A trial answers one question: on this project's tasks, with this model, does
the surface **with** the skill do better than the surface **without** it?

**Arms.** The current surface at `HEAD`, with and without the proposal copied
into `.gnomon/skills/`. That is the only difference between the arms, and the
trial asserts it by comparing the two surface manifests. Each cell runs in a
fresh `git worktree` at `HEAD`, so the arms never share state. For a
refinement (part 4) the arms are the old skill against the new one.

**Tasks** are declared in `.gnomon/trials/<name>.toml`. They are hashed,
because they decide what counts as better, and that deserves review like code.

```toml
# .gnomon/trials/default.toml
[trial]
model_profile = "local_first"   # the arms use this profile, pinned
attempts = 3                    # per task per arm; pairs are task × attempt
order = "interleaved"           # base, skill, base, skill … never arm-blocked

[thresholds]                    # declared BEFORE the run; the report compares against these
max_pass_drop = 0               # skill arm may solve at most this many fewer tasks
min_output_token_gain = 0.10    # at least 10% fewer output tokens, OR
min_pass_gain = 1               # at least one more task solved
alpha = 0.05

[budget]
max_requests = 400              # the trial stops, and the report says so
max_cost_usd = 2.00             # only enforced when the endpoint reports cost

[[task]]
id = "tests-pass"
prompt = "Fix the failing test in tests/test_pricing.py"
setup = "git checkout -q -- . && python3 tools/break_pricing.py"   # optional
check = "pytest -q tests/test_pricing.py"                        # pass = exit 0, read from real state

[[task]]
id = "replay-2026-10-28"
replay_session = "s-20261028-…"   # first user prompt of a recorded session…
check = "make test"               # …judged by a declared command, never by the old outcome
```

**Validity.** These are the benchmark-discipline rules, enforced by the tool:
- A cell is **valid** only if it made at least one metered model request (from
  gnomon's own usage counters) and its `check` ran.
- A cell where the endpoint failed is `apparatus_failure`. It is reported and
  never scored.
- The buckets are asserted to sum to n.
- Pass or fail comes from the `check` exit code, never from the model's prose.

**Statistics.**
- Pass rate: exact McNemar on the pairs.
- Output tokens, requests and wall time: an exact sign test on the pairs.
- Each proportion carries a Wilson interval.
- The report states the minimum detectable effect for its n.
- `--calibrate` runs the base arm twice first and reports the flip rate, the
  noise floor. When the flip rate exceeds the effect the thresholds ask for,
  the report says the trial cannot answer.

**Output.** The trial writes three things:
- `.gnomon-trials/<skill>/<utc>/report.json` and one record per cell.
- A `skill_trial` audit record holding: the hashes of the skill content and the
  report, both surface hashes, the model and endpoint, n, each endpoint's
  numbers, and `meets_thresholds: true | false | undetermined`.

That field compares the numbers with thresholds declared beforehand. It is not
a composite outcome. Every cell keeps its own bucket (Rule 4).

**Cost controls.**
- The trial refuses to start against a billed endpoint without a `[budget]`, or
  `--yes-spend` on the command line.
- Before spending, `--estimate` runs one cell and projects the whole trial's
  cost.
- The trial stops at its budget and reports `budget_exhausted`, never a verdict.
- The default profile is the local one.

### 3. Acceptance: still a person, now with evidence

`gnomon skill accept ID [--evidence TRIAL_REPORT]`:
- moves the file, as today;
- appends a `skill_accept` audit record (new) holding: the skill's content
  hash, the surface hashes before and after, the trial report's hash or
  `evidence: "none"`, and who accepted it (`$USER` and the host, the same as
  the `approval` records);
- `reject` appends `skill_reject`, with an optional reason.

`[skills] require_trial = true` in `policy.toml` makes accept refuse without a
report that meets these three conditions:
- it is for this exact skill content;
- it was run against this exact base surface hash;
- it meets the declared thresholds.

It is **off** by default: a small project should not need a trial to save a
note. Teams turn it on.

**There is no auto-accept, ever,** even when a trial passes. A passing trial
makes the case; a person makes the decision.

### 4. Refinement: a new proposal that supersedes

A refined skill is a new proposal with `supersedes = "old-id"` in its front
matter. Its trial arms are old against new, not none against new. Accepting it
replaces the old file in one `skill_accept` record that names both, so
`git log -p .gnomon/skills/` shows the edit. Nothing rewrites an active skill in
place.

### 5. Rollback, expiry and model drift

- **Rollback.** Skills are files in git, so `git revert` works and the hash
  follows. `gnomon skill retire ID` moves an active skill to
  `.gnomon/skills/retired/` and records `skill_retire`. That directory is
  neither loaded nor hashed, like `proposed/`.
- **Expiry.** `review_after = "2027-02-01"` in the front matter. After that
  date, startup warns once per session, and `gnomon skill list` marks the skill
  `review due`.
- **Model drift.** Each trial records its model. When a role's current model
  differs from the model an active skill was last trialled on, startup warns
  once: `skill X was trialled on qwen3.6-35b; this role now runs
  deepseek-v4.1-flash`. P1 and P1-H showed why: the same harness ranked 2nd on
  one model and last on another. `gnomon skill trial --recheck` re-trials every
  active skill on the current model.

### Later: ACP and a browser UI

ACP clients and a future `gnomon ui` read the same files:
- **Candidates** appear as a notice.
- **A trial** runs as a background job with a progress line.
- **Accept** stays an explicit button that writes the same `skill_accept`
  record.

The UI decides nothing the CLI could not.

## What this will not do

- **Change behaviour in the session that learned it.** A change applies from
  the next session, after acceptance (Rule 2).
- **Keep skills anywhere but the repository.** No user-level or machine-level
  skills (Rule 1).
- **Let a skill grant a tool, widen `write_allow`, or override `system.md`.**
  A skill is prompt text, and is presented as a learned note under the rules.
- **Judge a trial with a model.** Pass and fail come from declared `check`
  commands.
- **Auto-accept**, even on a passing trial.
- **Build a profile of the user.**

## The Six Rules, checked

| Rule | Holds? | How |
|---|---|---|
| 1. No machine-scoped configuration | Yes | Skills, trial specs and thresholds live in `.gnomon/`. Candidates, reports and cells live in `.gnomon-*` run directories. Nothing goes in `~`. |
| 2. Every session emits a manifest | Yes | Proposals, candidates and retired skills are outside the hash. An accept moves the hash, and the `skill_accept` record names both hashes. A trial's two arms are two manifests, compared before the run. |
| 3. Tool schemas are declared data | Yes | No new model tool. `skill` stays a declared tool in `tools.toml`, granted per role. `mine` and `trial` are CLI commands, not model tools. |
| 4. Three buckets, no composite verdict | Yes, with care | Every cell keeps `result`, `refusal` or `apparatus_failure`. `meets_thresholds` compares each endpoint with numbers declared before the run. It is not an outcome bucket, and the report prints every endpoint beside it. |
| 5. Published exit contract | Yes | `trial`: 0 meets the thresholds, 2 does not, 10 apparatus failure or undetermined (budget, noise floor). Added to CONTRACTS.md with a fixture. |
| 6. Published enumerations | Yes | `meets_thresholds` values, candidate signal kinds and the new audit kinds (`skill_trial`, `skill_accept`, `skill_reject`, `skill_retire`) go into `gnomon enumerations`. |

## Implementation plan

Each step is one PR. Each lists a test that fails on master first.

1. **Audit records for accept and reject.** `skill_accept` and `skill_reject`
   carry the content hash and the surface hashes before and after.
   - Fails first: a test that accepts a proposal and reads the trail. Today the
     trail has no record of it.
2. **`gnomon skill trial`**, project tasks only.
   - Includes: the trial spec format, worktree isolation, interleaved paired
     cells, validity from metered requests, McNemar and sign tests, the report,
     the `skill_trial` record, the exit contract and the budget stop.
   - Fails first, with a fake model scripted to solve the task only when the
     skill text is present:
     1. the trial reports a pass gain;
     2. with the skill text removed from the prompt, it reports none, which is
        the negative control;
     3. with the endpoint down, it exits 10.
3. **`accept --evidence` and `require_trial`.**
   - Fails first: accept with `require_trial = true` and no report must exit
     non-zero. A report for different content or a different base surface hash
     must be refused.
4. **`gnomon skill mine`, candidates and the nudge.** Deterministic, over fixture
   trails.
   - Fails first: a fixture trail with four `write_allow` refusals of the same
     path pattern yields exactly one candidate, pointing at those four records.
5. **`draft`, `supersedes`, `retire`, `review_after`, and model-drift warnings.**
6. **Recorded-session replay tasks** (`replay_session`), then ACP and UI
   surfacing.

**Benchmarks to pre-register before step 2 merges:**
- **ST0, negative control.** A planted harmful skill ("skip running the tests;
  they are slow") must fail its trial on a task set where the check catches it.
  If it passes, the trial does not measure what it claims.
- **ST1, trial reproducibility.** The same skill and task set, trialled twice:
  how often does `meets_thresholds` agree? This sets the noise floor users
  should expect at n = 3.
- **ST2, governed versus auto-accept.** On the P1 local-model task subset, over
  K sessions:
  - arm A accepts every drafted skill (Hermes-style);
  - arm B accepts only skills that meet their thresholds;
  - endpoints: pass rate and cost per solved task over sessions, and how many
    harmful skills each arm accumulates.

  This is the experiment that says whether governance costs learning speed or
  saves it.

## Open questions for you

1. **Default task set.** Should `gnomon init` scaffold a `trials/default.toml`
   from the project's `[verify]` command, or should trials need a hand-written
   task list?
2. **`require_trial`.** Should it stay off by default? It would be on in a team
   template.
3. **Which role drafts.** `smol` on the local model, at no cost, or the role
   that produced the evidence?
4. **Recorded sessions as tasks.** Replays reuse prompts, which may contain
   pasted secrets. Should replay be opt-in per session (`gnomon sessions mark
   ID --trial-ok`)?

# CHANGELOG — gnomon

<!--
  The 0.1.0 heading below read `## [0.1.0] — 2025-01-xx` until this commit: a
  placeholder day, in a year the project did not exist. Measured against the
  repository itself — `git log --reverse --date=short` puts the first commit at
  2026-08-23 and the newest at 2026-09-01, and `git tag` lists nothing at all.

  So 0.1.0 had never been cut. The section carrying that number described
  scaffold day, while ~700 lines of the work that 0.1.0 actually consists of
  sat above it under `[Unreleased]`. Those are one release, and they are one
  section now; scaffold day is kept as a dated subsection at the end of it
  rather than deleted, because it is still what happened on 2026-08-23.

  Updated 2026-09-02: v0.1.0 was tagged (a651b51) and a draft release was cut,
  but it was never published — an audit of that tag found the defects listed
  under 0.1.1, including two mechanisms that reported success while doing
  nothing. v0.1.1 is the first release intended for anyone else to install, and
  v0.1.0 is kept in this file because it is what happened, not because anything
  should install it.

  The dates on release headings are the dates those sections were prepared. If
  a tag is pushed on a different day, change the heading to that day. The link
  definitions at the foot of this file resolve only once the tags exist.
-->

## [Unreleased]

### Added

- **Windows is supported and tested.** `windows-latest` runs the full TypeScript
  suite in CI — 899 passing, 3 skipped — alongside a new **macOS test job**, so
  every platform this project claims is now one it actually runs. macOS
  previously only *compiled* `gnomon-surface`, meaning "green on macOS" said
  nothing about whether it worked there.

  The release matrix gains **windows-x64**: `surface`, `apply` and `session` are
  the native crates, so a Windows user with no archive gets the TypeScript half
  of the harness and none of the half that computes the hash.

  **What it needs, and why.** Git for Windows, for its POSIX shell.
  `spawn(cmd, { shell: true })` runs `/bin/sh -c` on Unix and `cmd.exe /d /s /c`
  on Windows, which would make the same surface at the same hash mean two
  different languages — a shell that changes with the operating system is
  machine-scoped behaviour the hash cannot see. With none found, `bash` refuses
  and says how to get one; it does not fall back. `GNOMON_SHELL` points at one
  you already have. **Not WSL's `bash.exe`**, deliberately: it runs in a
  different filesystem with a different root, so `ctx.root` would not mean the
  same tree to the shell as it does to the sandbox check.

  **What differs there, disclosed rather than silently degraded.** `gnomon loops`
  runs but cannot install on a schedule (that is cron; Windows has Task
  Scheduler), and the credential store is restricted with an ACL rather than a
  `0600` mode.

### Fixed

- **A Windows path in TOML took the entire surface down.** `unescapeBasic`
  entered its unicode branch on the *first character* of the escape, which is
  also true for the `.` fallback of its own alternation — so `\U` followed by
  anything that is not eight hex digits reached `parseInt("", 16) = NaN`,
  `String.fromCodePoint(NaN)` threw, and the surface failed to load with
  "Invalid code point NaN", naming neither the line nor the word "escape". The
  string that does this is the most ordinary line a Windows user can write:
  `command = "C:\Users\me\server.exe"`. Not a Windows bug — a parser bug that
  Windows makes unavoidable.

- **The credential store was world-readable on Windows.** Mode came back `0o666`
  while the code set `0600` and the comment beside it said "a secret readable by
  other users on the machine is not stored" — true on POSIX, false on Windows,
  where `chmod` is a no-op. Now restricted with `icacls`, and it *reports* when
  it cannot, because a security control that fails silently is worse than one
  that is absent.

- **Native binaries were never found on Windows.** Cargo writes
  `gnomon-edit.exe`; every lookup asked for the bare name. A whole-platform
  outage from one missing suffix. `which` → `where` too.

- **The shell-`cd` detector was blind to drive paths.** `worktreeStampOf`'s
  second root came from `raw.startsWith("/")`, which no Windows path satisfies —
  so a turn that `cd`'d to `C:\work` and did everything there moved nothing the
  stamp could see, and the anti-flailing nudge would have told a working agent to
  stop. The same defect already fixed on the other platform, eight lines away.

- **`killTree` signalled a process group**, which Windows does not have;
  `taskkill /T` walks the tree instead.

### Removed

- **`agent.ts` — the second, unwired agent loop.** 339 lines exporting an
  `ExtensionHost`, a `HookPhase` enum, `runAgentTurn` and `runSession`, called
  by nothing on any turn in any session; `initAgent` had one importer that
  imported the name and never called it. It was kept deliberately while the
  extension-host design was wanted, and the reason it goes now is that
  `.gnomon/extensions/` left the surface hash the day before — the directory the
  host existed to read is inert in both directions, so the scaffolding has
  nothing left to be scaffolding for.

  **This is a breaking export change: the next release must be 0.2.0, not
  0.1.2.** Anything importing `ExtensionHost`, `HookPhase`, `runAgentTurn`,
  `runSession` or `initAgent` from `gnomon-core` will no longer resolve. Nothing
  in this repository did.

  Its removal broke two `file.ts:line` citations in `ROADMAP.md`, which
  `docs.test.ts` caught immediately — the citation check doing exactly its job.

### Added

- **`scripts/doc_reconciliation.mjs` and `docs/reconciliation.json`** — the
  scheduled reconciliation pass the ROADMAP has asked for. Each prose document
  records the commit it was last read against the code, plus the paths whose
  movement should send somebody back to it; the script reports which documents
  are **owed a reading**.

  It cannot tell whether a document is true — nothing can — and it does not
  pretend to. It answers the half that is mechanical. `.gnomon/ci.sh` prints the
  report and never fails on it, because a gate firing on every commit that
  touches `prompt_loop.ts` would be switched off within a month; `--check` exits
  1 for anyone who wants it to gate.

  Seeded with the three documents that have actually rotted here:
  `POSITIONING.md`, `README.md` and `HARNESS-RESEARCH-RECONCILIATION.md`.

- **`[chain] gate` — the chain can now stop.** One dial, three positions, each
  strictly stronger: `never` (the behaviour every existing surface has, and the
  default, so nothing moves under anybody), `on_refusal` (a stage whose bucket
  is `refusal` stops it), `on_check` (also a stage whose declared `[verify]`
  check did not pass).

  This closes the limit the README has published since the feature shipped: *"a
  role chain runs in order and gates on nothing"*. A `critique` stage that
  reported the work was wrong was followed by the next stage regardless.

  What it deliberately does not do: gate on a stage's **opinion**. A verifier
  reporting "this is wrong" in prose still exits 0, and reading its sentence
  would be instruction rather than capability. What stops the chain is a check
  that ran and failed. `auditSurface` reports a surface declaring `on_check`
  with no `[verify] command`, because an option that reads as a guarantee and
  behaves as `on_refusal` is the class `7ebd8fd` disclosed.

  Rule 4 is untouched: every stage keeps its own bucket and its own
  `chain_stage` record, and a stopped chain records `stopped_by` naming which
  condition fired. **No migration needed** — unlike compaction, the code default
  is what every existing surface already does.

- **`verify` on the turn record** — `passed` / `failed` / `unrunnable` /
  `declined`, so `gnomon task --json` says whether the declared check passed.
  It existed only as a separate `verify` audit record, so a turn whose check
  had failed every round it was given still reported `code: 0` and
  `stop_reason: "answered"`. Same silent-success shape as `exit null` read as a
  clean zero, one level up.

- **`verify_skipped_shell_only`** — a 13th declared degradation, and the one that
  found itself. `touchedFiles` is set only by a `write`/`edit` returning 0, so
  with the default `[verify] after = "write"` a turn that changes files **only
  through the shell gets no check at all** — and the turn is reported exactly
  like one that passed. The exclusion is deliberate and its reasoning is sound
  (counting shell work as a write would silently turn `write` into `always`
  underneath every existing surface); what was missing is that the cost was
  written down nowhere, while this repository's own note eight lines away records
  **49 of 50 nudged trials editing through heredocs and `sed -i`**.

  The enumeration is unchanged. The skip is now announced and recorded, so an
  operator can choose `after = "always"` rather than never learning the check did
  not run. `TurnResult.verify` gains `"skipped"`, which the chain gate treats
  like `unrunnable` — a check that never ran has not been passed.

  Found by `benchmarks/greenfield-spec`, whose entire arm was measuring a
  mechanism that was not running.

- **`pass^k`, computed from the archive for $0** —
  [reliability-passk-2026-09-05](benchmarks/results/reliability-passk-2026-09-05/).
  gnomon v0.1.1: **pass@1 51.2%, pass^2 45.2%**, retention 0.88 — about one
  apparent success in eight does not reproduce. Both passes of both regression
  arms have carried per-task outcomes since 2026-09-03; the metric was missing
  because nobody asked the question, not because the data was. It restates this
  project's 11.9–14.9% self-flip as a *measurement of the harness* rather than an
  apology for the apparatus, in
  [ReliabilityBench](https://arxiv.org/abs/2601.06112)'s vocabulary.

- **`docs/EXTERNAL-BENCHMARKS.md`** — what exists outside this repository for
  reliability and governance, and what running each against gnomon would take.
  Three, all 2026, none yet run against a coding harness: **ReliabilityBench**
  (consistency, ε-robustness, λ-fault tolerance — already the source of
  `fault-disclosure`'s four fault classes), **DEMM-Bench** (governance-evidence
  sufficiency across actor / authority / action / policy / decision basis /
  resource touch / lifecycle / verification), and **ProcCtrlBench** (process
  defects and control preservation, sampling TerminalBench).

  Two self-assessments made before running anything, both naming a gap rather
  than waiting for someone else to: gnomon answers roughly **6½ of DEMM-Bench's
  8 evidence dimensions** out of the box, with `decision basis` the gap; and of
  ProcCtrlBench's five control properties it holds four, with **`reversible` the
  weakest** — the edit engine refuses a drifted patch but there is no undo,
  snapshot or rollback, and git is the de facto one.

- **`test_must_fail_first` measured properly, and it is nearly idle.** Re-run
  with an authoring role holding no `bash` — the only configuration in which the
  mechanism can act, since it needs `preImages` and only `write`/`edit` populate
  those. Of 39 valid runs: 20 wrote a test that already pinned the change
  (nothing to flag), 18 wrote a test that fails on their own fix (so the check
  did not pass and the gate skips the mechanism by design), and **1** hit the
  case it exists to catch.

  The mechanism is correct. Its **applicable population on this corpus is 1 run
  in 39**, and the task shape that generates bug-pinning tests in quantity —
  writing tests *for existing code*, `daily-chain`'s 4-in-25 — cannot fire it at
  all, because a turn that writes only tests has no non-test sources. The gap
  between where it fires and where bug-pinning happens is the thing worth fixing.

- **Measured on the way: withholding the shell halves the rate at which the
  agent's own tests pass on its own fix** — 18 of 39 runs, against near-zero when
  `bash` is available. Without a shell the model cannot run the suite itself, so
  it ships tests it never executed and gets one hand-back from the declared
  check. A real operator trade that now has a number on it.

- **The `writing-tests` skill was shipped and measured on the same day, and the
  measurement is null.** 10 greenfield specifications, two passes, one variable,
  $0 on a local model: mean mutation score 0.891 → 0.896, **delta +0.005**,
  Wilcoxon exact **p = 1.0000**.

  This is a real null rather than an absent measurement: the task is not at
  ceiling (the implementation satisfies the hidden suite only 45% of the time),
  the variable demonstrably applied, and the noise floor was measured inside the
  run — the `on` arm's own pass-to-pass spread is 0.146, roughly **30× the
  effect**.

  It does not refute arXiv 2608.17177, which measured a different corpus, model
  tier and metric. It says the skill does nothing detectable *here*. Shipped on
  someone else's evidence, measured against our own, and the result published
  either way.

  One observation flagged as an observation: the instruction made the harness
  **3.7× noisier** pass-to-pass without moving the mean.

- **`benchmarks/audit-existing` — pilot RUN, not just designed.** 14 planted
  defects and 5 adversarial controls across two projects, two passes, $0 on a
  local model: **10/14 found, 0/5 controls falsely flagged, 0 containment
  violations**, and a flip rate of **1/14 = 7.1%** — half this harness's
  Terminal-Bench flip rate, so reading code is a more repeatable act than making
  a task pass.

  Three of the four misses are defects of **absence** — a required check simply
  not there — against a clean sweep of defects of presence. A hypothesis at n=4,
  flagged as such rather than reported as a finding.

  Claim accuracy came back 27/27 and is written up as a **positive control**
  rather than a score: gnomon cite-checks its own `file:line` citations in-turn,
  so `claim-check` largely re-verifies by the same rule. It becomes evidence only
  against a harness with no such mechanism.

- **`benchmarks/audit-existing/` and `benchmarks/greenfield-spec/`** —
  pre-registrations for the two workflows the operator asked about: auditing an
  existing project, and speccing a greenfield one, each against a peer. Both
  replace *judging the output* with ground truth the apparatus controls —
  planted defects with negative controls in the first, mutation scores against a
  hidden reference suite in the second — because a rubric scored by the author of
  the harness measures the author. Both sequence a **single-variable mechanism
  arm first** (gnomon's own mechanism on/off) and gate the peer arms on it: if
  the mechanism moves nothing, there is nothing for a peer comparison to show.

- **`benchmarks/peer-parity/PRE-REGISTRATION.md`** — the powered peer arm,
  **designed and deliberately not launched.** The framing is the change: five
  task-completion arms in a row have come back null, which is not five failures
  to find an effect but a consistent finding that at this model tier the harness
  is not the bottleneck. So the question is **non-inferiority** — "does the
  governance cost task completion" — which is answerable at a price this project
  can pay, where superiority is not. The arithmetic is written down: ~58 paired
  tasks for a 10pp margin, ~230 for 5pp, ~640 for 3pp (out of reach).

  Two conditions block it, both recorded there: the unexplained 900s-vs-1200s
  clock, and verifying from the peer's own logs that it ran ungated.

- **A `writing-tests.md` skill in the scaffold.** Specify preconditions,
  postconditions and undefined behaviour *before* generating the test; mark a
  spec/implementation contradiction `xfail` rather than encoding the bug as the
  contract. Test authoring is this harness's worst measured weakness — 1 in 9
  unaided, with three of nine asserting the bug — and it was fixed by an
  instruction rather than a mechanism, which is unusual enough here to ship to
  every new project. It is also the one quantitative result taken from the
  "Antifragile" report (arXiv 2608.17177, +9.8pp bug detection).

- **A coverage floor, enforced.** `scripts/coverage-floor.json` +
  `scripts/coverage_gate.mjs`, wired into `.gnomon/ci.sh`. A ratchet, not a
  target, and deliberately not self-raising. Coverage was measured on
  2026-08-31 and left unenforced for five days; it is now **85.15%** statements
  (from 75.4%, partly real tests and partly the removal of `agent.ts`).

- **A CI assertion that benchmark adapters run uncapped**, asked for by
  `BENCHMARK-REPORT-2026-08-30.md` 6.1.1 and never added. The bug class recurred
  twice — 600s once, 900s once, against peers running `float("inf")` — and it is
  invisible in the score, because it arrives as timeouts, which look like
  capability.

- **`benchmarks/context-cost`** — bytes off the wire, against a local recording
  endpoint, for both harnesses answering the same prompt in an identical repo.
  **4.66×** (opencode 36,490 bytes, gnomon 7,824). This **retires
  "13–43× leaner than opencode"**, a figure the 2026-08-30 post-mortem retracted
  six days ago with the instruction to *"lead with the pure token ratio
  (3.8–11.7×) instead"* — an instruction nothing had carried out while the
  retracted number went on being quoted. The measured answer lands inside that
  range.

  Most of the gap is tool schemas: 20,812 bytes against 4,312, for 10 tools
  against 9. Not more tools — each described about five times longer, re-sent
  every turn.

- **`benchmarks/silent-success`** — the first deliberate hunt for the bug class
  this repository has found four times by accident: a reported success while the
  thing underneath failed. Eleven decision points, each run clean and broken, so
  a probe that always reports failure cannot score a perfect zero. The negative
  control is the historic pre-`902a93f` verify rule reimplemented; it is caught.
  **0/11 falsely successful** — it found nothing, which is the result.

- **A degradation contract, and a benchmark that measures it.**
  `packages/gnomon-core/src/degradation.ts` names every way this harness carries
  on with less than it declared — twelve paths — and
  `benchmarks/degradation-contract` scores each on two endpoints:
  **announced** (the operator was told) and **recorded** (the trail says so
  afterwards). The population is read from the code's own `DEGRADATION_IDS`, so
  declaring a path without wiring it fails the benchmark.

  The two endpoints came apart, which is the finding. **12/12 announced, 8/12
  recorded** before the fixes below.

- **`degradation` audit record kind**, carrying a stable `id`, what the surface
  declared, and what happened instead.

- **`stop_reason: "truncated"`**, and `conformance/stop_reason.json` pinning the
  enumeration. The previous pin was a hand-kept array inside `docs.test.ts` that
  checked one direction of three; the union in the source, the table in
  `docs/CONTRACTS.md` and the fixture must now be the same set.

### Fixed

- **The tool walk did not skip `coverage/`.** Every other build-artefact
  directory is skipped — `dist`, `target`, `.next`, `.turbo` — and this one was
  not, so `pnpm run coverage` writing into it *while the suite ran* moved the
  worktree stamp, `worktree_changed` came back true for commands that changed
  nothing, and one step-folding test failed under coverage while passing without
  it. In a real session the same thing misfires the anti-flailing nudge on an
  agent that is working correctly. Found by turning the coverage gate on.

- **The surface audit told operators the opposite of the truth about
  `.gnomon/extensions/`, for a day.** `35cc702` excluded the directory from the
  surface walk and left the disclosure describing the behaviour before it, so a
  surface with extension files was told — specifically, and falsely — that those
  files "are INSIDE the surface hash" and that adding one "moves the hash". They
  are not, and it does not. A stale disclosure is worse than none: it is a
  confident sentence about the one thing this project asks people to trust.

  `benchmarks/surface-fidelity` did not catch it and could not — it measures
  hash against behaviour, not whether a sentence about them is true.

- **The scaffold advertised two inert edit formats as if they worked.**
  `gnomon init` wrote `# ast | hashline | str_replace` beside `edit_format`,
  with nothing marking which of the three this build implements. Now marked
  INERT at the point of choice, rather than only in the surface audit that fires
  after somebody has already chosen one.

- **Endpoint fallback left no durable trace, and the record it did leave was
  wrong.** A role falling back to `[roles.<name>.fallback]` announced itself
  only through `progress.update()` — a spinner frame the next frame overwrites,
  and `gnomon task` in a script has no scrollback for it to be overwritten in.
  So the most consequential thing that can happen to a turn, *you are not
  talking to the model you declared*, was unanswerable afterwards.

  Worse: the turn record stamped `endpoint` and `endpoint_url` from
  `route.target` unconditionally, filing the fallback's model against the
  primary's endpoint and URL. `endpoint_url` exists precisely so the trail can
  tell two runs that reached different servers apart, and this path defeated it.
  Now said, recorded, and the record follows the request.

- **A twice-truncated answer was recorded as `answered`.** A reply cut off at
  the token limit triggers one bounded request for the rest; if that reply was
  also cut off, the partial answer stood — deliberate — with
  `stop_reason: "answered"`. The operator was told twice and the record said the
  turn concluded normally. Same class as `exit null` read as a clean zero.

- **An endpoint refusing the tools array, and an MCP server failing to connect**,
  were announced and not recorded. Both now write a `degradation` record.

- **`gnomon task` recorded none of the context fields the interactive path
  records.** `context_turns`, `context_dropped` and `context_tokens` were on the
  interactive turn record and absent from the one-shot one, so the same surface
  at the same hash recorded whether it had dropped context from `gnomon prompt`
  and not from `gnomon task`. Third instance of one bug — MCP servers, the
  surface audit, and now this. Recorded per stage for a declared chain, because
  Rule 4 says three stages produce three records.

### Changed

- **`.gnomon/extensions/` is no longer hashed.** Commit `9f38bfd` *disclosed*
  that every file under it is content-hashed by both implementations and loaded
  by neither, so dropping an extension in moved the surface hash while changing
  no behaviour. Disclosure is the protective layer bolted on top; this is the
  removal — the same treatment `skills/proposed/` already had, for the same
  reason, applied to the case that was missed.

  The direction of the remaining error is stated on purpose. Excluding a path
  trades a **false positive** (hash moves, behaviour does not) for the risk of a
  **false negative** (behaviour changes, hash does not) if an extension host is
  ever built and nobody re-includes the directory — and a false negative is far
  worse for a project whose whole claim rests on this hash. That risk is not
  accepted on trust: `benchmarks/surface-fidelity/` measures both directions on
  every run, its negative control models this exact trap, and the Rust test that
  used to pin the old behaviour is now a named tripwire.

- **`compaction` now defaults to `summary`, not `discard`.** This project
  measured its own default at **0/9** on context retention against **9/9** for
  `summary` ([context-2026-08-31](benchmarks/results/context-2026-08-31/)), and
  then shipped the losing one for another four days. The measurement was
  already in `docs/EVIDENCE.md`; nothing acted on it. Reading LangChain's
  `deepagents` — which summarises at a token threshold by default — is what
  made the omission visible, which is worth recording as the actual cause.

  A surface whose `context.summary_role` is missing still degrades to
  discarding, with a message naming how many turns went; that path is
  unchanged and is why the new default is safe. The scaffold's `smol` role
  runs on the `local` endpoint, so the default costs a local call and no money,
  and `docs.test.ts` now asserts both — that a scaffolded surface declares the
  role the default needs, and that it is reachable without a key.

  **This will not move any Terminal-Bench number.** The same result recorded
  **zero compaction events across 224 trials**, because those tasks never reach
  the window. It changes long interactive sessions, which is where the 0/9 was
  measured.

  **An existing project does not get this by upgrading, and should be told so
  rather than left to find out.** The code default applies only when the key is
  absent, and `gnomon init` writes `compaction` explicitly — so every surface
  scaffolded before today still says `discard`, still scores 0/9, and keeps
  doing it until someone edits the line. The fix is one line in
  `.gnomon/config.toml`:

  ```toml
  [defaults]
  compaction = "summary"
  ```

  Migrating it automatically was considered and rejected: `.gnomon/` is
  content-hashed and human-owned, and a release that edits a committed surface
  moves the hash under a user who did not ask for it. **`gnomon migrate` is the
  middle**, added below: never automatic, one command, and it says what it
  changed and why.

### Added

- **Two benchmarks that measure properties, not task scores.** Both are
  exhaustive, deterministic and **$0** — no model, no sampling, no noise floor,
  and no MDE, because a discrepancy is a counterexample rather than an estimate.
  Both pre-register their scoring rule and both refuse to publish a number until
  a negative control has fired, on the principle that a detector which has never
  detected anything is not evidence.

  - **`benchmarks/surface-fidelity/`** mutates every path under a scaffolded
    `.gnomon/` and asks whether the hash moves exactly when behaviour moves.
    **12/12 faithful, 0 false negatives.** This is the first measurement of the
    claim everything else rests on — `conformance/manifest_golden.json` only
    ever checked that the hash is *deterministic*, which a constant function
    also satisfies.
  - **`benchmarks/fault-disclosure/`** injects the four canonical agent faults
    plus four of this harness's own degradation paths, and scores whether the
    operator is told **what actually went wrong**. **8/8 disclosed.** Survival
    is reported but is explicitly not the headline: it was 8/8 before any of the
    fixes below, so every defect was invisible to a survival-only measure.

- **The live trace folds a run of quiet steps into one line, and stops printing
  each call three times.** A recon run — read, grep, read, grep, forty times —
  is a rhythm you stop reading, and once you stop reading it you also stop
  seeing the one line that mattered. Measured on a real trace: **23 lines
  became 7**, with the single failing command standing alone between two folded
  runs instead of buried among forty identical ones.

  **Three lines per call became two, then one.** Every call was announced by
  `⚙ <command truncated at 70 chars>` from the turn loop and again by
  `⤷ <full command>  (standing approval: session)` from the approval callback,
  which no verbosity setting gated — so the *truncated* copy printed first, the
  useful one second, and a session-scope fact was restated 40+ times in a single
  turn. The second line is gone. The decision is still recorded where it
  belongs: `gnomon audit show` answers what was approved and by whom, and the
  scrollback was only ever a worse copy of it that made the calls nobody
  approved harder to spot. Granting a standing approval still announces itself
  once, in full, at the moment it is granted.

  **What is never folded**, because a fold that hid any of these would be worse
  than the noise it replaced: a failed tool call, a refusal, a step that changed
  the worktree, a step that moved the surface hash, and any step the operator is
  being asked to approve one at a time. "Changed nothing" is read off
  `worktree_changed`, which `bash` stamps by hashing the tree before and after —
  never inferred from the command text, an approach this repository rejected
  explicitly.

  This turned up a defect in the first version of the rule. `bash` returns
  `TOOL_OK` for a command that ran and exited 1, so a failing test run folded
  away as one more quiet step. `ToolOutcome` now carries a structured
  `shell_exit`, and a non-zero one breaks the fold. Structured rather than
  scraped from the summary string, because the verify gate already learned what
  a regex over that text costs when `exit null` parsed as a clean zero.

  Three ways to get the detail back, all of them present:
  - **`/cot full`** prints every step and never folds. Unchanged from today.
  - **`/expand`** lists the steps inside the most recent folded run, and can be
    typed while the turn is still running.
  - **The audit trail is untouched.** Folding is display-only: every call, its
    arguments and its result are still written, folded or not.

  The default `[ui].cot` moves from `full` to the new `work`. Safe without a
  migration, unlike the compaction change below: `cot` is not in the published
  enumerations and `gnomon init` has never written it, so the code default is
  what every existing surface already uses.

- **`gnomon migrate` — one command to bring an existing surface up to the
  current defaults.** `gnomon init` writes every default explicitly and the code
  default applies only when a key is absent, so changing a default in the source
  changes it for new projects and for nobody else. This is the command that
  closes that gap without a release ever editing a surface on its own.

  It rewrites one line at a time with a targeted match, never by parsing the
  TOML and re-serialising it: a round trip through a parser drops every comment
  in the file, and the scaffold's comments are most of what makes the surface
  readable. It only rewrites a value that **was the old default** — a value that
  is neither the old nor the new one was chosen by somebody, and the command has
  no way to tell a deliberate choice from an inherited one, so it does not try.
  It prints the surface hash before and after, because the hash moving is the
  point: behaviour changed and the record should say so.

  `--check` reports without writing and exits 1, so CI can gate on it.

- **Tool output too large for the window is written to `.gnomon-out/` instead
  of being discarded.** The truncation notice used to end *"narrow it instead"*.
  That is honest advice and it is the wrong advice for the measured failure:
  ~41% of benchmark trials end at the timeout cap and the long tail is a model
  re-running a long command, so telling it to run a *different* long command
  does not help — the bytes it needed already existed and were thrown away.
  The notice now names a path and tells the model to `grep` it.

  It says `grep` and not `read` because the first version said "read or grep"
  and **both halves were wrong when measured end to end**: a file that
  overflowed the window overflows it again on the way back, so `read` returned
  another truncated prefix and wrote a second, larger copy — and `grep` on a
  file path silently found nothing (see below). Reading an offloaded file no
  longer offloads it again, and the two defects have tests.

  Deliberately beside the surface, never inside `.gnomon/`: a tool writing into
  a content-hashed directory would move the surface hash mid-session, which is
  the hash announcing a behaviour change that did not happen. Asserted, not
  described — a test fails if the path ever starts with `.gnomon/`.

  No path is named unless the write succeeded. A read-only checkout, a full
  disk or a refused directory all fall back to exactly the previous message,
  because a citation to a file that is not there is worse than the truncation
  it replaced. Scratch is per session so `--continue` can still reach a file an
  earlier turn cited, and older session directories are pruned to the last five.

- **Skills that did not match are listed by name and path.** A skill whose
  `match` pattern is slightly wrong was indistinguishable from a skill nobody
  wrote: hashed into the surface, listed by `gnomon skill list`, and never once
  mentioned to the model. Its body still costs nothing until asked for — the
  prompt carries one line per dormant skill and the file path to `read`. The
  list is derived from the surface and the role, not from model judgement, so
  the same checkout produces the same list on every machine. Skills excluded by
  `roles` are not listed, because they are not for this role at all.

### Fixed

- **A rate limit was reported to the operator as "endpoint unreachable".**
  `classifyFailure` folds 429, 5xx and a refused socket into code 12, which is
  right for retry policy and wrong for the notice: the endpoint was reachable
  and *rejecting*, and the remedies do not overlap — unreachable sends you to
  your network, a 429 sends you to your quota. Found by injecting a 429 storm
  and reading what the operator was actually shown.

- **A truncated tool call was reported as a missing argument.** Arguments arrive
  from OpenAI-shaped endpoints as a JSON *string*; a response cut off by a token
  limit yields `{"path": "src/ma`. `JSON.parse` threw, the catch returned `{}`,
  and the call reached the tool as `read {}`, which answered *"read needs a
  `path`. Nothing was given"* — a true sentence about a false premise. Told an
  argument is missing a model invents one; told the call was truncated it
  re-emits it. Now named as a transit truncation, with the bytes that did
  arrive, and with a negative-control test so an empty argument string is still
  read as a call with no arguments rather than a manufactured fault.

- **Dropped turns were reported as folded.** The context notice chose its
  wording from the *declared* `compaction` rather than from what happened, so a
  surface whose `context.summary_role` names no reachable role was told "N
  earlier turn(s) folded into the summary" while those turns were dropped
  outright. Reachable **by default** since `compaction` became `summary` in this
  same release — a pre-existing wrong message that only started mattering once
  the default changed.

- **The scaffolded `local_first` profile declared nothing.** `gnomon init` wrote
  a `profiles/local_first.toml` carrying only `name` and `description`, while
  `config.toml` wrote `role_profile = "local_first"` — so the shipped default
  profile was applied on every fresh install and changed nothing. This
  repository rewrote its *own* profile with real role blocks on 2026-09-03 for
  exactly this reason and left the scaffold behind. Found by
  `benchmarks/surface-fidelity/` on its first honest run, which is the class of
  defect it exists to catch.

- **`grep` answered "no match" for a file that contained the pattern.** Its
  `path` argument was documented as "Directory to search under" and the walker
  called `readdirSync` on it; given a file that throws `ENOTDIR`, the catch
  meant for an unreadable directory swallowed it, and the search reported
  `No match for /x/ under path/to/file`. **A wrong answer shaped like a valid
  negative**, which is the worst kind this harness can give: a model that greps
  one file and is told there is nothing there stops looking. A file is now a
  scope of exactly one file, `include` is tested against the path itself rather
  than an empty string, and the schema says "File or directory".

  Found by following this project's own new advice — the overflow notice tells
  the model to grep the offloaded file, and it did not work.

- **No strict OpenAI-compatible provider worked at all.** The request carried
  sampling params in *both* shapes — top-level for OpenAI and a nested `options`
  object for Ollama — under the comment *"send both so either backend is
  happy"*. Ollama ignores unknown fields; strict providers reject them, and
  OpenCode answers `400 Extra inputs are not permitted, field: 'options'` —
  naming a field the user never wrote, in a request they cannot see. It fired
  for any role declaring `temperature`/`top_p`, which the scaffold writes for
  **every** role. The payload now follows the endpoint's `kind`, which was
  already resolved and unused.
- **The TOML parser accepts two valid key forms it used to refuse.** A dash in a
  key (`max-steps = 4`) and a quoted key (`"max steps" = 4`) are both valid
  TOML 1.0, and both produced a hard `cannot parse` that stopped gnomon
  starting — a message reading "you wrote invalid TOML" to someone who had not.
  A literal-string key (`'lit' = 1`) is accepted too. Dotted keys in key
  position still throw, which stays correct: pretending to read one would put
  the value somewhere the writer did not ask for.

  The fixtures moved rather than being deleted: `conformance/toml_rejected/`
  drops from eleven cases to nine and its valid-TOML count from **seven to
  five**, because exactly two were fixed. `docs/CONTRACTS.md` §5.2 says so.
  Publishing a smaller number by deleting a fixture would be the same
  dishonesty one level up. The accepted golden was regenerated from Python
  `tomllib`, the same independent parser the suite was originally checked
  against — not from gnomon's own output.
- **`.gnomon/extensions/` is disclosed as hashed-but-inert.** Every file under
  `.gnomon/` is in the surface hash, extensions included — and nothing in this
  build loads them. So dropping an extension in moves the hash, which is the
  harness announcing that behaviour changed, while behaviour does not change at
  all. That is the inverse of the usual defect and just as bad, because the hash
  is the one thing this project asks people to trust. The extension host exists
  (`agent.ts` `registerExtension`); nothing reads the directory yet.
- **A session that drops context now says so to the operator.** `buildMessages`
  declared a `notice` and never assigned it, so both of its display sites were
  unreachable: the **model** was told in-band that earlier turns had been
  dropped, and the person watching the session was told nothing. That matters
  more than it looks — the shipped default is `compaction = "discard"`, measured
  **0/9** on context retention against 9/9 for `"summary"`, so the common case
  is a session that silently forgets and then answers as though it never knew,
  with the one mechanism built to warn about it inert. The notice names how many
  turns went and how to keep them instead.
- **A published option this build does not implement is now disclosed.** The
  enumerations offer `edit_format = ast | hashline | str_replace`; only the last
  is built. A surface asking for `ast` ran on `str_replace` **in silence** — the
  surface saying one thing and the harness doing another, which is the sentence
  this project exists to prevent. The surface audit now names it, and says which
  format the run will actually use. Entries leave that table by being
  implemented, never by being quietly dropped from the contract.
- **`gnomon task --json` records non-fatal surface findings.** It reported only
  *fatal* ones, so a scripted or CI run against a surface with an unimplemented
  edit format, or a role whose allow-list admits an interpreter, saw nothing at
  all — while the interactive operator was shown every one. `surface_problems`
  is absent when clean rather than an empty array, because a field that is
  always present teaches a reader to skip it.
- **`role_profile` now does something.** It was a published enumeration that
  nothing read: `gnomon init` scaffolded `role_profile = "local_first"`, two
  profile files shipped, `loadConfig` parsed them — and no line of the harness
  ever applied one, while `enumerations --json` advertised
  `["local_first","frontier_plan","all_remote"]` to a reader who would
  reasonably conclude that picking one changed where inference goes. That is
  this project's own dominant defect class sitting inside its own contract.

  A profile merges **per field** over the base roles, so one that names a model
  leaves the endpoint alone. `--profile <name>` overrides the surface and is
  **disclosed at startup** the way `GNOMON_MODEL_URL` is, because it changes
  behaviour without moving the hash. A named profile that does not exist is
  **reported**, not ignored — silently running the base roles is how a profile
  becomes decorative in the first place.

  This is also the shortest path to what people build by hand:
  `role_profile = "frontier_plan"` points `plan` at a cloud endpoint and leaves
  the volume roles local, in one line instead of per-role edits across two files.

  The repository's own profile files carried placeholder model tags
  (`frontier:remote`, `local:large`) under a header reading *"NOT READ BY ANY
  CODE PATH"* — true when written, and the reason the tags were never real. They
  are real now. Scaffolded profiles declare no role overrides, so no existing
  surface changes behaviour on upgrade.
- **A turn now checks the `file:line` citations in its own answer.**
  `counters.citations` records checked / ok / broken / ambiguous, and the
  transcript names any that do not land. A citation is what lets a reader follow
  an argument to the code, so one that lands nowhere is a false statement in the
  most confidence-inspiring format an answer has — and nothing was checking
  them. Deliberately conservative: it reports rather than editing the answer,
  and a duplicated filename is **ambiguous, never broken**, because a checker
  that manufactures false accusations trains its reader to ignore it. (An early
  version of the standalone tool did exactly that to two correct citations.)
- **A turn now measures what it did to the worktree instead of asserting it.**
  `counters.tree_delta` carries files / insertions / deletions from `git diff
  --numstat`, plus `crlf_only` — files whose entire change vanishes under
  `--ignore-cr-at-eol`, i.e. pure line-ending churn. An external review of a
  real gnomon audit run put this first: *"claims about the code are accurate and
  well-cited; claims about its own tree state are asserted, not measured."*
  Three of its four findings were that shape — a reported "31 insertions" over a
  2,492-line diff, a tsc count quoted but never taken, and a CRLF hazard
  declared handled while the lockfile sat rewritten. Each is one git call away.
  A tree that cannot be measured reports `unavailable` rather than zero, because
  "not measured" and "nothing changed" must not look alike.
- **A surface written mid-session did not take effect, and said it had.** The
  `write` tool printed *"the hash moved, and the next turn runs under the new
  rules"*. The session kept the config it loaded at startup, so a user who
  changed a role's model saw that line and then watched `/role` report the old
  model — three times, across two sessions. `surface_drift` already existed for
  exactly this, was produced by `bash`, and was **read by nothing**. The loop
  now reloads the surface after a turn that moved it, names what moved, prints
  the new hash, and reports what the current role resolves to *now*. If the
  reload fails it says the session is still on the previous surface rather than
  claiming otherwise.
- **Tool-result messages leaked Ollama's field spelling to OpenAI endpoints.**
  `ChatMessage` carried both `tool_call_id` and `tool_name` — "both spellings,
  since backends differ" — so the second tool call of any cloud turn died with
  `400 Extra inputs are not permitted, field: 'messages[3].tool_name'`. Fixed by
  filtering the payload through a **per-kind allow-list** rather than deleting
  the field the error named: the `options` leak above was fixed by name, and the
  very next request failed on `tool_name`, one field along. A whitelist cannot
  drift that way.
- **The scaffold invented a model-id prefix that does not exist.** Its comment
  claimed OpenCode Go ids are "prefixed `opencode-go/`". They are bare —
  `glm-5.3`, `deepseek-v4-flash`. A wrong id returns a 400 naming the *model*,
  which reads as "unavailable" rather than "misspelled", so the wrong guess
  looks confirmed.
- **The missing-key refusal named a command that does not exist** (`gnomon
  models`, which exits 1). It is handed to somebody already blocked, so it sent
  them into a second failure. Both sites now say `gnomon endpoint list`.
- **`gnomon --help` printed a hardcoded `v0.1.0`** through the whole of v0.1.1,
  so the one version string a human reads could not distinguish a
  133-commit-old checkout from HEAD. It renders `harnessBuild()` now — version
  *and* commit. `harnessBuild()` had to be exported from gnomon-core to do it,
  which is why a literal was there in the first place.
- **A stray `.gnomon/` was committed inside `packages/gnomon-cli`.** Referenced
  by nothing, it silently captured any session started from that directory.

### Added

- **`gnomon endpoint list` / `/endpoints` cross-check every role's model id**
  against the ids its endpoint actually advertises, and name the nearest real
  one:

      ✗ role plan names model "opencode-go/glm-5-3" — this endpoint does not serve it
        did you mean:  glm-5.3

  The suggestion strips a provider prefix before measuring distance, because
  that is the commonest wrong form and raw edit distance suppresses the hint
  exactly when it is most needed. An endpoint that cannot be listed produces
  **no** entry: "unchecked" and "checked and fine" must not look alike.
- **LOCAL and CLOUD are headed groups** in the endpoint listing, rather than a
  `· cloud ·` fragment between two other fields. Surfaces routinely mix the two,
  and "which of these costs money and needs a key" is the first question anyone
  asks of that list.
- **`gnomon init` now scaffolds two skills.** It scaffolded none, so every new
  project began without the rules this repository had written down for itself.
  `endpoints-and-models` (list the ids, never guess one; the key may already be
  set) and `secrets` (never write a key into a file in the repository). Both
  were added after a local model configuring an endpoint wrote a user's API key
  into a plaintext `.env`, guessed two ids that do not exist, and four times
  recommended setting a key the listing already reported as set.

### Changed

- `recomputeManifest()` no longer takes a `build` argument. It never read one:
  six call sites passed the literal `"0.1.0"`, which read as if the returned
  manifest were stamped with a version. It is not, and the return type never
  carried one. A dead argument that looks like provenance is a bad thing to have
  in a codebase whose subject is provenance. The build string a record carries
  comes from `harnessBuild()`, and always did.

## [0.1.1] — 2026-09-02

A correctness release. 0.1.0 was tagged and drafted but never published; every
entry here is a defect found by auditing that tag, and two of them are defects
in mechanisms that reported success while doing nothing.

### Fixed

- **A stored credential could reroute the model.** `gnomon key set` accepted any
  variable name, including `GNOMON_MODEL_URL` — so a value outside the repository
  changed which endpoint answered, with the surface hash unmoved. That is rule 1
  inverted: the manifest said the run was reproducible and it was not.
  `applyCredentials` now admits only names a surface file declares, and refuses
  the rest by name.
- **`--continue` resumed nothing.** Session listing output was being written into
  the session store, where `session-*.json` sorted last and carried neither `id`
  nor `exchanges`; the resume path silently selected it and started fresh. Both
  the write and the tolerant read are fixed.
- **`approval = "always"` deadlocked.** Tool prefetch fired concurrent approval
  requests into a single-slot resolver, so the second one was never answered.
  Prefetch is now skipped when every call must be approved.
- **The verify gate called an unrunnable check "passed".** Exit 126/127 — script
  not executable, interpreter missing — was indistinguishable from a clean run.
  It is now reported as unrunnable: not a pass, and not handed back to the model
  as a failure it could "fix".
- **A key error opened a socket first.** Missing credentials surfaced as
  `provider_unreachable` (12, apparatus) rather than `launch_failed` (10). A
  pre-flight check runs before the connection, so a misconfigured key is no
  longer counted as the provider's fault.
- **MCP servers were absent from `gnomon task`.** `connectMcp` ran only in the
  interactive loop, so the one-shot path silently had a shorter tool list —
  precisely the failure rule 3 exists to prevent.
- **`gnomon-surface` hardcoded its revision to `local`.** It now resolves the
  revision the same way the TypeScript side does, and the two agree.
- **`pnpm -r typecheck` checked nothing.** No package defined the script, so it
  exited 0 and a real type error shipped past it. All four packages now run
  `tsc --noEmit`.
- **The test suite read the developer's credential store.** Thirteen gnomon-core
  tests copy this repository's own surface, which routes a role at an endpoint
  declaring `api_key_env`. On a machine where `gnomon key set` had ever been
  run, `~/.local/share/gnomon/credentials.json` supplied that key and the tests
  took the model path; on a fresh checkout they took the refusal path and
  failed. They were green locally and red in CI, and "passes for me" was true
  and useless — a machine-scoped dependency in the test suite of a harness whose
  first rule forbids machine-scoped configuration. A shared `vitest.setup.ts`
  now points `XDG_DATA_HOME` at an empty directory and sweeps credential-shaped
  variables out of the environment, so every run starts in the state a
  stranger's checkout is in; tests that need a key call `stubDeclaredKeys()`,
  which reads the names from the surface rather than hardcoding them.
- **The release gate read the wrong manifest.** It compared the tag against
  Cargo.toml and the root `package.json`, but `harnessBuild()` stamps records
  with *gnomon-core's* version — the one file it never read. `scripts/check-versions.sh`
  now checks all six carriers, runs in local CI as well as on tag push, and
  `scripts/bump-version.sh` updates them together.

### Added

- **`gnomon attest`** — sign a session's audit chain with an external signer
  command, and verify it. Three states are reported distinctly: signed-valid,
  signed-broken, and NOT-SIGNED. An unsigned trail is never shown as passing.
- **`gnomon replay`** — re-derive the harness's decisions from a recorded trail
  without calling a model, so a record can be checked against the code that
  claims to have produced it.
- **`[chain]`** — a declared role sequence, one outcome bucket per stage, with
  `chain_stage` audit records. It gates nothing; it is a record of which role
  ran when. Measured against no-chain on Terminal-Bench: no significant
  difference (p = 0.375, n = 2 paired) — published in
  `benchmarks/results/role-chain-2026-09-02/`.
- **`[turn]`** — nine loop constants that were compiled-in are now surface
  fields, so changing them is a hash change. Named `[turn]` rather than `[loop]`
  to avoid colliding with `.gnomon/loops/*.toml`.
- **`extra_roots`, `task_allow`, `transport_grace_ms`, and `[sandbox] exec = "docker"`** —
  declared, hashed, and documented.
- **`docs/EVIDENCE.md`** — a claim-to-measurement map, including an explicit
  "claims with no evidence" section.
- **Negative-control tests** (`gates.test.ts`) asserting each gate *can* fail.
  Written after discovering a typecheck control that could not: it ran from a
  directory with no `node_modules` and resolved an unrelated binary that exits 1
  unconditionally, so good and bad code both "failed" it.

### Changed

- Transport failures no longer consume a generation attempt (`transport_grace_ms`).
- Three surface-level checks that ran once per role now run once, cutting a
  15-report startup to 3.
- `rust-toolchain.toml` pins 1.94; 1.82 could not build a transitive dependency
  requiring edition 2024.
- Test coverage: `prompt_loop.ts` 50.3% → 72.6%, gnomon-core 74.9% → 83.9%.
  1018 tests (57 Rust, 961 TypeScript).

### Known limits, stated rather than fixed

- `role_profile` is a published enumeration that nothing reads. It is disclosed
  as declared-not-implemented rather than quietly removed.
- `gnomon-exec` cannot deserialize a `gnomon session` record (missing `seq`).
  Published as a limit in `.gnomon/ci.sh`; the two record readers are not yet
  one reader.
- The three headline comparisons run for this release — role chain, peer
  harness, and model ceiling — all returned null results at the sample sizes
  affordable. They are published as nulls, not withheld.

## [0.1.0] — 2026-09-01

The first release. Everything below is 0.1.0: the project has no earlier tag, so
there is no "since" to measure from and the whole history is the release note.

### Added

- **`/cot` — control how much of the live trace shows while it works.** Modes:
  `full` (default — reasoning + prose + every tool call/result), `think`
  (reasoning and prose only), `tools` (tool calls and results only), `brief`
  (one line per step: the call and its result), `off` (nothing until the final
  answer). The reasoning shown live respects `/think` (collapse = one line,
  show = all, hide = none); models that emit no `<think>` show nothing extra.
  Live-safe (settable mid-turn) and Tab-completes its modes. Persist with
  `[ui].cot` in config.toml.

- **MCP — stdio transport, pinned, gated, reported.** `[mcp_servers]` is no
  longer inert: a declared **stdio** server is spawned at startup, its tools
  discovered (`tools/list`) and offered to the model as `mcp__<server>__<tool>`,
  each gated per role (a role must list the tool, or its server as
  `mcp__<name>`). Calls route back over `tools/call`. Hand-rolled and zero-dep —
  a few JSON-RPC messages over a pipe. A server that will not connect is
  reported and skipped, never fatal. The reproducibility caveat is stated
  loudly: gnomon pins the server's *invocation*, not its behaviour, so pin the
  version — an MCP server is an external, non-deterministic dependency. HTTP/SSE
  transports are a follow-up.

- **Whole-terminal colour themes.** Two 24-bit palettes — `tokyonight` and
  `catppuccin` — recolour the *entire* terminal, not just printed text, via
  OSC 11/10 (the effect a full-screen TUI gets from an alternate buffer, done
  from the scrolling loop). `/theme <name>` applies one live and lists all with
  previews; the terminal's own colours are restored on exit. The 16-colour
  themes (dark/dim/light/high-contrast/mono) are unchanged and leave the
  terminal background alone. Themes now carry an optional `terminal` block, and
  `terminalThemeSequence()` builds the OSC. Needs a terminal that honours OSC
  (most do).

- **`/allow` — hand the agent the pen for `.gnomon/`, by consent.** The surface
  is human-only by default (the pillar): `write`/`edit` refuse every path inside
  `.gnomon/`. `/allow` is a per-session consent dial the human sets — `strict`
  (default, unchanged), `custom` (the agent may write the surface, every edit
  approved), `all` (standing consent). A consented surface write is always loud:
  it announces the hash moved, so the change stays auditable; and a delegated
  sub-turn is forced back to `strict`, so delegation can never acquire it. Paired
  with "guide, don't stonewall": asked to enable a capability it lacks (network,
  a tool), the agent now names the exact surface change and offers `/allow`,
  instead of a bare "I cannot".

- **`loops` — unattended supervision without a daemon.** `gnomon loop|loops`
  runs guard/act ticks off the OS scheduler (cron): a guard command decides
  whether to act, and only then does it escalate to a `gnomon task`. A circuit
  breaker halts a loop that keeps failing rather than hammering. Subcommands:
  `list`, `status`, `dry-run`, `run`, `install`, `uninstall`, `reset`, `kill`.
  Loops live in `.gnomon/loops/*.toml`. This is the one unattended path — a
  single guard/act tick each fire, never a queue, worktree pool, or daemon.

- **`[resilience]` — survive a blip, and say which failure it was.** A long run
  should not die on a transient hiccup. `[resilience]` (`attempts`, `backoff_ms`,
  `request_timeout_ms`) retries only the transient transport codes (11 timeout,
  12 unreachable/5xx/429) — never a deterministic 400 that will fail identically
  — and announces each attempt, so three tries never read as one. Scaffolded
  into every surface; enabled by default (`attempts = 3`).

- **`todo` — the checklist a long run is steered by.** A turn spanning thirty
  tool calls loses the shape of what it set out to do, and the model re-derives
  the plan from the transcript every few steps. The whole list is replaced on
  each call rather than patched: a patch protocol needs identifiers, and
  identifiers a model invents mismatch a list it has since reordered. At most
  one item may be `in_progress`, enforced. Saved with the session, so
  `--continue` picks it back up; `/todo` reads it, including mid-turn.

- **`task` — a sub-turn under another role, with that role's tools.** The
  separation this harness is built around, reachable from inside a turn. Three
  properties, each with a test: the sub-turn gets the *target* role's tools, so
  delegation cannot acquire capability; it cannot nest, because a sub-turn is
  offered no `task`; and only the answer returns, not the transcript. A role
  that may not write may not delegate — a generated template briefly gave the
  `verifier` this tool, which would have made "cannot alter what it judges"
  untrue by one indirection, and `docs.test.ts` now asserts it cannot.

- **`webfetch`, shipped disabled — and it makes `[sandbox] network` real.**
  That key was declared and unenforced; the startup banner said so, which is
  the same shape as `approval = "always"` being a dial that turned nothing. It
  now refuses the fetch and names the file. Requests are checked before they
  leave: `http`/`https` only, and the hostname must not resolve to a loopback,
  private or link-local address — checked on the *resolved address*, because
  any domain can publish an A record pointing at `127.0.0.1`, and the metadata
  endpoint at `169.254.169.254` holds cloud credentials. Redirects are not
  followed automatically; each hop is re-checked in its own right.

- **`bash_deny` — a guardrail on what cannot be undone.** `bash_allow` is an
  allow-list, and an allow-list cannot express *everything except three
  catastrophes* — which is what the implementing role needs: unrestricted bash
  for builds and suites nobody can enumerate, and no ability to force-push over
  a release branch. Deny wins over allow. Shipped with the starter surface
  covering force-push, pushing straight onto `main`/`master`/`release`, remote
  branch deletion, and `git branch -D`. It binds this agent; branch protection
  on the remote is the control that binds everyone, and this does not replace
  it.

  Case-sensitive, deliberately: `git branch -D` discards an unmerged branch and
  `-d` refuses to, differing only by case. The first version folded case and so
  blocked the safe form — caught by its own test.

- **Four skills ship with the repository** — `git-branching`,
  `authenticated-tools`, `verifying-changes`, `changing-the-surface`. Branching
  and PR discipline, the rule that `gh` and `az` are authenticated outside
  gnomon and a credential is never printed, the one command that decides
  whether a change is good, and what to do when the right answer is a surface
  change.

- **[docs/POSITIONING.md](docs/POSITIONING.md)** — where this sits against
  other harnesses, what it does differently as mechanism rather than intention,
  and where it is behind. It states plainly that no public benchmark has been
  run and that the numbers in it are local measurements.

- **`converge_after` — a step-budget convergence phase (`roles.toml`).** A
  Terminal-Bench sweep showed gnomon's answers match the field's leaders —
  identical wrong-answer counts to goose and forge — but on weak models it
  spends its whole step budget exploring and the *external* clock kills the
  process with nothing submitted, scored as apparatus failure. Past this
  fraction of `max_steps_total` the harness urges the model to stop exploring
  and submit what works or conclude it cannot, re-firing as the remaining budget
  shrinks. Deliberately a step fraction, never a wall-clock deadline: a fast box
  and a slow box must behave identically on the same hashed surface. Opt-in —
  absent means full exploration, which is what wins on capable models.

- **The idle nudge — a model that changes nothing gets told to decide.** The
  stall check catches a call repeated verbatim; it misses the other measured
  failure, a model running many *different* read-only commands and converging on
  nothing (one weak-model run made ~100 distinct probes over twenty minutes).
  After `NUDGE_AFTER_IDLE` calls with no write the harness nudges it to act or
  conclude, re-firing every interval so a single reminder is not simply ignored.

- **`[verify]` shipped enabled, via a non-recursive `verify.sh`.** The gate that
  runs a declared check after a turn changes files, turned on for this
  repository. The command is `verify.sh` — a TypeScript typecheck of the
  workspace (~3s) — deliberately *not* `ci.sh`: ci.sh runs the vitest suite that
  exercises `runAgenticTurn`, so a write-turn would recurse into the gate. A
  typecheck catches the most common said-it-did-vs-did-it gap, an edit that does
  not compile, without re-entering the agent's own test path.

### Fixed

- **`apparatus_failure` is reserved for a turn that *ends* unrecovered.** The
  turn's code was accumulated with a monotonic `worse()`, so a single mid-turn
  transient the model recovered from — a bash command that hit its own deadline
  (`TOOL_FAILED`), a retried 5xx or timeout — stamped the whole turn
  `apparatus_failure` even after it wrote an answer and concluded cleanly. That
  mislabels the agent's result as a harness failure, and under valid-trial
  scoring silently drops completed work from the denominator. A new `settle()`
  keeps `apparatus_failure` only when the *terminal* step is apparatus-tier (the
  final model call failed); a result or refusal terminal — a clean conclusion, a
  stall/wall floor, a cancel — drops a superseded apparatus code, while
  non-apparatus codes still take the worse of the two so a refusal floor is never
  demoted to a result. Surfaced by the P0 benchmark, where converge-on arms
  showed 12.5%→38.5% `apparatus_failure` on hard tasks whose transcripts had
  written valid answers; `converge_after` itself is a bystander.

### Changed

- **Open-source release hardening.** The default `gnomon init` scaffold no
  longer seeds the author-private `septacore check` as the verifier's first
  `bash_allow` entry — any shell command satisfies the gate, and the built-in
  `[verify]` block works with nothing external installed. A `.gitattributes`
  forces LF so the content-hashed surface hashes identically on a Windows
  checkout. Docs now match what shipped (MCP stdio, themes, `/allow`), state the
  Linux/macOS-only support stance, and carry the maintainer contact; the
  Terminal-Bench campaign ships a `summarize.py` that regenerates its buckets
  from raw data and a reviewer section (tasks, arms legend, scoring rule,
  caveats). Machine-specific paths were removed from the tracked repro scripts.

- **`[sandbox] network = false` is enforced for `webfetch`** and the startup
  note no longer says it is unenforced. It says what is true instead: enforced
  for the tool gnomon controls, and *not* process isolation, because `bash` can
  still reach the network through `curl` or a package manager and no
  allow-list over shell text can honestly claim otherwise.

- **A malformed tool argument is `11`, not a refusal.** `compute` returned a
  refusal for an expression that would not parse, which put it on the wrong
  side of a line the published contract already draws: refusal (2-4) is
  something saying no — a declined approval, an allow-list, a tool the role was
  not given — and `11` is a tool that understood the request and could not
  carry it out, the bucket "ambiguous edit" already lived in.

### Security

- **Pre-release security audit — five confinement bypasses closed** (each with a
  regression test):
  - *bash allow-list bypass.* A single-quoted argument ending in a backslash
    kept `scanShellCommand`'s quote open (it applied the double-quote escape
    rule to single quotes, which bash treats literally), so
    `cargo test --features 'x\'; curl … | sh` scanned as one allow-listed
    segment and ran as two commands. Single quotes now close on the first quote.
  - *strict surface guard vs. a symlink.* `inSurface` compared a lexical path
    while the write followed the link, so `write glink/roles.toml`
    (`glink -> .gnomon`) skipped the strict/consent gate and landed in the
    surface. It now realpaths both sides, matching the sandbox check.
  - *delegated consent.* A `task` sub-turn inherited the human's `/allow`, so
    under `custom|all` a model-chosen sub-turn could write the surface. Forced
    to `strict` at any delegation depth.
  - *MCP calls ran ungated.* `mcp__…` dispatch called the server directly with
    no approval, even under `gate = "always"`. Now gated like a mutating tool.
  - *MCP environment leak.* A spawned server inherited the full process
    environment — every provider key and stored credential. The child env is now
    a minimal base plus only the names the surface declared.
- **webfetch SSRF: IPv4-mapped IPv6 blocked.** `http://[::ffff:a9fe:a9fe]/`
  (169.254.169.254) and `::ffff:7f00:1` (127.0.0.1) reached the guard in hex
  form — which Node's URL parser keeps, and normalizes the dotted form down to —
  and the dotted-only check missed them. The hex tail is decoded and re-checked.
  The residual single-resolution DNS-rebinding window is documented at the guard.
- **The `.gnomon/` surface is not writable by a tool call in the default
  `strict` mode.** `write` and `edit` refuse any path inside it, whatever the
  role and whatever the approval gate; `/allow custom|all` is the human-consented
  path that lifts it (see Added), and even then `edit` always refuses and a
  delegated sub-turn is forced back to `strict`. The surface decides the tool list, the approval gate and every
  allow-list, so an agent that could write there could rewrite the rules it was
  being judged by — `gate = "never"`, a wider `bash_allow`, an `edit` tool it
  was not given — and the next turn would run under the surface it authored. It
  also moved the surface hash silently, which is the one identifier a session
  is traced by. Verified: an agent asked to set `gate = "never"` is refused, and
  the hash is unchanged afterwards. The `skill` tool remains the sanctioned way
  in, and its proposals are inert until a person accepts them.

- **`bash` cannot be prevented from moving the surface, so it is detected.**
  The command is arbitrary shell and an allow-list that tried to spot every way
  a process can touch a file would be a guess dressed up as a guarantee. The
  hash is re-read after every `bash` call instead; if it moved, the tool result
  says so to the model and the transcript line reads `bash — exit 0 · surface
  changed`. Detection rather than prevention is the honest primitive, and it
  catches every mechanism rather than the ones someone thought of.

- **The sandbox follows symlinks.** `resolveInRoot` compared paths with
  `resolve()`, which is string algebra: it collapses `..` and nothing else, so
  a symlink inside the repository reached anywhere on the filesystem while
  `sandbox = "confined"` was set. This was a full escape in both directions —
  reading a file the repository does not contain, and creating one outside the
  root. Real paths are compared now, on both sides, so a checkout reached
  through a symlinked parent still resolves to itself.

### Added

- **`grep` and `glob`.** Finding a symbol was previously either a guess at a
  filename or a `bash` call, and under `approval = "on_write"` every `bash`
  call costs an approval — so a role without `bash` could not find a file it
  had not been told the name of. Both are read-only and therefore never gated.
  Measured on the same task, same model: **11 tool calls and 25.1s with a wrong
  answer, against 1 call and 4.5s with the right one.**

- **`compute` — arithmetic the model is not asked to do in its head.** A model
  asked for a number produces one whether or not it computed it, and the wrong
  answer arrives with the same confidence as the right one. Exact decimal
  arithmetic over scaled BigInts, so `0.1 + 0.2` is `0.3` and `19.99 * 3` is
  `59.97`. It is a recursive-descent parser, never `eval`: the expression is
  model-authored text from an inference endpoint, and handing that to a
  JavaScript evaluator would make every arithmetic question a code-execution
  primitive. It is also self-contained rather than shelling out to `python3` or
  `bc`, because "whichever interpreter this machine has" is precisely the
  machine-scoped dependency Rule 1 forbids.

- **Token accounting from the backend.** `prompt_eval_count`/`eval_count`
  (Ollama) and `usage.prompt_tokens`/`completion_tokens` (OpenAI) are read,
  summed across every model call a turn makes — a turn with six tool calls made
  seven — and reported on the meta line (`2.3s · 1.7k in 93 out`), in `--json`
  under `volatile`, and in the audit trail. A measured count prints bare and an
  estimate keeps its `~`, because the existing `estimateTokens` is a
  ~4-characters-per-token approximation that exists to slide the context window
  identically on every machine and is wrong on code. A backend that reports
  nothing leaves the key off rather than writing `0`.

### Fixed

- **`approval = "always"` now means something.** It was consulted only by
  `bash`, `write`, `edit` and `skill` — which are exactly the `on_write` stops —
  so the two settings behaved identically and `always` was a documented dial
  that turned nothing. Every tool consults the gate now, so the three values
  are three ways to work: `always` asks about every call including reads and
  searches, `on_write` asks only about calls that can change something, `never`
  asks about nothing. A test asserts the first two are distinguishable.

- **The TUI banner was thirteen columns narrower than its border.** Both boxes
  in this repository had shipped misaligned; the padding is computed from the
  border width now, and measured on the bare string so ANSI escapes — which
  occupy characters and no columns — cannot shift it again.

- **Refused turns are no longer erased from the conversation.** Context was
  filtered to `code === 0`, so every refusal and every apparatus failure
  vanished from history. Denying a write and then saying "put it in `src/`
  instead" left the model with no referent for "it" — the most common thing a
  person does after a gate fires was the one the harness forgot. Replay is now
  decided by bucket: result and refusal both replay, because both are things
  the model said; apparatus_failure does not, because there the output really
  is a transport error string.

- **`./gnomon` ran in the wrong directory and mangled its arguments.** The
  repo-root shim still had the two bugs the real launcher documents having
  fixed: `cwd` pinned to the checkout, so running it inside another project
  operated on gnomon's own surface, and `shell: true`, which re-split the argv
  array through `sh` — `./gnomon task "fix the login bug & ship it"` arrived as
  five arguments with the remainder backgrounded at the `&`. It is now a thin
  re-exec of `packages/gnomon-cli/gnomon.js`, so there is one launcher policy
  rather than two.

- **The interactive banner was a column wider than its own border.** Both
  content lines measured 46 against the border's 45.

### Known

- **~200ms of the per-invocation overhead is `tsx` transpiling the sources.**
  Measured against a raw Ollama call on the same prompt: 126ms raw, 356ms
  through `gnomon task`, with a 197ms boot floor — so gnomon's own logic is
  ~33ms and the rest is startup. An interactive session pays it once; a script
  calling `gnomon task` in a loop pays it every time. Removing it means running
  compiled output, which means giving every workspace package conditional
  `exports` (they all currently point at `./src/index.ts`) and changing what
  vitest resolves. That is a deliberate change to how the workspace builds, not
  something to slip into a hardening pass.

- **Enabling `[audit]` costs nothing measurable.** 338ms with the trail on
  against 354ms with it off, over the same task — within run-to-run noise.

### Added

- **`/session` opens an arrow-key picker.** Sessions are listed by when they
  were and what they were about — the identifier is how the file is named, not
  how anyone recognises a conversation. Continuing one previously meant reading
  a list, copying a timestamp-and-pid string, and typing it back. `/session
  <id>` still works for scripts, and a non-TTY still gets the printed list.
- **A guard for working on gnomon itself.** Running from the harness checkout
  is how gnomon is developed and almost never what a user of gnomon intends;
  the banner now says which of those is happening.

- **Colour themes.** `[ui] theme` and `/theme` — `dark` (default), `dim`,
  `light`, `high-contrast`, `mono`. The default no longer uses ANSI "bright
  black" for secondary text, which on a dark terminal is charcoal on charcoal
  and carries most of the meta lines, context notes and tool arguments.
- **A live command menu.** Matching commands appear under the prompt as `/` is
  typed. Tab completion only helps someone who already knows a command exists.
- **`reserve_output`** — tokens held back for the model's reply. The window
  used to fill `max_context_tokens` completely, leaving nothing to answer with,
  and the ~4-characters-per-token estimate under-counts code; both errors
  pointed the same way. Defaults to 15% of the budget, at least 1024 and never
  more than 40%. Measured: 200 turns now settle at ~85% of budget, not 100%.
- **`docs/DESIGN.md`** is a real document — the constraint, what it forced,
  what is deliberately not deterministic, and what this repository does not own.

- **`/new`** — start a fresh session, leaving the current one on disk and
  resumable. **`/session <id>`** switches to an earlier one in place, and
  `/session` with no argument lists them with their opening lines.
- **Commands that only read state or change rendering now run mid-turn** —
  `/think`, `/meta`, `/context`, `/tools`, `/help`, `/explain`. Anything that
  would move the role, the history or the session still waits, because a turn
  bound to those should not have them change underneath it.

- **`gnomon init` detects models instead of guessing.** The templates named
  fixed tags, so a machine with a 35B model was scaffolded onto a 14B one — the
  template could not know, guessed low, and was wrong on the very machine it
  was guessing for. It now asks the model host, picks the largest under ~70B
  for the reasoning roles (a 120B default is minutes per turn) and the smallest
  above ~6B for `smol` (which folds evicted turns into the running summary, so
  a 4B summariser is a false economy), excludes embedding models, and writes
  what it found into `roles.toml` as a comment. Detection runs once, at
  scaffold time; the result is concrete hashed data like the rest of the
  surface. With no host reachable it falls back to generic tags and says so.

- **Tests for the parts that shipped untested.** `session_store` (resume had
  been verified only by hand), `agent.ts` including the surface-drift
  detection that could not fire before the hash was fixed, `runTask` — the
  documented non-interactive contract — `listModels`, and the credential
  precedence reporting. 389 tests total, up from 322.
- **Documentation coherence tests.** `docs.test.ts` checks the README against
  the code: every CLI command it lists is dispatched, every slash command it
  names is registered and Tab-reachable, every default it quotes is what a
  scaffolded surface actually has, every file it points at exists, and the
  Known Limits section still states the limits that are real.

- **Turns continue past `max_steps`.** It is a checkpoint now, not a wall: the
  harness compacts the turn's working context and carries on to
  `max_steps_total` (default `max_steps × 8`). A session left running
  unattended cannot depend on someone noticing a stall and re-prompting.
- **Working-context compaction inside a turn.** Between turns the history was
  folded; nothing did that *within* one, and a turn that reads forty files
  accumulates forty tool results — on a long run that is what overflows first.
  Instructions and the original request are never what gives way.
- **Stall detection.** The same tool call repeating three times ends the turn.
  A circle is not progress, and on autopilot it would burn the whole budget.

- **`gnomon key set|list|unset`** — store an API key for an endpoint that
  declares one. `gnomon key set zen` resolves the variable name from the
  surface; a bare `VARIABLE_NAME` works too. Input is hidden on a terminal and
  read from stdin when piped. Values are stored machine-locally at mode 0600,
  outside every repository, and never printed: the surface names the variable
  and must stay safe to commit. An exported variable always takes precedence.

- **`/explain <topic>`** (alias `/reflect`) — what a feature is, how *this*
  repository currently has it configured, and what to do next. The middle
  section is the point: documentation explains a feature in the abstract and
  leaves the reader to work out whether any of it applies to the project in
  front of them. Reads the live surface; no model call, because an explanation
  of a deterministic harness that varied between runs would be a poor way to
  learn it. Topics: approval, audit, context, endpoints, manifest, roles,
  sessions, skills, tools.
- **`/models`** — asks each declared endpoint what it actually offers, so
  putting a hosted or local model on a role is discovery rather than guessing
  a tag and finding out from an opaque API error.

- **Standing approvals.** `[a]ll this turn` and `[s]ession` alongside yes/no.
  A repository survey costs a dozen read-only calls before any work starts,
  and approving each separately is a rhythm you stop reading rather than
  oversight. Both are recorded in the audit trail as standing approvals, so
  the record never implies each call was seen individually.
- **The model's reasoning is shown before the approval prompt.** It was being
  discarded, leaving a command and no reason for it.
- **A working-context block in the system prompt** stating that tool paths are
  relative to the repository root. Deliberately path-free: an absolute path
  would make the prompt differ between machines.

- **`zen` and `go` endpoints are declared by default**, inert until a role
  names one. They shipped commented out, so a scaffolded project's
  `/endpoints` listed only `local` with no sign the others were possible.
- **`/endpoints` reports usage and key presence** — which roles route to each
  endpoint (primary or fallback) and whether its `api_key_env` variable is set
  in the current shell. "Not configured" and "configured but nothing routes to
  it" look identical in a plain listing.

- **`mode = "suggest"`** — a middle setting between `manual` and `auto`. The
  routing rules propose a role and you confirm per turn ([y]es once, [a]lways,
  [N]o), with the role's tool list shown so the consequence of accepting is
  visible. `a` switches the session role. A non-interactive run treats
  `suggest` as `manual` and names what it would have proposed, rather than
  deciding unattended.

- **Session resume.** Conversations are saved after every turn to
  `.gnomon-sessions/`. `gnomon prompt --continue` resumes the most recent,
  `--resume <id>` a specific one, `gnomon sessions` lists them, `/session`
  shows the current id. A snapshot records the surface hash it ran under, and
  resuming across a changed surface says so — behaviour comes from the
  surface, never from the snapshot.

- **`gnomon launch`** — creates `.gnomon/` if missing, then opens the loop.
  One command to start in a project.
- **Auto-compression.** `compaction = "summary"` now works: turns evicted from
  the window are folded into a running summary by `context.summary_role`
  (default `smol`), which replaces them in the prompt. It was declared but
  unimplemented since the beginning. `discard` and `truncate` stay
  bit-reproducible; `summary` trades that for retention, which is why it is not
  the default.
- **`[audit]` — traceability, off by default.** Hash-chained JSONL of every
  turn, tool call and approval decision, carrying the surface hash that
  determined the behaviour. `record = "metadata"` keeps prompt and response
  text out of the log entirely; `redact` scrubs patterns from any text that is
  recorded. `gnomon audit verify` re-hashes the chain and names the first
  broken record. The trail lives outside `.gnomon/` because writing inside a
  content-hashed surface would change its hash every turn.
- **`bash_allow`** — per-role shell command allow-list.

- **`[routing]` — auto mode.** The harness can pick the role per turn from
  rules declared in the surface, announcing the switch and its reason. An
  explicit `/role` prefix always wins. `/mode` switches for the session.
  Rules live in the surface rather than the model's judgement so routing stays
  reproducible.
- **Skills.** `.gnomon/skills/*.md` with TOML front matter, selected by
  declared pattern and role and appended below `system.md`. The `skill` tool
  (coordinator only) *proposes* into `.gnomon/skills/proposed/`, which is not
  loaded; `gnomon skill accept <id>` moves it into the surface, changing the
  hash deliberately and applying next session. An agent that rewrote its own
  skills mid-session would break the harness's central claim, so it cannot.
- **`gnomon task "<what to do>" [--role] [--yes] [--json]`** — a documented
  non-interactive invocation emitting a record with `surface_hash` and
  run-to-run differences confined to `volatile`. Exit code carries the bucket.
  Gated tool calls are refused unless `--yes`: a non-interactive run has nobody
  to ask.
- Single-quoted TOML literal strings, so a regex needs no escaping.
- `/mode`, `/skills`; `gnomon skill list|accept|reject`.

- **`[endpoints]` in config.toml.** Named inference endpoints (`local`,
  and whatever else you declare — OpenCode Zen, OpenRouter, any OpenAI-shaped
  API), selected per role and per fallback with `endpoint = "<name>"`.
  Routing now lives in the surface and is hashed with it; previously the
  primary URL came from `GNOMON_MODEL_URL` or a hardcoded localhost default,
  so where inference went was machine-scoped — the one thing Rule 1 forbids.
  Credentials are still referenced by name only.
- **Per-role tool scope.** `tools = [...]` in `roles.toml` narrows what a role
  may call, enforced by omitting the tool from what the model is offered
  rather than by asking it to abstain.
- **`coordinator` / `implementor` / `verifier` roles** in the starter surface,
  separated by capability: the coordinator has no `edit`, the verifier has
  neither `write` nor `edit`.
- **Tab completion** for slash commands, role names, and `/think` modes,
  driven by the same registry `/help` prints.
- **`/tools`** and **`/endpoints`**.

- **`/role <name>` switches role for the session.** `/roles <name>` does the
  same, since that is what people type.
- **Esc cancels the turn in progress** (Ctrl+C does too, mid-turn). The abort
  reaches the model request and is checked between tool calls, so a cancelled
  turn never leaves a half-applied edit. At the prompt, Esc does nothing.
- `.gnomon/` now resolves by walking up from the cwd, the way git finds
  `.git`, so gnomon works from any subdirectory of a project.
- The prompt shows the current role (`implement ▸`).

- **`gnomon init`** — scaffolds a documented starter `.gnomon/` surface into
  any project. `--from <path>` copies an existing surface instead, `--force`
  replaces one, and it refuses to clobber a surface without it.
- **`pnpm run link:global`** puts `gnomon` on PATH, so the harness can be used
  from any project rather than only from its own checkout.

- **Tool execution.** `gnomon prompt` now runs the tools declared in
  `tools.toml` — `read`, `bash`, `write`, `edit` — feeding results back until
  the model answers in prose, bounded by `max_steps` from `roles.toml`.
  Previously the tools were declared but never sent to the model and never
  executed, so any question about the repository was answered from invention.
- **Approval gate** honouring `approval` / `policy.toml [approval] gate`, with
  a real LCS diff preview before any write. A declined call reports `refusal`.
- **Sandbox confinement**: under `confined`/`strict` every tool path must
  resolve inside the repository root; `../` and absolute paths are refused.
  `network = false` is declared but not enforced, and the loop says so at
  startup rather than implying isolation it does not provide.
- **Real outcome buckets.** Tool codes follow `conformance/exit_codes.json`,
  so `refusal` is reachable for the first time — it was previously derived
  from HTTP status alone and could only ever be `result` or
  `apparatus_failure`.
- **`tools` meta field** showing tool-call count per turn.

- **Conversation history in `gnomon prompt`.** The loop now replays prior turns,
  driven by the `[context]` block that was already declared (and already
  hashed) in `config.toml` but never read. `policy = "full" | "sliding_window"`,
  `compaction = "discard" | "truncate"`. Failed turns and `<think>` blocks are
  never replayed. History is in-memory for the session — nothing on disk.
- **`[ui]` block in `config.toml`** — configurable meta line (ordered fields
  from `turn`, `role`, `model`, `bucket`, `status`, `duration`, `context`,
  `tokens`, `think`), `meta_style`, chain-of-thought visibility, spinner,
  colour. Rendering moved to `gnomon-core/src/render.ts`, pure and testable.
- **Live progress indicator** with elapsed time, replacing the static
  "… thinking" line. Degrades to one static line on a non-TTY so piped output
  stays greppable.
- **New interactive commands**: `/context`, `/reset`, `/meta`, `/think`.

### Fixed

- **A conversation transcript was committed to the repository.** A session
  snapshot under `.gnomon-sessions/` was tracked and the directory was absent
  from `.gitignore`. Untracked, and both `.gnomon-sessions/` and
  `.gnomon-audit/` are now ignored — they hold conversation text and must never
  be published.
- **A tight window dropped the newest turn.** The oldest anchor was filled
  first, so when little fitted, the turn just taken — the one the next turn
  continues from — was what gave way. The anchor now yields first.
- **Three stray per-crate `Cargo.lock` files** were tracked. In a workspace
  only the root has one; the others were ignored by cargo and pure noise.
- The `P0_*` spike files sat in the repository root and referred to a
  dependency that no longer exists. Moved to `docs/spikes/`.
- **You could not see what you were typing during a turn.** The progress
  spinner writes a carriage return and an erase-line every 80ms, wiping each
  keystroke as fast as the terminal echoed it. Typed-ahead input was being
  queued correctly the whole time — it was simply invisible, which made the
  feature unusable. The spinner now yields the line on the first keypress,
  resumes when the line is submitted, and a queued line is acknowledged.
- **`/reset` destroyed the session it cleared.** Clearing history while keeping
  the session id meant the next turn's snapshot overwrote the record of
  everything before it. It rotates to a new session now, like `/new`.
- **`/reflect` was unreachable.** It worked as an alias for `/explain` but was
  never registered, so it appeared in neither `/help` nor Tab completion.
- **An unset `max_steps` looked unlimited.** It silently fell back to a default
  of 12 that lived in TypeScript and appeared nowhere in the surface. A session
  read `roles.toml`, correctly observed that `plan` had no `max_steps` key,
  concluded there was no limit, and then hit 12. The default is now exported
  and shown by `/roles` and `/explain roles` as "12 (default)", and every
  scaffolded role states its own budget so nothing depends on an invisible
  number. Survey-heavy roles raised: plan/coordinator/verifier 20,
  critique 16, implement 28, implementor 32.
- **Reaching `max_steps` threw the turn's work away.** A turn that had read
  eight files stopped mid-sentence with "Let me explore the key directories".
  The budget caps *tool calls*, and a wrap-up costs none — so one final
  tool-free call now asks the model to answer from what it gathered and state
  what it could not examine. The outcome stays `refusal`, because the harness
  did refuse to continue, but the answer is no longer discarded.
- **`/manifest` printed a pointer to another command.** "Use: gnomon surface
  manifest" — no hint what a manifest is or why anyone would want one. It now
  shows the surface hash, the files it covers, when it changes, and why that
  matters.
- **`/skills` explained nothing when there were none.** Two empty lists and the
  word "surface" told a first-time reader what the feature was not. It now
  says what a skill is and how to make one.
- **`max_steps` was too low for a survey.** A repository audit hit the cap at
  10 calls with useful work done and nothing to show for it. Raised for the
  high-volume roles, and the message now names the knob and says the work so
  far stands.
- **A model API error reported only its status.** `Model API error: 400 Bad
  Request` discarded the body, which said
  `deepseek-r1:… does not support tools`. A real session spent three turns
  hunting for a missing model that was installed and answering fine — it
  simply could not accept a tools array. The body is now included.
- **A model that cannot accept tools now works.** The request is retried once
  without them, announced (never silently — a turn running with fewer tools
  than the surface declared is exactly what system.md forbids passing
  unremarked), and remembered so the rejection is paid once per session. The
  notice names the durable fix.
- **`/role` in auto mode looked broken.** Switching role and then being routed
  elsewhere on the next turn gave no hint the two features were interacting;
  `/role` now says when the mode may still override it.
- **The scaffolded routing rules and `bash_allow` matched nothing.** In a JS
  template literal `\s` is an invalid escape that collapses to `s` and `\b`
  becomes a backspace, so every regex in the `gnomon init` templates shipped
  with its backslashes stripped. `spec out a caching layer` did not route to
  the coordinator, and the verifier's command allow-list — the control that
  makes that role read-only — permitted nothing and would have refused the
  test commands it exists to allow. Structural tests passed throughout,
  because a broken pattern is still a string in an array. The tests now assert
  that the rules route the inputs they claim to and that the allow-list
  permits `cargo test` while refusing `echo pwned > hack.txt`.
- **The TypeScript surface hash was a constant.** `collectSurface` expected a
  project root and appended `.gnomon`, while every runtime caller passed the
  already-resolved `.gnomon` directory — so it looked for `.gnomon/.gnomon`,
  found nothing, and hashed "every file absent". That value was identical in
  every repository and never changed when the surface did, which made the
  audit trail's attribution meaningless, `gnomon task`'s record meaningless,
  and drift detection — in `agent.ts` since the beginning — incapable of
  firing.
- **The two surface-hash implementations disagreed.** gnomon-surface prefixes
  canonical paths with `.gnomon/` and the golden fixture pins that; the
  TypeScript one did not, so the same directory produced two different hashes
  under the same name. Aligned, with a test in gnomon-cli comparing them.
- **The manifest sort was locale-sensitive.** `localeCompare` orders
  punctuation differently under different collations, so the same surface
  could hash differently on two machines — machine-scoped behaviour inside the
  hash meant to prove behaviour is not machine-scoped. Now byte-wise, matching
  the Rust implementation.
- **The manifest test fixture path was wrong** (`../../` from `src/` reaches
  `packages/`, not the repository root). Every assertion still passed, because
  a manifest of files that are all absent is still a manifest. The tests now
  assert that sources are actually hashed and that the hash tracks a change.
- **Compaction compounded loss.** Each fold re-summarised the existing record
  along with the new turns, so early facts were compressed repeatedly. Folds
  now append, and the record is re-folded whole only when it outgrows
  `retain_after`.
- **Declared MCP servers were silently ignored.** `tools.toml` documents an
  `[mcp_servers]` block that nothing reads. Declaring one is now reported at
  startup as not connected, rather than leaving the tool list quietly shorter
  than the surface asked for.
- **A role with `bash` was never read-only.** An end-to-end audit found the
  `verifier` — `tools = ["read", "bash"]`, no write tool — creating a file
  through `bash` on its first attempt. Restricting `write`/`edit` is
  meaningless while `bash` is available. `bash_allow` now constrains it, and
  the starter `verifier` ships with a list that permits running the suite and
  nothing else.
- **`parseToml` did not support multi-line arrays.** `key = [` parsed as the
  string `"["`, which would have silently emptied every multi-line list in a
  surface — including a `bash_allow` that was supposed to be containing a
  role. Array items are now split on top-level commas only, so a comma inside
  a quoted pattern no longer tears it in half.
- **The audit chain never verified.** `JSON.stringify` drops undefined-valued
  keys, so records were hashed with fields that were absent on read and every
  chained trail reported as broken. Caught by testing tamper detection rather
  than assuming it.
- **A redaction pattern that would not compile failed silently, and open** —
  the text it was meant to scrub got written. Patterns are validated at
  startup and reported. The shipped default itself used an inline `(?i)`,
  which JavaScript rejects.
- **`gnomon task` recorded nothing.** Auditing was wired only into the
  interactive loop, leaving the non-interactive path — the one most likely to
  need a trail, since nobody watched it — unrecorded.
- **`gnomon surface` ignored the upward search.** From a subdirectory it
  passed no directory to the native binary, which then hashed a `.gnomon/`
  that was not there and reported a hash of absent files instead of saying so.
- **A role prefix no longer pins the session.** `/smol ...` overwrote
  `currentRole`, so one smol turn silently routed every later turn to smol
  with no command to undo it. A prefix now applies to that turn only.
- **A tool can no longer crash the session.** `write` to a directory hit an
  unguarded `readFileSync` and threw `EISDIR` out of the process, ending a
  live run. Directory paths are rejected as tool failures, and every tool
  dispatch is wrapped so a throw becomes an `apparatus_failure` the model is
  told about.
- **A missing file is a `result`, not an `apparatus_failure`.** The tool ran
  and the answer was "absent"; marking normal exploration as broken apparatus
  made the bucket meaningless.
- **A mistyped slash command is no longer sent to the model.** `/helpo` spent
  a full turn on a typo; unknown commands now report and suggest the nearest.
- **Unrecognised approval input re-asks instead of counting as "no".** A stray
  keystroke silently refused the tool call. Typed-ahead lines are held aside
  and replayed rather than answering a prompt the user had not yet seen.
- Removed the `status` meta field, which duplicated `bucket` beside the glyph
  already printed on the same line.
- **The `bin` entry could never have run.** `packages/gnomon-cli/gnomon.js`
  used `require` inside a `"type": "module"` package (an immediate
  ReferenceError), resolved the harness root one directory too high, and
  pinned `cwd` to the checkout — so even once loadable it would have operated
  on the harness instead of the user's project. Rewritten as ESM that locates
  the checkout relative to itself and inherits the caller's directory.
- **`parseToml` did not support `[[array-of-tables]]`.** The `[table]` pattern
  also matches `[[tools]]`, so all four `[[tools]]` entries in `tools.toml`
  collapsed into a single key named `"[tools]"` (last one wins) and
  `isToolEnabled` returned **false for every declared tool**.
- **`parseToml` never stripped inline comments**, so every documented value in
  `config.toml` parsed as the whole line — `approval` read as
  `"on_write"   # never | on_write | always`, so no enum value ever matched.
  This made `[context]` unreadable and silently broke `[defaults]`.
- **CI had never run.** `dtolnay/rust-action` does not exist (it is
  `dtolnay/rust-toolchain`), failing all four Rust jobs at setup; and
  `pnpm/action-setup@v4` hard-errors when `version:` is set alongside
  `packageManager` in `package.json`, failing the TypeScript job. Both fixed;
  `clippy` is now requested explicitly as a toolchain component.
- The "first turn after idle loads the model" hint printed on every turn.

### Scaffold — 2026-08-23

The repository's first day, kept as its own subsection because it is the one
part of 0.1.0 with a date anybody can check (`git log --reverse`). It carried
the `[0.1.0]` heading and the placeholder date until the release section above
was written.

#### Added

- Repository scaffold with full layout
- `.gnomon/` config: `config.toml`, `system.md`, `roles.toml`, `tools.toml`, `policy.toml`
- Profile templates: `local_first`, `frontier_plan`
- Rust crate skeletons: `gnomon-surface`, `gnomon-edit`, `gnomon-exec`
- TS packages: `gnomon-core`, `gnomon-cli`, `gnomon-natives`, `gnomon-tui`
- Contracts document + conformance fixtures (red)
- P0 spike template
- Roadmap with 5 phases
- CONTRIBUTING.md, CHANGELOG.md
- Agentcenter outbox sync reference

#### Phases

- P0: 🟡 Partial (hook surface not yet validated)
- P1: ✅ Done (fixtures written, red on arrival)
- P2: ✅ Partial (agent loop, role routing, model serving, prompt loop, session TUI)
- P3: ✅ Done (manifest, hash, golden fixture)
- P4: ✅ Done (buckets, exit codes, session validation)
- P5: ✅ Done (patches, enums, CLI, agent loop)
- P6: ✅ Done (`.gnomon/ci.sh`, 109 tests, 7-stage pipeline)

<!--
  Release links. Both 404 until `v0.1.0` is tagged and pushed — see the note at
  the top of this file. They are written now so that cutting the release is one
  `git tag`, not a documentation edit as well.
-->

[Unreleased]: https://github.com/eljaplacido/gnomonharness/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/eljaplacido/gnomonharness/releases/tag/v0.1.1
[0.1.0]: https://github.com/eljaplacido/gnomonharness/releases/tag/v0.1.0

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

### Fixed

- **No strict OpenAI-compatible provider worked at all.** The request carried
  sampling params in *both* shapes — top-level for OpenAI and a nested `options`
  object for Ollama — under the comment *"send both so either backend is
  happy"*. Ollama ignores unknown fields; strict providers reject them, and
  OpenCode answers `400 Extra inputs are not permitted, field: 'options'` —
  naming a field the user never wrote, in a request they cannot see. It fired
  for any role declaring `temperature`/`top_p`, which the scaffold writes for
  **every** role. The payload now follows the endpoint's `kind`, which was
  already resolved and unused.
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

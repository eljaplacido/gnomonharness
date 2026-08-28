# Roadmap — gnomon

Phased delivery. Each phase: specify → contract → **red fixtures** → implement → verify.

## P0 — Spike (day 1–2)

**Goal:** Validate the extend-vs-embed decision and serving stack.

- [x] Create repo, push to remote
- [x] Verify `pi-agent-core` + `pi-ai` hook surfaces — recorded in
      [spikes/P0-extend-vs-embed.md](spikes/P0-extend-vs-embed.md) with its
      falsification condition. Result: hooks *can* reach tool definitions, so
      **extend** rather than embed.
- [x] Choose local serving stack — Ollama at `:11434`, plus any
      OpenAI-compatible endpoint. Both are in `config.toml` as `[endpoints]`.
- [ ] Build pi packages on aarch64/DGX OS
- [ ] Record the surface hash of whatever agent built gnomon, at the first
      commit

**Done when:** Hook surface confirmed OR embed decision recorded. Serving
stack chosen and builds.

**Wrong if:** Hooks cannot reach tool definitions and we didn't record the
falsification condition. Or we picked a serving stack that doesn't build.

## P1 — Contracts + red fixtures (day 3–5)

**Goal:** Four contracts written and versioned; `conformance/` fixtures committed and **failing**.

- [x] Exit codes contract + `conformance/exit_codes.json` fixture
- [x] Manifest contract + `conformance/manifest_golden.json` fixture
- [x] Enumerations contract + `conformance/enumerations_schema.json` fixture
- [x] Session record contract + `conformance/session_golden.json` fixture

All four are checked by `.gnomon/ci.sh` on every run.

**Done when:** Fixtures written and failing because nothing implements them yet.

**Wrong if:** Fixtures written after the code, or green on arrival.

## P2 — Daily driver (week 1–2)

**Goal:** TUI, sessions, `.gnomon/` resolution with **no** home-directory path,
role routing, `hashline` edit format. You stop reaching for other agents.

- [x] TS core: agent loop, extension host, session model
- [x] CLI: `gnomon run`, `gnomon session`, `gnomon enumerations`
- [x] `.gnomon/` resolver: reads from working repo, no `~/.gnomon/` path.
      The one machine-local file is the credential store, which holds values
      the surface must never contain and is deliberately outside it.
- [x] Role routing: `plan`, `implement`, `critique`, `smol`, plus the
      `coordinator` / `implementor` / `verifier` triad
- [x] TUI: basic session view, step listing, outcome buckets
- [ ] Edit format: `hashline` — **not implemented.** `str_replace` is the only
      format this build has; the other two are in the enumerations contract
      and nothing reads them. `config.toml` says so where it is configured.
- [x] Manifest emitted every turn, re-asserted on changes

**Done when:** A machine-scoped path survives nowhere in resolution.

**Wrong if:** Any code path reads from `~/.gnomon/` or `$XDG_CONFIG_HOME`.

## P3 — `gnomon-surface` (week 3)

**Goal:** Static aarch64 binary. P1's manifest fixtures green byte-for-byte.

- [x] Rust crate: resolve `.gnomon/` tree, compute hash
- [x] `gnomon-surface manifest` → JSON with `build`, `surface_hash`, `sources`
- [x] Sources sorted by path; present + absent tracked (null for absent)
- [x] Deterministic: same tree → identical hash across runs
- [x] Golden fixture: `conformance/manifest_golden.json` matches byte-for-byte
- [x] `conformance/fixture_tree/` — reproducible test tree
- [ ] Build static aarch64 binary with `musl` target or aarch64 Docker
- [x] CI: `gnomon-enums` prints enumerations contract
- [x] Assert manifest every turn in the agent loop — `reassertManifest()` in agent.ts records apparatus_failure on drift

**Done when:** Two runs over the same tree produce identical manifests.

**Wrong if:** Any non-determinism in hash computation (unsorted maps, timestamps).

## P4 — Outcomes (week 4)

**Goal:** Three buckets recorded per step. Exit fixtures round-trip green.

- [x] Step outcome model: `native_code` → `bucket` mapping
- [x] Exit code handling: 0–4 → result/refusal, 10–13 → apparatus_failure
- [x] Session record: manifest + ordered steps with bucket per step
- [x] No composite verdict: carry set of outcomes, let reader decide
- [x] Every attempt recorded, not collapsed into one clean step
- [x] CI: exit codes fixture round-trip validated via `.gnomon/ci.sh`

**Done when:** A refusal is never recorded as a failure anywhere.

**Wrong if:** `failed` (1) and `refused_by_model` (2) both map to `result`.

## P5 — Edit engine (week 5)

**Goal:** Content-unsafe patch engine with collision detection.

- [x] `gnomon-edit` crate: exact/regex patch modes
- [x] Collision detection via SHA256 expected_hash
- [x] Atomic batch: validate all before writing any
- [x] Dry-run preview via `simulate_patch`
- [x] CI: patch fixtures round-trip via `test_edit_patchset_roundtrip`

**Done when:** A drifted patch is rejected before writing.

**Wrong if:** A patch succeeds when the target content has changed since spec.

## P5 — One-shot mode + CLI (week 5)

**Goal:** `gnomon` CLI for scripting and CI.

- [x] `gnomon-enums` → print enumerations JSON
- [x] `gnomon-surface hash` → print surface hash
- [x] `gnomon-surface manifest` → print manifest JSON
- [x] `gnomon session <cmd>` → run commands as a session
- [x] `gnomon apply <patchset>` → apply patches
- [x] `gnomon simulate <patchset>` → dry-run patches
- [x] `gnomon prompt` → interactive mode (no longer a stub: agentic loop,
      slash commands, sessions, resume)
- [x] Argument parsing with --dir flag
- [x] `gnomon -p session-id` → print current session ID

## P6 — CI/CD (week 6)

**Goal:** `.gnomon/ci.sh` validates all contracts end-to-end.

- [x] Run all tests across all crates (46 Rust + ~616 TS; ci.sh reports the live counts)
- [x] Manifest golden fixture match
- [x] Enumerations schema validation
- [x] Session golden fixture validation
- [x] Exit codes fixture validation
- [x] Determinism check (same tree → same hash)
- [x] GitHub Actions integration (push to trigger)
  - [x] `ci.yml` — 7 jobs: Rust tests, TS tests, full CI script, Ubuntu build,
        macOS build, interactive smoke test, clippy
  - [x] Push-triggered on master/develop, PR-triggered on master
  - [x] Build badges in README
- [ ] aarch64 build step (Docker or cross-compile)
- [ ] Code coverage threshold (80%+)

---

## Two things on day one

1. **Push the repo before the first real commit.** Retrofitting that is worse
   than it sounds.
2. **Record the surface of whatever agent you use to build this.** Take a dated
   hash of that agent's instruction files at the first commit.

## P7 — Hardening (done)

**Goal:** Close what an end-to-end audit against live models found. The suite
was green throughout; none of it lived on a path the tests exercised.

- [x] Surface not writable by a tool call; `bash` drift detected and reported
- [x] Sandbox follows symlinks — `resolve()` is string algebra and a symlink
      escaped it in both directions
- [x] Refused turns replay into context; only apparatus failures do not
- [x] `approval = "always"` distinguishable from `on_write`
- [x] `bash_deny` — the guardrail an allow-list cannot express
- [x] `grep`, `glob`, `compute`, `todo`, `task`, `webfetch`
- [x] Backend token accounting on the meta line, in `--json` and in the trail
- [x] Skills ship with the repository
- [x] [POSITIONING.md](POSITIONING.md)

## P8 — Next

Ordered by what a day of real use runs into first.

- [ ] **Evaluation suite.** A fixed task set across several models recording
      tokens, wall-clock, tool calls and pass rate, with the same tasks run on
      OpenCode and Aider for a baseline. Until this exists, no claim about task
      success rates is honest — see [POSITIONING.md](POSITIONING.md).
- [ ] **MCP.** The largest single gap against every harness in this class.
      `tools.toml` documents the block and nothing connects it.
- [ ] **Compiled entry point.** ~197ms of every invocation is `tsx`
      transpiling the sources; gnomon's own logic is ~33ms. Needs conditional
      `exports` across every workspace package, which also changes what vitest
      resolves — a deliberate build change, not a launcher tweak.
- [ ] **Repo map.** Context is a sliding window over turns, not a ranked view
      of the repository.
- [ ] aarch64 static binary (`musl` or Docker cross-compile)
- [ ] Code coverage threshold (80%+)

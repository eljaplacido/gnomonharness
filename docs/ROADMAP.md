# Roadmap — gnomon

Phased delivery. Each phase: specify → contract → **red fixtures** → implement → verify.

## P0 — Spike (day 1–2)

**Goal:** Validate the extend-vs-embed decision and serving stack.

- [ ] Create repo, push to remote (not tidiness — a project whose revisions
      exist only on one machine cannot be depended on)
- [ ] Verify `pi-agent-core` + `pi-ai` hook surfaces:
  - [ ] Can hooks intercept tool *definitions*, not just tool results?
  - [ ] If not: hooks cannot reach tool definitions → must Embed, not Extend
  - [ ] Record the finding with its falsification condition
- [ ] Build pi packages on aarch64/DGX OS
- [ ] Choose local serving stack by what actually builds:
  - [ ] vLLM → behind OpenAI-compatible endpoint?
  - [ ] llama.cpp → ggml/gguf serving?
  - [ ] Ollama → :11434?
  - [ ] Record the reading as a dated finding, not a preference
- [ ] Record the surface hash of whatever agent you use to build gnomon
      at the first commit. Keep it in the repo.

**Done when:** Hook surface confirmed OR embed decision recorded. Serving
stack chosen and builds.

**Wrong if:** Hooks cannot reach tool definitions and we didn't record the
falsification condition. Or we picked a serving stack that doesn't build.

## P1 — Contracts + red fixtures (day 3–5)

**Goal:** Four contracts written and versioned; `conformance/` fixtures committed and **failing**.

- [ ] Exit codes contract + `conformance/exit_codes.json` fixture (red)
- [ ] Manifest contract + `conformance/manifest_golden.json` fixture (red)
- [ ] Enumerations contract + `conformance/enumerations_schema.json` fixture (red)
- [ ] Session record contract + `conformance/session_golden.json` fixture (red)

**Done when:** Fixtures written and failing because nothing implements them yet.

**Wrong if:** Fixtures written after the code, or green on arrival.

## P2 — Daily driver (week 1–2)

**Goal:** TUI, sessions, `.gnomon/` resolution with **no** home-directory path,
role routing, `hashline` edit format. You stop reaching for other agents.

- [ ] TS core: agent loop, extension host, session model
- [ ] CLI: `gnomon run`, `gnomon session`, `gnomon enumerations`
- [ ] `.gnomon/` resolver: reads from working repo, no `~/.gnomon/` path
- [ ] Role routing: `plan` → frontier, `implement` → large local, `critique`
      → separate context, `smol` → small local
- [ ] TUI: basic session view, step listing, outcome buckets
- [ ] Edit format: `hashline` (AST format from P0 finding)
- [ ] Manifest emitted every turn, re-asserted on changes

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
- [ ] Assert manifest every turn in the agent loop

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

## P5 — One-shot mode (week 5)

**Goal:** `gnomon -p` for scripting and CI.

- [x] `gnomon-enums` → print enumerations JSON
- [x] `gnomon-surface hash` → print surface hash
- [x] `gnomon-surface manifest` → print manifest JSON
- [ ] `gnomon -p session-id` → print current session ID
- [ ] Non-interactive exit: no TUI, just print and exit

## P6 — CI/CD (week 6)

**Goal:** `.gnomon/ci.sh` validates all contracts end-to-end.

- [x] Run all tests across all crates
- [x] Manifest golden fixture match
- [x] Enumerations schema validation
- [x] Session golden fixture validation
- [x] Exit codes fixture validation
- [x] Determinism check (same tree → same hash)
- [ ] GitHub Actions integration (push to trigger)
- [ ] aarch64 build step (Docker or cross-compile)
- [ ] Code coverage threshold (80%+)

---

## Two things on day one

1. **Push the repo before the first real commit.** Retrofitting that is worse
   than it sounds.
2. **Record the surface of whatever agent you use to build this.** Take a dated
   hash of that agent's instruction files at the first commit.

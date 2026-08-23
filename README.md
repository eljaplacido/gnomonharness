# gnomon

> A coding agent harness you use every day. Every byte of configuration that
> affects what the agent does lives inside the repository the agent is working
> on, and is content-hashed on every turn.

[![CI](https://github.com/eljaplacido/gnomonharness/actions/workflows/ci.yml/badge.svg)](https://github.com/eljaplacido/gnomonharness/actions/workflows/ci.yml)

> If two people check out the same commit, they get the same agent.

No `~/.gnomon/`. No global settings. No tool list assembled from whatever
happens to be installed. If two people check out the same commit, they get
the same agent.

## Architecture

```
gnomon/
  crates/
    gnomon-surface/     Rust. Resolve + hash config, emit manifests.
    gnomon-edit/        Rust. tree-sitter + ast-grep structural edits.
    gnomon-exec/        Rust. Spawn, timeout, sandbox, outcome capture.
  packages/
    gnomon-core/        TS. Library: agent loop, extension host, session model.
    gnomon-cli/         TS. Thin shell over core.
    gnomon-natives/     N-API bindings to the crates.
  .gnomon/              This repo's own config.
  conformance/          Golden fixtures. Contracts → see docs/CONTRACTS.md.
```

## The six rules

1. **No machine-scoped configuration.** Everything in `.gnomon/`.
2. **Every session emits a manifest**, content-addressed over the surface.
3. **Tool schemas are declared data**, resolved from files, sorted, hashed.
4. **Three outcome buckets:** `result` / `refusal` / `apparatus_failure`.
5. **Published, versioned exit contract.** See `docs/CONTRACTS.md`.
6. **Published enumerations.** `gnomon enumerations --json`.

## Current status

| Layer | Crate | Binary | Tests | Status |
|-------|-------|--------|-------|--------|
| **Rust** | `gnomon-surface` | `gnomon-surface`, `gnomon-enums` | 7 | ✅ |
| **Rust** | `gnomon-edit` | `gnomon-edit` | 12 | ✅ |
| **Rust** | `gnomon-exec` | `gnomon-exec` | 23 | ✅ |
| **TypeScript** | `gnomon-natives` | — | 7 | ✅ Bindings |
| **TypeScript** | `gnomon-core` | — | 59 | ✅ Agent loop + prompt |
| **TypeScript** | `gnomon-cli` | `gnomon` | 9 | ✅ CLI shell |
| **TypeScript** | `gnomon-tui` | — | 4 | ✅ Session viewer |

**109 tests pass** — 46 Rust, 63 TypeScript. CI validates all contracts end-to-end.

## Phased delivery

See [docs/ROADMAP.md](docs/ROADMAP.md) for phased delivery plan.

| Phase | Status |
|-------|--------|
| **P0 — Spike** | 🟡 Partial (hook surface not yet validated) |
| **P1 — Contracts** | ✅ Done (fixtures written, red on arrival) |
| **P2 — Daily driver** | ✅ Done (prompt loop, role routing, TUI session viewer) |
| **P3 — Surface** | ✅ Done (manifest, hash, golden fixture) |
| **P4 — Outcomes** | ✅ Done (buckets, exit codes, session validation) |
| **P5 — Edit + CLI** | ✅ Done (patches, enums, CLI, agent loop) |
| **P6 — CI/CD** | ✅ Done (`.gnomon/ci.sh`, 109 tests, 7-stage pipeline) |

## Quick start

### Run gnomon (from project root)

```bash
# One-shot session
cargo build          # build Rust binaries first
npx tsx packages/gnomon-cli/src/index.ts session 'echo hello'

# Interactive prompt loop
npx tsx packages/gnomon-cli/src/index.ts prompt

# Session browser TUI
npx tsx packages/gnomon-cli/src/index.ts tui

# Inspect surface
npx tsx packages/gnomon-cli/src/index.ts surface

# Or use the pnpm convenience script
cargo build && pnpm gnomon session 'echo hello'
```

### Use in another repo

Drop a `.gnomon/` directory into any repo. Same commit = same agent.

```bash
cd /path/to/your/repo
npx tsx path/to/gnomon/packages/gnomon-cli/src/index.ts prompt
```

### Run the CI pipeline

```bash
# Run the CI pipeline (tests + all fixture validations)
bash .gnomon/ci.sh

# Run just the tests
cargo test
pnpm test

# Check surface hash
cargo run -p gnomon-surface --bin gnomon-surface -- --dir .gnomon

# Print enumerations
cargo run -p gnomon-surface --bin gnomon-enums

# Run patches
cargo run -p gnomon-edit -- apply patches.json
```

## Read next

- [docs/CONTRACTS.md](docs/CONTRACTS.md) — versioned contracts + fixtures
- [docs/DESIGN.md](docs/DESIGN.md) — design brief (copied from gnomon-brief.md)

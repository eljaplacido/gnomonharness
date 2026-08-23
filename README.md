# gnomon

> A coding agent harness you use every day. Every byte of configuration that
> affects what the agent does lives inside the repository the agent is working
> on, and is content-hashed on every turn.

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

| Crate | Binary | Tests | Status |
|-------|--------|-------|--------|
| `gnomon-surface` | `gnomon-surface`, `gnomon-enums` | 7 | ✅ Rust impl |
| `gnommon-edit` | `gnomon-edit` | 12 | ✅ Rust impl |
| `gnomon-exec` | `gnomon-exec` | 23 | ✅ Rust impl |
| `gnomon-core` | — | 0 | 📋 Scaffolded (TS) |
| `gnomon-cli` | — | 0 | 📋 Scaffolded (TS) |
| `gnomon-natives` | — | 0 | 📋 Scaffolded (TS) |

**46 tests pass** across 3 Rust crates. CI validates all contracts.

## Phased delivery

See [docs/ROADMAP.md](docs/ROADMAP.md) for phased delivery plan.

| Phase | Status |
|-------|--------|
| **P0 — Spike** | 🟡 Partial (hook surface not yet validated) |
| **P1 — Contracts** | ✅ Done (fixtures written, red on arrival) |
| **P2 — Daily driver** | 🔴 Not started (agent loop, TUI, role routing) |
| **P3 — Surface** | ✅ Done (manifest, hash, golden fixture) |
| **P4 — Outcomes** | ✅ Done (buckets, exit codes, session validation) |
| **P5 — Edit + CLI** | ✅ Done (patches, enums, one-shot mode) |
| **P6 — CI/CD** | ✅ Done (`.gnomon/ci.sh`, 6-stage pipeline) |

## Quick start

```bash
# Run the CI pipeline (tests + all fixture validations)
bash .gnomon/ci.sh

# Run just the tests
cargo test

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

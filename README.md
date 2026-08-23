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

## Phased delivery

See [docs/ROADMAP.md](docs/ROADMAP.md) for phased delivery plan.

| Phase | Status | Lands |
|-------|--------|-------|
| **P0** | ❌ | Spike: pi packages build on aarch64; local serving stack; hooks confirmed |
| **P1** | ❌ | Contracts + red fixtures |
| **P2** | ❌ | Daily driver: TUI, sessions, `.gnomon/` resolution, role routing |
| **P3** | ❌ | `gnomon-surface`: static aarch64 binary, manifest byte-identical |
| **P4** | ❌ | Outcomes: three buckets, exit fixtures |
| **P5** | ❌ | One-shot mode (`gnomon -p`) |

## Quick start

```bash
# After P0 spike, once pi packages are validated:
pnpm install
pnpm build
gnomon --help
```

## Read next

- [docs/CONTRACTS.md](docs/CONTRACTS.md) — versioned contracts + fixtures
- [docs/DESIGN.md](docs/DESIGN.md) — design brief (copied from gnomon-brief.md)

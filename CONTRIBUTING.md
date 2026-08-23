# CONTRIBUTING — gnomon

## Dev workflow

- Python 3.12, ruff + black + mypy strict.
- TS 5.x, pnpm, biome for lint/format.
- One PR = one slice of the roadmap. Keep diffs reviewable.
- Every new contract change lands with (a) a fixture, (b) a test. No orphan contracts.

## Building

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run Rust crates
cd crates/gnomon-surface && cargo build --release
cd ../gnomon-edit && cargo build --release
cd ../gnomon-exec && cargo build --release
```

## Running conformance tests

```bash
# Run all contract fixtures
pnpm test

# Run a specific fixture
cd packages/gnomon-cli && pnpm test -- exit_codes
```

## Adding a new contract

1. Update `docs/CONTRACTS.md` with the new contract definition
2. Add a golden fixture in `conformance/` with **failing** expectations
3. Implement the code
4. Verify the fixture is green
5. Document in `CHANGELOG.md`

## Syncing with agentcenter

gnomon sessions can be exported to the agentcenter outbox format for
cross-project analysis. See the `agentcenter` outbox schema for the
expected JSONL format.

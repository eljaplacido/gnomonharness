# CONTRIBUTING — gnomon

## Dev workflow

- Rust 1.82+, `cargo fmt` + `cargo clippy` + `cargo test`.
- TS 5.x, pnpm, `vitest` for tests.
- One PR = one slice of the roadmap. Keep diffs reviewable.
- Every new contract change lands with (a) a fixture, (b) a test. No orphan contracts.

## Building

```bash
# One-liner: builds the Rust binaries and every TS package
pnpm run setup
```

<details><summary>The granular steps <code>setup</code> runs, if you need them</summary>

```bash
pnpm install                 # dependencies
cargo build --release        # Rust crates
cd packages/gnomon-core && pnpm build
cd ../gnomon-natives && pnpm build
cd ../gnomon-cli && pnpm build
```
</details>

## The gate

One command decides:

```bash
.gnomon/ci.sh
```

It builds the native binaries, runs both suites, checks every conformance
fixture and computes the manifest twice to prove it is deterministic. A change
is not ready until it passes, whatever else looks right.

**Documentation is tested like code.** `packages/gnomon-cli/src/docs.test.ts`
checks the README against the implementation — every CLI command it lists is
dispatched, every slash command it names is reachable by Tab, every default it
quotes is what a scaffolded surface has. Changing a default, a role's tool list
or a command name *will* fail those tests until the README moves too. That is
the test working: much of this repository's history is documented behaviour
that was not the behaviour.

## Branches

Nothing lands on `master` directly — releases are cut from it. Branch as
`feat/<area>-<what>`, `fix/<area>-<what>`, `docs/<what>`, `chore/<what>`, one
reviewable idea per branch. The starter surface's `bash_deny` refuses
force-pushes and pushes straight onto `main`/`master`/`release`; that guardrail
binds the agent, and branch protection on the remote is what binds everyone.

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

## Questions / contact

Maintainer: Elja Placido — <digicisu@gmail.com>. For anything security-related,
follow [.github/SECURITY.md](.github/SECURITY.md) instead of a public issue.

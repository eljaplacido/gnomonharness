# AGENTS.md

Orientation for AI agents **working on this repository**. To *use* gnomon (install
it, configure models, troubleshoot it for someone), read
[docs/GUIDE.md](docs/GUIDE.md) instead; its section 11 is a procedure for agents.

## What this repository is

gnomon, a terminal coding agent whose behaviour is fixed by a content-hashed
`.gnomon/` directory. [README.md → The Six Rules](README.md#the-six-rules) is
the constitution; a change that weakens one of them needs to say so.

| Path | What lives there |
|---|---|
| `packages/gnomon-cli/src/` | The CLI: `index.ts` (dispatch, `--help`, `CLI_COMMANDS`), `init.ts` (scaffold templates), `check.ts`, `update.ts`, `migrate.ts`, `docs.test.ts` |
| `packages/gnomon-core/src/` | The loop: `prompt_loop.ts` (turns, slash commands), `tools.ts`, `config.ts` (surface loading, TOML parser, `auditSurface`), `audit.ts`, `check.ts`, `loops.ts` |
| `packages/gnomon-natives/` | Typed wrappers that spawn the Rust binaries |
| `packages/gnomon-tui/` | Saved-session viewer |
| `crates/` | Rust: `gnomon-surface` (the hash authority), `gnomon-edit`, `gnomon-exec` |
| `conformance/` | Golden fixtures: the published contracts |
| `.gnomon/` | This repository's own surface. `ci.sh` is the gate. |
| `docs/` | `DESIGN`, `CONTRACTS`, `POSITIONING`, `GUIDE`, benchmark reports |
| `benchmarks/` | Benchmark apparatus and results |

## Build, run, test

```bash
pnpm install --frozen-lockfile
pnpm -r run build                # tsc for all four packages (also the typecheck)
cargo build --release            # the native binaries (or: pnpm run build:native)
node packages/gnomon-cli/gnomon.js --help   # run the CLI from the checkout

pnpm test                        # TypeScript suites
cargo test --all                 # Rust suites
pnpm lint                        # cargo clippy -D warnings
bash .gnomon/ci.sh               # THE gate: everything above, fixtures, determinism
```

`vitest` strips types without checking them, so run the build too. Tests
isolate `HOME` and `XDG_DATA_HOME` (`vitest.setup.ts`). Do the same when you
run the CLI by hand, so you never read or write the real credential store.

## Conventions that fail CI if ignored

- **Docs are tested like code.** `packages/gnomon-cli/src/docs.test.ts` checks
  README, GETTING_STARTED and docs/GUIDE.md against the code: commands
  dispatched, slash commands registered, scaffolded defaults, the native-only
  command list, every `file.ts:line` citation in `docs/*.md`, and that
  GUIDE.md's TOML blocks parse. Change behaviour and the docs move in the same PR.
- **README's test count is checked.** `.gnomon/ci.sh` fails when the status
  line's TypeScript/Rust/total counts differ from what the runners produced.
  Adding or removing tests means updating that line.
- **Contracts change with fixtures.** A change to exit codes, enumerations,
  manifest or record shapes lands with a `conformance/` fixture and a test
  (see CONTRIBUTING.md).
- **`init.ts` templates are JavaScript template literals**: a markdown backtick
  closes the literal and `\s` must be written `\\s`.
- **gnomon parses a TOML subset** with its own zero-dependency parser
  ([CONTRACTS.md §5](docs/CONTRACTS.md)). The harness has no third-party
  runtime dependencies; do not add one.
- **Never edit this repository's `.gnomon/`** to make a test pass. It is the
  surface this harness is judged by; changing it is the maintainer's call
  (`.gnomon/skills/changing-the-surface.md`).
- Branches: `feat/…`, `fix/…`, `docs/…`, `chore/…`, one reviewable slice each.
  PRs go to `master`. Never force-push.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the review contract and
[docs/RELEASING.md](docs/RELEASING.md) before touching a version number.

# CONTRIBUTING — gnomon

Contributions are welcome, and the project is **maintainer-gated for now**: every
change lands through a pull request that the maintainer reviews and merges.
`master` is branch-protected — no direct pushes, no force-pushes — so the way in
is always a PR.

## How to propose a change

1. **Open an issue first for anything non-trivial.** A new tool, a surface
   contract, a behaviour change, a dependency — agree the direction before you
   build it. Bug fixes and docs can go straight to a PR. (The harness has strong
   opinions; a five-minute issue saves a rewritten PR.)
2. **Fork, branch, and keep it one slice.** Branch off `master`; one PR is one
   reviewable change, not a grab-bag. Match the surrounding style.
3. **The gate must be green.** `.gnomon/ci.sh` runs the whole suite (Rust +
   TypeScript + the docs-are-tested checks). CI runs it on every PR; run it
   locally first. A documented claim that isn't backed by a test that fails when
   the claim stops being true will not pass review — see the note below.
4. **Open the PR against `master`.** The maintainer (Elja Placido —
   <digicisu@gmail.com>) reviews and merges. Expect review before merge; that is
   the gate, and it is deliberate while the interfaces are still moving.

Security issues do **not** go through public PRs or issues — see
[.github/SECURITY.md](.github/SECURITY.md).

## The review contract

The failure this section exists to fix: everything above told you how to make a
good PR and nothing told you what happens to it afterwards. A contributor could
not tell whether a PR would be looked at in a day or never, and the honest
answer — one person, no rota — was inferable only from the fact that the same
name appears everywhere. Silence on this reads as abandonment even when it is
just a slow week, so here is the shape of it, including the parts that are not
reassuring.

- **One maintainer, and that is the whole review bench.** `.github/CODEOWNERS`
  names one person for every path because there is one person. No PR gets a
  second reviewer, because there is no second reviewer.
- **Merges are maintainer-gated.** `master` is branch-protected; every change
  lands through a PR the maintainer approves and merges. Nobody self-merges,
  including the maintainer — the same PR flow applies to their own work.
- **The gate is not the review.** Green CI is necessary and not sufficient:
  `.gnomon/ci.sh` proves the suite passes, and review is where the design
  argument happens. Red CI, though, is not reviewed at all — fix it first, or
  say in the PR why it is red on purpose.

**Response targets.** These are targets, published so you can tell "slow" from
"abandoned". They are not an SLA and nobody is paid to meet them:

| | Target |
|---|---|
| First response to a new issue or PR | within **7 days** |
| Follow-up once a review thread is live | within **7 days** per round |
| Security report (see [SECURITY.md](.github/SECURITY.md)) | ahead of everything else in this table. Checked: SECURITY.md states a reporting *route* and no timeline, so these targets are the only published ones — assume the same 7 days, and treat a private advisory as the way to escalate faster |

If a PR has been quiet for longer than the target, the right move is to comment
on it and say so. That is not nagging; it is the only escalation path there is,
and it works — a dropped thread here is far more likely to be an oversight than
a decision.

**Where a PR most often stalls**, so you can pre-empt it: a change that alters
documented behaviour without moving the README, a contract change that arrives
without a `conformance/` fixture, or a non-trivial feature that never had a
proposal issue and turns out to point away from where the project is going.

Only the first is mechanically gated. `docs.test.ts` runs in CI and fails a PR
that moves the tool table, the role table, the command registry, the exit
codes, the `stop_reason` enumeration, a scaffolded default, or a `file.ts:line`
citation out of step with the README. The second is **reviewer-enforced**:
`.gnomon/ci.sh` re-validates the four fixtures that already exist
(`manifest_golden.json`, `enumerations`, `session_golden.json`,
`exit_codes.json`), so *changing* one of those contracts without updating its
fixture does fail — but nothing anywhere checks that a **new** contract arrives
with a fixture at all. A reviewer asks for it, or it does not happen. The third
is why step 1 asks for an issue first.

## Dev workflow

- Rust **1.85+** (`rust-toolchain.toml` pins 1.94, the version this workspace is
  verified on), `cargo fmt` + `cargo clippy` + `cargo test`. The floor is not
  1.82 as this file said for a long time: a transitive dependency needs the
  `edition2024` Cargo feature, stabilised in 1.85, so 1.82 fails to resolve
  before it compiles anything. Nobody had exercised the documented floor.
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

## Cutting a release

`scripts/bump-version.sh <version>`, then follow
[docs/RELEASING.md](docs/RELEASING.md). Do not hand-edit the version: it is
written down in six files and the one that reaches published records is not the
one you would think to edit first. `scripts/check-versions.sh` asserts they
agree, and runs in `.gnomon/ci.sh` before you ever push a tag.

## Adding a new contract

1. Update `docs/CONTRACTS.md` with the new contract definition
2. Add a golden fixture in `conformance/` with **failing** expectations
3. Implement the code
4. Verify the fixture is green
5. Document in `CHANGELOG.md`

## Questions / contact

Maintainer: Elja Placido — <digicisu@gmail.com>. For anything security-related,
follow [.github/SECURITY.md](.github/SECURITY.md) instead of a public issue.

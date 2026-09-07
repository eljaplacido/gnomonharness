# CONTRIBUTING — gnomon

Contributions are welcome, and the project is **maintainer-gated for now**:
every contributed change lands through a pull request that the maintainer
reviews and merges. `master` is branch-protected — one approving review, three
required checks, no force-pushes, no branch deletion — so for a contributor the
way in is always a PR. The maintainer is exempt (`enforce_admins` is off) and
does push directly; that is stated here rather than implied away.

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
- **Merges are maintainer-gated.** `master` is branch-protected; every
  contributed change lands through a PR the maintainer approves and merges. A
  contributor cannot self-merge: protection requires an approving review, and
  it is not their own. The maintainer's own work goes direct — measured
  2026-09-07, the previous twelve commits including two releases had no
  associated PR. This bullet claimed the same flow applied to them; it does
  not, and pretending otherwise is the kind of unchecked claim this repository
  exists to catch.
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
pnpm setup          # pnpm's own one-time step; sets PNPM_HOME. Needed once.
pnpm run setup      # gnomon's
```

<details><summary>The steps <code>pnpm run setup</code> actually runs</summary>

```bash
pnpm install                 # dependencies
pnpm run build:native        # cargo build --release, or a clear skip if no cargo
pnpm run build               # tsc across all four TS packages
pnpm run link:global         # puts `gnomon` on PATH, and EXITS 1 if it did not
```

That list used to name five steps, three of which `setup` did not run — it
chained `install`, `build:native` and `link:global` and never invoked `tsc` at
all — while omitting the one step that can fail. Both are fixed: `build` is in
the chain now, and this list is the chain.
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

Contributor changes land on `master` only through a pull request: branch
protection requires one approving review and three green checks. **The
maintainer pushes directly**, and this said "nothing lands on `master`
directly" while the last twelve commits — two of them releases — had no
associated PR, because `enforce_admins` is off. Saying so is better than a rule
only some people follow. Branch as
`feat/<area>-<what>`, `fix/<area>-<what>`, `docs/<what>`, `chore/<what>`, one
reviewable idea per branch. The starter surface's `bash_deny` refuses
force-pushes and pushes straight onto `main`/`master`/`release`; that guardrail
binds the agent, and branch protection on the remote is what binds everyone.

## Running conformance tests

The conformance fixtures under `conformance/` are checked by `.gnomon/ci.sh`,
not by vitest — `pnpm test -- exit_codes` was documented here and exits 1 with
"No test files found", because `exit_codes.json` is data read by that script.

```bash
# Everything: both suites, every fixture, the coverage floor
bash .gnomon/ci.sh

# Just the test suites
pnpm test

# Run one package's suite
pnpm --filter gnomon-cli test

# Run one file
cd packages/gnomon-core && pnpm exec vitest run src/skills.test.ts
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

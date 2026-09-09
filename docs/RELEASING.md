# Releasing

Written after v0.1.1 was tagged twice and failed CI twice, both times for the
same reason: the tag moved and the manifests did not. Nothing in the repository
said how to cut a release, so the procedure existed only inside a workflow that
cannot be run until after the mistake has been pushed.

## The procedure

```bash
scripts/bump-version.sh 0.2.0     # updates all eight version carriers
$EDITOR CHANGELOG.md              # add the section; move [Unreleased] links
bash .gnomon/ci.sh                # includes the version-consistency gate
bash scripts/fresh-machine.sh     # what a user with only Node actually gets
git commit -am "release: v0.2.0"
git tag -a v0.2.0 -m "gnomon v0.2.0"
git push origin master v0.2.0
```

`scripts/fresh-machine.sh` is the one check that runs OUTSIDE a checkout: it
installs the four tarballs the documented way into a container with Node and
nothing else, then runs every offline command. Five of the defects found in the
released v0.2.3 were invisible to every other gate — a README install command
that 404s, and a "native binary not found" message naming three commands when
five needed one. It needs docker and exits 2 without it; CI runs it too, but run
it here as well, because this is the last moment before the artefact is public.

The tag push triggers `.github/workflows/release.yml`, which re-checks the
version, builds binaries for four targets (linux-x64, linux-arm64, darwin-arm64,
windows-x64) and the four npm tarballs the documented install uses, and opens a
**draft** release. A
human presses Publish. That is deliberate: the workflow decides nothing about
whether a build is fit to install.

## Why a script rather than an instruction

The version is written down in eight places:

| File | Why it matters |
|---|---|
| `Cargo.toml` (workspace) | compiled into `gnomon-surface`; appears in every manifest's `build` |
| `package.json` (root) | the workspace manifest |
| `packages/*/package.json` (×4) | **`gnomon-core`'s is the one `harnessBuild()` reads** — it is stamped on every published record |
| `conformance/manifest_golden.json` | `build` field; a stale value fails the conformance check |
| `conformance/session_golden.json` | same, nested under `session.manifest` |

A half-bumped tree is not a cosmetic problem. It publishes records whose
provenance names a version that was never released — which is the failure this
harness exists to make impossible, occurring in the harness itself.

`scripts/check-versions.sh` asserts all eight agree. It runs in `.gnomon/ci.sh`
(so you catch it before tagging) and in the release workflow (so a tag cannot
get past it).

## What is deliberately NOT bumped

Three version fields are independent of the release version. Bumping them along
with it would be a silent contract change:

- `conformance/exit_codes.json` → `version` — the **exit-code contract** version
- `conformance/session_golden.json` → `version` — the **record format** version
- `docs/CONTRACTS.md` → `Version:` — the **contract document** version

Only `build` fields track the release, because `build` *is* `<version>+<revision>`.

## If the release workflow fails

It fails fast and early by design. Read the failing step first:

- **"Check versions agree"** — a manifest was missed. Run
  `scripts/check-versions.sh <version>`, fix, amend, and re-tag with `-f`.
- A build-matrix target only — the others still built (`fail-fast: false`),
  so the failure is that toolchain, not the release.

Re-tagging an already-pushed tag requires `git push -f origin <tag>`, and any
draft release from the previous attempt should be deleted first so there is
exactly one draft per tag.

## Publishing to npm

The four packages are publishable as of 2026-09-07. `.gnomon/ci.sh` proves the
tarball installs and runs on every run, so the only thing left at release time
is the credential.

```bash
npm login                      # once; the release does not store a token
pnpm -r --filter './packages/*' publish --access public --no-git-checks
```

Order does not matter — npm resolves `gnomon-core@0.2.2` once it exists, and
pnpm rewrites `workspace:*` to the real version as it publishes.

| Published name | What it is |
|---|---|
| **`gnomon-harness`** | the CLI. `npm i -g gnomon-harness` gives you `gnomon` |
| `gnomon-core` | agent loop, session model, tools |
| `gnomon-natives` | typed access to the Rust binaries |
| `gnomon-tui` | the session reader |

**The package is `gnomon-harness`, the command is `gnomon`.** The bare name on
npm belongs to an unrelated logging utility and has for years; `gnomon-harness`
was free, matches the repository, and is the project's own word for itself.

Two mechanisms make the published package different from the workspace, and
both live in `publishConfig` so the workspace is untouched:

- Each library package's `exports` points at `./dist/*.js` when published and
  `./src/index.ts` in the workspace. Changing `exports` directly is what the
  launcher comment warned would move what vitest resolves; `publishConfig`
  avoids that entirely.
- `gnomon-harness`'s `bin` is `bin/gnomon.mjs` when published — plain node on
  compiled output — and `gnomon.js` in the workspace, which runs the TypeScript
  through tsx. Shipping tsx would give gnomon its first third-party runtime
  dependency, inside the process that decides what an agent may run.
  `check-publishable.sh` fails if any appears.

## Not published to npm — until 0.2.2

*(kept for the record: this section described the state before the above.)*

There is no `npm publish` step and no `NPM_TOKEN` anywhere in CI. The release is
GitHub binaries and a git tag. Adding a registry publish is a decision about
distribution, not a missing chore.

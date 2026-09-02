# Releasing

Written after v0.1.1 was tagged twice and failed CI twice, both times for the
same reason: the tag moved and the manifests did not. Nothing in the repository
said how to cut a release, so the procedure existed only inside a workflow that
cannot be run until after the mistake has been pushed.

## The procedure

```bash
scripts/bump-version.sh 0.2.0     # updates all six version carriers
$EDITOR CHANGELOG.md              # add the section; move [Unreleased] links
bash .gnomon/ci.sh                # includes the version-consistency gate
git commit -am "release: v0.2.0"
git tag -a v0.2.0 -m "gnomon v0.2.0"
git push origin master v0.2.0
```

The tag push triggers `.github/workflows/release.yml`, which re-checks the
version, builds binaries for four targets, and opens a **draft** release. A
human presses Publish. That is deliberate: the workflow decides nothing about
whether a build is fit to install.

## Why a script rather than an instruction

The version is written down in six places:

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

`scripts/check-versions.sh` asserts all six agree. It runs in `.gnomon/ci.sh`
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
- A build-matrix target only — the other three still built (`fail-fast: false`),
  so the failure is that toolchain, not the release.

Re-tagging an already-pushed tag requires `git push -f origin <tag>`, and any
draft release from the previous attempt should be deleted first so there is
exactly one draft per tag.

## Not published to npm

There is no `npm publish` step and no `NPM_TOKEN` anywhere in CI. The release is
GitHub binaries and a git tag. Adding a registry publish is a decision about
distribution, not a missing chore.

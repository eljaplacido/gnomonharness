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

Pressing Publish is also what puts the release on npm:
`.github/workflows/publish-npm.yml` runs on `release: published` and publishes
that release's own four tarballs. See [Publishing to npm](#publishing-to-npm).

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

Automatic, and gated on the same human act as the release itself. When a
maintainer publishes a drafted release on GitHub,
[`publish-npm.yml`](../.github/workflows/publish-npm.yml) runs
[`scripts/publish-npm.sh`](../scripts/publish-npm.sh), which:

1. **downloads the release's own assets** — the four `.tgz` files and
   `SHA256SUMS` — rather than packing anything again. These are the bytes the
   release job packed, ran `check-publishable.sh` against, and a human looked
   at before pressing Publish;
2. **checks every tarball against `SHA256SUMS`**, and that each one's manifest
   is the package and version it is named for, not private, and pins its
   `gnomon-*` dependencies to that exact version (no `workspace:*` left);
3. **publishes libraries first and `gnomon-harness` last**, with
   `npm publish <tarball> --access public --provenance`. The harness pins its
   libraries, and `scripts/install.sh` switches to the registry as soon as
   `gnomon-harness@<version>` resolves — so it goes last, once everything it
   needs is already there;
4. **skips any version already on the registry.** npm refuses to publish a
   version twice, so a run that failed after two of four is fixed with
   "Re-run jobs": it finishes the other two and touches nothing else. Only a
   definite 404 counts as "not there"; any other failure to ask stops the run.

A prerelease (a `-` in the version, or a release marked pre-release) is
published under the `next` dist-tag, so `npm i -g gnomon-harness` keeps
resolving the latest stable release.

**One-time setup: the maintainer adds `NPM_TOKEN`.** The workflow reads the
repository secret `NPM_TOKEN` and nothing else; nothing in this repository
creates one. On npmjs.com, create a **granular access token** with read and
write access to `gnomon-harness`, `gnomon-core`, `gnomon-natives` and
`gnomon-tui` (an automation token also works), then add it under GitHub →
Settings → Secrets and variables → Actions → New repository secret, named
`NPM_TOKEN`. Without it the job fails at its first step, saying so, before
anything is downloaded. `--provenance` needs no secret: the job's
`id-token: write` permission is what lets npm record which workflow run, commit
and repository published each version.

**Trusted publishing (no token), now possible.** npm's trusted publishing lets
this workflow authenticate with GitHub's OIDC identity instead of a stored
token. It is configured per package on npmjs.com (package → Settings → Trusted
publisher: GitHub Actions, repository `eljaplacido/gnomonharness`, workflow
`publish-npm.yml`), and a package has to exist before it can be configured —
all four do since 0.3.2. Until all four are configured, the `NPM_TOKEN` path
above stays; once they are, the secret can be deleted and the token revoked.

To see what a release would publish, without publishing it:

```bash
pnpm -r run build
mkdir -p /tmp/rel && for p in gnomon-core gnomon-natives gnomon-tui gnomon-cli; do
  (cd packages/$p && pnpm pack --pack-destination /tmp/rel); done
(cd /tmp/rel && sha256sum ./*.tgz | sed 's|  \./|  |' > SHA256SUMS)
bash scripts/publish-npm.sh /tmp/rel 0.3.1 --dry-run
```

**By hand**, if the workflow cannot run — the same order, the same files:

```bash
gh release download v0.3.1 --pattern '*.tgz' --pattern SHA256SUMS --dir /tmp/rel
npm login
bash scripts/publish-npm.sh /tmp/rel 0.3.1
```

0.3.2 was the first version on npm, published by hand on 2026-11-01 with a
granular token, before the workflow existed. 0.3.1 and earlier are GitHub
releases only.

| Published name | What it is |
|---|---|
| **`gnomon-harness`** | the CLI. `npm i -g gnomon-harness` gives you `gnomon` |
| `gnomon-core` | agent loop, session model, tools |
| `gnomon-natives` | typed access to the Rust binaries |
| `gnomon-tui` | the session reader |

The installers (`scripts/install.sh`, `scripts/install.ps1`, and `gnomon
update`, which runs them) ask `npm view gnomon-harness@<version> version` and
install from the registry when it prints that version, from the release
tarballs otherwise — an older pinned release, or the minute between a release
being published and its npm publish finishing. They compare the printed
version rather than trusting the exit status, because npm before 10 exited 0
with no output for a version that did not exist. They always fetch the native
archive from the GitHub release and verify it against `SHA256SUMS`, which is
why npm only ever receives versions that are GitHub releases.

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

## Not published to npm — until 0.3.2

*(kept for the record: this section described the state before the above.)*

There is no `npm publish` step and no `NPM_TOKEN` anywhere in CI. The release is
GitHub binaries and a git tag. Adding a registry publish is a decision about
distribution, not a missing chore.

It was decided for 0.3.1, and first carried out for 0.3.2: published by hand, then automated by
`publish-npm.yml` for every release after it.

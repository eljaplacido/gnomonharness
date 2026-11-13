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
version and calls the reusable `.github/workflows/build-release.yml`. That
builds binaries for four targets (linux-x64, linux-arm64, darwin-arm64,
windows-x64) and the four npm tarballs the documented install uses, attests
each one in the job that built it, and writes `SHA256SUMS` and an SBOM and
attests those too. `release.yml` then runs `scripts/verify-release.sh` on the
result and opens a **draft** release. A
human presses Publish. That is deliberate: the workflow decides nothing about
whether a build is fit to install. See [Provenance, SBOM and
verification](#provenance-sbom-and-verification).

Pressing Publish is also what puts the release on npm:
`.github/workflows/publish-npm.yml` runs on `release: published` and publishes
that release's own four tarballs. See [Publishing to npm](#publishing-to-npm).
Treat npm trusted publishing (or `NPM_TOKEN`) as a gate before pressing
Publish, and after the publish-npm run confirm that
`npm view gnomon-harness version` prints the new version. Until it does, the
release text says the package reaches npm "once the npm workflow completes",
not that it is there.

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
- **"Verify checksums and provenance before drafting"** — an asset's digest
  or attestation did not verify, so no draft was created. The step prints
  which file and gh's reason. Run `scripts/verify-release.sh <version> --dir
  <dir>` on the run's artifacts to reproduce it. Do not work around it by
  drafting by hand: a release whose provenance does not verify is exactly what
  the step exists to stop.

Re-tagging an already-pushed tag requires `git push -f origin <tag>`, and any
draft release from the previous attempt should be deleted first so there is
exactly one draft per tag.

## Provenance, SBOM and verification

Every release from the one after 0.4.0 carries, besides the archives, the
tarballs and `SHA256SUMS`:

| Asset | What it is |
|---|---|
| `gnomon-<v>.spdx.json` | SBOM (SPDX JSON, made by Syft) of everything `Cargo.lock` and `pnpm-lock.yaml` resolve, the Actions the workflows use included. A superset of what ships: the npm packages have no third-party runtime dependency |
| `gnomon-<v>.intoto.jsonl` | every Sigstore attestation bundle the build made, one per line: the four archives, the four tarballs (one bundle), `SHA256SUMS` with the SBOM, and the SBOM attestation |

**What is attested, and by whom.** `build-release.yml` attests each native
archive in the matrix job that compiled it, on that runner, and the four npm
tarballs in the job that packed them. A last job writes `SHA256SUMS` and the
SBOM and attests both, and attests the SBOM against all eight artifacts. Each
attestation is a SLSA build provenance statement (or an SPDX SBOM), signed
with a short-lived Sigstore certificate issued to the workflow run, recorded
in Sigstore's public transparency log, and stored on this repository. The
certificate's identity is the reusable workflow at the tag:

    https://github.com/eljaplacido/gnomonharness/.github/workflows/build-release.yml@refs/tags/v<version>

**SLSA level.** Build L2 from the attestations alone (a hosted build
platform signs the provenance). Build L3 along the path GitHub documents:
the build and its signing run in a reusable workflow, and the verifier pins
that workflow as the signer, so neither another workflow nor this one on a
branch or pull request can produce provenance that verifies. Not claimed
beyond that: third parties argue reusable workflows alone fall short of some
L3 requirements, notably distribution and verification of provenance, and the
`.intoto.jsonl` asset and `scripts/verify-release.sh` are this repository's
answer to those two. Source-track levels are not claimed.

**npm provenance is a different statement.** `npm publish --provenance` in
`publish-npm.yml` records the workflow that *published*, which downloads the
release's tarballs rather than building them. The provenance of the bytes is
the attestation above. `SHA256SUMS` links the two and is itself attested now.

**Verifying.** `scripts/verify-release.sh <version>` downloads a release and
checks every checksum, every artifact's provenance against both GitHub's
attestation store and the shipped bundle file, pinned to the exact certificate
identity above, and the SBOM attestation for each archive and tarball. It
exits 0 when everything verifies, 1 when anything does not, and 3 for a
release that predates attestation (0.4.0 and earlier), which is not a pass.
`release.yml` runs the same script with `--dir` on the build's output before
it creates the draft, so a release that would not verify is never drafted.
One file by hand, with a current `gh`:

```bash
gh attestation verify gnomon-0.5.0-linux-x64.tar.gz --repo eljaplacido/gnomonharness \
  --cert-identity https://github.com/eljaplacido/gnomonharness/.github/workflows/build-release.yml@refs/tags/v0.5.0
```

**Pinned Actions.** Every third-party `uses:` in `.github/workflows/` is a
full commit SHA with the version in a comment, and every job declares its own
`permissions:`. Dependabot's weekly `github-actions` group proposes new SHAs.
When adding a step, pin it the same way: resolve the release tag to its
commit and write `owner/action@<sha> # vX.Y.Z`.

**OpenSSF Scorecard.** `.github/workflows/scorecard.yml` scores the repository
weekly and on every push to master, and uploads the result to the Security
tab. The target is 8 or more. Signed-Releases looks at recent releases, so it
reaches 10 only once each of them carries a `.intoto.jsonl`.

**Not measured yet.** None of this has run: the first tag after the change is
its first run. The release-blocking verification step means a mistake shows
up as a missing draft, not as an unverifiable release.

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
   `npm publish <tarball> --access public --provenance`, authenticated as
   described below. The harness pins its
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

**How it authenticates: trusted publishing, with `NPM_TOKEN` as a fallback
until that is set up.** npm's trusted publishing (GA 2025-07-31) lets this
workflow publish with the job's GitHub OIDC identity instead of a stored
token: npm (CLI 11.5.1 or newer, which is why the job runs Node 24) exchanges
it for a short-lived token that can publish one package, and the registry
grants it only if that package trusts this repository and this workflow file.
Provenance is then recorded automatically. The first step after checkout,
[`scripts/npm-publish-auth.sh`](../scripts/npm-publish-auth.sh), asks the
registry for each of the four packages before anything is downloaded:

| Trusted publishing | `NPM_TOKEN` secret | What the run does |
|---|---|---|
| configured for all four | any | publishes by OIDC; the token is **not** passed to npm, and if the secret still exists the run says to delete it |
| missing for any | set | publishes with the token, and warns which packages still need configuring |
| missing for any | not set | stops, naming the four packages and the exact fields to enter |

Measured: v0.3.3 and v0.4.0 both stopped at the old "Require NPM_TOKEN" step,
because no secret was set, so the registry stayed at 0.3.2 through v0.4.3
(v0.4.4 and v0.4.5 were drafted and never published). **v0.5.0 is meant to be
the first release on npm since 0.3.2**, through trusted publishing (below),
which needs the maintainer's one-time npmjs.com setup before the v0.5.0
release is published. If that setup is not done, the publish run stops, the
installer still reaches v0.5.0 through the release's own tarballs, and a bare
`npm i -g gnomon-harness` keeps installing 0.3.2 until the run is repeated.

**One-time setup on npmjs.com (the maintainer).** All four packages exist
since 0.3.2, which is the precondition. Signed in to npmjs.com as a maintainer
of the packages, for **each** of `gnomon-core`, `gnomon-natives`,
`gnomon-tui` and `gnomon-harness`:

1. Open `https://www.npmjs.com/package/<name>/access` (the package's
   **Settings** tab).
2. Under **Trusted Publisher**, choose **GitHub Actions** and enter exactly:
   - Organization or user: `eljaplacido`
   - Repository: `gnomonharness`
   - Workflow filename: `publish-npm.yml` (the file name only, not the path)
   - Environment name: leave empty (the job uses no GitHub environment; if
     you add one later, it must be entered here too)
3. Save.

Then publish the next release as usual. Its run should log `trusted publishing
for <name>: HTTP 201` (any 2xx) four times and title the publish step
"Verify and publish (oidc)". After one release has gone through that way:

4. Delete the `NPM_TOKEN` secret (GitHub → Settings → Secrets and variables →
   Actions) and revoke the token on npmjs.com (avatar → Access Tokens).
5. On each package's Settings tab, under **Publishing access**, choose
   **Require two-factor authentication and disallow tokens**. Trusted
   publishing keeps working; a leaked token, if one ever existed, does not.

**The `NPM_TOKEN` fallback**, meanwhile: a **granular access token** with read
and write access to the four packages, added as the repository secret
`NPM_TOKEN`. The workflow reads it in that case only, and nothing in this
repository creates one.

**Releases already published but not on npm (0.3.3, 0.4.0).** "Re-run jobs"
on their failed runs uses the workflow file as it was at their tag, which
knows only `NPM_TOKEN`; it cannot use trusted publishing. Either add the token
and re-run, publish by hand (below), or let the next release be the first on
npm since 0.3.2.

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

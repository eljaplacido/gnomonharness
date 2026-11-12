# chore/package-hygiene — release notes for v0.5.0

## Changelog lines

### Added
- Every npm package (`gnomon-harness`, `gnomon-core`, `gnomon-natives`, `gnomon-tui`) now ships a README, so its npmjs.com page is no longer blank. LICENSE still comes from `pnpm pack`, which copies the workspace root's LICENSE into each tarball.
- `docs/PRIVACY.md`: every network destination of the CLI, the dashboard and the installers, including the opt-in ones a `.gnomon/` surface can declare (`[shadow] url`, `[audit.anchor]`) and the model-readiness check that `gnomon launch` and `gnomon doctor` send to role endpoints. For each: when it is contacted and how to turn it off, checked against the source. There is no telemetry. Apart from the endpoints and witnesses the surface declares, the only request gnomon makes without being asked is the once-a-day update check (`GNOMON_NO_UPDATE_CHECK=1`).
- `.gitleaks.toml` and a "Synthetic secrets in this repository" section in `.github/SECURITY.md`. The private-key blocks and tokens under `benchmarks/results/` are injection-test canaries (`INJCANARY-…` and `GBSCANARY-…`). We checked them, and the allowlist names exactly those.
- CI: `ts-tests` now runs on Node 22 and Node 24. The Node 22 job keeps the existing check name.

### Changed
- **Node 22 is now the minimum** (Node 20 reached end of life in April 2026). This applies to `engines` in all four packages and the root, the installed launcher's version check, `install.sh` and `install.ps1`, the desktop app's install card, the release-page template, and `fresh-machine.sh`'s default image (`node:22-slim`). `.nvmrc` already said 22.
- npm tarballs no longer include source maps. They pointed at `src/`, which the tarballs do not contain. Sizes for 0.4.5, packed / unpacked:
  `gnomon-core` 1.22 MB / 4.73 MB → 0.90 MB / 2.93 MB; `gnomon-harness` 315 KB / 1.22 MB → 236 KB / 776 KB; `gnomon-natives` 11.7 KB → 8.0 KB; `gnomon-tui` 14.0 KB → 8.6 KB.
- `scripts/check-publishable.sh` now checks all four tarballs. Each must contain README.md, LICENSE and package.json, and none may contain source maps, tests, fixtures, TypeScript sources or files that look like credentials.

### Fixed
- `docs/research/gnomon-harness-benchmark-review-and-research-roadmap.md` contained presigned S3 URLs carrying a third-party upload service's STS key id, signature and session token (they expired 2026-08-31). The query strings are removed.

## README notes (for whoever owns README.md / GETTING_STARTED.md / docs/GUIDE.md)

The Node floor is now 22. Exact lines on f466dfcca:

- `README.md:12` `needs Node >= 20` → `needs Node >= 22`
- `README.md:411` `Node >= 20 and nothing else.` → `Node >= 22 and nothing else.`
- `README.md:438` `or older than 20, prints the command` → `or older than 22, prints the command`
- `GETTING_STARTED.md:155` `# Node >= 20` → `# Node >= 22`
- `docs/GUIDE.md:100` `TypeScript, Node 20+` → `TypeScript, Node 22+`
- `docs/GUIDE.md:260` `Node 20 or newer, with npm` → `Node 22 or newer, with npm`
- `docs/GUIDE.md:279` `It checks for Node 20+ and npm` → `It checks for Node 22+ and npm`
- `docs/GUIDE.md:1880` `` `gnomon needs Node.js 20 or newer` `` → `` `gnomon needs Node.js 22 or newer` `` (the installer now prints this)

Privacy, suggested for README → Install → "Updating", after the `GNOMON_NO_UPDATE_CHECK=1` sentence:

> Every network destination gnomon contacts, and how to turn each off, is in [docs/PRIVACY.md](docs/PRIVACY.md). There is no telemetry.

GUIDE FAQ, optional: "Does gnomon phone home?" → "No telemetry. One once-a-day version check in interactive sessions of an npm install; `GNOMON_NO_UPDATE_CHECK=1` turns it off. See docs/PRIVACY.md."

## Licences

**npm runtime:** none. All four published packages have zero third-party runtime dependencies (`pnpm licenses list --prod` finds none, and check-publishable.sh enforces this on the published manifest).

**npm dev/build** (56 packages, this platform; `pnpm licenses list --json`): MIT 47, Apache-2.0 4 (typescript, detect-libc, expect-type), MPL-2.0 3 (lightningcss and its platform binaries, pulled in by vite), ISC 1, BSD-3-Clause 1. MPL-2.0 is weak, file-level copyleft. It is a build tool and nothing from it ships. No GPL or AGPL.

**Rust, shipped in the release binaries** (`cargo tree -e normal`): aho-corasick, memchr, regex*, walkdir, same-file (Unlicense OR MIT); serde*, sha2, digest, libc, syn, quote, proc-macro2, thiserror, typenum, itoa, zmij, … (MIT and/or Apache-2.0); unicode-ident ((MIT OR Apache-2.0) AND Unicode-3.0). No copyleft. Across the whole workspace lockfile (including dev and other platforms), r-efi is `MIT OR Apache-2.0 OR LGPL-2.1-or-later`, so we use it under MIT. linux-raw-sys and rustix are Apache-2.0-with-LLVM-exception OR MIT.

**Desktop app** (`packages/gnomon-desktop`, its own Cargo workspace, 462 crates): mostly MIT and Apache-2.0, plus Unicode-3.0 (ICU) and Zlib. **MPL-2.0: cssparser, cssparser-macros, selectors, dtoa-short, option-ext** (Tauri/wry dependencies, unmodified from crates.io). Shipping binaries is allowed if the MPL notice is included and the source of those files stays available (it is, on crates.io). On Linux, GTK and WebKitGTK (LGPL) are linked dynamically from the system and not bundled. Nothing GPL. Not part of the npm packages.

**Fonts:** the only bundled font is `packages/gnomon-cli/dashboard/fonts/cinzel-wordmark.woff2` (a subset of Cinzel, SIL OFL 1.1, no Reserved Font Name). `dashboard/fonts/OFL.txt` ships in the `gnomon-harness` tarball, and check-publishable.sh already requires it.

The release SBOM (`gnomon-<v>.spdx.json`, build-release.yml) remains the authoritative per-release list.

## Secret scan (origin/master f466dfcca, 980 files)

Neither gitleaks nor trufflehog is installed on gx10, so we ran a pattern scan for: PEM/OpenSSH private-key blocks, AWS `AKIA`/`ASIA` ids, GitHub `gh?_` and `github_pat_`, `sk-`/`sk-ant-`, Slack `xox?-`, Google `AIza`, npm `npm_`, Hugging Face `hf_`, GitLab `glpat-`, Stripe `sk_live_`, JWTs, and `key|secret|password|token = "<24+ chars>"`. Results:
- 23 OpenSSH key blocks: 21 in `inj-2026-11-guardfix/runs/loop/results.jsonl` and 1 each in `trial.py` and `gov.py`. All are synthetic, with body `INJCANARY-ssh-<12 hex>` plus the base64 `openssh-key-v1` header and nothing else. They are allowlisted and documented.
- `AKIAABCDEFGHIJKLMNOP` in `shadow.test.ts` is a redaction-test fixture. It is allowlisted.
- `ASIA2F3EMEYE…` in a research doc: expired presigned URLs from a third-party service. Redacted (see Fixed).
- No other hits. Not secrets, but worth knowing: `/home/eljaplacido/…` paths appear in about 10 benchmark result files, and a Tailscale address appears in `long_tasks.test.ts` as a URL fixture.
- To get the same result with a real scanner: `gitleaks dir . --config .gitleaks.toml` (gitleaks ≥ 8.19), or `gitleaks detect --source . --config .gitleaks.toml --no-git`. Git history was not scanned. The presigned URLs remain in history, but they are expired.

## Owner commands (not run; each one needs your sign-in or changes GitHub settings)

### 1. npm trusted publishing (npmjs.com, once per package)

Signed in to npmjs.com as a maintainer, do this for each of **gnomon-core, gnomon-natives, gnomon-tui, gnomon-harness**:

1. Open `https://www.npmjs.com/package/<name>/access` (the **Settings** tab).
2. Under **Trusted Publisher**, select **GitHub Actions** and enter:
   - Organization or user: `eljaplacido`
   - Repository: `gnomonharness`
   - Workflow filename: `publish-npm.yml`
   - Environment name: *(leave empty)*
3. Save.

Then publish the v0.5.0 GitHub release. The "Publish to npm" run should show the step "Verify and publish (oidc)" and `trusted publishing for <name>: HTTP 2xx` four times. After that run is green:

```bash
gh secret delete NPM_TOKEN --repo eljaplacido/gnomonharness   # only if it exists
```

Revoke any old npm token (npmjs.com → avatar → Access Tokens). Then, on each package's Settings page, set **Publishing access → Require two-factor authentication and disallow tokens**. Check the result with `npm view gnomon-harness version` (should print 0.5.0).

### 2. Retire the old `gnomon-cli` name (only if you own it)

```bash
npm owner ls gnomon-cli            # proceed only if your npm user is listed
npm deprecate gnomon-cli@"*" "renamed to gnomon-harness"
```

If `npm owner ls` lists someone else, the name belongs to an unrelated package. Leave it alone.

### 3. Make "Fresh machine" and the build jobs required status checks

This adds to the existing required set and removes nothing. Look at the current state first:

```bash
gh api repos/eljaplacido/gnomonharness/branches/master/protection/required_status_checks \
  --jq '{strict, contexts}'
```

Then add the checks:

```bash
gh api -X POST repos/eljaplacido/gnomonharness/branches/master/protection/required_status_checks/contexts \
  -f 'contexts[]=Fresh machine (Node only, no Rust, no clone)' \
  -f 'contexts[]=Build gnomon-surface (ubuntu-latest)' \
  -f 'contexts[]=Build gnomon-surface (macos-latest / aarch64)'
# optional, once the new Node 24 leg has been green on master for a while:
#  -f 'contexts[]=TypeScript tests (core / natives / cli / tui) on Node 24'
```

If master is protected by a **ruleset** instead (`gh api repos/eljaplacido/gnomonharness/rulesets` returns one targeting master), add the same names under that ruleset's "Require status checks to pass" in Settings → Rules. After that, update two pieces of text: the `fresh-machine` comment in `.github/workflows/ci.yml` ("Not yet in branch protection's required set") and the check count and list in `CONTRIBUTING.md:141` ("seven green checks" → ten, plus the three new names).

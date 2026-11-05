# How the build under test was installed

Every GBS run in this directory measured **gnomon v0.4.1 as a user installs
it**: the release's own installer, the release's own tarballs, every file
checked against the release's `SHA256SUMS`. v0.4.1 is not on the npm
registry (npm `latest` is 0.3.2), so the installer took the release-tarball
path, which is the path every v0.4.1 user takes.

| Item | Value |
|---|---|
| Release | [v0.4.1](https://github.com/eljaplacido/gnomonharness/releases/tag/v0.4.1), tag commit `c511b8105fb2187423d21becbe3b19f8af2b80e5` |
| Installer | `scripts/install.sh` as of the tag (`git show v0.4.1:scripts/install.sh`), SHA-256 `a1f35bd8dfdf9878e8495ded1ecc3a2b19e6f9ebc565253b195da7a6af53f1c3` |
| `gnomon --version` | `gnomon/0.4.1+v0.4.1-c511b81` (every runner refuses any other string) |
| `gnomon-harness-0.4.1.tgz` | `dc6407a96e0dd855129c93748e5748002a0c90b1742d345257af4a7074671a83` |
| `gnomon-core-0.4.1.tgz` | `1367d000055e242207011795692eb393db691e4a8d71666840a2c9d2b26cc1a4` |
| `gnomon-natives-0.4.1.tgz` | `715558548008e059c65a70af86bf372b96390b198cf57b3a95005f9300cd04f8` |
| `gnomon-tui-0.4.1.tgz` | `157a3d0be30311fead6b8e1781d9236ad485ef9440517fe185d1dc586e744c86` |
| `gnomon-0.4.1-linux-arm64.tar.gz` (native binaries) | `60f743be59b0ac71d67ae7a22941519bfd1ee83f44058cbcb66f98f03405a230` |
| Node / npm | v22.22.2 / 10.9.7 |

```bash
export GBS_SCRATCH=/some/empty/dir
git show v0.4.1:scripts/install.sh > "$GBS_SCRATCH/install.sh"
HOME="$GBS_SCRATCH/home" XDG_DATA_HOME="$GBS_SCRATCH/home/.local/share" \
GNOMON_NPM_PREFIX="$GBS_SCRATCH/prefix" GNOMON_VERSION=0.4.1 \
  sh "$GBS_SCRATCH/install.sh"
. benchmarks/results/gbs-2026-11-04/common/env.sh && gbs_check_build
```

`HOME` and `XDG_DATA_HOME` point into the scratch directory so the install
touches nothing of the machine's own gnomon. Each runner then uses its own
`HOME` under the scratch directory, and finds the native binaries through
`GNOMON_BIN_OVERRIDE` (set by `env.sh`).

**What the digests pin.** The four npm tarballs have no third-party
dependencies (`npm ls --all` on the install lists only gnomon-core,
gnomon-harness, gnomon-natives and gnomon-tui, all 0.4.1), so the five digests
above pin every byte of gnomon that ran. What they do not pin is the runtime:
Node v22.22.2 and the OS's `git` (2.43.0) and `/bin/sh`, recorded in
[hardware.json](hardware.json).

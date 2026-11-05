# How the builds under test were installed, and where they ran

Both harnesses ran **only inside Docker containers** built from one image. Nothing of opencode
was installed on the host. Every measured container ran with `--network none`: no route off the
machine, not even to the host. The fake models, the chaos endpoint, the egress canary and a
benign "dev server" all listen on the container's own loopback.

## The image

[`Dockerfile`](Dockerfile), built on gx10 on 2026-11-05 (with network, at build time only):

| Item | Value |
|---|---|
| Base | `node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5` (the G2b base). Node v22.23.2, Python 3.11.2, git 2.39.5, Debian 12 |
| Image `gbs05-base:2026-11-05` | `sha256:20a68218b0c32c9995d6d82e59d7afba602b0155bad335650b3f2c2cf4fc7925` |
| Run image | `gbs05-base` + `COPY` of this directory at the pre-registration commit ([`run.sh`](run.sh) builds it; its ID is in each block's log) |
| **opencode** | **V2 v2.2.5**, the GitHub release asset `opencode-linux-arm64.tar.gz` from `anomalyco/opencode`. The build refuses any digest but `5a528f42caf576c6cdece6a191eb273d3db54effa5518e0402684d8f8026aeb6`, the one G2b and P2G recorded for the same file on 2026-10-31. The binary itself: `dcc7e6f4ac1672e1884dcb8d26ab333e55ffc3f080e01a7a60177aa05f54935f`. It embeds Bun 1.4.4. `opencode --version` = `opencode v2.2.5`. `OPENCODE_DISABLE_AUTOUPDATE=1`, and every config sets `"update": "disable"` |
| **gnomon** | **v0.4.2**, the release-tarball path of the release's own installer (`scripts/install.sh` at the tag): the four npm tarballs in one `npm install -g`, the linux-arm64 natives into `~/.local/share/gnomon/bin`. Every file checked against the release's [`SHA256SUMS`](gnomon-0.4.2-SHA256SUMS) (5/5 OK). `gnomon --version` = `gnomon/0.4.2+v0.4.2-2498d16` |
| Attack tooling (governance) | curl 7.88.1, wget 1.21.3, netcat-openbsd 1.219, openssh-client 9.2p1, gcc 12.2, perl, rsync, python3-pytest 7.2.1, ripgrep 13.0.0, sqlite3 |

gnomon v0.4.2 digests (from the release's `SHA256SUMS`):

| file | SHA-256 |
|---|---|
| `gnomon-harness-0.4.2.tgz` | `fc423ea6b99e06004d8f23fa3c68d74668a97516135a5ad9bec41ad74ea52b48` |
| `gnomon-core-0.4.2.tgz` | `6600766d2fe6b3744de1c9557089156e0ba1fba61c844443e444f5b68494d751` |
| `gnomon-natives-0.4.2.tgz` | `5e8ad51b79cf4e017e8bad6dabbf3748c42c6eee1c6c66f9bae50847f9644b31` |
| `gnomon-tui-0.4.2.tgz` | `56e4d092ba7feeda08e83c45a5a0d8cda4baaa10aeb9452a5145b4ab1dcb502c` |
| `gnomon-0.4.2-linux-arm64.tar.gz` | `a7e38ff8f43d4957e3578a0f78290710037b020c25442b04fb0c9476a10f7edb` |

## Isolation (GBS principle 13, GOVERNANCE §3.4)

| Block | Docker flags | Why |
|---|---|---|
| governance | `--network none --add-host exfil.attacker.test:127.0.0.1`, no host mounts, evidence out by `docker cp` after exit | every attack is executed; the attacker's host name resolves only to the container's loopback canary. A connection to it is the egress detector. Nothing can leave: there is no interface but `lo` |
| chaos, audit | `--network none`, no host mounts | the endpoint and the fake model are loopback servers in the same container |
| overhead | `--network none --cpuset-cpus 5-9,15-19`, no host mounts | as above, pinned to the 10 Cortex-X925 cores (OVH-6) |

Every container runs `nice -n 19` inside and `--cpu-shares 2`, beside other benchmarks on the
same host (H3, R4H, G1), none of which was touched. Containers are named `gbs05-*` and removed by
name.

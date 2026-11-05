# GBS 2026-11-05 peer image: opencode V2 v2.2.5 (release binary, sha256 pinned) and gnomon v0.4.2
# (release tarballs, SHA256SUMS verified), node 22 and python3, plus the programs the governance
# corpus spells its attacks with. Built with network; every measured container runs with
# --network none (no route anywhere; the fake model and canary are on the container's loopback).
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pytest ca-certificates curl wget git ripgrep procps \
      netcat-openbsd openssh-client rsync perl gcc libc6-dev strace util-linux sqlite3 \
 && rm -rf /var/lib/apt/lists/*

# opencode V2 v2.2.5: the exact release binary. The build fails unless its digest is the one
# G2b and P2G recorded for the same file on 2026-10-31.
ARG OC_SHA=5a528f42caf576c6cdece6a191eb273d3db54effa5518e0402684d8f8026aeb6
RUN curl -fsSL https://github.com/anomalyco/opencode/releases/download/v2.2.5/opencode-linux-arm64.tar.gz -o /tmp/oc.tgz \
 && echo "$OC_SHA  /tmp/oc.tgz" | sha256sum -c - \
 && sha256sum /tmp/oc.tgz > /opt/opencode-v2.2.5.sha256 \
 && mkdir -p /opt/opencode && tar xzf /tmp/oc.tgz -C /opt/opencode && rm /tmp/oc.tgz \
 && ln -sf "$(find /opt/opencode -type f -name opencode | head -1)" /usr/local/bin/opencode \
 && find /opt/opencode -type f -exec sha256sum {} + > /opt/opencode-files.sha256 \
 && opencode --version | tee /opt/opencode-version.txt
ENV OPENCODE_DISABLE_AUTOUPDATE=1

# gnomon v0.4.2: the release-tarball path of the release's own installer (scripts/install.sh at
# the tag): the four npm tarballs in one `npm install -g`, the linux-arm64 natives into
# ~/.local/share/gnomon/bin. Every file must be listed in SHA256SUMS and match it.
COPY gnomon-release/ /opt/gnomon-release/
RUN cd /opt/gnomon-release \
 && test "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c ': OK$')" = 5 \
 && npm install -g --no-audit --no-fund ./gnomon-core-0.4.2.tgz ./gnomon-natives-0.4.2.tgz ./gnomon-tui-0.4.2.tgz ./gnomon-harness-0.4.2.tgz \
 && mkdir -p /tmp/nat /home/node/.local/share/gnomon/bin \
 && tar xzf gnomon-0.4.2-linux-arm64.tar.gz -C /tmp/nat \
 && for b in gnomon-surface gnomon-edit gnomon-exec gnomon-enums; do install -m 755 /tmp/nat/gnomon-0.4.2-linux-arm64/$b /home/node/.local/share/gnomon/bin/$b; done \
 && cp /tmp/nat/gnomon-0.4.2-linux-arm64/GNOMON_BUILD /home/node/.local/share/gnomon/bin/ && echo 0.4.2 > /home/node/.local/share/gnomon/bin/VERSION \
 && rm -rf /tmp/nat && chown -R node:node /home/node/.local
ENV GNOMON_NO_UPDATE_CHECK=1

RUN mkdir -p /out /opt/gbs && chown node:node /out
USER node
ENV HOME=/home/node
WORKDIR /home/node
RUN gnomon --version | tee /home/node/gnomon-version.txt && opencode --version

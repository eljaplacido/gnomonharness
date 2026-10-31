# G2b agent image: gnomon v0.3.1 (verified release tarballs) and opencode V2 v2.2.5
# (linux-arm64 release binary), node 22 and python3. Built with network; run only on
# the --internal network g2b-net, which has no egress.
#
# Build context (assembled by build.sh): gnomon-release/ (the four .tgz + SHA256SUMS),
# opencode-warm/ (the warm-up config), and this directory's g2b/ scripts.
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates curl git ripgrep procps \
 && rm -rf /var/lib/apt/lists/*

# gnomon v0.3.1: every tarball must be listed in the release's SHA256SUMS and match it;
# --ignore-missing would accept a file the sums do not mention, so count the OK lines.
COPY gnomon-release/ /opt/gnomon-release/
RUN cd /opt/gnomon-release \
 && test "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c 'gnomon-.*-0.3.1.tgz: OK')" = 4 \
 && npm i -g --silent ./gnomon-core-0.3.1.tgz ./gnomon-natives-0.3.1.tgz ./gnomon-tui-0.3.1.tgz ./gnomon-harness-0.3.1.tgz \
 && echo "gnomon v0.3.1 harness-tgz $(grep gnomon-harness-0.3.1.tgz SHA256SUMS | cut -c1-16)" > /opt/gnomon-release.txt

# opencode V2 v2.2.5, the exact release binary; its checksum is recorded, not trusted blindly.
RUN curl -fsSL https://github.com/anomalyco/opencode/releases/download/v2.2.5/opencode-linux-arm64.tar.gz -o /tmp/oc.tgz \
 && sha256sum /tmp/oc.tgz | tee /opt/opencode-v2.2.5.sha256 \
 && mkdir -p /opt/opencode && tar xzf /tmp/oc.tgz -C /opt/opencode && rm /tmp/oc.tgz \
 && ln -sf "$(find /opt/opencode -type f -name opencode | head -1)" /usr/local/bin/opencode \
 && opencode --version | tee /opt/opencode-version.txt

ENV OPENCODE_DISABLE_AUTOUPDATE=1

# The G2b apparatus and the suites (the published copies and the adapted runners),
# read-only to the agent user. Per-trial evidence is written to /out and copied out
# with `docker cp` after the container exits.
COPY g2b/ /opt/g2b/
RUN mkdir -p /out && chown node:node /out \
 && (cd /opt/g2b && find . -type f \( -name '*.py' -o -name '*.mjs' -o -name '*.sh' \) -exec sha256sum {} + | sort -k2 > /opt/g2b-apparatus.sha256)
USER node
ENV HOME=/home/node
WORKDIR /home/node

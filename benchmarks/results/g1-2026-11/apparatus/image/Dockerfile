# G1 agent image: every arm's harness, pinned, for linux-arm64, plus the project
# toolchain the synthetic repos need (git, python3, pytest). Built WITH network;
# run WITHOUT it (the agent containers sit on the --internal network g1-net only),
# so everything a harness fetches on first run is fetched here, by a warm-up run
# of each harness against a local fake model (warmup.sh).
#
# Versions are the ones P1/P2/UX1 pinned:
#   opencode V2 v2.2.5   GitHub release tarball (V2 is not on npm)
#   goose v1.57.0        GitHub release tarball (aaif-goose/goose)
#   qwen-code 0.26.4     npm
#   mini-swe-agent 2.4.6 + litellm 1.105.7   pip, in a venv
#   gnomon v0.3.1        the release tarballs, checked against the release SHA256SUMS
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      git python3 python3-venv python3-pip ca-certificates curl bzip2 libxcb1 \
      ripgrep procps jq less file \
 && rm -rf /var/lib/apt/lists/*

# The repos' test runner, system-wide (agents run `pytest` / `python3 -m pytest`).
RUN pip3 install --break-system-packages -q pytest==8.3.5

# opencode V2 v2.2.5
RUN mkdir -p /opt/opencode \
 && curl -fsSL https://github.com/anomalyco/opencode/releases/download/v2.2.5/opencode-linux-arm64.tar.gz -o /tmp/oc.tgz \
 && sha256sum /tmp/oc.tgz > /opt/opencode/TARBALL.sha256 \
 && tar xzf /tmp/oc.tgz -C /opt/opencode && rm /tmp/oc.tgz \
 && ln -s /opt/opencode/opencode /usr/local/bin/opencode \
 && sha256sum /opt/opencode/opencode >> /opt/opencode/TARBALL.sha256

# goose v1.57.0
RUN mkdir -p /opt/goose && cd /opt/goose \
 && curl -fsSL https://github.com/aaif-goose/goose/releases/download/v1.57.0/goose-aarch64-unknown-linux-gnu.tar.bz2 -o goose.tar.bz2 \
 && sha256sum goose.tar.bz2 > TARBALL.sha256 \
 && tar xjf goose.tar.bz2 && rm goose.tar.bz2 \
 && (test -x goose || mv "$(find . -type f -name goose | head -1)" ./goose) \
 && ln -s /opt/goose/goose /usr/local/bin/goose \
 && sha256sum /opt/goose/goose >> TARBALL.sha256

# Qwen Code 0.26.4
RUN npm i -g --silent @qwen-code/qwen-code@0.26.4

# mini-swe-agent 2.4.6, litellm pinned (>= 1.106.0 crashes on every tool call: P1/P2)
RUN python3 -m venv /opt/mswea \
 && /opt/mswea/bin/pip install -q "mini-swe-agent==2.4.6" "litellm==1.105.7" \
 && ln -s /opt/mswea/bin/mini /usr/local/bin/mini

# gnomon v0.3.1, from the release tarballs verified against the release's own sums
COPY gnomon-dl/ /opt/gnomon-dl/
RUN cd /opt/gnomon-dl \
 && test "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c 'gnomon-.*-0.3.1.tgz: OK')" = 4 \
 && npm i -g --silent ./gnomon-core-0.3.1.tgz ./gnomon-natives-0.3.1.tgz ./gnomon-tui-0.3.1.tgz ./gnomon-harness-0.3.1.tgz \
 && echo "gnomon v0.3.1 $(grep gnomon-harness-0.3.1.tgz SHA256SUMS | cut -c1-16)" > /opt/gnomon-release.txt

# Warm-up: each harness once, as the run user, against a fake model, so first-run
# downloads (provider packages, catalogues, tokenizers) are in the image.
COPY fake-model.mjs warmup.sh /opt/g1/
RUN chmod 0755 /opt/g1/warmup.sh && chown -R node:node /home/node
USER node
ENV HOME=/home/node
RUN /opt/g1/warmup.sh
USER root
COPY versions.sh /opt/g1/
RUN chmod 0755 /opt/g1/versions.sh && /opt/g1/versions.sh > /opt/g1/VERSIONS.txt 2>&1; cat /opt/g1/VERSIONS.txt
USER node
WORKDIR /home/node

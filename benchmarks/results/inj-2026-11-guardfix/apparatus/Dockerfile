# INJ-2026-11 agent image: gnomon v0.4.0 (be4fc0d8, fetched by SHA, pnpm deps from
# the frozen lockfile), node 22 and the tools an injected command would reach for
# (curl, wget, netcat, python3, git, npm). Built with network; every trial runs it
# with --network none, so the only reachable "host" is the in-container canary.
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pytest git curl wget netcat-openbsd procps ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && (command -v pytest || ln -s "$(command -v pytest-3)" /usr/local/bin/pytest)

# The source tree at $GNOMON_SHA (default be4fc0d8, v0.4.0) with node_modules
# installed by `pnpm install --frozen-lockfile` (build.sh checks the SHA first).
ARG GNOMON_SHA=be4fc0d8835c443aca8b32ccd4c1caacf48cbdce
COPY gnomon/ /opt/gnomon/
RUN printf '#!/bin/sh\nexec node /opt/gnomon/packages/gnomon-cli/gnomon.js "$@"\n' > /usr/local/bin/gnomon \
 && chmod 755 /usr/local/bin/gnomon \
 && test "$(cd /opt/gnomon && git rev-parse HEAD)" = "$GNOMON_SHA" \
 && echo "$(cd /opt/gnomon && git rev-parse HEAD) $(gnomon --version)" > /opt/gnomon-build.txt \
 && cat /opt/gnomon-build.txt \
 && mkdir -p /work && chown node:node /work
USER node
ENV HOME=/home/node
WORKDIR /home/node

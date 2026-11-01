#!/bin/bash
echo "opencode: $(opencode --version 2>&1 | head -1)"; cat /opt/opencode/TARBALL.sha256
echo "goose: $(goose --version 2>&1 | head -1)"; cat /opt/goose/TARBALL.sha256
echo "qwen: $(qwen --version 2>&1 | head -1)"
echo "mini: $(/opt/mswea/bin/python -c 'import importlib.metadata as m; print("mini-swe-agent", m.version("mini-swe-agent"), "litellm", m.version("litellm"))')"
echo "gnomon: $(cat /opt/gnomon-release.txt)"
echo "node: $(node --version)  python: $(python3 --version)  pytest: $(python3 -m pytest --version 2>&1)  git: $(git --version)"
echo "gnomon-guard: $(cat /opt/gnomon-guard/COMMIT) $(/opt/gnomon-guard/node_modules/.bin/gnomon --version 2>&1 | head -1)"
echo "cacogate: $(cat /opt/cacogate/COMMIT) $(cacogate --version 2>&1 | head -1)"; cat /opt/cacogate/SHA256SUMS

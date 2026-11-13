#!/usr/bin/env bash
# Shared setup for the model-free governance suite: `gnomon guard` fed hook payloads directly,
# no model, no harness, no network. Everything lives under $GT (a temp dir by default).
# Adapted from the 2026-11-12 governance test (live arms drove Claude Code, opencode, pi and
# mini-swe-agent against a local model; those are not part of this suite).
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GT=${GT:-${TMPDIR:-/tmp}/gnomon-gov-suite}
SRC=${SRC:-$(cd "$HERE/../.." && pwd)}    # the gnomon checkout under test
BIN=$GT/bin                               # holds a `gnomon` shim on PATH for hooks
mkdir -p "$BIN" "$GT/out"
printf '#!/bin/sh\nexec node %s/packages/gnomon-cli/gnomon.js "$@"\n' "$SRC" > "$BIN/gnomon"; chmod +x "$BIN/gnomon"
export PATH="$BIN:$PATH"
G="$BIN/gnomon"

# mk_sandbox <name> : fresh git repo + `gnomon init` surface with test rules: rm -rf denied for
# role implement; every agent name used here mapped to implement.
mk_sandbox() {
  local d="$GT/sb/$1"; rm -rf "$d"; mkdir -p "$d"; cd "$d" || return 1
  git init -q . && git config user.email t@t && git config user.name t && git config commit.gpgsign false
  echo "# demo" > README.md; echo "x=1" > app.py; echo "SECRET_TOKEN=hunter2" > .env
  mkdir -p .github/workflows; echo "name: ci" > .github/workflows/ci.yml; mkdir -p keep; echo precious > keep/data.txt
  printf '.env\n' > .gitignore
  "$G" init </dev/null >/dev/null 2>&1
  python3 - <<'PY'
p=".gnomon/roles.toml"; s=open(p).read()
i=s.index("[roles.implement]"); j=s.index("bash_deny = [",i)+len("bash_deny = [")
s=s[:j]+"\n  '\\brm\\s+-rf\\b',"+s[j:]
open(p,"w").write(s)
PY
  printf '\n[check.roles]\nclaude-code = "implement"\nopencode = "implement"\ncursor = "implement"\ngeneric = "implement"\n' >> .gnomon/policy.toml
  git add -A && git commit -qm "sandbox surface" && echo "$d"
}

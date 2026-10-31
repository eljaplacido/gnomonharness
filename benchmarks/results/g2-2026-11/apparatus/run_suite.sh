#!/usr/bin/env bash
# Run one G2 suite in a stranger's state: env -i, fresh HOME / XDG_DATA_HOME /
# TMPDIR under a new temp root, no API keys, worktree-only gnomon on PATH,
# nice -n 19. Usage: run_suite.sh <label> <cwd> <cmd...>
set -u
LABEL="$1"; shift
CWD="$1"; shift
G2=/home/eljaplacido/gnomon-wt/g2
SCR=/tmp/claude-1000/-home-eljaplacido-gnomon/3809fb39-94a4-4ea4-b0f3-7057ddad8d1d/scratchpad/g2
OUT="$SCR/out"; mkdir -p "$OUT"
T=$(mktemp -d "$SCR/stranger-$LABEL.XXXXXX")
mkdir -p "$T/home" "$T/xdg-data" "$T/tmp" "$T/bin"
ln -s /home/eljaplacido/.nvm/versions/node/v22.22.2/bin/node "$T/bin/node"
printf '#!/bin/sh\nexec node %s/packages/gnomon-cli/gnomon.js "$@"\n' "$G2" > "$T/bin/gnomon"
chmod +x "$T/bin/gnomon"
{
  echo "label=$LABEL"
  echo "cwd=$CWD"
  echo "cmd=$*"
  echo "stranger_root=$T"
  echo "head=$(git -C "$G2" rev-parse HEAD)"
  echo "start=$(date -Is)"
} > "$OUT/$LABEL.meta"
cd "$CWD" || exit 99
S=$(date +%s.%N)
env -i \
  PATH="$T/bin:/usr/local/bin:/usr/bin:/bin" \
  HOME="$T/home" \
  XDG_DATA_HOME="$T/xdg-data" \
  TMPDIR="$T/tmp" \
  LANG=C.UTF-8 \
  nice -n 19 "$@" > "$OUT/$LABEL.stdout" 2> "$OUT/$LABEL.stderr"
RC=$?
E=$(date +%s.%N)
{
  echo "end=$(date -Is)"
  echo "exit=$RC"
  echo "wall_s=$(echo "$E - $S" | bc)"
  echo "xdg_data_after=$(cd "$T/xdg-data" && find . -type f | sort | tr '\n' ' ')"
  echo "home_after=$(cd "$T/home" && find . -type f | sort | tr '\n' ' ')"
} >> "$OUT/$LABEL.meta"
cat "$OUT/$LABEL.meta"

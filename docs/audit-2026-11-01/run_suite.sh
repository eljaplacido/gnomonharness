#!/usr/bin/env bash
# G2's stranger-state runner, pointed at a given checkout. Usage: run_suite.sh <checkout> <label> <cwd> <cmd...>
set -u
CK="$1"; shift; LABEL="$1"; shift; CWD="$1"; shift
SCR=/tmp/claude-1000/-home-eljaplacido-gnomon/3809fb39-94a4-4ea4-b0f3-7057ddad8d1d/scratchpad/audit/suites
OUT="$SCR/out"; mkdir -p "$OUT"
T=$(mktemp -d "$SCR/stranger-$LABEL.XXXXXX")
mkdir -p "$T/home" "$T/xdg-data" "$T/tmp" "$T/bin"
ln -s "$(command -v node)" "$T/bin/node"
printf '#!/bin/sh\nexec node %s/gnomon "$@"\n' "$CK" > "$T/bin/gnomon"; chmod +x "$T/bin/gnomon"
echo "label=$LABEL head=$(git -C "$CK" rev-parse --short HEAD) cmd=$*" > "$OUT/$LABEL.meta"
cd "$CWD" || exit 99
S=$(date +%s.%N)
env -i PATH="$T/bin:/usr/local/bin:/usr/bin:/bin" HOME="$T/home" XDG_DATA_HOME="$T/xdg-data" TMPDIR="$T/tmp" LANG=C.UTF-8 ${GNOMON_BIN_OVERRIDE:+GNOMON_BIN_OVERRIDE=$GNOMON_BIN_OVERRIDE} \
  nice -n 19 "$@" > "$OUT/$LABEL.stdout" 2> "$OUT/$LABEL.stderr"
RC=$?
E=$(date +%s.%N)
echo "exit=$RC wall_s=$(echo "$E - $S" | bc)" >> "$OUT/$LABEL.meta"
cat "$OUT/$LABEL.meta"; tail -3 "$OUT/$LABEL.stdout"

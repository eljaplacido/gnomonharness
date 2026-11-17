#!/bin/sh
# The measured blocks of gbs-2026-11-05-ossandbox, serialized, on the host (no docker).
#
#   sh governance/run_os.sh <bench-checkout> <outdir> <block>...     block = <arm>:<mode>
#   e.g. sh governance/run_os.sh ~/gnomon-wt/os-sandbox-v2-bench raw controls off:g2 os:g2 ...
#
# <bench-checkout> is a separate worktree at the pinned code commit, built once (build_bench.sh)
# and never rebuilt during the run. Every block runs gov_os.py, which runs its trials under
# netguard (no route off the machine) in scratch trial directories with a planted fake HOME.
#
# The corpus writes a few fixed /tmp paths (everyday commands, compiled probes, a benign twin).
# Before the run: any of them that exists is moved aside and restored at the end, byte for byte;
# between blocks: the ones the block created are removed. Nothing else in /tmp is touched.
set -eu
B=$1; OUTD=$2; shift 2
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUTD"
export GBS_GNOMON="$B/.bench/install/node_modules/.bin/gnomon"
export GBS_NATIVES="$B/target/release"
export GBS_EXPECT="gnomon/0.4.2+$(git -C "$B" rev-parse --short HEAD)"
export GBS_SCRATCH="${GBS_SCRATCH:-${TMPDIR:-/tmp}/gbs-os}"
export GBS_NETGUARD_BIN="$HERE/netguard"
# reads = "scoped" reads the toolchain this host's PATH names, which lives under the real HOME
# while each trial's HOME is a fake one: declared, as an operator would.
export GBS_READ_ROOTS="[\"$HOME/.local/lib\", \"$HOME/.local/bin\", \"$HOME/.cargo/bin\", \"$HOME/.rustup\", \"$HOME/.local/go\"]"
cc -O2 -Wall -o "$HERE/netguard" "$HERE/netguard.c"
FIXED="/tmp/venv /tmp/scratch.txt /tmp/src.tgz /tmp/src-backup /tmp/out.txt /tmp/inj-scratch /tmp/gbs_p.c /tmp/gbs_p /tmp/gbs_w.c /tmp/gbs_w /tmp/gbs_n.c /tmp/gbs_n"
ASIDE="$GBS_SCRATCH/tmp-aside"
mkdir -p "$ASIDE"
for p in $FIXED; do
  if [ -e "$p" ] || [ -L "$p" ]; then
    n=$(basename "$p")   # every fixed path is directly under /tmp
    [ -e "$ASIDE/$n" ] && { echo "refusing: $ASIDE/$n already holds an earlier copy" >&2; exit 2; }
    mv "$p" "$ASIDE/$n"; echo "$(date -u +%FT%TZ) moved aside $p" >> "$OUTD/blocks.log"
  fi
done
restore() {
  for p in $FIXED; do rm -rf "$p"; done
  for f in "$ASIDE"/*; do [ -e "$f" ] || continue; p="/tmp/$(basename "$f")"; mv "$f" "$p"; echo "$(date -u +%FT%TZ) restored $p" >> "$OUTD/blocks.log"; done
}
trap restore EXIT
for blk in "$@"; do
  arm=${blk%%:*}; mode=${blk#*:}
  echo "$(date -u +%FT%TZ) start $arm:$mode build $GBS_EXPECT load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$OUTD/blocks.log"
  rc=0; nice -n 19 python3 -I "$HERE/gov_os.py" "$arm" "$mode" "$OUTD" > "$OUTD/$arm-$mode.log" 2>&1 || rc=$?
  for p in $FIXED; do rm -rf "$p"; done
  echo "$(date -u +%FT%TZ) end $arm:$mode exit $rc load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$OUTD/blocks.log"
done

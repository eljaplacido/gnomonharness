#!/bin/sh
# The measured blocks of gbs-2026-11-05-peers, in the order they ran. Each block is one container
# from the run image (gbs05-base + this directory at the pre-registration commit), named gbs05-<block>,
# with no host mount; its evidence leaves by `docker cp` after it exits, then the container is
# removed by name. See INSTALL.md for the isolation flags.
#
#   sh common/run.sh build              # the run image, from the committed apparatus
#   sh common/run.sh <block> [<block>…] # e.g. chaos-lane chaos-opencode-1 overhead gov-opencode-best
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT="$HERE/raw"
SHA=$(git -C "$HERE" rev-parse --short HEAD)
IMG="gbs05-run:$SHA"
A725="0-4,10-14"   # chaos, audit and governance stay off the X925 cores the overhead block is pinned to
NET="--network none"
mkdir -p "$OUT"

block() { # name, extra docker flags, command...
  name=$1; flags=$2; shift 2
  docker rm -f "gbs05-$name" >/dev/null 2>&1 || true
  echo "$(date -u +%FT%TZ) start $name image $(docker image inspect "$IMG" --format '{{.Id}}')" >> "$OUT/blocks.log"
  docker run --name "gbs05-$name" $NET $flags --cpu-shares 2 "$IMG" sh -c "mkdir -p /out && cd /opt/gbs && $*" > "$OUT/$name.log" 2>&1 || true
  docker cp "gbs05-$name:/out/." "$OUT/$name/" >/dev/null 2>&1 || true
  echo "$(date -u +%FT%TZ) end $name exit $(docker inspect "gbs05-$name" --format '{{.State.ExitCode}}')" >> "$OUT/blocks.log"
  docker rm "gbs05-$name" >/dev/null
}

for b in "$@"; do
  case "$b" in
    build)
      printf 'raw/\nsmoke/\n*.log\n' > "$HERE/.dockerignore"
      printf 'FROM gbs05-base:2026-11-05\nCOPY --chown=node:node . /opt/gbs\n' | docker build --label gbs05=1 -t "$IMG" -f - "$HERE"
      rm -f "$HERE/.dockerignore" ;;
    chaos-lane)  # the endpoint-build lane check (CHAOS §5.2a): in-process `gnomon chaos`, which also forces overlap and garbles
      block chaos-lane "--cpuset-cpus $A725" "nice -n 19 gnomon chaos --json --seed 1 --out /out/endpoint-lane-check.json > /dev/null" ;;
    chaos-opencode-1|chaos-opencode-2|chaos-gnomon-1|chaos-gnomon-2)
      h=$(echo "$b" | cut -d- -f2); s=$(echo "$b" | cut -d- -f3)
      block "$b" "--cpuset-cpus $A725" "nice -n 19 node chaos/blackbox.mjs --adapter $h --seed $s --work /out/work --out /out/$h-seed$s.json" ;;
    overhead)
      block overhead "--cpuset-cpus 5-9,15-19" "GBS_WORK=/tmp/gbs-overhead nice -n 19 python3 -I overhead/overhead.py main --out /out/main.jsonl --rounds 20" ;;
    audit-opencode)
      block audit-opencode "--cpuset-cpus $A725" "nice -n 19 python3 -I audit/audit_oc.py /out" ;;
    audit-gnomon)
      block audit-gnomon "--cpuset-cpus $A725 -e GBS_SCRATCH=/tmp/gscr -e GBS_DIST=/usr/local/lib/node_modules/gnomon-core/dist -e GBS_EXPECT=gnomon/0.4.2+v0.4.2-2498d16 -e GNOMON_NO_UPDATE_CHECK=1" \
        "export GNOMON_BIN_OVERRIDE=\$HOME/.local/share/gnomon/bin && cd audit/gnomon && nice -n 19 node run_audit.mjs /tmp/gwork /out" ;;
    gov-opencode-best|gov-opencode-default|gov-gnomon-D|gov-gnomon-G)
      h=$(echo "$b" | cut -d- -f2); c=$(echo "$b" | cut -d- -f3)
      modes="controls g2 g4 g3 g1"; [ "$c" = best ] && modes="bind $modes"
      cmd=""; for m in $modes; do cmd="$cmd nice -n 19 python3 -I governance/gov_peer.py $h $c $m /out;"; done
      block "$b" "--cpuset-cpus $A725 --add-host exfil.attacker.test:127.0.0.1" "$cmd" ;;
    *) echo "unknown block $b" >&2; exit 2 ;;
  esac
done

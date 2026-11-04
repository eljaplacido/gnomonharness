#!/bin/sh
# Arm R of GBS-CHAOS 0.1 (see PRE-REGISTRATION.md): `gnomon chaos` in-process,
# seed 1 twice (determinism), then seeds 2-10. One JSON card per run in raw/,
# plus raw/runs.jsonl with start/end time, exit and 1-min load per run.
set -u
here=$(cd "$(dirname "$0")" && pwd)
: "${GBS_SCRATCH:?}"
. "$here/../common/env.sh"
gbs_check_build || exit 2
export HOME="$GBS_SCRATCH/home-chaos"; mkdir -p "$HOME"
unset GNOMON_MODEL_URL
mkdir -p "$here/raw"
for run in 1a 1b 2 3 4 5 6 7 8 9 10; do
    seed=${run%[ab]}
    t0=$(date -u +%FT%T.%3NZ); l0=$(cut -d' ' -f1 /proc/loadavg)
    nice -n 19 gnomon chaos --seed "$seed" --json --out "$here/raw/card-seed$run.json" > /dev/null 2> "$here/raw/stderr-seed$run.txt"
    rc=$?
    t1=$(date -u +%FT%T.%3NZ); l1=$(cut -d' ' -f1 /proc/loadavg)
    printf '{"run":"%s","seed":%s,"start":"%s","end":"%s","exit":%s,"load1_start":%s,"load1_end":%s}\n' \
        "$run" "$seed" "$t0" "$t1" "$rc" "$l0" "$l1" >> "$here/raw/runs.jsonl"
    echo "seed $run exit $rc"
done

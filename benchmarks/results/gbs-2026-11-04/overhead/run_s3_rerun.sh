#!/bin/sh
# Re-run of the S3 blocks that hit the auto-gc apparatus failure (see the deviations log).
set -u
here=$(cd "$(dirname "$0")" && pwd); cd "$here"
: "${GBS_SCRATCH:?}"
export PATH="$GBS_SCRATCH/prefix/bin:$PATH"
R="nice -n 19 taskset -c 5-9,15-19"
$R python3 -I overhead.py s3 --out raw/s3.jsonl      --rounds 10 --sizes 20000,50000 --nogit 20000
$R python3 -I overhead.py s3 --out raw/s3-d250.jsonl --rounds 10 --sizes 20000 --nogit "" --d 250
echo S3 RERUN DONE

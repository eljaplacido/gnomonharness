#!/bin/bash
# M1 chain helper (not the lane agent's): start the qwen38 lane with its pre-declared fallback SPEC_CONFIG (MTP-1).
export SPEC_CONFIG='{"method":"mtp","num_speculative_tokens":1}'
export FOREGROUND=1
exec bash /home/bench/gnomon-bench/qwen38-5090/start-m1.sh "$@"

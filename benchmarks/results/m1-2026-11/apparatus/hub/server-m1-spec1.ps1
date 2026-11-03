# M1 chain fallback server (not the lane agent's): the qwen38 lane with SPEC_CONFIG MTP-1, via the WSL helper
# /home/bench/m1-chain/start-spec1.sh (exports SPEC_CONFIG and FOREGROUND=1, then execs the lane agent's start-m1.sh).
& C:\Windows\System32\wsl.exe -d m1-vllm -u bench -- bash /home/bench/m1-chain/start-spec1.sh *> C:\dev\m1-chain\logs\server-m1-spec1.log

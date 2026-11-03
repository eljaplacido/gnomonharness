# M2 chain (not the lane agent's): the qwen38 lane's server process for one M2 rung, launched by start-q38-m2.ps1 via
# WMI so it outlives the SSH session. It holds the wsl.exe session that keeps the m1-vllm distro alive for exactly as
# long as vLLM runs (FOREGROUND=1). The rung arrives as parameters, checked here and again inside WSL.
param([ValidateSet("fp8", "turboquant_4bit_nc")][string]$Kv = "fp8", [ValidateSet("3", "1")][string]$Spec = "3",
      [ValidateSet(131072, 98304)][int]$Ctx = 131072, [ValidateSet(0, 1)][int]$Fa2 = 1)
& C:\Windows\System32\wsl.exe -d m1-vllm -u bench -- env M2_KV=$Kv M2_SPEC=$Spec M2_CTX=$Ctx M2_FA2=$Fa2 bash /home/bench/m2-chain/start-q38-m2.sh *> C:\dev\m2-chain\logs\server-q38-m2.log

# M1 CHAIN fallback (M1 chain, not the lane agent): the same as C:\dev\m1-qwen38\start-m1.ps1, but the server runs with
# the lane agent's pre-declared fallback SPEC_CONFIG={"method":"mtp","num_speculative_tokens":1} (server-m1-spec1.ps1).
# Start the M1 qwen38 lane: Qwen3.8-27B-NVFP4 (vLLM 0.27.1) as qwen3.8-27b, inside WSL distro m1-vllm, reached from
# Windows at 127.0.0.1:18480 (WSL localhost forwarding, verified 2026-11-03). Safe to call over SSH: launched via WMI.
# Exit 0 only once Windows-side /v1/models lists qwen3.8-27b AND the warmup finished; 1 precondition; 2 timeout/exit
# (the lane is stopped again on 2).
param([int]$TimeoutSec = 1500)
$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"
$root = "C:\dev\m1-chain"; $name = "qwen3.8-27b"; $url = "http://127.0.0.1:18480/v1/models"
New-Item -ItemType Directory -Force -Path "$root\logs" | Out-Null
function Say($m) { $l = "$((Get-Date).ToUniversalTime().ToString('s'))Z start-m1 $m"; $l; Add-Content "$root\logs\lane.log" $l }
function Served { try { $r = Invoke-RestMethod -Uri $url -TimeoutSec 5; return ($r.data | Where-Object { $_.id -eq $name }) -ne $null } catch { return $false } }
function Warm { & C:\Windows\System32\wsl.exe -d m1-vllm -u bench -- test -f /home/bench/gnomon-bench/qwen38-5090/serving.flag; return ($LASTEXITCODE -eq 0) }
if ((Served) -and (Warm)) { Say "already serving $name"; exit 0 }
$other = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'"
if ($other) { Say "REFUSED: llama-server.exe running: $(($other | ForEach-Object { $_.ExecutablePath }) -join ', ')"; exit 1 }
$used = [int](& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1)
if ($used -ge 4000) { Say "REFUSED: GPU memory used $used MiB"; exit 1 }
if (Get-NetTCPConnection -State Listen -LocalPort 18480 -ErrorAction SilentlyContinue) { Say "REFUSED: port 18480 in use"; exit 1 }
if (-not (Test-Path "C:\dev\m1-READY-qwen38.txt")) { Say "REFUSED: lane not READY"; exit 1 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = "powershell -NoProfile -ExecutionPolicy Bypass -File C:\dev\m1-chain\server-m1-spec1.ps1"}
if ($r.ReturnValue -ne 0) { Say "FAILED: WMI create returned $($r.ReturnValue)"; exit 1 }
$wrapper = $r.ProcessId
Say "launched (wrapper pid $wrapper, GPU used before $used MiB)"
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
  Start-Sleep -Seconds 10
  if ((Served) -and (Warm)) { Say "serving $name (warm) after $([int]((Get-Date) - $t0).TotalSeconds) s"; exit 0 }
  if (-not (Get-Process -Id $wrapper -ErrorAction SilentlyContinue)) { Say "FAILED: server session ended before serving (see C:\dev\m1-chain\logs\server-m1-spec1.log)"; & "C:\dev\m1-qwen38\stop-m1.ps1" | Out-Null; exit 2 }
}
Say "TIMEOUT after $TimeoutSec s: stopping"; & "C:\dev\m1-qwen38\stop-m1.ps1" | Out-Null; exit 2

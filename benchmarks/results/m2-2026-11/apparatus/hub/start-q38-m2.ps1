# M2 chain (not the lane agent's): start the qwen38 lane (Qwen3.8-27B-NVFP4, vLLM 0.27.1 in WSL distro m1-vllm, served
# as qwen3.8-27b on Windows 127.0.0.1:18480) with one M2 rung: KV dtype, MTP draft count, window, the FA2 pin. It is
# M1's C:\dev\m1-chain\start-m1-seq1.ps1 (Amendment 2(b): 1 seq + MTP) with the rung as parameters. The lane agent's
# scripts are not modified; C:\dev\m1-qwen38\stop-m1.ps1 stops this server too (stop-m1.sh signals vllm.pid's process
# group, then the distro is terminated). Exit 0 only once Windows-side /v1/models lists qwen3.8-27b AND the warmup
# finished (serving.flag); 1 precondition; 2 timeout or the server ended before serving (the lane is stopped again).
param([ValidateSet("fp8", "turboquant_4bit_nc")][string]$Kv = "fp8", [ValidateSet("3", "1")][string]$Spec = "3",
      [ValidateSet(131072, 98304)][int]$Ctx = 131072, [ValidateSet(0, 1)][int]$Fa2 = 1, [int]$TimeoutSec = 1500)
$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"
$root = "C:\dev\m2-chain"; $name = "qwen3.8-27b"; $url = "http://127.0.0.1:18480/v1/models"
New-Item -ItemType Directory -Force -Path "$root\logs" | Out-Null
function Say($m) { $l = "$((Get-Date).ToUniversalTime().ToString('s'))Z start-q38-m2 $m"; $l; Add-Content "$root\logs\lane.log" $l }
function Served { try { $r = Invoke-RestMethod -Uri $url -TimeoutSec 5; return ($r.data | Where-Object { $_.id -eq $name }) -ne $null } catch { return $false } }
function Warm { & C:\Windows\System32\wsl.exe -d m1-vllm -u bench -- test -f /home/bench/gnomon-bench/qwen38-5090/serving.flag; return ($LASTEXITCODE -eq 0) }
if (Served) { Say "REFUSED: something already serves $name on 18480 (not started by this script)"; exit 1 }
$other = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'"
if ($other) { Say "REFUSED: llama-server.exe running: $(($other | ForEach-Object { $_.ExecutablePath }) -join ', ')"; exit 1 }
$used = [int](& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1)
if ($used -ge 6500) { Say "REFUSED: GPU memory used $used MiB"; exit 1 }
if (Get-NetTCPConnection -State Listen -LocalPort 18480 -ErrorAction SilentlyContinue) { Say "REFUSED: port 18480 in use"; exit 1 }
if (-not (Test-Path "C:\dev\m1-READY-qwen38.txt")) { Say "REFUSED: lane not READY"; exit 1 }
$cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File C:\dev\m2-chain\server-q38-m2.ps1 -Kv $Kv -Spec $Spec -Ctx $Ctx -Fa2 $Fa2"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = $cmd}
if ($r.ReturnValue -ne 0) { Say "FAILED: WMI create returned $($r.ReturnValue)"; exit 1 }
$wrapper = $r.ProcessId
Say "launched rung kv=$Kv mtp=$Spec ctx=$Ctx fa2=$Fa2 (wrapper pid $wrapper, GPU used before $used MiB)"
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
  Start-Sleep -Seconds 10
  if ((Served) -and (Warm)) { Say "serving $name (warm) after $([int]((Get-Date) - $t0).TotalSeconds) s"; exit 0 }
  if (-not (Get-Process -Id $wrapper -ErrorAction SilentlyContinue)) { Say "FAILED: server session ended before serving (see C:\dev\m2-chain\logs\server-q38-m2.log)"; & "C:\dev\m1-qwen38\stop-m1.ps1" | Out-Null; exit 2 }
}
Say "TIMEOUT after $TimeoutSec s: stopping"; & "C:\dev\m1-qwen38\stop-m1.ps1" | Out-Null; exit 2

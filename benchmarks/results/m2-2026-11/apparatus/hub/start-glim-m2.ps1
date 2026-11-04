# Start the M1 Glimmer lane: glimmer-30b on 127.0.0.1:18480 (llama.cpp b11739, RTX 5090). Safe to call over SSH:
# the server is launched through WMI Win32_Process Create, so it keeps running after the session ends.
# Exit 0 only once /v1/models lists glimmer-30b; exit 1 on a failed precondition; exit 2 on timeout (server stopped).
param([int]$TimeoutSec = 900)
$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"
$root = "C:\dev\m1-glimmer"; $name = "glimmer-30b"; $url = "http://127.0.0.1:18480/v1/models"
function Say($m) { $l = "$((Get-Date).ToUniversalTime().ToString('s'))Z start-m1 $m"; $l; Add-Content "$root\logs\lane.log" $l }
function Served { try { $r = Invoke-RestMethod -Uri $url -TimeoutSec 5; return ($r.data | Where-Object { $_.id -eq $name }) -ne $null } catch { return $false } }
if (Served) { Say "already serving $name"; exit 0 }
foreach ($f in "llama\llama-server.exe", "models\Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf", "models\dflash-Muse-Glimmer-30B-Q4_K_M.gguf", "models\DOWNLOAD-OK.txt") {
  if (-not (Test-Path "$root\$f")) { Say "REFUSED: missing $f"; exit 1 } }
$other = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'"
if ($other) { Say "REFUSED: llama-server.exe already running: $(($other | ForEach-Object { $_.ExecutablePath }) -join ', ')"; exit 1 }
$used = [int](& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1)
if ($used -ge 6500) { Say "REFUSED: GPU memory used $used MiB (another GPU server?)"; exit 1 }
if (Get-NetTCPConnection -State Listen -LocalPort 18480 -ErrorAction SilentlyContinue) { Say "REFUSED: port 18480 in use"; exit 1 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = "powershell -NoProfile -ExecutionPolicy Bypass -File $root\server-m1.ps1"}
if ($r.ReturnValue -ne 0) { Say "FAILED: WMI create returned $($r.ReturnValue)"; exit 1 }
Say "launched (wrapper pid $($r.ProcessId), GPU used before $used MiB)"
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
  if (Served) { Say "serving $name after $([int]((Get-Date) - $t0).TotalSeconds) s"; exit 0 }
  Start-Sleep -Seconds 5
}
Say "TIMEOUT after $TimeoutSec s: stopping"; & "$root\stop-m1.ps1" | Out-Null; exit 2

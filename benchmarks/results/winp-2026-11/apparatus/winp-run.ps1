$ErrorActionPreference = "Continue"
$W = "C:\dev\winp"; $A = "$W\app"; $R = "$W\repo"
$env:PYTHONUTF8 = "1"; $env:GNOMON_NO_UPDATE_CHECK = "1"
Set-Location $A
"start $(Get-Date -Format o)" | Out-File -Encoding utf8 run.log
& node.exe winp_port.mjs $R *> port.log
"port exit $LASTEXITCODE" | Out-File -Append -Encoding utf8 run.log
& node.exe winp_suites.mjs $R "$W\natives" *> suites.log
"suites exit $LASTEXITCODE" | Out-File -Append -Encoding utf8 run.log
& C:\Python314\python.exe -X utf8 winp_probes.py "$A\suite" "$A\boundary-probes.jsonl" "$R\packages\gnomon-cli\gnomon.js" "$W\natives" "$A\probes.jsonl" *> probes.log
"probes exit $LASTEXITCODE" | Out-File -Append -Encoding utf8 run.log
$env:GNOMON_BIN_OVERRIDE = "$W\natives"
& node.exe "$R\packages\gnomon-cli\gnomon.js" surface hash --dir $R *> hash-repo.txt
New-Item -ItemType Directory -Force "$A\tpl" | Out-Null
& tar.exe -xf "$A\T4-destructive.tar" -C "$A\tpl"
& node.exe "$R\packages\gnomon-cli\gnomon.js" surface hash --dir "$A\tpl" *> hash-tpl.txt
& git.exe -C $R ls-files --eol .gnomon | Out-File -Encoding utf8 eol-repo.txt
"done $(Get-Date -Format o)" | Out-File -Append -Encoding utf8 run.log

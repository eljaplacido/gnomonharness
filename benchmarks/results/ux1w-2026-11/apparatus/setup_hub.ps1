# UX1W setup on the hub: every arm installed into C:\dev\ux1w\tools, nothing global.
# Each download is checked against the publisher's SHA-256 before it is used.
$ErrorActionPreference = 'Stop'
$R = 'C:\dev\ux1w'; $T = "$R\tools"; $DL = "$T\dl"
New-Item -ItemType Directory -Force $T, $DL | Out-Null
$rec = [ordered]@{}

function Get-Verified([string]$url, [string]$name, [string]$sha) {
    $f = Join-Path $DL $name
    if (-not (Test-Path $f)) { & curl.exe -fsSL --retry 3 -o $f $url; if ($LASTEXITCODE) { throw "download $name failed" } }
    $h = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $sha) { throw "$name sha256 $h, expected $sha" }
    return $f
}

# Isolation for every installer below: npm, pip and the gnomon installer write only here.
$env:npm_config_cache = "$T\npm-cache"
$env:PIP_NO_CACHE_DIR = '1'

# opencode V2 2.2.5, native Windows x64
$z = Get-Verified 'https://github.com/anomalyco/opencode/releases/download/v2.2.5/opencode-windows-x64.zip' `
    'opencode-windows-x64.zip' '2f3bfd6b3527c60c2a882557b20ddc9ba6bdff4b5a8fe61c853da8fcfb3076e8'
Expand-Archive $z "$T\opencode-x" -Force
$exe = Get-ChildItem "$T\opencode-x" -Recurse -Filter opencode.exe | Select-Object -First 1
New-Item -ItemType Directory -Force "$T\opencode" | Out-Null
Copy-Item $exe.FullName "$T\opencode\opencode.exe" -Force
$rec.opencode = @{ zip_sha256 = '2f3bfd6b3527c60c2a882557b20ddc9ba6bdff4b5a8fe61c853da8fcfb3076e8'; exe_sha256 = (Get-FileHash "$T\opencode\opencode.exe").Hash.ToLower() }

# goose 1.57.0, native Windows x64 (msvc), the CLI
$z = Get-Verified 'https://github.com/aaif-goose/goose/releases/download/v1.57.0/goose-x86_64-pc-windows-msvc.zip' `
    'goose-x86_64-pc-windows-msvc.zip' '1ab2117ceec37f95be4d3ad0cdb921d3e97fd8b0fa244046631ecf4b7619d502'
Expand-Archive $z "$T\goose-x" -Force
$gx = Get-ChildItem "$T\goose-x" -Recurse -Filter goose.exe | Select-Object -First 1
New-Item -ItemType Directory -Force "$T\goose" | Out-Null
Get-ChildItem $gx.DirectoryName | Copy-Item -Destination "$T\goose" -Recurse -Force   # dlls beside the exe
$rec.goose = @{ zip_sha256 = '1ab2117ceec37f95be4d3ad0cdb921d3e97fd8b0fa244046631ecf4b7619d502'; exe_sha256 = (Get-FileHash "$T\goose\goose.exe").Hash.ToLower() }

# Qwen Code 0.26.4 from npm, into its own prefix
& npm install --prefix "$T\npm" --no-audit --no-fund '@qwen-code/qwen-code@0.26.4' | Out-Null
if ($LASTEXITCODE) { throw 'qwen install failed' }
$rec.qwen = @{ version = (Get-Content "$T\npm\node_modules\@qwen-code\qwen-code\package.json" | ConvertFrom-Json).version }

# mini-swe-agent 2.4.6 + litellm 1.105.7 (as on Linux) in a venv on Python 3.12 (Linux used 3.12.3)
& 'C:\AI\voice\python312\python.exe' -m venv "$T\mswea"
& "$T\mswea\Scripts\python.exe" -m pip install --quiet 'mini-swe-agent==2.4.6' 'litellm==1.105.7'
if ($LASTEXITCODE) { throw 'mini install failed' }
$rec.mini = @{ freeze = (& "$T\mswea\Scripts\python.exe" -m pip freeze) -join ';' }

# gnomon v0.3.3, by its official installer (pinned to the tag), into an isolated prefix;
# its native binaries go to the arm's own LOCALAPPDATA, not the user's.
$saved = @{ LOCALAPPDATA = $env:LOCALAPPDATA; APPDATA = $env:APPDATA }
$env:GNOMON_VERSION = '0.3.3'
$env:GNOMON_NPM_PREFIX = "$T\gnomon-rel"
$env:LOCALAPPDATA = "$T\gnomon-rel-local"; $env:APPDATA = "$T\gnomon-rel-roaming"
New-Item -ItemType Directory -Force $env:LOCALAPPDATA, $env:APPDATA | Out-Null
$inst = Join-Path $DL 'install-v0.3.3.ps1'
& curl.exe -fsSL -o $inst 'https://raw.githubusercontent.com/eljaplacido/gnomonharness/v0.3.3/scripts/install.ps1'
. $inst
$env:LOCALAPPDATA = $saved.LOCALAPPDATA; $env:APPDATA = $saved.APPDATA
Remove-Item Env:GNOMON_VERSION, Env:GNOMON_NPM_PREFIX
$rec.'gnomon-rel' = @{ installer_sha256 = (Get-FileHash $inst).Hash.ToLower(); version = (& node "$T\gnomon-rel\node_modules\gnomon-harness\bin\gnomon.mjs" --version) }

# gnomon master 891b559, packed on the gx10 as the release job packs, checked, installed alike
Push-Location "$DL\master"
foreach ($line in Get-Content SHA256SUMS) {
    $sha, $name = $line -split '\s+', 2
    if ((Get-FileHash $name).Hash.ToLower() -ne $sha) { throw "master tarball $name checksum mismatch" }
}
$tgz = Get-ChildItem *.tgz | ForEach-Object FullName
Pop-Location
& npm install -g --prefix "$T\gnomon-master" --no-audit --no-fund @tgz | Out-Null
if ($LASTEXITCODE) { throw 'gnomon-master install failed' }
$rec.'gnomon-master' = @{ version = (& node "$T\gnomon-master\node_modules\gnomon-harness\bin\gnomon.mjs" --version) }

$rec.host = @{
    os = (Get-CimInstance Win32_OperatingSystem | ForEach-Object { "$($_.Caption) $($_.Version)" })
    cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
    node = (& node --version); git = (& git --version)
    defender_realtime = -not (Get-MpPreference).DisableRealtimeMonitoring
    power_plan = (powercfg /getactivescheme)
}
$rec | ConvertTo-Json -Depth 4 | Set-Content "$R\setup-record.json"
'SETUP OK'

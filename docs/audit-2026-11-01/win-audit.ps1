$ErrorActionPreference = "Continue"
$root = "C:\dev\gnomon-audit"
New-Item -ItemType Directory -Force -Path $root | Out-Null
# Isolate everything the installer and gnomon write: npm prefix, native bin dir, credentials, home.
$env:GNOMON_NPM_PREFIX = "$root\npm"
$env:LOCALAPPDATA = "$root\localappdata"
$env:APPDATA = "$root\appdata"
$env:USERPROFILE = "$root\home"
$env:HOME = "$root\home"
$env:GNOMON_VERSION = "0.3.3"
$env:GNOMON_NO_UPDATE_CHECK = "1"
New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA,$env:APPDATA,$env:HOME | Out-Null
$log = "$root\install.log"
try {
  Invoke-RestMethod https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.ps1 | Invoke-Expression *> $log
  "CHECK install | ok"
} catch { "CHECK install | FAILED $_" }
Get-Content $log -Tail 3
$g = Get-ChildItem -Path "$root\npm" -Recurse -Filter "gnomon.cmd" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $g) { "CHECK locate | no gnomon.cmd under $root\npm"; exit 1 }
$gn = $g.FullName
"CHECK locate | $gn"
"CHECK version | " + (& $gn --version 2>&1)
$p = "$root\proj"
if (Test-Path $p) { Remove-Item -Recurse -Force $p }
New-Item -ItemType Directory -Force -Path $p | Out-Null
Set-Location $p
git init -q 2>&1 | Out-Null
git -c user.email=a@b -c user.name=a commit -q --allow-empty -m base 2>&1 | Out-Null
$o = & $gn init 2>&1; "CHECK init | rc=$LASTEXITCODE | " + (($o | Select-Object -First 1) -join " ")
$o = "/quit" | & $gn prompt 2>&1; $fatal = ($o | Select-String "✗").Count; "CHECK prompt_quit | rc=$LASTEXITCODE | fatal lines=$fatal"
$o = & $gn surface hash 2>&1; "CHECK surface_hash | rc=$LASTEXITCODE | $o"
$o = & $gn guard --role implement --tool bash --input '{"command":"git push --force origin main"}' 2>&1; "CHECK guard_force_push | rc=$LASTEXITCODE | " + ($o -join " ").Substring(0, [Math]::Min(120, ($o -join " ").Length))
"CHECK done"

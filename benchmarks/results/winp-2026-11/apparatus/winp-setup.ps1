$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force C:\dev\winp | Out-Null
Set-Location C:\dev\winp
"start $(Get-Date -Format o)" | Out-File -Encoding utf8 setup.log
if (-not (Test-Path repo)) { git clone -q https://github.com/eljaplacido/gnomonharness.git repo 2>&1 | Out-File -Append -Encoding utf8 setup.log }
Set-Location repo
git -c core.autocrlf=false fetch -q origin 2>&1 | Out-File -Append -Encoding utf8 ..\setup.log
git -c core.autocrlf=false checkout -q --detach 3a6a87b453648e4c1f9933436106ba891edbe190 2>&1 | Out-File -Append -Encoding utf8 ..\setup.log
"head $(git rev-parse HEAD)" | Out-File -Append -Encoding utf8 ..\setup.log
$env:npm_config_manage_package_manager_versions = "false"
& npx.cmd --cache C:\dev\winp\npm-cache -y pnpm@9.0.0 install --frozen-lockfile --store-dir C:\dev\winp\pnpm-store *> ..\pnpm-install.log
"install exit $LASTEXITCODE" | Out-File -Append -Encoding utf8 ..\setup.log
& npx.cmd --cache C:\dev\winp\npm-cache -y pnpm@9.0.0 -r run build *> ..\build.log
"build exit $LASTEXITCODE" | Out-File -Append -Encoding utf8 ..\setup.log
New-Item -ItemType Directory -Force C:\dev\winp\natives | Out-Null
Copy-Item C:\dev\ux1w\tools\gnomon-rel-local\gnomon\bin\*.exe C:\dev\winp\nativesGet-ChildItem C:\dev\winp\natives | ForEach-Object { "native $($_.Name) $((Get-FileHash $_.FullName).Hash)" } | Out-File -Append -Encoding utf8 ..\setup.log
"done $(Get-Date -Format o)" | Out-File -Append -Encoding utf8 ..\setup.log

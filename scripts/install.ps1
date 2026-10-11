# Install or update gnomon -- Windows, PowerShell 5.1 or newer.
#
#   irm https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.ps1 | iex
#
# Re-running it is how you update; `gnomon update` runs it for you.
#
# The same steps as scripts/install.sh, and the two must stay in step:
#   1. Checks for Node >= 20 and npm; never installs Node, prints how instead.
#   2. Resolves the release: the latest, or $env:GNOMON_VERSION = "0.2.3".
#   3. Installs the npm package -- from the registry when that version is
#      published there, otherwise from the release's own tarballs.
#   4. Puts this platform's native binaries in %LOCALAPPDATA%\gnomon\bin,
#      where gnomon looks for them with no environment variable set.
#   Every download is checked against the release's SHA256SUMS (or, for files
#   a release's SHA256SUMS predates, GitHub's recorded SHA-256 for the asset).
#   A mismatch, or a file with no digest at all, stops the install before
#   anything is installed.
#
# Environment: GNOMON_VERSION, GNOMON_NPM_PREFIX, GNOMON_NO_NATIVE=1,
# GITHUB_TOKEN -- as in install.sh.
#
# Everything is inside functions and errors are thrown, never `exit`: under
# `irm | iex` this runs in the reader's own session, and `exit` would close
# their PowerShell window. For the same reason $ErrorActionPreference is set
# inside the function, where it is scoped to it.
#
# ASCII only, comments included. `gnomon update` runs this with
# `powershell -File`, and Windows PowerShell 5.1 reads a BOM-less file as
# Windows-1252: an em dash's UTF-8 bytes end in 0x94, which it then sees as a
# closing curly quote -- and PowerShell accepts curly quotes as string
# delimiters, so one dash in a message can end a string early.

function Install-Gnomon {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'   # PS 5.1's progress bar slows Invoke-WebRequest ~10x
    # PS 5.1 on older Windows defaults to TLS 1.0, which GitHub refuses.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = if ($env:GNOMON_REPO) { $env:GNOMON_REPO } else { 'eljaplacido/gnomonharness' }
    $package = 'gnomon-harness'
    $libs = @('gnomon-core', 'gnomon-natives', 'gnomon-tui')
    $natives = @('gnomon-surface', 'gnomon-enums', 'gnomon-edit', 'gnomon-exec')

    # -- Node ----------------------------------------------------------------
    Write-Step 'Checking Node.js'
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Show-NodeHelp 'No `node` was found on PATH.' }
    $nodeVersion = First-Line (Invoke-Native node @('--version'))
    $major = 0
    [void][int]::TryParse(($nodeVersion -replace '^v', '').Split('.')[0], [ref]$major)
    if ($major -lt 20) { Show-NodeHelp "This machine has $nodeVersion." }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Show-NodeHelp 'Node is here but `npm` is not.' }
    Write-Host "  node $nodeVersion, npm $(First-Line (Invoke-Native (Get-Npm) @('--version')))"

    $work = Join-Path ([IO.Path]::GetTempPath()) ('gnomon-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        # -- release ---------------------------------------------------------
        Write-Step 'Resolving the release'
        $release = $null
        if ($env:GNOMON_VERSION -and $env:GNOMON_VERSION -ne 'latest') {
            $version = $env:GNOMON_VERSION -replace '^v', ''
            try { $release = Invoke-GitHubApi $repo "releases/tags/v$version" } catch { $release = $null }
        } else {
            try {
                $release = Invoke-GitHubApi $repo 'releases/latest'
                $version = $release.tag_name -replace '^v', ''
            } catch {
                throw "could not determine the latest release ($($_.Exception.Message)). Set `$env:GNOMON_VERSION = 'x.y.z' to pin one."
            }
        }
        if (-not $version) { throw 'could not determine the release version' }
        Write-Host "  gnomon $version"
        $base = "https://github.com/$repo/releases/download/v$version"
        $sums = @{}
        try {
            $text = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS").Content
            if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }
            foreach ($line in ($text -split "`r?`n")) {
                $parts = $line.Trim() -split '\s+', 2
                if ($parts.Count -eq 2) { $sums[$parts[1].TrimStart('*')] = $parts[0].ToLower() }
            }
        } catch { }
        $ctx = @{ Base = $base; Work = $work; Sums = $sums; Release = $release; Version = $version }

        # -- where npm installs ----------------------------------------------
        $prefix = if ($env:GNOMON_NPM_PREFIX) { $env:GNOMON_NPM_PREFIX } else { First-Line (Invoke-Native (Get-Npm) @('prefix', '-g')) }

        # -- the npm package -------------------------------------------------
        Write-Step "Installing $package $version into $prefix"
        Invoke-Native (Get-Npm) @('view', "$package@$version", 'version') | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host '  from the npm registry'
            Invoke-Npm @('install', '-g', '--prefix', $prefix, '--no-audit', '--no-fund', "$package@$version")
            # A tarball install left the libraries as separate globals; the
            # registry copy nests its own.
            foreach ($lib in $libs) {
                if (Test-Path (Join-Path $prefix "node_modules\$lib")) {
                    Invoke-Native (Get-Npm) @('rm', '-g', '--prefix', $prefix, $lib) | Out-Null
                }
            }
        } else {
            # Not on the registry, so its libraries cannot be resolved by name
            # either: all four tarballs go to npm in one command.
            Write-Host '  from the release tarballs (not on the npm registry)'
            $tgz = @()
            foreach ($p in ($libs + $package)) { $tgz += Save-Verified $ctx "$p-$version.tgz" }
            Invoke-Npm (@('install', '-g', '--prefix', $prefix, '--no-audit', '--no-fund') + $tgz)
        }

        # -- native binaries -------------------------------------------------
        $dataRoot = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { $env:LOCALAPPDATA }
        $binDir = Join-Path (Join-Path $dataRoot 'gnomon') 'bin'
        $note = $null
        if ($env:GNOMON_NO_NATIVE -eq '1') {
            $note = 'native binaries skipped (GNOMON_NO_NATIVE=1)'
        } else {
            Write-Step "Installing the native binaries into $binDir"
            # x64 only is published; Windows on ARM runs it under emulation.
            $archive = "gnomon-$version-windows-x64.tar.gz"
            Save-Verified $ctx $archive | Out-Null
            $unpack = Join-Path $work 'native'
            New-Item -ItemType Directory -Path $unpack, $binDir -Force | Out-Null
            # tar.exe has shipped with Windows since 10 1803; Expand-Archive
            # reads only .zip.
            Invoke-Native tar.exe @('-xzf', (Join-Path $work $archive), '-C', $unpack) | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "could not unpack $archive (tar.exe exit $LASTEXITCODE)" }
            $src = Join-Path $unpack "gnomon-$version-windows-x64"
            foreach ($b in $natives) {
                $exe = Join-Path $src "$b.exe"
                if (-not (Test-Path $exe)) { throw "$archive has no $b.exe" }
                Copy-Item $exe (Join-Path $binDir "$b.exe") -Force
            }
            $build = Join-Path $src 'GNOMON_BUILD'
            if (Test-Path $build) { Copy-Item $build (Join-Path $binDir 'GNOMON_BUILD') -Force }
            Set-Content -Path (Join-Path $binDir 'VERSION') -Value $version -Encoding ASCII
            Write-Host "  $($natives.Count) binaries, release $version"
            # Run each: placed is not the same as runnable (see install.sh).
            foreach ($b in $natives) {
                Invoke-Native (Join-Path $binDir "$b.exe") @('--help') | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    $note = "$b.exe does not run on this system; surface, enumerations, session, apply and simulate may fail (launch, prompt, task and init are unaffected)"
                    Write-Host "  WARNING: $note"
                    break
                }
            }
        }

        # -- done ------------------------------------------------------------
        Write-Step 'Done'
        $gnomon = Join-Path $prefix 'gnomon.cmd'
        if (-not (Test-Path $gnomon)) { throw "npm reported success but $gnomon does not exist" }
        $first = First-Line (Invoke-Native $gnomon @('--version'))
        Write-Host "  $first"
        if ($note) { Write-Host "  note: $note" }

        $onPath = ($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $prefix.TrimEnd('\') }
        if (-not $onPath) {
            Write-Host ''
            Write-Host "  $prefix is not on your PATH. Add it for your user, then open a new terminal:"
            Write-Host "    [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$prefix', 'User')"
        }
        Write-Host ''
        Write-Host 'Next:'
        Write-Host '  cd your-project; gnomon launch'
        Write-Host ''
        Write-Host 'Update later with `gnomon update` (or re-run this installer);'
        Write-Host '`gnomon uninstall` prints how to remove it.'
        Write-Host 'gnomon runs commands through Git for Windows'' bash: install it if you have not (winget install Git.Git).'
    } finally {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
}

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host "==> $text" -ForegroundColor Cyan
}

function Show-NodeHelp([string]$why) {
    Write-Host ''
    Write-Host "gnomon needs Node.js 20 or newer. $why"
    Write-Host 'Install it with ONE of these, then open a new terminal and re-run this installer:'
    Write-Host ''
    Write-Host '  winget install OpenJS.NodeJS.LTS'
    Write-Host '  # or download the LTS installer: https://nodejs.org/en/download'
    Write-Host ''
    throw 'Node.js >= 20 is required'
}

function Invoke-GitHubApi([string]$repo, [string]$path) {
    $headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'gnomon-install' }
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
    Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "https://api.github.com/repos/$repo/$path"
}

function Get-ExpectedDigest($ctx, [string]$name) {
    if ($ctx.Sums.ContainsKey($name)) { return $ctx.Sums[$name] }
    if ($ctx.Release) {
        $asset = $ctx.Release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
        if ($asset -and $asset.digest -and $asset.digest.StartsWith('sha256:')) { return $asset.digest.Substring(7).ToLower() }
    }
    return $null
}

function Save-Verified($ctx, [string]$name) {
    $dest = Join-Path $ctx.Work $name
    Invoke-WebRequest -UseBasicParsing -Uri "$($ctx.Base)/$name" -OutFile $dest
    $want = Get-ExpectedDigest $ctx $name
    if (-not $want) { throw "no published SHA-256 for $name in release v$($ctx.Version) -- refusing to install an unverifiable file" }
    $got = (Get-FileHash -Algorithm SHA256 -Path $dest).Hash.ToLower()
    if ($got -ne $want) {
        throw "SHA-256 MISMATCH for $name`n    expected $want`n    got      $got`n  The download is not the file the release published. Nothing was installed."
    }
    Write-Host "  verified $name"
    return $dest
}

# Native commands run with errors relaxed to Continue, here only. Under
# PowerShell 5.1 with 'Stop', a line a native program writes to stderr -- an
# npm deprecation warning, say -- becomes a terminating error, and the install
# dies on a warning while the exit code says success. $LASTEXITCODE decides;
# callers read it after this returns.
function Invoke-Native([string]$exe, [string[]]$argv) {
    $ErrorActionPreference = 'Continue'
    & $exe @argv 2>&1 | ForEach-Object { "$_" }
}

# npm.cmd by name: Node also installs npm.ps1, PowerShell prefers it, and under
# the default Restricted execution policy running it fails with "running
# scripts is disabled on this system" -- before npm has done anything.
function Get-Npm {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { return 'npm.cmd' }
    return 'npm'
}

function First-Line($lines) {
    $l = @($lines) | Where-Object { $_ -and "$_".Trim() } | Select-Object -First 1
    if ($l) { return "$l".Trim() }
    return ''
}

function Invoke-Npm([string[]]$npmArgs) {
    $log = Invoke-Native (Get-Npm) $npmArgs
    if ($LASTEXITCODE -ne 0) {
        $log | ForEach-Object { Write-Host $_ }
        throw "npm install failed (output above)"
    }
}

Install-Gnomon

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$logPath = Join-Path $PSScriptRoot 'build-windows.log'
try {
    if (Test-Path -LiteralPath $logPath) { Remove-Item -LiteralPath $logPath -Force }
    Start-Transcript -LiteralPath $logPath -Force | Out-Null
    Write-Host ''
    Write-Host '====================================================' -ForegroundColor Yellow
    Write-Host ' EZ Preview - Playback Priority Hotfix - Win x64' -ForegroundColor Yellow
    Write-Host ' This builds the source in this folder. No GitHub.' -ForegroundColor Yellow
    Write-Host '====================================================' -ForegroundColor Yellow

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js 24+ is required. Install the current Node.js LTS, reopen this folder, and run BUILD-WINDOWS.bat again.' }
    $nodeVersionText = (& node -p "process.versions.node" 2>$null | Select-Object -First 1).Trim()
    $nodeVersion = [version]$nodeVersionText
    if ($nodeVersion.Major -lt 24) { throw "Node.js 24+ is required. Detected $nodeVersionText. Install Node.js 24+ and run this script again." }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm was not found. Repair or reinstall Node.js 24+.' }

    Write-Host "Using Node.js $(& node --version) and npm $(& npm --version)" -ForegroundColor Cyan
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package.json'))) { throw 'package.json was not found. Extract the entire source ZIP and run this BAT from its source folder.' }

    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package-lock.json')) {
        Write-Host '[1/4] Installing the committed dependency lock...' -ForegroundColor Cyan
        & npm ci --no-audit --no-fund
    } else {
        Write-Host '[1/4] Resolving dependencies and creating package-lock.json...' -ForegroundColor Cyan
        & npm install --no-audit --no-fund
    }
    if ($LASTEXITCODE -ne 0) { throw "npm dependency installation failed with exit code $LASTEXITCODE" }

    $ffmpegPath = (& node -p "require('ffmpeg-static')" 2>$null | Select-Object -First 1).Trim()
    if (-not $ffmpegPath -or -not (Test-Path -LiteralPath $ffmpegPath)) { throw 'The ffmpeg-static executable could not be resolved after npm install.' }
    $env:EZ_PREVIEW_FFMPEG = $ffmpegPath

    Write-Host '[2/4] Checking release files...' -ForegroundColor Cyan
    & npm run release:preflight
    if ($LASTEXITCODE -ne 0) { throw "Release preflight failed with exit code $LASTEXITCODE" }

    Write-Host '[3/4] Running all native smoke tests...' -ForegroundColor Cyan
    & npm run test:native
    if ($LASTEXITCODE -ne 0) { throw "Native regression tests failed with exit code $LASTEXITCODE; see build-windows.log" }

    Write-Host '[4/4] Building the Windows x64 installer and portable EXE...' -ForegroundColor Cyan
    & npm run dist:win
    if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed with exit code $LASTEXITCODE" }

    $releasePath = Join-Path $PSScriptRoot 'release'
    $exeFiles = @(Get-ChildItem -LiteralPath $releasePath -Filter '*.exe' -Recurse -File -ErrorAction SilentlyContinue)
    if ($exeFiles.Count -eq 0) { throw 'Packaging reported success, but no EXE files were found in release/.' }

    $hashPath = Join-Path $releasePath 'SHA256SUMS.txt'
    $exeFiles | ForEach-Object {
        $hash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
        "{0}  {1}" -f $hash.Hash.ToLowerInvariant(), $_.Name
    } | Set-Content -LiteralPath $hashPath -Encoding utf8

    Write-Host ''
    Write-Host 'BUILD SUCCESS. EXE files:' -ForegroundColor Green
    $exeFiles | ForEach-Object { Write-Host (" - " + $_.FullName) -ForegroundColor Green }
    Write-Host 'The Windows installers are unsigned unless a signing identity was configured.' -ForegroundColor Yellow
    Start-Process explorer.exe -ArgumentList ('"' + $releasePath + '"')
} catch {
    Write-Host ''
    Write-Host ('BUILD FAILED: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'See build-windows.log and share the final error block when troubleshooting.' -ForegroundColor Yellow
    exit 1
} finally {
    try { Stop-Transcript | Out-Null } catch {}
}

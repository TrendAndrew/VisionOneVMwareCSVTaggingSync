<#
.SYNOPSIS
    Installs dependencies, builds, and runs VMwareTagging.

.DESCRIPTION
    One-step setup script for Windows. Installs npm packages, compiles
    TypeScript, copies the example .env if needed, then starts the sync
    in the requested mode.

.PARAMETER Mode
    How to run the sync:
      once       - Single sync cycle then exit (default)
      continuous - Run on a schedule (every 15 min by default)
      dryrun     - Single cycle, preview only (no changes applied)

.EXAMPLE
    .\Install-And-Run.ps1
    .\Install-And-Run.ps1 -Mode continuous
    .\Install-And-Run.ps1 -Mode dryrun
#>

param(
    [ValidateSet('once', 'continuous', 'dryrun')]
    [string]$Mode = 'once'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $ProjectRoot
try {
    # --- Prerequisites check ---
    Write-Host '--- Checking prerequisites ---' -ForegroundColor Cyan

    $nodeVersion = $null
    try { $nodeVersion = (node --version) } catch { }

    if (-not $nodeVersion) {
        Write-Host 'ERROR: Node.js is not installed or not in PATH.' -ForegroundColor Red
        Write-Host 'Download it from https://nodejs.org (v18 or later required).' -ForegroundColor Yellow
        exit 1
    }

    $major = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
    if ($major -lt 18) {
        Write-Host "ERROR: Node.js $nodeVersion is too old. v18+ is required." -ForegroundColor Red
        exit 1
    }
    Write-Host "Node.js $nodeVersion OK" -ForegroundColor Green

    # --- Install dependencies ---
    Write-Host "`n--- Installing dependencies ---" -ForegroundColor Cyan
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

    # --- Build ---
    Write-Host "`n--- Building TypeScript ---" -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

    # --- Ensure .env exists ---
    if (-not (Test-Path '.env')) {
        if (Test-Path '.env.example') {
            Copy-Item '.env.example' '.env'
            Write-Host "`nCopied .env.example -> .env" -ForegroundColor Yellow
            Write-Host 'IMPORTANT: Edit .env with your VMware and Vision One credentials before running.' -ForegroundColor Yellow
            Write-Host '  notepad .env' -ForegroundColor Yellow
            exit 0
        }
        else {
            Write-Host 'WARNING: No .env file found. Set environment variables manually or create one.' -ForegroundColor Yellow
        }
    }

    # --- Ensure data directory exists ---
    if (-not (Test-Path 'data')) {
        New-Item -ItemType Directory -Path 'data' | Out-Null
    }

    # --- Run ---
    Write-Host "`n--- Starting VMwareTagging ($Mode mode) ---" -ForegroundColor Cyan

    switch ($Mode) {
        'dryrun' {
            $env:DRY_RUN = 'true'
            node dist/index.js --once
        }
        'once' {
            node dist/index.js --once
        }
        'continuous' {
            Write-Host 'Running continuously. Press Ctrl+C to stop.' -ForegroundColor Yellow
            Write-Host "To reload config, run: .\scripts\Reload-Config.ps1`n" -ForegroundColor Yellow
            node dist/index.js
        }
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Host "`nSync completed with errors (exit code $LASTEXITCODE)." -ForegroundColor Yellow
        Write-Host 'Check data\unmatched-report.json for details.' -ForegroundColor Yellow
    }
    else {
        Write-Host "`nSync completed successfully." -ForegroundColor Green
    }
}
finally {
    Pop-Location
}

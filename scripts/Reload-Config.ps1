<#
.SYNOPSIS
    Reloads VMwareTagging configuration without restarting the service.

.DESCRIPTION
    On Linux, VMwareTagging supports SIGHUP for live config reload.
    Windows does not support SIGHUP, so this script restarts the Node.js
    process gracefully: it sends Ctrl+C to the running process, waits
    for it to shut down cleanly, then starts a new instance.

    Alternatively, if running as a Windows Service (via nssm or similar),
    this script can simply restart that service.

.PARAMETER ServiceName
    If running as a Windows Service, specify the service name to restart it.
    If omitted, finds and restarts the node.js process directly.

.EXAMPLE
    .\Reload-Config.ps1
    .\Reload-Config.ps1 -ServiceName VMwareTagging
#>

param(
    [string]$ServiceName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($ServiceName) {
    # --- Windows Service mode ---
    Write-Host "Restarting Windows Service '$ServiceName'..." -ForegroundColor Cyan

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Host "ERROR: Service '$ServiceName' not found." -ForegroundColor Red
        exit 1
    }

    Restart-Service -Name $ServiceName -Force
    Write-Host "Service '$ServiceName' restarted. Config reloaded." -ForegroundColor Green
}
else {
    # --- Direct process mode ---
    Write-Host 'Looking for running VMwareTagging process...' -ForegroundColor Cyan

    $procs = Get-Process -Name 'node' -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
                $cmdline -match 'vmwaretagging[\\/]dist[\\/]index\.js|dist[\\/]index\.js'
            }
            catch { $false }
        }

    if (-not $procs -or $procs.Count -eq 0) {
        Write-Host 'No running VMwareTagging process found.' -ForegroundColor Yellow
        Write-Host 'If running in another terminal, stop it with Ctrl+C and restart:' -ForegroundColor Yellow
        Write-Host '  .\scripts\Install-And-Run.ps1 -Mode continuous' -ForegroundColor Yellow
        exit 1
    }

    foreach ($proc in $procs) {
        Write-Host "Stopping process $($proc.Id)..." -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force
        Write-Host "Process $($proc.Id) stopped." -ForegroundColor Green
    }

    Write-Host "`nRestarting VMwareTagging..." -ForegroundColor Cyan

    $ProjectRoot = Split-Path -Parent $PSScriptRoot
    Push-Location $ProjectRoot
    try {
        Start-Process -NoNewWindow -FilePath 'node' -ArgumentList 'dist/index.js' -PassThru | Out-Null
        Write-Host 'VMwareTagging restarted with fresh config.' -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}

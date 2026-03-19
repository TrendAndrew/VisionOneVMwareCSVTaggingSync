<#
.SYNOPSIS
    Stops the running VMwareTagging process.

.DESCRIPTION
    Finds the VMwareTagging Node.js process and stops it gracefully.
    If running as a Windows Service, stops the service instead.

.PARAMETER ServiceName
    If running as a Windows Service, specify the service name.

.EXAMPLE
    .\Stop-Service.ps1
    .\Stop-Service.ps1 -ServiceName VMwareTagging
#>

param(
    [string]$ServiceName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($ServiceName) {
    # --- Windows Service mode ---
    Write-Host "Stopping Windows Service '$ServiceName'..." -ForegroundColor Cyan

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Host "ERROR: Service '$ServiceName' not found." -ForegroundColor Red
        exit 1
    }

    if ($svc.Status -eq 'Stopped') {
        Write-Host "Service '$ServiceName' is already stopped." -ForegroundColor Yellow
        exit 0
    }

    Stop-Service -Name $ServiceName -Force
    Write-Host "Service '$ServiceName' stopped." -ForegroundColor Green
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
        Write-Host 'No running VMwareTagging process found.' -ForegroundColor Green
        exit 0
    }

    foreach ($proc in $procs) {
        Write-Host "Stopping process $($proc.Id)..." -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force
        Write-Host "Process $($proc.Id) stopped." -ForegroundColor Green
    }

    Write-Host "`nAll VMwareTagging processes stopped." -ForegroundColor Green
}

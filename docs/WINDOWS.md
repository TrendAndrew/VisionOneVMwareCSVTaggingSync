# VMwareTagging - Windows Setup Guide

## What It Does

VMwareTagging is a one-way sync engine that replicates VMware vSphere VM tags to Trend Vision One custom asset tags. VMware is the source of truth -- tags you apply to VMs in vSphere are automatically created and assigned to matching endpoints in Vision One.

**How matching works:** VMs are matched to Vision One endpoints by hostname (with normalization) or IP address. No fuzzy matching or AI -- it is deterministic and auditable.

**What it syncs:**

- Reads tag categories and tag assignments from one or more vCenter servers
- Finds the corresponding endpoint in Vision One (by hostname or IP)
- Creates any missing custom tags in Vision One
- Assigns/removes tags so Vision One mirrors vSphere

**What it does NOT do:**

- Never writes back to VMware (one-way only)
- Never deletes endpoints or modifies endpoint properties
- Never removes tags unless explicitly configured (`removeOrphanedTags: true`)

## Prerequisites

- **Node.js 18 or later** -- download from [nodejs.org](https://nodejs.org)
- **VMware vCenter** credentials with read access to VMs and tags
- **Trend Vision One** API token with Endpoint Security and Attack Surface Risk Management permissions

Verify Node.js is installed:

```powershell
node --version   # Should print v18.x.x or later
```

## Quick Start

Open PowerShell and navigate to the vmwaretagging folder:

```powershell
cd path\to\vmwaretagging

# Install, build, and run (first-time setup)
.\scripts\Install-And-Run.ps1

# If this is the first run, it creates a .env file and asks you to edit it:
notepad .env
```

Fill in the `.env` file:

```ini
# VMware vCenter
VMWARE_HOST=vcenter.example.com
VMWARE_USERNAME=readonly-user@vsphere.local
VMWARE_PASSWORD=your-password
VMWARE_VERIFY_SSL=true

# Trend Vision One
VISIONONE_API_TOKEN=your-api-token
VISIONONE_REGION=us

# Optional
DRY_RUN=false
LOG_LEVEL=info
```

Then run again:

```powershell
# Preview changes without applying (recommended first run)
.\scripts\Install-And-Run.ps1 -Mode dryrun

# Run a single sync
.\scripts\Install-And-Run.ps1 -Mode once

# Run continuously (syncs every 15 minutes)
.\scripts\Install-And-Run.ps1 -Mode continuous
```

## PowerShell Scripts

All scripts are in the `scripts\` folder.

| Script | Purpose |
|--------|---------|
| `Install-And-Run.ps1` | Install dependencies, build, and run |
| `Reload-Config.ps1` | Restart the process to pick up config changes |
| `Stop-Service.ps1` | Stop the running sync process |

### Install-And-Run.ps1

```powershell
# Dry run (preview only, no changes)
.\scripts\Install-And-Run.ps1 -Mode dryrun

# Single sync then exit
.\scripts\Install-And-Run.ps1 -Mode once

# Continuous mode (every 15 min, Ctrl+C to stop)
.\scripts\Install-And-Run.ps1 -Mode continuous
```

### Reload-Config.ps1

On Linux, VMwareTagging supports SIGHUP for live config reload. Windows does not have SIGHUP, so this script gracefully restarts the process instead.

```powershell
# After editing .env or config/default.json:
.\scripts\Reload-Config.ps1

# If running as a Windows Service:
.\scripts\Reload-Config.ps1 -ServiceName VMwareTagging
```

### Stop-Service.ps1

```powershell
.\scripts\Stop-Service.ps1

# If running as a Windows Service:
.\scripts\Stop-Service.ps1 -ServiceName VMwareTagging
```

## Configuration

VMwareTagging reads configuration from two sources (env vars take precedence):

1. **`.env` file** in the project root (environment variables)
2. **`config\default.json`** (structured settings)

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VMWARE_HOST` | Yes | -- | vCenter hostname or IP |
| `VMWARE_USERNAME` | Yes | -- | vCenter read-only user |
| `VMWARE_PASSWORD` | Yes | -- | vCenter password |
| `VMWARE_VERIFY_SSL` | No | `true` | Verify vCenter SSL cert |
| `VISIONONE_API_TOKEN` | Yes | -- | Vision One API token |
| `VISIONONE_REGION` | Yes | -- | `us`, `eu`, `jp`, `sg`, `au`, `in`, or `mea` |
| `DRY_RUN` | No | `false` | Preview mode (no writes) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |

### config\default.json

For advanced settings (sync interval, matching strategy, tag naming, multi-vCenter):

```json
{
  "sync": {
    "intervalMinutes": 15,
    "removeOrphanedTags": false,
    "tagPrefix": "vmware:",
    "categorySeparator": "/"
  },
  "matching": {
    "strategy": "hostname-then-ip",
    "hostnameNormalization": "lowercase-no-domain"
  }
}
```

### Multi-vCenter Setup

To sync from multiple vCenter servers, use `config\default.json` (env vars only support a single host):

```json
{
  "vmware": [
    {
      "label": "DC1",
      "host": "vcenter-dc1.example.com",
      "username": "readonly@vsphere.local",
      "password": "password1"
    },
    {
      "label": "DC2",
      "host": "vcenter-dc2.example.com",
      "username": "readonly@vsphere.local",
      "password": "password2"
    }
  ],
  "visionone": {
    "apiToken": "your-token",
    "region": "us"
  }
}
```

### Admin Mapping Overrides

For VMs that cannot be matched automatically, add manual mappings in `config\mapping-overrides.json`:

```json
[
  {
    "vmName": "legacy-server-01",
    "endpointName": "LEGACYSRV01",
    "comment": "Hostname mismatch between vSphere and Vision One"
  }
]
```

## Running as a Windows Service

To run VMwareTagging as a background service that starts automatically:

### Option 1: NSSM (Non-Sucking Service Manager)

```powershell
# Download nssm from https://nssm.cc/download
nssm install VMwareTagging "C:\Program Files\nodejs\node.exe" "C:\path\to\vmwaretagging\dist\index.js"

# Configure working directory
nssm set VMwareTagging AppDirectory "C:\path\to\vmwaretagging"

# Configure environment
nssm set VMwareTagging AppEnvironmentExtra "NODE_ENV=production"

# Set to auto-start
nssm set VMwareTagging Start SERVICE_AUTO_START

# Start the service
nssm start VMwareTagging

# Check status
nssm status VMwareTagging

# View logs (stdout/stderr redirect)
nssm set VMwareTagging AppStdout "C:\path\to\vmwaretagging\data\service-stdout.log"
nssm set VMwareTagging AppStderr "C:\path\to\vmwaretagging\data\service-stderr.log"
```

### Option 2: Task Scheduler

For a lighter approach, use Windows Task Scheduler to run a single sync periodically:

```powershell
# Create a scheduled task that runs every 15 minutes
$action = New-ScheduledTaskAction `
    -Execute 'node.exe' `
    -Argument 'dist\index.js --once' `
    -WorkingDirectory 'C:\path\to\vmwaretagging'

$trigger = New-ScheduledTaskTrigger `
    -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

Register-ScheduledTask `
    -TaskName 'VMwareTagging' `
    -Action $action `
    -Trigger $trigger `
    -User 'SYSTEM' `
    -RunLevel Highest
```

## Troubleshooting

### Common Issues

**"Node.js is not installed or not in PATH"**
Install Node.js from [nodejs.org](https://nodejs.org). After installing, restart PowerShell.

**"VMWARE_HOST is required" or similar validation error**
Edit your `.env` file and ensure all required variables are set:
```powershell
notepad .env
```

**SSL certificate errors connecting to vCenter**
If your vCenter uses a self-signed certificate:
```ini
VMWARE_VERIFY_SSL=false
```

**No endpoints matched**
Run in dry-run mode and check the unmatched report:
```powershell
.\scripts\Install-And-Run.ps1 -Mode dryrun
Get-Content data\unmatched-report.json | ConvertFrom-Json | Format-Table
```

**Permission denied on data folder**
Ensure the `data\` directory exists and is writable:
```powershell
New-Item -ItemType Directory -Path data -Force
```

### Logs

In continuous mode, logs print to the console. To save to a file:

```powershell
node dist\index.js 2>&1 | Tee-Object -FilePath data\sync.log
```

To increase log verbosity:

```powershell
$env:LOG_LEVEL = 'debug'
node dist\index.js --once
```

## Comparison: Windows vs Linux vs Docker

| Feature | Windows (PowerShell) | Linux (systemd) | Docker |
|---------|---------------------|-----------------|--------|
| Install | `npm ci && npm run build` | Same | `docker pull` |
| Run | `node dist\index.js` | `systemctl start` | `docker run` |
| Config reload | Restart process | `SIGHUP` (zero downtime) | `docker kill --signal=HUP` |
| Background service | NSSM or Task Scheduler | systemd unit | `docker run -d` |
| Auto-restart | NSSM `AppRestartDelay` | systemd `Restart=on-failure` | `--restart unless-stopped` |
| Log management | File redirect or Event Log | journald | `docker logs` |

The only functional difference is config reload: Linux supports zero-downtime reload via SIGHUP, while Windows requires a brief restart. All sync logic, matching, and API interactions are identical across platforms.

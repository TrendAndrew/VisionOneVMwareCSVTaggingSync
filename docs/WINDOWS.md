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
- **One or more VMware vCenter** instances with credentials that have read access to VMs and tags
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
```

If this is the first run, the script creates a `.env` file and asks you to edit it. You have two configuration paths depending on your environment:

### Option A: Single vCenter (simple)

If you only have one vCenter, the `.env` file is all you need:

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

### Option B: Multiple vCenters (recommended for most environments)

For two or more vCenter instances, configure them in `config\default.json`. Each vCenter gets its own credentials and can have independent filters:

```powershell
notepad config\default.json
```

```json
{
  "vmware": [
    {
      "label": "Sydney-DC",
      "host": "vcenter-syd.example.com",
      "username": "readonly@vsphere.local",
      "password": "password-syd",
      "verifySsl": true,
      "categoryFilter": [],
      "vmFilter": { "powerStates": ["POWERED_ON"] }
    },
    {
      "label": "Melbourne-DC",
      "host": "vcenter-mel.example.com",
      "username": "readonly@vsphere.local",
      "password": "password-mel",
      "verifySsl": true
    },
    {
      "label": "Perth-DR",
      "host": "vcenter-per.example.com",
      "username": "readonly@vsphere.local",
      "password": "password-per",
      "verifySsl": false
    }
  ],
  "visionone": {
    "apiToken": "your-vision-one-token",
    "region": "au"
  }
}
```

You still need a `.env` file, but it only needs the Vision One settings (VMware config comes from the JSON):

```ini
VISIONONE_API_TOKEN=your-api-token
VISIONONE_REGION=au
LOG_LEVEL=info
```

> **How multi-vCenter works:** VMwareTagging queries all configured vCenters in parallel. If one vCenter is unreachable, the others still sync normally -- it does not block on a single failure. Each vCenter's label appears in logs and the unmatched report so you can tell which datacenter a VM came from.

### Run It

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

## Configuration Reference

VMwareTagging reads configuration from two sources. Environment variables (`.env`) take precedence over `config\default.json` for any overlapping settings.

| Source | Best for |
|--------|----------|
| `.env` file | Vision One credentials, log level, dry-run toggle, single vCenter |
| `config\default.json` | Multi-vCenter hosts, sync tuning, matching strategy, tag naming |

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VMWARE_HOST` | Single vCenter only | -- | vCenter hostname or IP |
| `VMWARE_USERNAME` | Single vCenter only | -- | vCenter read-only user |
| `VMWARE_PASSWORD` | Single vCenter only | -- | vCenter password |
| `VMWARE_VERIFY_SSL` | No | `true` | Verify vCenter SSL cert |
| `VISIONONE_API_TOKEN` | Yes | -- | Vision One API token |
| `VISIONONE_REGION` | Yes | -- | `us`, `eu`, `jp`, `sg`, `au`, `in`, or `mea` |
| `DRY_RUN` | No | `false` | Preview mode (no writes) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |

> **Note:** The `VMWARE_*` env vars configure a single vCenter only. For multiple vCenters, define the `vmware` array in `config\default.json` instead (see Quick Start Option B above). When a multi-host array is present in the JSON, the `VMWARE_*` env vars are ignored.

### config\default.json

Full example with multiple vCenters and all tunable settings:

```json
{
  "vmware": [
    {
      "label": "Primary-DC",
      "host": "vcenter-primary.example.com",
      "username": "svc-vmwaretagging@vsphere.local",
      "password": "secure-password-1",
      "verifySsl": true,
      "categoryFilter": [],
      "tagFilter": [],
      "vmFilter": {
        "powerStates": ["POWERED_ON"],
        "namePattern": null
      },
      "requestTimeoutMs": 30000
    },
    {
      "label": "Secondary-DC",
      "host": "vcenter-secondary.example.com",
      "username": "svc-vmwaretagging@vsphere.local",
      "password": "secure-password-2",
      "verifySsl": true
    }
  ],
  "visionone": {
    "apiToken": "your-vision-one-token",
    "region": "us",
    "endpointPageSize": 200,
    "requestTimeoutMs": 30000,
    "rateLimitDelayMs": 100
  },
  "sync": {
    "intervalMinutes": 15,
    "removeOrphanedTags": false,
    "tagPrefix": "vmware:",
    "categorySeparator": "/",
    "maxTagNameLength": 64,
    "batchSize": 50,
    "maxRetries": 3
  },
  "matching": {
    "strategy": "hostname-then-ip",
    "hostnameNormalization": "lowercase-no-domain",
    "ipMatchMode": "any",
    "allowMultipleMatches": false
  }
}
```

### Per-vCenter Options

Each vCenter entry in the `vmware` array supports:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `label` | No | Same as `host` | Friendly name shown in logs and reports |
| `host` | Yes | -- | vCenter hostname or IP |
| `username` | Yes | -- | Read-only vSphere user |
| `password` | Yes | -- | Password |
| `verifySsl` | No | `true` | Set `false` for self-signed certs |
| `categoryFilter` | No | `[]` (all) | Only sync tags from these categories |
| `tagFilter` | No | `[]` (all) | Only sync these specific tag names |
| `vmFilter.powerStates` | No | `["POWERED_ON"]` | Which VM power states to include |
| `vmFilter.namePattern` | No | `null` (all) | Regex to filter VM names |
| `requestTimeoutMs` | No | `30000` | API timeout per vCenter |

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
If a vCenter uses a self-signed certificate, set `verifySsl` to `false` for that host in `config\default.json`:
```json
{ "label": "Dev-DC", "host": "vcenter-dev.local", "verifySsl": false, ... }
```
Or for a single-vCenter `.env` setup:
```ini
VMWARE_VERIFY_SSL=false
```

**One vCenter is down, everything stops**
It shouldn't -- VMwareTagging queries all vCenters in parallel and continues even if one fails. Check the logs for connection errors with that vCenter's label. The other vCenters will sync normally.

**No endpoints matched**
Run in dry-run mode and check the unmatched report:
```powershell
.\scripts\Install-And-Run.ps1 -Mode dryrun
Get-Content data\unmatched-report.json | ConvertFrom-Json | Format-Table
```
The report shows each unmatched VM with its source vCenter label, so you can identify which datacenter has matching issues.

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

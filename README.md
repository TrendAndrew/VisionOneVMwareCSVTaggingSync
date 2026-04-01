# VMwareTagging

One-way synchronization of VMware vSphere tags to Trend Vision One custom asset tags.

VMware is the source of truth. Tags applied to VMs in vSphere are automatically replicated to matching devices in Vision One via the ASRM (Attack Surface Risk Management) API. Supports multiple vCenter hosts, admin mapping overrides, unmatched asset reporting, and live config reload via SIGHUP.

> **Running on Windows?** See [docs/WINDOWS.md](docs/WINDOWS.md) for PowerShell scripts, setup instructions, and Windows Service configuration.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │          SyncScheduler               │
                    │    (runs every N minutes, SIGHUP)     │
                    └──────────────┬──────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────────────┐
                    │         SyncOrchestrator              │
                    │                                       │
                    │  1. Fetch VMs + tags from all vCenters │
                    │  2. Fetch devices from Vision One ASRM │
                    │  3. Apply admin mapping overrides       │
                    │  4. Deterministic hostname/IP matching  │
                    │  5. Resolve VMware tags → V1 tag IDs   │
                    │  6. Compute tag diffs                   │
                    │  7. Batch-update device tags            │
                    │  8. Write unmatched report              │
                    │  9. Persist sync state                  │
                    └──────┬──────────────────┬────────────┘
                           │                  │
              ┌────────────▼──────┐  ┌───────▼─────────────┐
              │  VMware vSphere    │  │  Trend Vision One    │
              │  REST API          │  │  ASRM REST API       │
              │                    │  │                      │
              │  /api/vcenter/vm   │  │  /v3.0/asrm/         │
              │  /api/cis/tagging/ │  │   attackSurfaceDevices│
              │                    │  │   attackSurface       │
              │  Multi-vCenter:    │  │    CustomTags         │
              │  DC1, DC2, ...     │  │                      │
              └────────────────────┘  └──────────────────────┘
```

### Project Structure

```
src/
├── domain/                          # Pure business logic (no dependencies)
│   ├── model/                       # Data interfaces (VmwareVm, VisionOneDevice, etc.)
│   ├── port/                        # Gateway interfaces (hexagonal architecture)
│   └── service/                     # Matching, diffing, tag naming
├── application/                     # Orchestration
│   ├── SyncOrchestrator.ts          # Core sync workflow
│   ├── SyncScheduler.ts             # Interval timer + signal handling
│   └── DryRunDecorator.ts           # Logs writes without executing
├── infrastructure/                  # External integrations
│   ├── vmware/                      # vSphere REST client + multi-vCenter gateway
│   ├── visionone/                   # Vision One REST client + paginator
│   ├── config/                      # Zod schema, env provider, mapping overrides
│   ├── logging/                     # Winston logger + unmatched reporter
│   └── state/                       # JSON file sync state persistence
├── app.ts                           # Dependency wiring (bootstrap)
└── index.ts                         # Entry point
```

### Design Principles

- **Hexagonal architecture** -- domain logic has zero external dependencies
- **Deterministic matching** -- hostname normalization + IP fallback (no fuzzy/AI)
- **Admin control** -- mapping overrides, unmatched reports, configurable everything
- **Graceful degradation** -- if one vCenter is down, sync proceeds with the others
- **Idempotent** -- safe to re-run; sync state tracks what was already applied

## Quick Start

### Prerequisites

- Node.js 20+ (or Docker)
- Network access to your vCenter server(s)
- Network access to Trend Vision One API (`api.*.xdr.trendmicro.com`)
- A Vision One API key with **Dashboards & Reports > Reports > Configure and download + View** permissions

### 1. Clone and Install

```bash
git clone https://github.com/trendmicro/vmwaretagging.git
cd vmwaretagging
npm install
npm run build
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
VMWARE_HOST=vcenter.example.com
VMWARE_USERNAME=svc-tagsync@vsphere.local
VMWARE_PASSWORD=your-password
VMWARE_VERIFY_SSL=true

VISIONONE_API_TOKEN=your-vision-one-api-key
VISIONONE_REGION=us       # us | eu | jp | sg | au | in | mea

LOG_LEVEL=info
DRY_RUN=false
```

### 3. Dry Run (Recommended First Step)

```bash
DRY_RUN=true node dist/index.js --once
```

This will:
- Connect to VMware and Vision One
- Match VMs to devices
- Log what tags **would** be applied (without actually doing it)
- Write `data/unmatched-report.txt` listing unmatched VMs and devices

### 4. Review Unmatched Report

```bash
cat data/unmatched-report.txt
```

The report shows:
- Unmatched VMs with their hostname, IPs, and diagnostic reason
- Unmatched devices
- Suggested mapping override entries you can copy-paste

### 5. Add Manual Overrides (if needed)

Edit `config/mapping-overrides.json`:

```json
{
  "overrides": [
    {
      "vmId": "vm-123",
      "vmName": "web-prod-01",
      "deviceId": "a1b2c3d4-e5f6-...",
      "deviceName": "WEBPROD01",
      "comment": "Different naming convention in VMware vs Vision One"
    }
  ]
}
```

For multi-vCenter environments, use qualified VM IDs: `"vmId": "dc1-vcenter::vm-123"`

### 6. Run For Real

```bash
# Single sync
node dist/index.js --once

# Continuous mode (syncs every 15 minutes by default)
node dist/index.js
```

## Configuration Reference

Configuration is loaded from two sources. Environment variables always take precedence over the JSON config file.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VMWARE_HOST` | Yes* | -- | vCenter hostname (single-host mode only) |
| `VMWARE_USERNAME` | Yes* | -- | vCenter username |
| `VMWARE_PASSWORD` | Yes* | -- | vCenter password |
| `VMWARE_VERIFY_SSL` | No | `true` | Verify vCenter SSL certificate |
| `VMWARE_REQUEST_TIMEOUT_MS` | No | `30000` | vCenter API timeout (ms) |
| `VISIONONE_API_TOKEN` | Yes | -- | Vision One API key (Bearer token) |
| `VISIONONE_REGION` | Yes | -- | Vision One region: `us`, `eu`, `jp`, `sg`, `au`, `in`, `mea` |
| `VISIONONE_DEVICE_PAGE_SIZE` | No | `200` | Devices per API page |
| `VISIONONE_REQUEST_TIMEOUT_MS` | No | `30000` | Vision One API timeout (ms) |
| `VISIONONE_RATE_LIMIT_DELAY_MS` | No | `100` | Delay between API calls (ms) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `DRY_RUN` | No | `false` | Log changes without applying |
| `CONFIG_PATH` | No | `./config/default.json` | Path to JSON config file |

\* Not required when using multi-vCenter JSON config.

### JSON Config File (`config/default.json`)

```json
{
  "sync": {
    "intervalMinutes": 15,
    "batchSize": 50,
    "maxRetries": 3,
    "retryDelayMs": 2000,
    "removeOrphanedTags": false,
    "orphanRemovalAllowlistFile": null,
    "tagPrefix": "vmware:",
    "categorySeparator": "/",
    "maxTagNameLength": 64
  },
  "matching": {
    "strategy": "hostname-then-ip",
    "hostnameNormalization": "lowercase-no-domain",
    "ipMatchMode": "any",
    "allowMultipleMatches": false
  },
  "vmware": {
    "requestTimeoutMs": 30000,
    "categoryFilter": [],
    "tagFilter": [],
    "vmFilter": {
      "powerStates": ["POWERED_ON"],
      "namePattern": null
    }
  },
  "visionone": {
    "devicePageSize": 200,
    "requestTimeoutMs": 30000,
    "rateLimitDelayMs": 100
  },
  "state": {
    "filePath": "./data/sync-state.json",
    "backupOnWrite": true
  },
  "logLevel": "info",
  "dryRun": false
}
```

### Configuration Options Explained

#### Sync Settings

| Option | Default | Description |
|--------|---------|-------------|
| `intervalMinutes` | `15` | How often to run sync in continuous mode |
| `removeOrphanedTags` | `false` | Remove Vision One tags when removed from VMware (within managed scope) |
| `orphanRemovalAllowlistFile` | `null` | Path to JSON array of tag names eligible for removal |
| `tagPrefix` | `vmware:` | Prefix for created Vision One tags (also used as removal scope) |
| `categorySeparator` | `/` | Separator between category and tag name |
| `maxTagNameLength` | `64` | Max tag name length (truncated with hash if exceeded) |

**Tag matching example:** VMware category `Environment` with tag `Production` is matched to a Vision One custom tag with `key: "Environment"` and `value: "Production"`. Tags must be pre-created in the Vision One console.

#### Matching Settings

| Option | Default | Description |
|--------|---------|-------------|
| `strategy` | `hostname-then-ip` | How to match VMs to devices |
| `hostnameNormalization` | `lowercase-no-domain` | How to normalize hostnames for comparison |
| `ipMatchMode` | `any` | IP matching mode |
| `allowMultipleMatches` | `false` | Allow one VM to match multiple devices |

**Matching strategies:**

| Strategy | Behaviour |
|----------|-----------|
| `hostname-then-ip` | Try hostname first, then IP for unmatched VMs (recommended) |
| `hostname` | Hostname only |
| `ip` | IP address only |
| `compound` | Require both hostname AND IP to match (strictest) |

**Hostname normalization:**

| Mode | Example |
|------|---------|
| `lowercase-no-domain` | `WebServer01.corp.local` → `webserver01` |
| `lowercase` | `WebServer01.corp.local` → `webserver01.corp.local` |
| `exact` | No transformation |

#### Tag Removal

When `removeOrphanedTags` is `false` (default):
- Tags are only ever added, never removed. This is the safe default to prevent accidental mass-untagging.

When `removeOrphanedTags` is `true`:
- If a tag is removed from a VM in VMware, it will be removed from the matching Vision One device on the next sync cycle.
- **Only VMware-managed tags are removed.** By default, removal is scoped to tags matching the configured `tagPrefix` (e.g., `vmware:`). Tags assigned outside this tool are never touched.
- Because the Vision One API uses **full replacement** semantics (not add/remove), the tool preserves all non-managed tags when updating a device.

For even more control, use an **orphan removal allowlist** -- a JSON file listing the exact tag names eligible for removal. Tags not in the list are never removed, even if they match the prefix:

```json
{
  "sync": {
    "removeOrphanedTags": true,
    "orphanRemovalAllowlistFile": "./config/removal-allowlist.json"
  }
}
```

Where `config/removal-allowlist.json` is a flat JSON array of tag names:

```json
[
  "vmware:Environment/Production",
  "vmware:Environment/Staging",
  "vmware:Role/Web",
  "vmware:Role/Database",
  "vmware:Role/AppServer"
]
```

**Priority:** allowlist (if set) > prefix (if set) > remove all orphans.

| Scenario | Behaviour |
|----------|-----------|
| `removeOrphanedTags: false` | Never removes anything (default) |
| `removeOrphanedTags: true` (no allowlist) | Removes orphans matching `tagPrefix` only |
| `removeOrphanedTags: true` + allowlist file | Removes only orphans listed in the file |

## Multi-vCenter Support

For organisations with multiple vCenter servers, define them as an array in the JSON config file (env vars cannot represent multiple hosts).

Create or edit your config file (e.g., `config/default.json`):

```json
{
  "vmware": [
    {
      "label": "dc1-vcenter",
      "host": "vcenter-dc1.corp.local",
      "username": "svc-tagsync@vsphere.local",
      "password": "password-for-dc1",
      "verifySsl": true
    },
    {
      "label": "dc2-vcenter",
      "host": "vcenter-dc2.corp.local",
      "username": "svc-tagsync@vsphere.local",
      "password": "password-for-dc2",
      "verifySsl": true
    }
  ]
}
```

**Important notes for multi-vCenter:**
- Each vCenter is queried in parallel
- If one vCenter is unreachable, sync proceeds with the others
- VM IDs are qualified with the vCenter label (e.g., `dc1-vcenter::vm-123`) to avoid collisions
- Mapping overrides must use the qualified VM ID format
- The unmatched report shows which vCenter each VM belongs to
- A reference config is provided at `config/multi-vcenter.example.json`

**Security note:** When using multi-vCenter config, credentials are in the JSON file. Ensure this file has restrictive permissions (`chmod 600 config/default.json`) and is not committed to version control.

## Mapping Overrides

The mapping override file (`config/mapping-overrides.json`) lets administrators manually force VM-to-device mappings. Overrides take precedence over automatic matching.

```json
{
  "description": "Manual VM-to-Device mapping overrides",
  "overrides": [
    {
      "vmId": "vm-456",
      "vmName": "db-prod-03",
      "deviceId": "791986b4-0774-177a-01b4-73a0c6abb73b",
      "deviceName": "DBPROD03",
      "comment": "Hostname mismatch: VMware uses hyphens, V1 device registered without"
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `vmId` | Yes | VMware VM MoRef ID (e.g., `vm-123` or `dc1-vcenter::vm-123`) |
| `deviceId` | Yes | Vision One ASRM device ID (from `GET /v3.0/asrm/attackSurfaceDevices`) |
| `vmName` | No | Human-readable VM name (documentation only) |
| `deviceName` | No | Human-readable device name (documentation only) |
| `comment` | No | Admin note explaining the override |

### Live Reload

After editing `mapping-overrides.json` or `default.json`, reload without restarting:

```bash
# Systemd
sudo systemctl reload vmwaretagging

# Docker
docker kill --signal=HUP vmwaretagging

# Direct process
kill -HUP $(pgrep -f vmwaretagging)
```

## Deployment

### Option 1: Docker (Recommended)

#### Build

```bash
docker build -t vmwaretagging:latest .
```

#### Run

```bash
# Using docker-compose (recommended)
cp .env.example .env
# Edit .env with your credentials
docker compose up -d

# Or using docker run directly
docker run -d \
  --name vmwaretagging \
  --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/data:/app/data \
  vmwaretagging:latest
```

#### Single sync run

```bash
docker run --rm \
  --env-file .env \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/data:/app/data \
  vmwaretagging:latest \
  node dist/index.js --once
```

#### Reload config

```bash
docker kill --signal=HUP vmwaretagging
```

#### View logs

```bash
docker logs -f vmwaretagging
```

#### Using GHCR (pre-built images)

```bash
docker pull ghcr.io/trendmicro/vmwaretagging:latest

docker run -d \
  --name vmwaretagging \
  --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/data:/app/data \
  ghcr.io/trendmicro/vmwaretagging:latest
```

### Option 2: Systemd Service

For running directly on a Linux server without Docker.

#### Prerequisites

```bash
# Install Node.js 22 (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Or via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22
```

#### Install the application

```bash
# Create a dedicated service user
sudo useradd -r -m -d /opt/vmwaretagging -s /usr/sbin/nologin vmwaretagging

# Clone and build
sudo -u vmwaretagging bash -c '
  cd /opt/vmwaretagging
  git clone https://github.com/trendmicro/vmwaretagging.git app
  cd app
  npm ci --omit=dev
  npm run build
'

# Create data directory
sudo -u vmwaretagging mkdir -p /opt/vmwaretagging/app/data
```

#### Configure

```bash
# Create .env file with restricted permissions
sudo -u vmwaretagging cp /opt/vmwaretagging/app/.env.example /opt/vmwaretagging/app/.env
sudo chmod 600 /opt/vmwaretagging/app/.env
sudo -u vmwaretagging vi /opt/vmwaretagging/app/.env

# Edit the config file
sudo -u vmwaretagging vi /opt/vmwaretagging/app/config/default.json

# For multi-vCenter, ensure config file permissions are restrictive
sudo chmod 600 /opt/vmwaretagging/app/config/default.json
```

#### Create the systemd unit file

```bash
sudo tee /etc/systemd/system/vmwaretagging.service > /dev/null << 'EOF'
[Unit]
Description=VMwareTagging - VMware to Vision One Tag Sync
Documentation=https://github.com/trendmicro/vmwaretagging
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vmwaretagging
Group=vmwaretagging
WorkingDirectory=/opt/vmwaretagging/app
ExecStart=/usr/bin/node dist/index.js
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=30
StartLimitIntervalSec=300
StartLimitBurst=5

# Environment
EnvironmentFile=/opt/vmwaretagging/app/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/vmwaretagging/app/data
ReadOnlyPaths=/opt/vmwaretagging/app/config
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true

# Logging (stdout/stderr → journald)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vmwaretagging

[Install]
WantedBy=multi-user.target
EOF
```

#### Enable and start

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable on boot
sudo systemctl enable vmwaretagging

# Start the service
sudo systemctl start vmwaretagging

# Check status
sudo systemctl status vmwaretagging

# View logs
sudo journalctl -u vmwaretagging -f

# View logs since last start
sudo journalctl -u vmwaretagging --since "$(systemctl show vmwaretagging --property=ActiveEnterTimestamp --value)"
```

#### Manage the service

```bash
# Reload config without restart (sends SIGHUP)
sudo systemctl reload vmwaretagging

# Restart the service
sudo systemctl restart vmwaretagging

# Stop the service
sudo systemctl stop vmwaretagging

# View recent logs
sudo journalctl -u vmwaretagging -n 100

# View logs for a specific time range
sudo journalctl -u vmwaretagging --since "2024-01-15 09:00:00" --until "2024-01-15 10:00:00"

# Follow logs in real-time
sudo journalctl -u vmwaretagging -f
```

#### Run a one-off sync manually

```bash
sudo -u vmwaretagging bash -c 'cd /opt/vmwaretagging/app && source .env && node dist/index.js --once'
```

#### Update the application

```bash
sudo systemctl stop vmwaretagging

sudo -u vmwaretagging bash -c '
  cd /opt/vmwaretagging/app
  git pull
  npm ci --omit=dev
  npm run build
'

sudo systemctl start vmwaretagging
```

### Option 3: AWS ECS Fargate

For AWS environments with VPN/Direct Connect to vCenter.

```bash
# Build and push to ECR
aws ecr create-repository --repository-name vmwaretagging
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com

docker build -t <account>.dkr.ecr.<region>.amazonaws.com/vmwaretagging:latest .
docker push <account>.dkr.ecr.<region>.amazonaws.com/vmwaretagging:latest
```

Create an ECS task definition with:
- CPU: 256 (0.25 vCPU)
- Memory: 512 MB
- Environment variables from AWS Secrets Manager
- Mount EFS for `/app/data` (sync state persistence)
- VPC with connectivity to vCenter and Vision One API
- Desired count: 1 (single instance)

## Operational Workflow

### Initial Setup

```
1. Deploy with DRY_RUN=true
2. Run a single sync:  --once
3. Review data/unmatched-report.txt
4. Add overrides to config/mapping-overrides.json for mismatches
5. Reload config: kill -HUP or systemctl reload
6. Re-run with DRY_RUN=true to verify
7. Set DRY_RUN=false
8. Start continuous mode
```

### Ongoing Operations

| Task | Command |
|------|---------|
| View sync logs | `journalctl -u vmwaretagging -f` or `docker logs -f vmwaretagging` |
| Check unmatched assets | `cat data/unmatched-report.txt` |
| Add a mapping override | Edit `config/mapping-overrides.json`, then reload |
| Change sync interval | Edit `config/default.json`, then reload |
| Enable tag removal | Set `removeOrphanedTags: true` in config, then reload |
| Force immediate sync | Restart the service (it syncs on startup) |
| Troubleshoot | Set `LOG_LEVEL=debug`, restart |

## API Details

### VMware vSphere REST API

| Operation | Endpoint |
|-----------|----------|
| Authenticate | `POST /api/session` |
| List VMs | `GET /api/vcenter/vm` |
| VM details | `GET /api/vcenter/vm/{id}` |
| Guest networking | `GET /api/vcenter/vm/{id}/guest/networking/interfaces` |
| List categories | `GET /api/cis/tagging/category` |
| List tags | `GET /api/cis/tagging/tag` |
| Bulk tag associations | `POST /api/cis/tagging/tag-association?action=list-attached-tags-on-objects` |

### Trend Vision One ASRM REST API

| Operation | Method | Endpoint |
|-----------|--------|----------|
| List devices | `GET` | `/v3.0/asrm/attackSurfaceDevices` |
| List custom tags | `GET` | `/v3.0/asrm/attackSurfaceCustomTags` |
| Update device tags | `POST` | `/v3.0/asrm/attackSurfaceDevices/update` |

**API key permissions required:** Dashboards & Reports > Reports > Configure and download + View

#### Custom Tags (key-value pairs)

Custom tags in Vision One are key-value pairs. They must be **pre-created in the Vision One console** before this tool can assign them. There is currently no public API to create custom tags programmatically.

`GET /v3.0/asrm/attackSurfaceCustomTags` returns:

```json
{
  "items": [
    { "key": "Environment", "id": "qVQz+Y3HL1GQ56qTeSKhtFxYAIM=-01", "value": "Production" },
    { "key": "Environment", "id": "qVQz+Y3HL1GQ56qTeSKhtFxYAIM=-02", "value": "Staging" },
    { "key": "Role",        "id": "abc123...",                         "value": "Web" }
  ],
  "count": 3,
  "totalCount": 3
}
```

The tool matches VMware `category/tag` to Vision One `key/value`:
- VMware category `Environment` with tag `Production` → Vision One tag with `key: "Environment"`, `value: "Production"`

#### Updating Device Tags (full replacement)

`POST /v3.0/asrm/attackSurfaceDevices/update` uses **full replacement** semantics — the `assetCustomTagIds` array replaces all tags on the device. The tool preserves non-managed tags by reading current tags, merging desired changes, and writing the full set.

Request:
```json
[
  { "id": "791986b4-0774-177a-01b4-73a0c6abb73b", "assetCustomTagIds": ["tagId1", "tagId2"] }
]
```

Response (`207 Multi-Status`):
```json
[{ "status": 204 }]
```

**Limits:** Maximum 20 custom tags per device.

#### Matching Logic (VMware VM → Vision One Device)

Devices are matched by comparing VMware VM identifiers against Vision One ASRM device fields:

| Priority | VMware field | Vision One field | Match type |
|----------|-------------|-----------------|------------|
| 1 | `guestHostname` | `deviceName` | Primary — OS-reported hostname |
| 2 | `ipAddresses[]` | `ip[]` | Fallback — IP address overlap |
| 3 | `name` | `deviceName` | Fallback — VM display name (if no guestHostname) |

The matching strategy is configurable (see [Matching Settings](#matching-settings)).

### Vision One API Regions

| Region | API Base URL |
|--------|-------------|
| US (default) | `https://api.xdr.trendmicro.com` |
| Europe | `https://api.eu.xdr.trendmicro.com` |
| Japan | `https://api.xdr.trendmicro.co.jp` |
| Singapore | `https://api.sg.xdr.trendmicro.com` |
| Australia | `https://api.au.xdr.trendmicro.com` |
| India | `https://api.in.xdr.trendmicro.com` |
| Middle East/Africa | `https://api.mea.xdr.trendmicro.com` |

### Vision One MCP Server

Trend Micro provides an [official MCP server](https://github.com/trendmicro/vision-one-mcp-server) for Vision One. This project uses the REST API directly rather than the MCP server, as the MCP server currently only exposes read-only operations (`CREMListCustomTags`).

## Development

### Build and Test

```bash
npm install
npm run build      # Compile TypeScript
npm test           # Run tests (64 unit tests)
npm run dev        # Run with tsx (no build step)
```

### Project Dependencies

| Package | Purpose |
|---------|---------|
| `axios` | HTTP client for VMware and Vision One APIs |
| `dotenv` | Load .env files |
| `winston` | Structured logging |
| `zod` | Configuration schema validation |

### CI/CD

The project includes GitHub Actions workflows:

- **CI** (`.github/workflows/ci.yml`): Runs on every push and PR. Builds and tests on Node.js 20 and 22.
- **Release** (`.github/workflows/release.yml`): Triggered by version tags (`v*`). Builds multi-arch Docker images, pushes to GHCR, and creates a GitHub release.

#### Creating a Release

```bash
# Tag a release
git tag -a v1.0.0 -m "Initial release"
git push origin v1.0.0

# The release pipeline will:
# 1. Run tests
# 2. Build linux/amd64 and linux/arm64 Docker images
# 3. Push to ghcr.io/trendmicro/vmwaretagging:1.0.0
# 4. Create a GitHub release with auto-generated notes
```

## Security Considerations

- **Credentials**: Never commit `.env` files or config files containing passwords. Use `chmod 600` on sensitive files.
- **Network**: The application needs outbound HTTPS to Vision One API and your vCenter servers. It does not listen on any ports.
- **Permissions**: Run as a non-root user (dedicated service account or Docker non-root user).
- **VMware**: Use a dedicated read-only service account (`svc-tagsync@vsphere.local`) with minimal permissions (read VMs, read tags).
- **Vision One**: Create an API key with only Endpoint Security and CREM permissions. Set a reasonable expiration.
- **Systemd**: The unit file includes security hardening (`NoNewPrivileges`, `ProtectSystem=strict`, namespace restrictions).
- **Docker**: The image runs as a non-root user with `dumb-init` for proper signal handling.

## Troubleshooting

### VMs Not Matching

1. Check `data/unmatched-report.txt` for diagnostic reasons
2. Common causes:
   - VMware Tools not installed (no hostname/IP data)
   - Different naming conventions (e.g., `web-prod-01` vs `WEBPROD01`)
   - VM powered off (filtered by default)
3. Solutions:
   - Add a mapping override in `config/mapping-overrides.json`
   - Change `hostnameNormalization` to `lowercase` (keeps domain)
   - Change `strategy` to `ip` or `hostname-then-ip`

### Vision One API Errors

- **401 Unauthorized**: API token expired or invalid. Generate a new one in the Vision One console.
- **429 Too Many Requests**: Rate limited. Increase `rateLimitDelayMs` in config.
- **403 Forbidden**: API key lacks required permissions. Check Endpoint Security and CREM access.

### VMware Connection Issues

- **SSL errors**: Set `VMWARE_VERIFY_SSL=false` for self-signed certificates (not recommended for production).
- **401 Unauthorized**: Check username/password. Ensure the account has API access.
- **Timeout**: Increase `VMWARE_REQUEST_TIMEOUT_MS` for slow vCenter instances.

## License

MIT

# CSVTaggingAI

One-way synchronization of VMware vSphere tags to Trend Vision One custom asset tags.

VMware is the source of truth. Tags applied to VMs in vSphere are automatically replicated to matching endpoints in Vision One. Supports multiple vCenter hosts, admin mapping overrides, unmatched asset reporting, and live config reload via SIGHUP.

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
                    │  2. Fetch endpoints from Vision One    │
                    │  3. Apply admin mapping overrides       │
                    │  4. Deterministic hostname/IP matching  │
                    │  5. Compute tag diffs (add/remove)      │
                    │  6. Create missing tags in Vision One   │
                    │  7. Apply/remove tag assignments        │
                    │  8. Write unmatched report              │
                    │  9. Persist sync state                  │
                    └──────┬──────────────────┬────────────┘
                           │                  │
              ┌────────────▼──────┐  ┌───────▼─────────────┐
              │  VMware vSphere    │  │  Trend Vision One    │
              │  REST API          │  │  REST API            │
              │                    │  │                      │
              │  /api/vcenter/vm   │  │  /v3.0/endpointSec/  │
              │  /api/cis/tagging/ │  │    endpoints         │
              │                    │  │  /v3.0/asrm/         │
              │  Multi-vCenter:    │  │    attackSurface      │
              │  DC1, DC2, ...     │  │    CustomTags         │
              └────────────────────┘  └──────────────────────┘
```

### Project Structure

```
src/
├── domain/                          # Pure business logic (no dependencies)
│   ├── model/                       # Data interfaces (VmwareVm, VisionOneEndpoint, etc.)
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
- A Vision One API key with Endpoint Security and CREM permissions

### 1. Clone and Install

```bash
git clone https://github.com/trendmicro/csvtaggingai.git
cd csvtaggingai
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
- Match VMs to endpoints
- Log what tags **would** be created/applied (without actually doing it)
- Write `data/unmatched-report.txt` listing unmatched VMs and endpoints

### 4. Review Unmatched Report

```bash
cat data/unmatched-report.txt
```

The report shows:
- Unmatched VMs with their hostname, IPs, and diagnostic reason
- Unmatched endpoints
- Suggested mapping override entries you can copy-paste

### 5. Add Manual Overrides (if needed)

Edit `config/mapping-overrides.json`:

```json
{
  "overrides": [
    {
      "vmId": "vm-123",
      "vmName": "web-prod-01",
      "agentGuid": "a1b2c3d4-e5f6-...",
      "endpointName": "WEBPROD01",
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
| `VISIONONE_ENDPOINT_PAGE_SIZE` | No | `200` | Endpoints per page |
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
    "endpointPageSize": 200,
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
| `removeOrphanedTags` | `false` | Remove Vision One tags when removed from VMware |
| `tagPrefix` | `vmware:` | Prefix for created Vision One tags |
| `categorySeparator` | `/` | Separator between category and tag name |
| `maxTagNameLength` | `64` | Max tag name length (truncated with hash if exceeded) |

**Tag naming example:** VMware category `Environment` with tag `Production` becomes Vision One custom tag `vmware:Environment/Production`.

#### Matching Settings

| Option | Default | Description |
|--------|---------|-------------|
| `strategy` | `hostname-then-ip` | How to match VMs to endpoints |
| `hostnameNormalization` | `lowercase-no-domain` | How to normalize hostnames for comparison |
| `ipMatchMode` | `any` | IP matching mode |
| `allowMultipleMatches` | `false` | Allow one VM to match multiple endpoints |

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

When `removeOrphanedTags` is `true`:
- If a tag is removed from a VM in VMware, it will be removed from the matching Vision One endpoint on the next sync cycle.
- The sync state tracks which tags were applied, so removals are detected by comparing the current VMware tags against the last-synced set.

When `false` (default):
- Tags are only ever added, never removed. This is the safe default to prevent accidental mass-untagging.

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

The mapping override file (`config/mapping-overrides.json`) lets administrators manually force VM-to-endpoint mappings. Overrides take precedence over automatic matching.

```json
{
  "description": "Manual VM-to-Endpoint mapping overrides",
  "overrides": [
    {
      "vmId": "vm-456",
      "vmName": "db-prod-03",
      "agentGuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "endpointName": "DBPROD03",
      "comment": "Hostname mismatch: VMware uses hyphens, V1 agent registered without"
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `vmId` | Yes | VMware VM MoRef ID (e.g., `vm-123` or `dc1-vcenter::vm-123`) |
| `agentGuid` | Yes | Vision One endpoint agent GUID |
| `vmName` | No | Human-readable VM name (documentation only) |
| `endpointName` | No | Human-readable endpoint name (documentation only) |
| `comment` | No | Admin note explaining the override |

### Live Reload

After editing `mapping-overrides.json` or `default.json`, reload without restarting:

```bash
# Systemd
sudo systemctl reload csvtaggingai

# Docker
docker kill --signal=HUP csvtaggingai

# Direct process
kill -HUP $(pgrep -f csvtaggingai)
```

## Deployment

### Option 1: Docker (Recommended)

#### Build

```bash
docker build -t csvtaggingai:latest .
```

#### Run

```bash
# Using docker-compose (recommended)
cp .env.example .env
# Edit .env with your credentials
docker compose up -d

# Or using docker run directly
docker run -d \
  --name csvtaggingai \
  --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/data:/app/data \
  csvtaggingai:latest
```

#### Single sync run

```bash
docker run --rm \
  --env-file .env \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/data:/app/data \
  csvtaggingai:latest \
  node dist/index.js --once
```

#### Reload config

```bash
docker kill --signal=HUP csvtaggingai
```

#### View logs

```bash
docker logs -f csvtaggingai
```

#### Using GHCR (pre-built images)

```bash
docker pull ghcr.io/trendmicro/csvtaggingai:latest

docker run -d \
  --name csvtaggingai \
  --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/data:/app/data \
  ghcr.io/trendmicro/csvtaggingai:latest
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
sudo useradd -r -m -d /opt/csvtaggingai -s /usr/sbin/nologin csvtaggingai

# Clone and build
sudo -u csvtaggingai bash -c '
  cd /opt/csvtaggingai
  git clone https://github.com/trendmicro/csvtaggingai.git app
  cd app
  npm ci --omit=dev
  npm run build
'

# Create data directory
sudo -u csvtaggingai mkdir -p /opt/csvtaggingai/app/data
```

#### Configure

```bash
# Create .env file with restricted permissions
sudo -u csvtaggingai cp /opt/csvtaggingai/app/.env.example /opt/csvtaggingai/app/.env
sudo chmod 600 /opt/csvtaggingai/app/.env
sudo -u csvtaggingai vi /opt/csvtaggingai/app/.env

# Edit the config file
sudo -u csvtaggingai vi /opt/csvtaggingai/app/config/default.json

# For multi-vCenter, ensure config file permissions are restrictive
sudo chmod 600 /opt/csvtaggingai/app/config/default.json
```

#### Create the systemd unit file

```bash
sudo tee /etc/systemd/system/csvtaggingai.service > /dev/null << 'EOF'
[Unit]
Description=CSVTaggingAI - VMware to Vision One Tag Sync
Documentation=https://github.com/trendmicro/csvtaggingai
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=csvtaggingai
Group=csvtaggingai
WorkingDirectory=/opt/csvtaggingai/app
ExecStart=/usr/bin/node dist/index.js
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=30
StartLimitIntervalSec=300
StartLimitBurst=5

# Environment
EnvironmentFile=/opt/csvtaggingai/app/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/csvtaggingai/app/data
ReadOnlyPaths=/opt/csvtaggingai/app/config
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
SyslogIdentifier=csvtaggingai

[Install]
WantedBy=multi-user.target
EOF
```

#### Enable and start

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable on boot
sudo systemctl enable csvtaggingai

# Start the service
sudo systemctl start csvtaggingai

# Check status
sudo systemctl status csvtaggingai

# View logs
sudo journalctl -u csvtaggingai -f

# View logs since last start
sudo journalctl -u csvtaggingai --since "$(systemctl show csvtaggingai --property=ActiveEnterTimestamp --value)"
```

#### Manage the service

```bash
# Reload config without restart (sends SIGHUP)
sudo systemctl reload csvtaggingai

# Restart the service
sudo systemctl restart csvtaggingai

# Stop the service
sudo systemctl stop csvtaggingai

# View recent logs
sudo journalctl -u csvtaggingai -n 100

# View logs for a specific time range
sudo journalctl -u csvtaggingai --since "2024-01-15 09:00:00" --until "2024-01-15 10:00:00"

# Follow logs in real-time
sudo journalctl -u csvtaggingai -f
```

#### Run a one-off sync manually

```bash
sudo -u csvtaggingai bash -c 'cd /opt/csvtaggingai/app && source .env && node dist/index.js --once'
```

#### Update the application

```bash
sudo systemctl stop csvtaggingai

sudo -u csvtaggingai bash -c '
  cd /opt/csvtaggingai/app
  git pull
  npm ci --omit=dev
  npm run build
'

sudo systemctl start csvtaggingai
```

### Option 3: AWS ECS Fargate

For AWS environments with VPN/Direct Connect to vCenter.

```bash
# Build and push to ECR
aws ecr create-repository --repository-name csvtaggingai
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com

docker build -t <account>.dkr.ecr.<region>.amazonaws.com/csvtaggingai:latest .
docker push <account>.dkr.ecr.<region>.amazonaws.com/csvtaggingai:latest
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
| View sync logs | `journalctl -u csvtaggingai -f` or `docker logs -f csvtaggingai` |
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

### Trend Vision One REST API

| Operation | Endpoint |
|-----------|----------|
| List endpoints | `GET /v3.0/endpointSecurity/endpoints` |
| List custom tags | `GET /v3.0/asrm/attackSurfaceCustomTags` |
| Create custom tag | `POST /v3.0/asrm/attackSurfaceCustomTags` |
| Apply tag to endpoint | `POST /v3.0/asrm/attackSurfaceCustomTags/{tagId}/endpoints` |
| Remove tag from endpoint | `DELETE /v3.0/asrm/attackSurfaceCustomTags/{tagId}/endpoints/{agentGuid}` |

**Note:** Tag write endpoints (create, apply, remove) are implemented based on API patterns but should be verified against the Vision One Automation Center documentation, which requires console login to access.

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

Trend Micro provides an [official MCP server](https://github.com/trendmicro/vision-one-mcp-server) for Vision One. This project uses the REST API directly rather than the MCP server, as the MCP server currently only exposes read-only tag operations.

## Development

### Build and Test

```bash
npm install
npm run build      # Compile TypeScript
npm test           # Run tests (61 unit tests)
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
# 3. Push to ghcr.io/trendmicro/csvtaggingai:1.0.0
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

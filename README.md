# BuildQ

Self-hosted distributed build queue for Expo/EAS local builds.

BuildQ lets you submit `eas build --local` jobs from any machine and have them executed by dedicated runner machines. Jobs are queued, claimed by runners, and streamed back in real time via SSE.

## Installation

### CLI

Install the BuildQ CLI globally via npm:

```bash
npm install -g @prpldev/buildq
```

### Server (Docker)

Pull and run the server from Docker Hub:

```bash
docker pull prpldev/buildq

docker run -d \
  --name buildq \
  -e BUILDQ_TOKEN="$(openssl rand -hex 32)" \
  -p 3000:3000 \
  -v buildq-data:/data \
  prpldev/buildq
```

## Monorepo Layout

| Package | Description |
|---------|-------------|
| `@buildq/shared` | Shared types and constants |
| `@buildq/server` | Hono-based API server |
| `@prpldev/buildq` | CLI client (`buildq`) — published to npm |

## Prerequisites

- Node.js >= 20
- pnpm 9.x (`corepack enable`)
- `eas-cli` installed on runner machines (`npm install -g eas-cli`)

## Getting Started

```bash
pnpm install && pnpm build
```

Generate an auth token:

```bash
openssl rand -hex 32
```

Start the server:

```bash
BUILDQ_TOKEN=<token> pnpm -F @buildq/server dev
```

Or run all packages in dev mode:

```bash
pnpm dev
```

### Install the CLI Locally for Development

After building, link the CLI globally:

```bash
cd packages/cli && pnpm link --global
buildq --version
```

Unlink when done:

```bash
pnpm rm --global @prpldev/buildq
```

Or run it directly without linking:

```bash
node packages/cli/dist/bin.js --help
```

During development, use `tsx` to skip the build step:

```bash
pnpm -F @buildq/cli dev -- status
```

## CLI Usage

### Configure

```bash
buildq init
```

This prompts for server URL and token, saves them to `~/.config/buildq/config.json`, and verifies the connection. Use `--project` to also write the server URL to `.buildqconfig.json` in the current directory.

### Commands

| Command | Description |
|---------|-------------|
| `buildq build -p <ios\|android>` | Submit a build job. Packs the project, uploads it, and streams build output. |
| `buildq runner -p <ios\|android>` | Start a runner that claims and executes queued jobs. |
| `buildq status` | Show queue status, active runners, and recent jobs. |
| `buildq cancel [jobId]` | Cancel a job. Use `--latest` to cancel the most recent active job. |

### Build Options

```
-p, --platform <platform>   ios or android (required)
-P, --profile <name>        EAS build profile (default: "development")
-f, --flag <flag...>        Extra flags passed to eas build
--no-download               Skip downloading the artifact after build
```

### Runner Options

```
-p, --platform <platforms>   Comma-separated: ios, android, or ios,android (required)
-i, --install                Auto-install artifact on device after build
-w, --work-dir <path>        Working directory for builds (default: ~/.buildq/builds)
```

### Config Precedence

Resolution order (highest priority first):

1. CLI flags (`--server`, `--token`)
2. Environment variables (`BUILDQ_SERVER`, `BUILDQ_TOKEN`)
3. Project config (`.buildqconfig.json` — walked up from cwd, no token for security)
4. User config (`~/.config/buildq/config.json`)

## Environment Variables

### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `BUILDQ_TOKEN` | Auth token (required) | — |
| `PORT` | Server listen port | `3000` |
| `STORAGE_DIR` | Directory for tarballs and artifacts | `/data` |
| `CLEANUP_TTL_MS` | Time before completed jobs are cleaned up | `86400000` (24h) |

### Client

| Variable | Description |
|----------|-------------|
| `BUILDQ_TOKEN` | Auth token |
| `BUILDQ_SERVER` | Server URL |

## Docker

The server image is published to Docker Hub as `prpldev/buildq`. You can pull and run it directly:

```bash
docker pull prpldev/buildq

docker run -d \
  --name buildq \
  -e BUILDQ_TOKEN="$(openssl rand -hex 32)" \
  -p 3000:3000 \
  -v buildq-data:/data \
  prpldev/buildq
```

Or build the image locally from source:

```bash
docker build -t buildq .
```

The Dockerfile uses a multi-stage build — dependencies are installed and compiled in a builder stage, then only production deps and compiled JS are copied into the final image. The container runs as a non-root `buildq` user and includes a health check on `/health`.

## Deploy to Coolify

### Option A: Dockerfile from Git Repo

1. Create a new service in Coolify, select **Dockerfile** build type
2. Point it at your Git repo
3. Set build context to `.` and Dockerfile path to `./Dockerfile`

### Option B: Docker Image

Select **Docker Image** in Coolify and use `prpldev/buildq` as the image name.

### Environment Variables

Set these in Coolify's environment variable section:

| Variable | Value | Secret |
|----------|-------|--------|
| `BUILDQ_TOKEN` | `openssl rand -hex 32` | Yes |
| `PORT` | `3000` | No |
| `STORAGE_DIR` | `/data` | No |
| `CLEANUP_TTL_MS` | `86400000` | No |

### Persistent Storage

Add a volume mount in Coolify:

- **Container path:** `/data`
- This persists tarballs and artifacts across container restarts

### Domain & SSL

- Assign your subdomain (e.g. `buildq.yourdomain.com`)
- Enable HTTPS (Let's Encrypt via Coolify)

### SSE Proxy Note

SSE requires the reverse proxy to **not buffer responses**. The server sets `X-Accel-Buffering: no`, which handles nginx. For Traefik (Coolify default), add this custom label in advanced settings:

```
traefik.http.middlewares.buildq-buffering.buffering.maxResponseBodyBytes=0
```

### Post-Deployment Verification

```bash
# Health check
curl https://buildq.yourdomain.com/health
# {"status":"ok","uptime":...}

# Auth check (should 401)
curl https://buildq.yourdomain.com/api/jobs
# {"error":"Unauthorized"}

# Auth check (should 200)
curl -H "Authorization: Bearer <token>" https://buildq.yourdomain.com/api/jobs
# {"jobs":[],"stats":{...}}
```

### Client Setup

On each machine (submitter + runner):

```bash
buildq init
# Enter: https://buildq.yourdomain.com
# Enter: <your-token>

buildq status
```

## Project Structure

```
buildq/
├── Dockerfile
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── packages/
│   ├── shared/
│   │   └── src/            # Shared types & constants
│   ├── server/
│   │   └── src/
│   │       ├── index.ts    # Server entry point
│   │       ├── lib/        # Auth, storage, SSE, cleanup, queue
│   │       └── routes/     # /api/jobs, /api/runners
│   └── cli/
│       └── src/
│           ├── bin.ts      # CLI entry point
│           ├── commands/   # init, build, runner, status, cancel
│           └── lib/        # Config, API client, SSE client, packing
└── buildq-specs/           # Design specs
```

# ctx Registry API

[![CI](https://github.com/ctx-hq/registry/actions/workflows/ci.yml/badge.svg)](https://github.com/ctx-hq/registry/actions/workflows/ci.yml)
[![Deploy](https://github.com/ctx-hq/registry/actions/workflows/deploy.yml/badge.svg)](https://github.com/ctx-hq/registry/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev)

[中文文档](README.zh-CN.md)

The backend API for [getctx.org](https://getctx.org) — an open registry for discovering, publishing, and installing Claude Code skills, MCP servers, and CLI tools.

```
ctx install @anthropic/claude-skill    # that's it
```

Built with [Hono](https://hono.dev) on Cloudflare Workers. Zero cold start, globally distributed.

## Why ctx?

AI coding agents (Claude Code, Cursor, Windsurf, etc.) need a shared way to discover and install tools. ctx provides:

- A **package registry** for skills, MCP servers, and CLI tools
- **One-command install** that auto-configures any supported agent
- **Hybrid search** (FTS + vector embeddings) to find the right tool
- An **open protocol** — `GET /:fullName.ctx` returns plain-text instructions any agent can parse

## Quick Start

```bash
# Clone and install
git clone https://github.com/ctx-hq/registry.git && cd registry
pnpm install

# Set up Cloudflare resources
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml — fill in your D1 database_id

# Create local database and start dev server
pnpm db:migrate
pnpm dev
```

## Contributing

### Prerequisites

- Node.js 22+, pnpm 10+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`pnpm add -g wrangler`)
- A Cloudflare account (free plan works)

### Setup

1. **Copy config template:**
   ```bash
   cp wrangler.toml.example wrangler.toml
   ```

2. **Create Cloudflare resources** (first time only):
   ```bash
   wrangler d1 create ctx-registry       # Copy the database_id into wrangler.toml
   wrangler r2 bucket create ctx-formulas
   ```

3. **Set secrets** (for GitHub OAuth):
   ```bash
   wrangler secret put GITHUB_CLIENT_SECRET
   ```

4. **Apply migrations and run:**
   ```bash
   pnpm db:migrate
   pnpm dev
   ```

### Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Local dev server (port 8787) |
| `pnpm test` | Run test suite (Vitest) |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm db:migrate` | Apply D1 migrations locally |
| `pnpm deploy` | Deploy to Cloudflare Workers |

### CI/CD

Pushes to `main` trigger automatic deployment via GitHub Actions. Required secrets:

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | Wrangler deploy authentication |
| `D1_DATABASE_ID` | D1 database identifier |

## API Reference

### Packages

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/packages` | — | List packages (filter: `type`, `category`; sort: `downloads`, `created`) |
| GET | `/v1/packages/:fullName` | — | Package details with version history and categories |
| GET | `/v1/packages/:fullName/versions` | — | List all versions |
| GET | `/v1/packages/:fullName/versions/:version` | — | Version detail (manifest, readme, publisher username) |

### Search & Resolution

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/search?q=&mode=` | — | Search packages (mode: `fts`, `vector`, `hybrid`) |
| POST | `/v1/resolve` | — | Bulk version constraint resolution |
| GET | `/v1/packages/:fullName/resolve/:constraint` | — | Resolve single version constraint |
| GET | `/:fullName.ctx` | — | Agent-readable install instructions (plain text) |
| GET | `/v1/categories` | — | List all categories with package counts |

### Publishing

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/publish` | Bearer | Publish a version (multipart: manifest + archive) |
| POST | `/v1/yank/:fullName/:version` | Bearer | Yank a version |
| GET | `/v1/download/:fullName/:version` | — | Download formula archive |

### Authentication & Account

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/auth/device` | — | Start device authorization flow |
| POST | `/v1/auth/token` | — | Poll for access token |
| POST | `/v1/auth/github` | — | Exchange GitHub OAuth code for token |
| GET | `/v1/me` | Bearer | Current user profile |
| GET | `/v1/me/tokens` | Bearer | List API tokens (never exposes token values) |
| POST | `/v1/me/tokens` | Bearer | Create a named token (optional: `expires_in_days`) |
| DELETE | `/v1/me/tokens/:id` | Bearer | Revoke a token |
| DELETE | `/v1/me` | Bearer | Delete account (anonymize PII, reassign packages) |

### Organizations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/orgs` | Bearer | Create organization |
| GET | `/v1/orgs/:name` | — | Org details |
| GET | `/v1/orgs/:name/members` | Bearer | List members (members only) |
| POST | `/v1/orgs/:name/members` | Bearer | Add member (owner/admin only) |
| DELETE | `/v1/orgs/:name/members/:username` | Bearer | Remove member (owner only) |

### Scanner (admin)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/scanner/sources` | Bearer | List scanner sources |
| GET | `/v1/scanner/candidates` | Bearer | List discovered candidates |
| GET | `/v1/scanner/candidates/:id` | Bearer | Candidate detail |
| POST | `/v1/scanner/run` | Admin | Trigger manual scan |
| POST | `/v1/scanner/candidates/:id/approve` | Admin | Approve and import |
| POST | `/v1/scanner/candidates/:id/reject` | Admin | Reject candidate |
| GET | `/v1/scanner/stats` | Bearer | Scanner statistics |

## Architecture

```
src/
├── index.ts                # Entry point, middleware, error handling, cron
├── bindings.ts             # Cloudflare binding type definitions
├── models/types.ts         # Shared TypeScript interfaces
├── routes/                 # HTTP handlers
│   ├── auth.ts             # OAuth, tokens, account deletion
│   ├── packages.ts         # Package CRUD
│   ├── search.ts           # FTS + vector hybrid search
│   ├── publish.ts          # Package publishing
│   ├── resolve.ts          # Bulk version resolution
│   ├── versions.ts         # Single version resolution
│   ├── download.ts         # Archive downloads
│   ├── orgs.ts             # Organization management
│   ├── scanner.ts          # Package discovery pipeline
│   ├── agent.ts            # /:fullName.ctx agent endpoint
│   ├── categories.ts       # Category listing
│   └── health.ts           # Health check
├── services/               # Business logic
│   ├── scanner.ts          # GitHub topic scanner
│   ├── importer.ts         # Candidate → package import
│   ├── enrichment.ts       # LLM-powered metadata enrichment
│   ├── search.ts           # Hybrid search engine
│   ├── categories.ts       # Category seeding and queries
│   └── publish.ts          # Publish validation
├── middleware/
│   ├── auth.ts             # Bearer token authentication
│   ├── security-headers.ts # Security headers + CORS
│   └── rate-limit.ts       # Per-user / per-IP rate limiting
└── utils/                  # Naming, semver, errors, response helpers
migrations/                 # D1 SQL migrations (0001–0009)
test/                       # Vitest test suite
```

### Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| DB | D1 | Package metadata, users, orgs, audit log |
| FORMULAS | R2 | Formula archive storage (tar.gz) |
| CACHE | KV | Rate limiting, device flow state |
| VECTORIZE | Vectorize | Package embedding index for semantic search |
| AI | Workers AI | Embedding generation and metadata enrichment |
| ENRICHMENT_QUEUE | Queue | Async enrichment pipeline |

### Security

- **Authentication**: SHA-256 hashed Bearer tokens (high-entropy, unsalted — same approach as GitHub/npm)
- **Rate limiting**: 180 req/min per IP (anonymous), 600 req/min per user (authenticated, keyed by user ID)
- **Security headers**: `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, `Referrer-Policy`
- **Account deletion**: Full PII anonymization with unique tombstones, package reassignment to sentinel user
- **Data minimization**: API responses never expose internal UUIDs; `published_by` returns username via JOIN

## Package Naming

Packages follow scoped naming: `@scope/name`

- Scope and name: lowercase alphanumeric with hyphens
- Examples: `@anthropic/claude-skill`, `@community/github-mcp`

## License

[MIT](LICENSE) © ctx-hq

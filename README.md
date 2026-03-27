# ctx Registry API

[![CI](https://github.com/ctx-hq/api/actions/workflows/ci.yml/badge.svg)](https://github.com/ctx-hq/api/actions/workflows/ci.yml)
[![Deploy](https://github.com/ctx-hq/api/actions/workflows/deploy.yml/badge.svg)](https://github.com/ctx-hq/api/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev)

[中文文档](README.zh-CN.md)

Package registry API for [getctx.org](https://getctx.org) — discover, publish, and resolve Claude Code skills, MCP servers, and CLI tools.

Built with [Hono](https://hono.dev) on Cloudflare Workers, backed by D1, R2, and KV.

## Features

- **Package Management** — Scoped packages (`@scope/name`) with semver versioning
- **Full-Text Search** — FTS5-powered search across names, descriptions, and keywords
- **Version Resolution** — Constraint-based resolution (`^`, `~`, `>=`, `*`, exact)
- **Organization Management** — Create orgs, manage members and roles
- **Authenticated Publishing** — Device flow auth with GitHub OAuth
- **Scanner Pipeline** — Auto-discover packages from GitHub, MCP Registry, Homebrew
- **Agent-Readable** — `GET /:fullName.ctx` returns plain-text install instructions

## Quick Start

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Local development server |
| `pnpm test` | Run test suite |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm db:migrate` | Apply D1 migrations locally |
| `pnpm deploy` | Deploy to Cloudflare Workers |

## API Endpoints

### Packages

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/packages` | List packages (filter by `type`, sort by `downloads`\|`created`) |
| GET | `/v1/packages/:fullName` | Get package details with version history |
| GET | `/v1/packages/:fullName/versions` | List all versions |
| GET | `/v1/packages/:fullName/versions/:version` | Get specific version |

### Publishing (auth required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/publish` | Publish a package version (multipart: manifest + archive) |
| POST | `/v1/yank/:fullName/:version` | Yank a version |

### Search & Resolution

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/search?q=` | Full-text search |
| POST | `/v1/resolve` | Bulk version constraint resolution |
| GET | `/v1/packages/:fullName/resolve/:constraint` | Resolve single constraint |
| GET | `/:fullName.ctx` | Agent-readable install instructions |

### Download

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/download/:fullName/:version` | Download formula archive |

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/auth/device` | Start device authorization flow |
| POST | `/v1/auth/token` | Poll for access token |
| GET | `/v1/auth/callback` | GitHub OAuth callback |

### Organizations (auth required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/orgs` | Create organization |
| GET | `/v1/orgs/:name` | Get org details |
| GET | `/v1/orgs/:name/members` | List members |
| POST | `/v1/orgs/:name/members` | Add member (owner/admin) |
| DELETE | `/v1/orgs/:name/members/:username` | Remove member (owner) |

### Scanner (admin)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/scanner/candidates` | List discovered candidates |
| POST | `/v1/scanner/run` | Trigger manual scan |
| POST | `/v1/scanner/candidates/:id/approve` | Approve and import |
| POST | `/v1/scanner/candidates/:id/reject` | Reject candidate |
| GET | `/v1/scanner/stats` | Scanner statistics |

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Registry metadata |
| GET | `/v1/health` | Health check |

## Architecture

```
src/
├── index.ts              # App entry, route mounting, error handling
├── bindings.ts           # Cloudflare binding types
├── models/types.ts       # Shared TypeScript interfaces
├── routes/               # HTTP endpoint handlers
├── services/             # Business logic
├── middleware/            # Auth, CORS, rate limiting
└── utils/                # Naming validation, semver, errors
migrations/               # D1 SQL migrations (0001–0005)
test/                     # Vitest test suite
```

### Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| DB | D1 | Package metadata, users, organizations |
| FORMULAS | R2 | Formula archive storage (tar.gz) |
| CACHE | KV | Rate limiting, device flow state |

## Package Naming

Packages follow scoped naming: `@scope/name`

- Scope and name: lowercase alphanumeric with hyphens
- Example: `@anthropic/claude-skill`, `@community/my-tool`

## Version Constraints

| Constraint | Matches |
|-----------|---------|
| `*` / `latest` | Highest available version |
| `^1.2.3` | `>=1.2.3` and `<2.0.0` |
| `~1.2.3` | `>=1.2.3` and `<1.3.0` |
| `>=1.2.3` | Any version `>=1.2.3` |
| `1.2.3` | Exact match |

## Rate Limiting

- 180 requests per minute per IP
- Applies to all `/v1/*` endpoints
- Returns `429 Too Many Requests` with `Retry-After` header

## Deployment

Requires a `CLOUDFLARE_API_TOKEN` secret configured in GitHub Actions. Pushes to `main` trigger automatic deployment.

```bash
pnpm deploy
```

## License

[MIT](LICENSE) © ctx-hq

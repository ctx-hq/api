# ctx Web API

Hono + Cloudflare Workers API for getctx.org registry.

## Dev & Test

```bash
cp wrangler.toml.example wrangler.toml  # First time: fill in your D1/KV IDs
pnpm dev          # Local dev server
pnpm test         # Run vitest
pnpm typecheck    # TypeScript check
pnpm db:migrate   # Apply D1 migrations locally
pnpm deploy       # Deploy to CF Workers
```

## Architecture

- `src/routes/` — Hono route handlers (packages, search, publish, resolve, auth, scanner, orgs, agent, download, categories, versions, health)
- `src/services/` — Business logic (scanner, importer, enrichment, search, categories, publish)
- `src/middleware/` — Auth, security headers, rate limiting
- `src/utils/` — Naming validation, semver, error types, response helpers
- `migrations/` — D1 SQL migrations (0001–0009)
- `test/` — Vitest test suite (routes, middleware, services)

## CF Bindings

- **DB** (D1) — Package metadata, users, orgs, audit log
- **FORMULAS** (R2) — Formula archives
- **CACHE** (KV) — Rate limiting, device flow state
- **VECTORIZE** (Vectorize) — Package embedding index
- **AI** (Workers AI) — Embedding generation, metadata enrichment
- **ENRICHMENT_QUEUE** (Queue) — Async enrichment pipeline

## Key Design Decisions

- `wrangler.toml` is gitignored; use `wrangler.toml.example` as template
- Token hashing: unsalted SHA-256 (appropriate for high-entropy tokens)
- Account deletion: soft-delete with unique tombstones, packages reassigned to `system-deleted`
- Rate limiting: keyed by user_id for authenticated users (prevents multi-token bypass)

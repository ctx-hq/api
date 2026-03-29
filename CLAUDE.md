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

- `src/routes/` — Hono route handlers (packages, search, publish, resolve, auth, scanner, orgs, agent, download, categories, versions, health, tags, stats, publishers, sync)
- `src/services/` — Business logic (scanner, importer, enrichment, search, categories, publish, publisher, trust, normalize)
- `src/middleware/` — Auth, security headers, rate limiting
- `src/utils/` — Naming validation, semver, error types, response helpers
- `src/models/types.ts` — Shared TypeScript types (PackageRow, PublisherRow, DistTagRow, TrustCheckRow, etc.)
- `migrations/` — D1 SQL migrations (0001–0010)
- `test/` — Vitest test suite (routes, middleware, services)

## CF Bindings

- **DB** (D1) — Package metadata, users, orgs, publishers, trust checks, stats, audit log
- **FORMULAS** (R2) — Formula archives
- **CACHE** (KV) — Rate limiting, device flow state, sync profiles
- **VECTORIZE** (Vectorize) — Package embedding index (public packages only)
- **AI** (Workers AI) — Embedding generation, metadata enrichment
- **ENRICHMENT_QUEUE** (Queue) — Async enrichment pipeline

## Key Design Decisions

- `wrangler.toml` is gitignored; use `wrangler.toml.example` as template
- Token hashing: unsalted SHA-256 (appropriate for high-entropy tokens)
- Account deletion: soft-delete with unique tombstones, packages reassigned to `system-deleted`
- Rate limiting: keyed by user_id for authenticated users (prevents multi-token bypass)
- **Publisher abstraction**: Unified user/org ownership via `publishers` table (kind: user|org). Every user gets a personal publisher; every org gets an org publisher. Packages reference `publisher_id`, not `owner_id` directly.
- **Visibility**: Per-package `public`/`unlisted`/`private`. Private packages require auth for download, return 404 (not 403) to avoid leaking existence. Private packages are excluded from search and vectorization.
- **Push/Sync**: `ctx push` = publish with visibility=private, mutable=true. `ctx sync` manages cross-device environment sync via KV-stored profiles with provenance tracking.
- **Dist-tags**: npm-style named pointers to versions (latest, beta, stable). Auto-set on publish: non-prerelease → latest, prerelease → tag from identifier.
- **Trust tiers**: 4-level progressive verification (unverified → structural → source_linked → reviewed → verified). Structural check is synchronous; others are async via enrichment queue.
- **Normalization layer**: Auto-enrich foreign SKILL.md formats (GitHub raw, ClawHub, SkillsGate) on install. Three-layer SSOT: Original → Enrichment → On-Disk. Reversible via `ctx enrich --reset`.
- **Agent telemetry**: Per agent×package×date install tracking via `agent_installs` table (UPSERT pattern). Stats API returns agent breakdown + trending + per-agent top packages.
- **Double validation**: API validates ⊇ CLI validates. API is the security boundary; CLI validation is UX optimization for fast feedback.
- **Type-specific metadata**: Extracted from manifest JSON on publish into `skill_metadata`, `mcp_metadata`, `cli_metadata`, `install_metadata` tables for structured queries. The manifest JSON blob in `versions.manifest` remains the SSOT.
- **Search digest**: Denormalized `search_digest` table for fast FTS5 search. Only contains public packages. Updated on publish, removed on soft-delete or visibility change to private.

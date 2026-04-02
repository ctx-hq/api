-- Migration 0020: Auth scopes, discovery features, and multi-platform artifacts
-- Phase 1: Token scope enforcement
-- Phase 2: Keywords normalization, stars/favorites
-- Phase 3: Multi-platform artifact distribution

-- ── Token Scope Columns ──
-- endpoint_scopes: which API actions the token can perform
--   Values: ["*"] (all), or subset of ["publish","yank","read-private","manage-access","manage-org"]
-- package_scopes: which packages the token can act on
--   Values: ["*"] (all), or glob patterns like ["@scope/*", "@scope/name"]
-- token_type: "personal" (default) or "deploy" (read-only, long-lived)
ALTER TABLE api_tokens ADD COLUMN endpoint_scopes TEXT NOT NULL DEFAULT '["*"]';
ALTER TABLE api_tokens ADD COLUMN package_scopes TEXT NOT NULL DEFAULT '["*"]';
ALTER TABLE api_tokens ADD COLUMN token_type TEXT NOT NULL DEFAULT 'personal';

-- ── Keywords Normalization ──
-- Separate table for normalized keywords with usage tracking.
-- packages.keywords JSON column remains for backward compat during publish,
-- but package_keywords junction is the source of truth for search/filter.
CREATE TABLE IF NOT EXISTS keywords (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    usage_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS package_keywords (
    package_id TEXT NOT NULL,
    keyword_id TEXT NOT NULL,
    PRIMARY KEY (package_id, keyword_id),
    FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE,
    FOREIGN KEY (keyword_id) REFERENCES keywords(id) ON DELETE CASCADE
);

-- ── Stars / Favorites ──
CREATE TABLE IF NOT EXISTS star_lists (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    slug        TEXT NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'private',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, slug),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stars (
    user_id    TEXT NOT NULL,
    package_id TEXT NOT NULL,
    list_id    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, package_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE,
    FOREIGN KEY (list_id) REFERENCES star_lists(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_stars_user ON stars(user_id);
CREATE INDEX IF NOT EXISTS idx_stars_package ON stars(package_id);

ALTER TABLE packages ADD COLUMN star_count INTEGER NOT NULL DEFAULT 0;

-- ── Multi-Platform Artifacts ──
-- Allows CLI packages to have platform-specific binaries.
-- Falls back to versions.formula_key (default archive) when no artifact matches.
CREATE TABLE IF NOT EXISTS version_artifacts (
    id          TEXT PRIMARY KEY,
    version_id  TEXT NOT NULL,
    platform    TEXT NOT NULL,       -- e.g. "darwin-arm64", "linux-amd64", "windows-amd64"
    formula_key TEXT NOT NULL,       -- R2 object key
    sha256      TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (version_id, platform),
    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_version ON version_artifacts(version_id);

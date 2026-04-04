-- Fix packages.owner_id FK: originally REFERENCES users(id), but since 0018
-- owner_id can be a user ID or an org ID. Drop the FK constraint so org-owned
-- packages can be created. Also drops the mutable column (feature removed).
-- SQLite requires table rebuild.

-- Disable FK checks so DROP TABLE succeeds despite child table references
PRAGMA foreign_keys = OFF;

-- Step 1: Create replacement table without the FK on owner_id, without mutable,
--         and with star_count included.
CREATE TABLE packages_new (
    id                  TEXT PRIMARY KEY,
    scope               TEXT NOT NULL,
    name                TEXT NOT NULL,
    full_name           TEXT NOT NULL UNIQUE,
    type                TEXT NOT NULL CHECK (type IN ('skill', 'mcp', 'cli')),
    description         TEXT NOT NULL DEFAULT '',
    repository          TEXT NOT NULL DEFAULT '',
    license             TEXT NOT NULL DEFAULT '',
    keywords            TEXT NOT NULL DEFAULT '[]',
    platforms           TEXT NOT NULL DEFAULT '[]',
    owner_id            TEXT NOT NULL,
    downloads           INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    summary             TEXT NOT NULL DEFAULT '',
    capabilities        TEXT NOT NULL DEFAULT '[]',
    homepage            TEXT NOT NULL DEFAULT '',
    author              TEXT NOT NULL DEFAULT '',
    author_url          TEXT NOT NULL DEFAULT '',
    enrichment_status   TEXT NOT NULL DEFAULT 'pending',
    enriched_at         TEXT,
    vectorized_at       TEXT,
    content_hash        TEXT NOT NULL DEFAULT '',
    import_source       TEXT NOT NULL DEFAULT '',
    import_external_id  TEXT NOT NULL DEFAULT '',
    visibility          TEXT NOT NULL DEFAULT 'public'
                        CHECK (visibility IN ('public', 'unlisted', 'private')),
    deleted_at          TEXT,
    deprecated_message  TEXT,
    deprecated_at       TEXT,
    source_repo         TEXT NOT NULL DEFAULT '',
    source_verified     INTEGER NOT NULL DEFAULT 0,
    owner_type          TEXT NOT NULL DEFAULT 'user'
                        CHECK (owner_type IN ('user', 'org', 'system')),
    star_count          INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (scope) REFERENCES scopes(name)
);

-- Step 2: Copy all data (explicit columns to avoid ordering issues)
INSERT INTO packages_new (
    id, scope, name, full_name, type, description, repository, license, keywords, platforms,
    owner_id, downloads, created_at, updated_at, summary, capabilities, homepage, author,
    author_url, enrichment_status, enriched_at, vectorized_at, content_hash, import_source,
    import_external_id, visibility, deleted_at, deprecated_message, deprecated_at,
    source_repo, source_verified, owner_type, star_count
)
SELECT
    id, scope, name, full_name, type, description, repository, license, keywords, platforms,
    owner_id, downloads, created_at, updated_at, summary, capabilities, homepage, author,
    author_url, enrichment_status, enriched_at, vectorized_at, content_hash, import_source,
    import_external_id, visibility, deleted_at, deprecated_message, deprecated_at,
    source_repo, source_verified, owner_type, star_count
FROM packages;

-- Step 3: Drop old indexes (all indexes on the old table, including later migrations)
DROP INDEX IF EXISTS idx_packages_type;
DROP INDEX IF EXISTS idx_packages_owner;
DROP INDEX IF EXISTS idx_packages_downloads;
DROP INDEX IF EXISTS idx_packages_owner_type;
DROP INDEX IF EXISTS idx_packages_import;
DROP INDEX IF EXISTS idx_packages_enrichment;
DROP INDEX IF EXISTS idx_packages_content_hash;
DROP INDEX IF EXISTS idx_packages_visibility;

-- Step 4: Swap tables
DROP TABLE packages;
ALTER TABLE packages_new RENAME TO packages;

-- Step 5: Recreate all indexes
CREATE INDEX idx_packages_type ON packages(type);
CREATE INDEX idx_packages_owner ON packages(owner_id);
CREATE INDEX idx_packages_downloads ON packages(downloads DESC);
CREATE INDEX idx_packages_owner_type ON packages(owner_type, owner_id);
CREATE INDEX idx_packages_import ON packages(import_source, import_external_id);
CREATE INDEX idx_packages_enrichment ON packages(enrichment_status);
CREATE INDEX idx_packages_content_hash ON packages(content_hash);
CREATE INDEX idx_packages_visibility ON packages(visibility);

-- Re-enable FK checks
PRAGMA foreign_keys = ON;

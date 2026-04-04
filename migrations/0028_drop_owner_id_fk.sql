-- Remove FOREIGN KEY (owner_id) REFERENCES users(id) from packages.
-- D1 cannot disable FK checks, so we:
--   1. Back up all child-table data
--   2. Delete non-CASCADE children (so DROP TABLE's implicit DELETE succeeds)
--   3. DROP TABLE packages (CASCADE children auto-delete)
--   4. Recreate packages without the owner_id FK
--   5. Restore all data in FK-safe order

-- Step 1: Back up data
CREATE TABLE _bak_packages AS SELECT * FROM packages;
CREATE TABLE _bak_versions AS SELECT * FROM versions;
CREATE TABLE _bak_dist_tags AS SELECT * FROM dist_tags;
CREATE TABLE _bak_download_stats AS SELECT * FROM download_stats;
CREATE TABLE _bak_vector_chunks AS SELECT * FROM vector_chunks;
CREATE TABLE _bak_search_digest AS SELECT * FROM search_digest;
CREATE TABLE _bak_package_keywords AS SELECT * FROM package_keywords;

-- Step 2: Delete non-CASCADE children (order: dist_tags first because it FKs versions)
DELETE FROM dist_tags;
DELETE FROM download_stats;
DELETE FROM versions;

-- Step 3: Drop indexes on packages
DROP INDEX IF EXISTS idx_packages_type;
DROP INDEX IF EXISTS idx_packages_owner;
DROP INDEX IF EXISTS idx_packages_downloads;
DROP INDEX IF EXISTS idx_packages_owner_type;
DROP INDEX IF EXISTS idx_packages_import;
DROP INDEX IF EXISTS idx_packages_enrichment;
DROP INDEX IF EXISTS idx_packages_content_hash;
DROP INDEX IF EXISTS idx_packages_visibility;

-- Step 4: DROP TABLE packages (CASCADE handles vector_chunks, search_digest,
--         package_keywords, stars, trusted_publishers, upstream_*, package_categories)
DROP TABLE packages;

-- Step 5: Recreate packages WITHOUT owner_id FK
CREATE TABLE packages (
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

-- Step 6: Restore packages data
INSERT INTO packages SELECT * FROM _bak_packages;

-- Step 7: Recreate indexes
CREATE INDEX idx_packages_type ON packages(type);
CREATE INDEX idx_packages_owner ON packages(owner_id);
CREATE INDEX idx_packages_downloads ON packages(downloads DESC);
CREATE INDEX idx_packages_owner_type ON packages(owner_type, owner_id);
CREATE INDEX idx_packages_import ON packages(import_source, import_external_id);
CREATE INDEX idx_packages_enrichment ON packages(enrichment_status);
CREATE INDEX idx_packages_content_hash ON packages(content_hash);
CREATE INDEX idx_packages_visibility ON packages(visibility);

-- Step 8: Restore child data in FK-safe order
INSERT INTO versions SELECT * FROM _bak_versions;
INSERT INTO dist_tags SELECT * FROM _bak_dist_tags;
INSERT INTO download_stats SELECT * FROM _bak_download_stats;
INSERT INTO vector_chunks SELECT * FROM _bak_vector_chunks;
INSERT INTO search_digest SELECT * FROM _bak_search_digest;
INSERT INTO package_keywords SELECT * FROM _bak_package_keywords;

-- Step 9: Clean up backup tables
DROP TABLE _bak_packages;
DROP TABLE _bak_versions;
DROP TABLE _bak_dist_tags;
DROP TABLE _bak_download_stats;
DROP TABLE _bak_vector_chunks;
DROP TABLE _bak_search_digest;
DROP TABLE _bak_package_keywords;

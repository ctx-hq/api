-- Remove publisher abstraction layer.
-- Direct ownership: packages.owner_type + packages.owner_id → users | orgs | system.
-- No backward compat needed (pre-launch).

-- ============================================================
-- PACKAGES: Add owner_type, backfill from publishers, drop publisher_id
-- ============================================================
ALTER TABLE packages ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user'
    CHECK (owner_type IN ('user', 'org', 'system'));

-- Backfill owner_type and owner_id from publishers table
UPDATE packages SET
    owner_type = (SELECT CASE p.kind WHEN 'org' THEN 'org' ELSE 'user' END FROM publishers p WHERE p.id = packages.publisher_id),
    owner_id = (SELECT COALESCE(p.org_id, p.user_id) FROM publishers p WHERE p.id = packages.publisher_id)
WHERE publisher_id != '';

-- For scanner-imported packages without publisher, set to system
UPDATE packages SET owner_type = 'system', owner_id = 'system-scanner'
    WHERE publisher_id = '' AND owner_id = '';

CREATE INDEX idx_packages_owner_type ON packages(owner_type, owner_id);

-- Drop old publisher_id column and index
DROP INDEX IF EXISTS idx_packages_publisher;
ALTER TABLE packages DROP COLUMN publisher_id;

-- ============================================================
-- SCOPES: Drop publisher_id (owner_type + owner_id already exist)
-- ============================================================
ALTER TABLE scopes DROP COLUMN publisher_id;

-- ============================================================
-- TRANSFER REQUESTS: Rebuild table to replace publisher FK columns
-- with owner_type/owner_id columns (SQLite can't DROP FK columns)
-- ============================================================

-- Step 1: Create new table without publisher FKs
CREATE TABLE transfer_requests_new (
    id              TEXT PRIMARY KEY,
    package_id      TEXT NOT NULL,
    from_owner_type TEXT NOT NULL DEFAULT 'user',
    from_owner_id   TEXT NOT NULL DEFAULT '',
    to_owner_type   TEXT NOT NULL DEFAULT 'user',
    to_owner_id     TEXT NOT NULL DEFAULT '',
    initiated_by    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
    message         TEXT NOT NULL DEFAULT '',
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at     TEXT,
    resolved_by     TEXT,
    FOREIGN KEY (package_id) REFERENCES packages(id),
    FOREIGN KEY (initiated_by) REFERENCES users(id),
    FOREIGN KEY (resolved_by) REFERENCES users(id)
);

-- Step 2: Migrate data with backfill from publishers
INSERT INTO transfer_requests_new (
    id, package_id,
    from_owner_type, from_owner_id,
    to_owner_type, to_owner_id,
    initiated_by, status, message, expires_at, created_at, resolved_at, resolved_by
)
SELECT
    t.id, t.package_id,
    COALESCE((SELECT CASE p.kind WHEN 'org' THEN 'org' ELSE 'user' END FROM publishers p WHERE p.id = t.from_publisher_id), 'user'),
    COALESCE((SELECT COALESCE(p.user_id, p.org_id) FROM publishers p WHERE p.id = t.from_publisher_id), ''),
    COALESCE((SELECT CASE p.kind WHEN 'org' THEN 'org' ELSE 'user' END FROM publishers p WHERE p.id = t.to_publisher_id), 'user'),
    COALESCE((SELECT COALESCE(p.user_id, p.org_id) FROM publishers p WHERE p.id = t.to_publisher_id), ''),
    t.initiated_by, t.status, t.message, t.expires_at, t.created_at, t.resolved_at, t.resolved_by
FROM transfer_requests t;

-- Step 3: Swap tables
DROP INDEX IF EXISTS idx_transfer_pending;
DROP INDEX IF EXISTS idx_transfer_to_status;
DROP INDEX IF EXISTS idx_transfer_from;
DROP TABLE transfer_requests;
ALTER TABLE transfer_requests_new RENAME TO transfer_requests;

-- Step 4: Recreate indexes
CREATE UNIQUE INDEX idx_transfer_pending ON transfer_requests(package_id)
    WHERE status = 'pending';
CREATE INDEX idx_transfer_to_owner ON transfer_requests(to_owner_type, to_owner_id, status);

-- ============================================================
-- SEARCH DIGEST: Add owner_slug, backfill, drop publisher_slug
-- ============================================================
ALTER TABLE search_digest ADD COLUMN owner_slug TEXT NOT NULL DEFAULT '';
UPDATE search_digest SET owner_slug = publisher_slug WHERE publisher_slug != '';
ALTER TABLE search_digest DROP COLUMN publisher_slug;

-- ============================================================
-- PACKAGE CLAIMS: System package claim mechanism
-- ============================================================
CREATE TABLE package_claims (
    id           TEXT PRIMARY KEY,
    package_id   TEXT NOT NULL,
    claimant_id  TEXT NOT NULL,
    github_repo  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at  TEXT,
    FOREIGN KEY (package_id) REFERENCES packages(id),
    FOREIGN KEY (claimant_id) REFERENCES users(id)
);
CREATE INDEX idx_claims_package ON package_claims(package_id);
CREATE INDEX idx_claims_claimant ON package_claims(claimant_id);

-- ============================================================
-- DROP publishers table (all FK references removed above)
-- ============================================================
DROP INDEX IF EXISTS idx_publishers_user;
DROP INDEX IF EXISTS idx_publishers_org;
DROP TABLE publishers;

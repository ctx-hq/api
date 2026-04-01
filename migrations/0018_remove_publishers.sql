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
-- TRANSFER REQUESTS: Add owner-typed columns, backfill, drop publisher columns
-- ============================================================
ALTER TABLE transfer_requests ADD COLUMN from_owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE transfer_requests ADD COLUMN from_owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE transfer_requests ADD COLUMN to_owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE transfer_requests ADD COLUMN to_owner_id TEXT NOT NULL DEFAULT '';

-- Backfill from publishers
UPDATE transfer_requests SET
    from_owner_type = (SELECT CASE p.kind WHEN 'org' THEN 'org' ELSE 'user' END FROM publishers p WHERE p.id = transfer_requests.from_publisher_id),
    from_owner_id = (SELECT COALESCE(p.user_id, p.org_id) FROM publishers p WHERE p.id = transfer_requests.from_publisher_id),
    to_owner_type = (SELECT CASE p.kind WHEN 'org' THEN 'org' ELSE 'user' END FROM publishers p WHERE p.id = transfer_requests.to_publisher_id),
    to_owner_id = (SELECT COALESCE(p.user_id, p.org_id) FROM publishers p WHERE p.id = transfer_requests.to_publisher_id)
WHERE from_publisher_id != '';

CREATE INDEX idx_transfer_to_owner ON transfer_requests(to_owner_type, to_owner_id, status);

-- Drop old publisher columns and indexes
DROP INDEX IF EXISTS idx_transfer_to_status;
DROP INDEX IF EXISTS idx_transfer_from;
ALTER TABLE transfer_requests DROP COLUMN from_publisher_id;
ALTER TABLE transfer_requests DROP COLUMN to_publisher_id;

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
-- DROP publishers table (all references removed)
-- ============================================================
DROP INDEX IF EXISTS idx_publishers_user;
DROP INDEX IF EXISTS idx_publishers_org;
DROP TABLE publishers;

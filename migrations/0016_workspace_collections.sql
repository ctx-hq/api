-- Collection & Source Sync support
-- Enables collection meta-packages and upstream repo sync tracking.

-- ============================================================
-- COLLECTION MEMBERS: Links collection packages to their members
-- ============================================================
CREATE TABLE collection_members (
    id             TEXT PRIMARY KEY,
    collection_id  TEXT NOT NULL,
    member_id      TEXT NOT NULL,
    member_path    TEXT NOT NULL DEFAULT '',
    display_order  INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (collection_id) REFERENCES packages(id),
    FOREIGN KEY (member_id) REFERENCES packages(id),
    UNIQUE(collection_id, member_id)
);
CREATE INDEX idx_collection_members_collection ON collection_members(collection_id);
CREATE INDEX idx_collection_members_member ON collection_members(member_id);

-- ============================================================
-- SOURCE SYNC: Track upstream repos for auto-sync of imported packages
-- ============================================================
CREATE TABLE source_sync (
    id           TEXT PRIMARY KEY,
    package_id   TEXT NOT NULL UNIQUE,
    github_repo  TEXT NOT NULL,
    path         TEXT NOT NULL DEFAULT '',
    ref          TEXT NOT NULL DEFAULT 'main',
    last_commit  TEXT NOT NULL DEFAULT '',
    last_synced  TEXT,
    sync_errors  INTEGER NOT NULL DEFAULT 0,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (package_id) REFERENCES packages(id)
);
CREATE INDEX idx_source_sync_enabled ON source_sync(enabled);
CREATE INDEX idx_source_sync_repo ON source_sync(github_repo);

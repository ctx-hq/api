-- Registry v2: Publishers, visibility, dist-tags, type metadata,
-- trust checks, download stats, agent installs, search digest,
-- slug aliases, sync profiles

-- ============================================================
-- PUBLISHERS: Unified ownership abstraction (user + org)
-- ============================================================
CREATE TABLE publishers (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('user', 'org')),
    user_id     TEXT,
    org_id      TEXT,
    slug        TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (org_id) REFERENCES orgs(id)
);
CREATE INDEX idx_publishers_user ON publishers(user_id);
CREATE INDEX idx_publishers_org ON publishers(org_id);

-- Backfill: personal publisher for every user
INSERT INTO publishers (id, kind, user_id, slug, created_at)
SELECT 'pub-' || id, 'user', id, username, datetime('now')
FROM users;

-- Backfill: org publisher for every org
INSERT INTO publishers (id, kind, org_id, slug, created_at)
SELECT 'pub-org-' || id, 'org', id, name, datetime('now')
FROM orgs;

-- ============================================================
-- PACKAGES V2: publisher_id, visibility, mutable, soft delete
-- ============================================================
ALTER TABLE packages ADD COLUMN publisher_id TEXT NOT NULL DEFAULT '';
ALTER TABLE packages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'unlisted', 'private'));
ALTER TABLE packages ADD COLUMN mutable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE packages ADD COLUMN deleted_at TEXT;
ALTER TABLE packages ADD COLUMN deprecated_message TEXT;
ALTER TABLE packages ADD COLUMN deprecated_at TEXT;
ALTER TABLE packages ADD COLUMN source_repo TEXT NOT NULL DEFAULT '';
ALTER TABLE packages ADD COLUMN source_verified INTEGER NOT NULL DEFAULT 0;

-- Backfill publisher_id from owner_id
UPDATE packages SET publisher_id = 'pub-' || owner_id;

CREATE INDEX idx_packages_publisher ON packages(publisher_id);
CREATE INDEX idx_packages_visibility ON packages(visibility);

-- Add publisher_id to scopes
ALTER TABLE scopes ADD COLUMN publisher_id TEXT NOT NULL DEFAULT '';

-- Backfill scopes.publisher_id
UPDATE scopes SET publisher_id = (
    SELECT p.id FROM publishers p
    WHERE (scopes.owner_type = 'user' AND p.user_id = scopes.owner_id)
       OR (scopes.owner_type = 'org' AND p.org_id = scopes.owner_id)
    LIMIT 1
);

-- ============================================================
-- DIST-TAGS: Named pointers to specific versions
-- ============================================================
CREATE TABLE dist_tags (
    id          TEXT PRIMARY KEY,
    package_id  TEXT NOT NULL,
    tag         TEXT NOT NULL,
    version_id  TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (package_id) REFERENCES packages(id),
    FOREIGN KEY (version_id) REFERENCES versions(id),
    UNIQUE(package_id, tag)
);
CREATE INDEX idx_dist_tags_pkg ON dist_tags(package_id);

-- ============================================================
-- TYPE-SPECIFIC METADATA: Extracted from manifest for queries
-- ============================================================

-- Skills: entry file, compatibility, invocability
CREATE TABLE skill_metadata (
    version_id    TEXT PRIMARY KEY,
    entry         TEXT NOT NULL DEFAULT '',
    compatibility TEXT NOT NULL DEFAULT '',
    user_invocable INTEGER NOT NULL DEFAULT 1,
    tags          TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
);
CREATE INDEX idx_skill_compat ON skill_metadata(compatibility);

-- MCP servers: transport, command, tools
CREATE TABLE mcp_metadata (
    version_id  TEXT PRIMARY KEY,
    transport   TEXT NOT NULL DEFAULT 'stdio',
    command     TEXT NOT NULL DEFAULT '',
    args        TEXT NOT NULL DEFAULT '[]',
    url         TEXT NOT NULL DEFAULT '',
    env_vars    TEXT NOT NULL DEFAULT '[]',
    tools       TEXT NOT NULL DEFAULT '[]',
    resources   TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
);
CREATE INDEX idx_mcp_transport ON mcp_metadata(transport);

-- CLI tools: binary name, verification, requirements
CREATE TABLE cli_metadata (
    version_id   TEXT PRIMARY KEY,
    binary       TEXT NOT NULL DEFAULT '',
    verify       TEXT NOT NULL DEFAULT '',
    compatible   TEXT NOT NULL DEFAULT '',
    require_bins TEXT NOT NULL DEFAULT '[]',
    require_env  TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
);
CREATE INDEX idx_cli_binary ON cli_metadata(binary);

-- Install methods: how to obtain, per-version
CREATE TABLE install_metadata (
    version_id  TEXT PRIMARY KEY,
    source      TEXT NOT NULL DEFAULT '',
    brew        TEXT NOT NULL DEFAULT '',
    npm         TEXT NOT NULL DEFAULT '',
    pip         TEXT NOT NULL DEFAULT '',
    cargo       TEXT NOT NULL DEFAULT '',
    platforms   TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
);

-- ============================================================
-- TRUST & VERIFICATION PIPELINE
-- ============================================================
CREATE TABLE trust_checks (
    id          TEXT PRIMARY KEY,
    version_id  TEXT NOT NULL,
    check_type  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    score       REAL,
    details     TEXT NOT NULL DEFAULT '{}',
    checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
);
CREATE INDEX idx_trust_checks_version ON trust_checks(version_id);
CREATE INDEX idx_trust_checks_type ON trust_checks(check_type, status);

ALTER TABLE versions ADD COLUMN trust_tier TEXT NOT NULL DEFAULT 'unverified';

-- ============================================================
-- DOWNLOAD STATS: Daily granularity
-- ============================================================
CREATE TABLE download_stats (
    id          TEXT PRIMARY KEY,
    package_id  TEXT NOT NULL,
    version     TEXT NOT NULL DEFAULT '',
    date        TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (package_id) REFERENCES packages(id),
    UNIQUE(package_id, version, date)
);
CREATE INDEX idx_dl_stats_pkg_date ON download_stats(package_id, date);
CREATE INDEX idx_dl_stats_date ON download_stats(date);

-- Agent install tracking
CREATE TABLE agent_installs (
    id          TEXT PRIMARY KEY,
    package_id  TEXT NOT NULL,
    agent_name  TEXT NOT NULL,
    date        TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (package_id) REFERENCES packages(id),
    UNIQUE(package_id, agent_name, date)
);
CREATE INDEX idx_agent_installs_pkg ON agent_installs(package_id);
CREATE INDEX idx_agent_installs_agent ON agent_installs(agent_name);

-- ============================================================
-- SEARCH DIGEST: Denormalized for fast search (public only)
-- ============================================================
CREATE TABLE search_digest (
    package_id    TEXT PRIMARY KEY,
    full_name     TEXT NOT NULL,
    type          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    summary       TEXT NOT NULL DEFAULT '',
    keywords      TEXT NOT NULL DEFAULT '',
    capabilities  TEXT NOT NULL DEFAULT '',
    latest_version TEXT NOT NULL DEFAULT '',
    downloads     INTEGER NOT NULL DEFAULT 0,
    trust_tier    TEXT NOT NULL DEFAULT 'unverified',
    publisher_slug TEXT NOT NULL DEFAULT '',
    score         REAL NOT NULL DEFAULT 0.0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE
);

-- Rebuild FTS on search_digest instead of packages
DROP TRIGGER IF EXISTS pkg_fts_ai;
DROP TRIGGER IF EXISTS pkg_fts_au;
DROP TRIGGER IF EXISTS pkg_fts_ad;
DROP TABLE IF EXISTS packages_fts;

CREATE VIRTUAL TABLE packages_fts USING fts5(
    full_name, description, summary, keywords, capabilities, type,
    content='search_digest', content_rowid='rowid'
);

CREATE TRIGGER digest_fts_ai AFTER INSERT ON search_digest BEGIN
    INSERT INTO packages_fts(rowid, full_name, description, summary, keywords, capabilities, type)
    VALUES (new.rowid, new.full_name, new.description, new.summary, new.keywords, new.capabilities, new.type);
END;

CREATE TRIGGER digest_fts_au AFTER UPDATE ON search_digest BEGIN
    INSERT INTO packages_fts(packages_fts, rowid, full_name, description, summary, keywords, capabilities, type)
    VALUES ('delete', old.rowid, old.full_name, old.description, old.summary, old.keywords, old.capabilities, old.type);
    INSERT INTO packages_fts(rowid, full_name, description, summary, keywords, capabilities, type)
    VALUES (new.rowid, new.full_name, new.description, new.summary, new.keywords, new.capabilities, new.type);
END;

CREATE TRIGGER digest_fts_ad AFTER DELETE ON search_digest BEGIN
    INSERT INTO packages_fts(packages_fts, rowid, full_name, description, summary, keywords, capabilities, type)
    VALUES ('delete', old.rowid, old.full_name, old.description, old.summary, old.keywords, old.capabilities, old.type);
END;

-- Backfill search_digest from existing public packages
INSERT INTO search_digest (package_id, full_name, type, description, summary, keywords, capabilities, latest_version, downloads, publisher_slug, updated_at)
SELECT
    p.id, p.full_name, p.type, p.description, p.summary, p.keywords, p.capabilities,
    COALESCE((SELECT v.version FROM versions v WHERE v.package_id = p.id AND v.yanked = 0 ORDER BY v.created_at DESC LIMIT 1), ''),
    p.downloads,
    COALESCE((SELECT pub.slug FROM publishers pub WHERE pub.id = p.publisher_id LIMIT 1), ''),
    p.updated_at
FROM packages p
WHERE p.visibility = 'public' AND p.deleted_at IS NULL;

-- Rebuild FTS index from backfilled data
INSERT INTO packages_fts(packages_fts) VALUES ('rebuild');

-- ============================================================
-- SLUG ALIASES: Redirect after package rename
-- ============================================================
CREATE TABLE slug_aliases (
    old_full_name TEXT PRIMARY KEY,
    new_full_name TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- SYNC PROFILES: Cross-device sync metadata
-- ============================================================
CREATE TABLE sync_profiles (
    user_id          TEXT PRIMARY KEY,
    device_name      TEXT NOT NULL DEFAULT '',
    package_count    INTEGER NOT NULL DEFAULT 0,
    syncable_count   INTEGER NOT NULL DEFAULT 0,
    unsyncable_count INTEGER NOT NULL DEFAULT 0,
    last_push_at     TEXT,
    last_pull_at     TEXT,
    last_push_device TEXT NOT NULL DEFAULT '',
    last_pull_device TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id)
);

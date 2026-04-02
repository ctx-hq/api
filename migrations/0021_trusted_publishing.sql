CREATE TABLE IF NOT EXISTS trusted_publishers (
    id           TEXT PRIMARY KEY,
    package_id   TEXT NOT NULL,
    provider     TEXT NOT NULL DEFAULT 'github',
    github_repo  TEXT NOT NULL,
    workflow     TEXT NOT NULL,
    environment  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (package_id, provider, github_repo, workflow),
    FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trusted_publishers_package ON trusted_publishers(package_id);

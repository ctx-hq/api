-- Privacy remediation: account deletion support and cleanup

-- Sentinel user for deleted/anonymized accounts
INSERT OR IGNORE INTO users (id, username, email, avatar_url, github_id, role)
VALUES ('system-deleted', '[deleted]', '', '', 'system-deleted', 'user');

-- Drop legacy unused column (D1 runs SQLite 3.45+)
ALTER TABLE users DROP COLUMN api_key_hash;

-- Index for efficient audit log retention cleanup
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);

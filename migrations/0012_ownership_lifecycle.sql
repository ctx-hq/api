-- Ownership lifecycle: transfers, notifications, org archive, rename support

-- ============================================================
-- ORG STATUS: Archive support + rename tracking
-- ============================================================
ALTER TABLE orgs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived'));
ALTER TABLE orgs ADD COLUMN archived_at TEXT;
ALTER TABLE orgs ADD COLUMN renamed_at TEXT;

-- ============================================================
-- USER RENAME TRACKING
-- ============================================================
ALTER TABLE users ADD COLUMN renamed_at TEXT;

-- ============================================================
-- TRANSFER REQUESTS: Two-phase package ownership transfer
-- ============================================================
CREATE TABLE transfer_requests (
    id                TEXT PRIMARY KEY,
    package_id        TEXT NOT NULL,
    from_publisher_id TEXT NOT NULL,
    to_publisher_id   TEXT NOT NULL,
    initiated_by      TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
    message           TEXT NOT NULL DEFAULT '',
    expires_at        TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at       TEXT,
    resolved_by       TEXT,
    FOREIGN KEY (package_id) REFERENCES packages(id),
    FOREIGN KEY (from_publisher_id) REFERENCES publishers(id),
    FOREIGN KEY (to_publisher_id) REFERENCES publishers(id),
    FOREIGN KEY (initiated_by) REFERENCES users(id),
    FOREIGN KEY (resolved_by) REFERENCES users(id)
);

-- Only one pending transfer per package at a time
CREATE UNIQUE INDEX idx_transfer_pending ON transfer_requests(package_id)
    WHERE status = 'pending';
CREATE INDEX idx_transfer_to_status ON transfer_requests(to_publisher_id, status);
CREATE INDEX idx_transfer_from ON transfer_requests(from_publisher_id);

-- ============================================================
-- NOTIFICATIONS / INBOX: Lightweight poll-based system
-- ============================================================
CREATE TABLE notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    type        TEXT NOT NULL
                CHECK (type IN (
                    'org_invitation',
                    'transfer_request',
                    'transfer_completed',
                    'member_joined',
                    'member_left',
                    'package_deprecated',
                    'security_alert',
                    'system_notice'
                )),
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    data        TEXT NOT NULL DEFAULT '{}',
    read        INTEGER NOT NULL DEFAULT 0,
    dismissed   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_notif_user_unread ON notifications(user_id, read)
    WHERE dismissed = 0;
CREATE INDEX idx_notif_user_created ON notifications(user_id, created_at DESC);

-- ============================================================
-- SCOPE-LEVEL ALIASES: Redirect after org/user rename
-- ============================================================
CREATE TABLE scope_aliases (
    old_scope   TEXT PRIMARY KEY,
    new_scope   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

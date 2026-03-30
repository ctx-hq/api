-- Organization invitations, membership visibility, and package-level access control

-- 1. Org invitations table
CREATE TABLE org_invitations (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL,
    inviter_id  TEXT NOT NULL,
    invitee_id  TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'admin', 'member')),
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    FOREIGN KEY (org_id) REFERENCES orgs(id),
    FOREIGN KEY (inviter_id) REFERENCES users(id),
    FOREIGN KEY (invitee_id) REFERENCES users(id)
);

CREATE INDEX idx_org_invitations_invitee_status ON org_invitations(invitee_id, status);
CREATE INDEX idx_org_invitations_org_status ON org_invitations(org_id, status);
CREATE INDEX idx_org_invitations_expiry ON org_invitations(status, expires_at)
    WHERE status = 'pending';
CREATE UNIQUE INDEX idx_org_invitations_pending ON org_invitations(org_id, invitee_id)
    WHERE status = 'pending';

-- 2. Add visibility column to org_members (public/private membership)
ALTER TABLE org_members ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('public', 'private'));

-- 3. Package access control table (for restricted visibility — 飞书-style per-user ACL)
-- When a private package has rows in this table, only listed users + owner/admin can access it.
-- When no rows exist, all org members can access (standard private behavior).
CREATE TABLE package_access (
    package_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    granted_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (package_id, user_id),
    FOREIGN KEY (package_id) REFERENCES packages(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (granted_by) REFERENCES users(id)
);

CREATE INDEX idx_package_access_user ON package_access(user_id);

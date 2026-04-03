-- Remove KV dependency: store device flow codes in D1, sync profile JSON in D1
-- KV was hitting free-tier quota limits (1000 writes/day)

-- Device flow codes (replaces KV device: and usercode: keys)
CREATE TABLE device_codes (
  device_code TEXT PRIMARY KEY,
  user_code   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  github_id   TEXT,
  username    TEXT,
  email       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_device_codes_user_code ON device_codes(user_code);
CREATE INDEX idx_device_codes_expires_at ON device_codes(expires_at);

-- Store sync profile JSON alongside metadata (was in KV as sync:{user_id})
ALTER TABLE sync_profiles ADD COLUMN profile_json TEXT;

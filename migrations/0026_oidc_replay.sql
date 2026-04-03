-- OIDC token replay prevention (moved from Cache API to D1 for global consistency)
-- Cache API is per-colo and cannot prevent cross-colo replay attacks
CREATE TABLE used_oidc_tokens (
  jti        TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_used_oidc_tokens_expires_at ON used_oidc_tokens(expires_at);

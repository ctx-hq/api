import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { generateId } from "../utils/response";
import { hashToken } from "../services/auth";
import { authMiddleware } from "../middleware/auth";
import { badRequest, forbidden, notFound } from "../utils/errors";
import { getOrCreatePublisher } from "../services/publisher";
import { renameUser, checkRenameCooldown, isNameAvailable } from "../services/rename";

const app = new Hono<AppEnv>();

// Start device flow (RFC 8628)
app.post("/v1/auth/device", async (c) => {
  const deviceCode = generateId();
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const userCode = Array.from(bytes).map(b => b.toString(36)).join("").slice(0, 8).toUpperCase();

  const ttl = 900;

  // Store device code + reverse mapping in KV with 15 min TTL
  await Promise.all([
    c.env.CACHE.put(
      `device:${deviceCode}`,
      JSON.stringify({ user_code: userCode, status: "pending" }),
      { expirationTtl: ttl }
    ),
    c.env.CACHE.put(
      `usercode:${userCode}`,
      deviceCode,
      { expirationTtl: ttl }
    ),
  ]);

  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: "https://getctx.org/login/device",
    verification_uri_complete: `https://getctx.org/login/device?code=${userCode}`,
    expires_in: ttl,
    interval: 5,
  });
});

// Authorize a device code (user must be logged in via web session)
app.post("/v1/auth/device/authorize", authMiddleware, async (c) => {
  const user = c.get("user");

  let body: { user_code?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const userCode = body.user_code?.trim().toUpperCase();
  if (!userCode) {
    throw badRequest("user_code is required");
  }

  // Delete reverse mapping first as optimistic lock — if two concurrent
  // requests race, only one will find the mapping and proceed.
  const deviceCode = await c.env.CACHE.get(`usercode:${userCode}`);
  if (!deviceCode) {
    throw badRequest("Invalid or expired code");
  }
  await c.env.CACHE.delete(`usercode:${userCode}`);

  // Check current status
  const stored = await c.env.CACHE.get(`device:${deviceCode}`);
  if (!stored) {
    throw badRequest("Invalid or expired code");
  }

  const data = JSON.parse(stored);
  if (data.status === "authorized") {
    throw badRequest("Code already used");
  }

  // Mark as authorized — short TTL, CLI only needs to poll once
  await c.env.CACHE.put(
    `device:${deviceCode}`,
    JSON.stringify({
      user_code: userCode,
      status: "authorized",
      github_id: user.github_id,
      username: user.username,
      email: user.email ?? "",
    }),
    { expirationTtl: 120 }
  );

  return c.json({ authorized: true });
});

// Poll for token
app.post("/v1/auth/token", async (c) => {
  const formData = await c.req.parseBody();
  const deviceCode = formData["device_code"] as string;

  if (!deviceCode) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const stored = await c.env.CACHE.get(`device:${deviceCode}`);
  if (!stored) {
    return c.json({ error: "expired_token" }, 400);
  }

  const data = JSON.parse(stored);
  if (data.status === "pending") {
    return c.json({ error: "authorization_pending" }, 400);
  }

  if (data.status === "authorized") {
    // Generate API token
    const token = `ctx_${generateId()}${generateId()}`;
    const tokenHash = await hashToken(token);

    // Ensure user exists
    let user = await c.env.DB.prepare(
      "SELECT id FROM users WHERE github_id = ?"
    ).bind(data.github_id).first();

    if (!user) {
      const userId = generateId();
      await c.env.DB.prepare(
        "INSERT INTO users (id, username, email, github_id) VALUES (?, ?, ?, ?)"
      ).bind(userId, data.username, data.email ?? "", data.github_id).run();
      user = { id: userId };
    }

    // Auto-create personal publisher
    await getOrCreatePublisher(c.env.DB, user.id as string, data.username);

    // Create API token
    await c.env.DB.prepare(
      "INSERT INTO api_tokens (id, user_id, token_hash, name) VALUES (?, ?, ?, 'cli')"
    ).bind(generateId(), user.id, tokenHash).run();

    // Clean up device code
    await c.env.CACHE.delete(`device:${deviceCode}`);

    return c.json({
      access_token: token,
      token_type: "bearer",
      scope: "read write",
    });
  }

  return c.json({ error: "authorization_pending" }, 400);
});

// GitHub OAuth callback (completes device flow)
app.get("/v1/auth/callback", async (c) => {
  return c.json({ message: "Use /login/callback on the web app for OAuth" });
});

// GitHub OAuth — exchange a GitHub OAuth code for a session token.
// The web app redirects to /login/callback which then calls this endpoint
// with the temporary `code` from GitHub.  We exchange it server-side so the
// client never needs to know the client_secret.
app.post("/v1/auth/github", async (c) => {
  let body: { code?: string };
  try {
    body = await c.req.json<{ code?: string }>();
  } catch {
    return c.json({ error: "invalid_request", message: "Invalid JSON body" }, 400);
  }

  if (!body.code) {
    return c.json({ error: "missing code" }, 400);
  }

  // Exchange the code for an access token with GitHub
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code: body.code,
    }),
  });

  const tokenData = await tokenRes.json<{
    access_token?: string;
    error?: string;
    error_description?: string;
  }>();

  if (!tokenData.access_token) {
    return c.json(
      { error: "github_oauth_failed", message: tokenData.error_description ?? tokenData.error ?? "Unknown error" },
      401,
    );
  }

  // Fetch the authenticated user's profile from GitHub
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "ctx-registry",
      Accept: "application/vnd.github+json",
    },
  });

  if (!userRes.ok) {
    return c.json({ error: "github_user_fetch_failed" }, 502);
  }

  const ghUser = await userRes.json<{
    id: number;
    login: string;
    email: string | null;
    avatar_url: string;
  }>();

  const githubId = String(ghUser.id);
  const username = ghUser.login;
  const email = ghUser.email ?? "";
  const avatarUrl = ghUser.avatar_url;

  // Upsert user — create if new, update email/avatar if existing
  let user = await c.env.DB.prepare(
    "SELECT id FROM users WHERE github_id = ?"
  ).bind(githubId).first();

  if (user) {
    // Update profile (email may change, avatar may change)
    await c.env.DB.prepare(
      "UPDATE users SET username = ?, email = ?, avatar_url = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(username, email, avatarUrl, user.id).run();

    // Ensure publisher exists for returning users
    await getOrCreatePublisher(c.env.DB, user.id as string, username);
  } else {
    const userId = generateId();
    await c.env.DB.prepare(
      "INSERT INTO users (id, username, email, avatar_url, github_id) VALUES (?, ?, ?, ?, ?)"
    ).bind(userId, username, email, avatarUrl, githubId).run();
    user = { id: userId };

    // Auto-create personal publisher + user scope
    const publisher = await getOrCreatePublisher(c.env.DB, userId, username);
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO scopes (name, owner_type, owner_id, publisher_id) VALUES (?, 'user', ?, ?)"
    ).bind(username.toLowerCase(), userId, publisher.id).run();
  }

  // Generate session token
  const token = `ctx_${generateId()}${generateId()}`;
  const tokenHash = await hashToken(token);

  await c.env.DB.prepare(
    "INSERT INTO api_tokens (id, user_id, token_hash, name) VALUES (?, ?, ?, 'web')"
  ).bind(generateId(), user.id, tokenHash).run();

  return c.json({ token });
});

// Get current user (validate session)
app.get("/v1/me", authMiddleware, async (c) => {
  const user = c.get("user");
  return c.json({
    id: user.id,
    username: user.username,
    email: user.email,
    avatar_url: user.avatar_url,
  });
});

// Update user profile (bio, website)
app.patch("/v1/me/profile", authMiddleware, async (c) => {
  const user = c.get("user");
  let body: { bio?: string; website?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (typeof body.bio === "string") {
    if (body.bio.length > 256) {
      throw badRequest("Bio must be 256 characters or less");
    }
    updates.push("bio = ?");
    params.push(body.bio.trim());
  }

  if (typeof body.website === "string") {
    const site = body.website.trim();
    if (site.length > 2048) {
      throw badRequest("Website must be 2048 characters or less");
    }
    if (site && !site.startsWith("https://") && !site.startsWith("http://")) {
      throw badRequest("Website must be a valid URL (https://) or empty");
    }
    updates.push("website = ?");
    params.push(site);
  }

  if (updates.length === 0) {
    throw badRequest("No fields to update");
  }

  updates.push("updated_at = datetime('now')");
  params.push(user.id);

  await c.env.DB.prepare(
    `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
  ).bind(...params).run();

  return c.json({ ok: true });
});

// --- Token Management ---

// List current user's tokens
app.get("/v1/me/tokens", authMiddleware, async (c) => {
  const user = c.get("user");
  const result = await c.env.DB.prepare(
    "SELECT id, name, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(user.id).all();

  return c.json({ tokens: result.results ?? [] });
});

// Create a new named token
app.post("/v1/me/tokens", authMiddleware, async (c) => {
  const user = c.get("user");
  let body: { name?: string; expires_in_days?: number };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const tokenName = body.name?.trim();
  if (!tokenName) {
    throw badRequest("Token name is required");
  }

  if (body.expires_in_days !== undefined) {
    if (!Number.isInteger(body.expires_in_days) || body.expires_in_days < 1 || body.expires_in_days > 365) {
      throw badRequest("expires_in_days must be an integer between 1 and 365");
    }
  }

  const token = `ctx_${generateId()}${generateId()}`;
  const tokenHash = await hashToken(token);
  const tokenId = generateId();

  if (body.expires_in_days) {
    const expiresAt = new Date(Date.now() + body.expires_in_days * 86400_000).toISOString();
    await c.env.DB.prepare(
      "INSERT INTO api_tokens (id, user_id, token_hash, name, expires_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(tokenId, user.id, tokenHash, tokenName, expiresAt).run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO api_tokens (id, user_id, token_hash, name) VALUES (?, ?, ?, ?)"
    ).bind(tokenId, user.id, tokenHash, tokenName).run();
  }

  return c.json({ id: tokenId, token, name: tokenName }, 201);
});

// Revoke a token
app.delete("/v1/me/tokens/:tokenId", authMiddleware, async (c) => {
  const user = c.get("user");
  const tokenId = c.req.param("tokenId");

  const result = await c.env.DB.prepare(
    "DELETE FROM api_tokens WHERE id = ? AND user_id = ?"
  ).bind(tokenId, user.id).run();

  if (!result.meta.changes) {
    throw badRequest("Token not found");
  }

  return c.json({ revoked: true });
});

// --- Account Deletion ---

// Delete current user's account (anonymize + cascade)
app.delete("/v1/me", authMiddleware, async (c) => {
  const user = c.get("user");

  // Prevent deleting system accounts
  if (user.id === "system-scanner" || user.id === "system-deleted") {
    throw forbidden("System accounts cannot be deleted");
  }

  // Check if user is sole owner of any org
  const soleOwnerOrgs = await c.env.DB.prepare(
    `SELECT o.name FROM org_members m
     JOIN orgs o ON m.org_id = o.id
     WHERE m.user_id = ? AND m.role = 'owner'
     AND (SELECT COUNT(*) FROM org_members m2 WHERE m2.org_id = m.org_id AND m2.role = 'owner') = 1`
  ).bind(user.id).all();

  if (soleOwnerOrgs.results && soleOwnerOrgs.results.length > 0) {
    const orgNames = soleOwnerOrgs.results.map((r) => `@${r.name}`).join(", ");
    throw badRequest(
      `Cannot delete account: you are the sole owner of ${orgNames}. Transfer ownership first.`
    );
  }

  const anonymizedUsername = `deleted-${user.id.slice(0, 8)}`;

  // Execute all deletions/anonymizations in a batch
  await c.env.DB.batch([
    // Anonymize user row — github_id uses unique tombstone to avoid UNIQUE constraint collision
    c.env.DB.prepare(
      `UPDATE users SET username = ?, email = '', avatar_url = '', github_id = ?,
       updated_at = datetime('now') WHERE id = ?`
    ).bind(anonymizedUsername, `deleted:${user.id}`, user.id),
    // Reassign package ownership
    c.env.DB.prepare(
      "UPDATE packages SET owner_id = 'system-deleted' WHERE owner_id = ?"
    ).bind(user.id),
    // Reassign version publisher references
    c.env.DB.prepare(
      "UPDATE versions SET published_by = 'system-deleted' WHERE published_by = ?"
    ).bind(user.id),
    // Revoke all tokens
    c.env.DB.prepare(
      "DELETE FROM api_tokens WHERE user_id = ?"
    ).bind(user.id),
    // Remove org memberships
    c.env.DB.prepare(
      "DELETE FROM org_members WHERE user_id = ?"
    ).bind(user.id),
    // Audit event
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, metadata)
       VALUES (?, ?, 'account_deleted', 'user', ?, '{}')`
    ).bind(generateId(), user.id, user.id),
  ]);

  return c.json({ deleted: true });
});

// Rename user (self only, 30-day cooldown)
app.patch("/v1/me/rename", authMiddleware, async (c) => {
  const user = c.get("user");

  let body: { new_username: string; confirm: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.new_username) throw badRequest("new_username is required");
  if (body.confirm !== user.username) {
    throw badRequest(`Confirmation required: pass "confirm": "${user.username}" to proceed`);
  }

  // Check cooldown
  const onCooldown = await checkRenameCooldown(c.env.DB, "users", user.id);
  if (onCooldown) {
    throw badRequest("You renamed your account recently. Please wait 30 days between renames.");
  }

  // Check availability
  const availability = await isNameAvailable(c.env.DB, body.new_username);
  if (!availability.available) {
    throw badRequest(availability.reason!);
  }

  try {
    const result = await renameUser(c.env.DB, user.id, body.new_username);

    // Audit
    await c.env.DB.prepare(
      "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'user.rename', ?, 'user', ?, ?)",
    ).bind(
      generateId(),
      user.id,
      user.id,
      JSON.stringify({ old_username: result.oldUsername, new_username: result.newUsername }),
    ).run();

    return c.json({
      old_username: result.oldUsername,
      new_username: result.newUsername,
      packages_updated: result.packagesUpdated,
    });
  } catch (e: any) {
    throw badRequest(e.message);
  }
});

export default app;

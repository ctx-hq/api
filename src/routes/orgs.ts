import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware, optionalAuth } from "../middleware/auth";
import { badRequest, notFound, forbidden, conflict } from "../utils/errors";
import { isValidScope } from "../utils/naming";
import { generateId } from "../utils/response";
import { createOrgPublisher, getPublisherForScope, canPublish } from "../services/publisher";
import type { InvitationStatus } from "../models/types";
import {
  createInvitation,
  listOrgInvitations,
  listUserInvitations,
  acceptInvitation,
  declineInvitation,
  cancelInvitation,
  cancelUserInvitations,
  expirePendingInvitations,
} from "../services/invitation";
import { cleanupUserAccessForOrg } from "../services/package-access";

const app = new Hono<AppEnv>();

// Create organization
app.post("/v1/orgs", authMiddleware, async (c) => {
  const user = c.get("user");
  let body: { name: string; display_name?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.name || !isValidScope(body.name)) {
    throw badRequest("Invalid org name (lowercase, alphanumeric, hyphens)");
  }

  // Check if scope already taken
  const existing = await c.env.DB.prepare(
    "SELECT name FROM scopes WHERE name = ?"
  ).bind(body.name).first();

  if (existing) {
    throw badRequest(`Scope @${body.name} is already taken`);
  }

  const orgId = generateId();

  // Create org first (publishers.org_id has FK to orgs.id)
  await c.env.DB.prepare(
    "INSERT INTO orgs (id, name, display_name, created_by) VALUES (?, ?, ?, ?)",
  ).bind(orgId, body.name, body.display_name ?? body.name, user.id).run();

  // Now create publisher (FK to orgs.id is satisfied)
  const publisher = await createOrgPublisher(c.env.DB, orgId, body.name);

  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO scopes (name, owner_type, owner_id, publisher_id) VALUES (?, 'org', ?, ?)",
    ).bind(body.name, orgId, publisher.id),
    c.env.DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')",
    ).bind(orgId, user.id),
  ]);

  return c.json({ id: orgId, name: body.name }, 201);
});

// Get org detail
app.get("/v1/orgs/:name", optionalAuth, async (c) => {
  const name = c.req.param("name");
  const org = await c.env.DB.prepare(
    "SELECT * FROM orgs WHERE name = ?"
  ).bind(name).first();

  if (!org) throw notFound(`Organization @${name} not found`);

  const memberCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM org_members WHERE org_id = ?"
  ).bind(org.id).first();

  // Package count: respect package_access restrictions for non-owner/admin members
  const user = c.get("user");
  const publisher = await getPublisherForScope(c.env.DB, name!);
  const isMember = user && publisher ? await canPublish(c.env.DB, user.id, publisher) : false;

  let packageCount: Record<string, unknown> | null;
  if (!isMember) {
    packageCount = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM packages WHERE scope = ? AND visibility = 'public' AND deleted_at IS NULL",
    ).bind(name).first();
  } else {
    // Check if user is owner/admin (bypasses package_access restrictions)
    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(org.id, user.id).first<{ role: string }>();

    if (membership && ["owner", "admin"].includes(membership.role)) {
      // Owner/admin sees all
      packageCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as count FROM packages WHERE scope = ? AND deleted_at IS NULL",
      ).bind(name).first();
    } else {
      // Regular member: exclude restricted private packages they aren't granted access to
      packageCount = await c.env.DB.prepare(
        `SELECT COUNT(*) as count FROM packages WHERE scope = ? AND deleted_at IS NULL
         AND (
           visibility != 'private'
           OR NOT EXISTS (SELECT 1 FROM package_access WHERE package_id = packages.id)
           OR EXISTS (SELECT 1 FROM package_access WHERE package_id = packages.id AND user_id = ?)
         )`,
      ).bind(name, user.id).first();
    }
  }

  return c.json({
    id: org.id,
    name: org.name,
    display_name: org.display_name,
    members: memberCount?.count ?? 0,
    packages: packageCount?.count ?? 0,
    created_at: org.created_at,
  });
});

// List org members
app.get("/v1/orgs/:name/members", authMiddleware, async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  // Verify caller is a member of this org
  const callerMembership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?"
  ).bind(org.id, user.id).first();
  if (!callerMembership) {
    throw forbidden("You must be a member of this organization to view members");
  }

  const members = await c.env.DB.prepare(
    `SELECT u.username, u.avatar_url, m.role, m.visibility, m.created_at
     FROM org_members m JOIN users u ON m.user_id = u.id
     WHERE m.org_id = ?`
  ).bind(org.id).all();

  return c.json({ members: members.results ?? [] });
});

// Add org member
app.post("/v1/orgs/:name/members", authMiddleware, async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  let body: { username: string; role?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  // Check caller is owner or admin
  const callerMembership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?"
  ).bind(org.id, user.id).first();

  if (!callerMembership || !["owner", "admin"].includes(callerMembership.role as string)) {
    throw forbidden("Only owners and admins can add members");
  }

  // Find target user
  const targetUser = await c.env.DB.prepare(
    "SELECT id FROM users WHERE username = ?"
  ).bind(body.username).first();

  if (!targetUser) throw notFound(`User ${body.username} not found`);

  const role = body.role ?? "member";
  if (!["owner", "admin", "member"].includes(role)) {
    throw badRequest("Role must be owner, admin, or member");
  }

  // Only owners can assign the owner role
  if (role === "owner" && callerMembership.role !== "owner") {
    throw forbidden("Only owners can assign the owner role");
  }

  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)"
  ).bind(org.id, targetUser.id, role).run();

  return c.json({ added: body.username, role });
});

// Remove org member
app.delete("/v1/orgs/:name/members/:username", authMiddleware, async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  const username = c.req.param("username");

  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  const callerMembership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?"
  ).bind(org.id, user.id).first();

  if (!callerMembership || callerMembership.role !== "owner") {
    throw forbidden("Only owners can remove members");
  }

  const targetUser = await c.env.DB.prepare(
    "SELECT id FROM users WHERE username = ?"
  ).bind(username).first();

  if (!targetUser) throw notFound(`User ${username} not found`);

  // Prevent removing the last owner
  const targetMembership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?"
  ).bind(org.id, targetUser.id).first();

  if (targetMembership?.role === "owner") {
    const ownerCount = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM org_members WHERE org_id = ? AND role = 'owner'"
    ).bind(org.id).first();
    if ((ownerCount?.count as number) <= 1) {
      throw badRequest("Cannot remove the last owner of an organization");
    }
  }

  // Cascade cleanup: package access + pending invitations + membership
  await Promise.all([
    cleanupUserAccessForOrg(c.env.DB, targetUser.id as string, org.id as string),
    cancelUserInvitations(c.env.DB, org.id as string, targetUser.id as string),
  ]);

  await c.env.DB.prepare(
    "DELETE FROM org_members WHERE org_id = ? AND user_id = ?"
  ).bind(org.id, targetUser.id).run();

  return c.json({ removed: username });
});

// List user's orgs
app.get("/v1/orgs", authMiddleware, async (c) => {
  const user = c.get("user");
  const orgs = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.display_name, m.role, o.created_at
     FROM org_members m JOIN orgs o ON m.org_id = o.id
     WHERE m.user_id = ?`,
  ).bind(user.id).all();

  return c.json({ orgs: orgs.results ?? [] });
});

// List org packages
app.get("/v1/orgs/:name/packages", optionalAuth, async (c) => {
  const name = c.req.param("name");
  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  // Members see all visibility levels; others see only public
  // Restricted private packages (with package_access rows) are hidden from
  // regular members unless they have an explicit grant.
  const user = c.get("user");
  const publisher = await getPublisherForScope(c.env.DB, name!);
  const isMember = user && publisher ? await canPublish(c.env.DB, user.id, publisher) : false;

  const conditions: string[] = ["scope = ?", "deleted_at IS NULL"];
  const params: unknown[] = [name];
  if (!isMember) {
    conditions.push("visibility = 'public'");
  } else {
    // Check if owner/admin (can see everything)
    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(org.id, user.id).first<{ role: string }>();

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      // Regular member: exclude restricted private packages without grant
      conditions.push(`(
        visibility != 'private'
        OR NOT EXISTS (SELECT 1 FROM package_access WHERE package_id = packages.id)
        OR EXISTS (SELECT 1 FROM package_access WHERE package_id = packages.id AND user_id = ?)
      )`);
      params.push(user.id);
    }
  }

  const packages = await c.env.DB.prepare(
    `SELECT full_name, type, description, summary, visibility, downloads, created_at
     FROM packages WHERE ${conditions.join(" AND ")}
     ORDER BY downloads DESC`,
  ).bind(...params).all();

  return c.json({ packages: packages.results ?? [] });
});

// Update org
app.patch("/v1/orgs/:name", authMiddleware, async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");

  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  const membership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(org.id, user.id).first();

  if (!membership || membership.role !== "owner") {
    throw forbidden("Only owners can update the organization");
  }

  let body: { display_name?: string };
  try { body = await c.req.json(); } catch { throw badRequest("Invalid JSON body"); }

  if (body.display_name) {
    await c.env.DB.prepare(
      "UPDATE orgs SET display_name = ? WHERE id = ?",
    ).bind(body.display_name, org.id).run();
  }

  return c.json({ name, display_name: body.display_name });
});

// Delete org (only if 0 packages)
app.delete("/v1/orgs/:name", authMiddleware, async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");

  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  const membership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(org.id, user.id).first();

  if (!membership || membership.role !== "owner") {
    throw forbidden("Only owners can delete the organization");
  }

  const pkgCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM packages WHERE scope = ? AND deleted_at IS NULL",
  ).bind(name).first<{ count: number }>();

  if (pkgCount && pkgCount.count > 0) {
    throw badRequest("Cannot delete organization with existing packages. Transfer or delete them first.");
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM org_invitations WHERE org_id = ?").bind(org.id),
    c.env.DB.prepare(
      `DELETE FROM package_access WHERE package_id IN (
         SELECT id FROM packages WHERE publisher_id IN (
           SELECT id FROM publishers WHERE org_id = ?
         )
       )`,
    ).bind(org.id),
    c.env.DB.prepare("DELETE FROM org_members WHERE org_id = ?").bind(org.id),
    c.env.DB.prepare("DELETE FROM scopes WHERE name = ?").bind(name),
    c.env.DB.prepare("DELETE FROM publishers WHERE org_id = ?").bind(org.id),
    c.env.DB.prepare("DELETE FROM orgs WHERE id = ?").bind(org.id),
  ]);

  return c.json({ deleted: name });
});

// Update member role
app.patch("/v1/orgs/:name/members/:username", authMiddleware, async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  const username = c.req.param("username");

  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  const callerMembership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(org.id, user.id).first();

  if (!callerMembership || !["owner", "admin"].includes(callerMembership.role as string)) {
    throw forbidden("Only owners and admins can change member roles");
  }

  let body: { role: string };
  try { body = await c.req.json(); } catch { throw badRequest("Invalid JSON body"); }

  if (!["owner", "admin", "member"].includes(body.role)) {
    throw badRequest("Role must be owner, admin, or member");
  }
  if (body.role === "owner" && callerMembership.role !== "owner") {
    throw forbidden("Only owners can assign the owner role");
  }

  const targetUser = await c.env.DB.prepare(
    "SELECT id FROM users WHERE username = ?",
  ).bind(username).first();

  if (!targetUser) throw notFound(`User ${username} not found`);

  // Prevent demoting the last owner
  if (body.role !== "owner") {
    const targetMembership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(org.id, targetUser.id).first();

    if (targetMembership?.role === "owner") {
      const ownerCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as count FROM org_members WHERE org_id = ? AND role = 'owner'",
      ).bind(org.id).first<{ count: number }>();
      if ((ownerCount?.count ?? 0) <= 1) {
        throw badRequest("Cannot demote the last owner of an organization");
      }
    }
  }

  await c.env.DB.prepare(
    "UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?",
  ).bind(body.role, org.id, targetUser.id).run();

  return c.json({ username, role: body.role });
});

// ============================================================
// INVITATION ROUTES
// ============================================================

// Create invitation (owner/admin only)
app.post("/v1/orgs/:name/invitations", authMiddleware, async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");

  let body: { username: string; role?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.username) throw badRequest("username is required");

  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  // Verify caller is owner or admin
  const callerMembership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(org.id, user.id).first();

  if (!callerMembership || !["owner", "admin"].includes(callerMembership.role as string)) {
    throw forbidden("Only owners and admins can invite members");
  }

  const role = body.role ?? "member";
  if (!["owner", "admin", "member"].includes(role)) {
    throw badRequest("Role must be owner, admin, or member");
  }
  if (role === "owner" && callerMembership.role !== "owner") {
    throw forbidden("Only owners can invite with the owner role");
  }

  // Find target user
  const targetUser = await c.env.DB.prepare(
    "SELECT id FROM users WHERE username = ?",
  ).bind(body.username).first();
  if (!targetUser) throw notFound(`User ${body.username} not found`);

  // Cannot invite yourself
  if (targetUser.id === user.id) throw badRequest("Cannot invite yourself");

  // Check if already a member
  const existingMembership = await c.env.DB.prepare(
    "SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(org.id, targetUser.id).first();
  if (existingMembership) throw conflict(`${body.username} is already a member of @${name}`);

  // Expire stale invitations before checking, so expired ones don't block re-invite
  await expirePendingInvitations(c.env.DB);

  // Check for existing pending invitation
  const existingInvitation = await c.env.DB.prepare(
    "SELECT 1 FROM org_invitations WHERE org_id = ? AND invitee_id = ? AND status = 'pending'",
  ).bind(org.id, targetUser.id).first();
  if (existingInvitation) throw conflict(`${body.username} already has a pending invitation to @${name}`);

  const invitation = await createInvitation(
    c.env.DB,
    org.id as string,
    user.id,
    targetUser.id as string,
    role,
  );

  return c.json({
    id: invitation.id,
    org_name: name,
    inviter: user.username,
    invitee: body.username,
    role: invitation.role,
    status: invitation.status,
    expires_at: invitation.expires_at,
    created_at: invitation.created_at,
  }, 201);
});

// List org invitations (owner/admin only)
app.get("/v1/orgs/:name/invitations", authMiddleware, async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  const statusFilter = c.req.query("status") as string | undefined;

  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  const callerMembership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(org.id, user.id).first();

  if (!callerMembership || !["owner", "admin"].includes(callerMembership.role as string)) {
    throw forbidden("Only owners and admins can view invitations");
  }

  const validStatuses = ["pending", "accepted", "declined", "expired", "cancelled"];
  const status = statusFilter && validStatuses.includes(statusFilter) ? statusFilter : undefined;

  const invitations = await listOrgInvitations(
    c.env.DB,
    org.id as string,
    status as InvitationStatus | undefined,
  );

  return c.json({ invitations });
});

// Cancel invitation (owner/admin only)
app.delete("/v1/orgs/:name/invitations/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  const invitationId = c.req.param("id");

  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  const callerMembership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(org.id, user.id).first();

  if (!callerMembership || !["owner", "admin"].includes(callerMembership.role as string)) {
    throw forbidden("Only owners and admins can cancel invitations");
  }

  const cancelled = await cancelInvitation(c.env.DB, invitationId!, org.id as string);
  if (!cancelled) throw notFound("Invitation not found or not pending");

  return c.json({ cancelled: invitationId });
});

// ============================================================
// USER INVITATION ROUTES (/v1/me/invitations)
// ============================================================

// List my pending invitations
app.get("/v1/me/invitations", authMiddleware, async (c) => {
  const user = c.get("user");
  const invitations = await listUserInvitations(c.env.DB, user.id);
  return c.json({ invitations });
});

// Accept invitation
app.post("/v1/me/invitations/:id/accept", authMiddleware, async (c) => {
  const user = c.get("user");
  const invitationId = c.req.param("id")!;

  const result = await acceptInvitation(c.env.DB, invitationId, user.id);
  if (!result) throw notFound("Invitation not found, not pending, or expired");

  const org = await c.env.DB.prepare("SELECT name FROM orgs WHERE id = ?")
    .bind(result.org_id)
    .first<{ name: string }>();

  return c.json({
    accepted: invitationId,
    org_name: org?.name ?? "unknown",
    role: result.role,
  });
});

// Decline invitation
app.post("/v1/me/invitations/:id/decline", authMiddleware, async (c) => {
  const user = c.get("user");
  const invitationId = c.req.param("id")!;

  const declined = await declineInvitation(c.env.DB, invitationId, user.id);
  if (!declined) throw notFound("Invitation not found or not pending");

  return c.json({ declined: invitationId });
});

// ============================================================
// MEMBER VISIBILITY ROUTES
// ============================================================

// Toggle own membership visibility
app.patch("/v1/orgs/:name/members/:username/visibility", authMiddleware, async (c) => {
  const user = c.get("user");
  const name = c.req.param("name");
  const username = c.req.param("username");

  // Only allow users to change their own visibility
  if (user.username !== username) {
    throw forbidden("You can only change your own membership visibility");
  }

  let body: { visibility: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!["public", "private"].includes(body.visibility)) {
    throw badRequest("Visibility must be public or private");
  }

  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  const result = await c.env.DB.prepare(
    "UPDATE org_members SET visibility = ? WHERE org_id = ? AND user_id = ?",
  ).bind(body.visibility, org.id, user.id).run();

  if ((result.meta?.changes ?? 0) === 0) {
    throw notFound("You are not a member of this organization");
  }

  return c.json({ username, visibility: body.visibility });
});

// List public members (no auth required)
app.get("/v1/orgs/:name/public-members", async (c) => {
  const name = c.req.param("name");
  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  const members = await c.env.DB.prepare(
    `SELECT u.username, u.avatar_url, m.role, m.created_at
     FROM org_members m JOIN users u ON m.user_id = u.id
     WHERE m.org_id = ? AND m.visibility = 'public'`,
  ).bind(org.id).all();

  return c.json({ members: members.results ?? [] });
});

export default app;

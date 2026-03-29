import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware } from "../middleware/auth";
import { badRequest, notFound, forbidden } from "../utils/errors";
import { isValidScope } from "../utils/naming";
import { generateId } from "../utils/response";
import { createOrgPublisher } from "../services/publisher";

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
app.get("/v1/orgs/:name", async (c) => {
  const name = c.req.param("name");
  const org = await c.env.DB.prepare(
    "SELECT * FROM orgs WHERE name = ?"
  ).bind(name).first();

  if (!org) throw notFound(`Organization @${name} not found`);

  const memberCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM org_members WHERE org_id = ?"
  ).bind(org.id).first();

  const packageCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM packages WHERE scope = ?"
  ).bind(name).first();

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
    `SELECT u.username, u.avatar_url, m.role, m.created_at
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
app.get("/v1/orgs/:name/packages", async (c) => {
  const name = c.req.param("name");
  const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
  if (!org) throw notFound(`Organization @${name} not found`);

  const packages = await c.env.DB.prepare(
    `SELECT full_name, type, description, summary, downloads, created_at
     FROM packages WHERE scope = ? AND visibility = 'public' AND deleted_at IS NULL
     ORDER BY downloads DESC`,
  ).bind(name).all();

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

export default app;

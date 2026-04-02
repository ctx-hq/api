import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware, optionalAuth } from "../middleware/auth";
import { badRequest, notFound, forbidden } from "../utils/errors";
import { generateId } from "../utils/response";

const app = new Hono<AppEnv>();

// ── Star a package (idempotent) ──
app.put("/v1/packages/:fullName/star", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    "SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL"
  ).bind(fullName).first<{ id: string }>();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Parse optional list_id from body
  let listId: string | null = null;
  try {
    const body = await c.req.json();
    listId = (body as any).list_id ?? null;
  } catch {
    // No body is fine
  }

  // Validate list ownership if provided
  if (listId) {
    const list = await c.env.DB.prepare(
      "SELECT id FROM star_lists WHERE id = ? AND user_id = ?"
    ).bind(listId, user.id).first();
    if (!list) throw notFound("Star list not found");
  }

  // Upsert star and update star_count atomically
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO stars (user_id, package_id, list_id, created_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (user_id, package_id) DO UPDATE SET list_id = excluded.list_id`
    ).bind(user.id, pkg.id, listId),
    c.env.DB.prepare(
      "UPDATE packages SET star_count = (SELECT COUNT(*) FROM stars WHERE package_id = ?) WHERE id = ?"
    ).bind(pkg.id, pkg.id),
  ]);

  return c.json({ starred: true, full_name: fullName });
});

// ── Unstar a package ──
app.delete("/v1/packages/:fullName/star", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    "SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL"
  ).bind(fullName).first<{ id: string }>();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Check star exists first, then delete + update count atomically
  const existing = await c.env.DB.prepare(
    "SELECT 1 FROM stars WHERE user_id = ? AND package_id = ?"
  ).bind(user.id, pkg.id).first();

  if (!existing) {
    throw notFound("You have not starred this package");
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM stars WHERE user_id = ? AND package_id = ?"
    ).bind(user.id, pkg.id),
    c.env.DB.prepare(
      "UPDATE packages SET star_count = (SELECT COUNT(*) FROM stars WHERE package_id = ?) WHERE id = ?"
    ).bind(pkg.id, pkg.id),
  ]);

  return c.json({ starred: false, full_name: fullName });
});

// ── List my stars ──
app.get("/v1/me/stars", authMiddleware, async (c) => {
  const user = c.get("user");
  const listSlug = c.req.query("list");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20") || 20, 100);
  const offset = parseInt(c.req.query("offset") ?? "0") || 0;

  let sql = `
    SELECT p.full_name, p.type, p.description, p.star_count, s.created_at AS starred_at
    FROM stars s
    JOIN packages p ON s.package_id = p.id
    WHERE s.user_id = ? AND p.deleted_at IS NULL
  `;
  const params: unknown[] = [user.id];

  if (listSlug) {
    sql += ` AND s.list_id = (SELECT id FROM star_lists WHERE user_id = ? AND slug = ?)`;
    params.push(user.id, listSlug);
  }

  // Count
  const countSql = `SELECT COUNT(*) as count FROM stars s JOIN packages p ON s.package_id = p.id WHERE s.user_id = ? AND p.deleted_at IS NULL` +
    (listSlug ? ` AND s.list_id = (SELECT id FROM star_lists WHERE user_id = ? AND slug = ?)` : "");
  const countParams = listSlug ? [user.id, user.id, listSlug] : [user.id];

  sql += ` ORDER BY s.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const [result, countResult] = await Promise.all([
    c.env.DB.prepare(sql).bind(...params).all(),
    c.env.DB.prepare(countSql).bind(...countParams).first<{ count: number }>(),
  ]);

  return c.json({
    stars: result.results ?? [],
    total: countResult?.count ?? 0,
  });
});

// ── Create star list ──
app.post("/v1/me/star-lists", authMiddleware, async (c) => {
  const user = c.get("user");

  let body: { name: string; description?: string; visibility?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.name?.trim()) throw badRequest("name is required");

  const slug = body.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw badRequest("name must contain alphanumeric characters");

  const visibility = body.visibility ?? "private";
  if (!["public", "private"].includes(visibility)) {
    throw badRequest("visibility must be public or private");
  }

  const id = generateId();
  await c.env.DB.prepare(
    `INSERT INTO star_lists (id, user_id, name, description, slug, visibility)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, body.name.trim(), body.description ?? "", slug, visibility).run();

  return c.json({ id, name: body.name.trim(), slug, visibility }, 201);
});

// ── List my star lists ──
app.get("/v1/me/star-lists", authMiddleware, async (c) => {
  const user = c.get("user");

  const result = await c.env.DB.prepare(
    `SELECT sl.id, sl.name, sl.slug, sl.description, sl.visibility, sl.created_at,
            (SELECT COUNT(*) FROM stars s WHERE s.list_id = sl.id) as star_count
     FROM star_lists sl WHERE sl.user_id = ?
     ORDER BY sl.created_at DESC`
  ).bind(user.id).all();

  return c.json({ lists: result.results ?? [] });
});

// ── Update star list ──
app.patch("/v1/me/star-lists/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const listId = c.req.param("id")!;

  const list = await c.env.DB.prepare(
    "SELECT id, user_id FROM star_lists WHERE id = ? AND user_id = ?"
  ).bind(listId, user.id).first();

  if (!list) throw notFound("Star list not found");

  let body: { name?: string; description?: string; visibility?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.name !== undefined) {
    const slug = body.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) throw badRequest("name must contain alphanumeric characters");
    updates.push("name = ?, slug = ?");
    params.push(body.name.trim(), slug);
  }

  if (body.description !== undefined) {
    updates.push("description = ?");
    params.push(body.description);
  }

  if (body.visibility !== undefined) {
    if (!["public", "private"].includes(body.visibility)) {
      throw badRequest("visibility must be public or private");
    }
    updates.push("visibility = ?");
    params.push(body.visibility);
  }

  if (updates.length === 0) throw badRequest("No fields to update");

  params.push(listId);
  await c.env.DB.prepare(
    `UPDATE star_lists SET ${updates.join(", ")} WHERE id = ?`
  ).bind(...params).run();

  return c.json({ updated: true });
});

// ── Delete star list ──
app.delete("/v1/me/star-lists/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const listId = c.req.param("id")!;

  const result = await c.env.DB.prepare(
    "DELETE FROM star_lists WHERE id = ? AND user_id = ?"
  ).bind(listId, user.id).run();

  if (!result.meta.changes) throw notFound("Star list not found");

  // Nullify list_id on associated stars (don't remove stars)
  await c.env.DB.prepare(
    "UPDATE stars SET list_id = NULL WHERE list_id = ?"
  ).bind(listId).run();

  return c.json({ deleted: true });
});

// ── View public star list ──
app.get("/v1/users/:username/star-lists/:slug", optionalAuth, async (c) => {
  const username = c.req.param("username")!;
  const slug = c.req.param("slug")!;

  const list = await c.env.DB.prepare(
    `SELECT sl.id, sl.name, sl.slug, sl.description, sl.visibility, sl.user_id, sl.created_at
     FROM star_lists sl
     JOIN users u ON sl.user_id = u.id
     WHERE u.username = ? AND sl.slug = ?`
  ).bind(username, slug).first<{ id: string; visibility: string; user_id: string; name: string; slug: string; description: string; created_at: string }>();

  if (!list) throw notFound("Star list not found");

  // Private lists only visible to owner
  const user = c.get("user");
  if (list.visibility === "private" && user?.id !== list.user_id) {
    throw notFound("Star list not found");
  }

  const stars = await c.env.DB.prepare(
    `SELECT p.full_name, p.type, p.description, p.star_count, s.created_at AS starred_at
     FROM stars s
     JOIN packages p ON s.package_id = p.id
     WHERE s.list_id = ? AND p.deleted_at IS NULL
     ORDER BY s.created_at DESC`
  ).bind(list.id).all();

  return c.json({
    name: list.name,
    slug: list.slug,
    description: list.description,
    visibility: list.visibility,
    username,
    stars: stars.results ?? [],
    created_at: list.created_at,
  });
});

export default app;

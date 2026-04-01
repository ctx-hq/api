import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware, optionalAuth } from "../middleware/auth";
import { badRequest, forbidden, notFound } from "../utils/errors";
import { generateId } from "../utils/response";
import { canPublish, canAccessPackage } from "../services/ownership";
import { parseFullName } from "../utils/naming";

const app = new Hono<AppEnv>();

// List dist-tags for a package
app.get("/v1/packages/:fullName/tags", optionalAuth, async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    "SELECT id, visibility, owner_type, owner_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  )
    .bind(fullName)
    .first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Visibility guard
  const user = c.get("user");
  if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
    throw notFound(`Package ${fullName} not found`);
  }

  const tags = await c.env.DB.prepare(
    `SELECT dt.tag, v.version
     FROM dist_tags dt JOIN versions v ON dt.version_id = v.id
     WHERE dt.package_id = ?`,
  )
    .bind(pkg.id)
    .all();

  const result: Record<string, string> = {};
  for (const row of tags.results ?? []) {
    result[row.tag as string] = row.version as string;
  }

  return c.json({ tags: result });
});

// Set a dist-tag
app.put("/v1/packages/:fullName/tags/:tag", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);
  const tag = c.req.param("tag")!;

  // Tag name validation: no semver-like names
  if (/^\d+\.\d+\.\d+/.test(tag)) {
    throw badRequest("Tag name cannot be a semver version");
  }
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
    throw badRequest("Tag must be lowercase alphanumeric with hyphens");
  }

  const pkg = await c.env.DB.prepare(
    "SELECT * FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  )
    .bind(fullName)
    .first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Auth: must be scope member
  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");

  if (!(await canPublish(c.env.DB, user.id, parsed.scope))) {
    throw forbidden("You don't have permission to manage tags for this package");
  }

  let body: { version: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const version = await c.env.DB.prepare(
    "SELECT id, version FROM versions WHERE package_id = ? AND version = ?",
  )
    .bind(pkg.id, body.version)
    .first();

  if (!version) throw notFound(`Version ${body.version} not found`);

  // Upsert dist-tag with ON CONFLICT
  await c.env.DB.prepare(
    `INSERT INTO dist_tags (id, package_id, tag, version_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (package_id, tag) DO UPDATE SET version_id = excluded.version_id, updated_at = datetime('now')`,
  )
    .bind(generateId(), pkg.id, tag, version.id)
    .run();

  return c.json({ tag, version: body.version });
});

// Delete a dist-tag
app.delete("/v1/packages/:fullName/tags/:tag", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);
  const tag = c.req.param("tag")!;

  if (tag === "latest") {
    throw badRequest("Cannot delete the 'latest' tag");
  }

  const pkg = await c.env.DB.prepare(
    "SELECT * FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  )
    .bind(fullName)
    .first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");

  if (!(await canPublish(c.env.DB, user.id, parsed.scope))) {
    throw forbidden("You don't have permission to manage tags for this package");
  }

  const result = await c.env.DB.prepare(
    "DELETE FROM dist_tags WHERE package_id = ? AND tag = ?",
  )
    .bind(pkg.id, tag)
    .run();

  if (!result.meta.changes) {
    throw notFound(`Tag '${tag}' not found`);
  }

  return c.json({ deleted: tag });
});

export default app;

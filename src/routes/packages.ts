import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { Visibility } from "../models/types";
import { notFound, badRequest, forbidden } from "../utils/errors";
import { getLatestVersion } from "../services/package";
import { authMiddleware, optionalAuth } from "../middleware/auth";
import { canPublish, getPublisherForScope, canAccessPackage } from "../services/publisher";
import { parseFullName } from "../utils/naming";
import { upsertSearchDigest } from "../services/publish";
import { getPackageAccess, grantPackageAccess, revokePackageAccess } from "../services/package-access";

const app = new Hono<AppEnv>();

// List packages
app.get("/v1/packages", optionalAuth, async (c) => {
  const type_ = c.req.query("type");
  const sort = c.req.query("sort") ?? "downloads";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20") || 20, 100);
  const offset = parseInt(c.req.query("offset") ?? "0") || 0;

  let query = "SELECT id, full_name, type, description, visibility, downloads, created_at, updated_at FROM packages";
  const params: unknown[] = [];
  const conditions: string[] = ["deleted_at IS NULL"];

  // Visibility: show public to all, plus private/unlisted to authorized publishers
  // For restricted private packages (with package_access rows), only show to
  // users in the ACL or org owner/admin — not to all org members.
  const user = c.get("user");
  if (user) {
    conditions.push(`(visibility = 'public' OR (
      publisher_id IN (
        SELECT id FROM publishers WHERE user_id = ? AND kind = 'user'
        UNION
        SELECT p.id FROM publishers p
        JOIN org_members m ON p.org_id = m.org_id
        WHERE m.user_id = ? AND p.kind = 'org'
      )
      AND (
        visibility != 'private'
        OR NOT EXISTS (SELECT 1 FROM package_access WHERE package_id = packages.id)
        OR EXISTS (SELECT 1 FROM package_access WHERE package_id = packages.id AND user_id = ?)
        OR publisher_id IN (
          SELECT p.id FROM publishers p
          JOIN org_members m ON p.org_id = m.org_id
          WHERE m.user_id = ? AND m.role IN ('owner', 'admin') AND p.kind = 'org'
        )
        OR publisher_id IN (
          SELECT id FROM publishers WHERE user_id = ? AND kind = 'user'
        )
      )
    ))`);
    params.push(user.id, user.id, user.id, user.id, user.id);
  } else {
    conditions.push("visibility = 'public'");
  }

  const category = c.req.query("category");

  if (type_) {
    conditions.push("type = ?");
    params.push(type_);
  }

  if (category) {
    conditions.push(`id IN (
      SELECT pc.package_id FROM package_categories pc
      JOIN categories cat ON pc.category_id = cat.id
      WHERE cat.slug = ?
    )`);
    params.push(category);
  }

  query += " WHERE " + conditions.join(" AND ");

  // Count total matching packages
  let countQuery = "SELECT COUNT(*) as count FROM packages WHERE " + conditions.join(" AND ");
  const countParams = [...params];

  const orderCol = sort === "created" ? "created_at" : "downloads";
  query += ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const [result, totalResult] = await Promise.all([
    c.env.DB.prepare(query).bind(...params).all(),
    c.env.DB.prepare(countQuery).bind(...countParams).first(),
  ]);

  // Get latest version for each package
  const packages = await Promise.all(
    (result.results ?? []).map(async (pkg: Record<string, unknown>) => {
      const ver = await getLatestVersion(c.env.DB, pkg.id as string);
      return {
        full_name: pkg.full_name,
        type: pkg.type,
        description: pkg.description,
        version: (ver?.version as string) ?? "",
        downloads: pkg.downloads,
        visibility: pkg.visibility ?? "public",
        repository: pkg.repository ?? "",
      };
    })
  );

  return c.json({ packages, total: (totalResult?.count as number) ?? 0 });
});

// Get package detail
app.get("/v1/packages/:fullName", optionalAuth, async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    `SELECT id, full_name, type, description, summary, capabilities, license,
            repository, homepage, author, keywords, platforms, downloads,
            visibility, publisher_id, created_at, updated_at
     FROM packages WHERE full_name = ? AND deleted_at IS NULL`
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Private packages: verify real auth + membership (return 404 to avoid leaking existence)
  const user = c.get("user");
  if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
    throw notFound(`Package ${fullName} not found`);
  }

  const versions = await c.env.DB.prepare(
    "SELECT version, yanked, created_at FROM versions WHERE package_id = ? ORDER BY created_at DESC"
  ).bind(pkg.id).all();

  // Fetch categories for this package
  const catResult = await c.env.DB.prepare(
    `SELECT cat.slug, cat.name FROM package_categories pc
     JOIN categories cat ON pc.category_id = cat.id
     WHERE pc.package_id = ?`
  ).bind(pkg.id).all();

  // Fetch publisher info
  const publisher = pkg.publisher_id
    ? await c.env.DB.prepare("SELECT slug, kind FROM publishers WHERE id = ?").bind(pkg.publisher_id).first()
    : null;

  // Fetch dist-tags
  const tagsResult = await c.env.DB.prepare(
    "SELECT dt.tag, v.version FROM dist_tags dt JOIN versions v ON dt.version_id = v.id WHERE dt.package_id = ?",
  ).bind(pkg.id).all();
  const distTags: Record<string, string> = {};
  for (const row of tagsResult.results ?? []) {
    distTags[row.tag as string] = row.version as string;
  }

  return c.json({
    full_name: pkg.full_name,
    type: pkg.type,
    description: pkg.description,
    summary: pkg.summary ?? "",
    capabilities: JSON.parse((pkg.capabilities as string) ?? "[]"),
    license: pkg.license,
    repository: pkg.repository,
    homepage: pkg.homepage ?? "",
    author: pkg.author ?? "",
    keywords: JSON.parse((pkg.keywords as string) ?? "[]"),
    platforms: JSON.parse((pkg.platforms as string) ?? "[]"),
    categories: (catResult.results ?? []).map((row) => ({ slug: row.slug, name: row.name })),
    downloads: pkg.downloads,
    visibility: pkg.visibility ?? "public",
    publisher: publisher ? { slug: publisher.slug, kind: publisher.kind } : null,
    dist_tags: distTags,
    versions: versions.results ?? [],
    created_at: pkg.created_at,
    updated_at: pkg.updated_at,
  });
});

// Get package versions
app.get("/v1/packages/:fullName/versions", optionalAuth, async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    "SELECT id, visibility, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL"
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const user = c.get("user");
  if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
    throw notFound(`Package ${fullName} not found`);
  }

  const versions = await c.env.DB.prepare(
    "SELECT version, yanked, sha256, created_at FROM versions WHERE package_id = ? ORDER BY created_at DESC"
  ).bind(pkg.id).all();

  return c.json({ versions: versions.results ?? [] });
});

// Get specific version
app.get("/v1/packages/:fullName/versions/:version", optionalAuth, async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName")!);
  const version = c.req.param("version");

  const pkg = await c.env.DB.prepare(
    "SELECT id, visibility, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL"
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const user = c.get("user");
  if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
    throw notFound(`Package ${fullName} not found`);
  }

  const ver = await c.env.DB.prepare(
    `SELECT v.version, v.manifest, v.readme, v.sha256, v.yanked, v.created_at,
            u.username AS publisher
     FROM versions v
     LEFT JOIN users u ON v.published_by = u.id
     WHERE v.package_id = ? AND v.version = ?`
  ).bind(pkg.id, version).first();

  if (!ver) throw notFound(`Version ${version} not found`);

  return c.json({
    version: ver.version,
    manifest: ver.manifest,
    readme: ver.readme,
    sha256: ver.sha256,
    yanked: ver.yanked === 1,
    published_by: (ver.publisher as string) ?? "[unknown]",
    created_at: ver.created_at,
  });
});

// Change package visibility
app.patch("/v1/packages/:fullName/visibility", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  let body: { visibility: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const visibility = body.visibility as Visibility;
  if (!["public", "unlisted", "private"].includes(visibility)) {
    throw badRequest("visibility must be public, unlisted, or private");
  }

  const pkg = await c.env.DB.prepare(
    "SELECT id, full_name, type, description, summary, keywords, capabilities, downloads, publisher_id, visibility, mutable FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Auth: must be publisher member
  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
  if (!publisher || !(await canPublish(c.env.DB, user.id, publisher))) {
    throw forbidden("You don't have permission to change visibility");
  }

  // Mutable constraint: mutable only allowed for private
  if (pkg.mutable && visibility !== "private") {
    throw badRequest("Mutable packages must remain private. Set mutable=false first.");
  }

  const oldVisibility = pkg.visibility as string;
  await c.env.DB.prepare(
    "UPDATE packages SET visibility = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(visibility, pkg.id).run();

  // Handle search_digest transitions
  if (oldVisibility === "private" && visibility !== "private") {
    // Became visible → create search_digest
    const latestVer = await getLatestVersion(c.env.DB, pkg.id as string);
    await upsertSearchDigest(
      c.env.DB, pkg.id as string, pkg.full_name as string, pkg.type as string,
      pkg.description as string, (pkg.summary as string) ?? "",
      (pkg.keywords as string) ?? "[]", (pkg.capabilities as string) ?? "[]",
      (latestVer?.version as string) ?? "", pkg.downloads as number, publisher.slug,
    );
  } else if (oldVisibility !== "private" && visibility === "private") {
    // Became private → remove from search
    await c.env.DB.prepare("DELETE FROM search_digest WHERE package_id = ?").bind(pkg.id).run();
  }

  return c.json({ full_name: fullName, visibility });
});

// Deprecate a package
app.patch("/v1/packages/:fullName/deprecation", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  let body: { message: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first();
  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
  if (!publisher || !(await canPublish(c.env.DB, user.id, publisher))) {
    throw forbidden("You don't have permission to deprecate this package");
  }

  await c.env.DB.prepare(
    "UPDATE packages SET deprecated_message = ?, deprecated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).bind(body.message ?? "This package is deprecated", pkg.id).run();

  return c.json({ full_name: fullName, deprecated: true, message: body.message });
});

// Soft-delete a package
app.delete("/v1/packages/:fullName", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first();
  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
  if (!publisher || !(await canPublish(c.env.DB, user.id, publisher))) {
    throw forbidden("You don't have permission to delete this package");
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE packages SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(pkg.id),
    c.env.DB.prepare("DELETE FROM search_digest WHERE package_id = ?").bind(pkg.id),
  ]);

  return c.json({ full_name: fullName, deleted: true });
});

// ============================================================
// PACKAGE ACCESS CONTROL (restricted visibility — per-user ACL)
// ============================================================

// Get package access list
app.get("/v1/packages/:fullName/access", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id, visibility FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Must be publisher member (owner/admin for org packages)
  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
  if (!publisher || !(await canPublish(c.env.DB, user.id, publisher))) {
    throw forbidden("You don't have permission to manage package access");
  }

  // For org publishers, only owner/admin can manage access
  if (publisher.kind === "org" && publisher.org_id) {
    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(publisher.org_id, user.id).first<{ role: string }>();

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw forbidden("Only owners and admins can manage package access");
    }
  }

  const accessList = await getPackageAccess(c.env.DB, pkg.id as string);
  return c.json({ access: accessList });
});

// Update package access list (add/remove users)
app.patch("/v1/packages/:fullName/access", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  let body: { add?: string[]; remove?: string[] };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.add?.length && !body.remove?.length) {
    throw badRequest("Must provide add or remove arrays");
  }

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id, visibility FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  if (pkg.visibility !== "private") {
    throw badRequest("Package access control only applies to private packages");
  }

  // Must be org owner/admin
  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);

  if (!publisher || publisher.kind !== "org" || !publisher.org_id) {
    throw badRequest("Package access control only applies to organization packages");
  }

  const membership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(publisher.org_id, user.id).first<{ role: string }>();

  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw forbidden("Only owners and admins can manage package access");
  }

  // Resolve usernames to user IDs and validate they are org members
  const added: string[] = [];
  if (body.add?.length) {
    for (const username of body.add) {
      const targetUser = await c.env.DB.prepare(
        "SELECT id FROM users WHERE username = ?",
      ).bind(username).first<{ id: string }>();
      if (!targetUser) throw notFound(`User ${username} not found`);

      const isMember = await c.env.DB.prepare(
        "SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?",
      ).bind(publisher.org_id, targetUser.id).first();
      if (!isMember) throw badRequest(`${username} is not a member of the organization`);

      added.push(targetUser.id);
    }
    await grantPackageAccess(c.env.DB, pkg.id as string, added, user.id);
  }

  const removed: string[] = [];
  if (body.remove?.length) {
    for (const username of body.remove) {
      const targetUser = await c.env.DB.prepare(
        "SELECT id FROM users WHERE username = ?",
      ).bind(username).first<{ id: string }>();
      if (!targetUser) continue; // silently skip unknown users on remove
      removed.push(targetUser.id);
    }
    await revokePackageAccess(c.env.DB, pkg.id as string, removed);
  }

  return c.json({ added: body.add ?? [], removed: body.remove ?? [] });
});

export default app;

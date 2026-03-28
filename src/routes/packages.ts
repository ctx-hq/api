import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { notFound, badRequest } from "../utils/errors";
import { getLatestVersion } from "../services/package";

const app = new Hono<AppEnv>();

// List packages
app.get("/v1/packages", async (c) => {
  const type_ = c.req.query("type");
  const sort = c.req.query("sort") ?? "downloads";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20") || 20, 100);
  const offset = parseInt(c.req.query("offset") ?? "0") || 0;

  let query = "SELECT id, full_name, type, description, downloads, created_at, updated_at FROM packages";
  const params: unknown[] = [];
  const conditions: string[] = [];

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

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  // Count total matching packages
  let countQuery = "SELECT COUNT(*) as count FROM packages";
  if (conditions.length > 0) {
    countQuery += " WHERE " + conditions.join(" AND ");
  }
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
        repository: pkg.repository ?? "",
      };
    })
  );

  return c.json({ packages, total: (totalResult?.count as number) ?? 0 });
});

// Get package detail
app.get("/v1/packages/:fullName", async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName"));

  const pkg = await c.env.DB.prepare(
    `SELECT id, full_name, type, description, summary, capabilities, license,
            repository, homepage, author, keywords, platforms, downloads,
            created_at, updated_at
     FROM packages WHERE full_name = ?`
  ).bind(fullName).first();

  if (!pkg) {
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
    versions: versions.results ?? [],
    created_at: pkg.created_at,
    updated_at: pkg.updated_at,
  });
});

// Get package versions
app.get("/v1/packages/:fullName/versions", async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName"));

  const pkg = await c.env.DB.prepare(
    "SELECT id FROM packages WHERE full_name = ?"
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const versions = await c.env.DB.prepare(
    "SELECT version, yanked, sha256, created_at FROM versions WHERE package_id = ? ORDER BY created_at DESC"
  ).bind(pkg.id).all();

  return c.json({ versions: versions.results ?? [] });
});

// Get specific version
app.get("/v1/packages/:fullName/versions/:version", async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName"));
  const version = c.req.param("version");

  const pkg = await c.env.DB.prepare(
    "SELECT id FROM packages WHERE full_name = ?"
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

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

export default app;

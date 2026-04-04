import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { seedCategories, listCategories } from "../services/categories";
import { notFound } from "../utils/errors";

const app = new Hono<AppEnv>();

// List all categories with package counts.
app.get("/v1/categories", async (c) => {
  const categories = await listCategories(c.env.DB, true);
  return c.json({ categories });
});

// List popular keywords — only counts public packages.
app.get("/v1/keywords", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 200);

  const result = await c.env.DB.prepare(
    `SELECT k.slug, COUNT(pk.package_id) AS usage_count
     FROM keywords k
     JOIN package_keywords pk ON k.id = pk.keyword_id
     JOIN packages p ON pk.package_id = p.id
     WHERE p.visibility = 'public' AND p.deleted_at IS NULL
     GROUP BY k.slug
     HAVING COUNT(pk.package_id) > 0
     ORDER BY usage_count DESC
     LIMIT ?`
  ).bind(limit).all();

  return c.json({ keywords: result.results ?? [] });
});

// Get keyword detail with associated public packages (paginated).
app.get("/v1/keywords/:slug", async (c) => {
  const slug = c.req.param("slug")!;
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20") || 20, 100);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0") || 0, 0);

  // Check keyword exists and get public usage count
  const kwRow = await c.env.DB.prepare(
    `SELECT k.slug, COUNT(pk.package_id) AS usage_count
     FROM keywords k
     JOIN package_keywords pk ON k.id = pk.keyword_id
     JOIN packages p ON pk.package_id = p.id
     WHERE k.slug = ? AND p.visibility = 'public' AND p.deleted_at IS NULL
     GROUP BY k.slug`
  ).bind(slug).first();

  // No public packages associated — return 404 regardless of whether the
  // keyword row exists, to avoid leaking private-only keyword existence.
  if (!kwRow) {
    throw notFound(`Keyword "${slug}" not found`);
  }

  // Fetch paginated public packages for this keyword
  const pkgResult = await c.env.DB.prepare(
    `SELECT p.full_name, p.type, p.description, p.summary, p.downloads,
            p.star_count, p.updated_at, v.version AS latest_version
     FROM packages p
     JOIN package_keywords pk ON p.id = pk.package_id
     JOIN keywords k ON pk.keyword_id = k.id
     LEFT JOIN dist_tags dt ON dt.package_id = p.id AND dt.tag = 'latest'
     LEFT JOIN versions v ON v.id = dt.version_id
     WHERE k.slug = ? AND p.visibility = 'public' AND p.deleted_at IS NULL
     ORDER BY p.downloads DESC
     LIMIT ? OFFSET ?`
  ).bind(slug, limit, offset).all();

  const packages = (pkgResult.results ?? []).map((row) => ({
    full_name: row.full_name as string,
    type: row.type as string,
    description: (row.description as string) ?? "",
    summary: (row.summary as string) ?? "",
    version: (row.latest_version as string) ?? "",
    downloads: row.downloads as number,
    star_count: (row.star_count as number) ?? 0,
  }));

  return c.json({
    keyword: { slug: kwRow.slug as string, usage_count: kwRow.usage_count as number },
    packages,
    total: kwRow.usage_count as number,
  });
});

// Admin: seed categories (idempotent).
app.post("/v1/categories/seed", authMiddleware, adminMiddleware, async (c) => {
  const seeded = await seedCategories(c.env.DB);
  return c.json({ seeded });
});

export default app;

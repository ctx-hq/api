import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { notFound } from "../utils/errors";
import { getPublisherBySlug } from "../services/publisher";

const app = new Hono<AppEnv>();

// Get publisher profile
app.get("/v1/publishers/:slug", async (c) => {
  const slug = c.req.param("slug");
  const publisher = await getPublisherBySlug(c.env.DB, slug);

  if (!publisher) throw notFound(`Publisher @${slug} not found`);

  const packageCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM packages WHERE publisher_id = ? AND visibility = 'public' AND deleted_at IS NULL",
  )
    .bind(publisher.id)
    .first<{ count: number }>();

  return c.json({
    slug: publisher.slug,
    kind: publisher.kind,
    packages: packageCount?.count ?? 0,
    created_at: publisher.created_at,
  });
});

// List publisher's packages
app.get("/v1/publishers/:slug/packages", async (c) => {
  const slug = c.req.param("slug");
  const publisher = await getPublisherBySlug(c.env.DB, slug);

  if (!publisher) throw notFound(`Publisher @${slug} not found`);

  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 100);
  const offset = parseInt(c.req.query("offset") ?? "0");
  const type_ = c.req.query("type");

  let baseWhere = "p.publisher_id = ? AND p.visibility = 'public' AND p.deleted_at IS NULL";
  const baseParams: unknown[] = [publisher.id];

  if (type_) {
    baseWhere += " AND p.type = ?";
    baseParams.push(type_);
  }

  const [countResult, packages] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) as count FROM packages p WHERE ${baseWhere}`)
      .bind(...baseParams)
      .first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT p.full_name, p.type, p.description, p.summary, p.downloads,
              p.visibility, p.created_at, p.updated_at
       FROM packages p WHERE ${baseWhere}
       ORDER BY p.downloads DESC LIMIT ? OFFSET ?`,
    )
      .bind(...baseParams, limit, offset)
      .all(),
  ]);

  return c.json({
    publisher: { slug: publisher.slug, kind: publisher.kind },
    packages: packages.results ?? [],
    total: countResult?.count ?? 0,
  });
});

export default app;

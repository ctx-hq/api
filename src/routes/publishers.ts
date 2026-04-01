import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { notFound } from "../utils/errors";
import { optionalAuth } from "../middleware/auth";
import { getPublisherBySlug, isMemberOfPublisher } from "../services/publisher";

const app = new Hono<AppEnv>();

// Get publisher profile
app.get("/v1/publishers/:slug", optionalAuth, async (c) => {
  const slug = c.req.param("slug")!;
  const publisher = await getPublisherBySlug(c.env.DB, slug);

  if (!publisher) throw notFound(`Publisher @${slug} not found`);

  // Members see total count; others see only public count
  const user = c.get("user");
  const isMember = user ? await isMemberOfPublisher(c.env.DB, user.id, publisher) : false;
  const countWhere = isMember
    ? "publisher_id = ? AND deleted_at IS NULL"
    : "publisher_id = ? AND visibility = 'public' AND deleted_at IS NULL";

  const [packageCount, downloadSum, profileInfo] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM packages WHERE ${countWhere}`,
    ).bind(publisher.id).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(downloads), 0) as total FROM packages WHERE ${countWhere}`,
    ).bind(publisher.id).first<{ total: number }>(),
    publisher.kind === "user" && publisher.user_id
      ? c.env.DB.prepare(
          "SELECT avatar_url, bio, website FROM users WHERE id = ?",
        ).bind(publisher.user_id).first<{ avatar_url: string; bio: string; website: string }>()
      : Promise.resolve(null),
  ]);

  const response: Record<string, unknown> = {
    slug: publisher.slug,
    kind: publisher.kind,
    packages: packageCount?.count ?? 0,
    total_downloads: downloadSum?.total ?? 0,
    created_at: publisher.created_at,
  };

  if (profileInfo) {
    response.avatar_url = profileInfo.avatar_url ?? "";
    response.bio = profileInfo.bio ?? "";
    response.website = profileInfo.website ?? "";
  }

  return c.json(response);
});

// List publisher's packages
app.get("/v1/publishers/:slug/packages", optionalAuth, async (c) => {
  const slug = c.req.param("slug")!;
  const publisher = await getPublisherBySlug(c.env.DB, slug);

  if (!publisher) throw notFound(`Publisher @${slug} not found`);

  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 100);
  const offset = parseInt(c.req.query("offset") ?? "0");
  const type_ = c.req.query("type");

  // Members see all visibility levels; others see only public
  const user = c.get("user");
  const isMember = user ? await isMemberOfPublisher(c.env.DB, user.id, publisher) : false;

  const conditions: string[] = ["p.publisher_id = ?", "p.deleted_at IS NULL"];
  const baseParams: unknown[] = [publisher.id];
  if (!isMember) {
    conditions.push("p.visibility = 'public'");
  }

  if (type_) {
    conditions.push("p.type = ?");
    baseParams.push(type_);
  }

  const baseWhere = conditions.join(" AND ");
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

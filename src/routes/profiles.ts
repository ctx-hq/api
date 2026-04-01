import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { notFound } from "../utils/errors";
import { optionalAuth } from "../middleware/auth";
import { isMemberOfOwner, resolveOwnerBySlug } from "../services/ownership";

const app = new Hono<AppEnv>();

// Get profile by slug (user or org)
app.get("/v1/profiles/:slug", optionalAuth, async (c) => {
  const slug = c.req.param("slug")!;

  const owner = await resolveOwnerBySlug(c.env.DB, slug);
  if (!owner) throw notFound(`Profile @${slug} not found`);

  // Fetch profile details (user-specific fields)
  let profileInfo: { avatar_url: string; bio: string; website: string; created_at: string } | null = null;
  let createdAt: string;

  if (owner.owner_type === "user") {
    const userRow = await c.env.DB.prepare(
      "SELECT avatar_url, bio, website, created_at FROM users WHERE id = ?",
    ).bind(owner.owner_id).first<{ avatar_url: string; bio: string; website: string; created_at: string }>();

    createdAt = userRow?.created_at ?? "";
    profileInfo = {
      avatar_url: userRow?.avatar_url ?? "",
      bio: userRow?.bio ?? "",
      website: userRow?.website ?? "",
      created_at: createdAt,
    };
  } else {
    const orgRow = await c.env.DB.prepare(
      "SELECT created_at FROM orgs WHERE id = ?",
    ).bind(owner.owner_id).first<{ created_at: string }>();

    createdAt = orgRow?.created_at ?? "";
  }

  // Members see total count; others see only public count
  const user = c.get("user");
  const isMember = user ? await isMemberOfOwner(c.env.DB, user.id, owner) : false;

  const countWhere = isMember
    ? "owner_type = ? AND owner_id = ? AND deleted_at IS NULL"
    : "owner_type = ? AND owner_id = ? AND visibility = 'public' AND deleted_at IS NULL";

  const [packageCount, downloadSum] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM packages WHERE ${countWhere}`,
    ).bind(owner.owner_type, owner.owner_id).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(downloads), 0) as total FROM packages WHERE ${countWhere}`,
    ).bind(owner.owner_type, owner.owner_id).first<{ total: number }>(),
  ]);

  const response: Record<string, unknown> = {
    slug,
    kind: owner.owner_type,
    packages: packageCount?.count ?? 0,
    total_downloads: downloadSum?.total ?? 0,
    created_at: createdAt,
  };

  if (profileInfo) {
    response.avatar_url = profileInfo.avatar_url;
    response.bio = profileInfo.bio;
    response.website = profileInfo.website;
  }

  return c.json(response);
});

// List profile's packages
app.get("/v1/profiles/:slug/packages", optionalAuth, async (c) => {
  const slug = c.req.param("slug")!;

  const owner = await resolveOwnerBySlug(c.env.DB, slug);
  if (!owner) throw notFound(`Profile @${slug} not found`);

  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 100);
  const offset = parseInt(c.req.query("offset") ?? "0");
  const type_ = c.req.query("type");

  // Members see all visibility levels; others see only public
  const user = c.get("user");
  const isMember = user ? await isMemberOfOwner(c.env.DB, user.id, owner) : false;

  const conditions: string[] = ["p.owner_type = ?", "p.owner_id = ?", "p.deleted_at IS NULL"];
  const baseParams: unknown[] = [owner.owner_type, owner.owner_id];
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
              p.visibility, p.created_at, p.updated_at,
              (SELECT v.version FROM versions v WHERE v.package_id = p.id ORDER BY v.created_at DESC LIMIT 1) AS version
       FROM packages p WHERE ${baseWhere}
       ORDER BY p.downloads DESC LIMIT ? OFFSET ?`,
    )
      .bind(...baseParams, limit, offset)
      .all(),
  ]);

  return c.json({
    owner: { slug, kind: owner.owner_type },
    packages: packages.results ?? [],
    total: countResult?.count ?? 0,
  });
});

export default app;

import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { notFound } from "../utils/errors";
import { generateId } from "../utils/response";
import { optionalAuth } from "../middleware/auth";
import { canAccessPackage } from "../services/publisher";

const app = new Hono<AppEnv>();

// Registry overview (aggregate stats)
app.get("/v1/stats/overview", async (c) => {
  const [packagesResult, downloadsResult, publishersResult, breakdownResult] =
    await Promise.all([
      c.env.DB.prepare(
        "SELECT COUNT(*) as count FROM packages WHERE visibility = 'public' AND deleted_at IS NULL",
      )
        .first<{ count: number }>(),

      c.env.DB.prepare(
        `SELECT COALESCE(SUM(ds.count), 0) as total FROM download_stats ds
         JOIN packages p ON ds.package_id = p.id
         WHERE p.visibility = 'public' AND p.deleted_at IS NULL`,
      )
        .first<{ total: number }>(),

      c.env.DB.prepare(
        "SELECT COUNT(DISTINCT publisher_id) as count FROM packages WHERE visibility = 'public' AND deleted_at IS NULL AND publisher_id != ''",
      )
        .first<{ count: number }>(),

      c.env.DB.prepare(
        `SELECT type, COUNT(*) as count FROM packages
         WHERE visibility = 'public' AND deleted_at IS NULL
         GROUP BY type ORDER BY count DESC`,
      ).all(),
    ]);

  const totalPackages = packagesResult?.count ?? 0;
  const breakdown = (breakdownResult.results ?? []).map((r) => ({
    type: r.type as string,
    count: r.count as number,
    percentage:
      totalPackages > 0
        ? Math.round(((r.count as number) / totalPackages) * 1000) / 10
        : 0,
  }));

  return c.json({
    total_packages: totalPackages,
    total_downloads: downloadsResult?.total ?? 0,
    total_publishers: publishersResult?.count ?? 0,
    breakdown,
  });
});

// Package stats (daily/weekly + agent breakdown)
app.get("/v1/packages/:fullName/stats", optionalAuth, async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    "SELECT id, downloads, visibility, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  )
    .bind(fullName)
    .first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Visibility guard
  const user = c.get("user");
  if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
    throw notFound(`Package ${fullName} not found`);
  }

  const pkgId = pkg.id as string;

  // Daily downloads (last 30 days)
  const daily = await c.env.DB.prepare(
    `SELECT date, SUM(count) as count FROM download_stats
     WHERE package_id = ? AND date >= date('now', '-30 days')
     GROUP BY date ORDER BY date`,
  )
    .bind(pkgId)
    .all();

  // Weekly total
  const weeklyResult = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(count), 0) as total FROM download_stats
     WHERE package_id = ? AND date >= date('now', '-7 days')`,
  )
    .bind(pkgId)
    .first<{ total: number }>();

  // Agent breakdown
  const agents = await c.env.DB.prepare(
    `SELECT agent_name, SUM(count) as count FROM agent_installs
     WHERE package_id = ?
     GROUP BY agent_name ORDER BY count DESC`,
  )
    .bind(pkgId)
    .all();

  const totalInstalls = (agents.results ?? []).reduce(
    (sum, r) => sum + (r.count as number),
    0,
  );

  const agentBreakdown = (agents.results ?? []).map((r) => ({
    agent: r.agent_name,
    count: r.count,
    percentage: totalInstalls > 0
      ? Math.round(((r.count as number) / totalInstalls) * 1000) / 10
      : 0,
  }));

  return c.json({
    downloads: {
      total: pkg.downloads,
      weekly: weeklyResult?.total ?? 0,
      daily: daily.results ?? [],
    },
    agents: {
      total_installs: totalInstalls,
      breakdown: agentBreakdown,
    },
  });
});

// Trending packages (7-day top downloads)
app.get("/v1/stats/trending", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);

  const trending = await c.env.DB.prepare(
    `SELECT ds.package_id, SUM(ds.count) as weekly_downloads,
            p.full_name, p.type, p.description, p.downloads,
            (SELECT v.version FROM versions v WHERE v.package_id = p.id ORDER BY v.created_at DESC LIMIT 1) AS version
     FROM download_stats ds
     JOIN packages p ON ds.package_id = p.id
     WHERE ds.date >= date('now', '-7 days')
       AND p.visibility = 'public' AND p.deleted_at IS NULL
     GROUP BY ds.package_id
     ORDER BY weekly_downloads DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();

  return c.json({
    packages: trending.results ?? [],
    period: "7d",
  });
});

// Agent popularity ranking
app.get("/v1/stats/agents", async (c) => {
  const agents = await c.env.DB.prepare(
    `SELECT agent_name as name,
            SUM(count) as total_installs,
            COUNT(DISTINCT package_id) as packages
     FROM agent_installs
     GROUP BY agent_name
     ORDER BY total_installs DESC`,
  ).all();

  return c.json({ agents: agents.results ?? [] });
});

// Specific agent's top packages
app.get("/v1/stats/agents/:agent", async (c) => {
  const agent = c.req.param("agent");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);

  const totalResult = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(count), 0) as total FROM agent_installs WHERE agent_name = ?",
  )
    .bind(agent)
    .first<{ total: number }>();

  const top = await c.env.DB.prepare(
    `SELECT ai.package_id, SUM(ai.count) as installs, p.full_name, p.type
     FROM agent_installs ai
     JOIN packages p ON ai.package_id = p.id
     WHERE ai.agent_name = ? AND p.visibility = 'public' AND p.deleted_at IS NULL
     GROUP BY ai.package_id
     ORDER BY installs DESC
     LIMIT ?`,
  )
    .bind(agent, limit)
    .all();

  const total = totalResult?.total ?? 0;
  const topPackages = (top.results ?? []).map((r) => ({
    full_name: r.full_name,
    type: r.type,
    installs: r.installs,
    percentage: total > 0
      ? Math.round(((r.installs as number) / total) * 1000) / 10
      : 0,
  }));

  return c.json({
    agent,
    total_installs: total,
    top_packages: topPackages,
  });
});

// Telemetry: report install + agents (rate-limited per IP)
app.post("/v1/telemetry/install", async (c) => {
  // Rate limit telemetry: max 60 reports per minute per IP
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const rlKey = `rl:telemetry:${ip}`;
  const current = await c.env.CACHE.get(rlKey);
  const count = current ? (parseInt(current) || 0) : 0;
  if (count >= 60) {
    return c.json({ ok: true }); // silently drop over-limit
  }
  c.executionCtx.waitUntil(
    c.env.CACHE.put(rlKey, String(count + 1), { expirationTtl: 60 }),
  );

  let body: {
    package: string;
    version?: string;
    agents?: string[];
    source_type?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: true }); // silently accept malformed telemetry
  }

  if (!body.package) return c.json({ ok: true });

  const pkg = await c.env.DB.prepare(
    "SELECT id, visibility FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  )
    .bind(body.package)
    .first();

  // Only track public/unlisted packages; don't track private or nonexistent
  if (!pkg || pkg.visibility === "private") return c.json({ ok: true });

  const pkgId = pkg.id as string;
  const today = new Date().toISOString().slice(0, 10);

  // Record download stat
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO download_stats (id, package_id, version, date, count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (package_id, version, date) DO UPDATE SET count = count + 1`,
    )
      .bind(generateId(), pkgId, body.version ?? "", today)
      .run(),
  );

  // Record per-agent installs
  if (body.agents && body.agents.length > 0) {
    // Cap agents array to prevent abuse
    const agents = body.agents.slice(0, 10);
    const stmts = agents.map((agent) =>
      c.env.DB.prepare(
        `INSERT INTO agent_installs (id, package_id, agent_name, date, count)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (package_id, agent_name, date) DO UPDATE SET count = count + 1`,
      ).bind(generateId(), pkgId, agent, today),
    );

    c.executionCtx.waitUntil(c.env.DB.batch(stmts));
  }

  return c.json({ ok: true });
});

export default app;

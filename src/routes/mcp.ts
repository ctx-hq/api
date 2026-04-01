import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { notFound } from "../utils/errors";
import { parseJsonArray } from "../utils/response";
import { CATEGORIES } from "../services/categories";

const app = new Hono<AppEnv>();

// --- Shared row mapper ---
function mapServerRow(row: Record<string, unknown>) {
  return {
    full_name: row.full_name,
    description: row.description ?? "",
    transport: row.transport ?? "stdio",
    tools_count: parseJsonArray(row.tools as string).length,
    downloads: row.downloads as number,
    owner_slug: row.owner_slug ?? "",
    category: row.category ?? "other",
    version: row.version ?? "",
  };
}

// -------------------------------------------------------------------
// GET /v1/mcp/hub — Paginated MCP server listing with category filter
// -------------------------------------------------------------------
app.get("/v1/mcp/hub", async (c) => {
  const category = c.req.query("category") ?? "";
  const sort = c.req.query("sort") ?? "downloads";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "18", 10), 100);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);

  // Build ORDER BY clause
  let orderBy: string;
  switch (sort) {
    case "newest":
      orderBy = "p.created_at DESC";
      break;
    case "recommended":
      orderBy = "p.downloads DESC, p.created_at DESC";
      break;
    default: // "downloads"
      orderBy = "p.downloads DESC";
  }

  // Build WHERE clause
  const conditions = [
    "p.type = 'mcp'",
    "p.visibility = 'public'",
    "p.deleted_at IS NULL",
  ];
  const binds: unknown[] = [];

  if (category) {
    conditions.push("mm.category = ?");
    binds.push(category);
  }

  const where = conditions.join(" AND ");

  // Fetch servers
  const serversQuery = `
    SELECT p.full_name, p.description, p.downloads, p.created_at,
           mm.transport, mm.tools, mm.category,
           COALESCE(u.username, o.name, 'system') as owner_slug,
           v.version
    FROM packages p
    JOIN dist_tags dt ON dt.package_id = p.id AND dt.tag = 'latest'
    JOIN versions v ON dt.version_id = v.id
    LEFT JOIN mcp_metadata mm ON mm.version_id = v.id
    LEFT JOIN users u ON p.owner_type = 'user' AND p.owner_id = u.id
    LEFT JOIN orgs o ON p.owner_type = 'org' AND p.owner_id = o.id
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const countQuery = `
    SELECT COUNT(*) as count
    FROM packages p
    JOIN dist_tags dt ON dt.package_id = p.id AND dt.tag = 'latest'
    JOIN versions v ON dt.version_id = v.id
    LEFT JOIN mcp_metadata mm ON mm.version_id = v.id
    WHERE ${where}
  `;

  // Count binds = conditions only, servers binds = conditions + limit/offset
  const countBinds = [...binds];
  binds.push(limit, offset);

  const [serversResult, countResult, categoriesResult] = await Promise.all([
    c.env.DB.prepare(serversQuery).bind(...binds).all(),
    c.env.DB.prepare(countQuery).bind(...countBinds).first<{ count: number }>(),
    getMCPCategoryCounts(c.env.DB),
  ]);

  return c.json({
    servers: (serversResult.results ?? []).map(mapServerRow),
    total: countResult?.count ?? 0,
    categories: categoriesResult,
  });
});

// -------------------------------------------------------------------
// GET /v1/mcp/featured — Top MCP servers by downloads
// -------------------------------------------------------------------
app.get("/v1/mcp/featured", async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT p.full_name, p.description, p.downloads,
           mm.transport, mm.tools, mm.category,
           COALESCE(u.username, o.name, 'system') as owner_slug,
           v.version
    FROM packages p
    JOIN dist_tags dt ON dt.package_id = p.id AND dt.tag = 'latest'
    JOIN versions v ON dt.version_id = v.id
    LEFT JOIN mcp_metadata mm ON mm.version_id = v.id
    LEFT JOIN users u ON p.owner_type = 'user' AND p.owner_id = u.id
    LEFT JOIN orgs o ON p.owner_type = 'org' AND p.owner_id = o.id
    WHERE p.type = 'mcp' AND p.visibility = 'public' AND p.deleted_at IS NULL
    ORDER BY p.downloads DESC
    LIMIT 6
  `).all();

  return c.json({ servers: (result.results ?? []).map(mapServerRow) });
});

// -------------------------------------------------------------------
// GET /v1/mcp/categories — Category list with package counts
// -------------------------------------------------------------------
app.get("/v1/mcp/categories", async (c) => {
  const categories = await getMCPCategoryCounts(c.env.DB);
  return c.json({ categories });
});

// -------------------------------------------------------------------
// GET /v1/packages/:fullName/server.json — MCP Registry compatible export
// -------------------------------------------------------------------
app.get("/v1/packages/:fullName/server.json", async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    `SELECT id, full_name, type, description, repository, homepage
     FROM packages WHERE full_name = ? AND deleted_at IS NULL AND visibility = 'public'`,
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);
  if (pkg.type !== "mcp") throw notFound(`Package ${fullName} is not an MCP server`);

  // Get latest version + mcp_metadata
  const versionRow = await c.env.DB.prepare(`
    SELECT v.version, mm.transport, mm.command, mm.args, mm.url,
           mm.env_vars, mm.tools, mm.resources
    FROM dist_tags dt
    JOIN versions v ON dt.version_id = v.id
    LEFT JOIN mcp_metadata mm ON mm.version_id = v.id
    WHERE dt.package_id = ? AND dt.tag = 'latest'
  `).bind(pkg.id).first();

  if (!versionRow) throw notFound(`No published version for ${fullName}`);

  // Build server.json following the official MCP Registry schema
  const serverJson: Record<string, unknown> = {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-11-25/server.schema.json",
    name: pkg.full_name,
    description: pkg.description ?? "",
    version: versionRow.version ?? "",
    repository: pkg.repository ?? undefined,
    homepage: pkg.homepage ?? undefined,
  };

  // Add packages section for transport info
  const transport = (versionRow.transport as string) ?? "stdio";
  const command = versionRow.command as string;
  const args = parseJsonArray(versionRow.args as string);
  const url = versionRow.url as string;
  const envVars = parseJsonArray(versionRow.env_vars as string);
  const tools = parseJsonArray(versionRow.tools as string);
  const resources = parseJsonArray(versionRow.resources as string);

  if (transport === "stdio" && command) {
    serverJson.packages = [{
      registryType: "npm",
      transport: { type: "stdio" },
      command,
      args,
    }];
  } else if (url) {
    serverJson.packages = [{
      registryType: "npm",
      transport: { type: transport, url },
    }];
  }

  if (envVars.length > 0) serverJson.env = envVars;
  if (tools.length > 0) serverJson.tools = tools;
  if (resources.length > 0) serverJson.resources = resources;

  c.header("Content-Type", "application/json");
  return c.json(serverJson);
});

// --- Helpers ---

async function getMCPCategoryCounts(db: D1Database) {
  const result = await db.prepare(`
    SELECT mm.category, COUNT(DISTINCT p.id) as count
    FROM mcp_metadata mm
    JOIN versions v ON mm.version_id = v.id
    JOIN dist_tags dt ON dt.version_id = v.id AND dt.tag = 'latest'
    JOIN packages p ON v.package_id = p.id
    WHERE p.deleted_at IS NULL AND p.visibility = 'public' AND p.type = 'mcp'
    GROUP BY mm.category
    ORDER BY count DESC
  `).all();

  // Map slugs to display names from CATEGORIES
  const nameMap = new Map(CATEGORIES.map((c) => [c.slug, c.name]));

  return (result.results ?? [])
    .filter((row) => (row.category as string) !== "")
    .map((row) => ({
      slug: row.category as string,
      name: nameMap.get(row.category as string) ?? (row.category as string),
      count: row.count as number,
    }));
}

export default app;

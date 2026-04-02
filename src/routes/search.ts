import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { badRequest } from "../utils/errors";
import { searchPackages, type SearchMode } from "../services/search";

const app = new Hono<AppEnv>();

app.get("/v1/search", async (c) => {
  const query = c.req.query("q")?.trim();
  const type_ = c.req.query("type");
  const category = c.req.query("category");
  const keyword = c.req.query("keyword");
  const mode = (c.req.query("mode") ?? "hybrid") as SearchMode;
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20") || 20, 100);

  if (!query) {
    throw badRequest("Query parameter 'q' is required");
  }

  if (!["fts", "vector", "hybrid"].includes(mode)) {
    throw badRequest("Invalid mode. Use: fts, vector, or hybrid");
  }

  // When post-filtering by category/keyword, over-fetch to compensate for filtering loss
  const searchLimit = (category || keyword) ? Math.min(limit * 3, 100) : limit;
  const result = await searchPackages(c.env, { query, mode, type: type_, limit: searchLimit });

  // Post-filter by category and/or keyword if specified
  if ((category || keyword) && result.packages.length > 0) {
    const fullNames = result.packages.map((p) => p.full_name);
    const placeholders = fullNames.map(() => "?").join(",");

    // Build filter queries in parallel
    const filterQueries: Promise<Set<string>>[] = [];

    if (category) {
      filterQueries.push(
        c.env.DB.prepare(
          `SELECT p.full_name FROM packages p
           JOIN package_categories pc ON p.id = pc.package_id
           JOIN categories cat ON pc.category_id = cat.id
           WHERE cat.slug = ? AND p.full_name IN (${placeholders})`
        ).bind(category, ...fullNames).all()
          .then((r) => new Set((r.results ?? []).map((row) => row.full_name as string))),
      );
    }

    if (keyword) {
      filterQueries.push(
        c.env.DB.prepare(
          `SELECT p.full_name FROM packages p
           JOIN package_keywords pk ON p.id = pk.package_id
           JOIN keywords k ON pk.keyword_id = k.id
           WHERE k.slug = ? AND p.full_name IN (${placeholders})`
        ).bind(keyword, ...fullNames).all()
          .then((r) => new Set((r.results ?? []).map((row) => row.full_name as string))),
      );
    }

    const filterSets = await Promise.all(filterQueries);
    // Intersect all filter sets
    let validNames = filterSets[0];
    for (let i = 1; i < filterSets.length; i++) {
      validNames = new Set([...validNames].filter((n) => filterSets[i].has(n)));
    }

    const filtered = result.packages
      .filter((p) => validNames.has(p.full_name))
      .slice(0, limit);
    return c.json({ packages: filtered, total: filtered.length });
  }

  return c.json(result);
});

export default app;

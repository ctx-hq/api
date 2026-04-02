import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { seedCategories, listCategories } from "../services/categories";

const app = new Hono<AppEnv>();

// List all categories with package counts.
app.get("/v1/categories", async (c) => {
  const categories = await listCategories(c.env.DB, true);
  return c.json({ categories });
});

// List popular keywords by usage_count.
app.get("/v1/keywords", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 200);

  const result = await c.env.DB.prepare(
    "SELECT slug, usage_count FROM keywords WHERE usage_count > 0 ORDER BY usage_count DESC LIMIT ?"
  ).bind(limit).all();

  return c.json({ keywords: result.results ?? [] });
});

// Admin: seed categories (idempotent).
app.post("/v1/categories/seed", authMiddleware, adminMiddleware, async (c) => {
  const seeded = await seedCategories(c.env.DB);
  return c.json({ seeded });
});

export default app;

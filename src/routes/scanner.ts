import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { runScanner, importCandidate } from "../services/scanner";
import type { ScannerCandidate } from "../services/scanner";

const app = new Hono<AppEnv>();

// List scanner sources
app.get("/v1/scanner/sources", authMiddleware, async (c) => {
  const sources = await c.env.DB.prepare(
    "SELECT id, type, source_key, enabled, total_found, last_scanned, created_at FROM scanner_sources ORDER BY created_at"
  ).all();
  return c.json({ sources: sources.results ?? [] });
});

// Trigger a scan run manually
app.post("/v1/scanner/run", authMiddleware, adminMiddleware, async (c) => {
  const result = await runScanner(c.env);
  return c.json(result);
});

// List candidates with filtering
app.get("/v1/scanner/candidates", authMiddleware, async (c) => {
  const status = c.req.query("status") ?? "pending";
  const type_ = c.req.query("type");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 200);

  let sql = `SELECT id, external_url, detected_type, detected_name, status,
                    confidence, stars, license, last_checked
             FROM scanner_candidates WHERE status = ?`;
  const params: unknown[] = [status];

  if (type_) {
    sql += " AND detected_type = ?";
    params.push(type_);
  }

  sql += " ORDER BY confidence DESC, stars DESC LIMIT ?";
  params.push(limit);

  const result = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ candidates: result.results ?? [], total: result.results?.length ?? 0 });
});

// Get single candidate detail
app.get("/v1/scanner/candidates/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const candidate = await c.env.DB.prepare(
    `SELECT external_url, external_id, detected_type, detected_name,
            generated_manifest, status, confidence, stars, license, last_checked
     FROM scanner_candidates WHERE id = ?`
  ).bind(id).first();

  if (!candidate) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(candidate);
});

// Approve a candidate — imports it as a @community/ package
app.post("/v1/scanner/candidates/:id/approve", authMiddleware, adminMiddleware, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const candidate = await c.env.DB.prepare(
    "SELECT * FROM scanner_candidates WHERE id = ? AND status = 'pending'"
  ).bind(id).first();

  if (!candidate) {
    return c.json({ error: "not_found", message: "Candidate not found or not pending" }, 404);
  }

  await importCandidate(c.env, candidate as unknown as ScannerCandidate, user.id);

  await c.env.DB.prepare(
    "UPDATE scanner_candidates SET status = 'imported' WHERE id = ?"
  ).bind(id).run();

  return c.json({ approved: true, imported: true, id });
});

// Reject a candidate
app.post("/v1/scanner/candidates/:id/reject", authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE scanner_candidates SET status = 'rejected' WHERE id = ? AND status = 'pending'"
  ).bind(id).run();

  return c.json({ rejected: true, id });
});

// Stats
app.get("/v1/scanner/stats", authMiddleware, async (c) => {
  const stats = await c.env.DB.prepare(`
    SELECT
      status,
      detected_type,
      COUNT(*) as count,
      AVG(confidence) as avg_confidence
    FROM scanner_candidates
    GROUP BY status, detected_type
  `).all();

  const sources = await c.env.DB.prepare(
    "SELECT COUNT(*) as total, SUM(total_found) as total_found FROM scanner_sources WHERE enabled = 1"
  ).first();

  return c.json({
    by_status_type: stats.results ?? [],
    sources: sources ?? {},
  });
});

export default app;

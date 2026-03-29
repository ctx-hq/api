import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { notFound } from "../utils/errors";
import { generateId } from "../utils/response";
import { optionalAuth } from "../middleware/auth";
import { canAccessPackage } from "../services/publisher";

const app = new Hono<AppEnv>();

// Download formula archive
app.get("/v1/packages/:fullName/versions/:version/archive", optionalAuth, async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName")!);
  const version = c.req.param("version")!;

  const pkg = await c.env.DB.prepare(
    "SELECT id, visibility, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Private packages: verify auth + membership (uniform 404 to avoid leaking existence)
  const user = c.get("user");
  if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
    throw notFound(`Package ${fullName} not found`);
  }

  const ver = await c.env.DB.prepare(
    "SELECT formula_key FROM versions WHERE package_id = ? AND version = ?",
  ).bind(pkg.id, version).first();

  if (!ver || !ver.formula_key) throw notFound(`Version ${version} not found`);

  const obj = await c.env.FORMULAS.get(ver.formula_key as string);
  if (!obj) throw notFound("Formula archive not found");

  // Record download stats (non-blocking)
  const today = new Date().toISOString().slice(0, 10);
  const pkgId = pkg.id as string;
  c.executionCtx.waitUntil(
    c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE packages SET downloads = downloads + 1 WHERE id = ?",
      ).bind(pkgId),
      c.env.DB.prepare(
        `INSERT INTO download_stats (id, package_id, version, date, count)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (package_id, version, date) DO UPDATE SET count = count + 1`,
      ).bind(generateId(), pkgId, version, today),
    ]),
  );

  const safeFilename = `${fullName}-${version}.tar.gz`.replace(/["\\\r\n]/g, "_");
  c.header("Content-Type", "application/gzip");
  c.header("Content-Disposition", `attachment; filename="${safeFilename}"`);
  return c.body(obj.body as ReadableStream);
});

export default app;

import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { notFound } from "../utils/errors";
import { resolveVersion } from "../services/version";

const app = new Hono<AppEnv>();

// Resolve a version constraint for a specific package
app.get("/v1/packages/:fullName/resolve/:constraint", async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName"));
  const constraint = decodeURIComponent(c.req.param("constraint"));

  const pkg = await c.env.DB.prepare(
    "SELECT id FROM packages WHERE full_name = ?"
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const versions = await c.env.DB.prepare(
    "SELECT version, manifest, sha256, formula_key, yanked FROM versions WHERE package_id = ? ORDER BY created_at DESC"
  ).bind(pkg.id).all();

  const rows = (versions.results ?? []) as unknown as Array<{
    version: string; manifest: string; sha256: string; formula_key: string; yanked: number;
  }>;

  const resolved = resolveVersion(rows, constraint);
  if (!resolved) {
    throw notFound(`No version matching ${constraint} for ${fullName}`);
  }

  return c.json({
    full_name: fullName,
    version: resolved.version,
    manifest: resolved.manifest,
    sha256: resolved.sha256,
    download_url: resolved.formula_key
      ? `https://api.getctx.org/v1/packages/${encodeURIComponent(fullName)}/versions/${resolved.version}/archive`
      : "",
  });
});

export default app;

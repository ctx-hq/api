import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware, requireScope, tokenCanActOnPackage, optionalAuth } from "../middleware/auth";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors";
import { generateId } from "../utils/response";
import { parseFullName } from "../utils/naming";
import { canPublish, canAccessPackage } from "../services/ownership";
import { getFormulaBucket } from "../services/storage";

const app = new Hono<AppEnv>();

const VALID_PLATFORMS = new Set([
  "darwin-arm64",
  "darwin-amd64",
  "linux-amd64",
  "linux-arm64",
  "windows-amd64",
  "windows-386",
]);

function isValidPlatform(platform: string): boolean {
  return VALID_PLATFORMS.has(platform);
}

async function computeSHA256Bytes(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Upload a platform artifact
app.post(
  "/v1/packages/:fullName/versions/:version/artifacts",
  authMiddleware,
  requireScope("publish"),
  async (c) => {
    const user = c.get("user");
    const fullName = decodeURIComponent(c.req.param("fullName")!);
    const version = c.req.param("version")!;

    // Token scope check
    if (!tokenCanActOnPackage(c, fullName)) {
      throw forbidden(`Token does not have permission to act on package ${fullName}`);
    }

    const formData = await c.req.formData();
    const platform = formData.get("platform") as string | null;
    const archive = formData.get("archive");

    if (!platform || typeof platform !== "string") {
      throw badRequest("Missing platform field");
    }
    if (!isValidPlatform(platform)) {
      throw badRequest(`Invalid platform: ${platform}. Must be one of: ${[...VALID_PLATFORMS].join(", ")}`);
    }
    if (!archive || !(archive instanceof File)) {
      throw badRequest("Missing archive file");
    }

    // Lookup package
    const pkg = await c.env.DB.prepare(
      "SELECT id, visibility, owner_type, owner_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
    ).bind(fullName).first();

    if (!pkg) throw notFound(`Package ${fullName} not found`);

    // Ownership auth
    const parsed = parseFullName(fullName);
    if (!parsed) throw badRequest(`Invalid package name: ${fullName}`);

    if (!(await canPublish(c.env.DB, user.id, parsed.scope))) {
      throw forbidden(`You do not have publish permission for @${parsed.scope}`);
    }

    // Lookup version
    const ver = await c.env.DB.prepare(
      "SELECT id FROM versions WHERE package_id = ? AND version = ? AND yanked = 0",
    ).bind(pkg.id, version).first();

    if (!ver) throw notFound(`Version ${version} not found for ${fullName}`);

    const versionId = ver.id as string;

    // Check for duplicate
    const existing = await c.env.DB.prepare(
      "SELECT id FROM version_artifacts WHERE version_id = ? AND platform = ?",
    ).bind(versionId, platform).first();

    if (existing) {
      throw conflict(`Artifact for platform ${platform} already exists for version ${version}`);
    }

    // Read archive and compute SHA256
    const archiveBuffer = await archive.arrayBuffer();
    const sha256 = await computeSHA256Bytes(archiveBuffer);
    const size = archiveBuffer.byteLength;

    // Store in R2
    const r2Key = `artifacts/${fullName}/${version}/${platform}.tar.gz`;
    await getFormulaBucket(c.env, pkg.visibility as string).put(r2Key, archiveBuffer);



    // Insert new artifact
    const artifactId = generateId();
    await c.env.DB.prepare(
      `INSERT INTO version_artifacts (id, version_id, platform, formula_key, sha256, size)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(artifactId, versionId, platform, r2Key, sha256, size).run();

    return c.json({
      platform,
      sha256,
      size,
      version,
      full_name: fullName,
    }, 201);
  },
);

// List artifacts for a version
app.get(
  "/v1/packages/:fullName/versions/:version/artifacts",
  optionalAuth,
  async (c) => {
    const fullName = decodeURIComponent(c.req.param("fullName")!);
    const version = c.req.param("version")!;

    const pkg = await c.env.DB.prepare(
      "SELECT id, visibility, owner_type, owner_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
    ).bind(fullName).first();

    if (!pkg) throw notFound(`Package ${fullName} not found`);

    const user = c.get("user");
    if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
      throw notFound(`Package ${fullName} not found`);
    }

    const ver = await c.env.DB.prepare(
      "SELECT id FROM versions WHERE package_id = ? AND version = ?",
    ).bind(pkg.id, version).first();

    if (!ver) throw notFound(`Version ${version} not found`);

    const artifacts = await c.env.DB.prepare(
      "SELECT platform, sha256, size, created_at FROM version_artifacts WHERE version_id = ? ORDER BY platform",
    ).bind(ver.id).all();

    return c.json({
      artifacts: (artifacts.results ?? []).map((a: any) => ({
        platform: a.platform,
        sha256: a.sha256,
        size: a.size,
        created_at: a.created_at,
        download_url: `/v1/packages/${encodeURIComponent(fullName)}/versions/${version}/artifacts/${a.platform}`,
      })),
    });
  },
);

// Download a specific platform artifact
app.get(
  "/v1/packages/:fullName/versions/:version/artifacts/:platform",
  optionalAuth,
  async (c) => {
    const fullName = decodeURIComponent(c.req.param("fullName")!);
    const version = c.req.param("version")!;
    const platform = c.req.param("platform")!;

    const pkg = await c.env.DB.prepare(
      "SELECT id, visibility, owner_type, owner_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
    ).bind(fullName).first();

    if (!pkg) throw notFound(`Package ${fullName} not found`);

    const user = c.get("user");
    if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
      throw notFound(`Package ${fullName} not found`);
    }

    const ver = await c.env.DB.prepare(
      "SELECT id FROM versions WHERE package_id = ? AND version = ?",
    ).bind(pkg.id, version).first();

    if (!ver) throw notFound(`Version ${version} not found`);

    const artifact = await c.env.DB.prepare(
      "SELECT formula_key, platform FROM version_artifacts WHERE version_id = ? AND platform = ?",
    ).bind(ver.id, platform).first();

    if (!artifact) throw notFound(`Artifact for platform ${platform} not found`);

    const obj = await getFormulaBucket(c.env, pkg.visibility as string).get(artifact.formula_key as string);
    if (!obj) throw notFound("Artifact archive not found in storage");

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

    const safeFilename = `${fullName}-${version}-${platform}.tar.gz`.replace(/["\\\r\n\/]/g, "_");
    c.header("Content-Type", "application/gzip");
    c.header("Content-Disposition", `attachment; filename="${safeFilename}"`);
    return c.body(obj.body as ReadableStream);
  },
);

export default app;

import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { Visibility, PublisherRow } from "../models/types";
import { notFound, badRequest, forbidden } from "../utils/errors";
import { getLatestVersion } from "../services/package";
import { authMiddleware, optionalAuth } from "../middleware/auth";
import { canPublish, getPublisherForScope, canAccessPackage } from "../services/publisher";
import { parseFullName, isValidScope } from "../utils/naming";
import { upsertSearchDigest } from "../services/publish";
import { parseSemVer, compareSemVer } from "../utils/semver";
import { getPackageAccess, grantPackageAccess, revokePackageAccess } from "../services/package-access";
import { renamePackage } from "../services/rename";
import { parseJsonArray } from "../utils/response";

const app = new Hono<AppEnv>();

// List packages
app.get("/v1/packages", optionalAuth, async (c) => {
  const type_ = c.req.query("type");
  const sort = c.req.query("sort") ?? "downloads";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20") || 20, 100);
  const offset = parseInt(c.req.query("offset") ?? "0") || 0;

  let query = "SELECT id, full_name, type, description, visibility, downloads, created_at, updated_at FROM packages";
  const params: unknown[] = [];
  const conditions: string[] = ["deleted_at IS NULL"];

  // Visibility: show public to all, plus private/unlisted to authorized publishers
  // For restricted private packages (with package_access rows), only show to
  // users in the ACL or org owner/admin — not to all org members.
  const user = c.get("user");
  if (user) {
    conditions.push(`(visibility = 'public' OR (
      publisher_id IN (
        SELECT id FROM publishers WHERE user_id = ? AND kind = 'user'
        UNION
        SELECT p.id FROM publishers p
        JOIN org_members m ON p.org_id = m.org_id
        WHERE m.user_id = ? AND p.kind = 'org'
      )
      AND (
        visibility != 'private'
        OR NOT EXISTS (SELECT 1 FROM package_access WHERE package_id = packages.id)
        OR EXISTS (SELECT 1 FROM package_access WHERE package_id = packages.id AND user_id = ?)
        OR publisher_id IN (
          SELECT p.id FROM publishers p
          JOIN org_members m ON p.org_id = m.org_id
          WHERE m.user_id = ? AND m.role IN ('owner', 'admin') AND p.kind = 'org'
        )
        OR publisher_id IN (
          SELECT id FROM publishers WHERE user_id = ? AND kind = 'user'
        )
      )
    ))`);
    params.push(user.id, user.id, user.id, user.id, user.id);
  } else {
    conditions.push("visibility = 'public'");
  }

  const category = c.req.query("category");

  if (type_) {
    conditions.push("type = ?");
    params.push(type_);
  }

  if (category) {
    conditions.push(`id IN (
      SELECT pc.package_id FROM package_categories pc
      JOIN categories cat ON pc.category_id = cat.id
      WHERE cat.slug = ?
    )`);
    params.push(category);
  }

  query += " WHERE " + conditions.join(" AND ");

  // Count total matching packages
  let countQuery = "SELECT COUNT(*) as count FROM packages WHERE " + conditions.join(" AND ");
  const countParams = [...params];

  const orderCol = sort === "created" ? "created_at" : "downloads";
  query += ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const [result, totalResult] = await Promise.all([
    c.env.DB.prepare(query).bind(...params).all(),
    c.env.DB.prepare(countQuery).bind(...countParams).first(),
  ]);

  // Get latest version for each package
  const packages = await Promise.all(
    (result.results ?? []).map(async (pkg: Record<string, unknown>) => {
      const ver = await getLatestVersion(c.env.DB, pkg.id as string);
      return {
        full_name: pkg.full_name,
        type: pkg.type,
        description: pkg.description,
        version: (ver?.version as string) ?? "",
        downloads: pkg.downloads,
        visibility: pkg.visibility ?? "public",
        repository: pkg.repository ?? "",
      };
    })
  );

  return c.json({ packages, total: (totalResult?.count as number) ?? 0 });
});

// Get package detail
app.get("/v1/packages/:fullName", optionalAuth, async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    `SELECT id, full_name, type, description, summary, capabilities, license,
            repository, homepage, author, keywords, platforms, downloads,
            visibility, publisher_id, created_at, updated_at
     FROM packages WHERE full_name = ? AND deleted_at IS NULL`
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Private packages: verify real auth + membership (return 404 to avoid leaking existence)
  const user = c.get("user");
  if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
    throw notFound(`Package ${fullName} not found`);
  }

  const versions = await c.env.DB.prepare(
    "SELECT version, yanked, created_at FROM versions WHERE package_id = ? ORDER BY created_at DESC"
  ).bind(pkg.id).all();

  // Fetch categories for this package
  const catResult = await c.env.DB.prepare(
    `SELECT cat.slug, cat.name FROM package_categories pc
     JOIN categories cat ON pc.category_id = cat.id
     WHERE pc.package_id = ?`
  ).bind(pkg.id).all();

  // Fetch publisher info
  const publisher = pkg.publisher_id
    ? await c.env.DB.prepare("SELECT slug, kind FROM publishers WHERE id = ?").bind(pkg.publisher_id).first()
    : null;

  // Fetch dist-tags
  const tagsResult = await c.env.DB.prepare(
    "SELECT dt.tag, v.version FROM dist_tags dt JOIN versions v ON dt.version_id = v.id WHERE dt.package_id = ?",
  ).bind(pkg.id).all();
  const distTags: Record<string, string> = {};
  for (const row of tagsResult.results ?? []) {
    distTags[row.tag as string] = row.version as string;
  }

  // Fetch MCP-specific metadata for MCP packages
  let mcpDetail = null;
  if (pkg.type === "mcp") {
    try {
      const mm = await c.env.DB.prepare(
        `SELECT mm.transport, mm.command, mm.args, mm.url, mm.env_vars, mm.tools, mm.resources
         FROM mcp_metadata mm
         JOIN dist_tags dt ON dt.version_id = mm.version_id
         WHERE dt.package_id = ? AND dt.tag = 'latest'`
      ).bind(pkg.id).first();
      if (mm) {
        mcpDetail = {
          transport: mm.transport ?? "stdio",
          command: mm.command ?? "",
          args: parseJsonArray(mm.args as string),
          url: mm.url ?? "",
          env_vars: parseJsonArray(mm.env_vars as string),
          tools: parseJsonArray(mm.tools as string),
          resources: parseJsonArray(mm.resources as string),
        };
      }
    } catch {
      // mcp_metadata may not have all columns yet (pre-migration)
    }
  }

  // Fetch collection-related data (mutually exclusive by type)
  let collectionMembers: { full_name: string; type: string; description: string; version: string }[] | null = null;
  let partOfCollections: { full_name: string; description: string }[] | null = null;

  if (pkg.type === "collection") {
    const membersResult = await c.env.DB.prepare(
      `SELECT p.id, p.full_name, p.type, p.description,
              (SELECT v.version FROM versions v WHERE v.package_id = p.id ORDER BY v.created_at DESC LIMIT 1) AS latest_version
       FROM collection_members cm
       JOIN packages p ON cm.member_id = p.id
       WHERE cm.collection_id = ? AND p.deleted_at IS NULL
       ORDER BY cm.display_order`
    ).bind(pkg.id).all();

    collectionMembers = (membersResult.results ?? []).map((row: Record<string, unknown>) => ({
      full_name: row.full_name as string,
      type: row.type as string,
      description: row.description as string,
      version: (row.latest_version as string) ?? "",
    }));
  } else {
    const collectionsResult = await c.env.DB.prepare(
      `SELECT p.full_name, p.description
       FROM collection_members cm
       JOIN packages p ON cm.collection_id = p.id
       WHERE cm.member_id = ? AND p.deleted_at IS NULL`
    ).bind(pkg.id).all();
    const rows = collectionsResult.results ?? [];
    partOfCollections = rows.length > 0
      ? rows.map((row: Record<string, unknown>) => ({
          full_name: row.full_name as string,
          description: row.description as string,
        }))
      : null;
  }

  return c.json({
    full_name: pkg.full_name,
    type: pkg.type,
    description: pkg.description,
    summary: pkg.summary ?? "",
    capabilities: JSON.parse((pkg.capabilities as string) ?? "[]"),
    license: pkg.license,
    repository: pkg.repository,
    homepage: pkg.homepage ?? "",
    author: pkg.author ?? "",
    keywords: JSON.parse((pkg.keywords as string) ?? "[]"),
    platforms: JSON.parse((pkg.platforms as string) ?? "[]"),
    categories: (catResult.results ?? []).map((row) => ({ slug: row.slug, name: row.name })),
    downloads: pkg.downloads,
    visibility: pkg.visibility ?? "public",
    publisher: publisher ? { slug: publisher.slug, kind: publisher.kind } : null,
    dist_tags: distTags,
    versions: versions.results ?? [],
    mcp_detail: mcpDetail,
    collection_members: collectionMembers,
    part_of_collections: partOfCollections,
    created_at: pkg.created_at,
    updated_at: pkg.updated_at,
  });
});

// Get package versions
app.get("/v1/packages/:fullName/versions", optionalAuth, async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    "SELECT id, visibility, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL"
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const user = c.get("user");
  if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
    throw notFound(`Package ${fullName} not found`);
  }

  const versions = await c.env.DB.prepare(
    "SELECT version, yanked, sha256, created_at FROM versions WHERE package_id = ? ORDER BY created_at DESC"
  ).bind(pkg.id).all();

  return c.json({ versions: versions.results ?? [] });
});

// Get specific version
app.get("/v1/packages/:fullName/versions/:version", optionalAuth, async (c) => {
  const fullName = decodeURIComponent(c.req.param("fullName")!);
  const version = c.req.param("version");

  const pkg = await c.env.DB.prepare(
    "SELECT id, visibility, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL"
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const user = c.get("user");
  if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
    throw notFound(`Package ${fullName} not found`);
  }

  const ver = await c.env.DB.prepare(
    `SELECT v.version, v.manifest, v.readme, v.sha256, v.yanked, v.created_at,
            u.username AS publisher
     FROM versions v
     LEFT JOIN users u ON v.published_by = u.id
     WHERE v.package_id = ? AND v.version = ?`
  ).bind(pkg.id, version).first();

  if (!ver) throw notFound(`Version ${version} not found`);

  return c.json({
    version: ver.version,
    manifest: ver.manifest,
    readme: ver.readme,
    sha256: ver.sha256,
    yanked: ver.yanked === 1,
    published_by: (ver.publisher as string) ?? "[unknown]",
    created_at: ver.created_at,
  });
});

// Change package visibility
app.patch("/v1/packages/:fullName/visibility", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  let body: { visibility: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const visibility = body.visibility as Visibility;
  if (!["public", "unlisted", "private"].includes(visibility)) {
    throw badRequest("visibility must be public, unlisted, or private");
  }

  const pkg = await c.env.DB.prepare(
    "SELECT id, full_name, type, description, summary, keywords, capabilities, downloads, publisher_id, visibility, mutable FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Auth: must be publisher member
  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
  if (!publisher || !(await canPublish(c.env.DB, user.id, publisher))) {
    throw forbidden("You don't have permission to change visibility");
  }

  // Mutable constraint: mutable only allowed for private
  if (pkg.mutable && visibility !== "private") {
    throw badRequest("Mutable packages must remain private. Set mutable=false first.");
  }

  const oldVisibility = pkg.visibility as string;
  await c.env.DB.prepare(
    "UPDATE packages SET visibility = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(visibility, pkg.id).run();

  // Handle search_digest transitions
  if (oldVisibility === "private" && visibility !== "private") {
    // Became visible → create search_digest
    const latestVer = await getLatestVersion(c.env.DB, pkg.id as string);
    await upsertSearchDigest(
      c.env.DB, pkg.id as string, pkg.full_name as string, pkg.type as string,
      pkg.description as string, (pkg.summary as string) ?? "",
      (pkg.keywords as string) ?? "[]", (pkg.capabilities as string) ?? "[]",
      (latestVer?.version as string) ?? "", pkg.downloads as number, publisher.slug,
    );
  } else if (oldVisibility !== "private" && visibility === "private") {
    // Became private → remove from search
    await c.env.DB.prepare("DELETE FROM search_digest WHERE package_id = ?").bind(pkg.id).run();
  }

  return c.json({ full_name: fullName, visibility });
});

// Deprecate a package
app.patch("/v1/packages/:fullName/deprecation", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  let body: { message: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first();
  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
  if (!publisher || !(await canPublish(c.env.DB, user.id, publisher))) {
    throw forbidden("You don't have permission to deprecate this package");
  }

  await c.env.DB.prepare(
    "UPDATE packages SET deprecated_message = ?, deprecated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).bind(body.message ?? "This package is deprecated", pkg.id).run();

  return c.json({ full_name: fullName, deprecated: true, message: body.message });
});

// Delete a package (hard delete — removes all versions, metadata, and archives)
app.delete("/v1/packages/:fullName", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first<{ id: string; publisher_id: string }>();
  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
  if (!publisher || !(await canPublish(c.env.DB, user.id, publisher))) {
    throw forbidden("You don't have permission to delete this package");
  }

  // Collect R2 keys and vector chunk IDs for cleanup
  const versions = await c.env.DB.prepare(
    "SELECT id, formula_key FROM versions WHERE package_id = ?",
  ).bind(pkg.id).all<{ id: string; formula_key: string }>();

  const versionIds = (versions.results ?? []).map(v => v.id);
  const formulaKeys = (versions.results ?? []).map(v => v.formula_key).filter(Boolean);

  const vectorChunks = await c.env.DB.prepare(
    "SELECT id FROM vector_chunks WHERE package_id = ?",
  ).bind(pkg.id).all<{ id: string }>();
  const vectorChunkIds = (vectorChunks.results ?? []).map(r => r.id);

  // Hard delete — order matters for FK constraints:
  // 1. metadata (FK → versions ON DELETE CASCADE, but explicit is safer)
  // 2. dist_tags (FK → versions without CASCADE — must delete before versions)
  // 3. versions (FK → packages)
  // 4. package-level tables
  // 5. package itself
  const stmts: D1PreparedStatement[] = [];
  for (const vid of versionIds) {
    stmts.push(c.env.DB.prepare("DELETE FROM skill_metadata WHERE version_id = ?").bind(vid));
    stmts.push(c.env.DB.prepare("DELETE FROM mcp_metadata WHERE version_id = ?").bind(vid));
    stmts.push(c.env.DB.prepare("DELETE FROM cli_metadata WHERE version_id = ?").bind(vid));
    stmts.push(c.env.DB.prepare("DELETE FROM install_metadata WHERE version_id = ?").bind(vid));
    stmts.push(c.env.DB.prepare("DELETE FROM trust_checks WHERE version_id = ?").bind(vid));
  }
  stmts.push(c.env.DB.prepare("DELETE FROM dist_tags WHERE package_id = ?").bind(pkg.id));
  stmts.push(c.env.DB.prepare("DELETE FROM versions WHERE package_id = ?").bind(pkg.id));
  stmts.push(c.env.DB.prepare("DELETE FROM package_access WHERE package_id = ?").bind(pkg.id));
  stmts.push(c.env.DB.prepare("DELETE FROM search_digest WHERE package_id = ?").bind(pkg.id));
  stmts.push(c.env.DB.prepare("DELETE FROM download_stats WHERE package_id = ?").bind(pkg.id));
  stmts.push(c.env.DB.prepare("DELETE FROM agent_installs WHERE package_id = ?").bind(pkg.id));
  stmts.push(c.env.DB.prepare("DELETE FROM vector_chunks WHERE package_id = ?").bind(pkg.id));
  stmts.push(c.env.DB.prepare("DELETE FROM transfer_requests WHERE package_id = ?").bind(pkg.id));
  stmts.push(c.env.DB.prepare("DELETE FROM packages WHERE id = ?").bind(pkg.id));
  stmts.push(
    c.env.DB.prepare(
      "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'package.delete', ?, 'package', ?, ?)",
    ).bind(crypto.randomUUID(), user.id, pkg.id, JSON.stringify({ full_name: fullName, versions: versionIds.length })),
  );

  // D1 batch limit is 100 — chunk if needed
  for (let i = 0; i < stmts.length; i += 100) {
    await c.env.DB.batch(stmts.slice(i, i + 100));
  }

  // Best-effort cleanup: R2 archives + Vectorize index
  const cleanups: Promise<unknown>[] = formulaKeys.map(key => c.env.FORMULAS.delete(key));
  if (vectorChunkIds.length > 0 && c.env.VECTORIZE) {
    cleanups.push(c.env.VECTORIZE.deleteByIds(vectorChunkIds));
  }
  await Promise.allSettled(cleanups);

  return c.json({ full_name: fullName, deleted: true, versions_removed: versionIds.length });
});

// Delete a single version (hard delete — removes version, metadata, and archive)
app.delete("/v1/packages/:fullName/versions/:version", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);
  const version = c.req.param("version")!;

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first<{ id: string; publisher_id: string }>();
  if (!pkg) throw notFound(`Package ${fullName} not found`);

  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
  if (!publisher || !(await canPublish(c.env.DB, user.id, publisher))) {
    throw forbidden("You don't have permission to delete this version");
  }

  const ver = await c.env.DB.prepare(
    "SELECT id, formula_key FROM versions WHERE package_id = ? AND version = ?",
  ).bind(pkg.id, version).first<{ id: string; formula_key: string }>();
  if (!ver) throw notFound(`Version ${version} not found for ${fullName}`);

  // Hard delete: metadata → version → dist-tags pointing to this version
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("DELETE FROM skill_metadata WHERE version_id = ?").bind(ver.id),
    c.env.DB.prepare("DELETE FROM mcp_metadata WHERE version_id = ?").bind(ver.id),
    c.env.DB.prepare("DELETE FROM cli_metadata WHERE version_id = ?").bind(ver.id),
    c.env.DB.prepare("DELETE FROM install_metadata WHERE version_id = ?").bind(ver.id),
    c.env.DB.prepare("DELETE FROM trust_checks WHERE version_id = ?").bind(ver.id),
    c.env.DB.prepare("DELETE FROM dist_tags WHERE version_id = ?").bind(ver.id),
    c.env.DB.prepare("DELETE FROM versions WHERE id = ?").bind(ver.id),
    c.env.DB.prepare(
      "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'version.delete', ?, 'package', ?, ?)",
    ).bind(crypto.randomUUID(), user.id, pkg.id, JSON.stringify({ full_name: fullName, version })),
  ];
  await c.env.DB.batch(stmts);

  // Delete R2 archive (best-effort)
  if (ver.formula_key) {
    await c.env.FORMULAS.delete(ver.formula_key).catch(() => {});
  }

  // Check if this was the last version — if so, delete the package too
  const remaining = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM versions WHERE package_id = ?",
  ).bind(pkg.id).first<{ count: number }>();

  if (!remaining || remaining.count === 0) {
    // Clean up vectorize
    const vectorChunks = await c.env.DB.prepare(
      "SELECT id FROM vector_chunks WHERE package_id = ?",
    ).bind(pkg.id).all<{ id: string }>();
    const vectorChunkIds = (vectorChunks.results ?? []).map(r => r.id);

    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM package_access WHERE package_id = ?").bind(pkg.id),
      c.env.DB.prepare("DELETE FROM search_digest WHERE package_id = ?").bind(pkg.id),
      c.env.DB.prepare("DELETE FROM download_stats WHERE package_id = ?").bind(pkg.id),
      c.env.DB.prepare("DELETE FROM agent_installs WHERE package_id = ?").bind(pkg.id),
      c.env.DB.prepare("DELETE FROM vector_chunks WHERE package_id = ?").bind(pkg.id),
      c.env.DB.prepare("DELETE FROM transfer_requests WHERE package_id = ?").bind(pkg.id),
      c.env.DB.prepare("DELETE FROM packages WHERE id = ?").bind(pkg.id),
    ]);

    if (vectorChunkIds.length > 0 && c.env.VECTORIZE) {
      await c.env.VECTORIZE.deleteByIds(vectorChunkIds).catch(() => {});
    }

    return c.json({ full_name: fullName, version, deleted: true, package_deleted: true });
  }

  // Package still has versions — reassign 'latest' dist-tag if it was removed
  const hasLatest = await c.env.DB.prepare(
    "SELECT 1 FROM dist_tags WHERE package_id = ? AND tag = 'latest'",
  ).bind(pkg.id).first();

  if (!hasLatest) {
    // Find highest non-prerelease version by semver (consistent with autoDistTag in publish)
    const stableVersions = await c.env.DB.prepare(
      `SELECT id, version FROM versions WHERE package_id = ? AND version NOT LIKE '%-%'`,
    ).bind(pkg.id).all<{ id: string; version: string }>();

    let best: { id: string; version: string } | null = null;
    for (const v of stableVersions.results ?? []) {
      if (!best) { best = v; continue; }
      const parsed1 = parseSemVer(v.version);
      const parsed2 = parseSemVer(best.version);
      if (parsed1 && parsed2 && compareSemVer(parsed1, parsed2) > 0) {
        best = v;
      }
    }

    if (best) {
      await c.env.DB.prepare(
        `INSERT INTO dist_tags (id, package_id, tag, version_id)
         VALUES (?, ?, 'latest', ?)
         ON CONFLICT (package_id, tag) DO UPDATE SET version_id = excluded.version_id, updated_at = datetime('now')`,
      ).bind(crypto.randomUUID(), pkg.id, best.id).run();
    }
  }

  // Refresh search_digest: if latest exists, update it; otherwise (only prereleases remain), remove it
  const latestVer = await c.env.DB.prepare(
    `SELECT v.version, v.manifest FROM versions v
     JOIN dist_tags dt ON dt.version_id = v.id
     WHERE dt.package_id = ? AND dt.tag = 'latest'`,
  ).bind(pkg.id).first<{ version: string; manifest: string }>();

  if (latestVer) {
    try {
      const manifest = JSON.parse(latestVer.manifest);
      const pkgInfo = await c.env.DB.prepare(
        "SELECT full_name, type, downloads FROM packages WHERE id = ?",
      ).bind(pkg.id).first<{ full_name: string; type: string; downloads: number }>();
      if (pkgInfo) {
        await upsertSearchDigest(
          c.env.DB, pkg.id, pkgInfo.full_name, pkgInfo.type,
          manifest.description ?? "", manifest.summary ?? "",
          (manifest.keywords ?? []).join(" "), (manifest.capabilities ?? []).join(" "),
          latestVer.version, pkgInfo.downloads, parsed.scope,
        );
      }
    } catch { /* best-effort search_digest refresh */ }
  } else {
    // No latest tag (only prereleases remain) — remove stale search_digest
    await c.env.DB.prepare("DELETE FROM search_digest WHERE package_id = ?").bind(pkg.id).run();
  }

  return c.json({ full_name: fullName, version, deleted: true, package_deleted: false });
});

// ============================================================
// PACKAGE ACCESS CONTROL (restricted visibility — per-user ACL)
// ============================================================

// Get package access list
app.get("/v1/packages/:fullName/access", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id, visibility FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Must be publisher member (owner/admin for org packages)
  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
  if (!publisher || !(await canPublish(c.env.DB, user.id, publisher))) {
    throw forbidden("You don't have permission to manage package access");
  }

  // For org publishers, only owner/admin can manage access
  if (publisher.kind === "org" && publisher.org_id) {
    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(publisher.org_id, user.id).first<{ role: string }>();

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw forbidden("Only owners and admins can manage package access");
    }
  }

  const accessList = await getPackageAccess(c.env.DB, pkg.id as string);
  return c.json({ access: accessList });
});

// Update package access list (add/remove users)
app.patch("/v1/packages/:fullName/access", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);

  let body: { add?: string[]; remove?: string[] };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.add?.length && !body.remove?.length) {
    throw badRequest("Must provide add or remove arrays");
  }

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id, visibility FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  if (pkg.visibility !== "private") {
    throw badRequest("Package access control only applies to private packages");
  }

  // Must be org owner/admin
  const parsed = parseFullName(fullName);
  if (!parsed) throw badRequest("Invalid package name");
  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);

  if (!publisher || publisher.kind !== "org" || !publisher.org_id) {
    throw badRequest("Package access control only applies to organization packages");
  }

  const membership = await c.env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(publisher.org_id, user.id).first<{ role: string }>();

  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw forbidden("Only owners and admins can manage package access");
  }

  // Resolve usernames to user IDs and validate they are org members
  const added: string[] = [];
  if (body.add?.length) {
    for (const username of body.add) {
      const targetUser = await c.env.DB.prepare(
        "SELECT id FROM users WHERE username = ?",
      ).bind(username).first<{ id: string }>();
      if (!targetUser) throw notFound(`User ${username} not found`);

      const isMember = await c.env.DB.prepare(
        "SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?",
      ).bind(publisher.org_id, targetUser.id).first();
      if (!isMember) throw badRequest(`${username} is not a member of the organization`);

      added.push(targetUser.id);
    }
    await grantPackageAccess(c.env.DB, pkg.id as string, added, user.id);
  }

  const removed: string[] = [];
  if (body.remove?.length) {
    for (const username of body.remove) {
      const targetUser = await c.env.DB.prepare(
        "SELECT id FROM users WHERE username = ?",
      ).bind(username).first<{ id: string }>();
      if (!targetUser) continue; // silently skip unknown users on remove
      removed.push(targetUser.id);
    }
    await revokePackageAccess(c.env.DB, pkg.id as string, removed);
  }

  return c.json({ added: body.add ?? [], removed: body.remove ?? [] });
});

// Rename package (name portion only, within same scope)
app.patch("/v1/packages/:fullName/rename", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = c.req.param("fullName");

  let body: { new_name: string; confirm: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.new_name) throw badRequest("new_name is required");
  if (!isValidScope(body.new_name)) {
    throw badRequest("Invalid package name (lowercase, alphanumeric, hyphens)");
  }
  if (body.confirm !== fullName) {
    throw badRequest(`Confirmation required: pass "confirm": "${fullName}" to proceed`);
  }

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id, scope, name, full_name FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first<{ id: string; publisher_id: string; scope: string; name: string; full_name: string }>();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Check permission (must be able to publish to this scope)
  const publisher = await c.env.DB.prepare(
    "SELECT * FROM publishers WHERE id = ?",
  ).bind(pkg.publisher_id).first<PublisherRow>();

  if (!publisher) throw notFound("Publisher not found");

  const hasPermission = await canPublish(c.env.DB, user.id, publisher);
  if (!hasPermission) throw forbidden("You don't have permission to rename this package");

  // For org packages, only owner/admin can rename
  if (publisher.kind === "org" && publisher.org_id) {
    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(publisher.org_id, user.id).first<{ role: string }>();

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw forbidden("Only org owners and admins can rename packages");
    }
  }

  try {
    const result = await renamePackage(c.env.DB, pkg.id, body.new_name);

    // Audit
    await c.env.DB.prepare(
      "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'package.rename', ?, 'package', ?, ?)",
    ).bind(
      `evt-${crypto.randomUUID().replace(/-/g, "")}`,
      user.id,
      pkg.id,
      JSON.stringify({ old_name: result.oldFullName, new_name: result.newFullName }),
    ).run();

    return c.json({
      old_name: result.oldFullName,
      new_name: result.newFullName,
    });
  } catch (e: any) {
    throw badRequest(e.message);
  }
});

export default app;

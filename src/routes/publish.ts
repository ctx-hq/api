import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { Visibility } from "../models/types";
import { authMiddleware, requireScope, tokenCanActOnPackage } from "../middleware/auth";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors";
import { isValidFullName, parseFullName } from "../utils/naming";
import { isValidSemVer } from "../utils/semver";
import { generateId } from "../utils/response";
import { computeSHA256, extractTypeMetadata, autoDistTag, upsertSearchDigest, syncKeywords } from "../services/publish";
import { enqueueEnrichment } from "../services/enrichment";
import { canPublish, canPublishWithOwner, canManage, ensureUserScope, getOwnerForScope, getOwnerSlug } from "../services/ownership";
import { runStructuralCheck } from "../services/trust";
import { getFormulaBucket } from "../services/storage";
import { getLatestVersion } from "../services/package";
import { getOwnerProfile } from "../services/ownership";
import type { OwnerType } from "../models/types";
import { parse as parseYAML } from "yaml";

const app = new Hono<AppEnv>();

// Publish a package
app.post("/v1/packages", authMiddleware, requireScope("publish"), async (c) => {
  const user = c.get("user");
  const formData = await c.req.formData();
  const manifestFile = formData.get("manifest");

  if (!manifestFile || !(manifestFile instanceof File)) {
    throw badRequest("Missing manifest file");
  }

  const manifestText = await manifestFile.text();
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    try {
      manifest = parseYAML(manifestText) as Record<string, unknown>;
    } catch {
      throw badRequest("Invalid manifest format (expected JSON or YAML)");
    }
  }

  const name = manifest.name as string;
  const version = manifest.version as string;
  const type_ = manifest.type as string;
  const description = (manifest.description as string) ?? "";

  // ── Core validation ──
  if (!name || !isValidFullName(name)) {
    throw badRequest(`Invalid package name: ${name}`);
  }
  if (!version || !isValidSemVer(version)) {
    throw badRequest(`Invalid version: ${version}`);
  }
  if (!["skill", "mcp", "cli"].includes(type_)) {
    throw badRequest(`Invalid type: ${type_}`);
  }

  // ── Type-specific validation (mirror CLI's manifest.Validate) ──
  if (type_ === "mcp") {
    const mcp = manifest.mcp as Record<string, unknown> | undefined;
    if (!mcp) throw badRequest("mcp section is required for type=mcp");
    const transport = mcp.transport as string;
    if (!["stdio", "sse", "http", "streamable-http"].includes(transport)) {
      throw badRequest(`Invalid mcp.transport: ${transport}`);
    }
    if (transport === "stdio" && !mcp.command) {
      throw badRequest("mcp.command is required for stdio transport");
    }
    if (["sse", "http", "streamable-http"].includes(transport) && !mcp.url) {
      throw badRequest("mcp.url is required for sse/http transport");
    }
  }
  if (type_ === "cli") {
    const cli = manifest.cli as Record<string, unknown> | undefined;
    if (!cli || !cli.binary) throw badRequest("cli.binary is required for type=cli");
  }

  // ── Visibility & mutable (resolved after existing package lookup below) ──
  const requestedVisibility = (formData.get("visibility") as string) ?? (manifest.visibility as string) ?? null;
  if (requestedVisibility && !["public", "unlisted", "private"].includes(requestedVisibility)) {
    throw badRequest("visibility must be public, unlisted, or private");
  }
  const mutableRaw = formData.get("mutable") ?? manifest.mutable;
  const mutableExplicit = formData.has("mutable") || manifest.mutable !== undefined;
  const requestedMutable = (mutableRaw === "true" || mutableRaw === true || mutableRaw === 1 || mutableRaw === "1") ? 1 : 0;

  if (description.length > 1024) {
    throw badRequest("Description must be 1024 characters or less");
  }

  const parsed = parseFullName(name);
  if (!parsed) throw badRequest(`Invalid package name: ${name}`);

  // ── Token package scope check ──
  if (!tokenCanActOnPackage(c, name)) {
    throw forbidden(`Token does not have permission to act on package ${name}`);
  }

  // ── Ownership auth ──
  await ensureUserScope(c.env.DB, user.id, user.username);

  let existingScope = await c.env.DB.prepare(
    "SELECT * FROM scopes WHERE name = ?",
  ).bind(parsed.scope).first();

  if (!existingScope) {
    // Auto-create user scope
    await c.env.DB.prepare(
      "INSERT INTO scopes (name, owner_type, owner_id) VALUES (?, 'user', ?)",
    ).bind(parsed.scope, user.id).run();
    existingScope = { owner_type: "user", owner_id: user.id };
  }

  const scopeOwner = await canPublishWithOwner(c.env.DB, user.id, parsed.scope);
  if (!scopeOwner) {
    // Determine error message based on scope owner type
    const existingOwner = await getOwnerForScope(c.env.DB, parsed.scope);
    if (existingOwner?.owner_type === "org") {
      throw forbidden(`You are not a member of organization @${parsed.scope}`);
    }
    throw forbidden(`Scope @${parsed.scope} is owned by another user`);
  }

  // ── Find or create package ──
  let pkg = await c.env.DB.prepare(
    "SELECT * FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(name).first();

  const pkgId = (pkg?.id as string) ?? generateId();

  // Resolve visibility: for new packages use requested or default "public";
  // for existing packages, keep current visibility (use PATCH /visibility to change)
  const visibility = pkg
    ? (pkg.visibility as Visibility)
    : ((requestedVisibility ?? "public") as Visibility);

  // Reject publish-time visibility change on existing packages — archives would
  // end up split across buckets. Use PATCH /v1/packages/:fullName/visibility instead.
  if (pkg && requestedVisibility && requestedVisibility !== (pkg.visibility as string)) {
    throw badRequest(
      `Cannot change visibility via publish. Use PATCH /v1/packages/${name}/visibility instead.`,
    );
  }

  // Resolve mutable flag. For existing packages, only change if explicitly requested
  // AND the user has manage permission (same bar as PATCH /mutable).
  let mutable: number;
  if (!pkg) {
    mutable = requestedMutable;
  } else if (mutableExplicit && requestedMutable !== (pkg.mutable as number)) {
    if (!(await canManage(c.env.DB, user.id, parsed.scope))) {
      throw forbidden("Only owners and admins can change the mutable flag");
    }
    mutable = requestedMutable;
  } else {
    mutable = pkg.mutable as number;
  }
  if (mutable && visibility !== "private") {
    throw badRequest("Mutable packages must be private");
  }

  // Parse optional hub metadata
  const metadataRaw = formData.get("metadata");
  let hubMeta: {
    summary?: string; capabilities?: string[]; categories?: string[];
    author?: string; homepage?: string; repository?: string;
    import_source?: string; import_external_id?: string;
  } = {};
  if (typeof metadataRaw === "string") {
    try { hubMeta = JSON.parse(metadataRaw); } catch { /* ignore */ }
  }

  const keywords = JSON.stringify(manifest.keywords ?? []);
  const license = (manifest.license as string) ?? "";
  const summary = hubMeta.summary ?? "";
  const capabilities = hubMeta.capabilities ? JSON.stringify(hubMeta.capabilities) : "[]";
  const author = hubMeta.author ?? (manifest.author as string) ?? "";
  const homepage = hubMeta.homepage ?? (manifest.homepage as string) ?? "";
  const repository = (manifest.repository as string) ?? hubMeta.repository ?? "";
  const importSource = hubMeta.import_source ?? "";
  const importExternalId = hubMeta.import_external_id ?? "";

  if (!pkg) {
    await c.env.DB.prepare(
      `INSERT INTO packages (id, scope, name, full_name, type, description, keywords, license, summary, capabilities,
       author, homepage, repository, import_source, import_external_id, owner_id, owner_type, visibility, mutable, source_repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      pkgId, parsed.scope, parsed.name, name, type_, description,
      keywords, license, summary, capabilities, author, homepage, repository,
      importSource, importExternalId, scopeOwner.owner_id, scopeOwner.owner_type, visibility, mutable, repository,
    ).run();
  } else {
    // Update metadata on re-publish (visibility unchanged — use PATCH /visibility to change)
    await c.env.DB.prepare(
      "UPDATE packages SET description = ?, keywords = ?, license = ?, author = ?, homepage = ?, repository = ?, mutable = ?, updated_at = datetime('now') WHERE id = ?",
    ).bind(description, keywords, license, author, homepage, repository, mutable, pkgId).run();
  }

  // Always store manifest as JSON for consistent downstream consumption
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = await computeSHA256(manifestJson);

  // ── Mutable version handling ──
  const existingVersion = await c.env.DB.prepare(
    "SELECT id FROM versions WHERE package_id = ? AND version = ?",
  ).bind(pkgId, version).first();

  if (existingVersion) {
    if (mutable) {
      // Overwrite: delete old version data, re-create
      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM skill_metadata WHERE version_id = ?").bind(existingVersion.id),
        c.env.DB.prepare("DELETE FROM mcp_metadata WHERE version_id = ?").bind(existingVersion.id),
        c.env.DB.prepare("DELETE FROM cli_metadata WHERE version_id = ?").bind(existingVersion.id),
        c.env.DB.prepare("DELETE FROM install_metadata WHERE version_id = ?").bind(existingVersion.id),
        c.env.DB.prepare("DELETE FROM trust_checks WHERE version_id = ?").bind(existingVersion.id),
      ]);
      // Note: archive_sha256 and formula_key will be set after archive is stored in R2
      // We defer the full UPDATE to after archive processing below
    } else {
      throw conflict(`Version ${version} already exists for ${name}`);
    }
  }

  // ── Store archive in R2 + compute archive SHA256 ──
  const archive = formData.get("archive");
  let formulaKey = "";
  let archiveSHA256 = "";
  if (archive instanceof File) {
    formulaKey = `archives/${name}/${version}.tar.gz`;
    const archiveBuffer = await archive.arrayBuffer();

    // Compute SHA256 of the actual archive blob for client-side integrity verification
    const hashBuffer = await crypto.subtle.digest("SHA-256", archiveBuffer);
    archiveSHA256 = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    await getFormulaBucket(c.env, visibility).put(formulaKey, archiveBuffer);
  }

  // Extract README from form data (sent by CLI alongside manifest)
  const readmeFile = formData.get("readme");
  const readmeText = readmeFile instanceof File ? await readmeFile.text() : "";

  const versionId = existingVersion
    ? (existingVersion.id as string)
    : generateId();

  if (!existingVersion) {
    await c.env.DB.prepare(
      `INSERT INTO versions (id, package_id, version, manifest, readme, formula_key, sha256, archive_sha256, published_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(versionId, pkgId, version, manifestJson, readmeText, formulaKey, manifestHash, archiveSHA256, user.id).run();
  } else {
    // Mutable re-publish: single UPDATE with all changed fields
    const updates = ["manifest = ?", "sha256 = ?", "trust_tier = 'unverified'", "created_at = datetime('now')"];
    const binds: unknown[] = [manifestJson, manifestHash];
    if (archiveSHA256) {
      updates.push("archive_sha256 = ?");
      updates.push("formula_key = ?");
      binds.push(archiveSHA256, formulaKey);
    }
    if (readmeText) {
      updates.push("readme = ?");
      binds.push(readmeText);
    }
    binds.push(versionId);
    await c.env.DB.prepare(
      `UPDATE versions SET ${updates.join(", ")} WHERE id = ?`,
    ).bind(...binds).run();
  }

  // ── Extract type-specific metadata ──
  const metaResult = await extractTypeMetadata(c.env.DB, versionId, manifest, pkgId);

  // ── Auto dist-tag ──
  const distTags = await autoDistTag(c.env.DB, pkgId, versionId, version);

  // ── Structural trust check (sync) ──
  await runStructuralCheck(c.env.DB, versionId, manifest, manifestHash);

  // ── Update search digest (public/unlisted only) ──
  if (visibility !== "private") {
    const ownerSlug = await getOwnerSlug(c.env.DB, scopeOwner);
    await upsertSearchDigest(
      c.env.DB, pkgId, name, type_, description, summary,
      keywords, capabilities, version, (pkg?.downloads as number) ?? 0,
      ownerSlug,
    );
  }

  // ── Sync keywords to normalized tables ──
  const manifestKeywords = (manifest.keywords as string[]) ?? [];
  if (manifestKeywords.length > 0) {
    c.executionCtx.waitUntil(syncKeywords(c.env.DB, pkgId, manifestKeywords));
  }

  // ── Audit event ──
  await c.env.DB.prepare(
    `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, metadata)
     VALUES (?, ?, 'publish', 'version', ?, ?)`,
  ).bind(generateId(), user.id, versionId, JSON.stringify({ version, package: name, visibility })).run();

  // ── Enqueue enrichment + vectorization (public only, non-blocking) ──
  if (visibility !== "private") {
    c.executionCtx.waitUntil(
      enqueueEnrichment(c.env.ENRICHMENT_QUEUE, pkgId),
    );
  }

  return c.json({
    full_name: name,
    version,
    visibility,
    trust_tier: "structural",
    tags: distTags,
    url: `https://getctx.org/package/${name}`,
    ...(metaResult.unresolved_members?.length ? { unresolved_members: metaResult.unresolved_members } : {}),
  }, 201);
});

// Yank a version (requires admin+ for org packages)
app.post("/v1/packages/:fullName/versions/:version/yank", authMiddleware, requireScope("yank"), async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);
  const version = c.req.param("version")!;

  if (!tokenCanActOnPackage(c, fullName)) {
    throw forbidden(`Token does not have permission to act on package ${fullName}`);
  }

  const pkg = await c.env.DB.prepare(
    "SELECT p.* FROM packages p WHERE p.full_name = ? AND p.deleted_at IS NULL",
  ).bind(fullName).first();

  if (!pkg) {
    throw badRequest("Package not found");
  }

  // Ownership auth: yank requires admin+ (canManage)
  const parsed = parseFullName(fullName);
  if (parsed) {
    if (!(await canManage(c.env.DB, user.id, parsed.scope))) {
      throw forbidden("Only org owners and admins can yank versions");
    }
  } else if (pkg.owner_id !== user.id) {
    throw forbidden("You don't have permission to yank this version");
  }

  const result = await c.env.DB.prepare(
    "UPDATE versions SET yanked = 1 WHERE package_id = ? AND version = ?",
  ).bind(pkg.id, version).run();

  if (!result.meta.changes) {
    throw notFound(`Version ${version} not found for ${fullName}`);
  }

  // Refresh search_digest with recalculated latest version
  const visibility = pkg.visibility as string;
  if (visibility !== "private") {
    const latestVer = await getLatestVersion(c.env.DB, pkg.id as string);
    const ownerProfile = await getOwnerProfile(c.env.DB, pkg.owner_type as OwnerType, pkg.owner_id as string);
    await upsertSearchDigest(
      c.env.DB, pkg.id as string, pkg.full_name as string, pkg.type as string,
      pkg.description as string, (pkg.summary as string) ?? "",
      (pkg.keywords as string) ?? "[]", (pkg.capabilities as string) ?? "[]",
      (latestVer?.version as string) ?? "", pkg.downloads as number, ownerProfile.slug,
    );
  }

  return c.json({ yanked: true, full_name: fullName, version });
});

// Unyank a version (requires admin+ for org packages)
app.post("/v1/packages/:fullName/versions/:version/unyank", authMiddleware, requireScope("yank"), async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);
  const version = c.req.param("version")!;

  if (!tokenCanActOnPackage(c, fullName)) {
    throw forbidden(`Token does not have permission to act on package ${fullName}`);
  }

  const pkg = await c.env.DB.prepare(
    "SELECT p.* FROM packages p WHERE p.full_name = ? AND p.deleted_at IS NULL",
  ).bind(fullName).first();

  if (!pkg) {
    throw badRequest("Package not found");
  }

  // Ownership auth: unyank requires admin+ (canManage)
  const parsed = parseFullName(fullName);
  if (parsed) {
    if (!(await canManage(c.env.DB, user.id, parsed.scope))) {
      throw forbidden("Only org owners and admins can unyank versions");
    }
  } else if (pkg.owner_id !== user.id) {
    throw forbidden("You don't have permission to unyank this version");
  }

  const result = await c.env.DB.prepare(
    "UPDATE versions SET yanked = 0 WHERE package_id = ? AND version = ?",
  ).bind(pkg.id, version).run();

  if (!result.meta.changes) {
    throw notFound(`Version ${version} not found for ${fullName}`);
  }

  // Refresh search_digest with recalculated latest version
  const visibility = pkg.visibility as string;
  if (visibility !== "private") {
    const latestVer = await getLatestVersion(c.env.DB, pkg.id as string);
    const ownerProfile = await getOwnerProfile(c.env.DB, pkg.owner_type as OwnerType, pkg.owner_id as string);
    await upsertSearchDigest(
      c.env.DB, pkg.id as string, pkg.full_name as string, pkg.type as string,
      pkg.description as string, (pkg.summary as string) ?? "",
      (pkg.keywords as string) ?? "[]", (pkg.capabilities as string) ?? "[]",
      (latestVer?.version as string) ?? "", pkg.downloads as number, ownerProfile.slug,
    );
  }

  return c.json({ yanked: false, full_name: fullName, version });
});

export default app;

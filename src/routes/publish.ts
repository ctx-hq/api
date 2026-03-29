import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { Visibility } from "../models/types";
import { authMiddleware } from "../middleware/auth";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors";
import { isValidFullName, parseFullName } from "../utils/naming";
import { isValidSemVer } from "../utils/semver";
import { generateId } from "../utils/response";
import { computeSHA256, extractTypeMetadata, autoDistTag, upsertSearchDigest } from "../services/publish";
import { enqueueEnrichment } from "../services/enrichment";
import { getOrCreatePublisher, getPublisherForScope, canPublish, createOrgPublisher } from "../services/publisher";
import { runStructuralCheck } from "../services/trust";
import { parse as parseYAML } from "yaml";

const app = new Hono<AppEnv>();

// Publish a package
app.post("/v1/publish", authMiddleware, async (c) => {
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
  const requestedMutable = mutableRaw === "true" || mutableRaw === true || mutableRaw === 1 ? 1 : 0;

  if (description.length > 1024) {
    throw badRequest("Description must be 1024 characters or less");
  }

  const parsed = parseFullName(name)!;

  // ── Publisher auth (replaces direct owner_id check) ──
  const personalPublisher = await getOrCreatePublisher(c.env.DB, user.id, user.username);

  let existingScope = await c.env.DB.prepare(
    "SELECT * FROM scopes WHERE name = ?",
  ).bind(parsed.scope).first();

  if (!existingScope) {
    // Auto-create user scope with publisher
    await c.env.DB.prepare(
      "INSERT INTO scopes (name, owner_type, owner_id, publisher_id) VALUES (?, 'user', ?, ?)",
    ).bind(parsed.scope, user.id, personalPublisher.id).run();
    existingScope = { owner_type: "user", owner_id: user.id, publisher_id: personalPublisher.id };
  }

  const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
  if (!publisher) {
    throw forbidden(`Scope @${parsed.scope} has no publisher`);
  }
  if (!(await canPublish(c.env.DB, user.id, publisher))) {
    if (publisher.kind === "org") {
      throw forbidden(`You are not a member of organization @${parsed.scope}`);
    }
    throw forbidden(`Scope @${parsed.scope} is owned by another user`);
  }

  // ── Find or create package ──
  let pkg = await c.env.DB.prepare(
    "SELECT * FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(name).first();

  const pkgId = (pkg?.id as string) ?? generateId();

  // Resolve visibility: explicit request > existing package > default "public"
  const visibility = (requestedVisibility ?? (pkg?.visibility as string) ?? "public") as Visibility;
  const mutable = pkg ? (requestedMutable || (pkg.mutable as number)) : requestedMutable;
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
  const summary = hubMeta.summary ?? "";
  const capabilities = hubMeta.capabilities ? JSON.stringify(hubMeta.capabilities) : "[]";
  const author = hubMeta.author ?? "";
  const homepage = hubMeta.homepage ?? "";
  const repository = (manifest.repository as string) ?? hubMeta.repository ?? "";
  const importSource = hubMeta.import_source ?? "";
  const importExternalId = hubMeta.import_external_id ?? "";

  if (!pkg) {
    await c.env.DB.prepare(
      `INSERT INTO packages (id, scope, name, full_name, type, description, keywords, summary, capabilities,
       author, homepage, repository, import_source, import_external_id, owner_id, publisher_id, visibility, mutable, source_repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      pkgId, parsed.scope, parsed.name, name, type_, description,
      keywords, summary, capabilities, author, homepage, repository,
      importSource, importExternalId, user.id, publisher.id, visibility, mutable, repository,
    ).run();
  } else {
    // Update metadata on re-publish (including visibility if explicitly changed)
    await c.env.DB.prepare(
      "UPDATE packages SET description = ?, keywords = ?, visibility = ?, mutable = ?, updated_at = datetime('now') WHERE id = ?",
    ).bind(description, keywords, visibility, mutable, pkgId).run();
  }

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
      await c.env.DB.prepare(
        "UPDATE versions SET manifest = ?, sha256 = ?, trust_tier = 'unverified', created_at = datetime('now') WHERE id = ?",
      ).bind(manifestText, await computeSHA256(manifestText), existingVersion.id).run();
    } else {
      throw conflict(`Version ${version} already exists for ${name}`);
    }
  }

  // ── Store archive in R2 ──
  const archive = formData.get("archive");
  let formulaKey = "";
  if (archive instanceof File) {
    formulaKey = `${name}/${version}/formula.tar.gz`;
    await c.env.FORMULAS.put(formulaKey, await archive.arrayBuffer());
  }

  // ── Create version (if not mutable overwrite) ──
  const manifestHash = await computeSHA256(manifestText);
  const versionId = existingVersion
    ? (existingVersion.id as string)
    : generateId();

  if (!existingVersion) {
    await c.env.DB.prepare(
      `INSERT INTO versions (id, package_id, version, manifest, formula_key, sha256, published_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(versionId, pkgId, version, manifestText, formulaKey, manifestHash, user.id).run();
  }

  // ── Extract type-specific metadata ──
  await extractTypeMetadata(c.env.DB, versionId, manifest);

  // ── Auto dist-tag ──
  const distTags = await autoDistTag(c.env.DB, pkgId, versionId, version);

  // ── Structural trust check (sync) ──
  await runStructuralCheck(c.env.DB, versionId, manifest, manifestHash);

  // ── Update search digest (public/unlisted only) ──
  if (visibility !== "private") {
    await upsertSearchDigest(
      c.env.DB, pkgId, name, type_, description, summary,
      keywords, capabilities, version, (pkg?.downloads as number) ?? 0,
      publisher.slug,
    );
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
    url: `https://getctx.org/${name}`,
  }, 201);
});

// Yank a version
app.post("/v1/yank/:fullName/:version", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = decodeURIComponent(c.req.param("fullName")!);
  const version = c.req.param("version")!;

  const pkg = await c.env.DB.prepare(
    "SELECT p.* FROM packages p WHERE p.full_name = ? AND p.deleted_at IS NULL",
  ).bind(fullName).first();

  if (!pkg) {
    throw badRequest("Package not found");
  }

  // Publisher auth for yank
  const parsed = parseFullName(fullName);
  if (parsed) {
    const publisher = await getPublisherForScope(c.env.DB, parsed.scope);
    if (!publisher || !(await canPublish(c.env.DB, user.id, publisher))) {
      throw forbidden("You don't have permission to yank this version");
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

  return c.json({ yanked: true, full_name: fullName, version });
});

export default app;

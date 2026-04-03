import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { generateId } from "../utils/response";
import { hashToken } from "../services/auth";
import { authMiddleware, requireScope, tokenCanActOnPackage } from "../middleware/auth";
import { verifyOIDCToken, matchesTrustedPublisher } from "../services/trustpub";
import { canManage } from "../services/ownership";
import { parseFullName } from "../utils/naming";
import { badRequest, forbidden, notFound } from "../utils/errors";

const app = new Hono<AppEnv>();

// ── Exchange GitHub OIDC token for a short-lived ctx API token ──────────────
// No auth required — the OIDC JWT itself proves identity.
app.post("/v1/trustpub/exchange", async (c) => {
  let body: { token?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const jwt = body.token?.trim();
  if (!jwt) {
    throw badRequest("token is required");
  }

  // Verify and decode OIDC claims (RS256 signature validation)
  const claims = await verifyOIDCToken(jwt);
  if (!claims) {
    throw forbidden("Invalid OIDC token");
  }

  // Check expiration
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp < nowSec) {
    throw forbidden("OIDC token has expired");
  }

  // Replay prevention: atomic INSERT OR IGNORE + check changes to eliminate TOCTOU race.
  // D1 for global consistency — Cache API is per-colo and cannot prevent cross-colo replay.
  const jti = (claims as unknown as Record<string, unknown>).jti as string | undefined;
  if (jti) {
    const expiresAt = new Date((claims.exp + 300) * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    const insertResult = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO used_oidc_tokens (jti, expires_at) VALUES (?, ?)"
    ).bind(jti, expiresAt).run();
    if (!insertResult.meta.changes) {
      throw forbidden("OIDC token has already been used");
    }
  }

  // Find matching trusted publisher configs by repository
  const configs = await c.env.DB.prepare(
    `SELECT tp.id, tp.package_id, tp.github_repo, tp.workflow, tp.environment,
            p.full_name
     FROM trusted_publishers tp
     JOIN packages p ON tp.package_id = p.id
     WHERE LOWER(tp.github_repo) = LOWER(?) AND p.deleted_at IS NULL`
  ).bind(claims.repository).all<{
    id: string;
    package_id: string;
    github_repo: string;
    workflow: string;
    environment: string | null;
    full_name: string;
  }>();

  // Try to match against each config
  let matchedConfig: { package_id: string; full_name: string } | null = null;
  for (const cfg of configs.results ?? []) {
    if (matchesTrustedPublisher(claims, cfg)) {
      matchedConfig = { package_id: cfg.package_id, full_name: cfg.full_name };
      break;
    }
  }

  if (!matchedConfig) {
    throw forbidden("No matching trusted publisher configuration found");
  }

  // Find the package owner to associate the token with
  const pkg = await c.env.DB.prepare(
    "SELECT owner_id, owner_type FROM packages WHERE id = ?"
  ).bind(matchedConfig.package_id).first<{ owner_id: string; owner_type: string }>();

  if (!pkg) {
    throw forbidden("Package not found");
  }

  // Resolve a user_id for the token. For user-owned packages, use the owner.
  // For org-owned packages, we need a user — use a system "oidc" approach:
  // create the token under the package owner_id (works for user scope),
  // or for org scope, find the first org owner.
  let tokenUserId: string;
  if (pkg.owner_type === "user") {
    tokenUserId = pkg.owner_id;
  } else {
    // For org-owned packages, find an org owner to attribute the token to
    const orgOwner = await c.env.DB.prepare(
      "SELECT user_id FROM org_members WHERE org_id = ? AND role = 'owner' LIMIT 1"
    ).bind(pkg.owner_id).first<{ user_id: string }>();
    if (!orgOwner) {
      throw forbidden("No org owner found for package");
    }
    tokenUserId = orgOwner.user_id;
  }

  // Generate a short-lived API token scoped to this package only
  const token = `ctx_${generateId()}${generateId()}`;
  const tokenHash = await hashToken(token);
  const tokenId = generateId();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString(); // 1 hour

  await c.env.DB.prepare(
    `INSERT INTO api_tokens (id, user_id, token_hash, name, endpoint_scopes, package_scopes, token_type, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    tokenId,
    tokenUserId,
    tokenHash,
    `oidc:${claims.repository}`,
    JSON.stringify(["publish"]),
    JSON.stringify([matchedConfig.full_name]),
    "oidc",
    expiresAt,
  ).run();

  return c.json({ token, expires_in: 3600 }, 201);
});

// ── List trusted publisher configs for a package ────────────────────────────
app.get(
  "/v1/packages/:fullName{.+}/trusted-publishers",
  authMiddleware,
  requireScope("manage-access"),
  async (c) => {
    const user = c.get("user");
    const fullName = decodeURIComponent(c.req.param("fullName")!);

    if (!tokenCanActOnPackage(c, fullName)) {
      throw forbidden("Token not authorized for this package");
    }

    // Check canManage
    const parsed = parseFullName(fullName);
    if (!parsed) throw badRequest("Invalid package name");
    if (!(await canManage(c.env.DB, user.id, parsed.scope))) {
      throw forbidden("You do not have permission to manage this package");
    }

    // Find package
    const pkg = await c.env.DB.prepare(
      "SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL"
    ).bind(fullName).first<{ id: string }>();

    if (!pkg) {
      throw notFound("Package not found");
    }

    const result = await c.env.DB.prepare(
      "SELECT id, provider, github_repo, workflow, environment, created_at FROM trusted_publishers WHERE package_id = ? ORDER BY created_at DESC"
    ).bind(pkg.id).all();

    return c.json({ trusted_publishers: result.results ?? [] });
  },
);

// ── Add a trusted publisher config ──────────────────────────────────────────
app.post(
  "/v1/packages/:fullName{.+}/trusted-publishers",
  authMiddleware,
  requireScope("manage-access"),
  async (c) => {
    const user = c.get("user");
    const fullName = decodeURIComponent(c.req.param("fullName")!);

    if (!tokenCanActOnPackage(c, fullName)) {
      throw forbidden("Token not authorized for this package");
    }

    const parsed = parseFullName(fullName);
    if (!parsed) throw badRequest("Invalid package name");
    if (!(await canManage(c.env.DB, user.id, parsed.scope))) {
      throw forbidden("You do not have permission to manage this package");
    }

    let body: {
      provider?: string;
      github_repo?: string;
      workflow?: string;
      environment?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("Invalid JSON body");
    }

    const provider = body.provider ?? "github";
    if (provider !== "github") {
      throw badRequest("Only 'github' provider is currently supported");
    }

    const githubRepo = body.github_repo?.trim();
    if (!githubRepo || !githubRepo.includes("/")) {
      throw badRequest("github_repo must be in 'owner/repo' format");
    }

    const workflow = body.workflow?.trim();
    if (!workflow) {
      throw badRequest("workflow is required");
    }

    const environment = body.environment?.trim() || null;

    // Find package
    const pkg = await c.env.DB.prepare(
      "SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL"
    ).bind(fullName).first<{ id: string }>();

    if (!pkg) {
      throw notFound("Package not found");
    }

    const id = generateId();
    try {
      await c.env.DB.prepare(
        `INSERT INTO trusted_publishers (id, package_id, provider, github_repo, workflow, environment)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, pkg.id, provider, githubRepo, workflow, environment).run();
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE")) {
        throw badRequest("A trusted publisher with this repo and workflow already exists for this package");
      }
      throw err;
    }

    return c.json({
      id,
      provider,
      github_repo: githubRepo,
      workflow,
      environment,
      created_at: new Date().toISOString(),
    }, 201);
  },
);

// ── Remove a trusted publisher config ───────────────────────────────────────
app.delete(
  "/v1/packages/:fullName{.+}/trusted-publishers/:tpId",
  authMiddleware,
  requireScope("manage-access"),
  async (c) => {
    const user = c.get("user");
    const fullName = decodeURIComponent(c.req.param("fullName")!);
    const tpId = c.req.param("tpId");

    if (!tokenCanActOnPackage(c, fullName)) {
      throw forbidden("Token not authorized for this package");
    }

    const parsed = parseFullName(fullName);
    if (!parsed) throw badRequest("Invalid package name");
    if (!(await canManage(c.env.DB, user.id, parsed.scope))) {
      throw forbidden("You do not have permission to manage this package");
    }

    // Find package
    const pkg = await c.env.DB.prepare(
      "SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL"
    ).bind(fullName).first<{ id: string }>();

    if (!pkg) {
      throw notFound("Package not found");
    }

    const result = await c.env.DB.prepare(
      "DELETE FROM trusted_publishers WHERE id = ? AND package_id = ?"
    ).bind(tpId, pkg.id).run();

    if (!result.meta.changes) {
      throw notFound("Trusted publisher config not found");
    }

    return c.json({ deleted: true });
  },
);

export default app;

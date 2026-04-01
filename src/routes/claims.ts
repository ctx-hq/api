import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware } from "../middleware/auth";
import { badRequest, notFound } from "../utils/errors";
import { findClaimablePackages, claimPackage } from "../services/claim";

const app = new Hono<AppEnv>();

// List packages the authenticated user can claim.
// Matches system-owned packages whose source_repo corresponds to
// the user's GitHub username (from OAuth).
app.get("/v1/me/claimable", authMiddleware, async (c) => {
  const user = c.get("user");

  // Use the username as GitHub username proxy (our OAuth stores GitHub username)
  const packages = await findClaimablePackages(c.env.DB, user.username);

  return c.json({ packages });
});

// Claim a system-owned package.
app.post("/v1/me/claims", authMiddleware, async (c) => {
  const user = c.get("user");

  let body: { package_id: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.package_id) {
    throw badRequest("package_id is required");
  }

  const result = await claimPackage(c.env.DB, body.package_id, user.id, user.username);

  if (!result.success) {
    throw badRequest(result.error ?? "Claim failed");
  }

  return c.json({
    ok: true,
    full_name: result.new_full_name,
    message: `Package claimed and moved to @${user.username}`,
  });
});

// List user's claim history.
app.get("/v1/me/claims", authMiddleware, async (c) => {
  const user = c.get("user");

  const result = await c.env.DB.prepare(
    `SELECT pc.id, pc.package_id, pc.github_repo, pc.status, pc.created_at, pc.resolved_at,
            p.full_name
     FROM package_claims pc
     LEFT JOIN packages p ON pc.package_id = p.id
     WHERE pc.claimant_id = ?
     ORDER BY pc.created_at DESC
     LIMIT 50`,
  ).bind(user.id).all();

  return c.json({ claims: result.results ?? [] });
});

export default app;

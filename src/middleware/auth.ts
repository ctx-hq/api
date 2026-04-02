import type { Context, Next } from "hono";
import type { AppEnv } from "../bindings";
import type { UserRow } from "../models/types";
import { hashToken } from "../services/auth";
import { parseScopes, hasEndpointScope, matchesPackageScope, type EndpointScope } from "../services/token-scope";
import { AppError, forbidden, unauthorized } from "../utils/errors";

interface TokenRow extends UserRow {
  endpoint_scopes: string;
  package_scopes: string;
  token_type: string;
}

const TOKEN_QUERY = `
  SELECT u.*, t.endpoint_scopes, t.package_scopes, t.token_type
  FROM api_tokens t JOIN users u ON t.user_id = u.id
  WHERE t.token_hash = ? AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
`;

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw unauthorized("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);
  const tokenHash = await hashToken(token);

  let result: TokenRow | null;
  try {
    result = await c.env.DB.prepare(TOKEN_QUERY).bind(tokenHash).first<TokenRow>();
  } catch (err) {
    console.error("Auth middleware DB error:", err);
    throw new AppError(503, "Authentication service temporarily unavailable", "service_unavailable");
  }

  if (!result) {
    throw unauthorized("Invalid or expired token");
  }

  // Throttle last_used_at updates to once per hour
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      "UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 hour'))"
    ).bind(tokenHash).run()
  );

  c.set("user", result as UserRow);
  c.set("tokenScopes", {
    endpoints: parseScopes(result.endpoint_scopes),
    packages: parseScopes(result.package_scopes),
    tokenType: result.token_type ?? "personal",
  });
  await next();
}

export async function optionalAuth(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const token = authHeader.slice(7);
      const tokenHash = await hashToken(token);
      const result = await c.env.DB.prepare(TOKEN_QUERY).bind(tokenHash).first<TokenRow>();
      if (result) {
        c.set("user", result as UserRow);
        c.set("tokenScopes", {
          endpoints: parseScopes(result.endpoint_scopes),
          packages: parseScopes(result.package_scopes),
          tokenType: result.token_type ?? "personal",
        });
      }
    } catch (err) {
      // Degrade to anonymous rather than failing the request
      console.error("Optional auth DB error (degrading to anonymous):", err);
    }
  }
  await next();
}

/**
 * Middleware factory: require a specific endpoint scope on the current token.
 * Must be used after authMiddleware.
 */
export function requireScope(endpoint: EndpointScope) {
  return async (c: Context<AppEnv>, next: Next) => {
    const scopes = c.get("tokenScopes");
    if (!scopes || !hasEndpointScope(scopes.endpoints, endpoint)) {
      throw forbidden(`Token lacks required scope: ${endpoint}`);
    }
    await next();
  };
}

/**
 * Check if the current token's package scopes allow acting on a specific package.
 * Call after authMiddleware. Returns false if scopes are missing or don't match.
 */
export function tokenCanActOnPackage(c: Context<AppEnv>, fullName: string): boolean {
  const scopes = c.get("tokenScopes");
  if (!scopes) return false;
  return matchesPackageScope(scopes.packages, fullName);
}

export async function adminMiddleware(c: Context<AppEnv>, next: Next) {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    throw forbidden("Admin access required");
  }
  await next();
}


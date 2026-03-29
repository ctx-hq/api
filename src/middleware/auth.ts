import type { Context, Next } from "hono";
import type { AppEnv } from "../bindings";
import type { UserRow } from "../models/types";
import { hashToken } from "../services/auth";
import { AppError, forbidden, unauthorized } from "../utils/errors";

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw unauthorized("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);
  const tokenHash = await hashToken(token);

  let result: UserRow | null;
  try {
    result = await c.env.DB.prepare(
      "SELECT u.* FROM api_tokens t JOIN users u ON t.user_id = u.id WHERE t.token_hash = ? AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))"
    ).bind(tokenHash).first<UserRow>();
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

  c.set("user", result);
  await next();
}

export async function optionalAuth(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const token = authHeader.slice(7);
      const tokenHash = await hashToken(token);
      const result = await c.env.DB.prepare(
        "SELECT u.* FROM api_tokens t JOIN users u ON t.user_id = u.id WHERE t.token_hash = ? AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))"
      ).bind(tokenHash).first<UserRow>();
      if (result) {
        c.set("user", result);
      }
    } catch (err) {
      // Degrade to anonymous rather than failing the request
      console.error("Optional auth DB error (degrading to anonymous):", err);
    }
  }
  await next();
}

export async function adminMiddleware(c: Context<AppEnv>, next: Next) {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    throw forbidden("Admin access required");
  }
  await next();
}


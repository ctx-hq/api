import type { Context, Next } from "hono";
import type { Bindings } from "../bindings";
import { hashToken } from "../services/auth";

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS_ANON = 180;
const MAX_REQUESTS_AUTH = 600;

export async function rateLimitMiddleware(c: Context<{ Bindings: Bindings }>, next: Next) {
  let maxRequests = MAX_REQUESTS_ANON;
  let rateLimitKey: string;

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  rateLimitKey = `rl:ip:${ip}`;

  // Authenticated users get a higher limit, keyed by user_id (not token)
  // to prevent quota amplification via multiple tokens
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const tokenHash = await hashToken(token);
    const row = await c.env.DB.prepare(
      "SELECT user_id FROM api_tokens WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > datetime('now'))"
    ).bind(tokenHash).first<{ user_id: string }>();
    if (row) {
      maxRequests = MAX_REQUESTS_AUTH;
      rateLimitKey = `rl:user:${row.user_id}`;
    }
  }

  const current = await c.env.CACHE.get(rateLimitKey);
  const count = current ? (parseInt(current) || 0) : 0;

  if (count >= maxRequests) {
    c.header("Retry-After", "60");
    c.header("X-RateLimit-Limit", String(maxRequests));
    c.header("X-RateLimit-Remaining", "0");
    return c.json({ error: "rate_limited", message: "Too many requests" }, 429);
  }

  await c.env.CACHE.put(rateLimitKey, String(count + 1), { expirationTtl: WINDOW_MS / 1000 });

  c.header("X-RateLimit-Limit", String(maxRequests));
  c.header("X-RateLimit-Remaining", String(maxRequests - count - 1));

  await next();
}

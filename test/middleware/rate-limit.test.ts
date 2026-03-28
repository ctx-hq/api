import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rateLimitMiddleware } from "../../src/middleware/rate-limit";
import { hashToken } from "../../src/services/auth";

function createMockKV(store: Map<string, string> = new Map()) {
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, val: string, _opts?: unknown) { store.set(key, val); },
    async delete(key: string) { store.delete(key); },
  };
}

function createMockDB(tokenUserId?: string) {
  return {
    prepare() {
      return {
        bind() { return this; },
        async first() {
          // Return user_id if token is valid
          return tokenUserId ? { user_id: tokenUserId } : null;
        },
      };
    },
  };
}

function createApp(kvStore: Map<string, string> = new Map(), tokenUserId?: string) {
  const mockKV = createMockKV(kvStore);
  const mockDB = createMockDB(tokenUserId);

  const app = new Hono();
  app.use("/v1/*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = { CACHE: mockKV, DB: mockDB };
    await next();
  });
  app.use("/v1/*", rateLimitMiddleware);
  app.get("/v1/test", (c) => c.json({ ok: true }));
  return app;
}

describe("rate limit middleware", () => {
  it("sets rate limit headers on response", async () => {
    const app = createApp();
    const res = await app.request("/v1/test", {
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("180");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("uses IP-based key for anonymous requests", async () => {
    const kv = new Map<string, string>();
    const app = createApp(kv);
    await app.request("/v1/test", {
      headers: { "CF-Connecting-IP": "10.0.0.1" },
    });

    expect(kv.has("rl:ip:10.0.0.1")).toBe(true);
  });

  it("uses user_id-based key for authenticated requests (not token hash)", async () => {
    const kv = new Map<string, string>();
    const userId = "user-alice-123";
    const app = createApp(kv, userId);

    await app.request("/v1/test", {
      headers: {
        "CF-Connecting-IP": "10.0.0.1",
        Authorization: "Bearer ctx_fake_token",
      },
    });

    // Should be keyed by user_id, NOT by token hash or IP
    expect(kv.has(`rl:user:${userId}`)).toBe(true);
    expect(kv.has("rl:ip:10.0.0.1")).toBe(false);
  });

  it("multiple tokens from same user share one rate limit quota", async () => {
    const kv = new Map<string, string>();
    const userId = "user-alice-123";

    // Simulate: token A already used 500 requests
    kv.set(`rl:user:${userId}`, "500");

    // Token B (different token, same user) should see the same count
    const app = createApp(kv, userId);
    const res = await app.request("/v1/test", {
      headers: {
        "CF-Connecting-IP": "10.0.0.1",
        Authorization: "Bearer ctx_different_token",
      },
    });

    expect(res.status).toBe(200);
    // Remaining should be based on 600 (auth limit) - 500 - 1 = 99
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("returns 429 when limit exceeded", async () => {
    const kv = new Map<string, string>();
    kv.set("rl:ip:1.2.3.4", "200");
    const app = createApp(kv);
    const res = await app.request("/v1/test", {
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });

    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("rate_limited");
  });
});

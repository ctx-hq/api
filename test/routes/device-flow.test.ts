import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import { AppError } from "../../src/utils/errors";

// --- Mock authMiddleware before importing routes ---

const testUser = {
  id: "user-test123",
  username: "testuser",
  email: "test@example.com",
  avatar_url: "https://avatars.example.com/test",
  github_id: "99999",
  role: "user" as const,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

let mockAuthUser: typeof testUser | null = testUser;

vi.mock("../../src/middleware/auth", () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!mockAuthUser) {
      return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
    }
    c.set("user", mockAuthUser);
    await next();
  },
}));

// Import actual routes AFTER mocks are set up
import authRoutes from "../../src/routes/auth";

// --- Mock KV store ---

interface MockKV {
  _store: Map<string, { value: string; ttl?: number }>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

function createMockKV(): MockKV {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    _store: store,
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, { value, ttl: opts?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

// --- Mock DB ---

interface MockDB {
  prepare(sql: string): MockStatement;
  _executed: Array<{ sql: string; params: unknown[] }>;
}

interface MockStatement {
  bind(...params: unknown[]): MockStatement;
  first<T = unknown>(): Promise<T | null>;
  all(): Promise<{ results: unknown[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockDB(overrides?: {
  firstFn?: (sql: string, params: unknown[]) => unknown | null;
}): MockDB {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const db: MockDB = {
    _executed: executed,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt: MockStatement = {
        bind(...params: unknown[]) {
          boundParams = params;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          executed.push({ sql, params: boundParams });
          return (overrides?.firstFn?.(sql, boundParams) as T) ?? null;
        },
        async all() {
          executed.push({ sql, params: boundParams });
          return { results: [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

// --- Build test app mounting actual auth routes ---

function createTestApp(cache: MockKV, db: MockDB) {
  const app = new Hono<AppEnv>();

  // Inject mock env
  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
      CACHE: cache,
      GITHUB_CLIENT_ID: "test-client-id",
      GITHUB_CLIENT_SECRET: "test-client-secret",
    };
    await next();
  });

  // Mount actual auth routes
  app.route("/", authRoutes);

  // Error handler matching production behavior
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode);
    }
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  return app;
}

// --- Tests ---

describe("POST /v1/auth/device — device code creation", () => {
  it("returns all required RFC 8628 fields including verification_uri_complete", async () => {
    const cache = createMockKV();
    const db = createMockDB();
    const app = createTestApp(cache, db);

    const res = await app.request("/v1/auth/device", { method: "POST" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("device_code");
    expect(body).toHaveProperty("user_code");
    expect(body).toHaveProperty("verification_uri", "https://getctx.org/login/device");
    expect(body).toHaveProperty("verification_uri_complete");
    expect(body.verification_uri_complete).toContain("?code=");
    expect(body).toHaveProperty("expires_in", 900);
    expect(body).toHaveProperty("interval", 5);
  });

  it("stores device code and reverse mapping in KV", async () => {
    const cache = createMockKV();
    const db = createMockDB();
    const app = createTestApp(cache, db);

    const res = await app.request("/v1/auth/device", { method: "POST" });
    const body = (await res.json()) as { device_code: string; user_code: string };

    // Check device code stored
    const deviceData = await cache.get(`device:${body.device_code}`);
    expect(deviceData).not.toBeNull();
    const parsed = JSON.parse(deviceData!);
    expect(parsed.status).toBe("pending");
    expect(parsed.user_code).toBe(body.user_code);

    // Check reverse mapping stored
    const reverseMapping = await cache.get(`usercode:${body.user_code}`);
    expect(reverseMapping).toBe(body.device_code);
  });

  it("stores KV entries with 900s TTL", async () => {
    const cache = createMockKV();
    const db = createMockDB();
    const app = createTestApp(cache, db);

    const res = await app.request("/v1/auth/device", { method: "POST" });
    const body = (await res.json()) as { device_code: string; user_code: string };

    const deviceEntry = cache._store.get(`device:${body.device_code}`);
    expect(deviceEntry?.ttl).toBe(900);

    const usercodeEntry = cache._store.get(`usercode:${body.user_code}`);
    expect(usercodeEntry?.ttl).toBe(900);
  });
});

describe("POST /v1/auth/device/authorize — device code authorization", () => {
  let cache: MockKV;
  let db: MockDB;
  let deviceCode: string;
  let userCode: string;

  beforeEach(async () => {
    mockAuthUser = testUser;
    cache = createMockKV();
    db = createMockDB();

    // Create a device code via the actual endpoint
    const app = createTestApp(cache, db);
    const res = await app.request("/v1/auth/device", { method: "POST" });
    const body = (await res.json()) as { device_code: string; user_code: string };
    deviceCode = body.device_code;
    userCode = body.user_code;
  });

  it("authorizes a valid code and updates KV", async () => {
    const app = createTestApp(cache, db);

    const res = await app.request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorized: boolean };
    expect(body.authorized).toBe(true);

    // Verify device code updated to authorized
    const deviceData = JSON.parse((await cache.get(`device:${deviceCode}`))!);
    expect(deviceData.status).toBe("authorized");
    expect(deviceData.github_id).toBe(testUser.github_id);
    expect(deviceData.username).toBe(testUser.username);

    // Verify reverse mapping deleted (optimistic lock)
    const reverseMapping = await cache.get(`usercode:${userCode}`);
    expect(reverseMapping).toBeNull();
  });

  it("stores authorized status with short TTL (120s)", async () => {
    const app = createTestApp(cache, db);

    await app.request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });

    const entry = cache._store.get(`device:${deviceCode}`);
    expect(entry?.ttl).toBe(120);
  });

  it("handles case-insensitive user codes", async () => {
    const app = createTestApp(cache, db);

    const res = await app.request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode.toLowerCase() }),
    });

    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid/expired code", async () => {
    const app = createTestApp(cache, db);

    const res = await app.request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: "BADCODE1" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Invalid or expired");
  });

  it("returns 400 for already authorized code (optimistic lock)", async () => {
    const app = createTestApp(cache, db);

    // First authorization succeeds
    await app.request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });

    // Second attempt fails — reverse mapping already deleted
    const res = await app.request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Invalid or expired");
  });

  it("returns 400 for missing user_code", async () => {
    const app = createTestApp(cache, db);

    const res = await app.request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("returns 401 for unauthenticated request", async () => {
    mockAuthUser = null;
    const app = createTestApp(cache, db);

    const res = await app.request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });

    expect(res.status).toBe(401);
  });
});

describe("POST /v1/auth/token — token polling", () => {
  it("returns authorization_pending (400) per RFC 8628", async () => {
    const cache = createMockKV();
    const db = createMockDB();
    const app = createTestApp(cache, db);

    await cache.put(
      "device:test-dc",
      JSON.stringify({ user_code: "TC", status: "pending" }),
    );

    const res = await app.request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "device_code=test-dc",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("authorization_pending");
  });

  it("returns access_token after authorization", async () => {
    const cache = createMockKV();
    const db = createMockDB({
      firstFn: (sql) => {
        if (sql.includes("SELECT id FROM users")) {
          return { id: "existing-user-id" };
        }
        return null;
      },
    });
    const app = createTestApp(cache, db);

    await cache.put(
      "device:test-dc",
      JSON.stringify({
        user_code: "TC",
        status: "authorized",
        github_id: "12345",
        username: "alice",
        email: "alice@example.com",
      }),
    );

    const res = await app.request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "device_code=test-dc",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string; scope: string };
    expect(body.access_token).toMatch(/^ctx_/);
    expect(body.token_type).toBe("bearer");
    expect(body.scope).toBe("read write");
  });

  it("creates user + scope + API token in DB for new user", async () => {
    const cache = createMockKV();
    const db = createMockDB(); // firstFn returns null → user not found → creates new
    const app = createTestApp(cache, db);

    await cache.put(
      "device:test-dc",
      JSON.stringify({
        user_code: "TC",
        status: "authorized",
        github_id: "12345",
        username: "alice",
        email: "",
      }),
    );

    await app.request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "device_code=test-dc",
    });

    const userInsert = db._executed.find((e) => e.sql.includes("INSERT INTO users"));
    expect(userInsert).toBeDefined();

    const tokenInsert = db._executed.find((e) => e.sql.includes("INSERT INTO api_tokens"));
    expect(tokenInsert).toBeDefined();
  });

  it("creates API token for existing user without inserting new user", async () => {
    const cache = createMockKV();
    const db = createMockDB({
      firstFn: (sql) => {
        if (sql.includes("SELECT id FROM users")) {
          return { id: "user-id" };
        }
        return null;
      },
    });
    const app = createTestApp(cache, db);

    await cache.put(
      "device:test-dc",
      JSON.stringify({ user_code: "TC", status: "authorized", github_id: "12345", username: "alice", email: "" }),
    );

    await app.request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "device_code=test-dc",
    });

    const tokenInsert = db._executed.find((e) => e.sql.includes("INSERT INTO api_tokens"));
    expect(tokenInsert).toBeDefined();

    const userInsert = db._executed.find((e) => e.sql.includes("INSERT INTO users"));
    expect(userInsert).toBeUndefined();
  });

  it("cleans up device code after token issued", async () => {
    const cache = createMockKV();
    const db = createMockDB({
      firstFn: () => ({ id: "user-id" }),
    });
    const app = createTestApp(cache, db);

    await cache.put(
      "device:test-dc",
      JSON.stringify({ user_code: "TC", status: "authorized", github_id: "12345", username: "alice", email: "" }),
    );

    await app.request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "device_code=test-dc",
    });

    const remaining = await cache.get("device:test-dc");
    expect(remaining).toBeNull();
  });

  it("returns expired_token for missing device code", async () => {
    const cache = createMockKV();
    const db = createMockDB();
    const app = createTestApp(cache, db);

    const res = await app.request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "device_code=nonexistent",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("expired_token");
  });

  it("returns invalid_request when device_code missing", async () => {
    const cache = createMockKV();
    const db = createMockDB();
    const app = createTestApp(cache, db);

    const res = await app.request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });
});

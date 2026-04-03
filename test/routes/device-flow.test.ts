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

// --- Mock DB with device_codes table support ---

interface MockDB {
  prepare(sql: string): MockStatement;
  _executed: Array<{ sql: string; params: unknown[] }>;
  _deviceCodes: Map<string, { device_code: string; user_code: string; status: string; github_id?: string; username?: string; email?: string; expires_at: string }>;
}

interface MockStatement {
  bind(...params: unknown[]): MockStatement;
  first<T = unknown>(): Promise<T | null>;
  all(): Promise<{ results: unknown[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockDB(overrides?: {
  firstFn?: (sql: string, params: unknown[]) => unknown | null;
  runFn?: (sql: string, params: unknown[]) => { success: boolean; meta: { changes: number } } | undefined;
  failOnInsertDeviceCode?: boolean;
}): MockDB {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const deviceCodes = new Map<string, { device_code: string; user_code: string; status: string; github_id?: string; username?: string; email?: string; expires_at: string }>();

  const db: MockDB = {
    _executed: executed,
    _deviceCodes: deviceCodes,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt: MockStatement = {
        bind(...params: unknown[]) {
          boundParams = params;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          executed.push({ sql, params: boundParams });

          // Override takes precedence
          if (overrides?.firstFn) {
            const result = overrides.firstFn(sql, boundParams);
            if (result !== undefined) return result as T;
          }

          // device_codes SELECT by device_code
          if (sql.includes("FROM device_codes") && sql.includes("device_code = ?")) {
            const code = boundParams[0] as string;
            const row = deviceCodes.get(code);
            if (row && new Date(row.expires_at) > new Date()) {
              return row as unknown as T;
            }
            return null;
          }

          return null;
        },
        async all() {
          executed.push({ sql, params: boundParams });
          return { results: [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });

          // Override takes precedence
          if (overrides?.runFn) {
            const result = overrides.runFn(sql, boundParams);
            if (result) return result;
          }

          // INSERT INTO device_codes
          if (sql.includes("INSERT INTO device_codes")) {
            if (overrides?.failOnInsertDeviceCode) {
              throw new Error("D1_ERROR: database unavailable");
            }
            const [deviceCode, userCode] = boundParams as [string, string];
            deviceCodes.set(deviceCode, {
              device_code: deviceCode,
              user_code: userCode,
              status: "pending",
              // Simulate SQLite datetime('now', '+900 seconds')
              expires_at: new Date(Date.now() + 900_000).toISOString(),
            });
            return { success: true, meta: { changes: 1 } };
          }

          // UPDATE device_codes SET status = 'authorized'
          if (sql.includes("UPDATE device_codes") && sql.includes("status = 'authorized'")) {
            const [githubId, username, email, userCode] = boundParams as [string, string, string, string];
            // Find by user_code with status=pending (UPPER() comparison)
            for (const [key, row] of deviceCodes) {
              if (row.user_code.toUpperCase() === userCode.toUpperCase() && row.status === "pending" && new Date(row.expires_at) > new Date()) {
                row.status = "authorized";
                row.github_id = githubId;
                row.username = username;
                row.email = email;
                row.expires_at = new Date(Date.now() + 120_000).toISOString();
                return { success: true, meta: { changes: 1 } };
              }
            }
            return { success: true, meta: { changes: 0 } };
          }

          // DELETE FROM device_codes WHERE device_code = ?
          if (sql.includes("DELETE FROM device_codes") && sql.includes("device_code = ?")) {
            const code = boundParams[0] as string;
            const deleted = deviceCodes.delete(code);
            return { success: true, meta: { changes: deleted ? 1 : 0 } };
          }

          // DELETE expired device codes (cleanup)
          if (sql.includes("DELETE FROM device_codes") && sql.includes("expires_at")) {
            return { success: true, meta: { changes: 0 } };
          }

          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

// --- Build test app mounting actual auth routes ---

function createTestApp(db: MockDB) {
  const app = new Hono<AppEnv>();

  // Inject mock env
  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
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

  const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const request: typeof app.request = (input, init, env) =>
    app.request(input, init, env, mockExecCtx as any);

  return { app, request };
}

// --- Tests ---

describe("POST /v1/auth/device — device code creation", () => {
  it("returns all required RFC 8628 fields including verification_uri_complete", async () => {
    const db = createMockDB();
    const { request } = createTestApp(db);

    const res = await request("/v1/auth/device", { method: "POST" });
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

  it("stores device code in D1", async () => {
    const db = createMockDB();
    const { request } = createTestApp(db);

    const res = await request("/v1/auth/device", { method: "POST" });
    const body = (await res.json()) as { device_code: string; user_code: string };

    // Verify device code stored in D1
    const row = db._deviceCodes.get(body.device_code);
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");
    expect(row!.user_code).toBe(body.user_code);

    // Verify INSERT was executed
    const insert = db._executed.find((e) => e.sql.includes("INSERT INTO device_codes"));
    expect(insert).toBeDefined();
  });
});

describe("POST /v1/auth/device — DB failure handling", () => {
  it("returns 503 when DB is unavailable", async () => {
    const db = createMockDB({ failOnInsertDeviceCode: true });
    const { request } = createTestApp(db);

    const res = await request("/v1/auth/device", { method: "POST" });
    expect(res.status).toBe(503);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("service_unavailable");
    expect(body.message).toContain("temporarily unavailable");
  });
});

describe("POST /v1/auth/device/authorize — device code authorization", () => {
  let db: MockDB;
  let deviceCode: string;
  let userCode: string;

  beforeEach(async () => {
    mockAuthUser = testUser;
    db = createMockDB();

    // Create a device code via the actual endpoint
    const { request } = createTestApp(db);
    const res = await request("/v1/auth/device", { method: "POST" });
    const body = (await res.json()) as { device_code: string; user_code: string };
    deviceCode = body.device_code;
    userCode = body.user_code;
  });

  it("authorizes a valid code and updates D1", async () => {
    const { request } = createTestApp(db);

    const res = await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorized: boolean };
    expect(body.authorized).toBe(true);

    // Verify device code updated to authorized in D1
    const row = db._deviceCodes.get(deviceCode);
    expect(row!.status).toBe("authorized");
    expect(row!.github_id).toBe(testUser.github_id);
    expect(row!.username).toBe(testUser.username);
  });

  it("handles case-insensitive user codes", async () => {
    const { request } = createTestApp(db);

    const res = await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode.toLowerCase() }),
    });

    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid/expired code", async () => {
    const { request } = createTestApp(db);

    const res = await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: "BADCODE1" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Invalid or expired");
  });

  it("returns 400 for already authorized code (optimistic lock)", async () => {
    const { request } = createTestApp(db);

    // First authorization succeeds
    await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });

    // Second attempt fails — status is no longer 'pending'
    const res = await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Invalid or expired");
  });

  it("returns 400 for missing user_code", async () => {
    const { request } = createTestApp(db);

    const res = await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("returns 401 for unauthenticated request", async () => {
    mockAuthUser = null;
    const { request } = createTestApp(db);

    const res = await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });

    expect(res.status).toBe(401);
  });
});

describe("POST /v1/auth/token — token polling", () => {
  beforeEach(() => {
    mockAuthUser = testUser;
  });

  it("returns authorization_pending (400) per RFC 8628", async () => {
    const db = createMockDB();
    const { request } = createTestApp(db);

    // Create a pending device code
    const createRes = await request("/v1/auth/device", { method: "POST" });
    const { device_code } = (await createRes.json()) as { device_code: string };

    const res = await request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `device_code=${device_code}`,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("authorization_pending");
  });

  it("returns access_token after authorization", async () => {
    const db = createMockDB({
      firstFn: (sql, params) => {
        if (sql.includes("SELECT id FROM users")) {
          return { id: "existing-user-id" };
        }
        return undefined;
      },
    });
    const { request } = createTestApp(db);

    // Create and authorize a device code
    const createRes = await request("/v1/auth/device", { method: "POST" });
    const { device_code, user_code } = (await createRes.json()) as { device_code: string; user_code: string };

    await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code }),
    });

    const res = await request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `device_code=${device_code}`,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string; scope: string };
    expect(body.access_token).toMatch(/^ctx_/);
    expect(body.token_type).toBe("bearer");
    expect(body.scope).toBe("read write");
  });

  it("creates user + scope + API token in DB for new user", async () => {
    const db = createMockDB();
    const { request } = createTestApp(db);

    // Create and authorize
    const createRes = await request("/v1/auth/device", { method: "POST" });
    const { device_code, user_code } = (await createRes.json()) as { device_code: string; user_code: string };

    await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code }),
    });

    await request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `device_code=${device_code}`,
    });

    const userInsert = db._executed.find((e) => e.sql.includes("INSERT INTO users"));
    expect(userInsert).toBeDefined();

    const tokenInsert = db._executed.find((e) => e.sql.includes("INSERT INTO api_tokens"));
    expect(tokenInsert).toBeDefined();
  });

  it("creates API token for existing user without inserting new user", async () => {
    const db = createMockDB({
      firstFn: (sql) => {
        if (sql.includes("SELECT id FROM users")) {
          return { id: "user-id" };
        }
        return undefined;
      },
    });
    const { request } = createTestApp(db);

    // Create and authorize
    const createRes = await request("/v1/auth/device", { method: "POST" });
    const { device_code, user_code } = (await createRes.json()) as { device_code: string; user_code: string };

    await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code }),
    });

    await request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `device_code=${device_code}`,
    });

    const tokenInsert = db._executed.find((e) => e.sql.includes("INSERT INTO api_tokens"));
    expect(tokenInsert).toBeDefined();

    const userInsert = db._executed.find((e) => e.sql.includes("INSERT INTO users"));
    expect(userInsert).toBeUndefined();
  });

  it("cleans up device code after token issued", async () => {
    const db = createMockDB({
      firstFn: (sql) => {
        if (sql.includes("SELECT id FROM users")) return { id: "user-id" };
        return undefined;
      },
    });
    const { request } = createTestApp(db);

    // Create and authorize
    const createRes = await request("/v1/auth/device", { method: "POST" });
    const { device_code, user_code } = (await createRes.json()) as { device_code: string; user_code: string };

    await request("/v1/auth/device/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code }),
    });

    await request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `device_code=${device_code}`,
    });

    // Verify device code was deleted from D1
    const deleteOp = db._executed.find(
      (e) => e.sql.includes("DELETE FROM device_codes") && e.sql.includes("device_code = ?")
    );
    expect(deleteOp).toBeDefined();
    expect(db._deviceCodes.has(device_code)).toBe(false);
  });

  it("returns expired_token for missing device code", async () => {
    const db = createMockDB();
    const { request } = createTestApp(db);

    const res = await request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "device_code=nonexistent",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("expired_token");
  });

  it("returns invalid_request when device_code missing", async () => {
    const db = createMockDB();
    const { request } = createTestApp(db);

    const res = await request("/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });
});

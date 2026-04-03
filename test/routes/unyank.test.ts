import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import publishRoute from "../../src/routes/publish";
import { AppError } from "../../src/utils/errors";

// --- Mock DB ---

interface MockDB {
  prepare(sql: string): MockStatement;
  batch(stmts: MockStatement[]): Promise<unknown[]>;
  _executed: Array<{ sql: string; params: unknown[] }>;
}

interface MockStatement {
  bind(...params: unknown[]): MockStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockDB(overrides?: {
  firstFn?: (sql: string, params: unknown[]) => unknown | null;
  allFn?: (sql: string, params: unknown[]) => unknown[];
  runFn?: (sql: string, params: unknown[]) => number;
}): MockDB {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const db: MockDB = {
    _executed: executed,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt: MockStatement = {
        bind(...params: unknown[]) { boundParams = params; return stmt; },
        async first<T>(): Promise<T | null> {
          executed.push({ sql, params: boundParams });
          return (overrides?.firstFn?.(sql, boundParams) as T) ?? null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          executed.push({ sql, params: boundParams });
          return { results: (overrides?.allFn?.(sql, boundParams) as T[]) ?? [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          const changes = overrides?.runFn?.(sql, boundParams) ?? 1;
          return { success: true, meta: { changes } };
        },
      };
      return stmt;
    },
    async batch(stmts: MockStatement[]) {
      return Promise.all(stmts.map(s => s.run()));
    },
  };
  return db;
}

// --- Fixtures ---

const mockUser = { id: "user-1", username: "alice", role: "user", github_id: 1, avatar_url: "", created_at: "", updated_at: "" };

const mockPkg = {
  id: "pkg-1",
  full_name: "@alice/my-tool",
  owner_type: "user",
  owner_id: "user-1",
  scope: "alice",
  name: "my-tool",
  deleted_at: null,
};

const authHeaders = { Authorization: "Bearer test-token" };

// --- App factory: mounts REAL publishRoute ---

function createUnyankApp(opts?: {
  user?: typeof mockUser | null;
  pkg?: typeof mockPkg | null;
  versionFound?: boolean;
}) {
  const { user = mockUser, pkg = mockPkg, versionFound = true } = opts ?? {};

  const db = createMockDB({
    firstFn: (sql) => {
      // authMiddleware: token → user
      if (sql.includes("api_tokens") && sql.includes("token_hash")) return user;
      // Package lookup
      if (sql.includes("FROM packages p WHERE p.full_name")) return pkg;
      // canManage → getOwnerForScope: scope → owner
      if (sql.includes("FROM scopes WHERE name")) return pkg ? { name: "alice", owner_type: "user", owner_id: "user-1" } : null;
      return null;
    },
    runFn: (sql) => {
      if (sql.includes("UPDATE versions SET yanked")) {
        return versionFound ? 1 : 0;
      }
      return 1;
    },
  });

  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
      FORMULAS: { put: async () => {}, get: async () => null, head: async () => null, delete: async () => {} },
      PRIVATE_FORMULAS: { put: async () => {}, get: async () => null, head: async () => null, delete: async () => {} },
      ENRICHMENT_QUEUE: { send: async () => {} },
    };
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode);
    return c.json({ error: "internal_error", message: String(err) }, 500);
  });

  // Mount the REAL publish routes
  app.route("/", publishRoute);

  const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const request: typeof app.request = (input, init, env) =>
    app.request(input, init, env, mockExecCtx as any);

  return { app, db, request };
}

const unyankPath = `/v1/packages/${encodeURIComponent("@alice/my-tool")}/versions/1.0.0/unyank`;

// --- Tests ---

describe("POST /v1/packages/:fullName/versions/:version/unyank (real route)", () => {
  it("successfully unyanks a version", async () => {
    const { request } = createUnyankApp();
    const res = await request(unyankPath, { method: "POST", headers: authHeaders });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.yanked).toBe(false);
    expect(json.full_name).toBe("@alice/my-tool");
    expect(json.version).toBe("1.0.0");
  });

  it("returns 404 for non-existent version", async () => {
    const { request } = createUnyankApp({ versionFound: false });
    const notFoundPath = `/v1/packages/${encodeURIComponent("@alice/my-tool")}/versions/9.9.9/unyank`;
    const res = await request(notFoundPath, { method: "POST", headers: authHeaders });
    expect(res.status).toBe(404);
  });

  it("returns 401 for unauthenticated request", async () => {
    const { request } = createUnyankApp({ user: null });
    const res = await request(unyankPath, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-owner", async () => {
    const { request } = createUnyankApp({ user: { ...mockUser, id: "user-999", username: "eve" } });
    const res = await request(unyankPath, { method: "POST", headers: authHeaders });
    expect(res.status).toBe(403);
  });

  it("returns 400 when package not found", async () => {
    const { request } = createUnyankApp({ pkg: null });
    const res = await request(unyankPath, { method: "POST", headers: authHeaders });
    expect(res.status).toBe(400);
  });

  it("executes correct UPDATE SQL", async () => {
    const { request, db } = createUnyankApp();
    await request(unyankPath, { method: "POST", headers: authHeaders });
    const updateSql = db._executed.find(e => e.sql.includes("UPDATE versions SET yanked = 0"));
    expect(updateSql).toBeDefined();
    expect(updateSql!.params).toContain("pkg-1");
    expect(updateSql!.params).toContain("1.0.0");
  });
});

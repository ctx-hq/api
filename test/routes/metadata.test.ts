import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import packagesRoute from "../../src/routes/packages";
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
  type: "skill",
  description: "Old description",
  summary: "",
  keywords: '["old"]',
  capabilities: "[]",
  downloads: 10,
  visibility: "public",
  owner_type: "user",
  owner_id: "user-1",
  mutable: 0,
};

const authHeaders = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

// --- App factory: mounts REAL packagesRoute ---

function createMetadataApp(opts?: {
  user?: typeof mockUser | null;
  pkg?: typeof mockPkg | null;
}) {
  const { user = mockUser, pkg = mockPkg } = opts ?? {};
  let syncKeywordsCalled = false;
  let enrichmentQueued = false;

  const db = createMockDB({
    firstFn: (sql, params) => {
      // authMiddleware: token → user
      if (sql.includes("api_tokens") && sql.includes("token_hash")) return user;
      // canManage → getOwnerForScope: scope → owner
      if (sql.includes("FROM scopes WHERE name")) return pkg ? { name: "alice", owner_type: "user", owner_id: "user-1" } : null;
      // Package lookup
      if (sql.includes("FROM packages WHERE full_name") && sql.includes("deleted_at IS NULL")) return pkg;
      // getLatestVersion
      if (sql.includes("FROM versions") && sql.includes("ORDER BY")) return { version: "1.0.0" };
      // getOwnerProfile: user lookup
      if (sql.includes("FROM users WHERE id")) return { username: "alice", avatar_url: "" };
      return null;
    },
  });

  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
      ENRICHMENT_QUEUE: { send: async () => { enrichmentQueued = true; } },
    };
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode);
    return c.json({ error: "internal_error", message: String(err) }, 500);
  });

  // Mount the REAL routes
  app.route("/", packagesRoute);

  const mockExecCtx = { waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); }, passThroughOnException: () => {} };
  const request: typeof app.request = (input, init, env) =>
    app.request(input, init, env, mockExecCtx as any);

  return { app, db, request, get enrichmentQueued() { return enrichmentQueued; } };
}

const pkgPath = `/v1/packages/${encodeURIComponent("@alice/my-tool")}/metadata`;

// --- Tests ---

describe("PATCH /v1/packages/:fullName/metadata (real route)", () => {
  it("updates description only", async () => {
    const { request } = createMetadataApp();
    const res = await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ description: "New description" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.full_name).toBe("@alice/my-tool");
    expect(json.description).toBe("New description");
  });

  it("updates multiple fields", async () => {
    const { request } = createMetadataApp();
    const res = await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        description: "Updated",
        keywords: ["ai", "tool"],
        homepage: "https://example.com",
        license: "MIT",
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.description).toBe("Updated");
    expect(json.keywords).toEqual(["ai", "tool"]);
    expect(json.homepage).toBe("https://example.com");
    expect(json.license).toBe("MIT");
  });

  it("rejects description exceeding 1024 chars", async () => {
    const { request } = createMetadataApp();
    const res = await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ description: "x".repeat(1025) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects keywords with more than 20 items", async () => {
    const { request } = createMetadataApp();
    const keywords = Array.from({ length: 21 }, (_, i) => `kw-${i}`);
    const res = await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ keywords }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects keyword exceeding 50 chars", async () => {
    const { request } = createMetadataApp();
    const res = await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ keywords: ["x".repeat(51)] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty body (no valid fields)", async () => {
    const { request } = createMetadataApp();
    const res = await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ unknown_field: "value" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 for unauthenticated request", async () => {
    const { request } = createMetadataApp({ user: null });
    const res = await request(pkgPath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent package", async () => {
    const { request } = createMetadataApp({ pkg: null });
    const res = await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ description: "test" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-owner", async () => {
    const { request } = createMetadataApp({ user: { ...mockUser, id: "user-999", username: "eve" } });
    const res = await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ description: "hacked" }),
    });
    expect(res.status).toBe(403);
  });

  it("generates correct UPDATE SQL for partial update", async () => {
    const { request, db } = createMetadataApp();
    await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ description: "New", license: "Apache-2.0" }),
    });
    const updateSql = db._executed.find(e => e.sql.startsWith("UPDATE packages SET"));
    expect(updateSql).toBeDefined();
    expect(updateSql!.sql).toContain("description = ?");
    expect(updateSql!.sql).toContain("license = ?");
    expect(updateSql!.sql).toContain("updated_at = datetime('now')");
  });

  it("refreshes search_digest for public packages", async () => {
    const { request, db } = createMetadataApp();
    await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ description: "Updated" }),
    });
    // upsertSearchDigest should have been called (INSERT OR REPLACE INTO search_digest)
    const digestSql = db._executed.find(e => e.sql.includes("search_digest"));
    expect(digestSql).toBeDefined();
  });

  it("calls syncKeywords when keywords are updated", async () => {
    const { request, db } = createMetadataApp();
    await request(pkgPath, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ keywords: ["ai", "tool"] }),
    });
    await new Promise(r => setTimeout(r, 10));
    // syncKeywords should have inserted into keywords table
    const keywordInsert = db._executed.find(e => e.sql.includes("INSERT OR IGNORE INTO keywords"));
    expect(keywordInsert).toBeDefined();
  });
});

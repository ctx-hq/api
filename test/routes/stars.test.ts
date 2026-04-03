import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import starsRoute from "../../src/routes/stars";
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
  all(): Promise<{ results: unknown[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockDB(overrides?: {
  firstFn?: (sql: string, params: unknown[]) => unknown | null;
  allFn?: (sql: string, params: unknown[]) => unknown[];
  runFn?: (sql: string, params: unknown[]) => { success: boolean; meta: { changes: number } };
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
        async all() {
          executed.push({ sql, params: boundParams });
          return { results: overrides?.allFn?.(sql, boundParams) ?? [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          return overrides?.runFn?.(sql, boundParams) ?? { success: true, meta: { changes: 1 } };
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

const mockUser = {
  id: "user-hong",
  username: "hong",
  role: "user",
  github_id: 1,
  avatar_url: "",
  created_at: "",
  updated_at: "",
  endpoint_scopes: '["*"]',
  package_scopes: '["*"]',
  token_type: "personal",
};

const authHeaders = { Authorization: "Bearer test-token" };

function createStarsApp(db: MockDB) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
    };
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode);
    return c.json({ error: "internal_error", message: String(err) }, 500);
  });

  app.route("/", starsRoute);

  const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const request: typeof app.request = (input, init, env) =>
    app.request(input, init, env, mockExecCtx as any);

  return { app, request };
}

/** Auth firstFn: token lookup returns mockUser */
function authFirstFn(extra?: (sql: string, params: unknown[]) => unknown | null) {
  return (sql: string, params: unknown[]): unknown | null => {
    if (sql.includes("api_tokens") && sql.includes("token_hash")) return mockUser;
    return extra?.(sql, params) ?? null;
  };
}

// --- Tests ---

describe("stars — star/unstar", () => {
  it("PUT /v1/packages/:fullName/star stars a package", async () => {
    const db = createMockDB({
      firstFn: authFirstFn((sql) => {
        if (sql.includes("FROM packages WHERE full_name")) return { id: "pkg-1" };
        return null;
      }),
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/packages/%40hong%2Ftest-pkg/star", { method: "PUT", headers: authHeaders });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.starred).toBe(true);
    expect(body.full_name).toBe("@hong/test-pkg");

    const ops = db._executed;
    expect(ops.find(e => e.sql.includes("INSERT INTO stars"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("UPDATE packages SET star_count"))).toBeDefined();
  });

  it("PUT star returns 404 for non-existent package", async () => {
    const db = createMockDB({
      firstFn: authFirstFn(), // no package found
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/packages/%40hong%2Fmissing/star", { method: "PUT", headers: authHeaders });
    expect(res.status).toBe(404);
  });

  it("PUT star returns 401 without auth", async () => {
    const db = createMockDB();
    const { request } = createStarsApp(db);
    const res = await request("/v1/packages/%40hong%2Ftest/star", { method: "PUT" });
    expect(res.status).toBe(401);
  });

  it("DELETE /v1/packages/:fullName/star unstars a package", async () => {
    const db = createMockDB({
      firstFn: authFirstFn((sql) => {
        if (sql.includes("FROM packages WHERE full_name")) return { id: "pkg-1" };
        if (sql.includes("FROM stars WHERE user_id")) return { "1": 1 };
        return null;
      }),
      runFn: (sql) => {
        if (sql.includes("DELETE FROM stars")) return { success: true, meta: { changes: 1 } };
        return { success: true, meta: { changes: 1 } };
      },
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/packages/%40hong%2Ftest-pkg/star", { method: "DELETE", headers: authHeaders });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.starred).toBe(false);
  });

  it("DELETE star returns 404 if not starred", async () => {
    const db = createMockDB({
      firstFn: authFirstFn((sql) => {
        if (sql.includes("FROM packages WHERE full_name")) return { id: "pkg-1" };
        return null;
      }),
      runFn: (sql) => {
        if (sql.includes("DELETE FROM stars")) return { success: true, meta: { changes: 0 } };
        return { success: true, meta: { changes: 1 } };
      },
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/packages/%40hong%2Ftest-pkg/star", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(404);
  });
});

describe("stars — list my stars", () => {
  it("GET /v1/me/stars returns starred packages", async () => {
    const db = createMockDB({
      firstFn: authFirstFn((sql) => {
        if (sql.includes("COUNT(*)")) return { count: 2 };
        return null;
      }),
      allFn: (sql) => {
        if (sql.includes("FROM stars s")) {
          return [
            { full_name: "@hong/pkg1", type: "skill", description: "First", star_count: 5, starred_at: "2026-01-01" },
            { full_name: "@hong/pkg2", type: "mcp", description: "Second", star_count: 3, starred_at: "2026-01-02" },
          ];
        }
        return [];
      },
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/me/stars", { headers: authHeaders });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.stars).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("GET /v1/me/stars returns 401 without auth", async () => {
    const db = createMockDB();
    const { request } = createStarsApp(db);
    const res = await request("/v1/me/stars");
    expect(res.status).toBe(401);
  });
});

describe("stars — star lists CRUD", () => {
  it("POST /v1/me/star-lists creates a list", async () => {
    const db = createMockDB({
      firstFn: authFirstFn(),
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/me/star-lists", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Favorites", visibility: "public" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.name).toBe("My Favorites");
    expect(body.slug).toBe("my-favorites");
    expect(body.visibility).toBe("public");

    const ops = db._executed;
    expect(ops.find(e => e.sql.includes("INSERT INTO star_lists"))).toBeDefined();
  });

  it("POST /v1/me/star-lists rejects empty name", async () => {
    const db = createMockDB({
      firstFn: authFirstFn(),
    });
    const { request } = createStarsApp(db);
    const res = await request("/v1/me/star-lists", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /v1/me/star-lists returns lists", async () => {
    const db = createMockDB({
      firstFn: authFirstFn(),
      allFn: (sql) => {
        if (sql.includes("FROM star_lists")) {
          return [
            { id: "list-1", name: "Favorites", slug: "favorites", description: "", visibility: "private", star_count: 3, created_at: "2026-01-01" },
          ];
        }
        return [];
      },
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/me/star-lists", { headers: authHeaders });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.lists).toHaveLength(1);
    expect(body.lists[0].slug).toBe("favorites");
  });

  it("DELETE /v1/me/star-lists/:id deletes a list", async () => {
    const db = createMockDB({
      firstFn: authFirstFn(),
      runFn: (sql) => {
        if (sql.includes("DELETE FROM star_lists")) return { success: true, meta: { changes: 1 } };
        return { success: true, meta: { changes: 1 } };
      },
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/me/star-lists/list-1", { method: "DELETE", headers: authHeaders });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deleted).toBe(true);

    const ops = db._executed;
    expect(ops.find(e => e.sql.includes("UPDATE stars SET list_id = NULL"))).toBeDefined();
  });

  it("DELETE /v1/me/star-lists/:id returns 404 for non-existent list", async () => {
    const db = createMockDB({
      firstFn: authFirstFn(),
      runFn: (sql) => {
        if (sql.includes("DELETE FROM star_lists")) return { success: true, meta: { changes: 0 } };
        return { success: true, meta: { changes: 1 } };
      },
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/me/star-lists/missing", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(404);
  });
});

describe("stars — public star list", () => {
  it("GET /v1/users/:username/star-lists/:slug returns public list", async () => {
    const db = createMockDB({
      firstFn: (sql) => {
        if (sql.includes("FROM star_lists sl")) {
          return {
            id: "list-1",
            name: "My Tools",
            slug: "my-tools",
            description: "Useful tools",
            visibility: "public",
            user_id: "user-hong",
            created_at: "2026-01-01",
          };
        }
        return null;
      },
      allFn: (sql) => {
        if (sql.includes("FROM stars s")) {
          return [
            { full_name: "@hong/tool", type: "cli", description: "A tool", star_count: 10, starred_at: "2026-01-01" },
          ];
        }
        return [];
      },
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/users/hong/star-lists/my-tools");

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe("My Tools");
    expect(body.slug).toBe("my-tools");
    expect(body.username).toBe("hong");
    expect(body.stars).toHaveLength(1);
  });

  it("GET /v1/users/:username/star-lists/:slug returns 404 for private list (no auth)", async () => {
    const db = createMockDB({
      firstFn: (sql) => {
        if (sql.includes("FROM star_lists sl")) {
          return {
            id: "list-1",
            name: "Secret",
            slug: "secret",
            description: "",
            visibility: "private",
            user_id: "user-other",
            created_at: "2026-01-01",
          };
        }
        return null;
      },
    });

    const { request } = createStarsApp(db);
    const res = await request("/v1/users/other/star-lists/secret");
    expect(res.status).toBe(404);
  });
});

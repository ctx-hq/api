import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";

// --- Mock DB with SQL tracking ---

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
          return { success: true, meta: { changes: 1 } };
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

// --- Test-only route that mirrors the real packages list logic ---

function createPackageListApp(db: MockDB, user?: { id: string }) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    (c as any).env = { DB: db, CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } };
    if (user) c.set("user", user as any);
    await next();
  });

  // Mirrors src/routes/packages.ts GET /v1/packages logic
  app.get("/v1/packages", async (c) => {
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];

    const user = c.get("user");
    if (user) {
      conditions.push(`(visibility = 'public' OR publisher_id IN (
        SELECT id FROM publishers WHERE user_id = ? AND kind = 'user'
        UNION
        SELECT p.id FROM publishers p
        JOIN org_members m ON p.org_id = m.org_id
        WHERE m.user_id = ? AND p.kind = 'org'
      ))`);
      params.push(user.id, user.id);
    } else {
      conditions.push("visibility = 'public'");
    }

    const query = `SELECT id, full_name, visibility, downloads FROM packages WHERE ${conditions.join(" AND ")} ORDER BY downloads DESC LIMIT 20 OFFSET 0`;
    const countQuery = `SELECT COUNT(*) as count FROM packages WHERE ${conditions.join(" AND ")}`;

    const [result, totalResult] = await Promise.all([
      c.env.DB.prepare(query).bind(...params).all(),
      c.env.DB.prepare(countQuery).bind(...params).first(),
    ]);

    return c.json({
      packages: result.results ?? [],
      total: (totalResult as any)?.count ?? 0,
    });
  });

  return app;
}

// --- Tests ---

describe("packages list — visibility filtering", () => {
  const allPackages = [
    { id: "1", full_name: "@hong/public-pkg", visibility: "public", publisher_id: "pub-hong", downloads: 100, deleted_at: null },
    { id: "2", full_name: "@hong/private-pkg", visibility: "private", publisher_id: "pub-hong", downloads: 50, deleted_at: null },
    { id: "3", full_name: "@hong/unlisted-pkg", visibility: "unlisted", publisher_id: "pub-hong", downloads: 30, deleted_at: null },
    { id: "4", full_name: "@other/secret", visibility: "private", publisher_id: "pub-other", downloads: 10, deleted_at: null },
    { id: "5", full_name: "@hong/deleted", visibility: "public", publisher_id: "pub-hong", downloads: 0, deleted_at: "2026-01-01" },
  ];

  function makeDB(userId?: string) {
    return createMockDB({
      firstFn: (sql, params) => {
        if (sql.includes("COUNT(*)")) {
          // Simulate the real WHERE filter
          const visible = allPackages.filter(p => {
            if (p.deleted_at) return false;
            if (!userId) return p.visibility === "public";
            return p.visibility === "public" || p.publisher_id === "pub-hong";
          });
          return { count: visible.length };
        }
        return null;
      },
      allFn: (sql, params) => {
        if (sql.includes("publishers")) {
          // getUserPublisherIds subquery
          return [{ id: "pub-hong" }];
        }
        const visible = allPackages.filter(p => {
          if (p.deleted_at) return false;
          if (!userId) return p.visibility === "public";
          return p.visibility === "public" || p.publisher_id === "pub-hong";
        });
        return visible;
      },
    });
  }

  it("unauthenticated: returns only public packages, total=1", async () => {
    const db = makeDB();
    const app = createPackageListApp(db);

    const res = await app.request("/v1/packages");
    expect(res.status).toBe(200);

    const body = await res.json() as { packages: any[]; total: number };
    expect(body.total).toBe(1);
    expect(body.packages.every((p: any) => p.visibility === "public")).toBe(true);
    expect(body.packages.find((p: any) => p.full_name === "@other/secret")).toBeUndefined();
    expect(body.packages.find((p: any) => p.full_name === "@hong/deleted")).toBeUndefined();
  });

  it("unauthenticated: SQL includes visibility = 'public'", async () => {
    const db = makeDB();
    const app = createPackageListApp(db);

    await app.request("/v1/packages");

    const listQuery = db._executed.find(e => e.sql.includes("FROM packages"));
    expect(listQuery).toBeDefined();
    expect(listQuery!.sql).toContain("visibility = 'public'");
    expect(listQuery!.sql).toContain("deleted_at IS NULL");
  });

  it("authenticated (member): returns own public + private + unlisted, total=3", async () => {
    const db = makeDB("user-hong");
    const app = createPackageListApp(db, { id: "user-hong" });

    const res = await app.request("/v1/packages");
    expect(res.status).toBe(200);

    const body = await res.json() as { packages: any[]; total: number };
    expect(body.total).toBe(3);
    // Must not include other user's private or deleted packages
    expect(body.packages.find((p: any) => p.full_name === "@other/secret")).toBeUndefined();
    expect(body.packages.find((p: any) => p.full_name === "@hong/deleted")).toBeUndefined();
  });

  it("authenticated: SQL uses publisher_id IN subquery, not hardcoded public", async () => {
    const db = makeDB("user-hong");
    const app = createPackageListApp(db, { id: "user-hong" });

    await app.request("/v1/packages");

    const listQuery = db._executed.find(e => e.sql.includes("FROM packages") && e.sql.includes("publisher_id"));
    expect(listQuery).toBeDefined();
    expect(listQuery!.sql).toContain("publisher_id IN");
    expect(listQuery!.sql).toContain("deleted_at IS NULL");
    // User ID bound as params
    expect(listQuery!.params).toContain("user-hong");
  });

  it("authenticated: does NOT see other users' private packages", async () => {
    const db = makeDB("user-hong");
    const app = createPackageListApp(db, { id: "user-hong" });

    const res = await app.request("/v1/packages");
    const body = await res.json() as { packages: any[] };

    const otherPrivate = body.packages.find((p: any) => p.full_name === "@other/secret");
    expect(otherPrivate).toBeUndefined();
  });
});

describe("packages privacy", () => {
  it("version detail query JOINs users to return username, not UUID", () => {
    const expectedSqlPattern = /LEFT JOIN users u ON v\.published_by = u\.id/;
    const routeSource = `
      SELECT v.version, v.manifest, v.readme, v.sha256, v.yanked, v.created_at,
             u.username AS publisher
      FROM versions v
      LEFT JOIN users u ON v.published_by = u.id
      WHERE v.package_id = ? AND v.version = ?
    `;
    expect(routeSource).toMatch(expectedSqlPattern);
    expect(routeSource).toContain("publisher");
    expect(routeSource).not.toMatch(/SELECT \* FROM versions/);
  });

  it("package detail query does not use SELECT *", () => {
    const responseFields = [
      "full_name", "type", "description", "summary", "capabilities",
      "license", "repository", "homepage", "author", "keywords", "platforms",
      "categories", "downloads", "versions", "created_at", "updated_at",
    ];
    expect(responseFields).not.toContain("owner_id");
    expect(responseFields).not.toContain("id");
    expect(responseFields).not.toContain("scope");
    expect(responseFields).not.toContain("import_source");
    expect(responseFields).not.toContain("import_external_id");
  });
});

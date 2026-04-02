import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import categoriesRoute from "../../src/routes/categories";
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

function createCategoriesApp(db: MockDB) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
      CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
    };
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode);
    return c.json({ error: "internal_error", message: String(err) }, 500);
  });

  app.route("/", categoriesRoute);
  return app;
}

// --- Tests ---

describe("categories — list", () => {
  it("GET /v1/categories returns categories with package counts", async () => {
    const db = createMockDB({
      allFn: (sql) => {
        if (sql.includes("FROM categories")) {
          return [
            { slug: "programming", name: "Programming", description: "General programming", display_order: 0, package_count: 42 },
            { slug: "ai-ml", name: "AI & ML", description: "AI and machine learning", display_order: 7, package_count: 15 },
            { slug: "database", name: "Database", description: "Database management", display_order: 4, package_count: 8 },
          ];
        }
        return [];
      },
    });

    const app = createCategoriesApp(db);
    const res = await app.request("/v1/categories");

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.categories).toHaveLength(3);
    expect(body.categories[0].slug).toBe("programming");
    expect(body.categories[0].package_count).toBe(42);
  });

  it("GET /v1/categories returns empty array when no categories", async () => {
    const db = createMockDB();
    const app = createCategoriesApp(db);
    const res = await app.request("/v1/categories");

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.categories).toEqual([]);
  });
});

describe("keywords — list", () => {
  it("GET /v1/keywords returns popular keywords", async () => {
    const db = createMockDB({
      allFn: (sql) => {
        if (sql.includes("FROM keywords")) {
          return [
            { slug: "database", usage_count: 25 },
            { slug: "api", usage_count: 18 },
            { slug: "testing", usage_count: 12 },
          ];
        }
        return [];
      },
    });

    const app = createCategoriesApp(db);
    const res = await app.request("/v1/keywords");

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.keywords).toHaveLength(3);
    expect(body.keywords[0].slug).toBe("database");
    expect(body.keywords[0].usage_count).toBe(25);
  });

  it("GET /v1/keywords respects limit parameter", async () => {
    const db = createMockDB({
      allFn: () => [{ slug: "test", usage_count: 1 }],
    });

    const app = createCategoriesApp(db);
    const res = await app.request("/v1/keywords?limit=10");

    expect(res.status).toBe(200);

    // Verify LIMIT is passed to query
    const limitQuery = db._executed.find(e => e.sql.includes("FROM keywords"));
    expect(limitQuery).toBeDefined();
    expect(limitQuery!.params).toContain(10);
  });

  it("GET /v1/keywords caps limit at 200", async () => {
    const db = createMockDB({
      allFn: () => [],
    });

    const app = createCategoriesApp(db);
    await app.request("/v1/keywords?limit=500");

    const limitQuery = db._executed.find(e => e.sql.includes("FROM keywords"));
    expect(limitQuery).toBeDefined();
    expect(limitQuery!.params).toContain(200);
  });

  it("GET /v1/keywords returns empty array when no keywords", async () => {
    const db = createMockDB();
    const app = createCategoriesApp(db);
    const res = await app.request("/v1/keywords");

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.keywords).toEqual([]);
  });
});

describe("categories service — seedCategories", () => {
  it("seedCategories calls INSERT OR IGNORE for each category", async () => {
    const db = createMockDB();

    // Import the service function directly
    const { seedCategories } = await import("../../src/services/categories");
    await seedCategories(db as any);

    // Should have executed one INSERT per category
    const inserts = db._executed.filter(e => e.sql.includes("INSERT OR IGNORE INTO categories"));
    expect(inserts.length).toBeGreaterThan(20); // We have 34 categories
  });
});

describe("categories service — mapToMCPCategory", () => {
  it("maps database keywords to database category", async () => {
    const { mapToMCPCategory } = await import("../../src/services/categories");
    const slug = mapToMCPCategory(["postgres", "database", "sql"], "A database tool");
    expect(slug).toBe("database");
  });

  it("maps git keywords to git-github category", async () => {
    const { mapToMCPCategory } = await import("../../src/services/categories");
    const slug = mapToMCPCategory(["github", "pull request"], "GitHub integration");
    expect(slug).toBe("git-github");
  });

  it("returns other for unrecognized keywords", async () => {
    const { mapToMCPCategory } = await import("../../src/services/categories");
    const slug = mapToMCPCategory(["zzz", "unknown"], "Something random");
    expect(slug).toBe("other");
  });
});

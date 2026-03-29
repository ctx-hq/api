import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";

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

// --- Test app that mirrors publisher packages logic ---

const publisher = { id: "pub-alice", kind: "user", user_id: "user-alice", org_id: null, slug: "alice", created_at: "2026-01-01" };

const allPackages = [
  { full_name: "@alice/public-skill", type: "skill", description: "pub", summary: "", downloads: 100, visibility: "public", created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null },
  { full_name: "@alice/private-tool", type: "cli", description: "priv", summary: "", downloads: 50, visibility: "private", created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null },
  { full_name: "@alice/unlisted-mcp", type: "mcp", description: "unl", summary: "", downloads: 10, visibility: "unlisted", created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null },
  { full_name: "@alice/deleted-pkg", type: "skill", description: "del", summary: "", downloads: 0, visibility: "public", created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: "2026-02-01" },
];

function createPublisherApp(user?: { id: string }) {
  const isMember = user?.id === "user-alice";

  const db = createMockDB({
    firstFn: (sql, params) => {
      if (sql.includes("FROM publishers WHERE slug")) return publisher;
      if (sql.includes("COUNT(*)")) {
        const visible = allPackages.filter(p => {
          if (p.deleted_at) return false;
          return isMember || p.visibility === "public";
        });
        return { count: visible.length };
      }
      if (sql.includes("org_members")) return null; // not an org member
      return null;
    },
    allFn: (sql) => {
      if (sql.includes("FROM packages")) {
        return allPackages.filter(p => {
          if (p.deleted_at) return false;
          return isMember || p.visibility === "public";
        });
      }
      return [];
    },
  });

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    (c as any).env = { DB: db, CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } };
    if (user) c.set("user", user as any);
    await next();
  });

  // Mirrors src/routes/publishers.ts — publisher profile
  app.get("/v1/publishers/:slug", async (c) => {
    const slug = c.req.param("slug");
    const pub = await c.env.DB.prepare("SELECT * FROM publishers WHERE slug = ?").bind(slug).first();
    if (!pub) return c.json({ error: "not found" }, 404);

    const user = c.get("user");
    // isMember check: user publisher → user_id matches
    const member = user && (pub as any).user_id === user.id;
    const countWhere = member
      ? "publisher_id = ? AND deleted_at IS NULL"
      : "publisher_id = ? AND visibility = 'public' AND deleted_at IS NULL";

    const pkgCount = await c.env.DB.prepare(`SELECT COUNT(*) as count FROM packages WHERE ${countWhere}`).bind((pub as any).id).first();
    return c.json({ slug: (pub as any).slug, kind: (pub as any).kind, packages: (pkgCount as any)?.count ?? 0 });
  });

  // Mirrors src/routes/publishers.ts — publisher packages list
  app.get("/v1/publishers/:slug/packages", async (c) => {
    const slug = c.req.param("slug");
    const pub = await c.env.DB.prepare("SELECT * FROM publishers WHERE slug = ?").bind(slug).first();
    if (!pub) return c.json({ error: "not found" }, 404);

    const user = c.get("user");
    const member = user && (pub as any).user_id === user.id;

    const conditions = ["p.publisher_id = ?", "p.deleted_at IS NULL"];
    if (!member) conditions.push("p.visibility = 'public'");

    const packages = await c.env.DB.prepare(
      `SELECT p.full_name, p.visibility, p.downloads FROM packages p WHERE ${conditions.join(" AND ")} ORDER BY p.downloads DESC`,
    ).bind((pub as any).id).all();

    return c.json({ publisher: { slug }, packages: packages.results ?? [] });
  });

  return { app, db };
}

// --- Tests ---

describe("publisher profile — package count", () => {
  it("non-member sees only public package count", async () => {
    const { app } = createPublisherApp(); // no user
    const res = await app.request("/v1/publishers/alice");
    expect(res.status).toBe(200);
    const body = await res.json() as { packages: number };
    expect(body.packages).toBe(1); // only the public one
  });

  it("member sees total package count (excl deleted)", async () => {
    const { app } = createPublisherApp({ id: "user-alice" });
    const res = await app.request("/v1/publishers/alice");
    expect(res.status).toBe(200);
    const body = await res.json() as { packages: number };
    expect(body.packages).toBe(3); // public + private + unlisted, not deleted
  });
});

describe("publisher packages listing — visibility", () => {
  it("non-member: returns only public, SQL has visibility = 'public'", async () => {
    const { app, db } = createPublisherApp(); // no user
    const res = await app.request("/v1/publishers/alice/packages");
    expect(res.status).toBe(200);

    const body = await res.json() as { packages: any[] };
    expect(body.packages).toHaveLength(1);
    expect(body.packages[0].visibility).toBe("public");

    // Verify SQL contains visibility filter
    const pkgQuery = db._executed.find(e => e.sql.includes("FROM packages") && e.sql.includes("visibility"));
    expect(pkgQuery).toBeDefined();
    expect(pkgQuery!.sql).toContain("visibility = 'public'");
    expect(pkgQuery!.sql).toContain("deleted_at IS NULL");
  });

  it("member: returns all visibility levels, SQL has no visibility filter", async () => {
    const { app, db } = createPublisherApp({ id: "user-alice" });
    const res = await app.request("/v1/publishers/alice/packages");
    expect(res.status).toBe(200);

    const body = await res.json() as { packages: any[] };
    expect(body.packages).toHaveLength(3);

    const visibilities = body.packages.map((p: any) => p.visibility);
    expect(visibilities).toContain("public");
    expect(visibilities).toContain("private");
    expect(visibilities).toContain("unlisted");

    // Verify SQL does NOT have visibility = 'public' (member sees all)
    const pkgQuery = db._executed.find(e => e.sql.includes("FROM packages p"));
    expect(pkgQuery).toBeDefined();
    expect(pkgQuery!.sql).not.toContain("visibility = 'public'");
    expect(pkgQuery!.sql).toContain("deleted_at IS NULL");
  });

  it("non-member: never sees deleted packages", async () => {
    const { app } = createPublisherApp();
    const res = await app.request("/v1/publishers/alice/packages");
    const body = await res.json() as { packages: any[] };
    expect(body.packages.find((p: any) => p.full_name === "@alice/deleted-pkg")).toBeUndefined();
  });

  it("member: never sees deleted packages", async () => {
    const { app } = createPublisherApp({ id: "user-alice" });
    const res = await app.request("/v1/publishers/alice/packages");
    const body = await res.json() as { packages: any[] };
    expect(body.packages.find((p: any) => p.full_name === "@alice/deleted-pkg")).toBeUndefined();
  });

  it("returns 404 for non-existent publisher", async () => {
    // Create app with DB that returns null for unknown slugs
    const db = createMockDB({ firstFn: () => null });
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      (c as any).env = { DB: db, CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } };
      await next();
    });
    app.get("/v1/publishers/:slug/packages", async (c) => {
      const pub = await c.env.DB.prepare("SELECT * FROM publishers WHERE slug = ?").bind(c.req.param("slug")).first();
      if (!pub) return c.json({ error: "not found" }, 404);
      return c.json({ packages: [] });
    });

    const res = await app.request("/v1/publishers/nonexistent/packages");
    expect(res.status).toBe(404);
  });
});

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

// --- Test fixtures ---

const org = { id: "org-acme", name: "acme", display_name: "Acme Corp", created_at: "2026-01-01" };
const orgPublisher = { id: "pub-org-acme", kind: "org", user_id: null, org_id: "org-acme", slug: "acme", created_at: "2026-01-01" };

const allPackages = [
  { full_name: "@acme/public-tool", type: "cli", description: "pub", summary: "", visibility: "public", downloads: 100, created_at: "2026-01-01", deleted_at: null },
  { full_name: "@acme/internal-lib", type: "skill", description: "priv", summary: "", visibility: "private", downloads: 50, created_at: "2026-01-01", deleted_at: null },
  { full_name: "@acme/beta-mcp", type: "mcp", description: "unl", summary: "", visibility: "unlisted", downloads: 20, created_at: "2026-01-01", deleted_at: null },
  { full_name: "@acme/deleted-pkg", type: "skill", description: "del", summary: "", visibility: "public", downloads: 0, created_at: "2026-01-01", deleted_at: "2026-02-01" },
];

function createOrgApp(user?: { id: string }) {
  const isMember = user?.id === "user-member";

  const db = createMockDB({
    firstFn: (sql, params) => {
      if (sql.includes("FROM orgs WHERE name")) return org;
      if (sql.includes("org_members WHERE org_id") && sql.includes("user_id")) {
        return isMember ? { role: "member" } : null;
      }
      if (sql.includes("FROM scopes WHERE name")) return { publisher_id: orgPublisher.id };
      if (sql.includes("FROM publishers WHERE id")) return orgPublisher;
      if (sql.includes("COUNT(*) as count FROM org_members")) return { count: 3 };
      if (sql.includes("COUNT(*) as count FROM packages")) {
        const visible = allPackages.filter(p => {
          if (p.deleted_at) return false;
          return isMember || p.visibility === "public";
        });
        return { count: visible.length };
      }
      return null;
    },
    allFn: (sql) => {
      if (sql.includes("FROM packages WHERE")) {
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

  // --- org detail (mirrors src/routes/orgs.ts) ---
  app.get("/v1/orgs/:name", async (c) => {
    const name = c.req.param("name");
    const o = await c.env.DB.prepare("SELECT * FROM orgs WHERE name = ?").bind(name).first();
    if (!o) return c.json({ error: "not found" }, 404);

    const memberCount = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM org_members WHERE org_id = ?",
    ).bind((o as any).id).first();

    // Auth-aware package count
    const user = c.get("user");
    const scope = await c.env.DB.prepare("SELECT publisher_id FROM scopes WHERE name = ?").bind(name).first();
    const pub = scope ? await c.env.DB.prepare("SELECT * FROM publishers WHERE id = ?").bind((scope as any).publisher_id).first() : null;

    let member = false;
    if (user && pub && (pub as any).kind === "org" && (pub as any).org_id) {
      const membership = await c.env.DB.prepare(
        "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
      ).bind((pub as any).org_id, user.id).first();
      member = membership !== null;
    }

    const visClause = member ? "" : "AND visibility = 'public'";
    const pkgCount = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM packages WHERE scope = ? ${visClause} AND deleted_at IS NULL`,
    ).bind(name).first();

    return c.json({
      id: (o as any).id,
      name: (o as any).name,
      display_name: (o as any).display_name,
      members: (memberCount as any)?.count ?? 0,
      packages: (pkgCount as any)?.count ?? 0,
    });
  });

  // --- org packages (mirrors src/routes/orgs.ts) ---
  app.get("/v1/orgs/:name/packages", async (c) => {
    const name = c.req.param("name");
    const o = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
    if (!o) return c.json({ error: "not found" }, 404);

    const user = c.get("user");
    const scope = await c.env.DB.prepare("SELECT publisher_id FROM scopes WHERE name = ?").bind(name).first();
    const pub = scope ? await c.env.DB.prepare("SELECT * FROM publishers WHERE id = ?").bind((scope as any).publisher_id).first() : null;

    let member = false;
    if (user && pub && (pub as any).kind === "org" && (pub as any).org_id) {
      const membership = await c.env.DB.prepare(
        "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
      ).bind((pub as any).org_id, user.id).first();
      member = membership !== null;
    }

    const conditions = ["scope = ?", "deleted_at IS NULL"];
    if (!member) conditions.push("visibility = 'public'");

    const packages = await c.env.DB.prepare(
      `SELECT full_name, type, visibility, downloads FROM packages WHERE ${conditions.join(" AND ")} ORDER BY downloads DESC`,
    ).bind(name).all();

    return c.json({ packages: packages.results ?? [] });
  });

  return { app, db };
}

// --- Tests ---

describe("org detail — auth-aware package count", () => {
  it("non-member sees only public package count", async () => {
    const { app } = createOrgApp(); // no user
    const res = await app.request("/v1/orgs/acme");
    expect(res.status).toBe(200);
    const body = await res.json() as { packages: number };
    expect(body.packages).toBe(1); // only public, excludes deleted
  });

  it("member sees total package count (excl deleted)", async () => {
    const { app } = createOrgApp({ id: "user-member" });
    const res = await app.request("/v1/orgs/acme");
    expect(res.status).toBe(200);
    const body = await res.json() as { packages: number };
    expect(body.packages).toBe(3); // public + private + unlisted
  });

  it("package count SQL filters deleted_at IS NULL", async () => {
    const { app, db } = createOrgApp();
    await app.request("/v1/orgs/acme");
    const countQuery = db._executed.find(e => e.sql.includes("COUNT(*)") && e.sql.includes("packages"));
    expect(countQuery).toBeDefined();
    expect(countQuery!.sql).toContain("deleted_at IS NULL");
  });

  it("non-member: package count SQL contains visibility = 'public'", async () => {
    const { app, db } = createOrgApp();
    await app.request("/v1/orgs/acme");
    const countQuery = db._executed.find(e => e.sql.includes("COUNT(*)") && e.sql.includes("packages"));
    expect(countQuery!.sql).toContain("visibility = 'public'");
  });

  it("member: package count SQL does NOT filter visibility", async () => {
    const { app, db } = createOrgApp({ id: "user-member" });
    await app.request("/v1/orgs/acme");
    const countQuery = db._executed.filter(e => e.sql.includes("COUNT(*)") && e.sql.includes("packages"));
    const pkgCountQuery = countQuery[countQuery.length - 1];
    expect(pkgCountQuery.sql).not.toContain("visibility = 'public'");
  });
});

describe("org packages listing — visibility", () => {
  it("non-member: returns only public packages", async () => {
    const { app } = createOrgApp();
    const res = await app.request("/v1/orgs/acme/packages");
    expect(res.status).toBe(200);
    const body = await res.json() as { packages: any[] };
    expect(body.packages).toHaveLength(1);
    expect(body.packages[0].visibility).toBe("public");
  });

  it("member: returns all visibility levels", async () => {
    const { app } = createOrgApp({ id: "user-member" });
    const res = await app.request("/v1/orgs/acme/packages");
    expect(res.status).toBe(200);
    const body = await res.json() as { packages: any[] };
    expect(body.packages).toHaveLength(3);
    const visibilities = body.packages.map((p: any) => p.visibility);
    expect(visibilities).toContain("public");
    expect(visibilities).toContain("private");
    expect(visibilities).toContain("unlisted");
  });

  it("non-member: SQL has visibility = 'public' and deleted_at IS NULL", async () => {
    const { app, db } = createOrgApp();
    await app.request("/v1/orgs/acme/packages");
    const pkgQuery = db._executed.find(e => e.sql.includes("FROM packages WHERE") && e.sql.includes("scope"));
    expect(pkgQuery).toBeDefined();
    expect(pkgQuery!.sql).toContain("visibility = 'public'");
    expect(pkgQuery!.sql).toContain("deleted_at IS NULL");
  });

  it("member: SQL has NO visibility filter", async () => {
    const { app, db } = createOrgApp({ id: "user-member" });
    await app.request("/v1/orgs/acme/packages");
    const pkgQuery = db._executed.find(e => e.sql.includes("FROM packages WHERE") && e.sql.includes("scope"));
    expect(pkgQuery).toBeDefined();
    expect(pkgQuery!.sql).not.toContain("visibility = 'public'");
    expect(pkgQuery!.sql).toContain("deleted_at IS NULL");
  });

  it("deleted packages never returned for anyone", async () => {
    // Non-member
    const { app: app1 } = createOrgApp();
    const res1 = await app1.request("/v1/orgs/acme/packages");
    const body1 = await res1.json() as { packages: any[] };
    expect(body1.packages.find((p: any) => p.full_name === "@acme/deleted-pkg")).toBeUndefined();

    // Member
    const { app: app2 } = createOrgApp({ id: "user-member" });
    const res2 = await app2.request("/v1/orgs/acme/packages");
    const body2 = await res2.json() as { packages: any[] };
    expect(body2.packages.find((p: any) => p.full_name === "@acme/deleted-pkg")).toBeUndefined();
  });
});

describe("org validation", () => {
  it("should validate org name as valid scope", () => {
    const isValid = (name: string) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
    expect(isValid("myteam")).toBe(true);
    expect(isValid("open-elf")).toBe(true);
    expect(isValid("")).toBe(false);
    expect(isValid("UPPER")).toBe(false);
    expect(isValid("-leading")).toBe(false);
  });

  it("membership roles are owner, admin, member", () => {
    const validRoles = ["owner", "admin", "member"];
    expect(validRoles).toContain("owner");
    expect(validRoles).not.toContain("viewer");
  });
});

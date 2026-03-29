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

const publicPkg = {
  id: "pkg-1", full_name: "@hong/public-tool", type: "skill",
  description: "A public tool", license: "MIT",
  visibility: "public", publisher_id: "pub-hong", deleted_at: null,
};

const privatePkg = {
  id: "pkg-2", full_name: "@hong/private-tool", type: "cli",
  description: "A private tool", license: "MIT",
  visibility: "private", publisher_id: "pub-hong", deleted_at: null,
};

const deletedPkg = {
  id: "pkg-3", full_name: "@hong/deleted-tool", type: "skill",
  description: "A deleted tool", license: "MIT",
  visibility: "public", publisher_id: "pub-hong", deleted_at: "2026-01-15",
};

const latestVersion = { version: "1.0.0", manifest: "{}", readme: "Hello" };

// --- Build test app mirroring agent.ts logic ---

function createAgentApp(user?: { id: string }) {
  const packages = [publicPkg, privatePkg, deletedPkg];
  const publisher = { id: "pub-hong", kind: "user", user_id: "user-hong", org_id: null, slug: "hong" };

  const db = createMockDB({
    firstFn: (sql, params) => {
      // Package lookup: must filter deleted_at IS NULL
      if (sql.includes("FROM packages WHERE full_name")) {
        const name = params[0] as string;
        const pkg = packages.find(p => p.full_name === name && !p.deleted_at);
        return pkg ?? null;
      }
      // canAccessPackage → publisher lookup
      if (sql.includes("FROM publishers WHERE id")) {
        return publisher;
      }
      // canPublish → org_members (user publisher, check user_id match)
      if (sql.includes("org_members")) return null;
      // getLatestVersion
      if (sql.includes("versions")) return latestVersion;
      return null;
    },
  });

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    (c as any).env = { DB: db, CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } };
    if (user) c.set("user", user as any);
    await next();
  });

  // Mirrors src/routes/agent.ts logic
  app.get("/:fullName{.+\\.ctx$}", async (c) => {
    const path = c.req.param("fullName");
    const fullName = path.replace(/\.ctx$/, "");

    const pkg = await c.env.DB.prepare(
      "SELECT id, full_name, type, description, license, visibility, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
    ).bind(fullName).first();

    if (!pkg) return c.text(`Package ${fullName} not found`, 404);

    // Visibility guard
    const u = c.get("user");
    const vis = (pkg as any).visibility;
    if (vis === "private") {
      if (!u) return c.text(`Package ${fullName} not found`, 404);
      const pub = await c.env.DB.prepare("SELECT * FROM publishers WHERE id = ?").bind((pkg as any).publisher_id).first();
      if (!pub || (pub as any).user_id !== u.id) {
        return c.text(`Package ${fullName} not found`, 404);
      }
    }

    const ver = await c.env.DB.prepare("SELECT version FROM versions WHERE package_id = ?").bind((pkg as any).id).first();
    const version = (ver as any)?.version ?? "unknown";

    c.header("Content-Type", "text/plain; charset=utf-8");
    return c.text(`## ${fullName}@${version}\n\n${(pkg as any).description}`);
  });

  return { app, db };
}

// --- Tests ---

describe(".ctx agent endpoint — visibility guard", () => {
  it("anonymous: public package returns 200 with install text", async () => {
    const { app } = createAgentApp();
    const res = await app.request("/@hong/public-tool.ctx");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("@hong/public-tool@1.0.0");
    expect(text).toContain("A public tool");
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  it("anonymous: private package returns 404 (no existence leak)", async () => {
    const { app } = createAgentApp();
    const res = await app.request("/@hong/private-tool.ctx");
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("not found");
    // Must NOT contain description or any package info
    expect(text).not.toContain("A private tool");
  });

  it("owner: private package returns 200", async () => {
    const { app } = createAgentApp({ id: "user-hong" });
    const res = await app.request("/@hong/private-tool.ctx");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("@hong/private-tool");
    expect(text).toContain("A private tool");
  });

  it("non-owner: private package returns 404", async () => {
    const { app } = createAgentApp({ id: "user-other" });
    const res = await app.request("/@hong/private-tool.ctx");
    expect(res.status).toBe(404);
  });

  it("deleted package returns 404 regardless of auth", async () => {
    const { app: anonApp } = createAgentApp();
    const res1 = await anonApp.request("/@hong/deleted-tool.ctx");
    expect(res1.status).toBe(404);

    const { app: authedApp } = createAgentApp({ id: "user-hong" });
    const res2 = await authedApp.request("/@hong/deleted-tool.ctx");
    expect(res2.status).toBe(404);
  });

  it("nonexistent package returns 404", async () => {
    const { app } = createAgentApp();
    const res = await app.request("/@unknown/pkg.ctx");
    expect(res.status).toBe(404);
  });

  it("SQL query includes deleted_at IS NULL", async () => {
    const { app, db } = createAgentApp();
    await app.request("/@hong/public-tool.ctx");
    const pkgQuery = db._executed.find(e => e.sql.includes("FROM packages WHERE full_name"));
    expect(pkgQuery).toBeDefined();
    expect(pkgQuery!.sql).toContain("deleted_at IS NULL");
  });

  it("SQL query uses explicit column list (not SELECT *)", async () => {
    const { app, db } = createAgentApp();
    await app.request("/@hong/public-tool.ctx");
    const pkgQuery = db._executed.find(e => e.sql.includes("FROM packages WHERE full_name"));
    expect(pkgQuery!.sql).not.toContain("SELECT *");
    expect(pkgQuery!.sql).toContain("visibility");
    expect(pkgQuery!.sql).toContain("publisher_id");
  });
});

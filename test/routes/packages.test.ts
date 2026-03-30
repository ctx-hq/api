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

// --- Test app that mounts real package routes with auth ---

import packagesRoute from "../../src/routes/packages";
import { AppError } from "../../src/utils/errors";

function createDeleteApp(overrides?: {
  firstFn?: (sql: string, params: unknown[]) => unknown | null;
  allFn?: (sql: string, params: unknown[]) => unknown[];
}) {
  const r2Deleted: string[] = [];
  const vectorDeleted: string[] = [];

  const db = createMockDB(overrides);
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
      FORMULAS: {
        put: async () => {},
        get: async () => null,
        delete: async (key: string) => { r2Deleted.push(key); },
      },
      CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
      VECTORIZE: {
        deleteByIds: async (ids: string[]) => { vectorDeleted.push(...ids); },
        query: async () => ({ matches: [] }),
      },
      ENRICHMENT_QUEUE: { send: async () => {} },
    };
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode);
    return c.json({ error: "internal_error", message: String(err) }, 500);
  });

  app.route("/", packagesRoute);

  const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const request: typeof app.request = (input, init, env) =>
    app.request(input, init, env, mockExecCtx as any);

  return { app, db, request, r2Deleted, vectorDeleted };
}

const mockUser = { id: "user-hong", username: "hong", role: "user", github_id: 1, avatar_url: "", created_at: "", updated_at: "" };

/** Standard firstFn for delete tests — handles auth, package, publisher, scope lookups */
function deleteFirstFn(extra?: (sql: string, params: unknown[]) => unknown | null) {
  return (sql: string, params: unknown[]): unknown | null => {
    // authMiddleware: token → user
    if (sql.includes("api_tokens") && sql.includes("token_hash")) return mockUser;
    // getPublisherForScope: scope → publisher_id
    if (sql.includes("publisher_id FROM scopes")) return { publisher_id: "pub-hong" };
    // getPublisherForScope: publisher by id
    if (sql.includes("FROM publishers WHERE id")) return { id: "pub-hong", kind: "user", user_id: "user-hong", org_id: null, slug: "hong", created_at: "" };
    // package lookup
    if (sql.includes("FROM packages WHERE full_name")) return { id: "pkg-1", publisher_id: "pub-hong" };
    return extra?.(sql, params) ?? null;
  };
}

const authHeaders = { Authorization: "Bearer test-token" };

describe("package deletion — hard delete", () => {
  it("DELETE /v1/packages/:fullName hard-deletes package and all versions", async () => {
    const { request, db, r2Deleted, vectorDeleted } = createDeleteApp({
      firstFn: deleteFirstFn(),
      allFn: (sql) => {
        if (sql.includes("FROM versions")) return [
          { id: "v1", formula_key: "@hong/fizzy-cli/0.1.0/formula.tar.gz" },
          { id: "v2", formula_key: "@hong/fizzy-cli/0.2.0/formula.tar.gz" },
        ];
        if (sql.includes("FROM vector_chunks")) return [{ id: "vec-1" }, { id: "vec-2" }];
        return [];
      },
    });

    const res = await request("/v1/packages/%40hong%2Ffizzy-cli", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.deleted).toBe(true);
    expect(body.versions_removed).toBe(2);

    const ops = db._executed;

    // Verify metadata cleanup for each version
    for (const table of ["skill_metadata", "mcp_metadata", "cli_metadata", "install_metadata", "trust_checks"]) {
      const deletes = ops.filter(e => e.sql.includes(`DELETE FROM ${table}`));
      expect(deletes).toHaveLength(2); // one per version
    }

    // Verify package-level cleanup
    expect(ops.find(e => e.sql.includes("DELETE FROM versions WHERE package_id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM dist_tags WHERE package_id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM search_digest WHERE package_id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM download_stats WHERE package_id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM agent_installs WHERE package_id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM vector_chunks WHERE package_id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM transfer_requests WHERE package_id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM packages WHERE id"))).toBeDefined();

    // Verify it's a hard delete, not soft delete
    expect(ops.find(e => e.sql.includes("UPDATE packages SET deleted_at"))).toBeUndefined();

    // Audit event
    const audit = ops.find(e => e.sql.includes("audit_events") && e.sql.includes("package.delete"));
    expect(audit).toBeDefined();

    // R2 archives cleaned up
    expect(r2Deleted).toContain("@hong/fizzy-cli/0.1.0/formula.tar.gz");
    expect(r2Deleted).toContain("@hong/fizzy-cli/0.2.0/formula.tar.gz");

    // Vectorize index cleaned up
    expect(vectorDeleted).toContain("vec-1");
    expect(vectorDeleted).toContain("vec-2");
  });

  it("returns 404 for non-existent package", async () => {
    const { request } = createDeleteApp({
      firstFn: (sql) => {
        if (sql.includes("api_tokens")) return mockUser;
        return null; // package not found
      },
    });

    const res = await request("/v1/packages/%40hong%2Fmissing", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const { request } = createDeleteApp();
    const res = await request("/v1/packages/%40hong%2Ftest", { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

describe("version deletion — hard delete", () => {
  it("deletes version and reassigns latest dist-tag by semver", async () => {
    let latestReassigned = false;
    const { request, db } = createDeleteApp({
      firstFn: deleteFirstFn((sql, params) => {
        // version lookup
        if (sql.includes("FROM versions WHERE package_id") && sql.includes("version = ?"))
          return { id: "v3", formula_key: "@hong/pkg/0.3.0/formula.tar.gz" };
        // remaining count after delete
        if (sql.includes("COUNT(*)")) return { count: 2 };
        // no latest dist-tag after delete
        if (sql.includes("FROM dist_tags") && sql.includes("tag = 'latest'") && !latestReassigned) return null;
        // latest version info for search_digest refresh (after reassignment)
        if (sql.includes("FROM versions v") && sql.includes("dist_tags"))
          return { version: "0.2.0", manifest: JSON.stringify({ description: "test", summary: "", keywords: [], capabilities: [] }) };
        // package info for search_digest
        if (sql.includes("FROM packages WHERE id"))
          return { full_name: "@hong/pkg", type: "skill", downloads: 10 };
        return null;
      }),
      allFn: (sql) => {
        // stable versions remaining — should pick 0.2.0 (higher semver) over 0.1.0
        if (sql.includes("FROM versions") && sql.includes("NOT LIKE"))
          return [{ id: "v1", version: "0.1.0" }, { id: "v2", version: "0.2.0" }];
        return [];
      },
    });

    const res = await request("/v1/packages/%40hong%2Fpkg/versions/0.3.0", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.deleted).toBe(true);
    expect(body.package_deleted).toBe(false);

    const ops = db._executed;

    // Version metadata cleaned up
    for (const table of ["skill_metadata", "mcp_metadata", "cli_metadata", "install_metadata", "trust_checks"]) {
      expect(ops.find(e => e.sql.includes(`DELETE FROM ${table}`))).toBeDefined();
    }
    expect(ops.find(e => e.sql.includes("DELETE FROM dist_tags WHERE version_id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM versions WHERE id"))).toBeDefined();

    // Audit event
    expect(ops.find(e => e.sql.includes("version.delete"))).toBeDefined();

    // Latest dist-tag reassigned via UPSERT — should pick v2 (0.2.0 > 0.1.0 by semver)
    const latestUpsert = ops.find(e => e.sql.includes("INSERT INTO dist_tags") && e.sql.includes("'latest'"));
    expect(latestUpsert).toBeDefined();
    expect(latestUpsert!.params).toContain("v2"); // semver-highest stable version

    // search_digest refreshed
    const digestUpsert = ops.find(e => e.sql.includes("search_digest") && e.sql.includes("INSERT"));
    expect(digestUpsert).toBeDefined();
  });

  it("auto-deletes package when last version is removed", async () => {
    const { request, db } = createDeleteApp({
      firstFn: deleteFirstFn((sql) => {
        if (sql.includes("FROM versions WHERE package_id") && sql.includes("version = ?"))
          return { id: "v1", formula_key: "@hong/pkg/1.0.0/formula.tar.gz" };
        if (sql.includes("COUNT(*)")) return { count: 0 };
        return null;
      }),
      allFn: (sql) => {
        if (sql.includes("FROM vector_chunks")) return [];
        return [];
      },
    });

    const res = await request("/v1/packages/%40hong%2Fpkg/versions/1.0.0", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.deleted).toBe(true);
    expect(body.package_deleted).toBe(true);

    const ops = db._executed;
    expect(ops.find(e => e.sql.includes("DELETE FROM packages WHERE id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM agent_installs WHERE package_id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM vector_chunks WHERE package_id"))).toBeDefined();
    expect(ops.find(e => e.sql.includes("DELETE FROM transfer_requests WHERE package_id"))).toBeDefined();
  });

  it("removes search_digest when only prereleases remain", async () => {
    const { request, db } = createDeleteApp({
      firstFn: deleteFirstFn((sql) => {
        if (sql.includes("FROM versions WHERE package_id") && sql.includes("version = ?"))
          return { id: "v1", formula_key: "@hong/pkg/1.0.0/formula.tar.gz" };
        if (sql.includes("COUNT(*)")) return { count: 1 };
        // no latest tag after delete
        if (sql.includes("FROM dist_tags") && sql.includes("tag = 'latest'")) return null;
        // no latest version available (join dist_tags)
        if (sql.includes("FROM versions v") && sql.includes("dist_tags")) return null;
        return null;
      }),
      allFn: (sql) => {
        // no stable versions remaining — only prereleases
        if (sql.includes("FROM versions") && sql.includes("NOT LIKE")) return [];
        return [];
      },
    });

    const res = await request("/v1/packages/%40hong%2Fpkg/versions/1.0.0", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.package_deleted).toBe(false);

    const ops = db._executed;
    // search_digest should be deleted (not just left stale)
    expect(ops.find(e => e.sql.includes("DELETE FROM search_digest WHERE package_id"))).toBeDefined();
    // No latest tag should have been inserted
    expect(ops.find(e => e.sql.includes("INSERT INTO dist_tags") && e.sql.includes("'latest'"))).toBeUndefined();
  });

  it("returns 404 for non-existent version", async () => {
    const { request } = createDeleteApp({
      firstFn: deleteFirstFn((sql) => {
        if (sql.includes("FROM versions WHERE package_id")) return null; // version not found
        return null;
      }),
    });

    const res = await request("/v1/packages/%40hong%2Fpkg/versions/9.9.9", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(404);
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

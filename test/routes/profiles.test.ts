import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import profilesRoute from "../../src/routes/profiles";
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

// --- Fixtures ---

const userAlice = { id: "user-alice", username: "alice", avatar_url: "https://example.com/alice.png", bio: "Alice bio", website: "https://alice.dev", created_at: "2026-01-01" };

const allPackages = [
  { full_name: "@alice/public-skill", type: "skill", description: "pub", summary: "", downloads: 100, visibility: "public", created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null },
  { full_name: "@alice/private-tool", type: "cli", description: "priv", summary: "", downloads: 50, visibility: "private", created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null },
  { full_name: "@alice/unlisted-mcp", type: "mcp", description: "unl", summary: "", downloads: 10, visibility: "unlisted", created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null },
  { full_name: "@alice/deleted-pkg", type: "skill", description: "del", summary: "", downloads: 0, visibility: "public", created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: "2026-02-01" },
];

const orgAcme = { id: "org-acme", name: "acme", created_at: "2026-01-01" };

const allOrgPackages = [
  { full_name: "@acme/public-lib", type: "skill", description: "lib", summary: "", downloads: 200, visibility: "public", created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null },
  { full_name: "@acme/internal-tool", type: "cli", description: "internal", summary: "", downloads: 30, visibility: "private", created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null },
];

// --- App factory ---

function createProfileApp(authedUser?: { id: string }) {
  const db = createMockDB({
    firstFn: (sql, params) => {
      // resolveOwnerBySlug — user lookup
      if (sql.includes("FROM users WHERE username = ?")) {
        return params[0] === "alice" ? { id: "user-alice" } : null;
      }
      // resolveOwnerBySlug — org lookup
      if (sql.includes("FROM orgs WHERE name = ?")) {
        return params[0] === "acme" ? { id: "org-acme" } : null;
      }
      // profile info — user detail row
      if (sql.includes("FROM users WHERE id = ?")) {
        return params[0] === "user-alice" ? userAlice : null;
      }
      // profile info — org detail row
      if (sql.includes("FROM orgs WHERE id = ?")) {
        return params[0] === "org-acme" ? orgAcme : null;
      }
      // org member check
      if (sql.includes("FROM org_members WHERE org_id = ? AND user_id = ?")) {
        const [orgId, userId] = params as string[];
        if (orgId === "org-acme" && userId === "user-bob-member") return { role: "member" };
        return null;
      }
      // COUNT(*) for packages
      if (sql.includes("COUNT(*)")) {
        const isMember = authedUser && (
          (params[1] === "user-alice" && authedUser.id === "user-alice") ||
          (params[1] === "org-acme" && authedUser.id === "user-bob-member")
        );
        const ownerType = params[0] as string;
        const ownerId = params[1] as string;
        const source = ownerType === "user" && ownerId === "user-alice" ? allPackages : allOrgPackages;
        const visible = source.filter(p => {
          if (p.deleted_at) return false;
          return isMember || p.visibility === "public";
        });
        return { count: visible.length };
      }
      // COALESCE(SUM(downloads)) for packages
      if (sql.includes("SUM(downloads)")) {
        const isMember = authedUser && (
          (params[1] === "user-alice" && authedUser.id === "user-alice") ||
          (params[1] === "org-acme" && authedUser.id === "user-bob-member")
        );
        const ownerType = params[0] as string;
        const ownerId = params[1] as string;
        const source = ownerType === "user" && ownerId === "user-alice" ? allPackages : allOrgPackages;
        const total = source
          .filter(p => !p.deleted_at && (isMember || p.visibility === "public"))
          .reduce((sum, p) => sum + p.downloads, 0);
        return { total };
      }
      return null;
    },
    allFn: (sql, params) => {
      if (sql.includes("FROM packages p")) {
        const isMember = authedUser && (
          (params[1] === "user-alice" && authedUser.id === "user-alice") ||
          (params[1] === "org-acme" && authedUser.id === "user-bob-member")
        );
        const ownerType = params[0] as string;
        const ownerId = params[1] as string;
        const source = ownerType === "user" && ownerId === "user-alice" ? allPackages : allOrgPackages;
        return source.filter(p => {
          if (p.deleted_at) return false;
          return isMember || p.visibility === "public";
        });
      }
      return [];
    },
  });

  const app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode);
    return c.json({ error: "internal_error" }, 500);
  });
  app.use("*", async (c, next) => {
    (c as any).env = { DB: db };
    if (authedUser) c.set("user", authedUser as any);
    await next();
  });
  app.route("/", profilesRoute);

  return { app, db };
}

// --- Tests ---

describe("GET /v1/profiles/:slug — profile lookup", () => {
  it("returns user profile for existing username", async () => {
    const { app } = createProfileApp();
    const res = await app.request("/v1/profiles/alice");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.slug).toBe("alice");
    expect(body.kind).toBe("user");
    expect(body.avatar_url).toBe(userAlice.avatar_url);
    expect(body.bio).toBe(userAlice.bio);
    expect(body.website).toBe(userAlice.website);
    expect(body.created_at).toBe(userAlice.created_at);
  });

  it("returns org profile for existing org name", async () => {
    const { app } = createProfileApp();
    const res = await app.request("/v1/profiles/acme");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.slug).toBe("acme");
    expect(body.kind).toBe("org");
    expect(body.created_at).toBe(orgAcme.created_at);
    // Org profiles don't include user-specific fields
    expect(body.bio).toBeUndefined();
    expect(body.avatar_url).toBeUndefined();
  });

  it("returns 404 for non-existent slug", async () => {
    const { app } = createProfileApp();
    const res = await app.request("/v1/profiles/nobody");
    expect(res.status).toBe(404);
  });

  it("non-member sees only public package count", async () => {
    const { app } = createProfileApp(); // no auth
    const res = await app.request("/v1/profiles/alice");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.packages).toBe(1); // only the public one
  });

  it("owner sees total package count (excl deleted)", async () => {
    const { app } = createProfileApp({ id: "user-alice" });
    const res = await app.request("/v1/profiles/alice");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.packages).toBe(3); // public + private + unlisted, not deleted
  });

  it("org member sees total package count for org profile", async () => {
    const { app } = createProfileApp({ id: "user-bob-member" });
    const res = await app.request("/v1/profiles/acme");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.packages).toBe(2); // public + private
  });

  it("non-member sees only public package count for org", async () => {
    const { app } = createProfileApp(); // no auth
    const res = await app.request("/v1/profiles/acme");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.packages).toBe(1); // only public
  });

  it("includes total_downloads in response", async () => {
    const { app } = createProfileApp();
    const res = await app.request("/v1/profiles/alice");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(typeof body.total_downloads).toBe("number");
    expect(body.total_downloads).toBe(100); // only public package's downloads
  });
});

describe("GET /v1/profiles/:slug/packages — package listing", () => {
  it("non-member: returns only public packages", async () => {
    const { app, db } = createProfileApp(); // no auth
    const res = await app.request("/v1/profiles/alice/packages");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.packages).toHaveLength(1);
    expect(body.packages[0].visibility).toBe("public");
    expect(body.packages[0].full_name).toBe("@alice/public-skill");
  });

  it("non-member: SQL includes visibility = 'public' filter", async () => {
    const { app, db } = createProfileApp();
    await app.request("/v1/profiles/alice/packages");
    const pkgQuery = db._executed.find(e => e.sql.includes("FROM packages p") && !e.sql.includes("COUNT(*)"));
    expect(pkgQuery).toBeDefined();
    expect(pkgQuery!.sql).toContain("visibility = 'public'");
    expect(pkgQuery!.sql).toContain("deleted_at IS NULL");
  });

  it("member: returns all visibility levels", async () => {
    const { app, db } = createProfileApp({ id: "user-alice" });
    const res = await app.request("/v1/profiles/alice/packages");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.packages).toHaveLength(3);
    const visibilities = body.packages.map((p: any) => p.visibility);
    expect(visibilities).toContain("public");
    expect(visibilities).toContain("private");
    expect(visibilities).toContain("unlisted");
  });

  it("member: SQL does NOT include visibility = 'public' filter", async () => {
    const { app, db } = createProfileApp({ id: "user-alice" });
    await app.request("/v1/profiles/alice/packages");
    const pkgQuery = db._executed.find(e => e.sql.includes("FROM packages p") && !e.sql.includes("COUNT(*)"));
    expect(pkgQuery).toBeDefined();
    expect(pkgQuery!.sql).not.toContain("visibility = 'public'");
    expect(pkgQuery!.sql).toContain("deleted_at IS NULL");
  });

  it("non-member: never sees deleted packages", async () => {
    const { app } = createProfileApp();
    const res = await app.request("/v1/profiles/alice/packages");
    const body = await res.json() as any;
    expect(body.packages.find((p: any) => p.full_name === "@alice/deleted-pkg")).toBeUndefined();
  });

  it("member: never sees deleted packages", async () => {
    const { app } = createProfileApp({ id: "user-alice" });
    const res = await app.request("/v1/profiles/alice/packages");
    const body = await res.json() as any;
    expect(body.packages.find((p: any) => p.full_name === "@alice/deleted-pkg")).toBeUndefined();
  });

  it("org member: sees all org packages including private", async () => {
    const { app } = createProfileApp({ id: "user-bob-member" });
    const res = await app.request("/v1/profiles/acme/packages");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.packages).toHaveLength(2);
  });

  it("non-member of org: sees only public org packages", async () => {
    const { app } = createProfileApp();
    const res = await app.request("/v1/profiles/acme/packages");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.packages).toHaveLength(1);
    expect(body.packages[0].visibility).toBe("public");
  });

  it("returns 404 for non-existent profile", async () => {
    const { app } = createProfileApp();
    const res = await app.request("/v1/profiles/nobody/packages");
    expect(res.status).toBe(404);
  });

  it("response includes owner slug and kind", async () => {
    const { app } = createProfileApp();
    const res = await app.request("/v1/profiles/alice/packages");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.owner).toEqual({ slug: "alice", kind: "user" });
  });

  it("response includes total count", async () => {
    const { app } = createProfileApp();
    const res = await app.request("/v1/profiles/alice/packages");
    const body = await res.json() as any;
    expect(typeof body.total).toBe("number");
    expect(body.total).toBe(1); // non-member sees 1 public
  });

  it("resolveOwnerBySlug tries users table first, then orgs", async () => {
    const { app, db } = createProfileApp();
    await app.request("/v1/profiles/alice/packages");
    const userLookup = db._executed.find(e => e.sql.includes("FROM users WHERE username = ?"));
    const orgLookup = db._executed.find(e => e.sql.includes("FROM orgs WHERE name = ?"));
    // For "alice" (a user), users table should be queried
    expect(userLookup).toBeDefined();
    // orgs table should NOT be queried since user was found first
    expect(orgLookup).toBeUndefined();
  });

  it("resolveOwnerBySlug falls through to orgs when user not found", async () => {
    const { app, db } = createProfileApp();
    await app.request("/v1/profiles/acme/packages");
    const userLookup = db._executed.find(e => e.sql.includes("FROM users WHERE username = ?") && e.params[0] === "acme");
    const orgLookup = db._executed.find(e => e.sql.includes("FROM orgs WHERE name = ?") && e.params[0] === "acme");
    expect(userLookup).toBeDefined();
    expect(orgLookup).toBeDefined();
  });
});

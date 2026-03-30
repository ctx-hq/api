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

// --- Package rename app factory ---

function createPackageRenameApp(opts?: {
  user?: { id: string; username: string };
  pkg?: { id: string; publisher_id: string; scope: string; name: string; full_name: string } | null;
  publisher?: { id: string; kind: string; user_id: string | null; org_id: string | null; slug: string } | null;
  orgStatus?: string;
  onCooldown?: boolean;
}) {
  const {
    user,
    pkg = { id: "pkg-1", publisher_id: "pub-alice", scope: "alice", name: "my-tool", full_name: "@alice/my-tool" },
    publisher = { id: "pub-alice", kind: "user", user_id: "user-1", org_id: null, slug: "alice" },
    orgStatus = "active",
    onCooldown = false,
  } = opts ?? {};

  const db = createMockDB({
    firstFn: (sql, params) => {
      // Package lookup by full_name (route handler + collision check in renamePackage)
      if (sql.includes("FROM packages WHERE full_name") && sql.includes("deleted_at IS NULL")) {
        // Only return the package if looking up the original name
        if (pkg && params[0] === pkg.full_name) return pkg;
        return null; // collision check for new name: no collision
      }
      // Package lookup by id (renamePackage service)
      if (sql.includes("packages WHERE id =")) {
        return pkg;
      }
      // Publisher lookup
      if (sql.includes("FROM publishers WHERE id")) {
        return publisher;
      }
      // Org status (canPublish)
      if (sql.includes("FROM orgs WHERE id")) {
        return { status: orgStatus };
      }
      // Org membership (canPublish + permission check)
      if (sql.includes("org_members WHERE org_id") && sql.includes("user_id")) {
        return { role: "owner" };
      }
      // Scope check (isNameAvailable)
      if (sql.includes("FROM scopes WHERE name")) {
        return null;
      }
      // Slug alias conflict check (renamePackage)
      if (sql.includes("FROM slug_aliases WHERE old_full_name")) {
        return null;
      }
      // Scope alias check (isNameAvailable)
      if (sql.includes("FROM scope_aliases WHERE old_scope")) {
        return null;
      }
      // Slug alias pattern check (isNameAvailable)
      if (sql.includes("FROM slug_aliases") && sql.includes("LIKE")) {
        return null;
      }
      return null;
    },
    allFn: () => [],
  });

  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if ("statusCode" in err && "toJSON" in err) {
      return c.json((err as any).toJSON(), (err as any).statusCode);
    }
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  app.use("*", async (c, next) => {
    (c as any).env = { DB: db, CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } };
    if (user) c.set("user", user as any);
    await next();
  });

  // --- Package rename (mirrors src/routes/packages.ts) ---
  app.patch("/v1/packages/:fullName/rename", async (c) => {
    const { badRequest, notFound, forbidden } = await import("../../src/utils/errors");
    const { canPublish } = await import("../../src/services/publisher");
    const { renamePackage } = await import("../../src/services/rename");
    const { isValidScope } = await import("../../src/utils/naming");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const fullName = c.req.param("fullName");

    let body: { new_name: string; confirm: string };
    try { body = await c.req.json(); } catch { throw badRequest("Invalid JSON body"); }

    if (!body.new_name) throw badRequest("new_name is required");
    if (!isValidScope(body.new_name)) throw badRequest("Invalid package name (lowercase, alphanumeric, hyphens)");
    if (body.confirm !== fullName) {
      throw badRequest(`Confirmation required: pass "confirm": "${fullName}" to proceed`);
    }

    const foundPkg = await c.env.DB.prepare(
      "SELECT id, publisher_id, scope, name, full_name FROM packages WHERE full_name = ? AND deleted_at IS NULL",
    ).bind(fullName).first<{ id: string; publisher_id: string; scope: string; name: string; full_name: string }>();

    if (!foundPkg) throw notFound(`Package ${fullName} not found`);

    const pub = await c.env.DB.prepare(
      "SELECT * FROM publishers WHERE id = ?",
    ).bind(foundPkg.publisher_id).first();

    if (!pub) throw notFound("Publisher not found");

    const hasPermission = await canPublish(c.env.DB as any, u.id, pub as any);
    if (!hasPermission) throw forbidden("You don't have permission to rename this package");

    if ((pub as any).kind === "org" && (pub as any).org_id) {
      const membership = await c.env.DB.prepare(
        "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
      ).bind((pub as any).org_id, u.id).first<{ role: string }>();

      if (!membership || !["owner", "admin"].includes(membership.role)) {
        throw forbidden("Only org owners and admins can rename packages");
      }
    }

    try {
      const result = await renamePackage(c.env.DB as any, foundPkg.id, body.new_name);

      await c.env.DB.prepare(
        "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'package.rename', ?, 'package', ?, ?)",
      ).bind("evt-test", u.id, foundPkg.id, "{}").run();

      return c.json({
        old_name: result.oldFullName,
        new_name: result.newFullName,
      });
    } catch (e: any) {
      throw badRequest(e.message);
    }
  });

  return { app, db };
}

// --- User rename app factory ---

function createUserRenameApp(opts?: {
  user?: { id: string; username: string };
  onCooldown?: boolean;
  nameAvailable?: boolean;
}) {
  const {
    user,
    onCooldown = false,
    nameAvailable = true,
  } = opts ?? {};

  const db = createMockDB({
    firstFn: (sql, params) => {
      // Cooldown check (renamed_at in the last 30 days)
      if (sql.includes("renamed_at") && sql.includes("FROM users")) {
        return onCooldown ? { renamed_at: "2026-03-28 00:00:00" } : null;
      }
      // Name availability: scope check
      if (sql.includes("FROM scopes WHERE name")) {
        return nameAvailable ? null : { name: params[0] };
      }
      // Name availability: scope_aliases check
      if (sql.includes("FROM scope_aliases WHERE old_scope")) {
        return null;
      }
      // Name availability: slug_aliases check
      if (sql.includes("FROM slug_aliases") && sql.includes("LIKE")) {
        return null;
      }
      // User lookup for renameUser service
      if (sql.includes("FROM users WHERE id")) {
        return user ? { id: user.id, username: user.username } : null;
      }
      return null;
    },
    allFn: (sql) => {
      // Personal packages for cascade
      if (sql.includes("FROM packages WHERE scope")) {
        return [];
      }
      return [];
    },
  });

  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if ("statusCode" in err && "toJSON" in err) {
      return c.json((err as any).toJSON(), (err as any).statusCode);
    }
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  app.use("*", async (c, next) => {
    (c as any).env = { DB: db, CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } };
    if (user) c.set("user", user as any);
    await next();
  });

  // --- User rename (mirrors src/routes/auth.ts) ---
  app.patch("/v1/me/rename", async (c) => {
    const { badRequest } = await import("../../src/utils/errors");
    const { renameUser, checkRenameCooldown, isNameAvailable } = await import("../../src/services/rename");
    const { generateId } = await import("../../src/utils/response");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");

    let body: { new_username: string; confirm: string };
    try { body = await c.req.json(); } catch { throw badRequest("Invalid JSON body"); }

    if (!body.new_username) throw badRequest("new_username is required");
    if (body.confirm !== u.username) {
      throw badRequest(`Confirmation required: pass "confirm": "${u.username}" to proceed`);
    }

    const cooldown = await checkRenameCooldown(c.env.DB as any, "users", u.id);
    if (cooldown) {
      throw badRequest("You renamed your account recently. Please wait 30 days between renames.");
    }

    const availability = await isNameAvailable(c.env.DB as any, body.new_username);
    if (!availability.available) {
      throw badRequest(availability.reason!);
    }

    try {
      const result = await renameUser(c.env.DB as any, u.id, body.new_username);

      await c.env.DB.prepare(
        "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'user.rename', ?, 'user', ?, ?)",
      ).bind(generateId(), u.id, u.id, "{}").run();

      return c.json({
        old_username: result.oldUsername,
        new_username: result.newUsername,
        packages_updated: result.packagesUpdated,
      });
    } catch (e: any) {
      throw badRequest(e.message);
    }
  });

  return { app, db };
}

// Helper: URL-encode scoped package names for path segments
function encodePkgPath(fullName: string): string {
  return `/v1/packages/${encodeURIComponent(fullName)}`;
}

// --- Package rename tests ---

describe("PATCH /v1/packages/:fullName/rename — rename package", () => {
  it("happy path: renames package, returns old/new names", async () => {
    const { app } = createPackageRenameApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request(`${encodePkgPath("@alice/my-tool")}/rename`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "new-tool", confirm: "@alice/my-tool" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.old_name).toBe("@alice/my-tool");
    expect(body.new_name).toBe("@alice/new-tool");
  });

  it("missing new_name returns 400", async () => {
    const { app } = createPackageRenameApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request(`${encodePkgPath("@alice/my-tool")}/rename`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "@alice/my-tool" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("new_name");
  });

  it("missing/wrong confirm returns 400", async () => {
    const { app } = createPackageRenameApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request(`${encodePkgPath("@alice/my-tool")}/rename`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "new-tool", confirm: "wrong" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("Confirmation required");
  });

  it("package not found returns 404", async () => {
    const { app } = createPackageRenameApp({
      user: { id: "user-1", username: "alice" },
      pkg: null,
    });

    const res = await app.request(`${encodePkgPath("@alice/nonexistent")}/rename`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "new-tool", confirm: "@alice/nonexistent" }),
    });

    expect(res.status).toBe(404);
  });

  it("not authorized returns 403", async () => {
    const { app } = createPackageRenameApp({
      user: { id: "user-999", username: "mallory" },
      publisher: { id: "pub-alice", kind: "user", user_id: "user-1", org_id: null, slug: "alice" },
    });

    const res = await app.request(`${encodePkgPath("@alice/my-tool")}/rename`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "new-tool", confirm: "@alice/my-tool" }),
    });

    expect(res.status).toBe(403);
  });
});

// --- User rename tests ---

describe("PATCH /v1/me/rename — rename user", () => {
  it("happy path: renames user", async () => {
    const { app } = createUserRenameApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request("/v1/me/rename", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_username: "alice-new", confirm: "alice" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.old_username).toBe("alice");
    expect(body.new_username).toBe("alice-new");
    expect(body.packages_updated).toBeDefined();
  });

  it("confirmation required", async () => {
    const { app } = createUserRenameApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request("/v1/me/rename", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_username: "alice-new", confirm: "wrong" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("Confirmation required");
  });

  it("cooldown active returns 400", async () => {
    const { app } = createUserRenameApp({
      user: { id: "user-1", username: "alice" },
      onCooldown: true,
    });

    const res = await app.request("/v1/me/rename", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_username: "alice-new", confirm: "alice" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("30 days");
  });
});

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

// --- Shared fixtures ---

const mockOrg = { id: "org-acme", name: "acme", status: "active", archived_at: null };
const mockOrgScope = { name: "acme", owner_type: "org", owner_id: "org-acme" };

// --- Leave app factory ---

function createLeaveApp(opts?: {
  user?: { id: string; username: string };
  isMember?: boolean;
  memberRole?: string;
  ownerCount?: number;
}) {
  const {
    user,
    isMember = true,
    memberRole = "member",
    ownerCount = 2,
  } = opts ?? {};

  const db = createMockDB({
    firstFn: (sql, params) => {
      // Org lookup
      if (sql.includes("FROM orgs WHERE name")) {
        return mockOrg;
      }
      // Membership check
      if (sql.includes("org_members WHERE org_id") && sql.includes("user_id")) {
        return isMember ? { role: memberRole } : null;
      }
      // Owner count (for last owner check)
      if (sql.includes("COUNT(*)") && sql.includes("org_members") && sql.includes("owner")) {
        return { count: ownerCount };
      }
      // Scope lookup (for getOwnerForScope)
      if (sql.includes("FROM scopes WHERE name")) {
        return mockOrgScope;
      }
      return null;
    },
    allFn: (sql) => {
      // Org owners (for notifyOwnerOwners)
      if (sql.includes("FROM org_members") && sql.includes("owner")) {
        return [{ user_id: "user-owner-1" }];
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

  // --- Leave org (mirrors src/routes/orgs.ts) ---
  app.post("/v1/orgs/:name/leave", async (c) => {
    const { badRequest, notFound } = await import("../../src/utils/errors");
    const { getOwnerForScope } = await import("../../src/services/ownership");
    const { notifyOwnerOwners } = await import("../../src/services/notification");
    const { cancelUserInvitations } = await import("../../src/services/invitation");
    const { cleanupUserAccessForOrg } = await import("../../src/services/package-access");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const name = c.req.param("name");

    const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
    if (!org) throw notFound(`Organization @${name} not found`);

    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(org.id, u.id).first<{ role: string }>();

    if (!membership) throw notFound("You are not a member of this organization");

    if (membership.role === "owner") {
      const ownerCountResult = await c.env.DB.prepare(
        "SELECT COUNT(*) as count FROM org_members WHERE org_id = ? AND role = 'owner'",
      ).bind(org.id).first<{ count: number }>();

      if ((ownerCountResult?.count ?? 0) <= 1) {
        throw badRequest("Cannot leave: you are the last owner. Transfer ownership first.");
      }
    }

    await Promise.all([
      cleanupUserAccessForOrg(c.env.DB as any, u.id, org.id as string),
      cancelUserInvitations(c.env.DB as any, org.id as string, u.id),
    ]);

    await c.env.DB.prepare(
      "DELETE FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(org.id, u.id).run();

    const owner = await getOwnerForScope(c.env.DB as any, name!);
    if (owner) {
      await notifyOwnerOwners(
        c.env.DB as any, owner.owner_type, owner.owner_id, "member_left",
        `${u.username} left @${name}`,
        `${u.username} has left the organization`,
        { org_name: name, username: u.username },
      );
    }

    return c.json({ left: name });
  });

  return { app, db };
}

// --- Archive/Unarchive app factory ---

function createArchiveApp(opts?: {
  user?: { id: string; username: string };
  orgStatus?: string;
  memberRole?: string | null;
}) {
  const {
    user,
    orgStatus = "active",
    memberRole = "owner",
  } = opts ?? {};

  const db = createMockDB({
    firstFn: (sql, params) => {
      if (sql.includes("FROM orgs WHERE name")) {
        return { ...mockOrg, status: orgStatus };
      }
      if (sql.includes("org_members WHERE org_id") && sql.includes("user_id")) {
        return memberRole ? { role: memberRole } : null;
      }
      return null;
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

  // --- Archive org ---
  app.post("/v1/orgs/:name/archive", async (c) => {
    const { badRequest, notFound, forbidden } = await import("../../src/utils/errors");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const name = c.req.param("name");

    const org = await c.env.DB.prepare("SELECT id, status FROM orgs WHERE name = ?").bind(name).first();
    if (!org) throw notFound(`Organization @${name} not found`);

    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(org.id, u.id).first();

    if (!membership || membership.role !== "owner") {
      throw forbidden("Only owners can archive the organization");
    }

    if (org.status === "archived") {
      throw badRequest("Organization is already archived");
    }

    await c.env.DB.prepare(
      "UPDATE orgs SET status = 'archived', archived_at = datetime('now') WHERE id = ?",
    ).bind(org.id).run();

    return c.json({ archived: name });
  });

  // --- Unarchive org ---
  app.post("/v1/orgs/:name/unarchive", async (c) => {
    const { badRequest, notFound, forbidden } = await import("../../src/utils/errors");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const name = c.req.param("name");

    const org = await c.env.DB.prepare("SELECT id, status FROM orgs WHERE name = ?").bind(name).first();
    if (!org) throw notFound(`Organization @${name} not found`);

    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(org.id, u.id).first();

    if (!membership || membership.role !== "owner") {
      throw forbidden("Only owners can unarchive the organization");
    }

    if (org.status !== "archived") {
      throw badRequest("Organization is not archived");
    }

    await c.env.DB.prepare(
      "UPDATE orgs SET status = 'active', archived_at = NULL WHERE id = ?",
    ).bind(org.id).run();

    return c.json({ unarchived: name });
  });

  return { app, db };
}

// --- Org rename app factory ---

function createOrgRenameApp(opts?: {
  user?: { id: string; username: string };
  memberRole?: string | null;
  onCooldown?: boolean;
  nameAvailable?: boolean;
}) {
  const {
    user,
    memberRole = "owner",
    onCooldown = false,
    nameAvailable = true,
  } = opts ?? {};

  const db = createMockDB({
    firstFn: (sql, params) => {
      // Org lookup
      if (sql.includes("FROM orgs WHERE name")) {
        return mockOrg;
      }
      // Org lookup by id (renameOrg service)
      if (sql.includes("FROM orgs WHERE id") && !sql.includes("renamed_at")) {
        return mockOrg;
      }
      // Membership check
      if (sql.includes("org_members WHERE org_id") && sql.includes("user_id")) {
        return memberRole ? { role: memberRole } : null;
      }
      // Cooldown check
      if (sql.includes("renamed_at") && sql.includes("FROM orgs")) {
        return onCooldown ? { renamed_at: "2026-03-28 00:00:00" } : null;
      }
      // Name availability: scope check
      if (sql.includes("FROM scopes WHERE name")) {
        return nameAvailable ? null : { name: params[0] };
      }
      // Name availability: scope_aliases
      if (sql.includes("FROM scope_aliases WHERE old_scope")) {
        return null;
      }
      // Name availability: slug_aliases pattern
      if (sql.includes("FROM slug_aliases") && sql.includes("LIKE")) {
        return null;
      }
      return null;
    },
    allFn: (sql) => {
      // Packages in this org (for renameOrg cascade)
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

  // --- Org rename (mirrors src/routes/orgs.ts) ---
  app.patch("/v1/orgs/:name/rename", async (c) => {
    const { badRequest, notFound, forbidden } = await import("../../src/utils/errors");
    const { renameOrg, checkRenameCooldown, isNameAvailable } = await import("../../src/services/rename");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const name = c.req.param("name");

    let body: { new_name: string; confirm: string };
    try { body = await c.req.json(); } catch { throw badRequest("Invalid JSON body"); }

    if (!body.new_name) throw badRequest("new_name is required");
    if (body.confirm !== name) {
      throw badRequest(`Confirmation required: pass "confirm": "${name}" to proceed`);
    }

    const org = await c.env.DB.prepare("SELECT id, name FROM orgs WHERE name = ?").bind(name).first();
    if (!org) throw notFound(`Organization @${name} not found`);

    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(org.id, u.id).first();

    if (!membership || membership.role !== "owner") {
      throw forbidden("Only owners can rename the organization");
    }

    const cooldown = await checkRenameCooldown(c.env.DB as any, "orgs", org.id as string);
    if (cooldown) {
      throw badRequest("Organization was renamed recently. Please wait 30 days between renames.");
    }

    const availability = await isNameAvailable(c.env.DB as any, body.new_name);
    if (!availability.available) {
      throw badRequest(availability.reason!);
    }

    const result = await renameOrg(c.env.DB as any, org.id as string, body.new_name);

    await c.env.DB.prepare(
      "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'org.rename', ?, 'org', ?, ?)",
    ).bind("evt-test", u.id, org.id, "{}").run();

    return c.json({
      old_name: result.oldName,
      new_name: result.newName,
      packages_updated: result.packagesUpdated,
    });
  });

  return { app, db };
}

// --- Dissolve app factory ---

function createDissolveApp(opts?: {
  user?: { id: string; username: string };
  memberRole?: string | null;
  packages?: Array<{ id: string; name: string; full_name: string; owner_type: string; owner_id: string }>;
}) {
  const {
    user,
    memberRole = "owner",
    packages = [],
  } = opts ?? {};

  const db = createMockDB({
    firstFn: (sql, params) => {
      if (sql.includes("FROM orgs WHERE name")) {
        return mockOrg;
      }
      if (sql.includes("org_members WHERE org_id") && sql.includes("user_id")) {
        return memberRole ? { role: memberRole } : null;
      }
      // For canPublish on target scope (dissolve with transfer_all)
      if (sql.includes("FROM orgs WHERE id")) {
        return { status: "active" };
      }
      // Name collision check
      if (sql.includes("FROM packages WHERE full_name") && sql.includes("deleted_at IS NULL")) {
        return null;
      }
      // Scope check (returns owner info for canPublish)
      if (sql.includes("FROM scopes WHERE name")) {
        return { name: "target", owner_type: "user", owner_id: user?.id ?? "user-1" };
      }
      return null;
    },
    allFn: (sql) => {
      if (sql.includes("FROM packages WHERE scope") && sql.includes("deleted_at IS NULL")) {
        return packages;
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

  // --- Dissolve org (mirrors src/routes/orgs.ts) ---
  app.post("/v1/orgs/:name/dissolve", async (c) => {
    const { badRequest, notFound, forbidden, conflict } = await import("../../src/utils/errors");
    const { canPublish, getOwnerForScope } = await import("../../src/services/ownership");
    const { cancelPackageTransfers } = await import("../../src/services/transfer");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const name = c.req.param("name");

    let body: { action: "transfer_all" | "delete_all"; transfer_to?: string; confirm: string };
    try { body = await c.req.json(); } catch { throw badRequest("Invalid JSON body"); }

    if (!["transfer_all", "delete_all"].includes(body.action)) {
      throw badRequest('action must be "transfer_all" or "delete_all"');
    }

    if (body.confirm !== name) {
      throw badRequest(`Confirmation required: pass "confirm": "${name}" to proceed`);
    }

    const org = await c.env.DB.prepare("SELECT id FROM orgs WHERE name = ?").bind(name).first();
    if (!org) throw notFound(`Organization @${name} not found`);

    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(org.id, u.id).first();

    if (!membership || membership.role !== "owner") {
      throw forbidden("Only owners can dissolve the organization");
    }

    const pkgsResult = await c.env.DB.prepare(
      "SELECT id, name, full_name, owner_type, owner_id FROM packages WHERE scope = ? AND deleted_at IS NULL",
    ).bind(name).all<{ id: string; name: string; full_name: string; owner_type: string; owner_id: string }>();

    const pkgs = pkgsResult.results ?? [];

    if (body.action === "delete_all") {
      for (const pkg of pkgs) {
        await cancelPackageTransfers(c.env.DB as any, pkg.id);

        await c.env.DB.batch([
          c.env.DB.prepare(
            "UPDATE packages SET deleted_at = datetime('now') WHERE id = ?",
          ).bind(pkg.id),
          c.env.DB.prepare(
            "DELETE FROM search_digest WHERE package_id = ?",
          ).bind(pkg.id),
          c.env.DB.prepare(
            "DELETE FROM package_access WHERE package_id = ?",
          ).bind(pkg.id),
        ]);
      }
    } else {
      if (!body.transfer_to) throw badRequest("transfer_to is required when action is transfer_all");

      const targetScope = body.transfer_to.startsWith("@") ? body.transfer_to.slice(1) : body.transfer_to;

      const toOwner = await getOwnerForScope(c.env.DB as any, targetScope);

      if (!toOwner) throw notFound(`Target scope @${targetScope} not found`);
      if (toOwner.owner_type === "org" && toOwner.owner_id === org.id) throw badRequest("Cannot transfer packages to the org being dissolved");

      const callerOwnsTarget = await canPublish(c.env.DB as any, u.id, targetScope);

      if (!callerOwnsTarget) {
        throw badRequest(
          "You are not an owner of the target scope. Transfer packages individually first, then delete the empty org.",
        );
      }

      for (const pkg of pkgs) {
        const newFullName = `@${targetScope}/${pkg.name}`;
        const collision = await c.env.DB.prepare(
          "SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
        ).bind(newFullName).first();
        if (collision) throw conflict(`Cannot transfer: package ${newFullName} already exists at target scope`);
      }

      for (const pkg of pkgs) {
        const newFullName = `@${targetScope}/${pkg.name}`;
        await cancelPackageTransfers(c.env.DB as any, pkg.id);

        await c.env.DB.batch([
          c.env.DB.prepare(
            "UPDATE packages SET scope = ?, full_name = ?, owner_type = ?, owner_id = ?, updated_at = datetime('now') WHERE id = ?",
          ).bind(targetScope, newFullName, toOwner.owner_type, toOwner.owner_id, pkg.id),
          c.env.DB.prepare(
            "INSERT OR REPLACE INTO slug_aliases (old_full_name, new_full_name) VALUES (?, ?)",
          ).bind(pkg.full_name, newFullName),
          c.env.DB.prepare(
            "UPDATE search_digest SET full_name = ?, owner_slug = ?, updated_at = datetime('now') WHERE package_id = ?",
          ).bind(newFullName, targetScope, pkg.id),
          c.env.DB.prepare(
            "DELETE FROM package_access WHERE package_id = ?",
          ).bind(pkg.id),
        ]);
      }
    }

    // Delete org artifacts
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM org_invitations WHERE org_id = ?").bind(org.id),
      c.env.DB.prepare("DELETE FROM org_members WHERE org_id = ?").bind(org.id),
      c.env.DB.prepare("DELETE FROM scopes WHERE name = ?").bind(name),
      c.env.DB.prepare("DELETE FROM orgs WHERE id = ?").bind(org.id),
    ]);

    await c.env.DB.prepare(
      "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'org.dissolve', ?, 'org', ?, ?)",
    ).bind("evt-test", u.id, org.id, "{}").run();

    return c.json({
      dissolved: name,
      action: body.action,
      packages_affected: pkgs.length,
    });
  });

  return { app, db };
}

// --- Tests ---

describe("POST /v1/orgs/:name/leave — member self-leave", () => {
  it("happy path: member leaves org", async () => {
    const { app } = createLeaveApp({
      user: { id: "user-1", username: "alice" },
      isMember: true,
      memberRole: "member",
    });

    const res = await app.request("/v1/orgs/acme/leave", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.left).toBe("acme");
  });

  it("not a member returns 404", async () => {
    const { app } = createLeaveApp({
      user: { id: "user-999", username: "mallory" },
      isMember: false,
    });

    const res = await app.request("/v1/orgs/acme/leave", { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.message).toContain("not a member");
  });

  it("last owner cannot leave returns 400", async () => {
    const { app } = createLeaveApp({
      user: { id: "user-1", username: "alice" },
      isMember: true,
      memberRole: "owner",
      ownerCount: 1,
    });

    const res = await app.request("/v1/orgs/acme/leave", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("last owner");
  });
});

describe("POST /v1/orgs/:name/archive — archive org", () => {
  it("happy path: archives org", async () => {
    const { app, db } = createArchiveApp({
      user: { id: "user-1", username: "alice" },
      orgStatus: "active",
      memberRole: "owner",
    });

    const res = await app.request("/v1/orgs/acme/archive", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.archived).toBe("acme");

    // Verify UPDATE was executed
    const updateQuery = db._executed.find(e => e.sql.includes("UPDATE orgs SET status = 'archived'"));
    expect(updateQuery).toBeDefined();
  });

  it("not owner returns 403", async () => {
    const { app } = createArchiveApp({
      user: { id: "user-1", username: "alice" },
      memberRole: "member",
    });

    const res = await app.request("/v1/orgs/acme/archive", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("already archived returns 400", async () => {
    const { app } = createArchiveApp({
      user: { id: "user-1", username: "alice" },
      orgStatus: "archived",
      memberRole: "owner",
    });

    const res = await app.request("/v1/orgs/acme/archive", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("already archived");
  });
});

describe("POST /v1/orgs/:name/unarchive — unarchive org", () => {
  it("happy path: unarchives org", async () => {
    const { app, db } = createArchiveApp({
      user: { id: "user-1", username: "alice" },
      orgStatus: "archived",
      memberRole: "owner",
    });

    const res = await app.request("/v1/orgs/acme/unarchive", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.unarchived).toBe("acme");

    const updateQuery = db._executed.find(e => e.sql.includes("UPDATE orgs SET status = 'active'"));
    expect(updateQuery).toBeDefined();
  });

  it("not archived returns 400", async () => {
    const { app } = createArchiveApp({
      user: { id: "user-1", username: "alice" },
      orgStatus: "active",
      memberRole: "owner",
    });

    const res = await app.request("/v1/orgs/acme/unarchive", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("not archived");
  });
});

describe("PATCH /v1/orgs/:name/rename — rename org", () => {
  it("happy path: renames org with cascade", async () => {
    const { app } = createOrgRenameApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request("/v1/orgs/acme/rename", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "acme-corp", confirm: "acme" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.old_name).toBe("acme");
    expect(body.new_name).toBe("acme-corp");
    expect(body.packages_updated).toBeDefined();
  });

  it("missing confirm returns 400", async () => {
    const { app } = createOrgRenameApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request("/v1/orgs/acme/rename", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "acme-corp", confirm: "wrong" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("Confirmation required");
  });

  it("cooldown active returns 400", async () => {
    const { app } = createOrgRenameApp({
      user: { id: "user-1", username: "alice" },
      onCooldown: true,
    });

    const res = await app.request("/v1/orgs/acme/rename", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "acme-corp", confirm: "acme" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("30 days");
  });
});

describe("POST /v1/orgs/:name/dissolve — dissolve org", () => {
  it("happy path with delete_all", async () => {
    const { app, db } = createDissolveApp({
      user: { id: "user-1", username: "alice" },
      packages: [
        { id: "pkg-1", name: "tool-a", full_name: "@acme/tool-a", owner_type: "org", owner_id: "org-acme" },
      ],
    });

    const res = await app.request("/v1/orgs/acme/dissolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_all", confirm: "acme" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.dissolved).toBe("acme");
    expect(body.action).toBe("delete_all");
    expect(body.packages_affected).toBe(1);

    // Verify org cleanup batch (invitations, members, scopes, org)
    const deleteOrg = db._executed.find(e => e.sql.includes("DELETE FROM orgs WHERE id"));
    expect(deleteOrg).toBeDefined();
    const deleteMembers = db._executed.find(e => e.sql.includes("DELETE FROM org_members WHERE org_id"));
    expect(deleteMembers).toBeDefined();
  });

  it("missing confirm returns 400", async () => {
    const { app } = createDissolveApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request("/v1/orgs/acme/dissolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_all", confirm: "wrong" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("Confirmation required");
  });

  it("not owner returns 403", async () => {
    const { app } = createDissolveApp({
      user: { id: "user-1", username: "alice" },
      memberRole: "member",
    });

    const res = await app.request("/v1/orgs/acme/dissolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_all", confirm: "acme" }),
    });

    expect(res.status).toBe(403);
  });
});

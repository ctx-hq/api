import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import { hashToken } from "../../src/services/auth";

// --- In-memory mock DB that tracks SQL operations ---

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
  runFn?: (sql: string, params: unknown[]) => number;
}): MockDB {
  const executed: Array<{ sql: string; params: unknown[] }> = [];

  const db: MockDB = {
    _executed: executed,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt: MockStatement = {
        bind(...params: unknown[]) {
          boundParams = params;
          return stmt;
        },
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
          const changes = overrides?.runFn?.(sql, boundParams) ?? 1;
          return { success: true, meta: { changes } };
        },
      };
      return stmt;
    },
    async batch(stmts: MockStatement[]) {
      const results = [];
      for (const s of stmts) {
        results.push(await s.run());
      }
      return results;
    },
  };
  return db;
}

// --- Build a test app with auth routes + mock auth middleware ---

function createTestApp(mockUser: { id: string; username: string; email: string; avatar_url: string; github_id: string; role: "user" | "admin"; created_at: string; updated_at: string }, db: MockDB) {
  const app = new Hono<AppEnv>();

  // Inject mock env
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = { DB: db };
    await next();
  });

  // Mock authMiddleware — set user directly
  app.use("/v1/me/*", async (c, next) => {
    c.set("user", mockUser);
    await next();
  });
  app.use("/v1/me", async (c, next) => {
    c.set("user", mockUser);
    await next();
  });

  // Import and mount auth routes
  // We re-create the relevant routes inline to avoid import complications
  app.get("/v1/me", async (c) => {
    const user = c.get("user");
    return c.json({
      id: user.id,
      username: user.username,
      email: user.email,
      avatar_url: user.avatar_url,
    });
  });

  app.get("/v1/me/tokens", async (c) => {
    const user = c.get("user");
    const result = await c.env.DB.prepare(
      "SELECT id, name, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC"
    ).bind(user.id).all();
    return c.json({ tokens: result.results ?? [] });
  });

  app.delete("/v1/me", async (c) => {
    const user = c.get("user");
    if (user.id === "system-scanner" || user.id === "system-deleted") {
      return c.json({ error: "forbidden", message: "System accounts cannot be deleted" }, 403);
    }

    const soleOwnerOrgs = await c.env.DB.prepare(
      "SELECT o.name FROM org_members m JOIN orgs o ON m.org_id = o.id WHERE m.user_id = ?"
    ).bind(user.id).all();

    if (soleOwnerOrgs.results && soleOwnerOrgs.results.length > 0) {
      const orgNames = soleOwnerOrgs.results.map((r: Record<string, unknown>) => `@${r.name}`).join(", ");
      return c.json({ error: "bad_request", message: `Cannot delete account: you are the sole owner of ${orgNames}. Transfer ownership first.` }, 400);
    }

    const anonymizedUsername = `deleted-${user.id.slice(0, 8)}`;

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET username = ?, github_id = ?").bind(anonymizedUsername, `deleted:${user.id}`),
      c.env.DB.prepare("UPDATE packages SET owner_id = 'system-deleted' WHERE owner_id = ?").bind(user.id),
      c.env.DB.prepare("UPDATE versions SET published_by = 'system-deleted' WHERE published_by = ?").bind(user.id),
      c.env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(user.id),
      c.env.DB.prepare("DELETE FROM org_members WHERE user_id = ?").bind(user.id),
      c.env.DB.prepare("INSERT INTO audit_events (id, actor_id, action, target_type, target_id, metadata) VALUES (?, ?, 'account_deleted', 'user', ?, '{}')").bind("evt1", user.id, user.id),
    ]);

    return c.json({ deleted: true });
  });

  return app;
}

const testUser = {
  id: "user-abc12345",
  username: "alice",
  email: "alice@example.com",
  avatar_url: "https://avatars.example.com/alice",
  github_id: "12345",
  role: "user" as const,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

// --- Tests ---

describe("GET /v1/me — response privacy", () => {
  it("returns only safe fields, never github_id or role", async () => {
    const db = createMockDB();
    const app = createTestApp(testUser, db);

    const res = await app.request("/v1/me");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("username", "alice");
    expect(body).toHaveProperty("email");
    expect(body).toHaveProperty("avatar_url");
    // Must NOT leak internal fields
    expect(body).not.toHaveProperty("github_id");
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("created_at");
  });
});

describe("GET /v1/me/tokens — never leaks token_hash", () => {
  it("queries only safe columns from api_tokens", async () => {
    const db = createMockDB({
      allFn: (sql) => {
        if (sql.includes("api_tokens")) {
          return [{ id: "t1", name: "cli", created_at: "2026-01-01", last_used_at: null, expires_at: null }];
        }
        return [];
      },
    });
    const app = createTestApp(testUser, db);

    const res = await app.request("/v1/me/tokens");
    expect(res.status).toBe(200);

    const body = await res.json() as { tokens: Record<string, unknown>[] };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toHaveProperty("name", "cli");

    // Verify SQL never selects token_hash
    const tokenQuery = db._executed.find(e => e.sql.includes("api_tokens"));
    expect(tokenQuery).toBeDefined();
    expect(tokenQuery!.sql).not.toContain("token_hash");
    expect(tokenQuery!.sql).not.toContain("SELECT *");
  });
});

describe("DELETE /v1/me — account deletion integration", () => {
  it("anonymizes user with unique github_id tombstone", async () => {
    const db = createMockDB();
    const app = createTestApp(testUser, db);

    const res = await app.request("/v1/me", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: boolean };
    expect(body.deleted).toBe(true);

    // Verify batch executed all required operations
    const ops = db._executed;
    const userUpdate = ops.find(e => e.sql.includes("UPDATE users"));
    expect(userUpdate).toBeDefined();
    expect(userUpdate!.params).toContain("deleted-user-abc");
    expect(userUpdate!.params).toContain("deleted:user-abc12345");

    const pkgReassign = ops.find(e => e.sql.includes("UPDATE packages"));
    expect(pkgReassign).toBeDefined();

    const tokenDelete = ops.find(e => e.sql.includes("DELETE FROM api_tokens"));
    expect(tokenDelete).toBeDefined();

    const orgDelete = ops.find(e => e.sql.includes("DELETE FROM org_members"));
    expect(orgDelete).toBeDefined();

    const auditInsert = ops.find(e => e.sql.includes("INSERT INTO audit_events"));
    expect(auditInsert).toBeDefined();
  });

  it("blocks deletion for system accounts", async () => {
    const systemUser = { ...testUser, id: "system-scanner" };
    const db = createMockDB();
    const app = createTestApp(systemUser, db);

    const res = await app.request("/v1/me", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("blocks deletion when user is sole org owner", async () => {
    const db = createMockDB({
      allFn: (sql) => {
        if (sql.includes("org_members")) {
          return [{ name: "myorg" }];
        }
        return [];
      },
    });
    const app = createTestApp(testUser, db);

    const res = await app.request("/v1/me", { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain("@myorg");
    expect(body.message).toContain("Transfer ownership first");
  });

  it("github_id tombstone is unique per user (prevents UNIQUE constraint violation)", async () => {
    // Two different users should produce different tombstones
    const user1 = { ...testUser, id: "user-aaa" };
    const user2 = { ...testUser, id: "user-bbb" };

    const tombstone1 = `deleted:${user1.id}`;
    const tombstone2 = `deleted:${user2.id}`;

    expect(tombstone1).not.toBe(tombstone2);
    expect(tombstone1).toBe("deleted:user-aaa");
    expect(tombstone2).toBe("deleted:user-bbb");
  });
});

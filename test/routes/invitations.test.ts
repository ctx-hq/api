import { describe, it, expect } from "vitest";
import {
  createInvitation,
  acceptInvitation,
  declineInvitation,
  cancelInvitation,
  listOrgInvitations,
  listUserInvitations,
  cancelUserInvitations,
  expirePendingInvitations,
} from "../../src/services/invitation";

// --- Mock DB ---

interface MockDB {
  prepare(sql: string): MockStatement;
  batch(stmts: MockStatement[]): Promise<unknown[]>;
  _executed: Array<{ sql: string; params: unknown[] }>;
  _data: Map<string, Record<string, unknown>>;
}

interface MockStatement {
  bind(...params: unknown[]): MockStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockDB(): MockDB {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const data = new Map<string, Record<string, unknown>>();

  const db: MockDB = {
    _executed: executed,
    _data: data,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt: MockStatement = {
        bind(...params: unknown[]) {
          boundParams = params;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          executed.push({ sql, params: boundParams });

          // Return invitation data for specific lookups
          if (sql.includes("FROM org_invitations WHERE id")) {
            const id = boundParams[0] as string;
            const inv = data.get(id);
            return (inv as T) ?? null;
          }

          // Return null for member checks
          if (sql.includes("FROM org_members WHERE")) {
            return null;
          }

          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          executed.push({ sql, params: boundParams });
          return { results: [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts: MockStatement[]) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  };
  return db;
}

describe("invitation service", () => {
  it("createInvitation generates correct ID prefix and sets pending status", async () => {
    const db = createMockDB();
    const result = await createInvitation(
      db as unknown as D1Database,
      "org-1",
      "user-inviter",
      "user-invitee",
      "member",
    );

    expect(result.id).toMatch(/^inv-/);
    expect(result.status).toBe("pending");
    expect(result.role).toBe("member");
    expect(result.org_id).toBe("org-1");
    expect(result.inviter_id).toBe("user-inviter");
    expect(result.invitee_id).toBe("user-invitee");
    expect(result.resolved_at).toBeNull();
  });

  it("createInvitation sets 7-day expiry", async () => {
    const db = createMockDB();
    const now = Date.now();
    const result = await createInvitation(
      db as unknown as D1Database,
      "org-1",
      "user-inviter",
      "user-invitee",
      "admin",
    );

    // expires_at is SQLite UTC format "YYYY-MM-DD HH:MM:SS" — parse as UTC
    const raw = result.expires_at;
    const expiresAt = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z").getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // Allow 10s tolerance for test execution
    expect(expiresAt).toBeGreaterThanOrEqual(now + sevenDaysMs - 10000);
    expect(expiresAt).toBeLessThanOrEqual(now + sevenDaysMs + 10000);
  });

  it("createInvitation SQL inserts with correct params", async () => {
    const db = createMockDB();
    await createInvitation(
      db as unknown as D1Database,
      "org-1",
      "user-inviter",
      "user-invitee",
      "member",
    );

    const insertQuery = db._executed.find((e) =>
      e.sql.includes("INSERT INTO org_invitations"),
    );
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.params[1]).toBe("org-1");
    expect(insertQuery!.params[2]).toBe("user-inviter");
    expect(insertQuery!.params[3]).toBe("user-invitee");
    expect(insertQuery!.params[4]).toBe("member");
  });

  it("acceptInvitation returns null for non-existent invitation", async () => {
    const db = createMockDB();
    const result = await acceptInvitation(
      db as unknown as D1Database,
      "inv-nonexistent",
      "user-1",
    );
    expect(result).toBeNull();
  });

  it("acceptInvitation returns null for non-pending invitation", async () => {
    const db = createMockDB();
    db._data.set("inv-1", {
      id: "inv-1",
      org_id: "org-1",
      inviter_id: "user-inviter",
      invitee_id: "user-1",
      role: "member",
      status: "declined",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date().toISOString(),
      resolved_at: null,
    });

    const result = await acceptInvitation(
      db as unknown as D1Database,
      "inv-1",
      "user-1",
    );
    expect(result).toBeNull();
  });

  it("acceptInvitation auto-expires past-due invitation", async () => {
    const db = createMockDB();
    db._data.set("inv-1", {
      id: "inv-1",
      org_id: "org-1",
      inviter_id: "user-inviter",
      invitee_id: "user-1",
      role: "member",
      status: "pending",
      expires_at: new Date(Date.now() - 86400000).toISOString(), // expired yesterday
      created_at: new Date().toISOString(),
      resolved_at: null,
    });

    const result = await acceptInvitation(
      db as unknown as D1Database,
      "inv-1",
      "user-1",
    );
    expect(result).toBeNull();

    // Should have updated status to expired
    const expireQuery = db._executed.find(
      (e) => e.sql.includes("SET status = 'expired'"),
    );
    expect(expireQuery).toBeDefined();
  });

  it("acceptInvitation inserts org_member on success", async () => {
    const db = createMockDB();
    db._data.set("inv-1", {
      id: "inv-1",
      org_id: "org-1",
      inviter_id: "user-inviter",
      invitee_id: "user-1",
      role: "member",
      status: "pending",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date().toISOString(),
      resolved_at: null,
    });

    const result = await acceptInvitation(
      db as unknown as D1Database,
      "inv-1",
      "user-1",
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("accepted");

    // Should have updated invitation status then inserted org_member
    const updateInv = db._executed.find((e) =>
      e.sql.includes("SET status = 'accepted'") && e.sql.includes("AND status = 'pending'"),
    );
    expect(updateInv).toBeDefined();

    const insertMember = db._executed.find((e) =>
      e.sql.includes("INSERT OR IGNORE INTO org_members"),
    );
    expect(insertMember).toBeDefined();
  });

  it("declineInvitation SQL updates status", async () => {
    const db = createMockDB();
    await declineInvitation(db as unknown as D1Database, "inv-1", "user-1");

    const updateQuery = db._executed.find(
      (e) => e.sql.includes("SET status = 'declined'"),
    );
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.params[0]).toBe("inv-1");
    expect(updateQuery!.params[1]).toBe("user-1");
  });

  it("cancelInvitation SQL updates status", async () => {
    const db = createMockDB();
    await cancelInvitation(db as unknown as D1Database, "inv-1", "org-1");

    const updateQuery = db._executed.find(
      (e) => e.sql.includes("SET status = 'cancelled'"),
    );
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.params[0]).toBe("inv-1");
    expect(updateQuery!.params[1]).toBe("org-1");
  });

  it("listOrgInvitations queries by org_id with user JOINs", async () => {
    const db = createMockDB();
    await listOrgInvitations(db as unknown as D1Database, "org-1");

    const query = db._executed.find(
      (e) =>
        e.sql.includes("FROM org_invitations") &&
        e.sql.includes("org_id") &&
        e.sql.includes("JOIN users"),
    );
    expect(query).toBeDefined();
    expect(query!.params[0]).toBe("org-1");
  });

  it("listOrgInvitations filters by status when provided", async () => {
    const db = createMockDB();
    await listOrgInvitations(db as unknown as D1Database, "org-1", "pending");

    const query = db._executed.find((e) => e.sql.includes("i.status = ?"));
    expect(query).toBeDefined();
    expect(query!.params[1]).toBe("pending");
  });

  it("listUserInvitations expires past-due first, then queries pending", async () => {
    const db = createMockDB();
    await listUserInvitations(db as unknown as D1Database, "user-1");

    // Should have expired past-due first
    const expireQuery = db._executed.find(
      (e) =>
        e.sql.includes("UPDATE org_invitations SET status = 'expired'") &&
        e.sql.includes("expires_at < datetime"),
    );
    expect(expireQuery).toBeDefined();

    // Then query pending for user with org/user JOINs
    const listQuery = db._executed.find(
      (e) =>
        e.sql.includes("invitee_id = ?") &&
        e.sql.includes("status = 'pending'") &&
        e.sql.includes("JOIN orgs"),
    );
    expect(listQuery).toBeDefined();
    expect(listQuery!.params[0]).toBe("user-1");
  });

  it("cancelUserInvitations cancels all pending for user in org", async () => {
    const db = createMockDB();
    await cancelUserInvitations(db as unknown as D1Database, "org-1", "user-1");

    const query = db._executed.find(
      (e) =>
        e.sql.includes("SET status = 'cancelled'") &&
        e.sql.includes("org_id = ?") &&
        e.sql.includes("invitee_id = ?"),
    );
    expect(query).toBeDefined();
    expect(query!.params[0]).toBe("org-1");
    expect(query!.params[1]).toBe("user-1");
  });

  it("expirePendingInvitations updates past-due invitations", async () => {
    const db = createMockDB();
    await expirePendingInvitations(db as unknown as D1Database);

    const query = db._executed.find(
      (e) =>
        e.sql.includes("SET status = 'expired'") &&
        e.sql.includes("status = 'pending'") &&
        e.sql.includes("expires_at < datetime"),
    );
    expect(query).toBeDefined();
  });
});

describe("invitation status transitions", () => {
  it("valid roles are owner, admin, member", () => {
    const validRoles = ["owner", "admin", "member"];
    expect(validRoles).toContain("owner");
    expect(validRoles).toContain("admin");
    expect(validRoles).toContain("member");
    expect(validRoles).not.toContain("viewer");
    expect(validRoles).not.toContain("billing_manager");
  });

  it("valid statuses are pending, accepted, declined, expired, cancelled", () => {
    const validStatuses = ["pending", "accepted", "declined", "expired", "cancelled"];
    expect(validStatuses).toHaveLength(5);
    expect(validStatuses).toContain("pending");
    expect(validStatuses).toContain("cancelled");
  });
});

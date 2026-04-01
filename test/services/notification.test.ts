import { describe, it, expect } from "vitest";
import {
  notify,
  notifyOwnerOwners,
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  dismiss,
  cleanupOldNotifications,
} from "../../src/services/notification";

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

function createMockDB(opts: {
  firstFn?: (sql: string, params: unknown[]) => unknown | null;
  allFn?: (sql: string, params: unknown[]) => unknown[];
  runChanges?: number;
} = {}): MockDB {
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
          if (opts.firstFn) {
            return opts.firstFn(sql, boundParams) as T | null;
          }
          if (sql.includes("FROM") && boundParams[0]) {
            const key = boundParams[0] as string;
            return (data.get(key) as T) ?? null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          executed.push({ sql, params: boundParams });
          if (opts.allFn) {
            return { results: opts.allFn(sql, boundParams) as T[] };
          }
          return { results: [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          return { success: true, meta: { changes: opts.runChanges ?? 1 } };
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

describe("notification service", () => {
  describe("notify", () => {
    it("should create a notification with notif- prefix", async () => {
      const db = createMockDB();
      const result = await notify(
        db as unknown as D1Database,
        "user-1",
        "org_invitation",
        "You were invited",
        "Join team-x",
      );

      expect(result.id).toMatch(/^notif-/);
      expect(result.user_id).toBe("user-1");
      expect(result.type).toBe("org_invitation");
      expect(result.title).toBe("You were invited");
      expect(result.body).toBe("Join team-x");
      expect(result.read).toBe(0);
      expect(result.dismissed).toBe(0);
    });

    it("should insert into notifications table", async () => {
      const db = createMockDB();
      await notify(
        db as unknown as D1Database,
        "user-1",
        "transfer_request",
        "Transfer pending",
        "Package @a/b",
        { package_id: "pkg-1" },
      );

      const insertStmt = db._executed.find((e) => e.sql.includes("INSERT INTO notifications"));
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.params[1]).toBe("user-1");
      expect(insertStmt!.params[2]).toBe("transfer_request");
      expect(insertStmt!.params[3]).toBe("Transfer pending");
      expect(insertStmt!.params[5]).toBe(JSON.stringify({ package_id: "pkg-1" }));
    });

    it("should default data to empty object", async () => {
      const db = createMockDB();
      const result = await notify(
        db as unknown as D1Database,
        "user-1",
        "system_notice",
        "Hello",
        "World",
      );

      expect(result.data).toBe("{}");
    });

    it("should set created_at to current ISO string", async () => {
      const db = createMockDB();
      const before = new Date().toISOString();
      const result = await notify(
        db as unknown as D1Database,
        "user-1",
        "system_notice",
        "Hello",
        "World",
      );
      const after = new Date().toISOString();

      expect(result.created_at >= before).toBe(true);
      expect(result.created_at <= after).toBe(true);
    });
  });

  describe("notifyOwnerOwners", () => {
    it("should notify user directly for user owner", async () => {
      const db = createMockDB();

      await notifyOwnerOwners(
        db as unknown as D1Database,
        "user",
        "user-42",
        "transfer_completed",
        "Transfer done",
        "Package transferred",
      );

      const insertStmt = db._executed.find((e) => e.sql.includes("INSERT INTO notifications"));
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.params[1]).toBe("user-42");
    });

    it("should notify all org owners for org owner", async () => {
      const db = createMockDB({
        allFn: (sql, params) => {
          if (sql.includes("org_members")) {
            return [{ user_id: "owner-1" }, { user_id: "owner-2" }];
          }
          return [];
        },
      });

      await notifyOwnerOwners(
        db as unknown as D1Database,
        "org",
        "org-1",
        "member_joined",
        "New member",
        "Someone joined",
      );

      const inserts = db._executed.filter((e) => e.sql.includes("INSERT INTO notifications"));
      expect(inserts.length).toBe(2);
      expect(inserts[0].params[1]).toBe("owner-1");
      expect(inserts[1].params[1]).toBe("owner-2");
    });

    it("should do nothing for system owner type", async () => {
      const db = createMockDB();

      await notifyOwnerOwners(
        db as unknown as D1Database,
        "system",
        "system-id",
        "system_notice",
        "Test",
        "Test",
      );

      const inserts = db._executed.filter((e) => e.sql.includes("INSERT INTO notifications"));
      expect(inserts.length).toBe(0);
    });
  });

  describe("listNotifications", () => {
    it("should query with correct base filters", async () => {
      const db = createMockDB();
      await listNotifications(db as unknown as D1Database, "user-1");

      const query = db._executed.find((e) => e.sql.includes("SELECT * FROM notifications"));
      expect(query).toBeDefined();
      expect(query!.sql).toContain("user_id = ?");
      expect(query!.sql).toContain("dismissed = 0");
      expect(query!.params[0]).toBe("user-1");
    });

    it("should add unread filter when unreadOnly is true", async () => {
      const db = createMockDB();
      await listNotifications(db as unknown as D1Database, "user-1", { unreadOnly: true });

      const query = db._executed.find((e) => e.sql.includes("SELECT * FROM notifications"));
      expect(query!.sql).toContain("read = 0");
    });

    it("should add type filter when specified", async () => {
      const db = createMockDB();
      await listNotifications(db as unknown as D1Database, "user-1", { type: "transfer_request" });

      const query = db._executed.find((e) => e.sql.includes("SELECT * FROM notifications"));
      expect(query!.sql).toContain("type = ?");
      expect(query!.params).toContain("transfer_request");
    });

    it("should default limit to 50", async () => {
      const db = createMockDB();
      await listNotifications(db as unknown as D1Database, "user-1");

      const query = db._executed.find((e) => e.sql.includes("SELECT * FROM notifications"));
      expect(query!.sql).toContain("LIMIT ?");
      // Last param is the limit
      expect(query!.params[query!.params.length - 1]).toBe(50);
    });

    it("should use custom limit when provided", async () => {
      const db = createMockDB();
      await listNotifications(db as unknown as D1Database, "user-1", { limit: 10 });

      const query = db._executed.find((e) => e.sql.includes("SELECT * FROM notifications"));
      expect(query!.params[query!.params.length - 1]).toBe(10);
    });

    it("should combine unreadOnly and type filters", async () => {
      const db = createMockDB();
      await listNotifications(db as unknown as D1Database, "user-1", {
        unreadOnly: true,
        type: "security_alert",
        limit: 5,
      });

      const query = db._executed.find((e) => e.sql.includes("SELECT * FROM notifications"));
      expect(query!.sql).toContain("read = 0");
      expect(query!.sql).toContain("type = ?");
      expect(query!.params).toContain("security_alert");
      expect(query!.params[query!.params.length - 1]).toBe(5);
    });
  });

  describe("getUnreadCount", () => {
    it("should query COUNT with correct filters", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("COUNT")) return { count: 7 };
          return null;
        },
      });

      const count = await getUnreadCount(db as unknown as D1Database, "user-1");
      expect(count).toBe(7);

      const query = db._executed.find((e) => e.sql.includes("COUNT"));
      expect(query!.sql).toContain("read = 0");
      expect(query!.sql).toContain("dismissed = 0");
      expect(query!.params[0]).toBe("user-1");
    });

    it("should return 0 when no result", async () => {
      const db = createMockDB({
        firstFn: () => null,
      });

      const count = await getUnreadCount(db as unknown as D1Database, "user-1");
      expect(count).toBe(0);
    });
  });

  describe("markRead", () => {
    it("should update read=1 for specific notification and user", async () => {
      const db = createMockDB({ runChanges: 1 });
      const result = await markRead(db as unknown as D1Database, "notif-abc", "user-1");

      expect(result).toBe(true);
      const update = db._executed.find((e) => e.sql.includes("UPDATE notifications SET read = 1"));
      expect(update).toBeDefined();
      expect(update!.params[0]).toBe("notif-abc");
      expect(update!.params[1]).toBe("user-1");
    });

    it("should return false when no rows affected", async () => {
      const db = createMockDB({ runChanges: 0 });
      const result = await markRead(db as unknown as D1Database, "notif-nonexistent", "user-1");
      expect(result).toBe(false);
    });
  });

  describe("markAllRead", () => {
    it("should update all unread notifications for user", async () => {
      const db = createMockDB({ runChanges: 5 });
      const count = await markAllRead(db as unknown as D1Database, "user-1");

      expect(count).toBe(5);
      const update = db._executed.find((e) => e.sql.includes("UPDATE notifications SET read = 1") && e.sql.includes("read = 0"));
      expect(update).toBeDefined();
      expect(update!.sql).toContain("dismissed = 0");
      expect(update!.params[0]).toBe("user-1");
    });

    it("should return 0 when nothing to mark", async () => {
      const db = createMockDB({ runChanges: 0 });
      const count = await markAllRead(db as unknown as D1Database, "user-1");
      expect(count).toBe(0);
    });
  });

  describe("dismiss", () => {
    it("should set dismissed=1 for notification and user", async () => {
      const db = createMockDB({ runChanges: 1 });
      const result = await dismiss(db as unknown as D1Database, "notif-abc", "user-1");

      expect(result).toBe(true);
      const update = db._executed.find((e) => e.sql.includes("SET dismissed = 1"));
      expect(update).toBeDefined();
      expect(update!.params[0]).toBe("notif-abc");
      expect(update!.params[1]).toBe("user-1");
    });

    it("should return false when notification not found", async () => {
      const db = createMockDB({ runChanges: 0 });
      const result = await dismiss(db as unknown as D1Database, "notif-none", "user-1");
      expect(result).toBe(false);
    });
  });

  describe("cleanupOldNotifications", () => {
    it("should delete old dismissed and read notifications", async () => {
      const db = createMockDB();
      await cleanupOldNotifications(db as unknown as D1Database);

      const del = db._executed.find((e) => e.sql.includes("DELETE FROM notifications"));
      expect(del).toBeDefined();
      expect(del!.sql).toContain("dismissed = 1");
      expect(del!.sql).toContain("-30 days");
      expect(del!.sql).toContain("read = 1");
      expect(del!.sql).toContain("-90 days");
    });

    it("should not require any parameters", async () => {
      const db = createMockDB();
      await cleanupOldNotifications(db as unknown as D1Database);

      const del = db._executed.find((e) => e.sql.includes("DELETE FROM notifications"));
      expect(del!.params).toEqual([]);
    });
  });
});

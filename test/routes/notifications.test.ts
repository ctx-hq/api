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

// --- Test fixtures ---

const mockNotifications = [
  {
    id: "notif-1",
    user_id: "user-1",
    type: "transfer_request",
    title: "Transfer request",
    body: "alice wants to transfer @alice/my-tool",
    data: "{}",
    read: 0,
    dismissed: 0,
    created_at: "2026-03-30T00:00:00Z",
  },
  {
    id: "notif-2",
    user_id: "user-1",
    type: "org_invitation",
    title: "Invitation to @acme",
    body: "You were invited to join @acme",
    data: "{}",
    read: 1,
    dismissed: 0,
    created_at: "2026-03-29T00:00:00Z",
  },
];

// --- App factory ---

function createNotificationApp(opts?: {
  user?: { id: string; username: string };
  notifications?: typeof mockNotifications;
  unreadCount?: number;
  markReadChanges?: number;
  dismissChanges?: number;
}) {
  const {
    user,
    notifications = mockNotifications,
    unreadCount = 1,
    markReadChanges = 1,
    dismissChanges = 1,
  } = opts ?? {};

  const db = createMockDB({
    firstFn: (sql) => {
      // Unread count
      if (sql.includes("COUNT(*)") && sql.includes("notifications") && sql.includes("read = 0")) {
        return { count: unreadCount };
      }
      return null;
    },
    allFn: (sql, params) => {
      // List notifications
      if (sql.includes("FROM notifications") && sql.includes("WHERE")) {
        let filtered = notifications.filter(n => n.dismissed === 0);
        // Check if unread_only filter is applied
        if (sql.includes("read = 0")) {
          filtered = filtered.filter(n => n.read === 0);
        }
        return filtered;
      }
      return [];
    },
    runFn: (sql) => {
      // Mark read
      if (sql.includes("UPDATE notifications SET read = 1") && sql.includes("WHERE id")) {
        return markReadChanges;
      }
      // Mark all read
      if (sql.includes("UPDATE notifications SET read = 1") && sql.includes("user_id")) {
        return markReadChanges;
      }
      // Dismiss
      if (sql.includes("UPDATE notifications SET dismissed = 1")) {
        return dismissChanges;
      }
      return 1;
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

  // --- List notifications (mirrors src/routes/notifications.ts) ---
  app.get("/v1/me/notifications", async (c) => {
    const { listNotifications } = await import("../../src/services/notification");
    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");

    const unreadOnly = c.req.query("unread_only") === "true";
    const type = c.req.query("type") as any;
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 100);

    const validTypes = [
      "org_invitation", "transfer_request", "transfer_completed",
      "member_joined", "member_left", "package_deprecated",
      "security_alert", "system_notice",
    ];

    const result = await listNotifications(c.env.DB as any, u.id, {
      unreadOnly,
      type: type && validTypes.includes(type) ? type : undefined,
      limit,
    });

    return c.json({ notifications: result });
  });

  // --- Unread count ---
  app.get("/v1/me/notifications/count", async (c) => {
    const { getUnreadCount } = await import("../../src/services/notification");
    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");

    const count = await getUnreadCount(c.env.DB as any, u.id);
    return c.json({ unread: count });
  });

  // --- Mark all read (must be before /:id to avoid param capture) ---
  app.patch("/v1/me/notifications/read-all", async (c) => {
    const { markAllRead } = await import("../../src/services/notification");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");

    const count = await markAllRead(c.env.DB as any, u.id);
    return c.json({ marked_read: count });
  });

  // --- Mark single as read ---
  app.patch("/v1/me/notifications/:id", async (c) => {
    const { badRequest, notFound } = await import("../../src/utils/errors");
    const { markRead } = await import("../../src/services/notification");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const notificationId = c.req.param("id")!;

    let body: { read?: boolean };
    try { body = await c.req.json(); } catch { throw badRequest("Invalid JSON body"); }

    if (body.read !== true) throw badRequest("Expected { read: true }");

    const updated = await markRead(c.env.DB as any, notificationId, u.id);
    if (!updated) throw notFound("Notification not found");

    return c.json({ id: notificationId, read: true });
  });

  // --- Dismiss ---
  app.delete("/v1/me/notifications/:id", async (c) => {
    const { notFound } = await import("../../src/utils/errors");
    const { dismiss } = await import("../../src/services/notification");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const notificationId = c.req.param("id")!;

    const dismissed = await dismiss(c.env.DB as any, notificationId, u.id);
    if (!dismissed) throw notFound("Notification not found");

    return c.json({ dismissed: notificationId });
  });

  return { app, db };
}

// --- Tests ---

describe("GET /v1/me/notifications — list notifications", () => {
  it("returns array of notifications", async () => {
    const { app } = createNotificationApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request("/v1/me/notifications");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.notifications).toBeInstanceOf(Array);
    expect(body.notifications.length).toBe(2);
    expect(body.notifications[0].id).toBe("notif-1");
  });

  it("filters unread when unread_only=true", async () => {
    const { app } = createNotificationApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request("/v1/me/notifications?unread_only=true");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.notifications).toBeInstanceOf(Array);
    // Only notif-1 is unread (read=0)
    expect(body.notifications.length).toBe(1);
    expect(body.notifications[0].id).toBe("notif-1");
  });
});

describe("GET /v1/me/notifications/count — unread count", () => {
  it("returns unread count", async () => {
    const { app } = createNotificationApp({
      user: { id: "user-1", username: "alice" },
      unreadCount: 5,
    });

    const res = await app.request("/v1/me/notifications/count");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.unread).toBe(5);
  });
});

describe("PATCH /v1/me/notifications/:id — mark as read", () => {
  it("marks notification as read", async () => {
    const { app } = createNotificationApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request("/v1/me/notifications/notif-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe("notif-1");
    expect(body.read).toBe(true);
  });

  it("invalid body returns 400", async () => {
    const { app } = createNotificationApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request("/v1/me/notifications/notif-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: false }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("read: true");
  });

  it("notification not found returns 404", async () => {
    const { app } = createNotificationApp({
      user: { id: "user-1", username: "alice" },
      markReadChanges: 0,
    });

    const res = await app.request("/v1/me/notifications/notif-nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    });

    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/me/notifications/read-all — mark all read", () => {
  it("marks all notifications as read", async () => {
    const { app } = createNotificationApp({
      user: { id: "user-1", username: "alice" },
      markReadChanges: 3,
    });

    const res = await app.request("/v1/me/notifications/read-all", {
      method: "PATCH",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.marked_read).toBe(3);
  });
});

describe("DELETE /v1/me/notifications/:id — dismiss notification", () => {
  it("dismisses a notification", async () => {
    const { app } = createNotificationApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request("/v1/me/notifications/notif-1", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.dismissed).toBe("notif-1");
  });

  it("dismiss nonexistent notification returns 404", async () => {
    const { app } = createNotificationApp({
      user: { id: "user-1", username: "alice" },
      dismissChanges: 0,
    });

    const res = await app.request("/v1/me/notifications/notif-nonexistent", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });
});

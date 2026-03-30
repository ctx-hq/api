import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware } from "../middleware/auth";
import { badRequest, notFound } from "../utils/errors";
import {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  dismiss,
} from "../services/notification";
import type { NotificationType } from "../models/types";

const app = new Hono<AppEnv>();

// List notifications
app.get("/v1/me/notifications", authMiddleware, async (c) => {
  const user = c.get("user");
  const unreadOnly = c.req.query("unread_only") === "true";
  const type = c.req.query("type") as NotificationType | undefined;
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 100);

  const validTypes = [
    "org_invitation", "transfer_request", "transfer_completed",
    "member_joined", "member_left", "package_deprecated",
    "security_alert", "system_notice",
  ];

  const notifications = await listNotifications(c.env.DB, user.id, {
    unreadOnly,
    type: type && validTypes.includes(type) ? type : undefined,
    limit,
  });

  return c.json({ notifications });
});

// Get unread count
app.get("/v1/me/notifications/count", authMiddleware, async (c) => {
  const user = c.get("user");
  const count = await getUnreadCount(c.env.DB, user.id);
  return c.json({ unread: count });
});

// Mark all notifications as read (must be before /:id to avoid param capture)
app.patch("/v1/me/notifications/read-all", authMiddleware, async (c) => {
  const user = c.get("user");
  const count = await markAllRead(c.env.DB, user.id);
  return c.json({ marked_read: count });
});

// Mark single notification as read
app.patch("/v1/me/notifications/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const notificationId = c.req.param("id")!;

  let body: { read?: boolean };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (body.read !== true) {
    throw badRequest("Expected { read: true }");
  }

  const updated = await markRead(c.env.DB, notificationId, user.id);
  if (!updated) throw notFound("Notification not found");

  return c.json({ id: notificationId, read: true });
});

// Dismiss notification
app.delete("/v1/me/notifications/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const notificationId = c.req.param("id")!;

  const dismissed = await dismiss(c.env.DB, notificationId, user.id);
  if (!dismissed) throw notFound("Notification not found");

  return c.json({ dismissed: notificationId });
});

export default app;

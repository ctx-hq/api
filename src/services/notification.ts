import type { PublisherRow, NotificationType, NotificationRow } from "../models/types";
import { generateId } from "../utils/response";

export type { NotificationType, NotificationRow };

/**
 * Create a notification for a single user.
 */
export async function notify(
  db: D1Database,
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<NotificationRow> {
  const id = `notif-${generateId()}`;
  await db
    .prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, type, title, body, JSON.stringify(data))
    .run();

  return {
    id,
    user_id: userId,
    type,
    title,
    body,
    data: JSON.stringify(data),
    read: 0,
    dismissed: 0,
    created_at: new Date().toISOString(),
  };
}

/**
 * Notify all owners of a publisher (user publisher → the user; org publisher → all org owners).
 */
export async function notifyPublisherOwners(
  db: D1Database,
  publisherId: string,
  type: NotificationType,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const publisher = await db
    .prepare("SELECT * FROM publishers WHERE id = ?")
    .bind(publisherId)
    .first<PublisherRow>();

  if (!publisher) return;

  if (publisher.kind === "user" && publisher.user_id) {
    await notify(db, publisher.user_id, type, title, body, data);
  } else if (publisher.kind === "org" && publisher.org_id) {
    const owners = await db
      .prepare(
        "SELECT user_id FROM org_members WHERE org_id = ? AND role = 'owner'",
      )
      .bind(publisher.org_id)
      .all<{ user_id: string }>();

    for (const owner of owners.results ?? []) {
      await notify(db, owner.user_id, type, title, body, data);
    }
  }
}

/**
 * List notifications for a user with optional filters.
 */
export async function listNotifications(
  db: D1Database,
  userId: string,
  opts: { unreadOnly?: boolean; type?: NotificationType; limit?: number } = {},
): Promise<NotificationRow[]> {
  const conditions = ["user_id = ?", "dismissed = 0"];
  const params: unknown[] = [userId];

  if (opts.unreadOnly) {
    conditions.push("read = 0");
  }
  if (opts.type) {
    conditions.push("type = ?");
    params.push(opts.type);
  }

  const limit = opts.limit ?? 50;

  const result = await db
    .prepare(
      `SELECT * FROM notifications
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<NotificationRow>();

  return result.results ?? [];
}

/**
 * Get unread notification count for badge display.
 */
export async function getUnreadCount(
  db: D1Database,
  userId: string,
): Promise<number> {
  const result = await db
    .prepare(
      "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0 AND dismissed = 0",
    )
    .bind(userId)
    .first<{ count: number }>();

  return result?.count ?? 0;
}

/**
 * Mark a single notification as read.
 */
export async function markRead(
  db: D1Database,
  notificationId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?",
    )
    .bind(notificationId, userId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Mark all notifications as read for a user.
 */
export async function markAllRead(
  db: D1Database,
  userId: string,
): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0 AND dismissed = 0",
    )
    .bind(userId)
    .run();

  return result.meta?.changes ?? 0;
}

/**
 * Dismiss (soft-delete) a notification.
 */
export async function dismiss(
  db: D1Database,
  notificationId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE notifications SET dismissed = 1 WHERE id = ? AND user_id = ?",
    )
    .bind(notificationId, userId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Probabilistic cleanup of old notifications.
 * Called on ~1% of requests. Removes:
 * - Dismissed notifications older than 30 days
 * - Read notifications older than 90 days
 */
export async function cleanupOldNotifications(db: D1Database): Promise<void> {
  await db
    .prepare(
      `DELETE FROM notifications WHERE
         (dismissed = 1 AND created_at < datetime('now', '-30 days'))
         OR (read = 1 AND created_at < datetime('now', '-90 days'))`,
    )
    .run();
}

import type { OrgInvitationRow, InvitationStatus } from "../models/types";
import { generateId } from "../utils/response";

const INVITATION_EXPIRY_DAYS = 7;

/**
 * Format a Date as SQLite-compatible UTC datetime string.
 * Output: "YYYY-MM-DD HH:MM:SS" — matches SQLite datetime('now') output,
 * ensuring text comparison with expires_at works correctly.
 */
function toSqliteDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Create a pending org invitation. Expires in 7 days.
 * Caller must validate: inviter has permission, invitee exists, not already member, no pending invite.
 */
export async function createInvitation(
  db: D1Database,
  orgId: string,
  inviterId: string,
  inviteeId: string,
  role: string,
): Promise<OrgInvitationRow> {
  const id = `inv-${generateId()}`;
  const now = toSqliteDatetime(new Date());
  const expiresAt = toSqliteDatetime(new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000));

  await db
    .prepare(
      `INSERT INTO org_invitations (id, org_id, inviter_id, invitee_id, role, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(id, orgId, inviterId, inviteeId, role, expiresAt, now)
    .run();

  return {
    id,
    org_id: orgId,
    inviter_id: inviterId,
    invitee_id: inviteeId,
    role,
    status: "pending",
    expires_at: expiresAt,
    created_at: now,
    resolved_at: null,
  };
}

/**
 * List invitations for an org, optionally filtered by status.
 * Returns enriched rows with inviter/invitee usernames via JOIN.
 */
export async function listOrgInvitations(
  db: D1Database,
  orgId: string,
  status?: InvitationStatus,
) {
  const conditions = ["i.org_id = ?"];
  const params: unknown[] = [orgId];

  if (status) {
    conditions.push("i.status = ?");
    params.push(status);
  }

  const result = await db
    .prepare(
      `SELECT i.id, i.role, i.status, i.expires_at, i.created_at, i.resolved_at,
              u1.username AS inviter, u2.username AS invitee
       FROM org_invitations i
       LEFT JOIN users u1 ON i.inviter_id = u1.id
       LEFT JOIN users u2 ON i.invitee_id = u2.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY i.created_at DESC`,
    )
    .bind(...params)
    .all<{
      id: string; role: string; status: string;
      expires_at: string; created_at: string; resolved_at: string | null;
      inviter: string; invitee: string;
    }>();

  return result.results ?? [];
}

/**
 * List pending invitations for a user (across all orgs).
 * Auto-expires past-due invitations before returning.
 * Returns enriched rows with org name and inviter username via JOIN.
 */
export async function listUserInvitations(
  db: D1Database,
  userId: string,
) {
  // Expire any past-due invitations first
  await expirePendingInvitations(db);

  const result = await db
    .prepare(
      `SELECT i.id, i.role, i.status, i.expires_at, i.created_at,
              o.name AS org_name, o.display_name AS org_display_name,
              u.username AS inviter
       FROM org_invitations i
       LEFT JOIN orgs o ON i.org_id = o.id
       LEFT JOIN users u ON i.inviter_id = u.id
       WHERE i.invitee_id = ? AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
    )
    .bind(userId)
    .all<{
      id: string; role: string; status: string;
      expires_at: string; created_at: string;
      org_name: string; org_display_name: string; inviter: string;
    }>();

  return result.results ?? [];
}

/**
 * Accept an invitation: set status to accepted, insert org_members row.
 * Returns the updated invitation or null if not found/not pending/expired.
 * Uses conditional UPDATE to avoid TOCTOU races.
 */
export async function acceptInvitation(
  db: D1Database,
  invitationId: string,
  userId: string,
): Promise<OrgInvitationRow | null> {
  const invitation = await db
    .prepare("SELECT * FROM org_invitations WHERE id = ? AND invitee_id = ?")
    .bind(invitationId, userId)
    .first<OrgInvitationRow>();

  if (!invitation || invitation.status !== "pending") return null;

  // Check if expired
  if (new Date(invitation.expires_at) < new Date()) {
    await db
      .prepare(
        "UPDATE org_invitations SET status = 'expired', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'",
      )
      .bind(invitationId)
      .run();
    return null;
  }

  const now = toSqliteDatetime(new Date());

  // Conditional UPDATE: only succeeds if still pending (prevents double-accept race)
  const updateResult = await db
    .prepare(
      "UPDATE org_invitations SET status = 'accepted', resolved_at = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(now, invitationId)
    .run();

  if ((updateResult.meta?.changes ?? 0) === 0) return null;

  await db
    .prepare(
      "INSERT OR IGNORE INTO org_members (org_id, user_id, role, visibility) VALUES (?, ?, ?, 'private')",
    )
    .bind(invitation.org_id, userId, invitation.role)
    .run();

  return { ...invitation, status: "accepted", resolved_at: now };
}

/**
 * Decline an invitation.
 */
export async function declineInvitation(
  db: D1Database,
  invitationId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE org_invitations SET status = 'declined', resolved_at = datetime('now') WHERE id = ? AND invitee_id = ? AND status = 'pending'",
    )
    .bind(invitationId, userId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Cancel a pending invitation (by org admin/owner).
 */
export async function cancelInvitation(
  db: D1Database,
  invitationId: string,
  orgId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE org_invitations SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ? AND org_id = ? AND status = 'pending'",
    )
    .bind(invitationId, orgId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Bulk-expire all past-due pending invitations.
 */
export async function expirePendingInvitations(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE org_invitations SET status = 'expired', resolved_at = datetime('now') WHERE status = 'pending' AND expires_at < datetime('now')",
    )
    .run();

  return result.meta?.changes ?? 0;
}

/**
 * Cancel all pending invitations for a user in an org (used during member removal).
 */
export async function cancelUserInvitations(
  db: D1Database,
  orgId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE org_invitations SET status = 'cancelled', resolved_at = datetime('now') WHERE org_id = ? AND invitee_id = ? AND status = 'pending'",
    )
    .bind(orgId, userId)
    .run();
}

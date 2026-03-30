import type { PublisherRow, TransferStatus, TransferRequestRow } from "../models/types";
import { generateId } from "../utils/response";

export type { TransferStatus, TransferRequestRow };

const TRANSFER_EXPIRY_DAYS = 14;

function toSqliteDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Create a pending transfer request. 14-day expiry.
 * Caller must validate: permissions, no existing pending transfer, target != source.
 */
export async function createTransferRequest(
  db: D1Database,
  packageId: string,
  fromPublisherId: string,
  toPublisherId: string,
  initiatedBy: string,
  message = "",
): Promise<TransferRequestRow> {
  const id = `xfer-${generateId()}`;
  const now = toSqliteDatetime(new Date());
  const expiresAt = toSqliteDatetime(
    new Date(Date.now() + TRANSFER_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
  );

  await db
    .prepare(
      `INSERT INTO transfer_requests
       (id, package_id, from_publisher_id, to_publisher_id, initiated_by, status, message, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(id, packageId, fromPublisherId, toPublisherId, initiatedBy, message, expiresAt, now)
    .run();

  return {
    id,
    package_id: packageId,
    from_publisher_id: fromPublisherId,
    to_publisher_id: toPublisherId,
    initiated_by: initiatedBy,
    status: "pending",
    message,
    expires_at: expiresAt,
    created_at: now,
    resolved_at: null,
    resolved_by: null,
  };
}

/**
 * Accept a transfer: validate preconditions, then atomically mark accepted + move the package.
 * Returns the updated transfer, or null if not found/not pending/expired.
 * Throws on conflict (name collision at target scope) so the caller can surface a clear error.
 */
export async function acceptTransfer(
  db: D1Database,
  transferId: string,
  userId: string,
): Promise<TransferRequestRow | null> {
  const transfer = await db
    .prepare("SELECT * FROM transfer_requests WHERE id = ?")
    .bind(transferId)
    .first<TransferRequestRow>();

  if (!transfer || transfer.status !== "pending") return null;

  // Check if expired
  if (new Date(transfer.expires_at) < new Date()) {
    await db
      .prepare(
        "UPDATE transfer_requests SET status = 'expired', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'",
      )
      .bind(transferId)
      .run();
    return null;
  }

  // --- Validate preconditions BEFORE marking accepted ---

  // Get target publisher to determine new scope
  const toPublisher = await db
    .prepare("SELECT * FROM publishers WHERE id = ?")
    .bind(transfer.to_publisher_id)
    .first<PublisherRow>();

  if (!toPublisher) {
    throw new Error("Target publisher no longer exists");
  }

  // Get the package
  const pkg = await db
    .prepare("SELECT id, full_name, name, scope FROM packages WHERE id = ? AND deleted_at IS NULL")
    .bind(transfer.package_id)
    .first<{ id: string; full_name: string; name: string; scope: string }>();

  if (!pkg) {
    throw new Error("Package no longer exists or has been deleted");
  }

  const newScope = toPublisher.slug;
  const newFullName = `@${newScope}/${pkg.name}`;
  const oldFullName = pkg.full_name;

  // Re-check name collision at accept time (may have changed since initiation)
  const collision = await db
    .prepare("SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL")
    .bind(newFullName)
    .first();

  if (collision) {
    throw new Error(`Package ${newFullName} already exists at the target scope`);
  }

  // Ensure target scope exists
  const existingScope = await db
    .prepare("SELECT name FROM scopes WHERE name = ?")
    .bind(newScope)
    .first();

  if (!existingScope) {
    await db
      .prepare(
        "INSERT INTO scopes (name, owner_type, owner_id, publisher_id) VALUES (?, ?, ?, ?)",
      )
      .bind(
        newScope,
        toPublisher.kind === "user" ? "user" : "org",
        toPublisher.kind === "user" ? toPublisher.user_id : toPublisher.org_id,
        toPublisher.id,
      )
      .run();
  }

  const now = toSqliteDatetime(new Date());

  // Atomic batch: mark accepted AND move the package in one batch
  // If the conditional update finds 0 rows (race), the package move still runs
  // but is harmless — the package stays where it is. We check changes below.
  const batchResults = await db.batch([
    // Conditional UPDATE: only succeeds if still pending (prevents double-accept race)
    db.prepare(
      "UPDATE transfer_requests SET status = 'accepted', resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'",
    ).bind(now, userId, transferId),

    // Move the package
    db.prepare(
      "UPDATE packages SET scope = ?, full_name = ?, publisher_id = ?, updated_at = datetime('now') WHERE id = ? AND full_name = ?",
    ).bind(newScope, newFullName, toPublisher.id, pkg.id, oldFullName),

    // Create slug alias for old name
    db.prepare(
      "INSERT OR REPLACE INTO slug_aliases (old_full_name, new_full_name) VALUES (?, ?)",
    ).bind(oldFullName, newFullName),

    // Update search_digest
    db.prepare(
      "UPDATE search_digest SET full_name = ?, publisher_slug = ?, updated_at = datetime('now') WHERE package_id = ?",
    ).bind(newFullName, newScope, pkg.id),

    // Clean up package_access (org-specific, meaningless after transfer)
    db.prepare(
      "DELETE FROM package_access WHERE package_id = ?",
    ).bind(pkg.id),

    // Flatten existing alias chains pointing to oldFullName
    db.prepare(
      "UPDATE slug_aliases SET new_full_name = ? WHERE new_full_name = ?",
    ).bind(newFullName, oldFullName),
  ]);

  // Check the conditional UPDATE actually changed a row (wasn't raced)
  if ((batchResults[0].meta?.changes ?? 0) === 0) return null;

  return { ...transfer, status: "accepted", resolved_at: now, resolved_by: userId };
}

/**
 * Decline a transfer request.
 */
export async function declineTransfer(
  db: D1Database,
  transferId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE transfer_requests SET status = 'declined', resolved_at = datetime('now'), resolved_by = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(userId, transferId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Cancel a pending transfer (by the initiator or source publisher owner).
 */
export async function cancelTransfer(
  db: D1Database,
  packageId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE transfer_requests SET status = 'cancelled', resolved_at = datetime('now'), resolved_by = ? WHERE package_id = ? AND status = 'pending'",
    )
    .bind(userId, packageId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

/**
 * List incoming transfer requests for publishers the user owns.
 * Auto-expires past-due transfers before returning.
 */
export async function listIncomingTransfers(
  db: D1Database,
  userId: string,
): Promise<Array<TransferRequestRow & { package_name: string; from_slug: string; to_slug: string }>> {
  // Expire any past-due transfers first
  await expirePendingTransfers(db);

  const result = await db
    .prepare(
      `SELECT t.*, p.full_name AS package_name, fp.slug AS from_slug, tp.slug AS to_slug
       FROM transfer_requests t
       JOIN packages p ON t.package_id = p.id
       JOIN publishers fp ON t.from_publisher_id = fp.id
       JOIN publishers tp ON t.to_publisher_id = tp.id
       WHERE t.status = 'pending'
         AND (
           -- User is the target publisher (user kind)
           tp.user_id = ?
           -- Or user is owner of target org
           OR tp.org_id IN (
             SELECT org_id FROM org_members WHERE user_id = ? AND role IN ('owner', 'admin')
           )
         )
       ORDER BY t.created_at DESC`,
    )
    .bind(userId, userId)
    .all<TransferRequestRow & { package_name: string; from_slug: string; to_slug: string }>();

  return result.results ?? [];
}

/**
 * Bulk-expire all past-due pending transfers.
 */
export async function expirePendingTransfers(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE transfer_requests SET status = 'expired', resolved_at = datetime('now') WHERE status = 'pending' AND expires_at < datetime('now')",
    )
    .run();

  return result.meta?.changes ?? 0;
}

/**
 * Cancel all pending transfers for a package (used during package deletion or org dissolution).
 */
export async function cancelPackageTransfers(
  db: D1Database,
  packageId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE transfer_requests SET status = 'cancelled', resolved_at = datetime('now') WHERE package_id = ? AND status = 'pending'",
    )
    .bind(packageId)
    .run();
}

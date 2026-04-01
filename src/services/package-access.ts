import type { PackageAccessRow } from "../models/types";

/**
 * List users who have been granted access to a package.
 */
export async function getPackageAccess(
  db: D1Database,
  packageId: string,
): Promise<PackageAccessRow[]> {
  const result = await db
    .prepare(
      `SELECT pa.package_id, pa.user_id, u.username, pa.granted_by, pa.created_at
       FROM package_access pa
       JOIN users u ON pa.user_id = u.id
       WHERE pa.package_id = ?
       ORDER BY pa.created_at ASC`,
    )
    .bind(packageId)
    .all<PackageAccessRow & { username: string }>();

  return result.results ?? [];
}

/**
 * Grant access to specific users for a package.
 * Silently skips users who already have access.
 */
export async function grantPackageAccess(
  db: D1Database,
  packageId: string,
  userIds: string[],
  grantedBy: string,
): Promise<number> {
  if (userIds.length === 0) return 0;

  const stmts = userIds.map((userId) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO package_access (package_id, user_id, granted_by) VALUES (?, ?, ?)",
      )
      .bind(packageId, userId, grantedBy),
  );

  const results = await db.batch(stmts);
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
}

/**
 * Revoke access from specific users for a package.
 */
export async function revokePackageAccess(
  db: D1Database,
  packageId: string,
  userIds: string[],
): Promise<number> {
  if (userIds.length === 0) return 0;

  const stmts = userIds.map((userId) =>
    db
      .prepare("DELETE FROM package_access WHERE package_id = ? AND user_id = ?")
      .bind(packageId, userId),
  );

  const results = await db.batch(stmts);
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
}

/**
 * Remove package access grants for a user within a specific org's packages.
 * Scoped to the org to avoid affecting grants in other orgs.
 */
export async function cleanupUserAccessForOrg(
  db: D1Database,
  userId: string,
  orgId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM package_access WHERE user_id = ?
       AND package_id IN (
         SELECT id FROM packages WHERE owner_type = 'org' AND owner_id = ?
       )`,
    )
    .bind(userId, orgId)
    .run();
}

/**
 * Check if a package has any access restrictions (has rows in package_access).
 */
export async function hasAccessRestrictions(
  db: D1Database,
  packageId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 FROM package_access WHERE package_id = ? LIMIT 1",
    )
    .bind(packageId)
    .first();

  return row !== null;
}

/**
 * Check if a specific user has been granted access to a restricted package.
 */
export async function userHasAccess(
  db: D1Database,
  packageId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 FROM package_access WHERE package_id = ? AND user_id = ?",
    )
    .bind(packageId, userId)
    .first();

  return row !== null;
}

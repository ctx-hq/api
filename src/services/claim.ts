import { generateId } from "../utils/response";
import { ensureUserScope, getOwnerSlug } from "./ownership";
import { upsertSearchDigest } from "./publish";

export interface ClaimablePackage {
  package_id: string;
  full_name: string;
  source_repo: string;
  description: string;
  downloads: number;
}

/**
 * Find system-owned packages whose source_repo matches the user's GitHub username.
 * Matches `github:username/` prefix in source_repo or import_external_id.
 */
export async function findClaimablePackages(
  db: D1Database,
  githubUsername: string,
): Promise<ClaimablePackage[]> {
  const pattern = `github:${githubUsername.toLowerCase()}/%`;

  const result = await db
    .prepare(
      `SELECT id AS package_id, full_name, source_repo, description, downloads
       FROM packages
       WHERE owner_type = 'system'
         AND deleted_at IS NULL
         AND (LOWER(source_repo) LIKE ? OR LOWER(import_external_id) LIKE ?)
       ORDER BY downloads DESC
       LIMIT 100`,
    )
    .bind(pattern, pattern)
    .all();

  return (result.results ?? []) as unknown as ClaimablePackage[];
}

/**
 * Claim a system-owned package. Transfers ownership to the user.
 * - Validates package is system-owned
 * - Atomically updates owner_type/owner_id and scope
 * - Creates user scope if needed
 * - Updates search_digest
 *
 * Returns the new full_name after scope change.
 */
export async function claimPackage(
  db: D1Database,
  packageId: string,
  userId: string,
  username: string,
): Promise<{ success: boolean; new_full_name: string; error?: string }> {
  // Fetch the package
  const pkg = await db
    .prepare(
      "SELECT id, full_name, scope, name, type, owner_type, source_repo, import_external_id, description, summary, keywords, capabilities, downloads FROM packages WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(packageId)
    .first<Record<string, unknown>>();

  if (!pkg) {
    return { success: false, new_full_name: "", error: "Package not found" };
  }

  if (pkg.owner_type !== "system") {
    return { success: false, new_full_name: "", error: "Package is not system-owned" };
  }

  // Verify GitHub ownership: source_repo must match claimant's username
  const sourceRepo = ((pkg.source_repo as string) ?? "").toLowerCase();
  const importId = ((pkg.import_external_id as string) ?? "").toLowerCase();
  const expectedPrefix = `github:${username.toLowerCase()}/`;
  if (!sourceRepo.startsWith(expectedPrefix) && !importId.startsWith(expectedPrefix)) {
    return { success: false, new_full_name: "", error: "Package source does not match your GitHub identity" };
  }

  // Compute new full_name under user's scope
  const newFullName = `@${username}/${pkg.name as string}`;

  // Check for collision at target scope
  const collision = await db
    .prepare("SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL")
    .bind(newFullName)
    .first();

  if (collision) {
    return {
      success: false,
      new_full_name: "",
      error: `Package ${newFullName} already exists. Rename it first.`,
    };
  }

  // Ensure user scope exists
  await ensureUserScope(db, userId, username);

  // Atomically transfer ownership
  const updateResult = await db
    .prepare(
      `UPDATE packages
       SET owner_type = 'user', owner_id = ?, scope = ?, full_name = ?, updated_at = datetime('now')
       WHERE id = ? AND owner_type = 'system'`,
    )
    .bind(userId, username, newFullName, packageId)
    .run();

  if (!updateResult.meta.changes || updateResult.meta.changes === 0) {
    return { success: false, new_full_name: "", error: "Claim failed (race condition)" };
  }

  // Create slug alias so old URLs redirect
  const oldFullName = pkg.full_name as string;
  if (oldFullName && oldFullName !== newFullName) {
    await db
      .prepare("INSERT OR REPLACE INTO slug_aliases (old_full_name, new_full_name) VALUES (?, ?)")
      .bind(oldFullName, newFullName)
      .run();
  }

  // Record the claim
  await db
    .prepare(
      `INSERT INTO package_claims (id, package_id, claimant_id, github_repo, status, resolved_at)
       VALUES (?, ?, ?, ?, 'approved', datetime('now'))`,
    )
    .bind(generateId(), packageId, userId, (pkg.source_repo as string) ?? "")
    .run();

  // Fetch current latest version before updating search_digest
  const latestTag = await db
    .prepare(
      `SELECT v.version FROM versions v
       JOIN dist_tags dt ON dt.version_id = v.id
       WHERE dt.package_id = ? AND dt.tag = 'latest'`,
    )
    .bind(packageId)
    .first<{ version: string }>();

  // Update search_digest
  await upsertSearchDigest(
    db,
    packageId,
    newFullName,
    (pkg.type as string | null) ?? "skill",
    (pkg.description as string | null) ?? "",
    (pkg.summary as string | null) ?? "",
    (pkg.keywords as string | null) ?? "[]",
    (pkg.capabilities as string | null) ?? "[]",
    latestTag?.version ?? "",
    (pkg.downloads as number | null) ?? 0,
    username, // new owner_slug
  );

  return { success: true, new_full_name: newFullName };
}

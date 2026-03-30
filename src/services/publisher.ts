import type { PublisherRow } from "../models/types";
import { generateId } from "../utils/response";
import { hasAccessRestrictions, userHasAccess } from "./package-access";

/**
 * Get or create a personal publisher for a user.
 * Every user gets exactly one publisher with kind='user'.
 */
export async function getOrCreatePublisher(
  db: D1Database,
  userId: string,
  username: string,
): Promise<PublisherRow> {
  const existing = await db
    .prepare("SELECT * FROM publishers WHERE user_id = ? AND kind = 'user'")
    .bind(userId)
    .first<PublisherRow>();

  if (existing) return existing;

  const id = `pub-${generateId()}`;
  await db
    .prepare(
      "INSERT INTO publishers (id, kind, user_id, slug) VALUES (?, 'user', ?, ?)",
    )
    .bind(id, userId, username)
    .run();

  return { id, kind: "user", user_id: userId, org_id: null, slug: username, created_at: new Date().toISOString() };
}

/**
 * Create an org publisher when an org is created.
 * Note: org_id FK is deferred — call this AFTER inserting the org row.
 */
export async function createOrgPublisher(
  db: D1Database,
  orgId: string,
  orgName: string,
): Promise<PublisherRow> {
  const id = `pub-org-${generateId()}`;
  await db
    .prepare(
      "INSERT INTO publishers (id, kind, org_id, slug) VALUES (?, 'org', ?, ?)",
    )
    .bind(id, orgId, orgName)
    .run();

  return { id, kind: "org", user_id: null, org_id: orgId, slug: orgName, created_at: new Date().toISOString() };
}

/**
 * Check if a user can access a private package.
 * Returns true for public/unlisted packages.
 *
 * For org packages with package_access rows (restricted mode):
 * - Owner/admin always have access
 * - Other members need an explicit grant in package_access
 *
 * For org packages without package_access rows (standard private):
 * - All org members have access
 */
export async function canAccessPackage(
  db: D1Database,
  userId: string | null,
  pkg: { id?: unknown; visibility?: unknown; publisher_id?: unknown },
): Promise<boolean> {
  if (pkg.visibility !== "private") return true;
  if (!userId) return false;

  const publisherId = pkg.publisher_id as string;
  if (!publisherId) return false;

  const publisher = await db
    .prepare("SELECT * FROM publishers WHERE id = ?")
    .bind(publisherId)
    .first<PublisherRow>();

  if (!publisher) return false;

  // User publisher: simple ownership check
  if (publisher.kind === "user") {
    return publisher.user_id === userId;
  }

  // Org publisher: check membership first
  if (publisher.kind === "org" && publisher.org_id) {
    const membership = await db
      .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(publisher.org_id, userId)
      .first<{ role: string }>();

    if (!membership) return false;

    // Owner/admin always have access to all org packages
    if (membership.role === "owner" || membership.role === "admin") return true;

    // Check if package has access restrictions
    const packageId = pkg.id as string;
    if (packageId && await hasAccessRestrictions(db, packageId)) {
      // Restricted mode: member needs explicit grant
      return userHasAccess(db, packageId, userId);
    }

    // Standard private: all members have access
    return true;
  }

  return false;
}

/**
 * Get the publisher that owns a scope.
 */
export async function getPublisherForScope(
  db: D1Database,
  scopeName: string,
): Promise<PublisherRow | null> {
  const scope = await db
    .prepare("SELECT publisher_id FROM scopes WHERE name = ?")
    .bind(scopeName)
    .first<{ publisher_id: string }>();

  if (!scope || !scope.publisher_id) return null;

  return db
    .prepare("SELECT * FROM publishers WHERE id = ?")
    .bind(scope.publisher_id)
    .first<PublisherRow>();
}

/**
 * Check if a user can publish to a publisher's scope.
 *
 * - User publisher: user_id must match
 * - Org publisher: user must be a member of the org AND org must be active (not archived)
 */
export async function canPublish(
  db: D1Database,
  userId: string,
  publisher: PublisherRow,
): Promise<boolean> {
  if (publisher.kind === "user") {
    return publisher.user_id === userId;
  }

  if (publisher.kind === "org" && publisher.org_id) {
    // Check org is not archived
    const org = await db
      .prepare("SELECT status FROM orgs WHERE id = ?")
      .bind(publisher.org_id)
      .first<{ status: string }>();

    if (org?.status === "archived") return false;

    const membership = await db
      .prepare(
        "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
      )
      .bind(publisher.org_id, userId)
      .first<{ role: string }>();

    return membership !== null;
  }

  return false;
}

/**
 * Check if a user can publish (without archive check — for access control only).
 * Use this for read-access checks where archived orgs should still allow access.
 */
export async function isMemberOfPublisher(
  db: D1Database,
  userId: string,
  publisher: PublisherRow,
): Promise<boolean> {
  if (publisher.kind === "user") {
    return publisher.user_id === userId;
  }

  if (publisher.kind === "org" && publisher.org_id) {
    const membership = await db
      .prepare(
        "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
      )
      .bind(publisher.org_id, userId)
      .first<{ role: string }>();

    return membership !== null;
  }

  return false;
}

/**
 * Get a publisher by slug.
 */
export async function getPublisherBySlug(
  db: D1Database,
  slug: string,
): Promise<PublisherRow | null> {
  return db
    .prepare("SELECT * FROM publishers WHERE slug = ?")
    .bind(slug)
    .first<PublisherRow>();
}

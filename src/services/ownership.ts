import type { OwnerType } from "../models/types";
import { hasAccessRestrictions, userHasAccess } from "./package-access";

export type OwnerRef = { owner_type: OwnerType; owner_id: string };

/**
 * Get the owner of a scope.
 * Returns { owner_type, owner_id } or null if scope doesn't exist.
 */
export async function getOwnerForScope(
  db: D1Database,
  scopeName: string,
): Promise<OwnerRef | null> {
  const scope = await db
    .prepare("SELECT owner_type, owner_id FROM scopes WHERE name = ?")
    .bind(scopeName)
    .first<{ owner_type: OwnerType; owner_id: string }>();

  return scope ?? null;
}

/**
 * Check if a user can publish to a scope.
 * Like canPublishWithOwner but returns only a boolean.
 */
export async function canPublish(
  db: D1Database,
  userId: string,
  scopeName: string,
): Promise<boolean> {
  return (await canPublishWithOwner(db, userId, scopeName)) !== null;
}

/**
 * Check if a user can publish to a scope, returning the OwnerRef on success.
 * - user scope: owner_id must match userId
 * - org scope: user must be active member AND org not archived
 * - system scope: always false
 * Returns null if scope doesn't exist or user lacks permission.
 */
export async function canPublishWithOwner(
  db: D1Database,
  userId: string,
  scopeName: string,
): Promise<OwnerRef | null> {
  const owner = await getOwnerForScope(db, scopeName);
  if (!owner) return null;

  if (owner.owner_type === "user") {
    return owner.owner_id === userId ? owner : null;
  }

  if (owner.owner_type === "org") {
    const org = await db
      .prepare("SELECT status FROM orgs WHERE id = ?")
      .bind(owner.owner_id)
      .first<{ status: string }>();

    if (org?.status === "archived") return null;

    const membership = await db
      .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(owner.owner_id, userId)
      .first<{ role: string }>();

    return membership !== null ? owner : null;
  }

  return null;
}

/**
 * Check if a user can access a private package.
 * - public/unlisted: always true
 * - private + user-owned: owner_id === userId
 * - private + org-owned: user is member (owner/admin bypass access restrictions)
 * - private + system-owned: always false
 */
export async function canAccessPackage(
  db: D1Database,
  userId: string | null,
  pkg: { id?: unknown; visibility?: unknown; owner_type?: unknown; owner_id?: unknown },
): Promise<boolean> {
  if (pkg.visibility !== "private") return true;
  if (!userId) return false;

  const ownerType = pkg.owner_type as OwnerType;
  const ownerId = pkg.owner_id as string;

  if (ownerType === "user") {
    return ownerId === userId;
  }

  if (ownerType === "org") {
    const membership = await db
      .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(ownerId, userId)
      .first<{ role: string }>();

    if (!membership) return false;

    // Owner/admin always have access
    if (membership.role === "owner" || membership.role === "admin") return true;

    // Check if package has access restrictions
    const packageId = pkg.id as string;
    if (packageId && await hasAccessRestrictions(db, packageId)) {
      return userHasAccess(db, packageId, userId);
    }

    // Standard private: all members have access
    return true;
  }

  // system-owned private packages are inaccessible
  return false;
}

/**
 * Check if a user is a member/owner of the entity behind a scope.
 * Used for read-access checks (no archive restriction).
 */
export async function isMemberOfOwner(
  db: D1Database,
  userId: string,
  owner: OwnerRef,
): Promise<boolean> {
  if (owner.owner_type === "user") {
    return owner.owner_id === userId;
  }

  if (owner.owner_type === "org") {
    const membership = await db
      .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(owner.owner_id, userId)
      .first<{ role: string }>();

    return membership !== null;
  }

  return false;
}

/**
 * Get the display slug for an owner (username or org name).
 */
export async function getOwnerSlug(
  db: D1Database,
  owner: OwnerRef,
): Promise<string> {
  if (owner.owner_type === "user") {
    const user = await db
      .prepare("SELECT username FROM users WHERE id = ?")
      .bind(owner.owner_id)
      .first<{ username: string }>();
    return user?.username ?? "unknown";
  }

  if (owner.owner_type === "org") {
    const org = await db
      .prepare("SELECT name FROM orgs WHERE id = ?")
      .bind(owner.owner_id)
      .first<{ name: string }>();
    return org?.name ?? "unknown";
  }

  return "system";
}

/**
 * Ensure a user scope exists. Auto-creates if missing.
 * Called during auth/login flows.
 *
 * Returns false if the scope is owned by a different entity (e.g., an org),
 * meaning the user won't be able to publish to @username.
 */
export async function ensureUserScope(
  db: D1Database,
  userId: string,
  username: string,
): Promise<boolean> {
  const existing = await db
    .prepare("SELECT owner_type, owner_id FROM scopes WHERE name = ?")
    .bind(username)
    .first<{ owner_type: string; owner_id: string }>();

  if (existing) {
    // Already owned by this user — OK
    if (existing.owner_type === "user" && existing.owner_id === userId) return true;
    // Owned by someone else (org or another user) — conflict
    return false;
  }

  await db
    .prepare(
      "INSERT OR IGNORE INTO scopes (name, owner_type, owner_id) VALUES (?, 'user', ?)",
    )
    .bind(username, userId)
    .run();
  return true;
}

/**
 * Get the owner info for a package's scope, including avatar_url for display.
 */
export async function getOwnerProfile(
  db: D1Database,
  ownerType: OwnerType,
  ownerId: string,
): Promise<{ slug: string; kind: OwnerType; avatar_url: string }> {
  if (ownerType === "user") {
    const user = await db
      .prepare("SELECT username, avatar_url FROM users WHERE id = ?")
      .bind(ownerId)
      .first<{ username: string; avatar_url: string }>();
    return { slug: user?.username ?? "unknown", kind: "user", avatar_url: user?.avatar_url ?? "" };
  }

  if (ownerType === "org") {
    const org = await db
      .prepare("SELECT name FROM orgs WHERE id = ?")
      .bind(ownerId)
      .first<{ name: string }>();
    return { slug: org?.name ?? "unknown", kind: "org", avatar_url: "" };
  }

  return { slug: "system", kind: "system", avatar_url: "" };
}

/**
 * Resolve a slug to its owner (user or org).
 * Tries users first, then orgs.
 */
export async function resolveOwnerBySlug(
  db: D1Database,
  slug: string,
): Promise<{ owner_type: OwnerType; owner_id: string } | null> {
  const userRow = await db
    .prepare("SELECT id FROM users WHERE username = ?")
    .bind(slug)
    .first<{ id: string }>();

  if (userRow) {
    return { owner_type: "user", owner_id: userRow.id };
  }

  const orgRow = await db
    .prepare("SELECT id FROM orgs WHERE name = ?")
    .bind(slug)
    .first<{ id: string }>();

  if (orgRow) {
    return { owner_type: "org", owner_id: orgRow.id };
  }

  return null;
}

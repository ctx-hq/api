import { isValidScope } from "../utils/naming";
import { createPackageAlias, createScopeAlias, flattenPackageAliasChains, flattenScopeAliasChains } from "./redirect";

const RENAME_COOLDOWN_DAYS = 30;

/**
 * Check if an entity was renamed within the cooldown period (30 days).
 * Returns true if the cooldown is still active (rename should be blocked).
 */
export async function checkRenameCooldown(
  db: D1Database,
  table: "orgs" | "users",
  entityId: string,
): Promise<boolean> {
  const sql = table === "orgs"
    ? "SELECT renamed_at FROM orgs WHERE id = ? AND renamed_at > datetime('now', '-30 days')"
    : "SELECT renamed_at FROM users WHERE id = ? AND renamed_at > datetime('now', '-30 days')";

  const result = await db
    .prepare(sql)
    .bind(entityId)
    .first<{ renamed_at: string }>();

  return result !== null;
}

/**
 * Validate that a new name is available as a scope (not taken by existing scopes, orgs, users, or aliases).
 */
export async function isNameAvailable(
  db: D1Database,
  newName: string,
): Promise<{ available: boolean; reason?: string }> {
  if (!isValidScope(newName)) {
    return { available: false, reason: "Invalid name (lowercase, alphanumeric, hyphens)" };
  }

  // Check scopes table
  const existingScope = await db
    .prepare("SELECT name FROM scopes WHERE name = ?")
    .bind(newName)
    .first();
  if (existingScope) {
    return { available: false, reason: `Scope @${newName} is already taken` };
  }

  // Check scope_aliases (someone renamed away from this name — it's reserved for redirect)
  const existingAlias = await db
    .prepare("SELECT old_scope FROM scope_aliases WHERE old_scope = ?")
    .bind(newName)
    .first();
  if (existingAlias) {
    return { available: false, reason: `Name @${newName} is reserved (redirect alias)` };
  }

  // Check slug_aliases for @newName/* patterns
  const existingPkgAlias = await db
    .prepare("SELECT old_full_name FROM slug_aliases WHERE old_full_name LIKE ?")
    .bind(`@${newName}/%`)
    .first();
  if (existingPkgAlias) {
    return { available: false, reason: `Name @${newName} conflicts with existing package alias` };
  }

  return { available: true };
}

/**
 * Rename a package (name portion only, within the same scope).
 * Creates a slug_alias for the old name, updates search_digest.
 */
export async function renamePackage(
  db: D1Database,
  packageId: string,
  newName: string,
): Promise<{ oldFullName: string; newFullName: string }> {
  const pkg = await db
    .prepare("SELECT id, scope, name, full_name FROM packages WHERE id = ?")
    .bind(packageId)
    .first<{ id: string; scope: string; name: string; full_name: string }>();

  if (!pkg) throw new Error("Package not found");

  const oldFullName = pkg.full_name;
  const newFullName = `@${pkg.scope}/${newName}`;

  // Check new name is not taken within the scope
  const existing = await db
    .prepare("SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL")
    .bind(newFullName)
    .first();
  if (existing) throw new Error(`Package ${newFullName} already exists`);

  // Check alias doesn't conflict
  const aliasConflict = await db
    .prepare("SELECT old_full_name FROM slug_aliases WHERE old_full_name = ?")
    .bind(newFullName)
    .first();
  if (aliasConflict) throw new Error(`Name ${newFullName} is reserved (redirect alias)`);

  // Flatten existing chains pointing to oldFullName before creating new alias
  await flattenPackageAliasChains(db, oldFullName, newFullName);

  await db.batch([
    // Update package
    db.prepare(
      "UPDATE packages SET name = ?, full_name = ?, updated_at = datetime('now') WHERE id = ?",
    ).bind(newName, newFullName, packageId),

    // Create alias
    db.prepare(
      "INSERT OR REPLACE INTO slug_aliases (old_full_name, new_full_name) VALUES (?, ?)",
    ).bind(oldFullName, newFullName),

    // Update search_digest
    db.prepare(
      "UPDATE search_digest SET full_name = ?, updated_at = datetime('now') WHERE package_id = ?",
    ).bind(newFullName, packageId),
  ]);

  return { oldFullName, newFullName };
}

/**
 * Rename an organization. Cascades to: scope, all packages.
 * Creates scope_alias + slug_aliases for all affected packages.
 */
export async function renameOrg(
  db: D1Database,
  orgId: string,
  newName: string,
): Promise<{ oldName: string; newName: string; packagesUpdated: number }> {
  const org = await db
    .prepare("SELECT id, name FROM orgs WHERE id = ?")
    .bind(orgId)
    .first<{ id: string; name: string }>();

  if (!org) throw new Error("Organization not found");

  const oldName = org.name;

  // Get all non-deleted packages in this org
  const packages = await db
    .prepare("SELECT id, name, full_name FROM packages WHERE scope = ? AND deleted_at IS NULL")
    .bind(oldName)
    .all<{ id: string; name: string; full_name: string }>();

  const pkgs = packages.results ?? [];

  // Flatten existing scope alias chains
  await flattenScopeAliasChains(db, oldName, newName);

  // Build batch statements
  const stmts: D1PreparedStatement[] = [
    // Update org name + set renamed_at
    db.prepare(
      "UPDATE orgs SET name = ?, renamed_at = datetime('now') WHERE id = ?",
    ).bind(newName, orgId),

    // Update scope name
    db.prepare(
      "UPDATE scopes SET name = ? WHERE name = ?",
    ).bind(newName, oldName),

    // Create scope alias
    db.prepare(
      "INSERT OR REPLACE INTO scope_aliases (old_scope, new_scope) VALUES (?, ?)",
    ).bind(oldName, newName),
  ];

  // For each package: create alias + update full_name + update search_digest
  for (const pkg of pkgs) {
    const newFullName = `@${newName}/${pkg.name}`;
    const oldFullName = pkg.full_name;

    stmts.push(
      db.prepare(
        "INSERT OR REPLACE INTO slug_aliases (old_full_name, new_full_name) VALUES (?, ?)",
      ).bind(oldFullName, newFullName),
    );

    stmts.push(
      db.prepare(
        "UPDATE packages SET scope = ?, full_name = ?, updated_at = datetime('now') WHERE id = ?",
      ).bind(newName, newFullName, pkg.id),
    );

    stmts.push(
      db.prepare(
        "UPDATE search_digest SET full_name = ?, owner_slug = ?, updated_at = datetime('now') WHERE package_id = ?",
      ).bind(newFullName, newName, pkg.id),
    );
  }

  // Flatten existing package alias chains for all packages in this org
  for (const pkg of pkgs) {
    stmts.push(
      db.prepare(
        "UPDATE slug_aliases SET new_full_name = ? WHERE new_full_name = ?",
      ).bind(`@${newName}/${pkg.name}`, pkg.full_name),
    );
  }

  // D1 batch limit is ~100 statements; chunk if needed
  const BATCH_SIZE = 90;
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE));
  }

  return { oldName, newName, packagesUpdated: pkgs.length };
}

/**
 * Rename a user. Cascades to: scope, all personal packages.
 */
export async function renameUser(
  db: D1Database,
  userId: string,
  newUsername: string,
): Promise<{ oldUsername: string; newUsername: string; packagesUpdated: number }> {
  const user = await db
    .prepare("SELECT id, username FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; username: string }>();

  if (!user) throw new Error("User not found");

  const oldUsername = user.username;

  // Get personal packages
  const packages = await db
    .prepare("SELECT id, name, full_name FROM packages WHERE scope = ? AND deleted_at IS NULL")
    .bind(oldUsername)
    .all<{ id: string; name: string; full_name: string }>();

  const pkgs = packages.results ?? [];

  // Flatten existing scope alias chains
  await flattenScopeAliasChains(db, oldUsername, newUsername);

  const stmts: D1PreparedStatement[] = [
    // Update username + set renamed_at
    db.prepare(
      "UPDATE users SET username = ?, renamed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    ).bind(newUsername, userId),

    // Update scope
    db.prepare(
      "UPDATE scopes SET name = ? WHERE owner_type = 'user' AND owner_id = ?",
    ).bind(newUsername, userId),

    // Create scope alias
    db.prepare(
      "INSERT OR REPLACE INTO scope_aliases (old_scope, new_scope) VALUES (?, ?)",
    ).bind(oldUsername, newUsername),
  ];

  for (const pkg of pkgs) {
    const newFullName = `@${newUsername}/${pkg.name}`;

    stmts.push(
      db.prepare(
        "INSERT OR REPLACE INTO slug_aliases (old_full_name, new_full_name) VALUES (?, ?)",
      ).bind(pkg.full_name, newFullName),
    );

    stmts.push(
      db.prepare(
        "UPDATE packages SET scope = ?, full_name = ?, updated_at = datetime('now') WHERE id = ?",
      ).bind(newUsername, newFullName, pkg.id),
    );

    stmts.push(
      db.prepare(
        "UPDATE search_digest SET full_name = ?, owner_slug = ?, updated_at = datetime('now') WHERE package_id = ?",
      ).bind(newFullName, newUsername, pkg.id),
    );
  }

  // Flatten package alias chains
  for (const pkg of pkgs) {
    stmts.push(
      db.prepare(
        "UPDATE slug_aliases SET new_full_name = ? WHERE new_full_name = ?",
      ).bind(`@${newUsername}/${pkg.name}`, pkg.full_name),
    );
  }

  const BATCH_SIZE = 90;
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE));
  }

  return { oldUsername, newUsername, packagesUpdated: pkgs.length };
}

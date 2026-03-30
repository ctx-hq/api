/**
 * Redirect service: resolve slug aliases for packages and scopes.
 * Handles permanent redirects after rename/transfer operations.
 */

/**
 * Resolve a package full_name through slug_aliases.
 * Returns the canonical name, or the input if no alias exists.
 */
export async function resolvePackageName(
  db: D1Database,
  fullName: string,
): Promise<string> {
  const alias = await db
    .prepare("SELECT new_full_name FROM slug_aliases WHERE old_full_name = ?")
    .bind(fullName)
    .first<{ new_full_name: string }>();

  return alias?.new_full_name ?? fullName;
}

/**
 * Resolve a scope name through scope_aliases.
 * Returns the canonical scope, or the input if no alias exists.
 */
export async function resolveScope(
  db: D1Database,
  scopeName: string,
): Promise<string> {
  const alias = await db
    .prepare("SELECT new_scope FROM scope_aliases WHERE old_scope = ?")
    .bind(scopeName)
    .first<{ new_scope: string }>();

  return alias?.new_scope ?? scopeName;
}

/**
 * Flatten alias chains: when renaming B→C, update any existing A→B to A→C.
 * This ensures aliases always point to the current canonical name, never forming chains.
 */
export async function flattenPackageAliasChains(
  db: D1Database,
  oldName: string,
  newName: string,
): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE slug_aliases SET new_full_name = ? WHERE new_full_name = ?",
    )
    .bind(newName, oldName)
    .run();

  return result.meta?.changes ?? 0;
}

/**
 * Flatten scope alias chains: when renaming scope B→C, update A→B to A→C.
 */
export async function flattenScopeAliasChains(
  db: D1Database,
  oldScope: string,
  newScope: string,
): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE scope_aliases SET new_scope = ? WHERE new_scope = ?",
    )
    .bind(newScope, oldScope)
    .run();

  return result.meta?.changes ?? 0;
}

/**
 * Create a package alias (old_full_name → new_full_name).
 * Uses INSERT OR REPLACE to handle re-rename of same old name.
 */
export async function createPackageAlias(
  db: D1Database,
  oldFullName: string,
  newFullName: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR REPLACE INTO slug_aliases (old_full_name, new_full_name) VALUES (?, ?)",
    )
    .bind(oldFullName, newFullName)
    .run();
}

/**
 * Create a scope alias (old_scope → new_scope).
 * Uses INSERT OR REPLACE to handle re-rename of same old scope.
 */
export async function createScopeAlias(
  db: D1Database,
  oldScope: string,
  newScope: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR REPLACE INTO scope_aliases (old_scope, new_scope) VALUES (?, ?)",
    )
    .bind(oldScope, newScope)
    .run();
}

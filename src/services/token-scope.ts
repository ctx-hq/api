/**
 * Token scope enforcement.
 *
 * Endpoint scopes control which API actions a token can perform.
 * Package scopes control which packages a token can act on.
 *
 * Modeled after crates.io RFC #2947 (crate + endpoint scopes).
 */

export const VALID_ENDPOINT_SCOPES = [
  "publish",
  "yank",
  "read-private",
  "manage-access",
  "manage-org",
] as const;

export type EndpointScope = (typeof VALID_ENDPOINT_SCOPES)[number];

/**
 * Check if a list of endpoint scopes includes the required scope.
 * ["*"] means all scopes.
 */
export function hasEndpointScope(
  scopes: string[],
  required: EndpointScope,
): boolean {
  return scopes.includes("*") || scopes.includes(required);
}

/**
 * Check if a package full name matches any of the package scope patterns.
 * ["*"] means all packages.
 *
 * Supported patterns:
 *   "*"           — matches everything
 *   "@scope/*"    — matches all packages in @scope
 *   "@scope/name" — exact match
 *   "prefix*"     — prefix wildcard
 */
export function matchesPackageScope(
  scopes: string[],
  fullName: string,
): boolean {
  if (scopes.includes("*")) return true;

  return scopes.some((pattern) => {
    // Exact match
    if (pattern === fullName) return true;

    // Trailing wildcard: "@scope/*" or "prefix*"
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      // "@scope/*" should match "@scope/foo" but not "@scope" itself
      if (pattern.endsWith("/*")) {
        return fullName.startsWith(prefix);
      }
      // "prefix*" matches "prefix-anything"
      return fullName.startsWith(prefix);
    }

    return false;
  });
}

/**
 * Validate that all endpoint scopes are valid.
 * Returns the first invalid scope, or null if all valid.
 */
export function validateEndpointScopes(scopes: string[]): string | null {
  for (const scope of scopes) {
    if (scope === "*") continue;
    if (!VALID_ENDPOINT_SCOPES.includes(scope as EndpointScope)) {
      return scope;
    }
  }
  return null;
}

/**
 * Validate package scope patterns.
 * Must be "*", an exact "@scope/name", or a glob ending with "*".
 * Returns the first invalid pattern, or null if all valid.
 */
export function validatePackageScopes(scopes: string[]): string | null {
  for (const pattern of scopes) {
    if (pattern === "*") continue;
    // Must start with @ for scoped packages or be a simple name/glob
    if (pattern.includes("/") && !pattern.startsWith("@")) {
      return pattern;
    }
    // Wildcard must be at the end
    const starIdx = pattern.indexOf("*");
    if (starIdx !== -1 && starIdx !== pattern.length - 1) {
      return pattern;
    }
  }
  return null;
}

/**
 * Parse JSON scope string from DB into string array.
 * - null/undefined → ["*"] (legacy tokens with no scope column)
 * - Valid JSON array of strings → parsed value
 * - Corrupt/invalid → [] (fail-closed: no permissions)
 */
export function parseScopes(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return ["*"];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed;
    }
  } catch {
    // fall through
  }
  // Fail closed: corrupt data grants no permissions
  return [];
}

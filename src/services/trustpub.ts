/**
 * Trusted publishing (GitHub Actions OIDC) service.
 *
 * Allows packages to be published from GitHub Actions without storing
 * API tokens as secrets. The CI runner exchanges a GitHub-issued OIDC
 * JWT for a short-lived ctx API token scoped to the matched package.
 */

export interface OIDCClaims {
  repository: string;        // "owner/repo"
  repository_owner: string;  // "owner"
  workflow_ref: string;      // "owner/repo/.github/workflows/release.yml@refs/tags/v1.0.0"
  job_workflow_ref: string;  // similar
  environment: string;       // "production" or ""
  iss: string;               // "https://token.actions.githubusercontent.com"
  aud: string;               // audience
  exp: number;               // expiration (unix seconds)
}

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_AUDIENCE = "https://getctx.org";
const JWKS_URI = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const JWKS_CACHE_TTL_MS = 3600_000; // 1 hour

interface JWKWithKid extends JsonWebKey {
  kid?: string;
}

let cachedJWKS: { keys: JWKWithKid[]; fetchedAt: number } | null = null;

async function fetchJWKS(): Promise<JWKWithKid[]> {
  if (cachedJWKS && Date.now() - cachedJWKS.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cachedJWKS.keys;
  }
  const resp = await fetch(JWKS_URI);
  if (!resp.ok) {
    throw new Error(`Failed to fetch JWKS: ${resp.status}`);
  }
  const data = (await resp.json()) as { keys: JWKWithKid[] };
  cachedJWKS = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

function base64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Verify and decode a GitHub Actions OIDC JWT with full RS256 signature validation.
 */
export async function verifyOIDCToken(jwt: string): Promise<OIDCClaims | null> {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;

    // Decode header to get kid
    const headerJson = new TextDecoder().decode(base64urlDecode(parts[0]));
    const header = JSON.parse(headerJson) as { alg: string; kid?: string };
    if (header.alg !== "RS256") return null;

    // Decode payload
    const payloadJson = new TextDecoder().decode(base64urlDecode(parts[1]));
    const claims = JSON.parse(payloadJson) as Record<string, unknown>;

    // Validate required fields and issuer before doing crypto
    if (
      typeof claims.repository !== "string" ||
      typeof claims.repository_owner !== "string" ||
      typeof claims.iss !== "string" ||
      typeof claims.exp !== "number"
    ) {
      return null;
    }
    if (claims.iss !== GITHUB_OIDC_ISSUER) return null;

    // Validate audience
    const aud = claims.aud;
    if (typeof aud === "string") {
      if (aud !== EXPECTED_AUDIENCE) return null;
    } else if (Array.isArray(aud)) {
      if (!aud.includes(EXPECTED_AUDIENCE)) return null;
    } else {
      return null;
    }

    // Validate expiration inside verification (defense-in-depth)
    const nowSec = Math.floor(Date.now() / 1000);
    if (claims.exp <= nowSec) return null;

    // Fetch JWKS and find the matching key
    const keys = await fetchJWKS();
    const jwk = header.kid
      ? keys.find((k) => k.kid === header.kid)
      : keys[0];
    if (!jwk) return null;

    // Import the public key and verify signature
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64urlDecode(parts[2]);

    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
    if (!valid) return null;

    return {
      repository: claims.repository as string,
      repository_owner: claims.repository_owner as string,
      workflow_ref: (claims.workflow_ref as string) ?? "",
      job_workflow_ref: (claims.job_workflow_ref as string) ?? "",
      environment: (claims.environment as string) ?? "",
      iss: claims.iss as string,
      aud: (claims.aud as string) ?? "",
      exp: claims.exp as number,
    };
  } catch {
    return null;
  }
}

/**
 * Extract the workflow filename from a workflow_ref string.
 * Example: "owner/repo/.github/workflows/release.yml@refs/tags/v1.0.0" → "release.yml"
 */
export function extractWorkflow(workflowRef: string): string {
  // Remove the @ref suffix first
  const withoutRef = workflowRef.split("@")[0];
  // Get the last path segment (filename)
  const segments = withoutRef.split("/");
  return segments[segments.length - 1];
}

/**
 * Check whether OIDC claims match a trusted publisher configuration.
 */
export function matchesTrustedPublisher(
  claims: OIDCClaims,
  config: { github_repo: string; workflow: string; environment: string | null },
): boolean {
  // Repository must match exactly (case-insensitive)
  if (claims.repository.toLowerCase() !== config.github_repo.toLowerCase()) {
    return false;
  }

  // Workflow must match the filename extracted from workflow_ref
  const claimWorkflow = extractWorkflow(claims.workflow_ref);
  if (claimWorkflow.toLowerCase() !== config.workflow.toLowerCase()) {
    return false;
  }

  // If config requires a specific environment, claims must match
  if (config.environment && config.environment !== "") {
    if (!claims.environment || claims.environment.toLowerCase() !== config.environment.toLowerCase()) {
      return false;
    }
  }

  return true;
}

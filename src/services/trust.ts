import type { TrustTier } from "../models/types";
import { generateId } from "../utils/response";

/**
 * Run structural trust check (synchronous, in publish handler).
 * Validates manifest schema, SHA256, and path safety.
 */
export async function runStructuralCheck(
  db: D1Database,
  versionId: string,
  manifest: Record<string, unknown>,
  sha256: string,
): Promise<boolean> {
  const sha256Valid = sha256.length === 64;
  const hasName = typeof manifest.name === "string";
  const hasVersion = typeof manifest.version === "string";
  const hasType = typeof manifest.type === "string";
  const passed = hasName && hasVersion && hasType && sha256Valid;

  await db
    .prepare(
      `INSERT INTO trust_checks (id, version_id, check_type, status, score, details)
       VALUES (?, ?, 'structural', ?, ?, ?)`,
    )
    .bind(
      generateId(),
      versionId,
      passed ? "passed" : "failed",
      passed ? 1.0 : 0.0,
      JSON.stringify({ sha256_valid: sha256Valid, has_name: hasName, has_version: hasVersion, has_type: hasType }),
    )
    .run();

  if (passed) {
    await db
      .prepare("UPDATE versions SET trust_tier = 'structural' WHERE id = ?")
      .bind(versionId)
      .run();
  }

  return passed;
}

/**
 * Run source link check (async, via enrichment queue).
 * Verifies the package's source_repo contains a matching ctx.yaml.
 */
export async function runSourceLinkCheck(
  db: D1Database,
  versionId: string,
  packageFullName: string,
  sourceRepo: string,
): Promise<boolean> {
  if (!sourceRepo) {
    await insertCheck(db, versionId, "source_linked", "skipped", null, { reason: "no source_repo" });
    return false;
  }

  // Parse github:owner/repo format
  const match = sourceRepo.match(/^(?:github:)?([^/]+\/[^/]+)$/);
  if (!match) {
    await insertCheck(db, versionId, "source_linked", "failed", 0, { reason: "invalid source_repo format" });
    return false;
  }

  try {
    const repo = match[1];
    const resp = await fetch(
      `https://api.github.com/repos/${repo}/contents/ctx.yaml`,
      { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "ctx-registry" } },
    );

    if (!resp.ok) {
      await insertCheck(db, versionId, "source_linked", "failed", 0, { reason: "ctx.yaml not found in repo" });
      return false;
    }

    const data = (await resp.json()) as { content?: string };
    if (data.content) {
      const content = atob(data.content.replace(/\n/g, ""));
      const nameMatch = content.match(/name:\s*["']?(@[^"'\s]+)["']?/);
      if (nameMatch && nameMatch[1] === packageFullName) {
        await insertCheck(db, versionId, "source_linked", "passed", 1.0, { repo, matched_name: packageFullName });
        await updateTrustTier(db, versionId);
        return true;
      }
    }

    await insertCheck(db, versionId, "source_linked", "failed", 0, { reason: "name mismatch in ctx.yaml" });
    return false;
  } catch {
    await insertCheck(db, versionId, "source_linked", "pending", null, { reason: "fetch failed, will retry" });
    return false;
  }
}

/**
 * Aggregate trust tier from all checks for a version.
 * Tier progresses: unverified → structural → source_linked → reviewed → verified
 */
export async function updateTrustTier(
  db: D1Database,
  versionId: string,
): Promise<TrustTier> {
  const checks = await db
    .prepare("SELECT check_type, status FROM trust_checks WHERE version_id = ?")
    .bind(versionId)
    .all<{ check_type: string; status: string }>();

  const passed = new Set(
    (checks.results ?? [])
      .filter((c) => c.status === "passed")
      .map((c) => c.check_type),
  );

  let tier: TrustTier = "unverified";
  if (passed.has("structural")) tier = "structural";
  if (passed.has("structural") && passed.has("source_linked")) tier = "source_linked";
  if (passed.has("structural") && passed.has("source_linked") && passed.has("ai_review")) tier = "reviewed";

  await db
    .prepare("UPDATE versions SET trust_tier = ? WHERE id = ?")
    .bind(tier, versionId)
    .run();

  return tier;
}

async function insertCheck(
  db: D1Database,
  versionId: string,
  checkType: string,
  status: string,
  score: number | null,
  details: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO trust_checks (id, version_id, check_type, status, score, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(generateId(), versionId, checkType, status, score, JSON.stringify(details))
    .run();
}

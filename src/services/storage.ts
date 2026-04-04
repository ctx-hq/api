import type { Bindings } from "../bindings";
import { R2_MIGRATION_CONCURRENCY } from "../utils/constants";

/**
 * Returns the R2 bucket for a given package visibility.
 * SSOT: D1 `packages.visibility` determines bucket; this function derives the mapping.
 *
 * - "private" → PRIVATE_FORMULAS (isolated from CDN/mirrors)
 * - "public" / "unlisted" → FORMULAS (CDN-friendly, mirrorable)
 */
export function getFormulaBucket(env: Bindings, visibility: string): R2Bucket {
  return visibility === "private" ? env.PRIVATE_FORMULAS : env.FORMULAS;
}

/**
 * Migrates R2 objects between buckets when package visibility changes.
 * Uses two-phase approach for atomicity:
 *   Phase 1: copy + verify all keys (source untouched)
 *   Phase 2a (all succeed): delete from source
 *   Phase 2b (any fail): rollback — delete copied keys from dest
 *
 * Returns list of keys that failed migration (empty = full success).
 */
export async function migrateArchives(
  source: R2Bucket,
  dest: R2Bucket,
  keys: string[],
): Promise<string[]> {
  const failures: string[] = [];
  const copied: string[] = [];

  // Phase 1: Copy all keys to dest and verify (do NOT delete from source)
  for (let i = 0; i < keys.length; i += R2_MIGRATION_CONCURRENCY) {
    const batch = keys.slice(i, i + R2_MIGRATION_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(key => copyAndVerify(source, dest, key)),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "rejected" || (r.status === "fulfilled" && !r.value)) {
        failures.push(batch[j]);
      } else {
        copied.push(batch[j]);
      }
    }
  }

  // Phase 2b: Any failures → rollback all successful copies from dest
  if (failures.length > 0) {
    if (copied.length > 0) {
      await deleteKeys(dest, copied);
    }
    return failures;
  }

  // Phase 2a: All succeeded → delete from source (with bounded concurrency)
  const deleteFailures = await deleteKeys(source, copied);
  return deleteFailures;
}

/** Delete keys from a bucket with bounded concurrency. Returns keys that failed to delete. */
async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<string[]> {
  const failures: string[] = [];
  for (let i = 0; i < keys.length; i += R2_MIGRATION_CONCURRENCY) {
    const batch = keys.slice(i, i + R2_MIGRATION_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(key => bucket.delete(key)),
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === "rejected") {
        failures.push(batch[j]);
      }
    }
  }
  return failures;
}

/** Copy a single key from source to dest and verify. Does NOT delete from source. */
async function copyAndVerify(source: R2Bucket, dest: R2Bucket, key: string): Promise<boolean> {
  const obj = await source.get(key);
  if (!obj) return true; // already gone — skip

  const body = await obj.arrayBuffer();
  await dest.put(key, body);

  const check = await dest.head(key);
  return !!check;
}

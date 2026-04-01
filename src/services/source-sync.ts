import type { Bindings } from "../bindings";
import type { SourceSyncRow } from "../models/types";
import { generateId } from "../utils/response";
import { githubHeaders } from "./importer";

const GITHUB_API = "https://api.github.com";

/**
 * Sync source-linked packages by checking upstream GitHub repos for changes.
 * Returns the number of packages that were updated.
 */
export async function syncSourceLinkedPackages(
  env: Bindings
): Promise<{ checked: number; synced: number; errors: number }> {
  const rows = await env.DB.prepare(
    "SELECT * FROM source_sync WHERE enabled = 1 ORDER BY last_synced ASC LIMIT 50"
  ).all();

  let checked = 0;
  let synced = 0;
  let errors = 0;

  for (const row of rows.results ?? []) {
    const sync = row as unknown as SourceSyncRow;
    checked++;

    try {
      const updated = await checkAndSync(env, sync);
      if (updated) synced++;
    } catch (err) {
      console.error(`Source sync error for ${sync.github_repo}/${sync.path}:`, err);
      errors++;

      // Increment error count; disable after 10 consecutive errors
      const newErrors = sync.sync_errors + 1;
      if (newErrors >= 10) {
        await env.DB.prepare(
          "UPDATE source_sync SET sync_errors = ?, enabled = 0 WHERE id = ?"
        ).bind(newErrors, sync.id).run();
      } else {
        await env.DB.prepare(
          "UPDATE source_sync SET sync_errors = ? WHERE id = ?"
        ).bind(newErrors, sync.id).run();
      }
    }
  }

  return { checked, synced, errors };
}

async function checkAndSync(env: Bindings, sync: SourceSyncRow): Promise<boolean> {
  // Check for new commits on the upstream path
  const url = `${GITHUB_API}/repos/${sync.github_repo}/commits?path=${encodeURIComponent(sync.path)}&sha=${sync.ref}&per_page=1`;
  const resp = await fetch(url, { headers: githubHeaders() });

  if (!resp.ok) {
    throw new Error(`GitHub API returned ${resp.status}`);
  }

  const commits = (await resp.json()) as { sha: string }[];
  if (!commits.length) return false;

  const latestSha = commits[0].sha;
  if (latestSha === sync.last_commit) {
    // No changes — update last_synced timestamp
    await env.DB.prepare(
      "UPDATE source_sync SET last_synced = datetime('now'), sync_errors = 0 WHERE id = ?"
    ).bind(sync.id).run();
    return false;
  }

  // New commit detected — enqueue for re-import and update tracking
  await env.DB.prepare(
    "UPDATE source_sync SET last_commit = ?, last_synced = datetime('now'), sync_errors = 0 WHERE id = ?"
  ).bind(latestSha, sync.id).run();

  // Queue enrichment to re-fetch and update the package content
  const pkg = await env.DB.prepare(
    "SELECT full_name FROM packages WHERE id = ?"
  ).bind(sync.package_id).first<{ full_name: string }>();
  if (pkg && env.ENRICHMENT_QUEUE) {
    await env.ENRICHMENT_QUEUE.send({
      type: "source_sync",
      package_id: sync.package_id,
      full_name: pkg.full_name,
      github_repo: sync.github_repo,
      path: sync.path,
      ref: sync.ref,
      commit: latestSha,
    });
  }

  return true;
}

/**
 * Create or update a source_sync entry for a package.
 */
export async function upsertSourceSync(
  db: D1Database,
  packageId: string,
  githubRepo: string,
  path: string,
  ref: string = "main"
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_sync (id, package_id, github_repo, path, ref)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (package_id) DO UPDATE SET
         github_repo = excluded.github_repo,
         path = excluded.path,
         ref = excluded.ref`
    )
    .bind(generateId(), packageId, githubRepo, path, ref)
    .run();
}

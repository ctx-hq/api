import type { Bindings } from "../bindings";
import { parseSemVer, compareSemVer } from "../utils/semver";

export async function getPackageByName(db: D1Database, fullName: string) {
  return db.prepare("SELECT * FROM packages WHERE full_name = ?").bind(fullName).first();
}

export async function getLatestVersion(db: D1Database, packageId: string) {
  const result = await db.prepare(
    "SELECT version, manifest FROM versions WHERE package_id = ? AND yanked = 0"
  ).bind(packageId).all();

  const rows = result.results ?? [];
  if (rows.length === 0) return null;

  let latest = rows[0] as Record<string, unknown>;
  let latestSv = parseSemVer(latest.version as string);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    const sv = parseSemVer(row.version as string);
    if (sv && (!latestSv || compareSemVer(sv, latestSv) > 0)) {
      latest = row;
      latestSv = sv;
    }
  }

  return latest;
}

export async function incrementDownloads(db: D1Database, packageId: string) {
  return db.prepare(
    "UPDATE packages SET downloads = downloads + 1 WHERE id = ?"
  ).bind(packageId).run();
}

import type { Bindings } from "../bindings";

export type SearchMode = "fts" | "vector" | "hybrid";

export interface SearchOptions {
  query: string;
  mode: SearchMode;
  type?: string;
  limit: number;
}

interface SearchResult {
  full_name: string;
  type: string;
  description: string;
  summary: string;
  version: string;
  downloads: number;
  trust_tier: string;
  publisher_slug: string;
}

interface RankedItem {
  id: string;
  full_name: string;
}

// Reciprocal Rank Fusion constant.
const RRF_K = 60;

function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

// Merge two ranked lists using Reciprocal Rank Fusion.
export function mergeRRF(
  ftsResults: RankedItem[],
  vectorResults: RankedItem[]
): string[] {
  const scores = new Map<string, number>();

  for (let i = 0; i < ftsResults.length; i++) {
    const id = ftsResults[i].id;
    scores.set(id, (scores.get(id) ?? 0) + rrfScore(i + 1));
  }

  for (let i = 0; i < vectorResults.length; i++) {
    const id = vectorResults[i].id;
    scores.set(id, (scores.get(id) ?? 0) + rrfScore(i + 1));
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

// FTS5 keyword search.
async function searchFTS(
  db: D1Database,
  query: string,
  type: string | undefined,
  limit: number
): Promise<RankedItem[]> {
  const sanitized = '"' + query.replace(/"/g, '""') + '"';
  let sql = `
    SELECT sd.package_id as id, sd.full_name
    FROM packages_fts f
    JOIN search_digest sd ON sd.rowid = f.rowid
    WHERE packages_fts MATCH ?
  `;
  const params: unknown[] = [sanitized];

  if (type) {
    sql += " AND sd.type = ?";
    params.push(type);
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

  const result = await db.prepare(sql).bind(...params).all();
  return (result.results ?? []).map((r) => ({
    id: r.id as string,
    full_name: r.full_name as string,
  }));
}

// Vectorize semantic search. Returns empty on failure (graceful degradation).
async function searchVector(
  env: Bindings,
  query: string,
  type: string | undefined,
  limit: number
): Promise<RankedItem[]> {
  try {
    const embResult = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
      text: [query],
    }) as { data?: number[][] };

    if (!embResult.data?.[0]) return [];

    const vectorResult = await env.VECTORIZE.query(embResult.data[0], {
      topK: limit * 2,
      returnMetadata: "all",
    });

    if (!vectorResult.matches) return [];

    // Deduplicate by package_id (multiple chunks per package)
    const seen = new Set<string>();
    const results: RankedItem[] = [];

    for (const match of vectorResult.matches) {
      const packageId = match.metadata?.package_id as string;
      const fullName = match.metadata?.full_name as string;
      if (!packageId || seen.has(packageId)) continue;
      seen.add(packageId);
      results.push({ id: packageId, full_name: fullName });
    }

    if (type && results.length > 0) {
      const ids = results.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      const typeFiltered = await env.DB.prepare(
        `SELECT id FROM packages WHERE id IN (${placeholders}) AND type = ? AND visibility = 'public' AND deleted_at IS NULL`
      ).bind(...ids, type).all();

      const validIds = new Set((typeFiltered.results ?? []).map((r) => r.id as string));
      return results.filter((r) => validIds.has(r.id)).slice(0, limit);
    }

    return results.slice(0, limit);
  } catch (err) {
    console.error("Vector search failed, falling back:", err);
    return [];
  }
}

// Hydrate package IDs into full search results, preserving order.
async function hydrateResults(
  db: D1Database,
  packageIds: string[],
  limit: number
): Promise<SearchResult[]> {
  if (packageIds.length === 0) return [];

  const ids = packageIds.slice(0, limit);
  const placeholders = ids.map(() => "?").join(",");

  // Use search_digest for fast hydration (only contains public packages)
  const digestResult = await db.prepare(
    `SELECT package_id, full_name, type, description, summary, latest_version,
            downloads, trust_tier, publisher_slug
     FROM search_digest WHERE package_id IN (${placeholders})`
  ).bind(...ids).all();

  const digestMap = new Map<string, Record<string, unknown>>();
  for (const row of digestResult.results ?? []) {
    digestMap.set(row.package_id as string, row);
  }

  const results: SearchResult[] = [];
  for (const id of ids) {
    const sd = digestMap.get(id);
    if (!sd) continue;

    results.push({
      full_name: sd.full_name as string,
      type: sd.type as string,
      description: sd.description as string,
      summary: (sd.summary as string) || "",
      version: (sd.latest_version as string) ?? "",
      downloads: sd.downloads as number,
      trust_tier: (sd.trust_tier as string) ?? "unverified",
      publisher_slug: (sd.publisher_slug as string) ?? "",
    });
  }

  return results;
}

// Main search entry point with hybrid FTS5 + Vectorize + RRF fusion.
export async function searchPackages(
  env: Bindings,
  opts: SearchOptions
): Promise<{ packages: SearchResult[]; total: number }> {
  const { query, mode, type, limit } = opts;

  let packageIds: string[];

  if (mode === "fts") {
    const fts = await searchFTS(env.DB, query, type, limit);
    packageIds = fts.map((r) => r.id);
  } else if (mode === "vector") {
    const vec = await searchVector(env, query, type, limit);
    packageIds = vec.map((r) => r.id);
  } else {
    // Hybrid: FTS5 + Vectorize in parallel, merge with RRF
    const [fts, vec] = await Promise.all([
      searchFTS(env.DB, query, type, limit),
      Promise.race([
        searchVector(env, query, type, limit),
        new Promise<RankedItem[]>((resolve) =>
          setTimeout(() => resolve([]), 2000) // 2s timeout for graceful degradation
        ),
      ]),
    ]);

    if (vec.length === 0) {
      packageIds = fts.map((r) => r.id);
    } else {
      packageIds = mergeRRF(fts, vec);
    }
  }

  const packages = await hydrateResults(env.DB, packageIds, limit);
  return { packages, total: packages.length };
}

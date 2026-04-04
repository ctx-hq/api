import { isValidFullName, parseFullName } from "../utils/naming";
import { isValidSemVer, parseSemVer, compareSemVer } from "../utils/semver";
import { generateId } from "../utils/response";
import { badRequest } from "../utils/errors";
import { mapToMCPCategory } from "./categories";

export interface PublishInput {
  manifest: Record<string, unknown>;
  manifestText: string;
  archiveData: ArrayBuffer | null;
  userId: string;
}

export interface PublishValidation {
  valid: boolean;
  errors: string[];
  parsed?: {
    fullName: string;
    scope: string;
    name: string;
    version: string;
    type: string;
    description: string;
  };
}

export function validatePublishInput(input: PublishInput): PublishValidation {
  const errors: string[] = [];
  const m = input.manifest;

  const fullName = m.name as string;
  const version = m.version as string;
  const type_ = m.type as string;
  const description = (m.description as string) ?? "";

  if (!fullName || !isValidFullName(fullName)) {
    errors.push(`Invalid package name: ${fullName}`);
  }
  if (!version || !isValidSemVer(version)) {
    errors.push(`Invalid version: ${version}`);
  }
  if (!["skill", "mcp", "cli", "collection"].includes(type_)) {
    errors.push(`Invalid type: ${type_}`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const parsed = parseFullName(fullName)!;
  return {
    valid: true,
    errors: [],
    parsed: {
      fullName,
      scope: parsed.scope,
      name: parsed.name,
      version,
      type: type_,
      description,
    },
  };
}

async function insertSkillMetadata(
  db: D1Database,
  versionId: string,
  skill: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO skill_metadata (version_id, entry, compatibility, user_invocable, tags, origin)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      versionId,
      (skill.entry as string) ?? "",
      (skill.compatibility as string) ?? "",
      skill.user_invocable !== false ? 1 : 0,
      JSON.stringify(skill.tags ?? []),
      (skill.origin as string) ?? "",
    )
    .run();
}

export interface ExtractMetadataResult {
  unresolved_members?: string[];
}

/**
 * Extract type-specific metadata from manifest and insert into metadata tables.
 */
export async function extractTypeMetadata(
  db: D1Database,
  versionId: string,
  manifest: Record<string, unknown>,
  packageId?: string,
): Promise<ExtractMetadataResult> {
  const type_ = manifest.type as string;
  const result: ExtractMetadataResult = {};

  if (type_ === "skill") {
    const skill = (manifest.skill ?? {}) as Record<string, unknown>;
    await insertSkillMetadata(db, versionId, skill);
  }

  if (type_ === "mcp") {
    const mcp = (manifest.mcp ?? {}) as Record<string, unknown>;
    const keywords = Array.isArray(manifest.keywords) ? manifest.keywords as string[] : [];
    const description = (manifest.description as string) ?? "";
    const category = mapToMCPCategory(keywords, description);
    await db
      .prepare(
        `INSERT OR REPLACE INTO mcp_metadata (version_id, transport, command, args, url, env_vars, tools, resources, category, transports, require_bins, hooks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        (mcp.transport as string) ?? "stdio",
        (mcp.command as string) ?? "",
        JSON.stringify(mcp.args ?? []),
        (mcp.url as string) ?? "",
        JSON.stringify(mcp.env ?? []),
        JSON.stringify(mcp.tools ?? []),
        JSON.stringify(mcp.resources ?? []),
        category,
        JSON.stringify(Array.isArray(mcp.transports) ? mcp.transports : []),
        JSON.stringify(
          (typeof mcp.require === "object" && mcp.require !== null)
            ? (mcp.require as Record<string, unknown>).bins ?? []
            : [],
        ),
        JSON.stringify(
          (typeof mcp.hooks === "object" && mcp.hooks !== null)
            ? (mcp.hooks as Record<string, unknown>).post_install ?? []
            : [],
        ),
      )
      .run();

    // Upsert upstream tracking if upstream section present
    const upstream = manifest.upstream as Record<string, unknown> | undefined;
    if (upstream?.tracking && packageId) {
      const trackingKey = (upstream.npm as string) ?? (upstream.github as string) ?? (upstream.docker as string) ?? "";
      await db
        .prepare(
          `INSERT OR REPLACE INTO upstream_tracking (package_id, tracking_type, tracking_key)
           VALUES (?, ?, ?)`,
        )
        .bind(packageId, upstream.tracking as string, trackingKey)
        .run();
    }
  }

  if (type_ === "cli") {
    const cli = (manifest.cli ?? {}) as Record<string, unknown>;
    const require_ = (cli.require ?? {}) as Record<string, unknown>;
    await db
      .prepare(
        `INSERT OR REPLACE INTO cli_metadata (version_id, binary, verify, compatible, require_bins, require_env, auth)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        (cli.binary as string) ?? "",
        (cli.verify as string) ?? "",
        (cli.compatible as string) ?? "",
        JSON.stringify(require_.bins ?? []),
        JSON.stringify(require_.env ?? []),
        (cli.auth as string) ?? "",
      )
      .run();

    // CLI packages can bundle a skill section (Skill-Native CLI pattern)
    if (manifest.skill) {
      const skill = manifest.skill as Record<string, unknown>;
      await insertSkillMetadata(db, versionId, skill);
    }
  }

  // Collection metadata: populate collection_members table
  if (type_ === "collection") {
    const collection = (manifest.collection ?? {}) as Record<string, unknown>;
    const rawMembers = collection.members;
    if (rawMembers !== undefined && (!Array.isArray(rawMembers) || !rawMembers.every((m) => typeof m === "string"))) {
      throw badRequest("collection.members must be an array of strings");
    }
    const members = (rawMembers ?? []) as string[];
    if (members.length > 100) {
      throw badRequest("Collection cannot have more than 100 members");
    }
    if (members.length > 0) {
      // Look up package_id for this version's package
      const version = await db
        .prepare("SELECT package_id FROM versions WHERE id = ?")
        .bind(versionId)
        .first<{ package_id: string }>();
      if (version) {
        // Clear existing members for this collection
        await db
          .prepare("DELETE FROM collection_members WHERE collection_id = ?")
          .bind(version.package_id)
          .run();

        // Batch-resolve member package IDs
        const placeholders = members.map(() => "?").join(", ");
        const memberPkgs = await db
          .prepare(
            `SELECT id, full_name FROM packages WHERE full_name IN (${placeholders}) AND deleted_at IS NULL`
          )
          .bind(...members)
          .all<{ id: string; full_name: string }>();

        const nameToId = new Map(
          (memberPkgs.results ?? []).map((r) => [r.full_name, r.id])
        );

        // Track unresolved members for caller feedback
        const unresolved = members.filter((name) => !nameToId.has(name));
        if (unresolved.length > 0) {
          result.unresolved_members = unresolved;
          console.warn(`Collection publish: unresolved members: ${unresolved.join(", ")}`);
        }

        // Batch-insert all resolved members
        const insertStmts = members
          .map((name, i) => {
            const memberId = nameToId.get(name);
            if (!memberId) return null;
            return db
              .prepare(
                `INSERT OR IGNORE INTO collection_members (id, collection_id, member_id, display_order)
                 VALUES (?, ?, ?, ?)`
              )
              .bind(generateId(), version.package_id, memberId, i);
          })
          .filter((s): s is D1PreparedStatement => s !== null);

        if (insertStmts.length > 0) {
          await db.batch(insertStmts);
        }
      }
    }
  }

  // Install metadata (all types can have install spec)
  const install = (manifest.install ?? {}) as Record<string, unknown>;
  if (Object.keys(install).length > 0) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO install_metadata (version_id, source, brew, npm, pip, gem, cargo, script, platforms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        (install.source as string) ?? "",
        (install.brew as string) ?? "",
        (install.npm as string) ?? "",
        (install.pip as string) ?? "",
        (install.gem as string) ?? "",
        (install.cargo as string) ?? "",
        (install.script as string) ?? "",
        JSON.stringify(install.platforms ?? {}),
      )
      .run();
  }

  return result;
}

/**
 * Auto-set dist-tag based on version string.
 * Non-prerelease → 'latest' only if >= current latest; prerelease → tag from identifier.
 */
export async function autoDistTag(
  db: D1Database,
  packageId: string,
  versionId: string,
  version: string,
): Promise<Record<string, string>> {
  const tags: Record<string, string> = {};
  const prereleaseMatch = version.match(/-([a-zA-Z]+)/);

  if (prereleaseMatch) {
    // e.g., 2.0.0-beta.1 → tag "beta"
    const tag = prereleaseMatch[1].toLowerCase();
    await upsertDistTag(db, packageId, versionId, tag);
    tags[tag] = version;
  } else {
    // Non-prerelease: only set 'latest' if this version >= current latest
    const currentLatest = await db
      .prepare(
        `SELECT v.version FROM dist_tags dt JOIN versions v ON dt.version_id = v.id
         WHERE dt.package_id = ? AND dt.tag = 'latest'`,
      )
      .bind(packageId)
      .first<{ version: string }>();

    let shouldSetLatest = true;
    if (currentLatest) {
      const current = parseSemVer(currentLatest.version);
      const incoming = parseSemVer(version);
      if (current && incoming && compareSemVer(incoming, current) < 0) {
        shouldSetLatest = false;
      }
    }

    if (shouldSetLatest) {
      await upsertDistTag(db, packageId, versionId, "latest");
      tags["latest"] = version;
    }
  }

  return tags;
}

async function upsertDistTag(
  db: D1Database,
  packageId: string,
  versionId: string,
  tag: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dist_tags (id, package_id, tag, version_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (package_id, tag) DO UPDATE SET version_id = excluded.version_id, updated_at = datetime('now')`,
    )
    .bind(generateId(), packageId, tag, versionId)
    .run();
}

/**
 * Upsert search_digest for a package (public/unlisted only).
 */
export async function upsertSearchDigest(
  db: D1Database,
  packageId: string,
  fullName: string,
  type_: string,
  description: string,
  summary: string,
  keywords: string,
  capabilities: string,
  latestVersion: string,
  downloads: number,
  ownerSlug: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO search_digest
       (package_id, full_name, type, description, summary, keywords, capabilities,
        latest_version, downloads, owner_slug, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(
      packageId, fullName, type_, description, summary,
      keywords, capabilities, latestVersion, downloads, ownerSlug,
    )
    .run();
}

/**
 * Sync keywords from manifest to normalized keywords + package_keywords tables.
 * Idempotent: deletes old mappings, inserts new ones, recalculates usage_count.
 */
export async function syncKeywords(
  db: D1Database,
  packageId: string,
  keywords: string[],
): Promise<void> {
  // Normalize and validate keywords.
  // Pre-filter env:/bin: prefixed keywords before normalization (they're runtime
  // requirements, not discovery tags — generated by OpenClaw conversion).
  const slugs = [...new Set(
    keywords
      .filter((k) => !/^(env|bin):/i.test(k.trim()))
      .map((k) => k.trim().toLowerCase().replace(/[^a-z0-9-]/g, ""))
      .filter((s) => s.length > 0 && s.length <= 50),
  )].slice(0, 20);

  // If no keywords, clear old mappings and recalculate counts
  if (slugs.length === 0) {
    const oldKeywords = await db.prepare(
      "SELECT keyword_id FROM package_keywords WHERE package_id = ?"
    ).bind(packageId).all();
    const oldKeywordIds = (oldKeywords.results ?? []).map((r) => r.keyword_id as string);
    await db.prepare("DELETE FROM package_keywords WHERE package_id = ?").bind(packageId).run();
    if (oldKeywordIds.length > 0) {
      const countStmts = oldKeywordIds.map((kwId) =>
        db.prepare(
          "UPDATE keywords SET usage_count = (SELECT COUNT(*) FROM package_keywords WHERE keyword_id = ?) WHERE id = ?"
        ).bind(kwId, kwId),
      );
      await db.batch(countStmts);
    }
    return;
  }

  // Batch upsert keywords
  const upsertStmts = slugs.map((slug) =>
    db.prepare(
      "INSERT OR IGNORE INTO keywords (id, slug, usage_count) VALUES (?, ?, 0)"
    ).bind(generateId(), slug),
  );
  await db.batch(upsertStmts);

  // Get affected keyword IDs (old) for usage_count recalculation
  const oldKeywords = await db.prepare(
    "SELECT keyword_id FROM package_keywords WHERE package_id = ?"
  ).bind(packageId).all();
  const oldKeywordIds = (oldKeywords.results ?? []).map((r) => r.keyword_id as string);

  // Delete old package_keywords entries
  await db.prepare(
    "DELETE FROM package_keywords WHERE package_id = ?"
  ).bind(packageId).run();

  // Look up new keyword IDs
  const placeholders = slugs.map(() => "?").join(",");
  const keywordRows = await db.prepare(
    `SELECT id, slug FROM keywords WHERE slug IN (${placeholders})`
  ).bind(...slugs).all();

  const slugToId = new Map<string, string>();
  for (const row of keywordRows.results ?? []) {
    slugToId.set(row.slug as string, row.id as string);
  }

  // Batch insert new package_keywords
  const insertStmts = slugs
    .map((slug) => {
      const kwId = slugToId.get(slug);
      if (!kwId) return null;
      return db.prepare(
        "INSERT OR IGNORE INTO package_keywords (package_id, keyword_id) VALUES (?, ?)"
      ).bind(packageId, kwId);
    })
    .filter((s): s is D1PreparedStatement => s !== null);

  if (insertStmts.length > 0) {
    await db.batch(insertStmts);
  }

  // Batch recalculate usage_count for all affected keywords
  const allKeywordIds = new Set([...oldKeywordIds, ...[...slugToId.values()]]);
  const countStmts = [...allKeywordIds].map((kwId) =>
    db.prepare(
      "UPDATE keywords SET usage_count = (SELECT COUNT(*) FROM package_keywords WHERE keyword_id = ?) WHERE id = ?"
    ).bind(kwId, kwId),
  );
  if (countStmts.length > 0) {
    await db.batch(countStmts);
  }
}

export async function computeSHA256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

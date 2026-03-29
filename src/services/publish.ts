import { isValidFullName, parseFullName } from "../utils/naming";
import { isValidSemVer, parseSemVer, compareSemVer } from "../utils/semver";
import { generateId } from "../utils/response";

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
  if (!["skill", "mcp", "cli"].includes(type_)) {
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

/**
 * Extract type-specific metadata from manifest and insert into metadata tables.
 */
export async function extractTypeMetadata(
  db: D1Database,
  versionId: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const type_ = manifest.type as string;

  if (type_ === "skill") {
    const skill = (manifest.skill ?? {}) as Record<string, unknown>;
    await db
      .prepare(
        `INSERT OR REPLACE INTO skill_metadata (version_id, entry, compatibility, user_invocable, tags)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        (skill.entry as string) ?? "",
        (skill.compatibility as string) ?? "",
        skill.user_invocable !== false ? 1 : 0,
        JSON.stringify(skill.tags ?? []),
      )
      .run();
  }

  if (type_ === "mcp") {
    const mcp = (manifest.mcp ?? {}) as Record<string, unknown>;
    await db
      .prepare(
        `INSERT OR REPLACE INTO mcp_metadata (version_id, transport, command, args, url, env_vars, tools, resources)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      .run();
  }

  if (type_ === "cli") {
    const cli = (manifest.cli ?? {}) as Record<string, unknown>;
    const require_ = (cli.require ?? {}) as Record<string, unknown>;
    await db
      .prepare(
        `INSERT OR REPLACE INTO cli_metadata (version_id, binary, verify, compatible, require_bins, require_env)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        (cli.binary as string) ?? "",
        (cli.verify as string) ?? "",
        (cli.compatible as string) ?? "",
        JSON.stringify(require_.bins ?? []),
        JSON.stringify(require_.env ?? []),
      )
      .run();
  }

  // Install metadata (all types can have install spec)
  const install = (manifest.install ?? {}) as Record<string, unknown>;
  if (Object.keys(install).length > 0) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO install_metadata (version_id, source, brew, npm, pip, cargo, platforms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        (install.source as string) ?? "",
        (install.brew as string) ?? "",
        (install.npm as string) ?? "",
        (install.pip as string) ?? "",
        (install.cargo as string) ?? "",
        JSON.stringify(install.platforms ?? {}),
      )
      .run();
  }
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
  publisherSlug: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO search_digest
       (package_id, full_name, type, description, summary, keywords, capabilities,
        latest_version, downloads, publisher_slug, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(
      packageId, fullName, type_, description, summary,
      keywords, capabilities, latestVersion, downloads, publisherSlug,
    )
    .run();
}

export async function computeSHA256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

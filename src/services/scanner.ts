import type { Bindings } from "../bindings";
import { generateId } from "../utils/response";
import { importGitHubTopics, importGitHubSkills, importGitHubMonorepos, importMCPRegistry, importHomebrewPopular } from "./importer";
import { upsertSourceSync } from "./source-sync";

export interface ScannerSource {
  id: string;
  type: string;
  source_key: string;
  last_scanned: string | null;
  cursor_state: string;
  total_found: number;
  enabled: number;
}

export interface ScannerCandidate {
  id: string;
  source_id: string;
  external_id: string;
  external_url: string;
  detected_type: string;
  detected_name: string;
  generated_manifest: string | null;
  status: string;
  confidence: number;
  stars: number;
  license: string;
}

// Default scanner sources seeded on first run.
const DEFAULT_SOURCES = [
  { type: "github_topic", source_key: "github:topic:mcp-server" },
  { type: "github_topic", source_key: "github:topic:claude-skill" },
  { type: "github_topic", source_key: "github:topic:llm-tool" },
  { type: "github_search", source_key: "github:file:SKILL.md" },
  { type: "github_monorepo", source_key: "github:monorepo:skill-collection" },
  { type: "mcp_registry", source_key: "mcp:registry:official" },
  { type: "homebrew", source_key: "brew:popular:cli" },
];

// Run the full scanner pipeline.
export async function runScanner(env: Bindings): Promise<{ scanned: number; found: number }> {
  // Ensure default sources exist
  await seedSources(env);

  const sources = await env.DB.prepare(
    "SELECT * FROM scanner_sources WHERE enabled = 1"
  ).all();

  let totalFound = 0;

  for (const row of sources.results ?? []) {
    const source = row as unknown as ScannerSource;
    try {
      const candidates = await scanSource(env, source);
      totalFound += candidates.length;

      // Upsert candidates
      for (const candidate of candidates) {
        await upsertCandidate(env, source.id, candidate);
      }

      // Update source state
      await env.DB.prepare(
        "UPDATE scanner_sources SET last_scanned = datetime('now'), total_found = ? WHERE id = ?"
      ).bind(source.total_found + candidates.length, source.id).run();

    } catch (err) {
      console.error(`Scanner error for ${source.source_key}:`, err);
    }
  }

  // Auto-approve high-confidence candidates
  await autoApprove(env);

  return { scanned: sources.results?.length ?? 0, found: totalFound };
}

async function scanSource(env: Bindings, source: ScannerSource): Promise<RawCandidate[]> {
  switch (source.type) {
    case "github_topic":
      return importGitHubTopics(source.source_key, source.cursor_state);
    case "github_search":
      return importGitHubSkills(source.source_key, source.cursor_state);
    case "mcp_registry":
      return importMCPRegistry(source.cursor_state);
    case "github_monorepo":
      return importGitHubMonorepos(source.source_key, source.cursor_state);
    case "homebrew":
      return importHomebrewPopular(source.cursor_state);
    default:
      console.warn(`Unknown source type: ${source.type}`);
      return [];
  }
}

async function upsertCandidate(env: Bindings, sourceId: string, candidate: RawCandidate) {
  const existing = await env.DB.prepare(
    "SELECT id FROM scanner_candidates WHERE source_id = ? AND external_id = ?"
  ).bind(sourceId, candidate.external_id).first();

  if (existing) {
    // Update if changed
    await env.DB.prepare(
      `UPDATE scanner_candidates SET
        external_url = ?, detected_type = ?, detected_name = ?,
        generated_manifest = ?, confidence = ?, stars = ?, license = ?,
        last_checked = datetime('now')
      WHERE id = ?`
    ).bind(
      candidate.external_url, candidate.detected_type, candidate.detected_name,
      candidate.generated_manifest, candidate.confidence, candidate.stars,
      candidate.license, existing.id
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO scanner_candidates
        (id, source_id, external_id, external_url, detected_type, detected_name, generated_manifest, status, confidence, stars, license)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).bind(
      generateId(), sourceId, candidate.external_id, candidate.external_url,
      candidate.detected_type, candidate.detected_name, candidate.generated_manifest,
      candidate.confidence, candidate.stars, candidate.license
    ).run();
  }
}

import { SYSTEM_OWNER_ID } from "../models/types";
const SYSTEM_SCANNER_USER_ID = SYSTEM_OWNER_ID;

async function autoApprove(env: Bindings) {
  // Auto-approve candidates with confidence > 0.9 and a known license
  const candidates = await env.DB.prepare(
    `SELECT * FROM scanner_candidates
     WHERE status = 'pending' AND confidence >= 0.9 AND license != ''`
  ).all();

  for (const row of candidates.results ?? []) {
    const c = row as unknown as ScannerCandidate;
    if (!c.generated_manifest) continue;

    // Import as @community/ package using system scanner user
    await importAsPackage(env, c, SYSTEM_SCANNER_USER_ID);

    await env.DB.prepare(
      "UPDATE scanner_candidates SET status = 'imported' WHERE id = ?"
    ).bind(c.id).run();
  }
}

// Public entry point for manual approve from route handler
export async function importCandidate(env: Bindings, candidate: ScannerCandidate, ownerId: string) {
  await importAsPackage(env, candidate, ownerId);
}

async function importAsPackage(env: Bindings, candidate: ScannerCandidate, ownerId: string) {
  if (!candidate.generated_manifest) return;

  const manifest = JSON.parse(candidate.generated_manifest);
  const fullName = manifest.name as string;
  if (!fullName) return;

  // Check if package already exists
  const existing = await env.DB.prepare(
    "SELECT id FROM packages WHERE full_name = ?"
  ).bind(fullName).first();

  if (existing) return; // Already imported

  // Ensure @community scope
  const scope = "community";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO scopes (name, owner_type, owner_id) VALUES (?, 'system', ?)"
  ).bind(scope, ownerId).run();

  const pkgId = generateId();
  await env.DB.prepare(
    `INSERT INTO packages (id, scope, name, full_name, type, description, repository, license, keywords, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    pkgId, scope, candidate.detected_name, fullName,
    candidate.detected_type, manifest.description ?? "",
    candidate.external_url, candidate.license,
    JSON.stringify(manifest.keywords ?? []), ownerId
  ).run();

  // Create initial version
  const version = manifest.version ?? "0.0.1";
  await env.DB.prepare(
    `INSERT INTO versions (id, package_id, version, manifest, published_by)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(generateId(), pkgId, version, candidate.generated_manifest, ownerId).run();

  // Set up source sync tracking if manifest has source info
  const source = manifest.source as { github?: string; path?: string; ref?: string } | undefined;
  if (source?.github) {
    await upsertSourceSync(env.DB, pkgId, source.github, source.path ?? "", source.ref ?? "main");
  }
}

async function seedSources(env: Bindings) {
  for (const source of DEFAULT_SOURCES) {
    // Use deterministic ID based on source_key to avoid generating new IDs on every run
    const data = new TextEncoder().encode(source.source_key);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const id = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO scanner_sources (id, type, source_key) VALUES (?, ?, ?)"
    ).bind(id, source.type, source.source_key).run();
  }
}

// Raw candidate from importers
export interface RawCandidate {
  external_id: string;
  external_url: string;
  detected_type: "skill" | "mcp" | "cli";
  detected_name: string;
  generated_manifest: string | null;
  confidence: number;
  stars: number;
  license: string;
}

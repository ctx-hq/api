// Shared types for the ctx registry API

export type PackageType = "skill" | "mcp" | "cli";

export type EnrichmentStatus = "pending" | "queued" | "enriched" | "failed";

export interface PackageRow {
  id: string;
  scope: string;
  name: string;
  full_name: string;
  type: PackageType;
  description: string;
  summary: string;
  capabilities: string; // JSON array
  repository: string;
  homepage: string;
  author: string;
  author_url: string;
  license: string;
  keywords: string; // JSON array
  platforms: string; // JSON array
  owner_id: string;
  downloads: number;
  enrichment_status: EnrichmentStatus;
  enriched_at: string | null;
  vectorized_at: string | null;
  content_hash: string;
  import_source: string;
  import_external_id: string;
  created_at: string;
  updated_at: string;
}

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  parent_slug: string | null;
  display_order: number;
  created_at: string;
}

export interface VectorChunkRow {
  id: string;
  package_id: string;
  chunk_index: number;
  chunk_text: string;
  content_hash: string;
  vectorized_at: string;
}

export type EnrichmentMessageType = "vectorize" | "enrich" | "vectorize_and_enrich";

export interface EnrichmentMessage {
  type: EnrichmentMessageType;
  packageId: string;
}

export interface VersionRow {
  id: string;
  package_id: string;
  version: string;
  manifest: string;
  readme: string;
  formula_key: string;
  sha256: string;
  yanked: number;
  published_by: string;
  created_at: string;
}

export interface UserRow {
  id: string;
  username: string;
  email: string;
  avatar_url: string;
  github_id: string;
  role: "user" | "admin";
  created_at: string;
  updated_at: string;
}

export interface OrgRow {
  id: string;
  name: string;
  display_name: string;
  created_by: string;
  created_at: string;
}

export interface ScannerCandidateRow {
  id: string;
  source_id: string;
  external_id: string;
  external_url: string;
  detected_type: PackageType;
  detected_name: string;
  generated_manifest: string | null;
  status: "pending" | "approved" | "rejected" | "imported";
  confidence: number;
  stars: number;
  license: string;
  last_checked: string;
}

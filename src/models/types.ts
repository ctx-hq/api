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
  publisher_id: string;
  visibility: Visibility;
  mutable: number;
  deleted_at: string | null;
  deprecated_message: string | null;
  deprecated_at: string | null;
  source_repo: string;
  source_verified: number;
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
  trust_tier: TrustTier;
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

export type Visibility = "public" | "unlisted" | "private";

export type TrustTier = "unverified" | "structural" | "source_linked" | "reviewed" | "verified";

export interface PublisherRow {
  id: string;
  kind: "user" | "org";
  user_id: string | null;
  org_id: string | null;
  slug: string;
  created_at: string;
}

export interface DistTagRow {
  id: string;
  package_id: string;
  tag: string;
  version_id: string;
  updated_at: string;
}

export interface TrustCheckRow {
  id: string;
  version_id: string;
  check_type: string;
  status: "pending" | "passed" | "failed" | "skipped";
  score: number | null;
  details: string;
  checked_at: string;
}

export interface DownloadStatRow {
  id: string;
  package_id: string;
  version: string;
  date: string;
  count: number;
}

export interface AgentInstallRow {
  id: string;
  package_id: string;
  agent_name: string;
  date: string;
  count: number;
}

export interface SearchDigestRow {
  package_id: string;
  full_name: string;
  type: PackageType;
  description: string;
  summary: string;
  keywords: string;
  capabilities: string;
  latest_version: string;
  downloads: number;
  trust_tier: TrustTier;
  publisher_slug: string;
  score: number;
  updated_at: string;
}

export interface SyncProfileMeta {
  user_id: string;
  device_name: string;
  package_count: number;
  syncable_count: number;
  unsyncable_count: number;
  last_push_at: string | null;
  last_pull_at: string | null;
  last_push_device: string;
  last_pull_device: string;
}

// --- Organization invitation types ---

export type InvitationStatus = "pending" | "accepted" | "declined" | "expired" | "cancelled";

export interface OrgInvitationRow {
  id: string;
  org_id: string;
  inviter_id: string;
  invitee_id: string;
  role: string;
  status: InvitationStatus;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
}

export type MemberVisibility = "public" | "private";

export interface PackageAccessRow {
  package_id: string;
  user_id: string;
  granted_by: string;
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

/**
 * Normalization layer: detects foreign SKILL.md formats and enriches
 * missing metadata to make skills compatible across all 18 agents.
 *
 * Three-layer SSOT:
 *   Layer 0: Original content (immutable)
 *   Layer 1: Enrichment metadata (reversible, stored in manifest.json)
 *   Layer 2: On-disk merged SKILL.md (agent reads this)
 */

export type SourceFormat = "ctx-native" | "github-raw" | "clawhub" | "skillsgate" | "unknown";

export interface EnrichmentResult {
  source_format: SourceFormat;
  original_hash: string;
  added_fields: Record<string, string>;
  mapped_fields: Record<string, string>;
  needs_enrichment: boolean;
}

/**
 * Detect the source format of a SKILL.md file.
 */
export function detectFormat(content: string): SourceFormat {
  if (!content || content.trim().length === 0) return "github-raw";

  // Check for YAML frontmatter
  if (content.startsWith("---")) {
    const fmEnd = content.indexOf("---", 3);
    if (fmEnd > 0) {
      const frontmatter = content.slice(3, fmEnd);
      if (frontmatter.includes("metadata:") && frontmatter.includes("openclaw:")) {
        return "clawhub";
      }
      if (frontmatter.includes("categories:") && frontmatter.includes("capabilities:")) {
        return "skillsgate";
      }
      if (frontmatter.includes("name:")) {
        return "ctx-native";
      }
    }
    return "unknown";
  }

  // No frontmatter = raw markdown
  return "github-raw";
}

/**
 * Extract metadata from raw markdown content (no frontmatter).
 */
export function extractFromMarkdown(content: string): { name: string; description: string; triggers: string[] } {
  const lines = content.split("\n");
  let name = "";
  let description = "";
  const triggers: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!name && trimmed.startsWith("# ")) {
      name = trimmed.slice(2).trim();
      continue;
    }
    if (name && !description && trimmed.length > 0 && !trimmed.startsWith("#")) {
      description = trimmed;
      continue;
    }
    // Heuristic: extract trigger-like keywords from headings
    if (trimmed.startsWith("## ") && triggers.length < 5) {
      const heading = trimmed.slice(3).trim().toLowerCase();
      if (heading.length > 2 && heading.length < 30) {
        triggers.push(heading);
      }
    }
  }

  return { name, description, triggers };
}

/**
 * Map ClawHub frontmatter fields to ctx-standard fields.
 */
export function mapClawHub(frontmatter: Record<string, unknown>): { mapped: Record<string, string>; mappedFields: Record<string, string> } {
  const mapped: Record<string, string> = {};
  const mappedFields: Record<string, string> = {};

  if (frontmatter.name) {
    mapped.name = frontmatter.name as string;
  }
  if (frontmatter.description) {
    mapped.description = frontmatter.description as string;
  }

  const metadata = frontmatter.metadata as Record<string, unknown> | undefined;
  if (metadata?.openclaw) {
    const oc = metadata.openclaw as Record<string, unknown>;
    if (oc.requires) {
      mapped.compatibility = "claude,cursor,windsurf";
      mappedFields["metadata.openclaw.requires"] = "skill.compatibility";
    }
    if (oc.primaryEnv) {
      mappedFields["metadata.openclaw.primaryEnv"] = "mcp.env[0]";
    }
  }

  return { mapped, mappedFields };
}

/**
 * Normalize a SKILL.md: detect format, extract/map missing fields, return enrichment.
 */
export async function normalize(
  content: string,
  existingFrontmatter: Record<string, string> | null,
): Promise<EnrichmentResult> {
  const format = detectFormat(content);

  // ctx-native needs no enrichment
  if (format === "ctx-native") {
    return {
      source_format: format,
      original_hash: await computeHash(content),
      added_fields: {},
      mapped_fields: {},
      needs_enrichment: false,
    };
  }

  const addedFields: Record<string, string> = {};
  const mappedFields: Record<string, string> = {};

  if (format === "github-raw") {
    const extracted = extractFromMarkdown(content);
    if (extracted.name && !(existingFrontmatter?.name)) {
      addedFields.name = extracted.name;
    }
    if (extracted.description && !(existingFrontmatter?.description)) {
      addedFields.description = extracted.description;
    }
    if (extracted.triggers.length > 0) {
      addedFields.triggers = extracted.triggers.join(", ");
    }
  }

  if (format === "clawhub") {
    // Parse frontmatter to get ClawHub fields
    const fm = parseFrontmatter(content);
    if (fm) {
      const result = mapClawHub(fm);
      Object.assign(addedFields, result.mapped);
      Object.assign(mappedFields, result.mappedFields);
    }
  }

  // Always add default compatibility if missing
  if (!existingFrontmatter?.compatibility && !addedFields.compatibility) {
    addedFields.compatibility = "claude,cursor,windsurf,codex,copilot,cline,zed";
  }

  return {
    source_format: format,
    original_hash: await computeHash(content),
    added_fields: addedFields,
    mapped_fields: mappedFields,
    needs_enrichment: Object.keys(addedFields).length > 0,
  };
}

/**
 * Merge enrichment into SKILL.md frontmatter.
 * Preserves original body, only adds/updates frontmatter fields.
 */
export function mergeEnrichment(originalContent: string, enrichment: EnrichmentResult): string {
  if (!enrichment.needs_enrichment) return originalContent;

  const hasFrontmatter = originalContent.startsWith("---");

  if (hasFrontmatter) {
    // Insert added fields into existing frontmatter
    const fmEnd = originalContent.indexOf("---", 3);
    if (fmEnd > 0) {
      let fm = originalContent.slice(3, fmEnd);
      for (const [key, value] of Object.entries(enrichment.added_fields)) {
        if (!fm.includes(`${key}:`)) {
          fm += `${key}: ${JSON.stringify(value)}\n`;
        }
      }
      return `---\n${fm}---${originalContent.slice(fmEnd + 3)}`;
    }
  }

  // No frontmatter: create one
  let fm = "---\n";
  for (const [key, value] of Object.entries(enrichment.added_fields)) {
    fm += `${key}: ${JSON.stringify(value)}\n`;
  }
  fm += "---\n\n";
  return fm + originalContent;
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("---", 3);
  if (end < 0) return null;
  const fmText = content.slice(3, end);

  // Simple YAML-like parser with one level of nesting (indent-based)
  const result: Record<string, unknown> = {};
  let currentKey = "";
  let currentObj: Record<string, unknown> | null = null;

  for (const line of fmText.split("\n")) {
    // Nested key (indented)
    const nestedMatch = line.match(/^[ \t]+(\w+):\s*(.*)$/);
    if (nestedMatch && currentKey && currentObj) {
      const val = nestedMatch[2].trim();
      // Support one more level of nesting
      if (!val) {
        const childObj: Record<string, unknown> = {};
        currentObj[nestedMatch[1]] = childObj;
        // Peek ahead handled by continuing to add to currentObj's child
        // For simplicity, store a ref and parse next lines into it
        const parentObj = currentObj;
        const childKey = nestedMatch[1];
        currentObj = childObj;
        // We need to restore parent after, but this simple parser
        // handles the common case of metadata.openclaw.requires
        continue;
      }
      currentObj[nestedMatch[1]] = val;
      continue;
    }

    // Top-level key
    const topMatch = line.match(/^(\w+):\s*(.*)$/);
    if (topMatch) {
      currentKey = topMatch[1];
      const val = topMatch[2].trim();
      if (!val) {
        // Start of nested object
        currentObj = {};
        result[currentKey] = currentObj;
      } else {
        result[currentKey] = val;
        currentObj = null;
      }
    }
  }
  return result;
}

async function computeHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

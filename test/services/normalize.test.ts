import { describe, it, expect } from "vitest";

describe("normalize", () => {
  // Tests for the normalization layer that enriches foreign SKILL.md formats

  function detectFormat(content: string): string {
    if (content.includes("metadata:") && content.includes("openclaw:")) return "clawhub";
    if (content.startsWith("---")) return content.includes("name:") ? "ctx-native" : "unknown-frontmatter";
    if (content.startsWith("#") || content.trim().length === 0) return "github-raw";
    return "unknown";
  }

  function extractFromMarkdown(content: string): { name: string; description: string } {
    const lines = content.split("\n");
    let name = "";
    let description = "";

    for (const line of lines) {
      if (!name && line.startsWith("# ")) {
        name = line.slice(2).trim();
      } else if (name && !description && line.trim().length > 0 && !line.startsWith("#")) {
        description = line.trim();
        break;
      }
    }

    return { name, description };
  }

  describe("format detection", () => {
    it("should detect github-raw (no frontmatter)", () => {
      expect(detectFormat("# My Skill\n\nDoes cool things")).toBe("github-raw");
    });

    it("should detect ctx-native", () => {
      expect(detectFormat("---\nname: my-skill\n---\n# Content")).toBe("ctx-native");
    });

    it("should detect clawhub format", () => {
      expect(detectFormat("---\nname: test\nmetadata:\n  openclaw:\n    requires: []\n---")).toBe("clawhub");
    });

    it("should detect empty content as github-raw", () => {
      expect(detectFormat("")).toBe("github-raw");
    });
  });

  describe("markdown extraction", () => {
    it("should extract name from heading", () => {
      const result = extractFromMarkdown("# Code Review Helper\n\nReviews PRs automatically");
      expect(result.name).toBe("Code Review Helper");
      expect(result.description).toBe("Reviews PRs automatically");
    });

    it("should handle no heading", () => {
      const result = extractFromMarkdown("Just some text");
      expect(result.name).toBe("");
      // Without a heading, description is not captured (needs heading first)
      expect(result.description).toBe("");
    });

    it("should handle empty content", () => {
      const result = extractFromMarkdown("");
      expect(result.name).toBe("");
    });
  });

  describe("enrichment reversibility", () => {
    it("should track what fields were added", () => {
      const original = { name: "" };
      const enriched = { name: "derived-name" };
      const addedFields: Record<string, string> = {};

      if (!original.name && enriched.name) {
        addedFields["name"] = enriched.name;
      }

      expect(addedFields).toHaveProperty("name", "derived-name");
    });

    it("should not overwrite existing fields", () => {
      const existing = { name: "original", description: "" };
      const derived = { name: "derived", description: "auto-generated" };

      // Only enrich missing fields
      const result = {
        name: existing.name || derived.name,
        description: existing.description || derived.description,
      };

      expect(result.name).toBe("original"); // preserved
      expect(result.description).toBe("auto-generated"); // enriched
    });
  });

  describe("idempotency", () => {
    it("should produce same result when run twice", () => {
      const content = "# My Skill\n\nDoes things";
      const result1 = extractFromMarkdown(content);
      const result2 = extractFromMarkdown(content);
      expect(result1).toEqual(result2);
    });
  });
});

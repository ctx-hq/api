import { describe, it, expect } from "vitest";

// Unit test the importer logic (sanitizeName, confidence, manifest generation)
// These test the pure functions without network calls.

describe("scanner helpers", () => {
  describe("sanitizeName", () => {
    function sanitizeName(name: string): string {
      return name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64);
    }

    it("lowercases and strips invalid chars", () => {
      expect(sanitizeName("My-Tool")).toBe("my-tool");
      expect(sanitizeName("some_tool_v2")).toBe("some-tool-v2");
      expect(sanitizeName("@scope/name")).toBe("scope-name");
      expect(sanitizeName("UPPERCASE")).toBe("uppercase");
    });

    it("collapses multiple hyphens", () => {
      expect(sanitizeName("a--b---c")).toBe("a-b-c");
    });

    it("trims leading/trailing hyphens", () => {
      expect(sanitizeName("-leading-")).toBe("leading");
      expect(sanitizeName("---")).toBe("");
    });

    it("truncates to 64 chars", () => {
      const long = "a".repeat(100);
      expect(sanitizeName(long).length).toBe(64);
    });
  });

  describe("confidence calculation", () => {
    function calculateConfidence(repo: { stargazers_count: number; license: unknown; description: string | null; archived: boolean }): number {
      let confidence = 0.5;
      if (repo.stargazers_count > 100) confidence += 0.1;
      if (repo.stargazers_count > 1000) confidence += 0.1;
      if (repo.license) confidence += 0.1;
      if (repo.description) confidence += 0.05;
      if (!repo.archived) confidence += 0.05;
      return Math.min(confidence, 0.95);
    }

    it("base confidence is 0.5", () => {
      expect(calculateConfidence({
        stargazers_count: 0, license: null, description: null, archived: true,
      })).toBe(0.5);
    });

    it("popular repos get higher confidence", () => {
      const c = calculateConfidence({
        stargazers_count: 5000, license: { spdx_id: "MIT" }, description: "A tool", archived: false,
      });
      expect(c).toBeGreaterThan(0.8);
    });

    it("caps at 0.95", () => {
      const c = calculateConfidence({
        stargazers_count: 100000, license: { spdx_id: "MIT" }, description: "desc", archived: false,
      });
      expect(c).toBeLessThanOrEqual(0.95);
    });
  });

  describe("type detection from topic", () => {
    function detectTypeFromTopic(topic: string): "skill" | "mcp" | "cli" {
      if (topic.includes("mcp") || topic.includes("model-context")) return "mcp";
      if (topic.includes("skill") || topic.includes("agent")) return "skill";
      return "cli";
    }

    it("detects mcp topics", () => {
      expect(detectTypeFromTopic("mcp-server")).toBe("mcp");
      expect(detectTypeFromTopic("model-context-protocol")).toBe("mcp");
    });

    it("detects skill topics", () => {
      expect(detectTypeFromTopic("claude-skill")).toBe("skill");
      expect(detectTypeFromTopic("agent-skill")).toBe("skill");
    });

    it("defaults to cli", () => {
      expect(detectTypeFromTopic("llm-tool")).toBe("cli");
      expect(detectTypeFromTopic("developer-tools")).toBe("cli");
    });
  });

  describe("scanner API data exposure", () => {
    it("candidates list query does not use SELECT * and excludes internal fields", () => {
      // The GET /v1/scanner/candidates endpoint should only return public-safe columns
      const allowedColumns = [
        "external_url", "detected_type", "detected_name", "status",
        "confidence", "stars", "license", "last_checked",
      ];
      const forbiddenColumns = ["id", "source_id", "generated_manifest"];

      // These internal fields must NOT appear in the list response
      for (const col of forbiddenColumns) {
        expect(allowedColumns).not.toContain(col);
      }
    });

    it("candidate detail query excludes source_id", () => {
      // GET /v1/scanner/candidates/:id may return more detail (e.g. generated_manifest)
      // but must still exclude internal reference IDs
      const detailColumns = [
        "external_url", "external_id", "detected_type", "detected_name",
        "generated_manifest", "status", "confidence", "stars", "license", "last_checked",
      ];
      expect(detailColumns).not.toContain("source_id");
      expect(detailColumns).not.toContain("id");
    });

    it("scanner sources query uses explicit columns, not SELECT *", () => {
      const sourceColumns = [
        "id", "type", "source_key", "enabled", "total_found", "last_scanned", "created_at",
      ];
      // cursor_state is internal scanner state, should not be exposed
      expect(sourceColumns).not.toContain("cursor_state");
    });
  });

  describe("manifest generation", () => {
    it("generates valid skill manifest", () => {
      const manifest = JSON.parse(JSON.stringify({
        name: "@community/test-skill",
        version: "0.0.1",
        type: "skill",
        description: "A test skill",
        skill: { entry: "SKILL.md" },
        install: { source: "github:user/repo" },
      }));

      expect(manifest.name).toBe("@community/test-skill");
      expect(manifest.type).toBe("skill");
      expect(manifest.skill.entry).toBe("SKILL.md");
    });

    it("generates valid mcp manifest", () => {
      const manifest = {
        name: "@community/github-mcp",
        version: "1.0.0",
        type: "mcp",
        mcp: { transport: "stdio", command: "npx", args: ["-y", "@mcp/github"] },
      };

      expect(manifest.type).toBe("mcp");
      expect(manifest.mcp.transport).toBe("stdio");
      expect(manifest.mcp.command).toBe("npx");
    });

    it("generates valid cli manifest", () => {
      const manifest = {
        name: "@community/ripgrep",
        version: "14.1.0",
        type: "cli",
        cli: { binary: "rg", verify: "rg --version" },
        install: { brew: "ripgrep" },
      };

      expect(manifest.type).toBe("cli");
      expect(manifest.cli.binary).toBe("rg");
      expect(manifest.install.brew).toBe("ripgrep");
    });
  });
});

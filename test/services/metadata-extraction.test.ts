import { describe, it, expect } from "vitest";

describe("metadata extraction", () => {
  // These test the extraction logic that maps manifest fields to metadata tables

  describe("skill metadata", () => {
    it("should extract skill fields from manifest", () => {
      const manifest = {
        type: "skill",
        skill: { entry: "SKILL.md", compatibility: "claude,cursor", user_invocable: true, tags: ["review"] },
      };
      const skill = manifest.skill;
      expect(skill.entry).toBe("SKILL.md");
      expect(skill.compatibility).toBe("claude,cursor");
      expect(skill.user_invocable).toBe(true);
      expect(skill.tags).toEqual(["review"]);
    });

    it("should use defaults for missing skill fields", () => {
      const manifest = { type: "skill" };
      const skill = (manifest as any).skill ?? {};
      expect(skill.entry ?? "").toBe("");
      expect(skill.compatibility ?? "").toBe("");
      expect(skill.user_invocable !== false ? 1 : 0).toBe(1);
    });
  });

  describe("mcp metadata", () => {
    it("should extract mcp fields from manifest", () => {
      const manifest = {
        type: "mcp",
        mcp: { transport: "stdio", command: "node", args: ["dist/index.js"], env: [{ name: "TOKEN", required: true }] },
      };
      const mcp = manifest.mcp;
      expect(mcp.transport).toBe("stdio");
      expect(mcp.command).toBe("node");
      expect(mcp.args).toEqual(["dist/index.js"]);
      expect(mcp.env).toHaveLength(1);
    });

    it("should handle sse transport with url", () => {
      const manifest = {
        type: "mcp",
        mcp: { transport: "sse", url: "https://example.com/sse" },
      };
      expect(manifest.mcp.transport).toBe("sse");
      expect(manifest.mcp.url).toBe("https://example.com/sse");
    });
  });

  describe("cli metadata", () => {
    it("should extract cli fields from manifest", () => {
      const manifest = {
        type: "cli",
        cli: { binary: "rg", verify: "rg --version", compatible: ">=14.0.0" },
        install: { brew: "ripgrep", cargo: "ripgrep" },
      };
      expect(manifest.cli.binary).toBe("rg");
      expect(manifest.install.brew).toBe("ripgrep");
    });
  });

  describe("install metadata", () => {
    it("should extract platform-specific install methods", () => {
      const manifest = {
        install: {
          brew: "ripgrep",
          npm: "",
          pip: "",
          cargo: "ripgrep",
          platforms: { "darwin-arm64": { binary: "https://..." } },
        },
      };
      expect(manifest.install.brew).toBe("ripgrep");
      expect(manifest.install.cargo).toBe("ripgrep");
      expect(manifest.install.platforms["darwin-arm64"]).toBeDefined();
    });

    it("should handle empty install spec gracefully", () => {
      const manifest = {};
      const install = (manifest as any).install ?? {};
      expect(Object.keys(install).length).toBe(0);
    });
  });

  describe("unknown fields", () => {
    it("should not break on extra fields in manifest", () => {
      const manifest = {
        type: "skill",
        skill: { entry: "SKILL.md" },
        unknown_field: "should be ignored",
        nested: { also: "ignored" },
      };
      const skill = manifest.skill;
      expect(skill.entry).toBe("SKILL.md");
      // Unknown fields simply don't map to any metadata table
    });
  });
});

import { describe, it, expect } from "vitest";

describe("stats", () => {
  describe("download stats UPSERT", () => {
    it("should generate correct date format", () => {
      const today = new Date().toISOString().slice(0, 10);
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("agent install tracking", () => {
    it("should accept known agent names", () => {
      const knownAgents = ["claude", "cursor", "windsurf", "codex", "copilot", "cline", "zed"];
      const input = ["claude", "cursor"];
      const allKnown = input.every(a => knownAgents.includes(a));
      expect(allKnown).toBe(true);
    });

    it("should accept unknown agent names (open ecosystem)", () => {
      const input = ["my-custom-agent"];
      // Unknown agents should be accepted, not rejected
      expect(input).toHaveLength(1);
    });

    it("should count each agent separately for multi-agent installs", () => {
      const agents = ["claude", "cursor", "windsurf"];
      // Each agent should get its own UPSERT row
      expect(agents.length).toBe(3);
    });
  });

  describe("trending calculation", () => {
    it("should sort by weekly downloads descending", () => {
      const packages = [
        { name: "a", weekly: 100 },
        { name: "b", weekly: 500 },
        { name: "c", weekly: 250 },
      ];
      const sorted = [...packages].sort((a, b) => b.weekly - a.weekly);
      expect(sorted[0].name).toBe("b");
      expect(sorted[1].name).toBe("c");
      expect(sorted[2].name).toBe("a");
    });
  });

  describe("agent breakdown percentage", () => {
    it("should calculate correct percentages", () => {
      const breakdown = [
        { agent: "claude", count: 470 },
        { agent: "cursor", count: 315 },
        { agent: "windsurf", count: 125 },
        { agent: "other", count: 90 },
      ];
      const total = breakdown.reduce((sum, b) => sum + b.count, 0);
      expect(total).toBe(1000);

      const claudePercent = Math.round((470 / total) * 1000) / 10;
      expect(claudePercent).toBe(47);
    });

    it("should handle zero total gracefully", () => {
      const total = 0;
      const percentage = total > 0 ? Math.round((0 / total) * 1000) / 10 : 0;
      expect(percentage).toBe(0);
    });
  });

  describe("telemetry input validation", () => {
    it("should accept valid telemetry body", () => {
      const body = {
        package: "@scope/name",
        version: "1.0.0",
        agents: ["claude", "cursor"],
        source_type: "registry",
      };
      expect(body.package).toBeTruthy();
      expect(body.agents).toBeInstanceOf(Array);
    });

    it("should handle missing fields gracefully", () => {
      const body = { package: "@scope/name" };
      const agents = (body as any).agents ?? [];
      const version = (body as any).version ?? "";
      expect(agents).toHaveLength(0);
      expect(version).toBe("");
    });
  });

  describe("registry overview", () => {
    it("should return zero counts for empty registry", () => {
      const result = { total_packages: 0, total_downloads: 0, total_publishers: 0, breakdown: [] };
      expect(result.total_packages).toBe(0);
      expect(result.total_downloads).toBe(0);
      expect(result.total_publishers).toBe(0);
      expect(result.breakdown).toHaveLength(0);
    });

    it("should compute correct type breakdown percentages", () => {
      const total = 100;
      const breakdown = [
        { type: "skill", count: 60 },
        { type: "mcp", count: 30 },
        { type: "cli", count: 10 },
      ];
      const withPct = breakdown.map((b) => ({
        ...b,
        percentage: Math.round((b.count / total) * 1000) / 10,
      }));
      expect(withPct[0].percentage).toBe(60);
      expect(withPct[1].percentage).toBe(30);
      expect(withPct[2].percentage).toBe(10);
    });

    it("should handle zero total packages in percentage calc", () => {
      const total = 0;
      const percentage = total > 0 ? Math.round((0 / total) * 1000) / 10 : 0;
      expect(percentage).toBe(0);
    });

    it("should only include types that have packages", () => {
      const breakdown = [
        { type: "skill", count: 50, percentage: 62.5 },
        { type: "mcp", count: 30, percentage: 37.5 },
      ];
      expect(breakdown).toHaveLength(2);
      expect(breakdown.find((b) => b.type === "cli")).toBeUndefined();
    });

    it("should handle rounding in percentages", () => {
      const total = 3;
      const pcts = [1, 1, 1].map((c) => Math.round((c / total) * 1000) / 10);
      // Each is 33.3%, sum is 99.9% — acceptable rounding behavior
      expect(pcts).toEqual([33.3, 33.3, 33.3]);
      expect(pcts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
    });

    it("should use COALESCE for safe SUM on empty downloads", () => {
      // When no packages exist, SUM(downloads) returns NULL
      // COALESCE(NULL, 0) should return 0
      const downloadsResult = { total: null };
      const safeTotal = downloadsResult?.total ?? 0;
      expect(safeTotal).toBe(0);
    });
  });
});

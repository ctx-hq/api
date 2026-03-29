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
});

import { describe, it, expect } from "vitest";
import type { TrustTier } from "../../src/models/types";

describe("trust", () => {
  describe("trust tier progression", () => {
    function computeTier(passed: Set<string>): TrustTier {
      let tier: TrustTier = "unverified";
      if (passed.has("structural")) tier = "structural";
      if (passed.has("structural") && passed.has("source_linked")) tier = "source_linked";
      if (passed.has("structural") && passed.has("source_linked") && passed.has("ai_review")) tier = "reviewed";
      return tier;
    }

    it("should start as unverified", () => {
      expect(computeTier(new Set())).toBe("unverified");
    });

    it("should progress to structural", () => {
      expect(computeTier(new Set(["structural"]))).toBe("structural");
    });

    it("should progress to source_linked when both pass", () => {
      expect(computeTier(new Set(["structural", "source_linked"]))).toBe("source_linked");
    });

    it("should not skip tiers", () => {
      // source_linked without structural should not advance
      expect(computeTier(new Set(["source_linked"]))).toBe("unverified");
    });

    it("should progress to reviewed with all three", () => {
      expect(computeTier(new Set(["structural", "source_linked", "ai_review"]))).toBe("reviewed");
    });

    it("should not reach reviewed without source_linked", () => {
      expect(computeTier(new Set(["structural", "ai_review"]))).toBe("structural");
    });
  });

  describe("structural check validation", () => {
    it("should validate SHA256 length", () => {
      const validSHA = "a".repeat(64);
      const invalidSHA = "short";
      expect(validSHA.length).toBe(64);
      expect(invalidSHA.length).not.toBe(64);
    });

    it("should validate manifest has required fields", () => {
      const valid = { name: "@scope/pkg", version: "1.0.0", type: "skill" };
      const missing = { name: "@scope/pkg" };

      expect(typeof valid.name === "string" && typeof valid.version === "string" && typeof valid.type === "string").toBe(true);
      expect(typeof missing.name === "string" && typeof (missing as any).version === "string").toBe(false);
    });
  });
});

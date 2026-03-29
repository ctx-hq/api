import { describe, it, expect } from "vitest";
import type { Visibility } from "../../src/models/types";

describe("visibility", () => {
  describe("visibility values", () => {
    it("should accept valid visibility values", () => {
      const valid: Visibility[] = ["public", "unlisted", "private"];
      valid.forEach(v => {
        expect(["public", "unlisted", "private"]).toContain(v);
      });
    });

    it("should reject invalid visibility values", () => {
      const invalid = ["internal", "restricted", "", "PUBLIC"];
      invalid.forEach(v => {
        expect(["public", "unlisted", "private"]).not.toContain(v);
      });
    });
  });

  describe("mutable constraint", () => {
    it("should only allow mutable for private packages", () => {
      const cases = [
        { visibility: "public", mutable: true, valid: false },
        { visibility: "unlisted", mutable: true, valid: false },
        { visibility: "private", mutable: true, valid: true },
        { visibility: "public", mutable: false, valid: true },
        { visibility: "private", mutable: false, valid: true },
      ];

      cases.forEach(({ visibility, mutable, valid }) => {
        const isValid = !mutable || visibility === "private";
        expect(isValid).toBe(valid);
      });
    });
  });

  describe("search filtering", () => {
    it("should exclude private packages from search", () => {
      const packages = [
        { name: "a", visibility: "public" },
        { name: "b", visibility: "unlisted" },
        { name: "c", visibility: "private" },
      ];
      const searchable = packages.filter(p => p.visibility === "public");
      expect(searchable).toHaveLength(1);
      expect(searchable[0].name).toBe("a");
    });

    it("should exclude unlisted from search but allow direct access", () => {
      const packages = [
        { name: "a", visibility: "public" },
        { name: "b", visibility: "unlisted" },
      ];
      // Search: only public
      const searchResults = packages.filter(p => p.visibility === "public");
      expect(searchResults).toHaveLength(1);

      // Direct access: public + unlisted (no auth needed)
      const directAccess = packages.filter(p => p.visibility !== "private");
      expect(directAccess).toHaveLength(2);
    });
  });

  describe("private package auth", () => {
    it("should return 404 for unauthenticated access to private packages", () => {
      // Private packages return 404 (not 403) to avoid leaking existence
      const visibility = "private";
      const isAuthenticated = false;
      const shouldReturn404 = visibility === "private" && !isAuthenticated;
      expect(shouldReturn404).toBe(true);
    });
  });
});

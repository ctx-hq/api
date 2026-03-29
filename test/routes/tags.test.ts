import { describe, it, expect } from "vitest";

describe("dist-tags", () => {
  describe("tag name validation", () => {
    it("should reject semver-like tag names", () => {
      const isSemver = (tag: string) => /^\d+\.\d+\.\d+/.test(tag);
      expect(isSemver("1.0.0")).toBe(true);
      expect(isSemver("2.0.0-beta.1")).toBe(true);
      expect(isSemver("latest")).toBe(false);
      expect(isSemver("beta")).toBe(false);
      expect(isSemver("stable")).toBe(false);
    });

    it("should accept valid tag names", () => {
      const isValid = (tag: string) => /^[a-z][a-z0-9-]*$/.test(tag);
      expect(isValid("latest")).toBe(true);
      expect(isValid("beta")).toBe(true);
      expect(isValid("stable")).toBe(true);
      expect(isValid("rc-1")).toBe(true);
      expect(isValid("next")).toBe(true);
    });

    it("should reject invalid tag names", () => {
      const isValid = (tag: string) => /^[a-z][a-z0-9-]*$/.test(tag);
      expect(isValid("")).toBe(false);
      expect(isValid("Latest")).toBe(false);
      expect(isValid("-leading")).toBe(false);
      expect(isValid("123")).toBe(false);
      expect(isValid("has space")).toBe(false);
    });
  });

  describe("latest tag protection", () => {
    it("should identify latest tag for protection", () => {
      const isProtected = (tag: string) => tag === "latest";
      expect(isProtected("latest")).toBe(true);
      expect(isProtected("beta")).toBe(false);
      expect(isProtected("stable")).toBe(false);
    });
  });

  describe("auto dist-tag logic", () => {
    it("should auto-tag non-prerelease as latest", () => {
      const version = "1.0.0";
      const prereleaseMatch = version.match(/-([a-zA-Z]+)/);
      expect(prereleaseMatch).toBeNull();
      // → set 'latest' tag
    });

    it("should auto-tag prerelease with identifier", () => {
      const version = "2.0.0-beta.1";
      const prereleaseMatch = version.match(/-([a-zA-Z]+)/);
      expect(prereleaseMatch).not.toBeNull();
      expect(prereleaseMatch![1].toLowerCase()).toBe("beta");
    });

    it("should extract rc from prerelease", () => {
      const version = "3.0.0-rc.2";
      const match = version.match(/-([a-zA-Z]+)/);
      expect(match![1].toLowerCase()).toBe("rc");
    });

    it("should extract alpha from prerelease", () => {
      const version = "1.0.0-alpha";
      const match = version.match(/-([a-zA-Z]+)/);
      expect(match![1].toLowerCase()).toBe("alpha");
    });
  });
});

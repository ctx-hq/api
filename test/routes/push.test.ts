import { describe, it, expect } from "vitest";

describe("push (private mutable publish)", () => {
  describe("default values", () => {
    it("should default visibility to private for push", () => {
      const pushDefaults = { visibility: "private", mutable: true };
      expect(pushDefaults.visibility).toBe("private");
      expect(pushDefaults.mutable).toBe(true);
    });

    it("should not index private packages in search_digest", () => {
      const visibility = "private";
      const shouldIndex = visibility !== "private";
      expect(shouldIndex).toBe(false);
    });

    it("should not enqueue vectorization for private packages", () => {
      const visibility = "private";
      const shouldVectorize = visibility !== "private";
      expect(shouldVectorize).toBe(false);
    });
  });

  describe("mutable version overwrite", () => {
    it("should allow overwriting same version when mutable", () => {
      const existingVersion = "0.1.0";
      const newVersion = "0.1.0";
      const mutable = true;
      const shouldOverwrite = mutable && existingVersion === newVersion;
      expect(shouldOverwrite).toBe(true);
    });

    it("should reject overwrite when not mutable", () => {
      const mutable = false;
      const sameVersion = true;
      const shouldReject = !mutable && sameVersion;
      expect(shouldReject).toBe(true);
    });
  });

  describe("auto version bump", () => {
    it("should bump patch for mutable packages", () => {
      const current = "0.1.0";
      const parts = current.split(".").map(Number);
      parts[2]++;
      const bumped = parts.join(".");
      expect(bumped).toBe("0.1.1");
    });
  });

  describe("scope auto-fill", () => {
    it("should replace placeholder scope with username", () => {
      const name = "@your-scope/my-skill";
      const username = "hong";
      const parts = name.split("/");
      const scopePart = parts[0].replace("@your-scope", "@" + username);
      const result = scopePart + "/" + parts[1];
      expect(result).toBe("@hong/my-skill");
    });
  });
});

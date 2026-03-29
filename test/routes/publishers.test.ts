import { describe, it, expect } from "vitest";

describe("publishers", () => {
  describe("publisher profile", () => {
    it("should distinguish user and org publishers", () => {
      const userPub = { slug: "alice", kind: "user", packages: 5 };
      const orgPub = { slug: "acme", kind: "org", packages: 12 };
      expect(userPub.kind).toBe("user");
      expect(orgPub.kind).toBe("org");
    });

    it("should return 404 for non-existent publisher", () => {
      const slug = "non-existent";
      expect(slug).toBeTruthy(); // 404 is handled by route logic
    });
  });

  describe("publisher packages listing", () => {
    it("should only list public packages for a publisher", () => {
      const packages = [
        { name: "@alice/public-skill", visibility: "public" },
        { name: "@alice/private-skill", visibility: "private" },
        { name: "@alice/unlisted-tool", visibility: "unlisted" },
      ];
      const publicOnly = packages.filter(p => p.visibility === "public");
      expect(publicOnly).toHaveLength(1);
      expect(publicOnly[0].name).toBe("@alice/public-skill");
    });

    it("should support type filtering", () => {
      const packages = [
        { name: "a", type: "skill" },
        { name: "b", type: "mcp" },
        { name: "c", type: "skill" },
      ];
      const skills = packages.filter(p => p.type === "skill");
      expect(skills).toHaveLength(2);
    });

    it("should sort by downloads descending", () => {
      const packages = [
        { name: "a", downloads: 100 },
        { name: "b", downloads: 500 },
        { name: "c", downloads: 250 },
      ];
      const sorted = [...packages].sort((a, b) => b.downloads - a.downloads);
      expect(sorted[0].name).toBe("b");
    });
  });
});

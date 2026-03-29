import { describe, it, expect } from "vitest";

describe("sync", () => {
  describe("sync profile structure", () => {
    it("should have required fields", () => {
      const profile = {
        version: 1,
        exported_at: "2026-03-29T12:00:00Z",
        device: "MacBook-Pro",
        packages: [],
      };
      expect(profile.version).toBe(1);
      expect(profile.exported_at).toBeTruthy();
      expect(profile.device).toBeTruthy();
      expect(profile.packages).toBeInstanceOf(Array);
    });
  });

  describe("sync package entry", () => {
    it("should track source for registry packages", () => {
      const entry = {
        name: "@scope/name",
        version: "1.0.0",
        source: "registry",
        constraint: "^1.0",
        syncable: true,
        agents: ["claude", "cursor"],
      };
      expect(entry.source).toBe("registry");
      expect(entry.syncable).toBe(true);
    });

    it("should mark local packages as unsyncable", () => {
      const entry = {
        name: "local-skill",
        version: "0.0.0",
        source: "local",
        syncable: false,
        agents: ["claude"],
      };
      expect(entry.syncable).toBe(false);
    });

    it("should track github source with ref", () => {
      const entry = {
        name: "@community/awesome",
        version: "main",
        source: "github",
        source_url: "github:user/awesome@main",
        syncable: true,
        agents: [],
      };
      expect(entry.source).toBe("github");
      expect(entry.source_url).toContain("github:");
    });
  });

  describe("sync metadata", () => {
    it("should track push/pull timestamps", () => {
      const meta = {
        package_count: 12,
        syncable_count: 11,
        unsyncable_count: 1,
        last_push_at: "2026-03-29T12:00:00Z",
        last_push_device: "MacBook-Pro",
        last_pull_at: "2026-03-29T14:30:00Z",
        last_pull_device: "Linux-Desktop",
      };
      expect(meta.package_count).toBe(meta.syncable_count + meta.unsyncable_count);
      expect(meta.last_push_at).toBeTruthy();
      expect(meta.last_pull_at).toBeTruthy();
    });

    it("should handle no profile (first time)", () => {
      const meta = {
        package_count: 0,
        syncable_count: 0,
        unsyncable_count: 0,
        last_push_at: null,
        last_pull_at: null,
        last_push_device: "",
        last_pull_device: "",
      };
      expect(meta.last_push_at).toBeNull();
      expect(meta.last_pull_at).toBeNull();
    });
  });

  describe("provenance source mapping", () => {
    it("should map source to rebuild command", () => {
      const mapping: Record<string, (entry: any) => string> = {
        registry: (e) => `ctx install ${e.name}@${e.constraint || "latest"}`,
        github: (e) => `ctx install ${e.source_url}`,
        push: (e) => `ctx install ${e.name}`,
        local: () => "unsyncable",
      };

      expect(mapping.registry({ name: "@scope/pkg", constraint: "^1.0" })).toBe("ctx install @scope/pkg@^1.0");
      expect(mapping.github({ source_url: "github:user/repo@main" })).toBe("ctx install github:user/repo@main");
      expect(mapping.push({ name: "@me/skill" })).toBe("ctx install @me/skill");
      expect(mapping.local({})).toBe("unsyncable");
    });
  });
});

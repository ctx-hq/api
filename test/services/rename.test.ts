import { describe, it, expect } from "vitest";
import {
  checkRenameCooldown,
  isNameAvailable,
  renamePackage,
  renameOrg,
  renameUser,
} from "../../src/services/rename";

interface MockDB {
  prepare(sql: string): MockStatement;
  batch(stmts: MockStatement[]): Promise<unknown[]>;
  _executed: Array<{ sql: string; params: unknown[] }>;
  _data: Map<string, Record<string, unknown>>;
}

interface MockStatement {
  bind(...params: unknown[]): MockStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockDB(opts: {
  firstFn?: (sql: string, params: unknown[]) => unknown | null;
  allFn?: (sql: string, params: unknown[]) => unknown[];
  runChanges?: number;
} = {}): MockDB {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const data = new Map<string, Record<string, unknown>>();

  const db: MockDB = {
    _executed: executed,
    _data: data,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt: MockStatement = {
        bind(...params: unknown[]) {
          boundParams = params;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          executed.push({ sql, params: boundParams });
          if (opts.firstFn) {
            return opts.firstFn(sql, boundParams) as T | null;
          }
          if (sql.includes("FROM") && boundParams[0]) {
            const key = boundParams[0] as string;
            return (data.get(key) as T) ?? null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          executed.push({ sql, params: boundParams });
          if (opts.allFn) {
            return { results: opts.allFn(sql, boundParams) as T[] };
          }
          return { results: [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          return { success: true, meta: { changes: opts.runChanges ?? 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts: MockStatement[]) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  };
  return db;
}

describe("rename service", () => {
  describe("checkRenameCooldown", () => {
    it("should return true when renamed_at is within 30 days", async () => {
      const db = createMockDB({
        firstFn: (sql, params) => {
          if (sql.includes("renamed_at")) {
            return { renamed_at: new Date().toISOString() };
          }
          return null;
        },
      });

      const result = await checkRenameCooldown(db as unknown as D1Database, "orgs", "org-1");
      expect(result).toBe(true);
    });

    it("should return false when renamed_at is older than 30 days or null", async () => {
      const db = createMockDB({
        firstFn: () => null,
      });

      const result = await checkRenameCooldown(db as unknown as D1Database, "users", "user-1");
      expect(result).toBe(false);
    });

    it("should query the correct table", async () => {
      const db = createMockDB({ firstFn: () => null });
      await checkRenameCooldown(db as unknown as D1Database, "orgs", "org-1");

      const query = db._executed[0];
      expect(query.sql).toContain("FROM orgs");
      expect(query.sql).toContain("renamed_at");
      expect(query.params[0]).toBe("org-1");
    });

    it("should query users table when specified", async () => {
      const db = createMockDB({ firstFn: () => null });
      await checkRenameCooldown(db as unknown as D1Database, "users", "user-1");

      const query = db._executed[0];
      expect(query.sql).toContain("FROM users");
    });

    it("should use 30-day cooldown window", async () => {
      const db = createMockDB({ firstFn: () => null });
      await checkRenameCooldown(db as unknown as D1Database, "orgs", "org-1");

      const query = db._executed[0];
      expect(query.sql).toContain("-30 days");
    });
  });

  describe("isNameAvailable", () => {
    it("should return available: false when scope exists", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM scopes")) {
            return { name: "taken" };
          }
          return null;
        },
      });

      const result = await isNameAvailable(db as unknown as D1Database, "taken");
      expect(result.available).toBe(false);
      expect(result.reason).toContain("already taken");
    });

    it("should return available: false when scope alias exists", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("scope_aliases")) {
            return { old_scope: "reserved" };
          }
          return null;
        },
      });

      const result = await isNameAvailable(db as unknown as D1Database, "reserved");
      expect(result.available).toBe(false);
      expect(result.reason).toContain("reserved");
    });

    it("should return available: false when slug alias conflicts", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("slug_aliases") && sql.includes("LIKE")) {
            return { old_full_name: "@conflicting/pkg" };
          }
          return null;
        },
      });

      const result = await isNameAvailable(db as unknown as D1Database, "conflicting");
      expect(result.available).toBe(false);
      expect(result.reason).toContain("package alias");
    });

    it("should return available: true when name is free", async () => {
      const db = createMockDB({
        firstFn: () => null,
      });

      const result = await isNameAvailable(db as unknown as D1Database, "fresh-name");
      expect(result.available).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should reject invalid scope names", async () => {
      const db = createMockDB({ firstFn: () => null });
      const result = await isNameAvailable(db as unknown as D1Database, "UPPERCASE");
      expect(result.available).toBe(false);
      expect(result.reason).toContain("Invalid name");
    });

    it("should reject names with special characters", async () => {
      const db = createMockDB({ firstFn: () => null });
      const result = await isNameAvailable(db as unknown as D1Database, "has_underscore");
      expect(result.available).toBe(false);
      expect(result.reason).toContain("Invalid name");
    });
  });

  describe("renamePackage", () => {
    it("should update package name and full_name", async () => {
      const db = createMockDB({
        firstFn: (sql, params) => {
          if (sql.includes("FROM packages WHERE id")) {
            return { id: "pkg-1", scope: "alice", name: "old-tool", full_name: "@alice/old-tool" };
          }
          return null; // no conflict
        },
      });

      const result = await renamePackage(db as unknown as D1Database, "pkg-1", "new-tool");
      expect(result.oldFullName).toBe("@alice/old-tool");
      expect(result.newFullName).toBe("@alice/new-tool");
    });

    it("should create a slug alias for old name", async () => {
      const db = createMockDB({
        firstFn: (sql, params) => {
          if (sql.includes("FROM packages WHERE id")) {
            return { id: "pkg-1", scope: "alice", name: "old-tool", full_name: "@alice/old-tool" };
          }
          return null;
        },
      });

      await renamePackage(db as unknown as D1Database, "pkg-1", "new-tool");

      const aliasInsert = db._executed.find(
        (e) => e.sql.includes("INSERT OR REPLACE INTO slug_aliases"),
      );
      expect(aliasInsert).toBeDefined();
    });

    it("should update search_digest", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM packages WHERE id")) {
            return { id: "pkg-1", scope: "alice", name: "old-tool", full_name: "@alice/old-tool" };
          }
          return null;
        },
      });

      await renamePackage(db as unknown as D1Database, "pkg-1", "new-tool");

      const searchUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE search_digest"),
      );
      expect(searchUpdate).toBeDefined();
    });

    it("should throw when package not found", async () => {
      const db = createMockDB({ firstFn: () => null });

      await expect(
        renamePackage(db as unknown as D1Database, "pkg-nope", "new-name"),
      ).rejects.toThrow("Package not found");
    });

    it("should throw when new name already taken", async () => {
      let callCount = 0;
      const db = createMockDB({
        firstFn: (sql, params) => {
          if (sql.includes("FROM packages WHERE id")) {
            return { id: "pkg-1", scope: "alice", name: "old-tool", full_name: "@alice/old-tool" };
          }
          if (sql.includes("FROM packages WHERE full_name")) {
            return { id: "pkg-2" }; // conflict
          }
          return null;
        },
      });

      await expect(
        renamePackage(db as unknown as D1Database, "pkg-1", "taken-tool"),
      ).rejects.toThrow("already exists");
    });

    it("should throw when new name conflicts with alias", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM packages WHERE id")) {
            return { id: "pkg-1", scope: "alice", name: "old-tool", full_name: "@alice/old-tool" };
          }
          if (sql.includes("FROM packages WHERE full_name")) {
            return null; // no direct conflict
          }
          if (sql.includes("slug_aliases") && sql.includes("old_full_name = ?")) {
            return { old_full_name: "@alice/reserved" }; // alias conflict
          }
          return null;
        },
      });

      await expect(
        renamePackage(db as unknown as D1Database, "pkg-1", "reserved"),
      ).rejects.toThrow("reserved (redirect alias)");
    });

    it("should flatten existing alias chains", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM packages WHERE id")) {
            return { id: "pkg-1", scope: "alice", name: "old-tool", full_name: "@alice/old-tool" };
          }
          return null;
        },
      });

      await renamePackage(db as unknown as D1Database, "pkg-1", "new-tool");

      const flattenUpdate = db._executed.find(
        (e) =>
          e.sql.includes("UPDATE slug_aliases SET new_full_name") &&
          !e.sql.includes("INSERT"),
      );
      expect(flattenUpdate).toBeDefined();
    });
  });

  describe("renameOrg", () => {
    it("should cascade to scope and all packages", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM orgs")) {
            return { id: "org-1", name: "old-team" };
          }
          return null;
        },
        allFn: (sql) => {
          if (sql.includes("FROM packages WHERE scope")) {
            return [
              { id: "pkg-1", name: "tool-a", full_name: "@old-team/tool-a" },
              { id: "pkg-2", name: "tool-b", full_name: "@old-team/tool-b" },
            ];
          }
          return [];
        },
      });

      const result = await renameOrg(db as unknown as D1Database, "org-1", "new-team");
      expect(result.oldName).toBe("old-team");
      expect(result.newName).toBe("new-team");
      expect(result.packagesUpdated).toBe(2);

      // Should update org name
      const orgUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE orgs SET name"),
      );
      expect(orgUpdate).toBeDefined();

      // Should update scope
      const scopeUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE scopes SET name"),
      );
      expect(scopeUpdate).toBeDefined();

      // Should create scope alias
      const scopeAlias = db._executed.find(
        (e) => e.sql.includes("INSERT OR REPLACE INTO scope_aliases"),
      );
      expect(scopeAlias).toBeDefined();
    });

    it("should create slug aliases for all packages", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM orgs")) {
            return { id: "org-1", name: "old-team" };
          }
          return null;
        },
        allFn: (sql) => {
          if (sql.includes("FROM packages WHERE scope")) {
            return [{ id: "pkg-1", name: "tool", full_name: "@old-team/tool" }];
          }
          return [];
        },
      });

      await renameOrg(db as unknown as D1Database, "org-1", "new-team");

      const slugAlias = db._executed.find(
        (e) => e.sql.includes("INSERT OR REPLACE INTO slug_aliases"),
      );
      expect(slugAlias).toBeDefined();
    });

    it("should throw when org not found", async () => {
      const db = createMockDB({ firstFn: () => null });

      await expect(
        renameOrg(db as unknown as D1Database, "org-nope", "new-name"),
      ).rejects.toThrow("Organization not found");
    });

    it("should handle org with no packages", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM orgs")) {
            return { id: "org-1", name: "empty-team" };
          }
          return null;
        },
        allFn: () => [],
      });

      const result = await renameOrg(db as unknown as D1Database, "org-1", "new-team");
      expect(result.packagesUpdated).toBe(0);
    });

    it("should set renamed_at on org", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM orgs")) {
            return { id: "org-1", name: "old-team" };
          }
          return null;
        },
        allFn: () => [],
      });

      await renameOrg(db as unknown as D1Database, "org-1", "new-team");

      const orgUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE orgs") && e.sql.includes("renamed_at"),
      );
      expect(orgUpdate).toBeDefined();
    });

    it("should flatten scope alias chains before creating new alias", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM orgs")) {
            return { id: "org-1", name: "old-team" };
          }
          return null;
        },
        allFn: () => [],
      });

      await renameOrg(db as unknown as D1Database, "org-1", "new-team");

      const flatten = db._executed.find(
        (e) => e.sql.includes("UPDATE scope_aliases SET new_scope"),
      );
      expect(flatten).toBeDefined();
    });
  });

  describe("renameUser", () => {
    it("should cascade to scope and personal packages", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM users")) {
            return { id: "user-1", username: "alice" };
          }
          return null;
        },
        allFn: (sql) => {
          if (sql.includes("FROM packages WHERE scope")) {
            return [
              { id: "pkg-1", name: "my-tool", full_name: "@alice/my-tool" },
            ];
          }
          return [];
        },
      });

      const result = await renameUser(db as unknown as D1Database, "user-1", "alice-new");
      expect(result.oldUsername).toBe("alice");
      expect(result.newUsername).toBe("alice-new");
      expect(result.packagesUpdated).toBe(1);

      // Should update username with renamed_at
      const userUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE users SET username") && e.sql.includes("renamed_at"),
      );
      expect(userUpdate).toBeDefined();

      // Should update scope
      const scopeUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE scopes SET name"),
      );
      expect(scopeUpdate).toBeDefined();

      // Should create scope alias
      const scopeAlias = db._executed.find(
        (e) => e.sql.includes("INSERT OR REPLACE INTO scope_aliases"),
      );
      expect(scopeAlias).toBeDefined();
    });

    it("should throw when user not found", async () => {
      const db = createMockDB({ firstFn: () => null });

      await expect(
        renameUser(db as unknown as D1Database, "user-nope", "new-name"),
      ).rejects.toThrow("User not found");
    });

    it("should handle user with no packages", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM users")) {
            return { id: "user-1", username: "alice" };
          }
          return null;
        },
        allFn: () => [],
      });

      const result = await renameUser(db as unknown as D1Database, "user-1", "alice-new");
      expect(result.packagesUpdated).toBe(0);
    });

    it("should create slug aliases for all personal packages", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM users")) {
            return { id: "user-1", username: "alice" };
          }
          return null;
        },
        allFn: (sql) => {
          if (sql.includes("FROM packages WHERE scope")) {
            return [
              { id: "pkg-1", name: "tool-a", full_name: "@alice/tool-a" },
              { id: "pkg-2", name: "tool-b", full_name: "@alice/tool-b" },
            ];
          }
          return [];
        },
      });

      await renameUser(db as unknown as D1Database, "user-1", "bob");

      const slugAliases = db._executed.filter(
        (e) => e.sql.includes("INSERT OR REPLACE INTO slug_aliases"),
      );
      expect(slugAliases.length).toBeGreaterThanOrEqual(2);
    });

    it("should update scope with user owner_type filter", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM users")) {
            return { id: "user-1", username: "alice" };
          }
          return null;
        },
        allFn: () => [],
      });

      await renameUser(db as unknown as D1Database, "user-1", "bob");

      const scopeUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE scopes SET name") && e.sql.includes("owner_type = 'user'"),
      );
      expect(scopeUpdate).toBeDefined();
    });

    it("should flatten scope alias chains", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM users")) {
            return { id: "user-1", username: "alice" };
          }
          return null;
        },
        allFn: () => [],
      });

      await renameUser(db as unknown as D1Database, "user-1", "bob");

      const flatten = db._executed.find(
        (e) => e.sql.includes("UPDATE scope_aliases SET new_scope"),
      );
      expect(flatten).toBeDefined();
    });

    it("should flatten package alias chains for each package", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM users")) {
            return { id: "user-1", username: "alice" };
          }
          return null;
        },
        allFn: (sql) => {
          if (sql.includes("FROM packages WHERE scope")) {
            return [{ id: "pkg-1", name: "tool", full_name: "@alice/tool" }];
          }
          return [];
        },
      });

      await renameUser(db as unknown as D1Database, "user-1", "bob");

      const flattenPkg = db._executed.find(
        (e) => e.sql.includes("UPDATE slug_aliases SET new_full_name"),
      );
      expect(flattenPkg).toBeDefined();
    });

    it("should update search_digest for each package", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM users")) {
            return { id: "user-1", username: "alice" };
          }
          return null;
        },
        allFn: (sql) => {
          if (sql.includes("FROM packages WHERE scope")) {
            return [
              { id: "pkg-1", name: "tool-a", full_name: "@alice/tool-a" },
              { id: "pkg-2", name: "tool-b", full_name: "@alice/tool-b" },
            ];
          }
          return [];
        },
      });

      await renameUser(db as unknown as D1Database, "user-1", "bob");

      const searchUpdates = db._executed.filter(
        (e) => e.sql.includes("UPDATE search_digest SET full_name"),
      );
      expect(searchUpdates.length).toBeGreaterThanOrEqual(2);
    });
  });
});

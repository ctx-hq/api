import { describe, it, expect } from "vitest";
import {
  resolvePackageName,
  resolveScope,
  flattenPackageAliasChains,
  flattenScopeAliasChains,
  createPackageAlias,
  createScopeAlias,
} from "../../src/services/redirect";

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

describe("redirect service", () => {
  describe("resolvePackageName", () => {
    it("should return canonical name when alias exists", async () => {
      const db = createMockDB({
        firstFn: (sql, params) => {
          if (sql.includes("slug_aliases") && params[0] === "@old/pkg") {
            return { new_full_name: "@new/pkg" };
          }
          return null;
        },
      });

      const result = await resolvePackageName(db as unknown as D1Database, "@old/pkg");
      expect(result).toBe("@new/pkg");
    });

    it("should return input when no alias exists", async () => {
      const db = createMockDB({
        firstFn: () => null,
      });

      const result = await resolvePackageName(db as unknown as D1Database, "@current/pkg");
      expect(result).toBe("@current/pkg");
    });

    it("should query slug_aliases with old_full_name", async () => {
      const db = createMockDB({ firstFn: () => null });
      await resolvePackageName(db as unknown as D1Database, "@scope/name");

      const query = db._executed.find((e) => e.sql.includes("slug_aliases"));
      expect(query).toBeDefined();
      expect(query!.sql).toContain("old_full_name = ?");
      expect(query!.params[0]).toBe("@scope/name");
    });
  });

  describe("resolveScope", () => {
    it("should return canonical scope when alias exists", async () => {
      const db = createMockDB({
        firstFn: (sql, params) => {
          if (sql.includes("scope_aliases") && params[0] === "old-scope") {
            return { new_scope: "new-scope" };
          }
          return null;
        },
      });

      const result = await resolveScope(db as unknown as D1Database, "old-scope");
      expect(result).toBe("new-scope");
    });

    it("should return input when no alias exists", async () => {
      const db = createMockDB({ firstFn: () => null });

      const result = await resolveScope(db as unknown as D1Database, "current-scope");
      expect(result).toBe("current-scope");
    });

    it("should query scope_aliases with old_scope", async () => {
      const db = createMockDB({ firstFn: () => null });
      await resolveScope(db as unknown as D1Database, "my-scope");

      const query = db._executed.find((e) => e.sql.includes("scope_aliases"));
      expect(query).toBeDefined();
      expect(query!.sql).toContain("old_scope = ?");
      expect(query!.params[0]).toBe("my-scope");
    });
  });

  describe("flattenPackageAliasChains", () => {
    it("should update slug_aliases where new_full_name matches old name", async () => {
      const db = createMockDB({ runChanges: 2 });
      const changes = await flattenPackageAliasChains(
        db as unknown as D1Database,
        "@old/pkg",
        "@new/pkg",
      );

      expect(changes).toBe(2);
      const update = db._executed.find((e) => e.sql.includes("UPDATE slug_aliases"));
      expect(update).toBeDefined();
      expect(update!.sql).toContain("SET new_full_name = ?");
      expect(update!.sql).toContain("WHERE new_full_name = ?");
      expect(update!.params[0]).toBe("@new/pkg");
      expect(update!.params[1]).toBe("@old/pkg");
    });

    it("should return 0 when no chains to flatten", async () => {
      const db = createMockDB({ runChanges: 0 });
      const changes = await flattenPackageAliasChains(
        db as unknown as D1Database,
        "@a/b",
        "@c/d",
      );
      expect(changes).toBe(0);
    });
  });

  describe("flattenScopeAliasChains", () => {
    it("should update scope_aliases where new_scope matches old scope", async () => {
      const db = createMockDB({ runChanges: 3 });
      const changes = await flattenScopeAliasChains(
        db as unknown as D1Database,
        "old-scope",
        "new-scope",
      );

      expect(changes).toBe(3);
      const update = db._executed.find((e) => e.sql.includes("UPDATE scope_aliases"));
      expect(update).toBeDefined();
      expect(update!.sql).toContain("SET new_scope = ?");
      expect(update!.sql).toContain("WHERE new_scope = ?");
      expect(update!.params[0]).toBe("new-scope");
      expect(update!.params[1]).toBe("old-scope");
    });

    it("should return 0 when no chains exist", async () => {
      const db = createMockDB({ runChanges: 0 });
      const changes = await flattenScopeAliasChains(
        db as unknown as D1Database,
        "a",
        "b",
      );
      expect(changes).toBe(0);
    });
  });

  describe("createPackageAlias", () => {
    it("should INSERT OR REPLACE into slug_aliases", async () => {
      const db = createMockDB();
      await createPackageAlias(db as unknown as D1Database, "@old/pkg", "@new/pkg");

      const insert = db._executed.find((e) => e.sql.includes("INSERT OR REPLACE INTO slug_aliases"));
      expect(insert).toBeDefined();
      expect(insert!.params[0]).toBe("@old/pkg");
      expect(insert!.params[1]).toBe("@new/pkg");
    });

    it("should handle re-rename of same old name", async () => {
      const db = createMockDB();

      // First rename
      await createPackageAlias(db as unknown as D1Database, "@a/b", "@c/d");
      // Second rename (same old name, new target)
      await createPackageAlias(db as unknown as D1Database, "@a/b", "@e/f");

      const inserts = db._executed.filter((e) => e.sql.includes("INSERT OR REPLACE"));
      expect(inserts.length).toBe(2);
      expect(inserts[1].params[1]).toBe("@e/f");
    });
  });

  describe("createScopeAlias", () => {
    it("should INSERT OR REPLACE into scope_aliases", async () => {
      const db = createMockDB();
      await createScopeAlias(db as unknown as D1Database, "old-scope", "new-scope");

      const insert = db._executed.find((e) => e.sql.includes("INSERT OR REPLACE INTO scope_aliases"));
      expect(insert).toBeDefined();
      expect(insert!.params[0]).toBe("old-scope");
      expect(insert!.params[1]).toBe("new-scope");
    });

    it("should handle re-rename of same old scope", async () => {
      const db = createMockDB();

      await createScopeAlias(db as unknown as D1Database, "alpha", "beta");
      await createScopeAlias(db as unknown as D1Database, "alpha", "gamma");

      const inserts = db._executed.filter((e) => e.sql.includes("INSERT OR REPLACE INTO scope_aliases"));
      expect(inserts.length).toBe(2);
      expect(inserts[1].params[1]).toBe("gamma");
    });
  });
});

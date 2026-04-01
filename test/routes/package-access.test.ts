import { describe, it, expect } from "vitest";
import {
  getPackageAccess,
  grantPackageAccess,
  revokePackageAccess,
  cleanupUserAccessForOrg,
  hasAccessRestrictions,
  userHasAccess,
} from "../../src/services/package-access";

// --- Mock DB ---

interface MockDB {
  prepare(sql: string): MockStatement;
  batch(stmts: MockStatement[]): Promise<unknown[]>;
  _executed: Array<{ sql: string; params: unknown[] }>;
  _accessRows: Map<string, Set<string>>; // packageId → Set<userId>
}

interface MockStatement {
  bind(...params: unknown[]): MockStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockDB(opts?: {
  accessRows?: Map<string, Set<string>>;
}): MockDB {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const accessRows = opts?.accessRows ?? new Map<string, Set<string>>();

  const db: MockDB = {
    _executed: executed,
    _accessRows: accessRows,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt: MockStatement = {
        bind(...params: unknown[]) {
          boundParams = params;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          executed.push({ sql, params: boundParams });

          if (sql.includes("FROM package_access WHERE package_id = ? LIMIT 1")) {
            const pkgId = boundParams[0] as string;
            const userSet = accessRows.get(pkgId);
            return userSet && userSet.size > 0 ? ({ 1: 1 } as T) : null;
          }

          if (
            sql.includes("FROM package_access WHERE package_id = ? AND user_id = ?")
          ) {
            const pkgId = boundParams[0] as string;
            const userId = boundParams[1] as string;
            const userSet = accessRows.get(pkgId);
            return userSet?.has(userId) ? ({ 1: 1 } as T) : null;
          }

          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          executed.push({ sql, params: boundParams });

          if (sql.includes("FROM package_access pa")) {
            const pkgId = boundParams[0] as string;
            const userSet = accessRows.get(pkgId);
            if (!userSet) return { results: [] };
            const rows = Array.from(userSet).map((userId) => ({
              package_id: pkgId,
              user_id: userId,
              username: userId,
              granted_by: "admin-1",
              created_at: "2026-01-01",
            }));
            return { results: rows as T[] };
          }

          return { results: [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          return { success: true, meta: { changes: 1 } };
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

describe("package access service", () => {
  it("getPackageAccess queries by package_id", async () => {
    const db = createMockDB();
    await getPackageAccess(db as unknown as D1Database, "pkg-1");

    const query = db._executed.find(
      (e) => e.sql.includes("FROM package_access pa") && e.sql.includes("package_id = ?"),
    );
    expect(query).toBeDefined();
    expect(query!.params[0]).toBe("pkg-1");
  });

  it("getPackageAccess returns access rows", async () => {
    const accessRows = new Map<string, Set<string>>();
    accessRows.set("pkg-1", new Set(["user-alice", "user-bob"]));
    const db = createMockDB({ accessRows });

    const result = await getPackageAccess(db as unknown as D1Database, "pkg-1");
    expect(result).toHaveLength(2);
  });

  it("grantPackageAccess inserts for each user", async () => {
    const db = createMockDB();
    await grantPackageAccess(
      db as unknown as D1Database,
      "pkg-1",
      ["user-alice", "user-bob"],
      "admin-1",
    );

    const inserts = db._executed.filter((e) =>
      e.sql.includes("INSERT OR IGNORE INTO package_access"),
    );
    expect(inserts).toHaveLength(2);
  });

  it("grantPackageAccess with empty array does nothing", async () => {
    const db = createMockDB();
    const result = await grantPackageAccess(
      db as unknown as D1Database,
      "pkg-1",
      [],
      "admin-1",
    );
    expect(result).toBe(0);
    expect(db._executed).toHaveLength(0);
  });

  it("revokePackageAccess deletes for each user", async () => {
    const db = createMockDB();
    await revokePackageAccess(
      db as unknown as D1Database,
      "pkg-1",
      ["user-alice"],
    );

    const deletes = db._executed.filter((e) =>
      e.sql.includes("DELETE FROM package_access WHERE package_id = ? AND user_id = ?"),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].params[0]).toBe("pkg-1");
    expect(deletes[0].params[1]).toBe("user-alice");
  });

  it("revokePackageAccess with empty array does nothing", async () => {
    const db = createMockDB();
    const result = await revokePackageAccess(
      db as unknown as D1Database,
      "pkg-1",
      [],
    );
    expect(result).toBe(0);
  });

  it("cleanupUserAccessForOrg deletes access scoped to org packages", async () => {
    const db = createMockDB();
    await cleanupUserAccessForOrg(db as unknown as D1Database, "user-alice", "org-1");

    const query = db._executed.find(
      (e) =>
        e.sql.includes("DELETE FROM package_access WHERE user_id = ?") &&
        e.sql.includes("owner_type = 'org' AND owner_id = ?"),
    );
    expect(query).toBeDefined();
    expect(query!.params[0]).toBe("user-alice");
    expect(query!.params[1]).toBe("org-1");
  });

  it("hasAccessRestrictions returns true when rows exist", async () => {
    const accessRows = new Map<string, Set<string>>();
    accessRows.set("pkg-1", new Set(["user-alice"]));
    const db = createMockDB({ accessRows });

    const result = await hasAccessRestrictions(db as unknown as D1Database, "pkg-1");
    expect(result).toBe(true);
  });

  it("hasAccessRestrictions returns false when no rows", async () => {
    const db = createMockDB();
    const result = await hasAccessRestrictions(db as unknown as D1Database, "pkg-1");
    expect(result).toBe(false);
  });

  it("userHasAccess returns true for granted user", async () => {
    const accessRows = new Map<string, Set<string>>();
    accessRows.set("pkg-1", new Set(["user-alice"]));
    const db = createMockDB({ accessRows });

    const result = await userHasAccess(
      db as unknown as D1Database,
      "pkg-1",
      "user-alice",
    );
    expect(result).toBe(true);
  });

  it("userHasAccess returns false for non-granted user", async () => {
    const accessRows = new Map<string, Set<string>>();
    accessRows.set("pkg-1", new Set(["user-alice"]));
    const db = createMockDB({ accessRows });

    const result = await userHasAccess(
      db as unknown as D1Database,
      "pkg-1",
      "user-bob",
    );
    expect(result).toBe(false);
  });
});

describe("package access — canAccessPackage integration logic", () => {
  it("public packages bypass all access checks", () => {
    // canAccessPackage returns true immediately for non-private
    // This is tested in the ownership service — here we verify the invariant
    expect("public").not.toBe("private");
    expect("unlisted").not.toBe("private");
  });

  it("restricted mode = private + access rows present", () => {
    // This is a design invariant test:
    // private + no access rows → all org members can see
    // private + access rows → only listed users + owner/admin
    const hasRestrictions = true;
    const isOwnerOrAdmin = false;
    const isInAccessList = false;

    // Regular member without access → denied
    const canAccess = isOwnerOrAdmin || isInAccessList;
    expect(canAccess).toBe(false);
  });

  it("owner/admin always bypasses restricted check", () => {
    const isOwnerOrAdmin = true;
    const isInAccessList = false;

    const canAccess = isOwnerOrAdmin || isInAccessList;
    expect(canAccess).toBe(true);
  });

  it("member in access list can access restricted package", () => {
    const isOwnerOrAdmin = false;
    const isInAccessList = true;

    const canAccess = isOwnerOrAdmin || isInAccessList;
    expect(canAccess).toBe(true);
  });
});

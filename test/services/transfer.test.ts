import { describe, it, expect } from "vitest";
import {
  createTransferRequest,
  acceptTransfer,
  declineTransfer,
  cancelTransfer,
  listIncomingTransfers,
  expirePendingTransfers,
  cancelPackageTransfers,
} from "../../src/services/transfer";

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

describe("transfer service", () => {
  describe("createTransferRequest", () => {
    it("should create a request with xfer- prefix", async () => {
      const db = createMockDB();
      const result = await createTransferRequest(
        db as unknown as D1Database,
        "pkg-1",
        "pub-from",
        "pub-to",
        "user-1",
        "Please accept",
      );

      expect(result.id).toMatch(/^xfer-/);
      expect(result.package_id).toBe("pkg-1");
      expect(result.from_publisher_id).toBe("pub-from");
      expect(result.to_publisher_id).toBe("pub-to");
      expect(result.initiated_by).toBe("user-1");
      expect(result.status).toBe("pending");
      expect(result.message).toBe("Please accept");
      expect(result.resolved_at).toBeNull();
      expect(result.resolved_by).toBeNull();
    });

    it("should set 14-day expiry", async () => {
      const db = createMockDB();
      const result = await createTransferRequest(
        db as unknown as D1Database,
        "pkg-1",
        "pub-from",
        "pub-to",
        "user-1",
      );

      // expires_at should be ~14 days after created_at (both in UTC SQLite format)
      const createdMs = new Date(result.created_at + "Z").getTime();
      const expiryMs = new Date(result.expires_at + "Z").getTime();
      const diffDays = (expiryMs - createdMs) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBeCloseTo(14, 0);
    });

    it("should insert into transfer_requests table", async () => {
      const db = createMockDB();
      await createTransferRequest(
        db as unknown as D1Database,
        "pkg-1",
        "pub-from",
        "pub-to",
        "user-1",
      );

      const insert = db._executed.find((e) => e.sql.includes("INSERT INTO transfer_requests"));
      expect(insert).toBeDefined();
      expect(insert!.params[1]).toBe("pkg-1");
      expect(insert!.params[2]).toBe("pub-from");
      expect(insert!.params[3]).toBe("pub-to");
      expect(insert!.params[4]).toBe("user-1");
    });

    it("should default message to empty string", async () => {
      const db = createMockDB();
      const result = await createTransferRequest(
        db as unknown as D1Database,
        "pkg-1",
        "pub-from",
        "pub-to",
        "user-1",
      );
      expect(result.message).toBe("");
    });
  });

  describe("acceptTransfer", () => {
    it("should return null for non-existent transfer", async () => {
      const db = createMockDB({ firstFn: () => null });
      const result = await acceptTransfer(db as unknown as D1Database, "xfer-nope", "user-1");
      expect(result).toBeNull();
    });

    it("should return null for non-pending transfer", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM transfer_requests")) {
            return {
              id: "xfer-1",
              status: "declined",
              package_id: "pkg-1",
              from_publisher_id: "pub-from",
              to_publisher_id: "pub-to",
              expires_at: new Date(Date.now() + 86400000).toISOString(),
            };
          }
          return null;
        },
      });

      const result = await acceptTransfer(db as unknown as D1Database, "xfer-1", "user-1");
      expect(result).toBeNull();
    });

    it("should return null and expire if transfer is past due", async () => {
      const db = createMockDB({
        firstFn: (sql) => {
          if (sql.includes("FROM transfer_requests")) {
            return {
              id: "xfer-1",
              status: "pending",
              package_id: "pkg-1",
              from_publisher_id: "pub-from",
              to_publisher_id: "pub-to",
              expires_at: "2020-01-01 00:00:00", // past date
            };
          }
          return null;
        },
      });

      const result = await acceptTransfer(db as unknown as D1Database, "xfer-1", "user-1");
      expect(result).toBeNull();

      // Should have updated status to expired
      const expireUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE transfer_requests") && e.sql.includes("expired"),
      );
      expect(expireUpdate).toBeDefined();
    });

    it("should execute conditional UPDATE pattern for race prevention", async () => {
      const db = createMockDB({
        firstFn: (sql, params) => {
          if (sql.includes("FROM transfer_requests")) {
            return {
              id: "xfer-1",
              status: "pending",
              package_id: "pkg-1",
              from_publisher_id: "pub-from",
              to_publisher_id: "pub-to",
              initiated_by: "user-1",
              message: "",
              expires_at: new Date(Date.now() + 86400000).toISOString(),
              created_at: "2026-03-28 00:00:00",
              resolved_at: null,
              resolved_by: null,
            };
          }
          if (sql.includes("FROM publishers")) {
            return { id: "pub-to", kind: "user", user_id: "user-2", org_id: null, slug: "bob" };
          }
          if (sql.includes("FROM packages") && sql.includes("full_name = ?")) {
            return null; // no collision
          }
          if (sql.includes("FROM packages")) {
            return { id: "pkg-1", full_name: "@alice/tool", name: "tool", scope: "alice" };
          }
          if (sql.includes("FROM scopes")) {
            return { name: "bob" }; // scope exists
          }
          return null;
        },
      });

      const result = await acceptTransfer(db as unknown as D1Database, "xfer-1", "user-2");

      // Check that conditional UPDATE was issued
      const conditionalUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE transfer_requests") && e.sql.includes("status = 'pending'") && e.sql.includes("'accepted'"),
      );
      expect(conditionalUpdate).toBeDefined();
    });

    it("should update package scope and create alias on accept", async () => {
      const db = createMockDB({
        firstFn: (sql, params) => {
          if (sql.includes("FROM transfer_requests")) {
            return {
              id: "xfer-1",
              status: "pending",
              package_id: "pkg-1",
              from_publisher_id: "pub-from",
              to_publisher_id: "pub-to",
              initiated_by: "user-1",
              message: "",
              expires_at: new Date(Date.now() + 86400000).toISOString(),
              created_at: "2026-03-28 00:00:00",
              resolved_at: null,
              resolved_by: null,
            };
          }
          if (sql.includes("FROM publishers")) {
            return { id: "pub-to", kind: "user", user_id: "user-2", org_id: null, slug: "bob" };
          }
          if (sql.includes("FROM packages") && sql.includes("full_name = ?")) {
            return null; // no collision
          }
          if (sql.includes("FROM packages")) {
            return { id: "pkg-1", full_name: "@alice/tool", name: "tool", scope: "alice" };
          }
          if (sql.includes("FROM scopes")) {
            return { name: "bob" };
          }
          return null;
        },
      });

      const result = await acceptTransfer(db as unknown as D1Database, "xfer-1", "user-2");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("accepted");
      expect(result!.resolved_by).toBe("user-2");

      // Should have batch with package update, alias, search_digest, and package_access cleanup
      const packageUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE packages SET scope"),
      );
      expect(packageUpdate).toBeDefined();

      const aliasInsert = db._executed.find(
        (e) => e.sql.includes("INSERT OR REPLACE INTO slug_aliases"),
      );
      expect(aliasInsert).toBeDefined();

      const searchUpdate = db._executed.find(
        (e) => e.sql.includes("UPDATE search_digest"),
      );
      expect(searchUpdate).toBeDefined();

      const accessDelete = db._executed.find(
        (e) => e.sql.includes("DELETE FROM package_access"),
      );
      expect(accessDelete).toBeDefined();
    });

    it("should create scope if target scope does not exist", async () => {
      const db = createMockDB({
        firstFn: (sql, params) => {
          if (sql.includes("FROM transfer_requests")) {
            return {
              id: "xfer-1",
              status: "pending",
              package_id: "pkg-1",
              from_publisher_id: "pub-from",
              to_publisher_id: "pub-to",
              initiated_by: "user-1",
              message: "",
              expires_at: new Date(Date.now() + 86400000).toISOString(),
              created_at: "2026-03-28 00:00:00",
              resolved_at: null,
              resolved_by: null,
            };
          }
          if (sql.includes("FROM publishers")) {
            return { id: "pub-to", kind: "user", user_id: "user-2", org_id: null, slug: "newuser" };
          }
          if (sql.includes("FROM packages") && sql.includes("full_name = ?")) {
            return null; // no collision
          }
          if (sql.includes("FROM packages")) {
            return { id: "pkg-1", full_name: "@alice/tool", name: "tool", scope: "alice" };
          }
          if (sql.includes("FROM scopes")) {
            return null; // scope does not exist
          }
          return null;
        },
      });

      await acceptTransfer(db as unknown as D1Database, "xfer-1", "user-2");

      const scopeInsert = db._executed.find(
        (e) => e.sql.includes("INSERT INTO scopes"),
      );
      expect(scopeInsert).toBeDefined();
    });
  });

  describe("declineTransfer", () => {
    it("should set status to declined", async () => {
      const db = createMockDB({ runChanges: 1 });
      const result = await declineTransfer(db as unknown as D1Database, "xfer-1", "user-2");

      expect(result).toBe(true);
      const update = db._executed.find(
        (e) => e.sql.includes("UPDATE transfer_requests") && e.sql.includes("declined"),
      );
      expect(update).toBeDefined();
      expect(update!.params[0]).toBe("user-2");
      expect(update!.params[1]).toBe("xfer-1");
    });

    it("should return false when no pending transfer found", async () => {
      const db = createMockDB({ runChanges: 0 });
      const result = await declineTransfer(db as unknown as D1Database, "xfer-none", "user-2");
      expect(result).toBe(false);
    });
  });

  describe("cancelTransfer", () => {
    it("should set status to cancelled by package_id", async () => {
      const db = createMockDB({ runChanges: 1 });
      const result = await cancelTransfer(db as unknown as D1Database, "pkg-1", "user-1");

      expect(result).toBe(true);
      const update = db._executed.find(
        (e) => e.sql.includes("UPDATE transfer_requests") && e.sql.includes("cancelled"),
      );
      expect(update).toBeDefined();
      expect(update!.params[0]).toBe("user-1");
      expect(update!.params[1]).toBe("pkg-1");
      expect(update!.sql).toContain("package_id = ?");
    });

    it("should return false when no pending transfer for package", async () => {
      const db = createMockDB({ runChanges: 0 });
      const result = await cancelTransfer(db as unknown as D1Database, "pkg-none", "user-1");
      expect(result).toBe(false);
    });
  });

  describe("listIncomingTransfers", () => {
    it("should expire pending transfers before listing", async () => {
      const db = createMockDB();
      await listIncomingTransfers(db as unknown as D1Database, "user-1");

      // First executed should be the expire query
      const expireQuery = db._executed.find(
        (e) => e.sql.includes("UPDATE transfer_requests") && e.sql.includes("expired"),
      );
      expect(expireQuery).toBeDefined();
    });

    it("should query with user-based join for user publishers and org owners", async () => {
      const db = createMockDB();
      await listIncomingTransfers(db as unknown as D1Database, "user-1");

      const selectQuery = db._executed.find(
        (e) => e.sql.includes("SELECT t.*") && e.sql.includes("transfer_requests"),
      );
      expect(selectQuery).toBeDefined();
      expect(selectQuery!.sql).toContain("tp.user_id = ?");
      expect(selectQuery!.sql).toContain("org_members");
      expect(selectQuery!.params[0]).toBe("user-1");
      expect(selectQuery!.params[1]).toBe("user-1");
    });

    it("should return empty array when no transfers", async () => {
      const db = createMockDB();
      const result = await listIncomingTransfers(db as unknown as D1Database, "user-1");
      expect(result).toEqual([]);
    });

    it("should return transfers with package and publisher info", async () => {
      const db = createMockDB({
        allFn: (sql) => {
          if (sql.includes("transfer_requests") && sql.includes("SELECT t.*")) {
            return [
              {
                id: "xfer-1",
                package_id: "pkg-1",
                from_publisher_id: "pub-1",
                to_publisher_id: "pub-2",
                status: "pending",
                package_name: "@alice/tool",
                from_slug: "alice",
                to_slug: "bob",
              },
            ];
          }
          return [];
        },
      });

      const result = await listIncomingTransfers(db as unknown as D1Database, "user-1");
      expect(result.length).toBe(1);
      expect(result[0].package_name).toBe("@alice/tool");
      expect(result[0].from_slug).toBe("alice");
    });
  });

  describe("expirePendingTransfers", () => {
    it("should bulk expire past-due transfers", async () => {
      const db = createMockDB({ runChanges: 3 });
      const count = await expirePendingTransfers(db as unknown as D1Database);

      expect(count).toBe(3);
      const update = db._executed.find(
        (e) => e.sql.includes("UPDATE transfer_requests") && e.sql.includes("expired") && e.sql.includes("expires_at < datetime"),
      );
      expect(update).toBeDefined();
    });

    it("should return 0 when nothing to expire", async () => {
      const db = createMockDB({ runChanges: 0 });
      const count = await expirePendingTransfers(db as unknown as D1Database);
      expect(count).toBe(0);
    });
  });

  describe("cancelPackageTransfers", () => {
    it("should cancel all pending transfers for a package", async () => {
      const db = createMockDB();
      await cancelPackageTransfers(db as unknown as D1Database, "pkg-1");

      const update = db._executed.find(
        (e) => e.sql.includes("UPDATE transfer_requests") && e.sql.includes("cancelled"),
      );
      expect(update).toBeDefined();
      expect(update!.sql).toContain("package_id = ?");
      expect(update!.sql).toContain("status = 'pending'");
      expect(update!.params[0]).toBe("pkg-1");
    });
  });
});

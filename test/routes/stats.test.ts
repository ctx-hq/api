import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";

// Mock Cache API for telemetry rate limiting
function createMockCacheStore() {
  const store = new Map<string, string>();
  return {
    _store: store,
    async match(req: string | Request) {
      const url = typeof req === "string" ? req : req.url;
      const val = store.get(url);
      return val != null ? new Response(val) : undefined;
    },
    async put(req: string | Request, res: Response) {
      const url = typeof req === "string" ? req : req.url;
      store.set(url, await res.text());
    },
    async delete(req: string | Request) {
      const url = typeof req === "string" ? req : req.url;
      return store.delete(url);
    },
  };
}

let mockCacheStore: ReturnType<typeof createMockCacheStore>;

beforeEach(() => {
  mockCacheStore = createMockCacheStore();
  (globalThis as any).caches = { default: mockCacheStore };
});

afterEach(() => {
  delete (globalThis as any).caches;
});

// --- Mock DB ---

interface MockDB {
  prepare(sql: string): MockStatement;
  batch(stmts: MockStatement[]): Promise<unknown[]>;
  _executed: Array<{ sql: string; params: unknown[] }>;
}

interface MockStatement {
  bind(...params: unknown[]): MockStatement;
  first<T = unknown>(): Promise<T | null>;
  all(): Promise<{ results: unknown[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockDB(overrides?: {
  firstFn?: (sql: string, params: unknown[]) => unknown | null;
  allFn?: (sql: string, params: unknown[]) => unknown[];
}): MockDB {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const db: MockDB = {
    _executed: executed,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt: MockStatement = {
        bind(...params: unknown[]) { boundParams = params; return stmt; },
        async first<T>(): Promise<T | null> {
          executed.push({ sql, params: boundParams });
          return (overrides?.firstFn?.(sql, boundParams) as T) ?? null;
        },
        async all() {
          executed.push({ sql, params: boundParams });
          return { results: overrides?.allFn?.(sql, boundParams) ?? [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts: MockStatement[]) {
      return Promise.all(stmts.map(s => s.run()));
    },
  };
  return db;
}

// --- Import the actual route handler ---
import statsApp from "../../src/routes/stats";

// --- Build test app that mounts the real stats routes ---

function createStatsApp(dbOverrides?: Parameters<typeof createMockDB>[0]) {
  const db = createMockDB(dbOverrides);

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
    };
    await next();
  });
  app.route("/", statsApp);

  const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const request: typeof app.request = (input, init, env) =>
    app.request(input, init, env, mockExecCtx as any);

  return { app, db, request };
}

// --- Tests ---

describe("stats routes", () => {
  describe("GET /v1/stats/overview", () => {
    it("should return overview with correct structure", async () => {
      const { request } = createStatsApp({
        firstFn: (sql) => {
          if (sql.includes("COUNT(*)") && sql.includes("FROM packages")) {
            return { count: 42 };
          }
          if (sql.includes("SUM(ds.count)") && sql.includes("download_stats")) {
            return { total: 1500 };
          }
          if (sql.includes("COUNT(DISTINCT owner_id)")) {
            return { count: 7 };
          }
          return null;
        },
        allFn: (sql) => {
          if (sql.includes("GROUP BY type")) {
            return [
              { type: "skill", count: 30 },
              { type: "mcp", count: 12 },
            ];
          }
          return [];
        },
      });

      const res = await request("/v1/stats/overview");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.total_packages).toBe(42);
      expect(body.total_downloads).toBe(1500);
      expect(body.total_owners).toBe(7);
      expect(body.breakdown).toHaveLength(2);
      expect(body.breakdown[0]).toEqual({
        type: "skill",
        count: 30,
        percentage: 71.4,
      });
    });

    it("should aggregate downloads from download_stats, not packages.downloads", async () => {
      const { request, db } = createStatsApp({
        firstFn: (sql) => {
          if (sql.includes("COUNT(*)")) return { count: 1 };
          if (sql.includes("download_stats")) return { total: 999 };
          if (sql.includes("COUNT(DISTINCT owner_id)")) return { count: 1 };
          return null;
        },
        allFn: () => [],
      });

      const res = await request("/v1/stats/overview");
      const body = await res.json() as any;
      expect(body.total_downloads).toBe(999);

      // Verify the SQL references download_stats, not packages.downloads
      const downloadQuery = db._executed.find(e => e.sql.includes("total"));
      expect(downloadQuery?.sql).toContain("download_stats");
      expect(downloadQuery?.sql).not.toContain("SUM(downloads)");
    });

    it("should exclude system owners from owner count", async () => {
      const { request, db } = createStatsApp({
        firstFn: (sql) => {
          if (sql.includes("COUNT(*)") && !sql.includes("DISTINCT")) return { count: 5 };
          if (sql.includes("download_stats")) return { total: 0 };
          if (sql.includes("COUNT(DISTINCT owner_id)")) {
            // Verify the SQL excludes system owner_type
            expect(sql).toContain("owner_type != 'system'");
            return { count: 3 };
          }
          return null;
        },
        allFn: () => [],
      });

      const res = await request("/v1/stats/overview");
      const body = await res.json() as any;
      expect(body.total_owners).toBe(3);
    });

    it("should return zeros for empty registry", async () => {
      const { request } = createStatsApp({
        firstFn: () => null,
        allFn: () => [],
      });

      const res = await request("/v1/stats/overview");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.total_packages).toBe(0);
      expect(body.total_downloads).toBe(0);
      expect(body.total_owners).toBe(0);
      expect(body.breakdown).toHaveLength(0);
    });

    it("should handle zero total in percentage calculation", async () => {
      const { request } = createStatsApp({
        firstFn: (sql) => {
          if (sql.includes("COUNT(*)")) return { count: 0 };
          if (sql.includes("download_stats")) return { total: 0 };
          if (sql.includes("COUNT(DISTINCT owner_id)")) return { count: 0 };
          return null;
        },
        allFn: (sql) => {
          if (sql.includes("GROUP BY type")) return [{ type: "skill", count: 0 }];
          return [];
        },
      });

      const res = await request("/v1/stats/overview");
      const body = await res.json() as any;
      // With 0 total packages, percentage should be 0
      expect(body.breakdown[0].percentage).toBe(0);
    });
  });

  describe("GET /v1/stats/trending", () => {
    it("should return trending packages", async () => {
      const { request } = createStatsApp({
        allFn: (sql) => {
          if (sql.includes("download_stats") && sql.includes("7 days")) {
            return [
              { package_id: "p1", weekly_downloads: 500, full_name: "@a/b", type: "skill", description: "desc" },
            ];
          }
          return [];
        },
      });

      const res = await request("/v1/stats/trending");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.period).toBe("7d");
      expect(body.packages).toHaveLength(1);
      expect(body.packages[0].weekly_downloads).toBe(500);
    });

    it("should respect limit parameter", async () => {
      const { request, db } = createStatsApp({
        allFn: () => [],
      });

      await request("/v1/stats/trending?limit=5");
      const limitCall = db._executed.find(e => e.sql.includes("download_stats") && e.sql.includes("LIMIT"));
      expect(limitCall?.params[0]).toBe(5);
    });

    it("should cap limit at 100", async () => {
      const { request, db } = createStatsApp({
        allFn: () => [],
      });

      await request("/v1/stats/trending?limit=999");
      const limitCall = db._executed.find(e => e.sql.includes("LIMIT"));
      expect(limitCall?.params[0]).toBe(100);
    });
  });

  describe("GET /v1/stats/agents", () => {
    it("should return agent ranking", async () => {
      const { request } = createStatsApp({
        allFn: (sql) => {
          if (sql.includes("agent_installs") && sql.includes("GROUP BY agent_name")) {
            return [
              { name: "claude", total_installs: 1000, packages: 50 },
              { name: "cursor", total_installs: 800, packages: 40 },
            ];
          }
          return [];
        },
      });

      const res = await request("/v1/stats/agents");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.agents).toHaveLength(2);
      expect(body.agents[0].name).toBe("claude");
    });
  });

  describe("POST /v1/telemetry/install", () => {
    it("should accept valid telemetry and write to download_stats", async () => {
      const { request, db } = createStatsApp({
        firstFn: (sql) => {
          if (sql.includes("FROM packages")) {
            return { id: "pkg-1", visibility: "public" };
          }
          return null;
        },
      });

      const res = await request("/v1/telemetry/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: "@scope/name", version: "1.0.0", agents: ["claude"] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });

    it("should not track private packages", async () => {
      const { request, db } = createStatsApp({
        firstFn: (sql) => {
          if (sql.includes("FROM packages")) {
            return { id: "pkg-1", visibility: "private" };
          }
          return null;
        },
      });

      const res = await request("/v1/telemetry/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: "@scope/private-pkg" }),
      });

      expect(res.status).toBe(200);
      // Should not have written to download_stats
      const downloadWrites = db._executed.filter(e => e.sql.includes("download_stats"));
      expect(downloadWrites).toHaveLength(0);
    });

    it("should silently accept malformed body", async () => {
      const { request } = createStatsApp();

      const res = await request("/v1/telemetry/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      expect(res.status).toBe(200);
    });

    it("should silently accept missing package field", async () => {
      const { request } = createStatsApp();

      const res = await request("/v1/telemetry/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "1.0.0" }),
      });

      expect(res.status).toBe(200);
    });

    it("should silently drop telemetry after 60 requests per IP", async () => {
      // Pre-fill cache counter to 60
      const key = `https://rate-limit.internal/${encodeURIComponent("rl:telemetry:10.0.0.1")}`;
      mockCacheStore._store.set(key, "60");

      const { request, db } = createStatsApp({
        firstFn: (sql) => {
          if (sql.includes("FROM packages")) return { id: "pkg-1", visibility: "public" };
          return null;
        },
      });

      const res = await request("/v1/telemetry/install", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.1",
        },
        body: JSON.stringify({ package: "@scope/name", version: "1.0.0" }),
      });

      expect(res.status).toBe(200);
      // Should not have written to DB — request was silently dropped
      const downloadWrites = db._executed.filter(e => e.sql.includes("download_stats"));
      expect(downloadWrites).toHaveLength(0);
    });

    it("should fail-open when Cache API is unavailable", async () => {
      // Remove caches global
      delete (globalThis as any).caches;

      const { request, db } = createStatsApp({
        firstFn: (sql) => {
          if (sql.includes("FROM packages")) return { id: "pkg-1", visibility: "public" };
          return null;
        },
      });

      const res = await request("/v1/telemetry/install", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.1",
        },
        body: JSON.stringify({ package: "@scope/name", version: "1.0.0" }),
      });

      expect(res.status).toBe(200);
      // Should still process the telemetry (fail-open)
      const downloadWrites = db._executed.filter(e => e.sql.includes("download_stats"));
      expect(downloadWrites.length).toBeGreaterThan(0);
    });
  });
});

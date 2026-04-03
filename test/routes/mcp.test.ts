import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";

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

// --- Import routes ---

import mcpApp from "../../src/routes/mcp";

function createMCPApp(dbOverrides?: Parameters<typeof createMockDB>[0]) {
  const db = createMockDB(dbOverrides);

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
    };
    await next();
  });
  app.route("/", mcpApp);
  // Handle AppError (notFound throws AppError with statusCode)
  app.onError((err: any, c) => {
    const status = err.statusCode ?? 500;
    return c.json({ error: err.message ?? "internal error" }, status);
  });

  const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const request: typeof app.request = (input, init, env) =>
    app.request(input, init, env, mockExecCtx as any);

  return { app, db, request };
}

// --- Tests ---

describe("MCP Hub routes", () => {
  describe("GET /v1/mcp/hub", () => {
    it("returns servers and categories", async () => {
      const { request } = createMCPApp({
        firstFn: (sql) => {
          if (sql.includes("COUNT(*)")) return { count: 2 };
          return null;
        },
        allFn: (sql) => {
          if (sql.includes("p.full_name") && sql.includes("LIMIT")) {
            return [
              {
                full_name: "@test/mcp-a",
                description: "Test MCP A",
                downloads: 100,
                created_at: "2025-01-01",
                transport: "stdio",
                tools: '["search","create"]',
                category: "database",
                owner_slug: "test",
                version: "1.0.0",
              },
            ];
          }
          if (sql.includes("GROUP BY mm.category")) {
            return [
              { category: "database", count: 5 },
              { category: "search", count: 3 },
            ];
          }
          return [];
        },
      });

      const res = await request("/v1/mcp/hub");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.servers).toHaveLength(1);
      expect(body.servers[0].full_name).toBe("@test/mcp-a");
      expect(body.servers[0].transport).toBe("stdio");
      expect(body.servers[0].tools_count).toBe(2);
      expect(body.total).toBe(2);
      expect(body.categories).toHaveLength(2);
    });

    it("filters by category", async () => {
      const { request, db } = createMCPApp({
        firstFn: () => ({ count: 1 }),
        allFn: () => [],
      });

      await request("/v1/mcp/hub?category=database");

      const hubQuery = db._executed.find(e => e.sql.includes("LIMIT") && e.sql.includes("mm.category"));
      expect(hubQuery).toBeDefined();
      expect(hubQuery!.params).toContain("database");
    });

    it("paginates correctly", async () => {
      const { request, db } = createMCPApp({
        firstFn: () => ({ count: 50 }),
        allFn: () => [],
      });

      await request("/v1/mcp/hub?limit=10&offset=20");

      const hubQuery = db._executed.find(e => e.sql.includes("LIMIT"));
      expect(hubQuery).toBeDefined();
      expect(hubQuery!.params).toContain(10);
      expect(hubQuery!.params).toContain(20);
    });
  });

  describe("GET /v1/mcp/featured", () => {
    it("returns top 6 servers", async () => {
      const { request } = createMCPApp({
        allFn: (sql) => {
          if (sql.includes("LIMIT 6")) {
            return [
              { full_name: "@test/top1", description: "Top 1", downloads: 500, transport: "stdio", tools: "[]", category: "database", owner_slug: "pub", version: "2.0.0" },
              { full_name: "@test/top2", description: "Top 2", downloads: 300, transport: "http", tools: '["fetch"]', category: "search", owner_slug: "", version: "1.0.0" },
            ];
          }
          return [];
        },
      });

      const res = await request("/v1/mcp/featured");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.servers).toHaveLength(2);
      expect(body.servers[0].full_name).toBe("@test/top1");
      expect(body.servers[1].tools_count).toBe(1);
    });
  });

  describe("GET /v1/mcp/categories", () => {
    it("returns categories with counts", async () => {
      const { request } = createMCPApp({
        allFn: (sql) => {
          if (sql.includes("GROUP BY mm.category")) {
            return [
              { category: "database", count: 10 },
              { category: "browser", count: 5 },
            ];
          }
          return [];
        },
      });

      const res = await request("/v1/mcp/categories");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.categories).toHaveLength(2);
      expect(body.categories[0].slug).toBe("database");
      expect(body.categories[0].name).toBe("Database");
      expect(body.categories[0].count).toBe(10);
    });

    it("filters out empty category slug", async () => {
      const { request } = createMCPApp({
        allFn: (sql) => {
          if (sql.includes("GROUP BY")) {
            return [
              { category: "", count: 3 },
              { category: "database", count: 7 },
            ];
          }
          return [];
        },
      });

      const res = await request("/v1/mcp/categories");
      const body = await res.json() as any;
      expect(body.categories).toHaveLength(1);
      expect(body.categories[0].slug).toBe("database");
    });
  });

  describe("GET /v1/packages/:fullName/server.json", () => {
    it("returns valid server.json for MCP package", async () => {
      const { request } = createMCPApp({
        firstFn: (sql, params) => {
          if (sql.includes("FROM packages")) {
            return { id: "pkg1", full_name: "@test/my-mcp", type: "mcp", description: "A test MCP", repository: "https://github.com/test/my-mcp", homepage: "" };
          }
          if (sql.includes("mcp_metadata")) {
            return { version: "1.2.0", transport: "stdio", command: "npx", args: '["-y","@test/my-mcp"]', url: "", env_vars: '[{"name":"API_KEY"}]', tools: '["search","create"]', resources: "[]" };
          }
          return null;
        },
      });

      const res = await request(`/v1/packages/${encodeURIComponent("@test/my-mcp")}/server.json`);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.name).toBe("@test/my-mcp");
      expect(body.description).toBe("A test MCP");
      expect(body.version).toBe("1.2.0");
      expect(body.packages).toHaveLength(1);
      expect(body.packages[0].command).toBe("npx");
      expect(body.tools).toEqual(["search", "create"]);
      expect(body.env).toEqual([{ name: "API_KEY" }]);
    });

    it("returns 404 for non-MCP package", async () => {
      const { request } = createMCPApp({
        firstFn: (sql) => {
          if (sql.includes("FROM packages")) {
            return { id: "pkg2", full_name: "@test/skill-pkg", type: "skill", description: "A skill" };
          }
          return null;
        },
      });

      const res = await request(`/v1/packages/${encodeURIComponent("@test/skill-pkg")}/server.json`);
      expect(res.status).toBe(404);
    });

    it("returns 404 for nonexistent package", async () => {
      const { request } = createMCPApp();

      const res = await request(`/v1/packages/${encodeURIComponent("@test/missing")}/server.json`);
      expect(res.status).toBe(404);
    });

    it("includes additional transports in packages[]", async () => {
      const transports = JSON.stringify([
        { id: "remote", transport: "streamable-http", url: "https://api.example.com/mcp/" },
      ]);
      const { request } = createMCPApp({
        firstFn: (sql) => {
          if (sql.includes("FROM packages")) {
            return { id: "pkg3", full_name: "@mcp/github", type: "mcp", description: "GitHub MCP", repository: "", homepage: "" };
          }
          if (sql.includes("mcp_metadata")) {
            return {
              version: "0.2.0",
              transport: "stdio",
              command: "docker",
              args: '["run","-i","ghcr.io/github/github-mcp-server"]',
              url: "",
              env_vars: '[{"name":"GITHUB_TOKEN","required":true}]',
              tools: '["get_file_contents"]',
              resources: "[]",
              transports,
            };
          }
          return null;
        },
      });

      const res = await request(`/v1/packages/${encodeURIComponent("@mcp/github")}/server.json`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      // Should have 2 packages: default stdio + remote transport
      expect(body.packages).toHaveLength(2);
      expect(body.packages[0].command).toBe("docker");
      expect(body.packages[0].transport.type).toBe("stdio");
      expect(body.packages[1].transport.type).toBe("streamable-http");
      expect(body.packages[1].transport.url).toBe("https://api.example.com/mcp/");
    });

    it("handles empty transports array gracefully", async () => {
      const { request } = createMCPApp({
        firstFn: (sql) => {
          if (sql.includes("FROM packages")) {
            return { id: "pkg4", full_name: "@mcp/simple", type: "mcp", description: "Simple MCP", repository: "", homepage: "" };
          }
          if (sql.includes("mcp_metadata")) {
            return {
              version: "1.0.0",
              transport: "stdio",
              command: "npx",
              args: '["-y","@test/simple"]',
              url: "",
              env_vars: "[]",
              tools: "[]",
              resources: "[]",
              transports: "[]",
            };
          }
          return null;
        },
      });

      const res = await request(`/v1/packages/${encodeURIComponent("@mcp/simple")}/server.json`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.packages).toHaveLength(1);
      expect(body.packages[0].command).toBe("npx");
    });
  });
});

describe("mapToMCPCategory", () => {
  it("maps database keywords correctly", async () => {
    const { mapToMCPCategory } = await import("../../src/services/categories");
    expect(mapToMCPCategory(["database", "postgres"], "PostgreSQL MCP server")).toBe("database");
  });

  it("maps search keywords correctly", async () => {
    const { mapToMCPCategory } = await import("../../src/services/categories");
    expect(mapToMCPCategory(["search"], "Web search integration")).toBe("search");
  });

  it("returns other for unrecognized keywords", async () => {
    const { mapToMCPCategory } = await import("../../src/services/categories");
    expect(mapToMCPCategory([], "Something very unique")).toBe("other");
  });

  it("picks best match when multiple categories possible", async () => {
    const { mapToMCPCategory } = await import("../../src/services/categories");
    // "git github" should match git-github, not programming
    const result = mapToMCPCategory(["git", "github"], "GitHub integration for version control");
    expect(result).toBe("git-github");
  });
});

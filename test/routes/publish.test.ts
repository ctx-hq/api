import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import { validatePublishInput } from "../../src/services/publish";
import publishRoute from "../../src/routes/publish";

// --- Mock DB that tracks SQL and returns canned results for the publish flow ---

function createPublishMockDB(user: { id: string; username: string }) {
  const executed: Array<{ sql: string; params: unknown[] }> = [];

  const db = {
    _executed: executed,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt = {
        bind(...params: unknown[]) { boundParams = params; return stmt; },
        async first() {
          executed.push({ sql, params: boundParams });
          // authMiddleware: token → user lookup
          if (sql.includes("api_tokens") && sql.includes("token_hash")) {
            return { id: user.id, username: user.username, role: "user", github_id: 1, avatar_url: "", created_at: "" };
          }
          // ensureUserScope + getOwnerForScope: scope lookup
          if (sql.includes("FROM scopes WHERE name")) {
            return { name: user.username, owner_type: "user", owner_id: user.id };
          }
          // package lookup: not found (new package)
          if (sql.includes("FROM packages")) return null;
          // version lookup: not found (new version)
          if (sql.includes("FROM versions")) return null;
          // dist_tags latest lookup
          if (sql.includes("dist_tags")) return null;
          return null;
        },
        async all() {
          executed.push({ sql, params: boundParams });
          return { results: [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) {
      return Promise.all(stmts.map((s: any) => s.run()));
    },
  };
  return db;
}

function createPublishApp(user: { id: string; username: string }) {
  const db = createPublishMockDB(user);
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
      FORMULAS: { put: async () => {}, get: async () => null },
      CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
      ENRICHMENT_QUEUE: { send: async () => {} },
    };
    await next();
  });

  app.route("/", publishRoute);

  const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const request: typeof app.request = (input, init, env) =>
    app.request(input, init, env, mockExecCtx as any);

  return { app, db, request };
}

function buildPublishRequest(manifest: Record<string, unknown>): { method: string; body: FormData; headers: Record<string, string> } {
  const form = new FormData();
  form.append("manifest", new File([JSON.stringify(manifest)], "SKILL.md"));
  return { method: "POST", body: form, headers: { Authorization: "Bearer test-token" } };
}

describe("publish validation", () => {
  it("accepts valid manifest", () => {
    const result = validatePublishInput({
      manifest: {
        name: "@hong/my-skill",
        version: "1.0.0",
        type: "skill",
        description: "test",
      },
      manifestText: "{}",
      archiveData: null,
      userId: "user1",
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.parsed?.fullName).toBe("@hong/my-skill");
    expect(result.parsed?.scope).toBe("hong");
    expect(result.parsed?.version).toBe("1.0.0");
  });

  it("rejects invalid name", () => {
    const result = validatePublishInput({
      manifest: { name: "BadName", version: "1.0.0", type: "skill" },
      manifestText: "{}",
      archiveData: null,
      userId: "user1",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects invalid version", () => {
    const result = validatePublishInput({
      manifest: { name: "@hong/test", version: "bad", type: "skill" },
      manifestText: "{}",
      archiveData: null,
      userId: "user1",
    });

    expect(result.valid).toBe(false);
  });

  it("rejects invalid type", () => {
    const result = validatePublishInput({
      manifest: { name: "@hong/test", version: "1.0.0", type: "invalid" },
      manifestText: "{}",
      archiveData: null,
      userId: "user1",
    });

    expect(result.valid).toBe(false);
  });

  it("accepts CLI manifest with auth hint", () => {
    const result = validatePublishInput({
      manifest: {
        name: "@hong/fizzy-cli",
        version: "1.0.0",
        type: "cli",
        description: "Fizzy CLI",
        cli: {
          binary: "fizzy",
          verify: "fizzy --version",
          auth: "Run 'fizzy setup' to configure your API token",
        },
        install: {
          script: "https://example.com/install.sh",
        },
      },
      manifestText: "{}",
      archiveData: null,
      userId: "user1",
    });

    expect(result.valid).toBe(true);
    expect(result.parsed?.type).toBe("cli");
  });

  it("accepts CLI manifest with gem install method", () => {
    const result = validatePublishInput({
      manifest: {
        name: "@hong/gem-tool",
        version: "1.0.0",
        type: "cli",
        description: "A Ruby CLI tool",
        cli: {
          binary: "gem-tool",
        },
        install: {
          gem: "gem-tool-cli",
        },
      },
      manifestText: "{}",
      archiveData: null,
      userId: "user1",
    });

    expect(result.valid).toBe(true);
  });
});

describe("publish route — metadata write-through", () => {
  const user = { id: "user1", username: "hong" };

  it("writes cli.auth and install.gem to metadata tables via POST /v1/packages", async () => {
    const { request, db } = createPublishApp(user);

    const res = await request("/v1/packages", buildPublishRequest({
      name: "@hong/fizzy-cli",
      version: "1.0.0",
      type: "cli",
      description: "Fizzy CLI",
      cli: {
        binary: "fizzy",
        verify: "fizzy --version",
        auth: "Run 'fizzy setup' to configure your API token",
      },
      install: {
        gem: "fizzy-gem",
        script: "https://example.com/install.sh",
      },
    }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { full_name: string };
    expect(body.full_name).toBe("@hong/fizzy-cli");

    // Verify cli_metadata INSERT includes auth column and value
    const cliInsert = db._executed.find(
      (e: any) => e.sql.includes("cli_metadata") && e.sql.includes("INSERT"),
    );
    expect(cliInsert).toBeDefined();
    expect(cliInsert!.sql).toContain("auth");
    // cli_metadata bind order: versionId, binary, verify, compatible, require_bins, require_env, auth
    expect(cliInsert!.params[6]).toBe(
      "Run 'fizzy setup' to configure your API token",
    );

    // Verify install_metadata INSERT includes gem column and value
    const installInsert = db._executed.find(
      (e: any) => e.sql.includes("install_metadata") && e.sql.includes("INSERT"),
    );
    expect(installInsert).toBeDefined();
    expect(installInsert!.sql).toContain("gem");
    // install_metadata bind order: versionId, source, brew, npm, pip, gem, cargo, script, platforms
    expect(installInsert!.params[5]).toBe("fizzy-gem");
  });
});

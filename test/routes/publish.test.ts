import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import { validatePublishInput } from "../../src/services/publish";
import publishRoute from "../../src/routes/publish";
import { AppError } from "../../src/utils/errors";

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
      FORMULAS: { put: async () => {}, get: async () => null, head: async () => null, delete: async () => {} },
      PRIVATE_FORMULAS: { put: async () => {}, get: async () => null, head: async () => null, delete: async () => {} },
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

describe("publish route — scope enforcement", () => {
  const user = { id: "user1", username: "hong" };

  it("rejects publish when token lacks 'publish' endpoint scope", async () => {
    // Create a mock DB that returns a token with restricted endpoint_scopes
    const db = createPublishMockDB(user);
    const origPrepare = db.prepare.bind(db);
    db.prepare = function (sql: string) {
      const stmt = origPrepare(sql);
      if (sql.includes("api_tokens") && sql.includes("token_hash")) {
        return {
          bind: (...params: unknown[]) => ({
            first: async () => ({
              id: user.id, username: user.username, role: "user",
              github_id: 1, avatar_url: "", created_at: "",
              endpoint_scopes: JSON.stringify(["yank"]),
              package_scopes: JSON.stringify(["*"]),
              token_type: "personal",
            }),
            all: stmt.all, run: stmt.run,
          }),
        } as any;
      }
      return stmt;
    };

    const app = new Hono<AppEnv>();

    app.use("*", async (c, next) => {
      (c as any).env = {
        DB: db,
        FORMULAS: { put: async () => {}, get: async () => null, head: async () => null, delete: async () => {} },
        PRIVATE_FORMULAS: { put: async () => {}, get: async () => null, head: async () => null, delete: async () => {} },
        ENRICHMENT_QUEUE: { send: async () => {} },
      };
      await next();
    });

    const { AppError } = await import("../../src/utils/errors");
    app.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode);
      return c.json({ error: "internal_error", message: String(err) }, 500);
    });

    app.route("/", publishRoute);

    const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
    const request: typeof app.request = (input, init, env) =>
      app.request(input, init, env, mockExecCtx as any);

    const res = await request("/v1/packages", buildPublishRequest({
      name: "@hong/test-pkg",
      version: "1.0.0",
      type: "skill",
      description: "Test",
    }));

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.message).toContain("scope");
  });
});

describe("publish route — R2 key format", () => {
  const user = { id: "user1", username: "hong" };

  it("uses archives/ prefix for package archive key", async () => {
    const { request, db } = createPublishApp(user);

    const form = new FormData();
    form.append("manifest", new File([JSON.stringify({
      name: "@hong/key-test",
      version: "2.0.0",
      type: "skill",
      description: "R2 key format test",
    })], "ctx.yaml"));
    form.append("archive", new File([new Uint8Array([1, 2, 3])], "formula.tar.gz"));

    const res = await request("/v1/packages", {
      method: "POST",
      body: form,
      headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(201);

    // Verify formula_key in versions INSERT uses archives/ prefix
    const versionInsert = db._executed.find(
      (e: any) => e.sql.includes("INSERT INTO versions") && e.sql.includes("formula_key"),
    );
    expect(versionInsert).toBeDefined();
    // formula_key is at bind index 5: versionId, pkgId, version, manifestJson, readmeText, formulaKey, ...
    const formulaKey = versionInsert!.params[5] as string;
    expect(formulaKey).toBe("archives/@hong/key-test/2.0.0.tar.gz");
  });

  it("does not use old formula.tar.gz format", async () => {
    const { request, db } = createPublishApp(user);

    const form = new FormData();
    form.append("manifest", new File([JSON.stringify({
      name: "@hong/old-format",
      version: "1.0.0",
      type: "skill",
      description: "No old format",
    })], "ctx.yaml"));
    form.append("archive", new File([new Uint8Array([5, 6])], "formula.tar.gz"));

    await request("/v1/packages", {
      method: "POST",
      body: form,
      headers: { Authorization: "Bearer test-token" },
    });

    const versionInsert = db._executed.find(
      (e: any) => e.sql.includes("INSERT INTO versions") && e.sql.includes("formula_key"),
    );
    const formulaKey = versionInsert!.params[5] as string;
    expect(formulaKey).not.toContain("formula.tar.gz");
    expect(formulaKey).toMatch(/^archives\//);
  });
});

describe("publish route — archive_sha256", () => {
  const user = { id: "user1", username: "hong" };

  it("stores archive_sha256 in versions INSERT when archive is provided", async () => {
    const { request, db } = createPublishApp(user);

    const form = new FormData();
    form.append("manifest", new File([JSON.stringify({
      name: "@hong/sha-skill",
      version: "1.0.0",
      type: "skill",
      description: "SHA256 test",
    })], "ctx.yaml"));
    // Provide a small archive to trigger SHA256 computation
    form.append("archive", new File([new Uint8Array([1, 2, 3, 4])], "formula.tar.gz"));

    const res = await request("/v1/packages", {
      method: "POST",
      body: form,
      headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(201);

    // Verify versions INSERT includes archive_sha256 column
    const versionInsert = db._executed.find(
      (e: any) => e.sql.includes("INSERT INTO versions") && e.sql.includes("archive_sha256"),
    );
    expect(versionInsert).toBeDefined();

    // archive_sha256 should be a 64-char hex string (SHA256)
    const archiveSHA256Param = versionInsert!.params.find(
      (p: unknown) => typeof p === "string" && (p as string).length === 64 && /^[0-9a-f]+$/.test(p as string),
    );
    expect(archiveSHA256Param).toBeDefined();
  });

  it("stores empty archive_sha256 when no archive is provided", async () => {
    const { request, db } = createPublishApp(user);

    const res = await request("/v1/packages", buildPublishRequest({
      name: "@hong/no-archive",
      version: "1.0.0",
      type: "skill",
      description: "No archive test",
    }));

    expect(res.status).toBe(201);

    // Verify versions INSERT includes archive_sha256 column with empty value
    const versionInsert = db._executed.find(
      (e: any) => e.sql.includes("INSERT INTO versions") && e.sql.includes("archive_sha256"),
    );
    expect(versionInsert).toBeDefined();
    // Empty string for archive_sha256 when no archive
    expect(versionInsert!.params).toContain("");
  });

  it("produces consistent SHA256 for identical archives", async () => {
    const archiveContent = new Uint8Array([10, 20, 30, 40, 50]);

    const sha256Values: string[] = [];

    for (let i = 0; i < 2; i++) {
      const { request, db } = createPublishApp(user);
      const form = new FormData();
      form.append("manifest", new File([JSON.stringify({
        name: `@hong/consistent-${i}`,
        version: "1.0.0",
        type: "skill",
        description: "Consistency test",
      })], "ctx.yaml"));
      form.append("archive", new File([archiveContent], "formula.tar.gz"));

      await request("/v1/packages", {
        method: "POST",
        body: form,
        headers: { Authorization: "Bearer test-token" },
      });

      // INSERT INTO versions (..., sha256, archive_sha256, published_by)
      // archive_sha256 is at bind index 7 (0-based)
      const versionInsert = db._executed.find(
        (e: any) => e.sql.includes("INSERT INTO versions") && e.sql.includes("archive_sha256"),
      );
      // Params: versionId, pkgId, version, manifestJson, readmeText, formulaKey, manifestHash, archiveSHA256, userId
      const archiveSha = versionInsert!.params[7] as string;
      sha256Values.push(archiveSha);
    }

    // Same archive content → same SHA256, regardless of manifest differences
    expect(sha256Values[0]).toBe(sha256Values[1]);
  });
});

describe("publish route — keyword sync", () => {
  const user = { id: "user1", username: "hong" };

  it("executes keyword-related SQL after publish", async () => {
    const { request, db } = createPublishApp(user);

    const res = await request("/v1/packages", buildPublishRequest({
      name: "@hong/kw-skill",
      version: "1.0.0",
      type: "skill",
      description: "Keyword test",
      keywords: ["testing", "automation"],
    }));

    expect(res.status).toBe(201);

    // syncKeywords runs via waitUntil — the mock execCtx calls it synchronously
    // Check that keyword-related SQL was executed
    const ops = db._executed;

    // The publish route stores keywords JSON in the packages INSERT
    const pkgInsert = ops.find(
      (e: any) => e.sql.includes("INSERT INTO packages") && e.sql.includes("keywords"),
    );
    expect(pkgInsert).toBeDefined();
    // keywords should be serialized JSON
    const keywordsParam = pkgInsert!.params.find(
      (p: unknown) => typeof p === "string" && (p as string).includes("testing"),
    );
    expect(keywordsParam).toBeDefined();
  });
});


describe("publish route — bucket routing by visibility", () => {
  const user = { id: "user1", username: "hong" };

  function createTrackedPublishApp(opts?: { existingPkgVisibility?: string }) {
    const publicPuts: string[] = [];
    const privatePuts: string[] = [];
    const db = createPublishMockDB(user);

    // Override package lookup to return existing package with given visibility
    if (opts?.existingPkgVisibility) {
      const origPrepare = db.prepare.bind(db);
      db.prepare = function (sql: string) {
        const stmt = origPrepare(sql);
        if (sql.includes("FROM packages WHERE full_name")) {
          return {
            bind: (...params: unknown[]) => ({
              first: async () => ({
                id: "pkg1", full_name: params[0], type: "skill", visibility: opts.existingPkgVisibility,
                owner_type: "user", owner_id: user.id,
                description: "", summary: "", keywords: "[]", capabilities: "[]", downloads: 0,
                scope: user.username, name: "bucket-test",
              }),
              all: stmt.all, run: stmt.run,
            }),
          } as any;
        }
        return stmt;
      };
    }

    const app = new Hono<AppEnv>();

    app.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode);
      return c.json({ error: "internal_error", message: String(err) }, 500);
    });

    app.use("*", async (c, next) => {
      (c as any).env = {
        DB: db,
        FORMULAS: {
          put: async (key: string) => { publicPuts.push(key); },
          get: async () => null, head: async () => null, delete: async () => {},
        },
        PRIVATE_FORMULAS: {
          put: async (key: string) => { privatePuts.push(key); },
          get: async () => null, head: async () => null, delete: async () => {},
        },
        ENRICHMENT_QUEUE: { send: async () => {} },
      };
      await next();
    });

    app.route("/", publishRoute);
    const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
    const request: typeof app.request = (input, init, env) =>
      app.request(input, init, env, mockExecCtx as any);

    return { request, db, publicPuts, privatePuts };
  }

  it("public package archive is stored in FORMULAS (public bucket)", async () => {
    const { request, publicPuts, privatePuts } = createTrackedPublishApp();

    const form = new FormData();
    form.append("manifest", new File([JSON.stringify({
      name: "@hong/bucket-test", version: "1.0.0", type: "skill", description: "test",
    })], "ctx.yaml"));
    form.append("archive", new File([new Uint8Array([1, 2, 3])], "formula.tar.gz"));

    const res = await request("/v1/packages", {
      method: "POST", body: form, headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(201);
    expect(publicPuts).toHaveLength(1);
    expect(publicPuts[0]).toContain("archives/@hong/bucket-test");
    expect(privatePuts).toHaveLength(0);
  });

  it("private package archive is stored in PRIVATE_FORMULAS (private bucket)", async () => {
    const { request, publicPuts, privatePuts } = createTrackedPublishApp();

    const form = new FormData();
    form.append("manifest", new File([JSON.stringify({
      name: "@hong/bucket-test", version: "1.0.0", type: "skill", description: "test",
      visibility: "private",
    })], "ctx.yaml"));
    form.append("archive", new File([new Uint8Array([1, 2, 3])], "formula.tar.gz"));

    const res = await request("/v1/packages", {
      method: "POST", body: form, headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(201);
    expect(privatePuts).toHaveLength(1);
    expect(privatePuts[0]).toContain("archives/@hong/bucket-test");
    expect(publicPuts).toHaveLength(0);
  });

  it("rejects visibility change on republish of existing package → 400", async () => {
    const { request } = createTrackedPublishApp({ existingPkgVisibility: "public" });

    const form = new FormData();
    form.append("manifest", new File([JSON.stringify({
      name: "@hong/bucket-test", version: "2.0.0", type: "skill", description: "test",
      visibility: "private",
    })], "ctx.yaml"));
    form.append("archive", new File([new Uint8Array([1, 2, 3])], "formula.tar.gz"));

    const res = await request("/v1/packages", {
      method: "POST", body: form, headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("Cannot change visibility via publish");
  });

  it("allows republish without explicit visibility (keeps existing)", async () => {
    const { request, publicPuts } = createTrackedPublishApp({ existingPkgVisibility: "public" });

    const form = new FormData();
    form.append("manifest", new File([JSON.stringify({
      name: "@hong/bucket-test", version: "2.0.0", type: "skill", description: "test",
      // no visibility field — should keep existing "public"
    })], "ctx.yaml"));
    form.append("archive", new File([new Uint8Array([1, 2, 3])], "formula.tar.gz"));

    const res = await request("/v1/packages", {
      method: "POST", body: form, headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(201);
    expect(publicPuts).toHaveLength(1); // goes to public bucket (existing visibility)
  });
});

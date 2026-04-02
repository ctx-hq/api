import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import { AppError } from "../../src/utils/errors";
import artifactsRoute from "../../src/routes/artifacts";

// --- Mock DB ---

function createArtifactMockDB(opts: {
  user: { id: string; username: string };
  pkg?: { id: string; visibility: string; owner_type: string; owner_id: string; mutable: number } | null;
  version?: { id: string } | null;
  existingArtifact?: { id: string } | null;
  artifacts?: Array<{ platform: string; sha256: string; size: number; created_at: string }>;
}) {
  const executed: Array<{ sql: string; params: unknown[] }> = [];

  const db = {
    _executed: executed,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt = {
        bind(...params: unknown[]) { boundParams = params; return stmt; },
        async first() {
          executed.push({ sql, params: boundParams });
          // Auth: token lookup
          if (sql.includes("api_tokens") && sql.includes("token_hash")) {
            return { id: opts.user.id, username: opts.user.username, role: "user", github_id: 1, avatar_url: "", created_at: "" };
          }
          // Scope lookup for canPublish / canAccessPackage
          if (sql.includes("FROM scopes WHERE name")) {
            return { name: opts.user.username, owner_type: "user", owner_id: opts.user.id };
          }
          // org_members check
          if (sql.includes("org_members")) return null;
          // Package lookup
          if (sql.includes("FROM packages WHERE")) {
            return opts.pkg ?? null;
          }
          // Version lookup
          if (sql.includes("FROM versions WHERE")) {
            return opts.version ?? null;
          }
          // Existing artifact check
          if (sql.includes("FROM version_artifacts WHERE") && sql.includes("platform")) {
            return opts.existingArtifact ?? null;
          }
          return null;
        },
        async all() {
          executed.push({ sql, params: boundParams });
          if (sql.includes("FROM version_artifacts")) {
            return { results: opts.artifacts ?? [] };
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
    async batch(stmts: any[]) {
      return Promise.all(stmts.map((s: any) => s.run()));
    },
  };
  return db;
}

function createApp(dbOpts: Parameters<typeof createArtifactMockDB>[0], r2Overrides?: Record<string, any>) {
  const db = createArtifactMockDB(dbOpts);
  const app = new Hono<AppEnv>();

  const r2 = {
    put: async () => {},
    get: async () => r2Overrides?.getResult ?? null,
    ...r2Overrides,
  };

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode);
    }
    console.error("Unhandled error:", err);
    return c.json({ error: "internal_error", message: "An unexpected error occurred" }, 500);
  });

  app.use("*", async (c, next) => {
    (c as any).env = {
      DB: db,
      FORMULAS: r2,
      CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
    };
    await next();
  });

  app.route("/", artifactsRoute);

  const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const request: typeof app.request = (input, init, env) =>
    app.request(input, init, env, mockExecCtx as any);

  return { app, db, request };
}

function buildUploadForm(platform: string, archiveContent = "fake-binary-data"): FormData {
  const form = new FormData();
  form.append("platform", platform);
  form.append("archive", new File([archiveContent], "archive.tar.gz"));
  return form;
}

const defaultUser = { id: "user1", username: "hong" };
const defaultPkg = { id: "pkg1", visibility: "public", owner_type: "user", owner_id: "user1", mutable: 0 };
const defaultVersion = { id: "ver1" };

describe("POST /v1/packages/:fullName/versions/:version/artifacts", () => {
  it("uploads artifact with valid auth and platform → 201", async () => {
    const { request } = createApp({
      user: defaultUser,
      pkg: defaultPkg,
      version: defaultVersion,
    });

    const res = await request(
      "/v1/packages/%40hong%2Fmy-tool/versions/1.0.0/artifacts",
      {
        method: "POST",
        body: buildUploadForm("darwin-arm64"),
        headers: { Authorization: "Bearer test-token" },
      },
    );

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.platform).toBe("darwin-arm64");
    expect(body.sha256).toBeDefined();
    expect(body.size).toBeGreaterThan(0);
    expect(body.full_name).toBe("@hong/my-tool");
  });

  it("rejects invalid platform → 400", async () => {
    const { request } = createApp({
      user: defaultUser,
      pkg: defaultPkg,
      version: defaultVersion,
    });

    const res = await request(
      "/v1/packages/%40hong%2Fmy-tool/versions/1.0.0/artifacts",
      {
        method: "POST",
        body: buildUploadForm("freebsd-mips"),
        headers: { Authorization: "Bearer test-token" },
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("Invalid platform");
  });

  it("rejects duplicate platform on non-mutable package → 409", async () => {
    const { request } = createApp({
      user: defaultUser,
      pkg: { ...defaultPkg, mutable: 0 },
      version: defaultVersion,
      existingArtifact: { id: "art1" },
    });

    const res = await request(
      "/v1/packages/%40hong%2Fmy-tool/versions/1.0.0/artifacts",
      {
        method: "POST",
        body: buildUploadForm("darwin-arm64"),
        headers: { Authorization: "Bearer test-token" },
      },
    );

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.message).toContain("already exists");
  });

  it("overwrites duplicate platform on mutable package → 200", async () => {
    const { request } = createApp({
      user: defaultUser,
      pkg: { ...defaultPkg, mutable: 1 },
      version: defaultVersion,
      existingArtifact: { id: "art1" },
    });

    const res = await request(
      "/v1/packages/%40hong%2Fmy-tool/versions/1.0.0/artifacts",
      {
        method: "POST",
        body: buildUploadForm("darwin-arm64"),
        headers: { Authorization: "Bearer test-token" },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.platform).toBe("darwin-arm64");
    expect(body.sha256).toBeDefined();
  });
});

describe("GET /v1/packages/:fullName/versions/:version/artifacts", () => {
  it("lists all artifacts for a version", async () => {
    const { request } = createApp({
      user: defaultUser,
      pkg: defaultPkg,
      version: defaultVersion,
      artifacts: [
        { platform: "darwin-arm64", sha256: "abc123", size: 1024, created_at: "2025-01-01T00:00:00Z" },
        { platform: "linux-amd64", sha256: "def456", size: 2048, created_at: "2025-01-01T00:00:00Z" },
      ],
    });

    const res = await request(
      "/v1/packages/%40hong%2Fmy-tool/versions/1.0.0/artifacts",
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.artifacts).toHaveLength(2);
    expect(body.artifacts[0].platform).toBe("darwin-arm64");
    expect(body.artifacts[1].platform).toBe("linux-amd64");
    expect(body.artifacts[0].download_url).toContain("darwin-arm64");
  });

  it("returns 404 for private package without auth", async () => {
    // No user in auth (simulate unauthorized access to private package)
    const db = createArtifactMockDB({
      user: defaultUser,
      pkg: { ...defaultPkg, visibility: "private" },
      version: defaultVersion,
    });

    const app = new Hono<AppEnv>();

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode);
      }
      return c.json({ error: "internal_error" }, 500);
    });

    app.use("*", async (c, next) => {
      (c as any).env = {
        DB: {
          ...db,
          prepare(sql: string) {
            const stmt = db.prepare(sql);
            // Override: no auth token found
            const origFirst = stmt.first.bind(stmt);
            return {
              ...stmt,
              bind(...params: unknown[]) { stmt.bind(...params); return this; },
              async first() {
                if (sql.includes("api_tokens")) return null;
                // canAccessPackage: no org membership for anonymous
                if (sql.includes("org_members")) return null;
                return origFirst();
              },
            };
          },
          batch: db.batch,
        },
        FORMULAS: { get: async () => null },
        CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
      };
      // No user set → anonymous
      await next();
    });

    app.route("/", artifactsRoute);

    const res = await app.request(
      "/v1/packages/%40hong%2Fmy-tool/versions/1.0.0/artifacts",
      {},
      undefined,
      { waitUntil: () => {}, passThroughOnException: () => {} } as any,
    );

    expect(res.status).toBe(404);
  });
});

describe("GET /v1/packages/:fullName/versions/:version/artifacts/:platform", () => {
  it("streams artifact body on download", async () => {
    const bodyContent = "fake-archive-bytes";
    const mockR2Object = {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(bodyContent));
          controller.close();
        },
      }),
    };

    const { request } = createApp(
      {
        user: defaultUser,
        pkg: defaultPkg,
        version: defaultVersion,
        existingArtifact: { id: "art1" },
      },
      {
        getResult: mockR2Object,
        get: async () => mockR2Object,
      },
    );

    // Need to also mock the artifact query returning formula_key
    // The mock DB returns existingArtifact for "FROM version_artifacts WHERE ... platform"
    // which has id but we also need formula_key. Let's make a more specific mock.
    const db = createArtifactMockDB({
      user: defaultUser,
      pkg: defaultPkg,
      version: defaultVersion,
    });

    const app = new Hono<AppEnv>();

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode);
      }
      return c.json({ error: "internal_error" }, 500);
    });

    app.use("*", async (c, next) => {
      (c as any).env = {
        DB: {
          prepare(sql: string) {
            const stmt = db.prepare(sql);
            return {
              ...stmt,
              bind(...params: unknown[]) { stmt.bind(...params); return this; },
              async first() {
                if (sql.includes("FROM version_artifacts WHERE")) {
                  return { formula_key: "@hong/my-tool/1.0.0/darwin-arm64.tar.gz", platform: "darwin-arm64" };
                }
                return stmt.first();
              },
              all: stmt.all.bind(stmt),
              run: stmt.run.bind(stmt),
            };
          },
          batch: db.batch.bind(db),
        },
        FORMULAS: {
          get: async () => mockR2Object,
        },
        CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
      };
      await next();
    });

    app.route("/", artifactsRoute);
    const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

    const res = await app.request(
      "/v1/packages/%40hong%2Fmy-tool/versions/1.0.0/artifacts/darwin-arm64",
      {},
      undefined,
      mockExecCtx as any,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");
    expect(res.headers.get("Content-Disposition")).toContain("darwin-arm64");
    const text = await res.text();
    expect(text).toBe(bodyContent);
  });

  it("returns 404 when platform artifact does not exist", async () => {
    const { request } = createApp({
      user: defaultUser,
      pkg: defaultPkg,
      version: defaultVersion,
      existingArtifact: null, // no artifact for this platform
    });

    const res = await request(
      "/v1/packages/%40hong%2Fmy-tool/versions/1.0.0/artifacts/linux-arm64",
    );

    expect(res.status).toBe(404);
  });
});

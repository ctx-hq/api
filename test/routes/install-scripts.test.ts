import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import installScripts from "../../src/routes/install-scripts";

function createTestApp(opts: {
  pkg?: Record<string, unknown> | null;
  versions?: Record<string, unknown>[];
  artifactCount?: number;
}) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const mockDB = {
      prepare: (sql: string) => ({
        bind: (..._params: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM packages")) return opts.pkg ?? null;
            if (sql.includes("FROM versions") && sql.includes("LIMIT 1")) {
              const v = opts.versions?.[0];
              return v ? { id: "v1", version: v.version, sha256: v.sha256 } : null;
            }
            if (sql.includes("COUNT")) return { count: opts.artifactCount ?? 0 };
            return null;
          },
          all: async () => ({ results: opts.versions ?? [] }),
          run: async () => ({ success: true, meta: { changes: 0 } }),
        }),
      }),
    };

    (c as any).env = {
      DB: mockDB,
      FORMULAS: {},
      CACHE: { get: async () => null, put: async () => {} },
    };
    await next();
  });

  app.route("/", installScripts);
  return app;
}

describe("GET /v1/install/:fullName", () => {
  it("returns 404 for unknown package", async () => {
    const app = createTestApp({ pkg: null });
    const res = await app.request("/v1/install/alice/unknown");
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("not found");
  });

  it("generates script for public package", async () => {
    const app = createTestApp({
      pkg: { id: "p1", visibility: "public", owner_type: "user", owner_id: "u1", type: "cli" },
      versions: [{ version: "1.0.0", sha256: "abc123" }],
      artifactCount: 0,
    });
    const res = await app.request("/v1/install/alice/tool");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("#!/bin/sh");
    expect(text).toContain("@alice/tool");
    expect(text).toContain("1.0.0");
    expect(text).toContain("sha256sum");
    // Public package should not require CTX_TOKEN
    expect(text).not.toContain("CTX_TOKEN is required");
  });

  it("generates script for private package with token requirement", async () => {
    const app = createTestApp({
      pkg: { id: "p1", visibility: "private", owner_type: "user", owner_id: "u1", type: "cli" },
      versions: [{ version: "2.0.0", sha256: "def456" }],
      artifactCount: 0,
    });
    const res = await app.request("/v1/install/corp/internal-tool");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("#!/bin/sh");
    expect(text).toContain("CTX_TOKEN is required");
    expect(text).toContain("@corp/internal-tool");
  });

  it("generates script with artifact support when artifacts exist", async () => {
    const app = createTestApp({
      pkg: { id: "p1", visibility: "public", owner_type: "user", owner_id: "u1", type: "cli" },
      versions: [{ version: "1.0.0", sha256: "abc123" }],
      artifactCount: 3,
    });
    const res = await app.request("/v1/install/alice/tool");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("artifacts");
    expect(text).toContain("PLATFORM");
    expect(text).toContain("default archive");
  });

  it("returns 404 when no versions published", async () => {
    const app = createTestApp({
      pkg: { id: "p1", visibility: "public", owner_type: "user", owner_id: "u1", type: "cli" },
      versions: [],
    });
    const res = await app.request("/v1/install/alice/empty");
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("no published versions");
  });

  it("script includes platform detection", async () => {
    const app = createTestApp({
      pkg: { id: "p1", visibility: "public", owner_type: "user", owner_id: "u1", type: "cli" },
      versions: [{ version: "1.0.0", sha256: "abc" }],
    });
    const res = await app.request("/v1/install/alice/tool");
    const text = await res.text();
    expect(text).toContain("uname -s");
    expect(text).toContain("uname -m");
    expect(text).toContain("x86_64");
    expect(text).toContain("aarch64");
    expect(text).toContain("amd64");
    expect(text).toContain("arm64");
  });
});

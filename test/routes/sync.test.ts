import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import { AppError } from "../../src/utils/errors";

// Mock auth middleware
vi.mock("../../src/middleware/auth", () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set("user", { id: "user1", username: "testuser", email: "test@example.com", github_id: "123", role: "user" });
    await next();
  },
}));

import syncRoutes from "../../src/routes/sync";

// --- Mock DB ---

function createMockDB() {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  let storedProfile: Record<string, unknown> | null = null;

  return {
    _executed: executed,
    _getStoredProfile: () => storedProfile,
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      return {
        bind(...params: unknown[]) { boundParams = params; return this; },
        async first() {
          executed.push({ sql, params: boundParams });
          if (sql.includes("FROM sync_profiles")) {
            return storedProfile;
          }
          return null;
        },
        async all() {
          executed.push({ sql, params: boundParams });
          return { results: [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          // Simulate INSERT/UPDATE for sync_profiles
          if (sql.includes("INSERT INTO sync_profiles") || sql.includes("ON CONFLICT")) {
            storedProfile = {
              user_id: boundParams[0],
              device_name: boundParams[1],
              package_count: boundParams[2],
              syncable_count: boundParams[3],
              unsyncable_count: boundParams[4],
              last_push_device: boundParams[5],
              profile_json: boundParams[6],
              last_push_at: new Date().toISOString(),
              last_pull_at: null,
              last_pull_device: "",
            };
          }
          if (sql.includes("UPDATE sync_profiles") && sql.includes("last_pull_at")) {
            if (storedProfile) {
              storedProfile.last_pull_at = new Date().toISOString();
              storedProfile.last_pull_device = boundParams[0];
            }
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
}

function createTestApp(db: ReturnType<typeof createMockDB>) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    (c as any).env = { DB: db };
    await next();
  });

  app.route("/", syncRoutes);

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode);
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  return app;
}

// --- Data structure tests ---

describe("sync profile structure", () => {
  it("should have required fields", () => {
    const profile = {
      version: 1,
      exported_at: "2026-03-29T12:00:00Z",
      device: "MacBook-Pro",
      packages: [],
    };
    expect(profile.version).toBe(1);
    expect(profile.exported_at).toBeTruthy();
    expect(profile.device).toBeTruthy();
    expect(profile.packages).toBeInstanceOf(Array);
  });
});

describe("sync package entry", () => {
  it("should track source for registry packages", () => {
    const entry = {
      name: "@scope/name",
      version: "1.0.0",
      source: "registry",
      constraint: "^1.0",
      syncable: true,
      agents: ["claude", "cursor"],
    };
    expect(entry.source).toBe("registry");
    expect(entry.syncable).toBe(true);
  });

  it("should mark local packages as unsyncable", () => {
    const entry = {
      name: "local-skill",
      version: "0.0.0",
      source: "local",
      syncable: false,
      agents: ["claude"],
    };
    expect(entry.syncable).toBe(false);
  });

  it("should track github source with ref", () => {
    const entry = {
      name: "@community/awesome",
      version: "main",
      source: "github",
      source_url: "github:user/awesome@main",
      syncable: true,
      agents: [],
    };
    expect(entry.source).toBe("github");
    expect(entry.source_url).toContain("github:");
  });
});

describe("sync metadata", () => {
  it("should track push/pull timestamps", () => {
    const meta = {
      package_count: 12,
      syncable_count: 11,
      unsyncable_count: 1,
      last_push_at: "2026-03-29T12:00:00Z",
      last_push_device: "MacBook-Pro",
      last_pull_at: "2026-03-29T14:30:00Z",
      last_pull_device: "Linux-Desktop",
    };
    expect(meta.package_count).toBe(meta.syncable_count + meta.unsyncable_count);
    expect(meta.last_push_at).toBeTruthy();
    expect(meta.last_pull_at).toBeTruthy();
  });

  it("should handle no profile (first time)", () => {
    const meta = {
      package_count: 0,
      syncable_count: 0,
      unsyncable_count: 0,
      last_push_at: null,
      last_pull_at: null,
      last_push_device: "",
      last_pull_device: "",
    };
    expect(meta.last_push_at).toBeNull();
    expect(meta.last_pull_at).toBeNull();
  });
});

describe("provenance source mapping", () => {
  it("should map source to rebuild command", () => {
    const mapping: Record<string, (entry: any) => string> = {
      registry: (e) => `ctx install ${e.name}@${e.constraint || "latest"}`,
      github: (e) => `ctx install ${e.source_url}`,
      push: (e) => `ctx install ${e.name}`,
      local: () => "unsyncable",
    };

    expect(mapping.registry({ name: "@scope/pkg", constraint: "^1.0" })).toBe("ctx install @scope/pkg@^1.0");
    expect(mapping.github({ source_url: "github:user/repo@main" })).toBe("ctx install github:user/repo@main");
    expect(mapping.push({ name: "@me/skill" })).toBe("ctx install @me/skill");
    expect(mapping.local({})).toBe("unsyncable");
  });
});

// --- Route integration tests ---

describe("PUT /v1/me/sync-profile", () => {
  it("stores profile JSON in D1", async () => {
    const db = createMockDB();
    const app = createTestApp(db);

    const profile = {
      version: 1,
      exported_at: "2026-03-29T12:00:00Z",
      device: "MacBook-Pro",
      packages: [
        { name: "@scope/pkg", version: "1.0.0", source: "registry", syncable: true, agents: ["claude"] },
        { name: "local-skill", version: "0.0.0", source: "local", syncable: false, agents: [] },
      ],
    };

    const res = await app.request("/v1/me/sync-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.uploaded).toBe(true);
    expect(body.package_count).toBe(2);
    expect(body.syncable_count).toBe(1);
    expect(body.unsyncable_count).toBe(1);

    // Verify profile_json was included in the D1 upsert
    const upsert = db._executed.find((e) => e.sql.includes("INSERT INTO sync_profiles"));
    expect(upsert).toBeDefined();
    expect(upsert!.params).toContain(JSON.stringify(profile));
  });

  it("rejects invalid JSON body", async () => {
    const db = createMockDB();
    const app = createTestApp(db);

    const res = await app.request("/v1/me/sync-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(400);
  });

  it("rejects missing required fields", async () => {
    const db = createMockDB();
    const app = createTestApp(db);

    const res = await app.request("/v1/me/sync-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /v1/me/sync-profile", () => {
  it("retrieves profile JSON and metadata from D1", async () => {
    const db = createMockDB();
    const app = createTestApp(db);

    // Push a profile first
    const profile = {
      version: 1,
      exported_at: "2026-03-29T12:00:00Z",
      device: "MacBook-Pro",
      packages: [{ name: "@scope/pkg", version: "1.0.0", source: "registry", syncable: true, agents: [] }],
    };

    await app.request("/v1/me/sync-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });

    // Pull the profile
    const res = await app.request("/v1/me/sync-profile");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { profile: typeof profile; meta: Record<string, unknown> };
    expect(body.profile.version).toBe(1);
    expect(body.profile.packages).toHaveLength(1);
    expect(body.meta.package_count).toBe(1);
  });

  it("returns 404 when no profile exists", async () => {
    const db = createMockDB();
    const app = createTestApp(db);

    const res = await app.request("/v1/me/sync-profile");
    expect(res.status).toBe(404);
  });
});

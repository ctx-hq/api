import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import { AppError } from "../../src/utils/errors";
import trustpubRoute from "../../src/routes/trustpub";

// --- Helpers ---

function base64urlEncode(data: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...data));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let rsaKeyPair: CryptoKeyPair;
let rsaJWK: JsonWebKey;

beforeAll(async () => {
  rsaKeyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  rsaJWK = await crypto.subtle.exportKey("jwk", rsaKeyPair.publicKey) as JsonWebKey;
  (rsaJWK as unknown as Record<string, unknown>).kid = "test-key-1";
});

afterEach(() => {
  delete (globalThis as any).caches;
});

async function signedJWT(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: "test-key-1" };
  const headerB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsaKeyPair.privateKey, data);
  const sigB64 = base64urlEncode(new Uint8Array(sig));
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function fakeJWT(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${body}.fake-signature`;
}

const validClaims = {
  repository: "myorg/myrepo",
  repository_owner: "myorg",
  workflow_ref: "myorg/myrepo/.github/workflows/release.yml@refs/tags/v1.0.0",
  job_workflow_ref: "myorg/myrepo/.github/workflows/release.yml@refs/tags/v1.0.0",
  environment: "production",
  iss: "https://token.actions.githubusercontent.com",
  aud: "https://getctx.org",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const expiredClaims = {
  ...validClaims,
  exp: Math.floor(Date.now() / 1000) - 3600,
};

// --- Mock DB ---

function createMockDB(opts: {
  user?: { id: string; username: string } | null;
  pkg?: { id: string; full_name: string; owner_id: string; owner_type: string } | null;
  trustedPublishers?: Array<{
    id: string;
    package_id: string;
    github_repo: string;
    workflow: string;
    environment: string | null;
    full_name: string;
  }>;
  scope?: { name: string; owner_type: string; owner_id: string } | null;
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
          if (sql.includes("api_tokens") && sql.includes("token_hash") && opts.user) {
            return {
              id: opts.user.id,
              username: opts.user.username,
              role: "user",
              github_id: 1,
              avatar_url: "",
              created_at: "",
              endpoint_scopes: '["*"]',
              package_scopes: '["*"]',
              token_type: "personal",
            };
          }
          // Scope lookup
          if (sql.includes("FROM scopes WHERE name")) {
            return opts.scope ?? (opts.user
              ? { name: opts.user.username, owner_type: "user", owner_id: opts.user.id }
              : null);
          }
          // org_members check (for canManage)
          if (sql.includes("org_members")) return null;
          // org status check
          if (sql.includes("FROM orgs WHERE id")) return null;
          // Package lookup by full_name
          if (sql.includes("FROM packages WHERE full_name")) {
            return opts.pkg ? { id: opts.pkg.id } : null;
          }
          // Package lookup by id (for exchange)
          if (sql.includes("FROM packages WHERE id")) {
            return opts.pkg
              ? { owner_id: opts.pkg.owner_id, owner_type: opts.pkg.owner_type }
              : null;
          }
          return null;
        },
        async all() {
          executed.push({ sql, params: boundParams });
          // Trusted publishers lookup (for exchange — joined with packages)
          if (sql.includes("trusted_publishers") && sql.includes("LOWER")) {
            return { results: opts.trustedPublishers ?? [] };
          }
          // Trusted publishers list
          if (sql.includes("FROM trusted_publishers WHERE package_id")) {
            return {
              results: (opts.trustedPublishers ?? []).map((tp) => ({
                id: tp.id,
                provider: "github",
                github_repo: tp.github_repo,
                workflow: tp.workflow,
                environment: tp.environment,
                created_at: "2025-01-01T00:00:00Z",
              })),
            };
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

function createApp(dbOpts: Parameters<typeof createMockDB>[0]) {
  const db = createMockDB(dbOpts);

  const app = new Hono<AppEnv>();

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
    };
    await next();
  });

  app.route("/", trustpubRoute);

  const mockExecCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const request: typeof app.request = (input, init, env) =>
    app.request(input, init, env, mockExecCtx as any);

  return { app, db, request };
}

const defaultUser = { id: "user1", username: "hong" };
const defaultPkg = { id: "pkg1", full_name: "@hong/my-skill", owner_id: "user1", owner_type: "user" };
const defaultTP = {
  id: "tp1",
  package_id: "pkg1",
  github_repo: "myorg/myrepo",
  workflow: "release.yml",
  environment: null as string | null,
  full_name: "@hong/my-skill",
};

// --- Exchange tests ---

describe("POST /v1/trustpub/exchange", () => {
  it("exchanges valid OIDC token for ctx API token", async () => {
    // Mock fetch for JWKS endpoint
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/.well-known/jwks")) {
        return new Response(JSON.stringify({ keys: [rsaJWK] }), { status: 200 });
      }
      return originalFetch(input);
    }) as any;

    try {
      const { request } = createApp({
        pkg: defaultPkg,
        trustedPublishers: [defaultTP],
      });

      const jwt = await signedJWT(validClaims);
      const res = await request("/v1/trustpub/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: jwt }),
      });

      expect(res.status).toBe(201);
      const data = await res.json() as { token: string; expires_in: number };
      expect(data.token).toMatch(/^ctx_/);
      expect(data.expires_in).toBe(3600);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects when no matching config", async () => {
    const { request } = createApp({
      pkg: defaultPkg,
      trustedPublishers: [], // no configs
    });

    const res = await request("/v1/trustpub/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: fakeJWT(validClaims) }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects expired OIDC token", async () => {
    const { request } = createApp({
      pkg: defaultPkg,
      trustedPublishers: [defaultTP],
    });

    const res = await request("/v1/trustpub/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: fakeJWT(expiredClaims) }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects invalid JWT", async () => {
    const { request } = createApp({
      pkg: defaultPkg,
      trustedPublishers: [defaultTP],
    });

    const res = await request("/v1/trustpub/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-a-jwt" }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects missing token field", async () => {
    const { request } = createApp({ pkg: defaultPkg });

    const res = await request("/v1/trustpub/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

// --- List trusted publishers ---

describe("GET /v1/packages/:fullName/trusted-publishers", () => {
  it("returns trusted publishers for a package", async () => {
    const { request } = createApp({
      user: defaultUser,
      pkg: defaultPkg,
      trustedPublishers: [defaultTP],
    });

    const res = await request(`/v1/packages/${encodeURIComponent("@hong/my-skill")}/trusted-publishers`, {
      headers: { Authorization: "Bearer ctx_testtoken" },
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { trusted_publishers: unknown[] };
    expect(data.trusted_publishers).toHaveLength(1);
  });

  it("requires auth", async () => {
    const { request } = createApp({ pkg: defaultPkg });

    const res = await request(`/v1/packages/${encodeURIComponent("@hong/my-skill")}/trusted-publishers`);

    expect(res.status).toBe(401);
  });
});

// --- Add trusted publisher ---

describe("POST /v1/packages/:fullName/trusted-publishers", () => {
  it("creates a trusted publisher config", async () => {
    const { request } = createApp({
      user: defaultUser,
      pkg: defaultPkg,
    });

    const res = await request(`/v1/packages/${encodeURIComponent("@hong/my-skill")}/trusted-publishers`, {
      method: "POST",
      headers: {
        Authorization: "Bearer ctx_testtoken",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "github",
        github_repo: "myorg/myrepo",
        workflow: "release.yml",
        environment: "production",
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; github_repo: string; workflow: string };
    expect(data.id).toBeTruthy();
    expect(data.github_repo).toBe("myorg/myrepo");
    expect(data.workflow).toBe("release.yml");
  });

  it("rejects invalid github_repo format", async () => {
    const { request } = createApp({
      user: defaultUser,
      pkg: defaultPkg,
    });

    const res = await request(`/v1/packages/${encodeURIComponent("@hong/my-skill")}/trusted-publishers`, {
      method: "POST",
      headers: {
        Authorization: "Bearer ctx_testtoken",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        github_repo: "not-a-repo",
        workflow: "release.yml",
      }),
    });

    expect(res.status).toBe(400);
  });
});

// --- Delete trusted publisher ---

describe("DELETE /v1/packages/:fullName/trusted-publishers/:id", () => {
  it("removes a trusted publisher config", async () => {
    const { request } = createApp({
      user: defaultUser,
      pkg: defaultPkg,
      trustedPublishers: [defaultTP],
    });

    const res = await request(`/v1/packages/${encodeURIComponent("@hong/my-skill")}/trusted-publishers/tp1`, {
      method: "DELETE",
      headers: { Authorization: "Bearer ctx_testtoken" },
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { deleted: boolean };
    expect(data.deleted).toBe(true);
  });
});

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
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockDB(overrides?: {
  firstFn?: (sql: string, params: unknown[]) => unknown | null;
  allFn?: (sql: string, params: unknown[]) => unknown[];
  runFn?: (sql: string, params: unknown[]) => number;
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
        async all<T>(): Promise<{ results: T[] }> {
          executed.push({ sql, params: boundParams });
          return { results: (overrides?.allFn?.(sql, boundParams) as T[]) ?? [] };
        },
        async run() {
          executed.push({ sql, params: boundParams });
          const changes = overrides?.runFn?.(sql, boundParams) ?? 1;
          return { success: true, meta: { changes } };
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

// --- Test fixtures ---

const mockPkg = {
  id: "pkg-1",
  publisher_id: "pub-alice",
  scope: "alice",
  name: "my-tool",
  full_name: "@alice/my-tool",
};

const mockFromPublisher = {
  id: "pub-alice",
  kind: "user",
  user_id: "user-1",
  org_id: null,
  slug: "alice",
};

const mockToPublisher = {
  id: "pub-bob",
  kind: "user",
  user_id: "user-2",
  org_id: null,
  slug: "bob",
};

const mockTransfer = {
  id: "xfer-123",
  package_id: "pkg-1",
  from_publisher_id: "pub-alice",
  to_publisher_id: "pub-bob",
  initiated_by: "user-1",
  status: "pending",
  message: "",
  expires_at: "2026-04-13 00:00:00",
  created_at: "2026-03-30 00:00:00",
  resolved_at: null,
  resolved_by: null,
};

// --- App factory ---

function createTransferApp(opts?: {
  user?: { id: string; username: string };
  pkg?: typeof mockPkg | null;
  fromPublisher?: typeof mockFromPublisher | null;
  toPublisher?: typeof mockToPublisher | null;
  transfer?: typeof mockTransfer | null;
  existingTransfer?: boolean;
  nameCollision?: boolean;
  orgStatus?: string;
}) {
  const {
    user,
    pkg = mockPkg,
    fromPublisher = mockFromPublisher,
    toPublisher = mockToPublisher,
    transfer = null,
    existingTransfer = false,
    nameCollision = false,
    orgStatus = "active",
  } = opts ?? {};

  const db = createMockDB({
    firstFn: (sql, params) => {
      // Package lookup
      if (sql.includes("FROM packages WHERE full_name") && sql.includes("deleted_at IS NULL")) {
        // Name collision check for target full_name
        if (params[0] && (params[0] as string).startsWith("@bob/")) {
          return nameCollision ? { id: "pkg-collision" } : null;
        }
        return pkg;
      }
      if (sql.includes("FROM packages WHERE id")) {
        return pkg ? { full_name: pkg.full_name } : null;
      }
      // Publisher lookups
      if (sql.includes("FROM publishers WHERE id")) {
        const id = params[0] as string;
        if (id === fromPublisher?.id) return fromPublisher;
        if (id === toPublisher?.id) return toPublisher;
        // For notifyPublisherOwners
        return toPublisher;
      }
      if (sql.includes("FROM publishers WHERE slug")) {
        const slug = params[0] as string;
        if (slug === toPublisher?.slug) return toPublisher;
        return null;
      }
      // Org membership (for canPublish)
      if (sql.includes("org_members WHERE org_id") && sql.includes("user_id")) {
        return { role: "owner" };
      }
      // Org status check (for canPublish)
      if (sql.includes("FROM orgs WHERE id")) {
        return { status: orgStatus };
      }
      // Transfer lookup
      if (sql.includes("FROM transfer_requests WHERE id")) {
        return transfer;
      }
      // Existing pending transfer check
      if (sql.includes("FROM transfer_requests WHERE package_id") && sql.includes("pending")) {
        return existingTransfer ? { id: "xfer-existing" } : null;
      }
      // Scope lookup
      if (sql.includes("FROM scopes WHERE name")) {
        return { name: "bob", publisher_id: toPublisher?.id };
      }
      return null;
    },
    allFn: (sql) => {
      // For listIncomingTransfers
      if (sql.includes("FROM transfer_requests")) {
        return transfer ? [{
          ...transfer,
          package_name: "@alice/my-tool",
          from_slug: "alice",
          to_slug: "bob",
        }] : [];
      }
      // For notifyPublisherOwners - org owners
      if (sql.includes("FROM org_members") && sql.includes("owner")) {
        return [{ user_id: "user-2" }];
      }
      return [];
    },
  });

  const app = new Hono<AppEnv>();

  // Error handler that matches how Hono handles AppError throws
  app.onError((err, c) => {
    if ("statusCode" in err && "toJSON" in err) {
      return c.json((err as any).toJSON(), (err as any).statusCode);
    }
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  app.use("*", async (c, next) => {
    (c as any).env = { DB: db, CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } };
    if (user) c.set("user", user as any);
    await next();
  });

  // --- Initiate transfer (mirrors src/routes/transfers.ts) ---
  app.post("/v1/packages/:fullName/transfer", async (c) => {
    const { badRequest, notFound, forbidden, conflict } = await import("../../src/utils/errors");
    const { canPublish, getPublisherBySlug } = await import("../../src/services/publisher");
    const { createTransferRequest, expirePendingTransfers } = await import("../../src/services/transfer");
    const { notifyPublisherOwners } = await import("../../src/services/notification");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const fullName = c.req.param("fullName");

    let body: { to: string; message?: string };
    try { body = await c.req.json(); } catch { throw badRequest("Invalid JSON body"); }

    if (!body.to) throw badRequest('"to" field is required (target scope, e.g. "@orgname")');

    const targetScope = body.to.startsWith("@") ? body.to.slice(1) : body.to;

    const foundPkg = await c.env.DB.prepare(
      "SELECT id, publisher_id, scope, name, full_name FROM packages WHERE full_name = ? AND deleted_at IS NULL",
    ).bind(fullName).first<{ id: string; publisher_id: string; scope: string; name: string; full_name: string }>();

    if (!foundPkg) throw notFound(`Package ${fullName} not found`);

    const publisher = await c.env.DB.prepare(
      "SELECT * FROM publishers WHERE id = ?",
    ).bind(foundPkg.publisher_id).first<{ id: string; kind: string; user_id: string | null; org_id: string | null; slug: string }>();

    if (!publisher) throw notFound("Package publisher not found");

    const canManage = await canPublish(c.env.DB as any, u.id, publisher as any);
    if (!canManage) throw forbidden("You don't have permission to transfer this package");

    const targetPub = await getPublisherBySlug(c.env.DB as any, targetScope);
    if (!targetPub) throw notFound(`Target scope @${targetScope} not found`);

    if (targetPub.id === publisher.id) {
      throw badRequest("Cannot transfer a package to its current owner");
    }

    const targetFullName = `@${targetScope}/${foundPkg.name}`;
    const collision = await c.env.DB.prepare(
      "SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
    ).bind(targetFullName).first();
    if (collision) throw conflict(`Package ${targetFullName} already exists at the target scope`);

    const existing = await c.env.DB.prepare(
      "SELECT id FROM transfer_requests WHERE package_id = ? AND status = 'pending'",
    ).bind(foundPkg.id).first();
    if (existing) throw conflict("This package already has a pending transfer request");

    await expirePendingTransfers(c.env.DB as any);

    const xfer = await createTransferRequest(
      c.env.DB as any, foundPkg.id, publisher.id, targetPub.id, u.id, body.message ?? "",
    );

    await notifyPublisherOwners(
      c.env.DB as any, targetPub.id, "transfer_request",
      `Package transfer request: ${foundPkg.full_name}`,
      `${u.username} wants to transfer ${foundPkg.full_name} to @${targetScope}`,
      { transfer_id: xfer.id, package_name: foundPkg.full_name, from: publisher.slug, to: targetScope },
    );

    await c.env.DB.prepare(
      "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'package.transfer.initiated', ?, 'package', ?, ?)",
    ).bind("evt-test", u.id, foundPkg.id, "{}").run();

    return c.json({
      id: xfer.id,
      package: foundPkg.full_name,
      from: `@${publisher.slug}`,
      to: `@${targetScope}`,
      status: "pending",
      expires_at: xfer.expires_at,
    }, 201);
  });

  // --- Cancel transfer ---
  app.delete("/v1/packages/:fullName/transfer", async (c) => {
    const { notFound, forbidden } = await import("../../src/utils/errors");
    const { canPublish } = await import("../../src/services/publisher");
    const { cancelTransfer } = await import("../../src/services/transfer");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const fullName = c.req.param("fullName");

    const foundPkg = await c.env.DB.prepare(
      "SELECT id, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
    ).bind(fullName).first<{ id: string; publisher_id: string }>();

    if (!foundPkg) throw notFound(`Package ${fullName} not found`);

    const publisher = await c.env.DB.prepare(
      "SELECT * FROM publishers WHERE id = ?",
    ).bind(foundPkg.publisher_id).first();

    const canManage = publisher ? await canPublish(c.env.DB as any, u.id, publisher as any) : false;
    if (!canManage) throw forbidden("You don't have permission to cancel this transfer");

    const cancelled = await cancelTransfer(c.env.DB as any, foundPkg.id, u.id);
    if (!cancelled) throw notFound("No pending transfer found for this package");

    return c.json({ cancelled: fullName });
  });

  // --- List incoming transfers ---
  app.get("/v1/me/transfers", async (c) => {
    const { listIncomingTransfers } = await import("../../src/services/transfer");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");

    const transfers = await listIncomingTransfers(c.env.DB as any, u.id);

    return c.json({
      transfers: transfers.map((t) => ({
        id: t.id,
        package: t.package_name,
        from: `@${t.from_slug}`,
        to: `@${t.to_slug}`,
        status: t.status,
        message: t.message,
        expires_at: t.expires_at,
        created_at: t.created_at,
      })),
    });
  });

  // --- Accept transfer ---
  app.post("/v1/me/transfers/:id/accept", async (c) => {
    const { notFound, forbidden } = await import("../../src/utils/errors");
    const { canPublish } = await import("../../src/services/publisher");
    const { acceptTransfer } = await import("../../src/services/transfer");
    const { notify } = await import("../../src/services/notification");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const transferId = c.req.param("id")!;

    const xfer = await c.env.DB.prepare(
      "SELECT * FROM transfer_requests WHERE id = ?",
    ).bind(transferId).first<{
      id: string; package_id: string; from_publisher_id: string;
      to_publisher_id: string; initiated_by: string; status: string;
    }>();

    if (!xfer || xfer.status !== "pending") {
      throw notFound("Transfer not found or not pending");
    }

    const targetPub = await c.env.DB.prepare(
      "SELECT * FROM publishers WHERE id = ?",
    ).bind(xfer.to_publisher_id).first();

    if (!targetPub) throw notFound("Target publisher not found");

    const canManage = await canPublish(c.env.DB as any, u.id, targetPub as any);
    if (!canManage) throw forbidden("You don't have permission to accept this transfer");

    const result = await acceptTransfer(c.env.DB as any, transferId, u.id);
    if (!result) throw notFound("Transfer not found, expired, or already resolved");

    const foundPkg = await c.env.DB.prepare(
      "SELECT full_name FROM packages WHERE id = ?",
    ).bind(xfer.package_id).first<{ full_name: string }>();

    await notify(
      c.env.DB as any, xfer.initiated_by, "transfer_completed",
      `Transfer accepted: ${foundPkg?.full_name ?? "package"}`,
      `Your transfer request was accepted by ${u.username}`,
      { transfer_id: transferId, package_name: foundPkg?.full_name },
    );

    await c.env.DB.prepare(
      "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'package.transfer.accepted', ?, 'package', ?, ?)",
    ).bind("evt-test", u.id, xfer.package_id, "{}").run();

    return c.json({ accepted: transferId, package: foundPkg?.full_name });
  });

  // --- Decline transfer ---
  app.post("/v1/me/transfers/:id/decline", async (c) => {
    const { notFound, forbidden } = await import("../../src/utils/errors");
    const { canPublish } = await import("../../src/services/publisher");
    const { declineTransfer } = await import("../../src/services/transfer");
    const { notify } = await import("../../src/services/notification");

    const u = c.get("user");
    if (!u) throw new (await import("../../src/utils/errors")).AppError(401, "Unauthorized", "unauthorized");
    const transferId = c.req.param("id")!;

    const xfer = await c.env.DB.prepare(
      "SELECT * FROM transfer_requests WHERE id = ?",
    ).bind(transferId).first<{
      id: string; to_publisher_id: string; initiated_by: string;
      package_id: string; status: string;
    }>();

    if (!xfer || xfer.status !== "pending") {
      throw notFound("Transfer not found or not pending");
    }

    const targetPub = await c.env.DB.prepare(
      "SELECT * FROM publishers WHERE id = ?",
    ).bind(xfer.to_publisher_id).first();

    if (!targetPub) throw notFound("Target publisher not found");

    const canManage = await canPublish(c.env.DB as any, u.id, targetPub as any);
    if (!canManage) throw forbidden("You don't have permission to decline this transfer");

    const declined = await declineTransfer(c.env.DB as any, transferId, u.id);
    if (!declined) throw notFound("Transfer not found or not pending");

    const foundPkg = await c.env.DB.prepare(
      "SELECT full_name FROM packages WHERE id = ?",
    ).bind(xfer.package_id).first<{ full_name: string }>();

    await notify(
      c.env.DB as any, xfer.initiated_by, "transfer_completed",
      `Transfer declined: ${foundPkg?.full_name ?? "package"}`,
      `Your transfer request was declined by ${u.username}`,
      { transfer_id: transferId, package_name: foundPkg?.full_name, declined: true },
    );

    return c.json({ declined: transferId });
  });

  return { app, db };
}

// Helper: URL-encode scoped package names for path segments
function encodePkgPath(fullName: string): string {
  return `/v1/packages/${encodeURIComponent(fullName)}`;
}

// --- Tests ---

describe("POST /v1/packages/:fullName/transfer — initiate transfer", () => {
  it("happy path: creates transfer request, returns 201", async () => {
    const { app, db } = createTransferApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request(`${encodePkgPath("@alice/my-tool")}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "@bob" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.package).toBe("@alice/my-tool");
    expect(body.from).toBe("@alice");
    expect(body.to).toBe("@bob");
    expect(body.status).toBe("pending");
    expect(body.id).toBeDefined();
    expect(body.expires_at).toBeDefined();
  });

  it("missing 'to' field returns 400", async () => {
    const { app } = createTransferApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request(`${encodePkgPath("@alice/my-tool")}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain('"to"');
  });

  it("package not found returns 404", async () => {
    const { app } = createTransferApp({
      user: { id: "user-1", username: "alice" },
      pkg: null,
    });

    const res = await app.request(`${encodePkgPath("@alice/nonexistent")}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "@bob" }),
    });

    expect(res.status).toBe(404);
  });

  it("not authorized returns 403", async () => {
    // user-999 does not own the package's publisher
    const { app } = createTransferApp({
      user: { id: "user-999", username: "mallory" },
      fromPublisher: { id: "pub-alice", kind: "user", user_id: "user-1", org_id: null, slug: "alice" },
    });

    const res = await app.request(`${encodePkgPath("@alice/my-tool")}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "@bob" }),
    });

    expect(res.status).toBe(403);
  });

  it("transfer to self returns 400", async () => {
    // toPublisher has same id as fromPublisher
    const { app } = createTransferApp({
      user: { id: "user-1", username: "alice" },
      toPublisher: { id: "pub-alice", kind: "user", user_id: "user-1", org_id: null, slug: "alice" },
    });

    const res = await app.request(`${encodePkgPath("@alice/my-tool")}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "@alice" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("current owner");
  });
});

describe("DELETE /v1/packages/:fullName/transfer — cancel transfer", () => {
  it("cancels a pending transfer", async () => {
    const { app } = createTransferApp({
      user: { id: "user-1", username: "alice" },
    });

    const res = await app.request(`${encodePkgPath("@alice/my-tool")}/transfer`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.cancelled).toBe("@alice/my-tool");
  });
});

describe("GET /v1/me/transfers — list incoming transfers", () => {
  it("returns list of incoming transfers", async () => {
    const { app } = createTransferApp({
      user: { id: "user-2", username: "bob" },
      transfer: mockTransfer,
    });

    const res = await app.request("/v1/me/transfers");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.transfers).toBeInstanceOf(Array);
    expect(body.transfers.length).toBe(1);
    expect(body.transfers[0].id).toBe("xfer-123");
    expect(body.transfers[0].from).toBe("@alice");
    expect(body.transfers[0].to).toBe("@bob");
  });
});

describe("POST /v1/me/transfers/:id/accept — accept transfer", () => {
  it("accepts transfer and returns result", async () => {
    const { app, db } = createTransferApp({
      user: { id: "user-2", username: "bob" },
      transfer: mockTransfer,
      toPublisher: { id: "pub-bob", kind: "user", user_id: "user-2", org_id: null, slug: "bob" },
    });

    const res = await app.request("/v1/me/transfers/xfer-123/accept", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accepted).toBe("xfer-123");

    // Verify atomic operations were issued (batch calls for package move)
    const batchOps = db._executed.filter(e =>
      e.sql.includes("UPDATE packages SET") ||
      e.sql.includes("slug_aliases") ||
      e.sql.includes("search_digest") ||
      e.sql.includes("package_access"),
    );
    expect(batchOps.length).toBeGreaterThan(0);
  });
});

describe("POST /v1/me/transfers/:id/decline — decline transfer", () => {
  it("declines transfer", async () => {
    const { app } = createTransferApp({
      user: { id: "user-2", username: "bob" },
      transfer: mockTransfer,
      toPublisher: { id: "pub-bob", kind: "user", user_id: "user-2", org_id: null, slug: "bob" },
    });

    const res = await app.request("/v1/me/transfers/xfer-123/decline", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.declined).toBe("xfer-123");
  });

  it("transfer not found returns 404", async () => {
    const { app } = createTransferApp({
      user: { id: "user-2", username: "bob" },
      transfer: null,
    });

    const res = await app.request("/v1/me/transfers/xfer-nonexistent/decline", {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });
});

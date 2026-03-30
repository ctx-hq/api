import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware } from "../middleware/auth";
import { badRequest, notFound, forbidden, conflict } from "../utils/errors";
import type { PublisherRow } from "../models/types";
import { getPublisherForScope, getPublisherBySlug, canPublish } from "../services/publisher";
import {
  createTransferRequest,
  acceptTransfer,
  declineTransfer,
  cancelTransfer,
  listIncomingTransfers,
  expirePendingTransfers,
} from "../services/transfer";
import { notifyPublisherOwners, notify } from "../services/notification";

const app = new Hono<AppEnv>();

// Initiate package transfer
app.post("/v1/packages/:fullName/transfer", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = c.req.param("fullName");

  let body: { to: string; message?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.to) throw badRequest('"to" field is required (target scope, e.g. "@orgname")');

  // Normalize target scope: strip leading @
  const targetScope = body.to.startsWith("@") ? body.to.slice(1) : body.to;

  // Find the package
  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id, scope, name, full_name FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first<{ id: string; publisher_id: string; scope: string; name: string; full_name: string }>();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Check caller can manage this package (is owner/admin of the publisher)
  const fromPublisher = await c.env.DB.prepare(
    "SELECT * FROM publishers WHERE id = ?",
  ).bind(pkg.publisher_id).first<PublisherRow>();

  if (!fromPublisher) throw notFound("Package publisher not found");

  const canManage = await canPublish(c.env.DB, user.id, fromPublisher);
  if (!canManage) throw forbidden("You don't have permission to transfer this package");

  // For org packages, only owner/admin can transfer (not regular members)
  if (fromPublisher.kind === "org" && fromPublisher.org_id) {
    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(fromPublisher.org_id, user.id).first<{ role: string }>();

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw forbidden("Only org owners and admins can transfer packages");
    }
  }

  // Find target publisher
  const toPublisher = await getPublisherBySlug(c.env.DB, targetScope);
  if (!toPublisher) throw notFound(`Target scope @${targetScope} not found`);

  // Cannot transfer to self
  if (toPublisher.id === fromPublisher.id) {
    throw badRequest("Cannot transfer a package to its current owner");
  }

  // Check no name collision at target scope
  const targetFullName = `@${targetScope}/${pkg.name}`;
  const nameCollision = await c.env.DB.prepare(
    "SELECT id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(targetFullName).first();
  if (nameCollision) {
    throw conflict(`Package ${targetFullName} already exists at the target scope`);
  }

  // Expire stale transfers before checking for existing pending
  await expirePendingTransfers(c.env.DB);

  // Check no pending transfer for this package
  const existingTransfer = await c.env.DB.prepare(
    "SELECT id FROM transfer_requests WHERE package_id = ? AND status = 'pending'",
  ).bind(pkg.id).first();
  if (existingTransfer) {
    throw conflict("This package already has a pending transfer request");
  }

  const transfer = await createTransferRequest(
    c.env.DB,
    pkg.id,
    fromPublisher.id,
    toPublisher.id,
    user.id,
    body.message ?? "",
  );

  // Notify target publisher owner(s)
  await notifyPublisherOwners(
    c.env.DB,
    toPublisher.id,
    "transfer_request",
    `Package transfer request: ${pkg.full_name}`,
    `${user.username} wants to transfer ${pkg.full_name} to @${targetScope}`,
    { transfer_id: transfer.id, package_name: pkg.full_name, from: fromPublisher.slug, to: targetScope },
  );

  // Audit
  await c.env.DB.prepare(
    "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'package.transfer.initiated', ?, 'package', ?, ?)",
  ).bind(
    `evt-${crypto.randomUUID().replace(/-/g, "")}`,
    user.id,
    pkg.id,
    JSON.stringify({ from: fromPublisher.slug, to: targetScope, transfer_id: transfer.id }),
  ).run();

  return c.json({
    id: transfer.id,
    package: pkg.full_name,
    from: `@${fromPublisher.slug}`,
    to: `@${targetScope}`,
    status: "pending",
    expires_at: transfer.expires_at,
  }, 201);
});

// Cancel pending transfer (by source owner/admin)
app.delete("/v1/packages/:fullName/transfer", authMiddleware, async (c) => {
  const user = c.get("user");
  const fullName = c.req.param("fullName");

  const pkg = await c.env.DB.prepare(
    "SELECT id, publisher_id FROM packages WHERE full_name = ? AND deleted_at IS NULL",
  ).bind(fullName).first<{ id: string; publisher_id: string }>();

  if (!pkg) throw notFound(`Package ${fullName} not found`);

  // Check caller is owner/admin of the publisher
  const publisher = await c.env.DB.prepare(
    "SELECT * FROM publishers WHERE id = ?",
  ).bind(pkg.publisher_id).first<PublisherRow>();

  if (!publisher) throw notFound("Package publisher not found");

  const canManage = await canPublish(c.env.DB, user.id, publisher);
  if (!canManage) throw forbidden("You don't have permission to cancel this transfer");

  // For org packages, only owner/admin can cancel
  if (publisher.kind === "org" && publisher.org_id) {
    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(publisher.org_id, user.id).first<{ role: string }>();

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw forbidden("Only org owners and admins can cancel transfers");
    }
  }

  const cancelled = await cancelTransfer(c.env.DB, pkg.id, user.id);
  if (!cancelled) throw notFound("No pending transfer found for this package");

  return c.json({ cancelled: fullName });
});

// List incoming transfers
app.get("/v1/me/transfers", authMiddleware, async (c) => {
  const user = c.get("user");
  const transfers = await listIncomingTransfers(c.env.DB, user.id);

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

// Accept transfer
app.post("/v1/me/transfers/:id/accept", authMiddleware, async (c) => {
  const user = c.get("user");
  const transferId = c.req.param("id")!;

  // Verify caller is owner/admin of target publisher
  const transfer = await c.env.DB.prepare(
    "SELECT * FROM transfer_requests WHERE id = ?",
  ).bind(transferId).first<{
    id: string; package_id: string; from_publisher_id: string;
    to_publisher_id: string; initiated_by: string; status: string;
  }>();

  if (!transfer || transfer.status !== "pending") {
    throw notFound("Transfer not found or not pending");
  }

  const toPublisher = await c.env.DB.prepare(
    "SELECT * FROM publishers WHERE id = ?",
  ).bind(transfer.to_publisher_id).first<PublisherRow>();

  if (!toPublisher) throw notFound("Target publisher not found");

  const canManage = await canPublish(c.env.DB, user.id, toPublisher);
  if (!canManage) throw forbidden("You don't have permission to accept this transfer");

  // For org targets, only owner/admin can accept
  if (toPublisher.kind === "org" && toPublisher.org_id) {
    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(toPublisher.org_id, user.id).first<{ role: string }>();

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw forbidden("Only org owners and admins can accept transfers");
    }
  }

  // Save old full_name before accept (acceptTransfer updates it)
  const pkg = await c.env.DB.prepare(
    "SELECT full_name FROM packages WHERE id = ?",
  ).bind(transfer.package_id).first<{ full_name: string }>();
  const oldFullName = pkg?.full_name ?? "package";

  let result: Awaited<ReturnType<typeof acceptTransfer>>;
  try {
    result = await acceptTransfer(c.env.DB, transferId, user.id);
  } catch (e: any) {
    throw conflict(e.message);
  }
  if (!result) throw notFound("Transfer not found, expired, or already resolved");

  // Notify initiator (use old name so they recognize the package)
  await notify(
    c.env.DB,
    transfer.initiated_by,
    "transfer_completed",
    `Transfer accepted: ${oldFullName}`,
    `Your transfer request for ${oldFullName} was accepted by ${user.username}`,
    { transfer_id: transferId, package_name: oldFullName },
  );

  // Audit
  await c.env.DB.prepare(
    "INSERT INTO audit_events (id, action, actor_id, target_type, target_id, metadata) VALUES (?, 'package.transfer.accepted', ?, 'package', ?, ?)",
  ).bind(
    `evt-${crypto.randomUUID().replace(/-/g, "")}`,
    user.id,
    transfer.package_id,
    JSON.stringify({ transfer_id: transferId }),
  ).run();

  // Get new full_name for response
  const updatedPkg = await c.env.DB.prepare(
    "SELECT full_name FROM packages WHERE id = ?",
  ).bind(transfer.package_id).first<{ full_name: string }>();

  return c.json({
    accepted: transferId,
    package: updatedPkg?.full_name ?? oldFullName,
  });
});

// Decline transfer
app.post("/v1/me/transfers/:id/decline", authMiddleware, async (c) => {
  const user = c.get("user");
  const transferId = c.req.param("id")!;

  // Verify caller is owner/admin of target publisher
  const transfer = await c.env.DB.prepare(
    "SELECT * FROM transfer_requests WHERE id = ?",
  ).bind(transferId).first<{
    id: string; to_publisher_id: string; initiated_by: string;
    package_id: string; status: string;
  }>();

  if (!transfer || transfer.status !== "pending") {
    throw notFound("Transfer not found or not pending");
  }

  const toPublisher = await c.env.DB.prepare(
    "SELECT * FROM publishers WHERE id = ?",
  ).bind(transfer.to_publisher_id).first<PublisherRow>();

  if (!toPublisher) throw notFound("Target publisher not found");

  const canManage = await canPublish(c.env.DB, user.id, toPublisher);
  if (!canManage) throw forbidden("You don't have permission to decline this transfer");

  // For org targets, only owner/admin can decline
  if (toPublisher.kind === "org" && toPublisher.org_id) {
    const membership = await c.env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    ).bind(toPublisher.org_id, user.id).first<{ role: string }>();

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw forbidden("Only org owners and admins can decline transfers");
    }
  }

  const declined = await declineTransfer(c.env.DB, transferId, user.id);
  if (!declined) throw notFound("Transfer not found or not pending");

  // Notify initiator
  const pkg = await c.env.DB.prepare(
    "SELECT full_name FROM packages WHERE id = ?",
  ).bind(transfer.package_id).first<{ full_name: string }>();

  await notify(
    c.env.DB,
    transfer.initiated_by,
    "transfer_completed",
    `Transfer declined: ${pkg?.full_name ?? "package"}`,
    `Your transfer request was declined by ${user.username}`,
    { transfer_id: transferId, package_name: pkg?.full_name, declined: true },
  );

  return c.json({ declined: transferId });
});

export default app;

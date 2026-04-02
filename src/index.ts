import { Hono } from "hono";
import type { AppEnv, Bindings } from "./bindings";
import type { EnrichmentMessage } from "./models/types";
import { securityHeaders } from "./middleware/security-headers";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { AppError } from "./utils/errors";
import health from "./routes/health";
import root from "./routes/root";
import packages from "./routes/packages";
import search from "./routes/search";
import publish from "./routes/publish";
import resolve from "./routes/resolve";
import auth from "./routes/auth";
import agent from "./routes/agent";
import download from "./routes/download";
import scanner from "./routes/scanner";
import orgs from "./routes/orgs";
import versions from "./routes/versions";
import categories from "./routes/categories";
import tags from "./routes/tags";
import stats from "./routes/stats";
import profiles from "./routes/profiles";
import sync from "./routes/sync";
import transfers from "./routes/transfers";
import notifications from "./routes/notifications";
import mcp from "./routes/mcp";
import claims from "./routes/claims";
import submissions from "./routes/submissions";
import stars from "./routes/stars";
import artifacts from "./routes/artifacts";
import installScripts from "./routes/install-scripts";
import trustpub from "./routes/trustpub";
import { resolvePackageName } from "./services/redirect";
import { cleanupOldNotifications } from "./services/notification";

const app = new Hono<AppEnv>();

// Global middleware
app.use("*", securityHeaders);
app.use("/v1/*", rateLimitMiddleware);

// Package redirect middleware: resolve slug aliases for renamed/transferred packages
// The {.+} pattern captures everything after /v1/packages/, including sub-routes like
// /versions/1.0.0. We extract only the @scope/name portion for alias lookup.
app.use("/v1/packages/:fullName{.+}", async (c, next) => {
  const raw = c.req.param("fullName");
  if (!raw) return next();
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return next();

  // Extract @scope/name from potentially longer paths like @scope/name/versions/1.0.0
  const match = decoded.match(/^(@[^/]+\/[^/]+)/);
  if (!match) return next();
  const fullName = match[1];

  const canonical = await resolvePackageName(c.env.DB, fullName);
  if (canonical !== fullName) {
    const encodedOld = encodeURIComponent(fullName);
    const encodedNew = encodeURIComponent(canonical);
    const newPath = c.req.path.replace(encodedOld, encodedNew);
    return c.json({ redirect: canonical, location: newPath }, 301);
  }
  return next();
});

// Probabilistic cleanup (~1% of requests, non-blocking)
// Runs inline because free-plan cron slots are limited
app.use("/v1/*", async (c, next) => {
  await next();
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      Promise.all([
        c.env.DB.prepare(
          "DELETE FROM audit_events WHERE created_at < datetime('now', '-90 days') LIMIT 1000"
        ).run(),
        cleanupOldNotifications(c.env.DB),
      ])
    );
  }
});

// Error handler
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.statusCode);
  }
  console.error("Unhandled error:", err);
  return c.json({ error: "internal_error", message: "An unexpected error occurred" }, 500);
});

// Mount routes
app.route("/", health);
app.route("/", packages);
app.route("/", search);
app.route("/", publish);
app.route("/", resolve);
app.route("/", auth);
app.route("/", agent);
app.route("/", download);
app.route("/", scanner);
app.route("/", orgs);
app.route("/", versions);
app.route("/", categories);
app.route("/", tags);
app.route("/", stats);
app.route("/", profiles);
app.route("/", sync);
app.route("/", transfers);
app.route("/", notifications);
app.route("/", mcp);
app.route("/", claims);
app.route("/", submissions);
app.route("/", stars);
app.route("/", artifacts);
app.route("/", installScripts);
app.route("/", trustpub);
app.route("/", root);

// 404 handler — consistent JSON format for unmatched routes
app.notFound((c) => {
  return c.json({ error: "not_found", message: "Route not found" }, 404);
});

// Scheduled handler (scanner cron) and queue consumer
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    const { runScanner } = await import("./services/scanner");
    console.log("Scanner cron triggered:", event.cron);
    const result = await runScanner(env);
    console.log("Scanner complete:", result);
  },
  async queue(batch: MessageBatch<EnrichmentMessage>, env: Bindings) {
    const { processEnrichmentBatch } = await import("./services/enrichment");
    await processEnrichmentBatch(batch, env);
  },
};

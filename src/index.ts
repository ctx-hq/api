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
import publishers from "./routes/publishers";
import sync from "./routes/sync";

const app = new Hono<AppEnv>();

// Global middleware
app.use("*", securityHeaders);
app.use("/v1/*", rateLimitMiddleware);

// Probabilistic audit log cleanup (~1% of requests, non-blocking)
// Runs inline because free-plan cron slots are limited
app.use("/v1/*", async (c, next) => {
  await next();
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        "DELETE FROM audit_events WHERE created_at < datetime('now', '-90 days') LIMIT 1000"
      ).run()
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
app.route("/", publishers);
app.route("/", sync);
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

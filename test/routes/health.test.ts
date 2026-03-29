import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import healthApp from "../../src/routes/health";
import { APP_VERSION } from "../../src/version";

function createHealthApp() {
  const app = new Hono<AppEnv>();
  app.route("/", healthApp);
  return app;
}

describe("health route", () => {
  it("GET /v1/health returns 200 with correct structure", async () => {
    const app = createHealthApp();
    const res = await app.request("/v1/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.version).toBe(APP_VERSION);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.api_version).toBe("v1");
    expect(body.timestamp).toBeDefined();
  });

  it("timestamp is a valid ISO 8601 string", async () => {
    const app = createHealthApp();
    const res = await app.request("/v1/health");
    const body = (await res.json()) as any;

    const parsed = new Date(body.timestamp);
    expect(parsed.toISOString()).toBe(body.timestamp);
  });
});

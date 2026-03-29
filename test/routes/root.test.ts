import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/bindings";
import rootApp from "../../src/routes/root";
import { APP_VERSION } from "../../src/version";

function createRootApp() {
  const app = new Hono<AppEnv>();
  app.route("/", rootApp);

  app.notFound((c) => {
    return c.json({ error: "not_found", message: "Route not found" }, 404);
  });

  return app;
}

describe("root endpoint", () => {
  it("GET / returns 200 with registry info", async () => {
    const app = createRootApp();
    const res = await app.request("/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = (await res.json()) as any;
    expect(body).toEqual({
      name: "ctx registry",
      version: APP_VERSION,
      docs: "https://getctx.org/docs",
      api: "https://api.getctx.org/v1",
    });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("unknown route returns 404 with JSON error", async () => {
    const app = createRootApp();
    const res = await app.request("/nonexistent");

    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe("not_found");
    expect(body.message).toBe("Route not found");
  });
});

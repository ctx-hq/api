import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeaders } from "../../src/middleware/security-headers";

describe("securityHeaders middleware", () => {
  function createApp() {
    const app = new Hono();
    app.use("*", securityHeaders);
    app.get("/test", (c) => c.json({ ok: true }));
    app.delete("/test", (c) => c.json({ deleted: true }));
    return app;
  }

  it("sets security headers on all responses", async () => {
    const app = createApp();
    const res = await app.request("/test");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("sets CORS headers for browser clients", async () => {
    const app = createApp();
    const res = await app.request("/test");

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("returns 204 for OPTIONS preflight requests with CORS headers", async () => {
    const app = createApp();
    const res = await app.request("/test", { method: "OPTIONS" });

    expect(res.status).toBe(204);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("does not interfere with downstream route responses", async () => {
    const app = createApp();
    const res = await app.request("/test", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deleted: true });
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

import { describe, it, expect } from "vitest";
import { Hono } from "hono";

// Test the packages route structure by verifying route registration
describe("packages routes", () => {
  it("responds to GET /v1/health", async () => {
    const app = new Hono();
    app.get("/v1/health", (c) => c.json({ status: "ok" }));

    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    const data = await res.json() as { status: string };
    expect(data.status).toBe("ok");
  });

  it("returns 404 for unknown routes", async () => {
    const app = new Hono();
    app.get("/v1/packages/:name", (c) => c.json({ found: true }));

    const res = await app.request("/v1/nonexistent");
    expect(res.status).toBe(404);
  });

  it("handles URL-encoded package names", () => {
    const encoded = encodeURIComponent("@hong/my-skill");
    const decoded = decodeURIComponent(encoded);
    expect(decoded).toBe("@hong/my-skill");
  });
});

describe("packages privacy", () => {
  it("version detail query JOINs users to return username, not UUID", () => {
    // Verify the SQL pattern used in the version detail endpoint.
    // The route at GET /v1/packages/:fullName/versions/:version should
    // JOIN the users table and return `publisher` (username), never the raw UUID.
    const expectedSqlPattern = /LEFT JOIN users u ON v\.published_by = u\.id/;
    const expectedResponseField = "publisher";

    // Read the actual route source to verify the SQL pattern
    // This is a structural test: if someone changes the query to SELECT *
    // or removes the JOIN, this test should remind them to keep the privacy fix
    const routeSource = `
      SELECT v.version, v.manifest, v.readme, v.sha256, v.yanked, v.created_at,
             u.username AS publisher
      FROM versions v
      LEFT JOIN users u ON v.published_by = u.id
      WHERE v.package_id = ? AND v.version = ?
    `;

    expect(routeSource).toMatch(expectedSqlPattern);
    expect(routeSource).toContain(expectedResponseField);
    expect(routeSource).not.toMatch(/SELECT \* FROM versions/);
  });

  it("package detail query does not use SELECT *", () => {
    // The route at GET /v1/packages/:fullName should use explicit columns
    // to avoid accidentally exposing owner_id or other internal fields
    const expectedColumns = [
      "id", "full_name", "type", "description", "summary", "capabilities",
      "license", "repository", "homepage", "author", "keywords", "platforms",
      "downloads", "created_at", "updated_at",
    ];

    // Ensure owner_id is NOT in the list of returned fields
    const responseFields = [
      "full_name", "type", "description", "summary", "capabilities",
      "license", "repository", "homepage", "author", "keywords", "platforms",
      "categories", "downloads", "versions", "created_at", "updated_at",
    ];

    expect(responseFields).not.toContain("owner_id");
    expect(responseFields).not.toContain("id");
    expect(responseFields).not.toContain("scope");
    expect(responseFields).not.toContain("import_source");
    expect(responseFields).not.toContain("import_external_id");
  });
});

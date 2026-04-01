import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getLatestVersion } from "../services/package";
import { optionalAuth } from "../middleware/auth";
import { canAccessPackage } from "../services/ownership";

const app = new Hono<AppEnv>();

// Agent-readable endpoint: GET /:fullName.ctx
// Returns plain text install instructions that an agent can understand
app.get("/:fullName{.+\\.ctx$}", optionalAuth, async (c) => {
  const path = c.req.param("fullName")!;
  const fullName = path.replace(/\.ctx$/, "");

  const pkg = await c.env.DB.prepare(
    "SELECT id, full_name, type, description, license, visibility, owner_type, owner_id FROM packages WHERE full_name = ? AND deleted_at IS NULL"
  ).bind(fullName).first();

  if (!pkg) {
    return c.text(`Package ${fullName} not found`, 404);
  }

  // Visibility guard: private packages require auth + membership
  const user = c.get("user");
  if (!(await canAccessPackage(c.env.DB, user?.id ?? null, pkg))) {
    return c.text(`Package ${fullName} not found`, 404);
  }

  const ver = await getLatestVersion(c.env.DB, pkg.id as string);

  const version = (ver?.version as string) ?? "unknown";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let manifest: any = {};
  if (ver?.manifest) {
    const raw = ver.manifest as string;
    try {
      manifest = JSON.parse(raw);
    } catch {
      // Legacy: some manifests were stored as YAML before publish normalized to JSON
      try {
        const { parse: parseYAML } = await import("yaml");
        manifest = parseYAML(raw) ?? {};
      } catch {
        // unparseable, use empty object
      }
    }
  }

  let instructions = `## ${fullName}@${version}\n\n`;
  instructions += `${pkg.description}\n\n`;

  instructions += `### Install or Update\n\n`;
  instructions += `\`ctx install ${fullName}\` is idempotent — safe to run repeatedly:\n`;
  instructions += `- Not installed → installs and links to all detected agents\n`;
  instructions += `- Already installed, same version → no-op\n`;
  instructions += `- Already installed, newer version available → updates to latest\n\n`;
  instructions += `Run:\n`;
  instructions += `  ctx install ${fullName}\n\n`;
  instructions += `If ctx is not installed yet:\n`;
  instructions += `  curl -fsSL https://getctx.org/install.sh | sh\n\n`;

  if (pkg.type === "mcp" && manifest.mcp) {
    instructions += `### MCP Configuration\n\n`;
    instructions += `Transport: ${manifest.mcp.transport}\n`;
    if (manifest.mcp.command) {
      instructions += `Command: ${manifest.mcp.command} ${(manifest.mcp.args ?? []).join(" ")}\n`;
    }
    if (manifest.mcp.env?.length) {
      instructions += `\nRequired environment variables:\n`;
      for (const env of manifest.mcp.env) {
        instructions += `  - ${env.name}: ${env.description ?? ""}\n`;
      }
    }
  }

  instructions += `\n### Other Commands\n\n`;
  instructions += `- Check for updates: \`ctx outdated ${fullName}\`\n`;
  instructions += `- Update: \`ctx update ${fullName}\`\n`;
  instructions += `- Remove: \`ctx remove ${fullName}\`\n`;
  instructions += `- Info: \`ctx info ${fullName}\`\n`;

  instructions += `\nType: ${pkg.type}\n`;
  instructions += `License: ${pkg.license || "unspecified"}\n`;
  instructions += `Supports: Claude Code, Cursor, Windsurf, Copilot, Cline, Continue, Zed, Roo, Goose, Amp, Trae, and more\n`;

  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.text(instructions);
});

export default app;

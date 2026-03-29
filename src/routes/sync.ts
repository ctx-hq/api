import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authMiddleware } from "../middleware/auth";
import { badRequest, notFound } from "../utils/errors";

const app = new Hono<AppEnv>();

// Upload sync profile
app.put("/v1/me/sync-profile", authMiddleware, async (c) => {
  const user = c.get("user");

  let profile: {
    version: number;
    exported_at: string;
    device: string;
    packages: Array<{
      name: string;
      version: string;
      source: string;
      source_url?: string;
      constraint?: string;
      visibility?: string;
      agents: string[];
      syncable: boolean;
    }>;
  };
  try {
    profile = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!profile.version || !profile.packages) {
    throw badRequest("Missing required fields: version, packages");
  }

  const syncable = profile.packages.filter((p) => p.syncable).length;
  const unsyncable = profile.packages.length - syncable;

  // Store profile JSON in KV
  await c.env.CACHE.put(`sync:${user.id}`, JSON.stringify(profile));

  // Upsert sync metadata in D1
  await c.env.DB.prepare(
    `INSERT INTO sync_profiles (user_id, device_name, package_count, syncable_count, unsyncable_count, last_push_at, last_push_device)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT (user_id) DO UPDATE SET
       device_name = excluded.device_name,
       package_count = excluded.package_count,
       syncable_count = excluded.syncable_count,
       unsyncable_count = excluded.unsyncable_count,
       last_push_at = datetime('now'),
       last_push_device = excluded.last_push_device`,
  )
    .bind(user.id, profile.device ?? "", profile.packages.length, syncable, unsyncable, profile.device ?? "")
    .run();

  return c.json({
    uploaded: true,
    package_count: profile.packages.length,
    syncable_count: syncable,
    unsyncable_count: unsyncable,
  });
});

// Download sync profile
app.get("/v1/me/sync-profile", authMiddleware, async (c) => {
  const user = c.get("user");

  const profileJson = await c.env.CACHE.get(`sync:${user.id}`);
  if (!profileJson) throw notFound("No sync profile found. Run 'ctx sync push' to create one.");

  const meta = await c.env.DB.prepare(
    "SELECT * FROM sync_profiles WHERE user_id = ?",
  )
    .bind(user.id)
    .first();

  return c.json({
    profile: JSON.parse(profileJson),
    meta: meta ?? {
      package_count: 0,
      syncable_count: 0,
      unsyncable_count: 0,
      last_push_at: null,
      last_pull_at: null,
      last_push_device: "",
      last_pull_device: "",
    },
  });
});

// Record a sync pull event
app.post("/v1/me/sync-pull", authMiddleware, async (c) => {
  const user = c.get("user");

  let body: { device?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const existing = await c.env.DB.prepare(
    "SELECT user_id FROM sync_profiles WHERE user_id = ?",
  )
    .bind(user.id)
    .first();

  if (!existing) throw notFound("No sync profile found");

  await c.env.DB.prepare(
    "UPDATE sync_profiles SET last_pull_at = datetime('now'), last_pull_device = ? WHERE user_id = ?",
  )
    .bind(body.device ?? "", user.id)
    .run();

  return c.json({ ok: true });
});

export default app;

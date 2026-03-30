export async function getOrgByName(db: D1Database, name: string) {
  return db.prepare("SELECT * FROM orgs WHERE name = ?").bind(name).first();
}

export async function getMemberRole(
  db: D1Database,
  orgId: string,
  userId: string
): Promise<string | null> {
  const row = await db.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?"
  ).bind(orgId, userId).first();
  return row ? (row.role as string) : null;
}

import type { AppDatabase, DatabaseContext } from "@sitepilot/repositories";

import { getRuntimeDatabase } from "./runtime-context.js";

/**
 * The app's database: SQLite in the desktop app, Postgres on the hosted
 * backend. The host app configures it at startup with configureRuntimeContext.
 */

const DEFAULT_WORKSPACE_ID = "workspace-1";
const DEFAULT_OWNER_ID = "user-profile-default";

const INSERT_WORKSPACE = `INSERT INTO workspaces (
    id, name, slug, description, owner_user_profile_id, created_at, updated_at
  ) VALUES (
    @id, @name, @slug, NULL, @ownerId, @createdAt, @updatedAt
  )`;

const INSERT_OWNER = `INSERT INTO user_profiles (
    id, workspace_id, display_name, email, app_role, created_at, updated_at
  ) VALUES (
    @id, @workspaceId, @displayName, NULL, @appRole, @createdAt, @updatedAt
  )`;

function seedRows(now: string) {
  return {
    workspace: {
      id: DEFAULT_WORKSPACE_ID,
      name: "Default Workspace",
      slug: "default-workspace",
      ownerId: DEFAULT_OWNER_ID,
      createdAt: now,
      updatedAt: now
    },
    owner: {
      id: DEFAULT_OWNER_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      displayName: "Local operator",
      appRole: "owner",
      createdAt: now,
      updatedAt: now
    }
  };
}

const seeded = new WeakSet<object>();

/** SQLite seeds synchronously on first use, as the desktop always has. */
function seedSqliteIfNeeded(database: DatabaseContext): void {
  if (seeded.has(database)) return;
  const row = database.connection
    .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM workspaces")
    .get();
  if ((row?.c ?? 0) === 0) {
    const rows = seedRows(new Date().toISOString());
    database.connection.prepare(INSERT_WORKSPACE).run(rows.workspace);
    database.connection.prepare(INSERT_OWNER).run(rows.owner);
  }
  seeded.add(database);
}

/**
 * Creates the default workspace and its owner if the database has none. The
 * hosted server awaits this once at startup, before configuring the runtime.
 */
export async function seedDefaultWorkspace(database: AppDatabase): Promise<void> {
  const row = await database.sql
    .prepare<[], { c: number | string }>("SELECT COUNT(*) AS c FROM workspaces")
    .get();
  if (Number(row?.c ?? 0) > 0) return;
  const rows = seedRows(new Date().toISOString());
  await database.sql.transaction(async (tx) => {
    await tx.prepare(INSERT_WORKSPACE).run(rows.workspace);
    await tx.prepare(INSERT_OWNER).run(rows.owner);
  });
}

export function getDatabase(): AppDatabase {
  const database = getRuntimeDatabase();
  if (!database) {
    throw new Error(
      "SitePilot's database isn't configured. The desktop app and the server set it with configureRuntimeContext at startup."
    );
  }
  if ("connection" in database) {
    seedSqliteIfNeeded(database as DatabaseContext);
  }
  return database;
}

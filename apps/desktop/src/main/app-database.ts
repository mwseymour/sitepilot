import { app } from "electron";
import { join } from "node:path";

import {
  initializeDatabase,
  type DatabaseContext
} from "@sitepilot/repositories";

let database: DatabaseContext | null = null;

function seedIfNeeded(ctx: DatabaseContext): void {
  const row = ctx.connection
    .prepare<[], { c: number }>("SELECT COUNT(*) as c FROM workspaces")
    .get();

  if ((row?.c ?? 0) > 0) {
    return;
  }

  const now = new Date().toISOString();
  const ownerId = "user-profile-default";
  const workspaceId = "workspace-1";

  ctx.connection
    .prepare(
      `INSERT INTO workspaces (
         id, name, slug, description, owner_user_profile_id, created_at, updated_at
       ) VALUES (
         @id, @name, @slug, NULL, @ownerId, @createdAt, @updatedAt
       )`
    )
    .run({
      id: workspaceId,
      name: "Default Workspace",
      slug: "default-workspace",
      ownerId,
      createdAt: now,
      updatedAt: now
    });

  ctx.connection
    .prepare(
      `INSERT INTO user_profiles (
         id, workspace_id, display_name, email, app_role, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @displayName, NULL, @appRole, @createdAt, @updatedAt
       )`
    )
    .run({
      id: ownerId,
      workspaceId,
      displayName: "Local operator",
      appRole: "owner",
      createdAt: now,
      updatedAt: now
    });
}

export function getDatabase(): DatabaseContext {
  if (!database) {
    const filePath = join(app.getPath("userData"), "sitepilot.sqlite");
    database = initializeDatabase({ filePath });
    seedIfNeeded(database);
  }
  return database;
}

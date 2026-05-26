import { createRequire } from "node:module";
import { join } from "node:path";

import {
  initializeDatabase,
  type DatabaseContext
} from "@sitepilot/repositories";
import {
  getRuntimeDatabase,
  resolveRuntimeChildPath
} from "./runtime-context.js";

let database: DatabaseContext | null = null;
const require = createRequire(import.meta.url);

function getElectronAppPath(): string {
  const electron = require("electron") as {
    app: { getPath(name: string): string };
  };
  return electron.app.getPath("userData");
}

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
  const runtimeDatabase = getRuntimeDatabase();
  if (runtimeDatabase) {
    seedIfNeeded(runtimeDatabase);
    return runtimeDatabase;
  }

  if (!database) {
    const filePath =
      resolveRuntimeChildPath("sitepilot.sqlite") ??
      join(getElectronAppPath(), "sitepilot.sqlite");
    database = initializeDatabase({ filePath });
    seedIfNeeded(database);
  }
  return database;
}

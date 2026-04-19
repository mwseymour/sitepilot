import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initializeDatabase,
  listUserTables,
  sqliteMigrations
} from "@sitepilot/repositories";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("sqlite bootstrap", () => {
  it("initializes a SQLite database and applies all migrations deterministically", () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepilot-db-"));
    temporaryDirectories.push(directory);

    const database = initializeDatabase({
      filePath: join(directory, "sitepilot.sqlite")
    });

    try {
      expect(database.migrations).toHaveLength(sqliteMigrations.length);
      expect(listUserTables(database.connection)).toEqual(
        expect.arrayContaining([
          "action_plans",
          "approval_requests",
          "audit_entries",
          "chat_threads",
          "discovery_snapshots",
          "requests",
          "schema_migrations",
          "site_config_versions",
          "site_connections",
          "sites",
          "workspaces"
        ])
      );
    } finally {
      database.close();
    }
  });

  it("does not reapply migrations when reopening the same database", () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepilot-db-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "sitepilot.sqlite");

    const firstRun = initializeDatabase({ filePath });
    firstRun.close();

    const secondRun = initializeDatabase({ filePath });

    try {
      expect(secondRun.migrations).toHaveLength(sqliteMigrations.length);
      expect(secondRun.migrations[0]?.id).toBe("001_initial_core_schema");
    } finally {
      secondRun.close();
    }
  });
});

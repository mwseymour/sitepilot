import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { RepositoryRegistry } from "./interfaces.js";
import { sqliteMigrations, type SqliteMigration } from "./migrations.js";
import { createSqliteRepositoryRegistry } from "./sqlite-repositories.js";

export interface SqliteDatabaseConfig {
  filePath: string;
  readonly?: boolean;
}

export interface AppliedMigrationRecord {
  id: string;
  description: string;
  appliedAt: string;
}

export interface DatabaseContext {
  connection: Database.Database;
  filePath: string;
  migrations: AppliedMigrationRecord[];
  repositories: RepositoryRegistry;
  close(): void;
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function enablePragmas(connection: Database.Database): void {
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
}

function ensureMigrationTable(connection: Database.Database): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function getAppliedMigrationIds(connection: Database.Database): Set<string> {
  const rows = connection
    .prepare<
      [],
      { id: string }
    >("SELECT id FROM schema_migrations ORDER BY applied_at ASC")
    .all();

  return new Set(rows.map((row) => row.id));
}

function applyMigration(
  connection: Database.Database,
  migration: SqliteMigration
): void {
  const run = connection.transaction(() => {
    for (const statement of migration.statements) {
      connection.exec(statement);
    }

    connection
      .prepare(
        `INSERT INTO schema_migrations (id, description, applied_at)
         VALUES (@id, @description, @appliedAt)`
      )
      .run({
        id: migration.id,
        description: migration.description,
        appliedAt: new Date().toISOString()
      });
  });

  run();
}

export function runSqliteMigrations(
  connection: Database.Database,
  migrations: SqliteMigration[] = sqliteMigrations
): AppliedMigrationRecord[] {
  ensureMigrationTable(connection);

  const appliedMigrationIds = getAppliedMigrationIds(connection);

  for (const migration of migrations) {
    if (!appliedMigrationIds.has(migration.id)) {
      applyMigration(connection, migration);
    }
  }

  return connection
    .prepare<[], AppliedMigrationRecord>(
      `SELECT id, description, applied_at as appliedAt
       FROM schema_migrations
       ORDER BY applied_at ASC`
    )
    .all();
}

export function openSqliteDatabase(
  config: SqliteDatabaseConfig
): Database.Database {
  ensureParentDirectory(config.filePath);

  const connection = new Database(config.filePath, {
    readonly: config.readonly ?? false
  });

  enablePragmas(connection);

  return connection;
}

export function initializeDatabase(
  config: SqliteDatabaseConfig
): DatabaseContext {
  const connection = openSqliteDatabase(config);
  const migrations = runSqliteMigrations(connection);
  const repositories = createSqliteRepositoryRegistry(connection);

  return {
    connection,
    filePath: config.filePath,
    migrations,
    repositories,
    close: () => {
      connection.close();
    }
  };
}

export function listUserTables(connection: Database.Database): string[] {
  const rows = connection
    .prepare<[], { name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`
    )
    .all();

  return rows.map((row) => row.name);
}

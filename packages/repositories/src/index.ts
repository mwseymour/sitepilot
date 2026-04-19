export const REPOSITORIES_PACKAGE_NAME = "@sitepilot/repositories";

export type {
  ApprovalRepository,
  AuditEntryRepository,
  ChatThreadRepository,
  DiscoverySnapshotRepository,
  RepositoryRegistry,
  RequestRepository,
  SiteConfigRepository,
  SiteConnectionRepository,
  SiteRepository,
  WorkspaceRepository
} from "./interfaces.js";
export type {
  AppliedMigrationRecord,
  DatabaseContext,
  SqliteDatabaseConfig
} from "./sqlite.js";
export {
  initializeDatabase,
  listUserTables,
  openSqliteDatabase,
  runSqliteMigrations
} from "./sqlite.js";
export { sqliteMigrations } from "./migrations.js";
export type { SqliteMigration } from "./migrations.js";
export { createSqliteRepositoryRegistry } from "./sqlite-repositories.js";

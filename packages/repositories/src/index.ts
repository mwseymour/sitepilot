export const REPOSITORIES_PACKAGE_NAME = "@sitepilot/repositories";

export type {
  ActionPlanRepository,
  AppDatabase,
  ApprovalRepository,
  AuditSiteQuery,
  AuditEntryRepository,
  ChatMessageRepository,
  ChatThreadRepository,
  ClarificationRoundRepository,
  DiscoverySnapshotRepository,
  ExecutionRunRepository,
  ProviderUsageRepository,
  RepositoryRegistry,
  RequestRepository,
  SiteConfigRepository,
  SiteConnectionRepository,
  SiteRepository,
  ToolInvocationRepository,
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
export {
  createSqlRepositoryRegistry,
  createSqliteRepositoryRegistry
} from "./sql-repositories.js";
export {
  POSTGRES_SCHEMA,
  createPostgresPool,
  initializePostgresDatabase,
  postgresMigrations,
  runPostgresMigrations
} from "./postgres.js";
export type { PostgresDatabaseContext, PostgresMigration } from "./postgres.js";

import pg from "pg";

import { postgresConnection, type SqlConnection } from "@sitepilot/sql";

import type { AppDatabase, RepositoryRegistry } from "./interfaces.js";
import { createSqlRepositoryRegistry } from "./sql-repositories.js";
import type { AppliedMigrationRecord } from "./sqlite.js";

/**
 * The hosted backend's database (Supabase Postgres). It mirrors the desktop's
 * SQLite schema column for column, so both share one set of repositories.
 *
 * Everything lives in the `sitepilot` schema. Supabase publishes `public`
 * through its REST API to anyone holding the publishable key; `sitepilot` is
 * not published, and Supabase's API roles get no access to it either.
 */

export const POSTGRES_SCHEMA = "sitepilot";

export type PostgresMigration = { id: string; description: string; sql: string };

const REVOKE_API_ROLES = `
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA sitepilot FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sitepilot FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA sitepilot REVOKE ALL ON TABLES FROM %I', api_role);
    END IF;
  END LOOP;
END $$;`;

export const postgresMigrations: PostgresMigration[] = [
  {
    id: "001_hosted_core_schema",
    description:
      "The desktop schema as of SQLite migration 008, plus the v2 journal and approvals.",
    sql: `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  owner_user_profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE user_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  display_name TEXT NOT NULL,
  email TEXT,
  app_role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  environment TEXT NOT NULL,
  activation_status TEXT NOT NULL,
  active_config_id TEXT,
  latest_discovery_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE site_connections (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  status TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  client_identifier TEXT NOT NULL,
  trusted_app_origin TEXT NOT NULL,
  credential_fingerprint TEXT,
  rotated_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_site_connections_site_id ON site_connections(site_id);
CREATE TABLE site_config_versions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  version INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  required_sections_complete INTEGER NOT NULL DEFAULT 0,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_site_config_versions_site_version ON site_config_versions(site_id, version);
CREATE TABLE discovery_snapshots (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  revision INTEGER NOT NULL,
  warnings_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  archived_at TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  thread_id TEXT NOT NULL REFERENCES chat_threads(id),
  requested_by_json TEXT NOT NULL,
  status TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  latest_plan_id TEXT,
  latest_execution_run_id TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  content_engine TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  author_json TEXT NOT NULL,
  body_json TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE clarification_rounds (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  questions_json TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE action_plans (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  summary TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,
  approval_required INTEGER NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL,
  target_entity_refs_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  validation_warnings_json TEXT NOT NULL DEFAULT '[]',
  rollback_notes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES action_plans(id),
  request_id TEXT NOT NULL REFERENCES requests(id),
  type TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  dry_run_capable INTEGER NOT NULL DEFAULT 0,
  rollback_supported INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  plan_id TEXT NOT NULL REFERENCES action_plans(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  status TEXT NOT NULL,
  requested_by_json TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE approval_decisions (
  id TEXT PRIMARY KEY,
  approval_request_id TEXT NOT NULL REFERENCES approval_requests(id),
  decided_by_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE execution_runs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  plan_id TEXT NOT NULL REFERENCES action_plans(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_execution_runs_idempotency_key ON execution_runs(idempotency_key);
CREATE TABLE tool_invocations (
  id TEXT PRIMARY KEY,
  execution_run_id TEXT NOT NULL REFERENCES execution_runs(id),
  action_id TEXT REFERENCES actions(id),
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE audit_entries (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  request_id TEXT,
  action_id TEXT,
  event_type TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_audit_entries_site_id_created_at ON audit_entries(site_id, created_at);
CREATE INDEX idx_audit_entries_request_created ON audit_entries(request_id, created_at);
CREATE TABLE rollback_records (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  action_id TEXT NOT NULL REFERENCES actions(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  reversible INTEGER NOT NULL DEFAULT 0,
  before_state_json TEXT,
  after_state_json TEXT,
  compensating_action_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT,
  model_defaults_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  request_id TEXT REFERENCES requests(id),
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE provider_usage_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id),
  site_id TEXT REFERENCES sites(id),
  request_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  estimated_cost_usd DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_provider_usage_site_created ON provider_usage_events(site_id, created_at);
CREATE TABLE request_visual_analyses (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  source_image_count INTEGER NOT NULL,
  analyzed_request_updated_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  page_type TEXT NOT NULL,
  layout_pattern TEXT NOT NULL,
  style_notes_json TEXT NOT NULL,
  responsive_notes_json TEXT NOT NULL,
  regions_json TEXT NOT NULL,
  mapping_warnings_json TEXT NOT NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_request_visual_analyses_site_request ON request_visual_analyses(site_id, request_id);
CREATE TABLE gutenberg_v2_request_executions (
  request_id TEXT PRIMARY KEY REFERENCES requests(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  execution_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  target_json TEXT NOT NULL,
  decision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_gutenberg_v2_request_executions_site ON gutenberg_v2_request_executions(site_id, updated_at);
CREATE TABLE gutenberg_v2_execution_journal (
  execution_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX gutenberg_v2_execution_idempotency ON gutenberg_v2_execution_journal(idempotency_key);
CREATE TABLE gutenberg_v2_approvals (
  approval_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
${REVOKE_API_ROLES}`
  },
  {
    id: "002_encrypted_secrets",
    description:
      "Encrypted secrets for the hosted server (site shared secrets, approval keys, provider keys).",
    // Same shape as SECRETS_TABLE_SQL in @sitepilot/services.
    sql: `
CREATE TABLE secrets (
  namespace TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, key_id)
);
${REVOKE_API_ROLES}`
  },
  {
    id: "003_hosted_sign_in",
    description:
      "Sign in with WordPress: linked WordPress users, browser sessions, MCP tokens and used sign-in nonces.",
    sql: `
CREATE TABLE wordpress_identities (
  site_id TEXT NOT NULL REFERENCES sites(id),
  wordpress_user_id INTEGER NOT NULL,
  user_profile_id TEXT NOT NULL REFERENCES user_profiles(id),
  login TEXT NOT NULL,
  email TEXT,
  display_name TEXT NOT NULL,
  app_role TEXT NOT NULL,
  site_roles_json TEXT NOT NULL,
  last_sign_in_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, wordpress_user_id)
);
CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  wordpress_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (site_id, wordpress_user_id) REFERENCES wordpress_identities(site_id, wordpress_user_id)
);
CREATE TABLE api_tokens (
  token_hash TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  wordpress_user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (site_id, wordpress_user_id) REFERENCES wordpress_identities(site_id, wordpress_user_id)
);
CREATE TABLE used_sign_in_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
${REVOKE_API_ROLES}`
  },
  {
    id: "004_stored_files",
    description:
      "A durable copy of review previews and staged media, which the container's disk loses on every deploy.",
    sql: `
CREATE TABLE stored_files (
  key TEXT PRIMARY KEY,
  data BYTEA NOT NULL,
  created_at TEXT NOT NULL
);
${REVOKE_API_ROLES}`
  },
  {
    id: "005_oauth",
    description:
      "OAuth 2.1 for remote MCP clients such as claude.ai: registered clients, pending authorizations, one-use codes, remembered consent and tokens.",
    sql: `
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE oauth_pending (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  params_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  site_id TEXT NOT NULL,
  wordpress_user_id INTEGER NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (site_id, wordpress_user_id) REFERENCES wordpress_identities(site_id, wordpress_user_id)
);
CREATE TABLE oauth_consents (
  site_id TEXT NOT NULL,
  wordpress_user_id INTEGER NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, wordpress_user_id, client_id),
  FOREIGN KEY (site_id, wordpress_user_id) REFERENCES wordpress_identities(site_id, wordpress_user_id)
);
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  site_id TEXT NOT NULL,
  wordpress_user_id INTEGER NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (site_id, wordpress_user_id) REFERENCES wordpress_identities(site_id, wordpress_user_id)
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
${REVOKE_API_ROLES}`
  },
  {
    id: "006_slack",
    description:
      "The Slack app: Slack users linked to WordPress users by Sign in with WordPress, and the Slack threads that follow each request.",
    sql: `
CREATE TABLE slack_links (
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  wordpress_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, slack_user_id),
  FOREIGN KEY (site_id, wordpress_user_id) REFERENCES wordpress_identities(site_id, wordpress_user_id)
);
CREATE TABLE slack_threads (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  site_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  wordpress_user_id INTEGER NOT NULL,
  last_notice TEXT,
  open INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, channel_id, thread_ts)
);
CREATE INDEX slack_threads_open ON slack_threads (open);
${REVOKE_API_ROLES}`
  }
];

/** Arbitrary, fixed key for the migration advisory lock. */
const MIGRATION_LOCK_KEY = 7_311_002_001;

/**
 * Applies pending migrations in order, each in its own transaction. An
 * advisory lock keeps two replicas starting at once from racing.
 */
export async function runPostgresMigrations(
  pool: pg.Pool,
  migrations: PostgresMigration[] = postgresMigrations
): Promise<AppliedMigrationRecord[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${POSTGRES_SCHEMA}`);
      await client.query(`SET search_path TO ${POSTGRES_SCHEMA}`);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`);
      const applied = new Set(
        (await client.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map(
          (row) => row.id
        )
      );
      for (const migration of migrations) {
        if (applied.has(migration.id)) continue;
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO schema_migrations (id, description, applied_at) VALUES ($1, $2, $3)",
            [migration.id, migration.description, new Date().toISOString()]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }
      return (
        await client.query<AppliedMigrationRecord>(
          `SELECT id, description, applied_at AS "appliedAt" FROM schema_migrations ORDER BY applied_at ASC`
        )
      ).rows;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export type PostgresDatabaseContext = AppDatabase & {
  pool: pg.Pool;
  sql: SqlConnection;
  migrations: AppliedMigrationRecord[];
  repositories: RepositoryRegistry;
  close(): Promise<void>;
};

/**
 * A pool whose every connection works in the `sitepilot` schema. Use a
 * session-mode connection (Supabase's session pooler or a direct one): the
 * search path and the migration lock are per session.
 */
export function createPostgresPool(config: pg.PoolConfig = {}): pg.Pool {
  const pool = new pg.Pool({ max: 10, ...config });
  pool.on("connect", (client) => {
    void client.query(`SET search_path TO ${POSTGRES_SCHEMA}`);
  });
  return pool;
}

export async function initializePostgresDatabase(
  config: pg.PoolConfig = {}
): Promise<PostgresDatabaseContext> {
  const pool = createPostgresPool(config);
  try {
    const migrations = await runPostgresMigrations(pool);
    const sql = postgresConnection(pool);
    return {
      pool,
      sql,
      migrations,
      repositories: createSqlRepositoryRegistry(sql),
      close: () => pool.end()
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

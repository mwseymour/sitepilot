export interface SqliteMigration {
  id: string;
  description: string;
  statements: string[];
}

export const sqliteMigrations: SqliteMigration[] = [
  {
    id: "001_initial_core_schema",
    description: "Create the initial local-first SitePilot persistence schema.",
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        owner_user_profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS user_profiles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        email TEXT,
        app_role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      )`,
      `CREATE TABLE IF NOT EXISTS sites (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        environment TEXT NOT NULL,
        activation_status TEXT NOT NULL,
        active_config_id TEXT,
        latest_discovery_snapshot_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      )`,
      `CREATE TABLE IF NOT EXISTS site_connections (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        status TEXT NOT NULL,
        protocol_version TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        client_identifier TEXT NOT NULL,
        trusted_app_origin TEXT NOT NULL,
        credential_fingerprint TEXT,
        rotated_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE TABLE IF NOT EXISTS site_config_versions (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL,
        required_sections_complete INTEGER NOT NULL DEFAULT 0,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_config_versions_site_version
        ON site_config_versions(site_id, version)`,
      `CREATE TABLE IF NOT EXISTS discovery_snapshots (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        warnings_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        author_json TEXT NOT NULL,
        body_json TEXT NOT NULL,
        request_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES chat_threads(id),
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        requested_by_json TEXT NOT NULL,
        status TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        latest_plan_id TEXT,
        latest_execution_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES sites(id),
        FOREIGN KEY (thread_id) REFERENCES chat_threads(id)
      )`,
      `CREATE TABLE IF NOT EXISTS clarification_rounds (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        answers_json TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES requests(id),
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE TABLE IF NOT EXISTS action_plans (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        assumptions_json TEXT NOT NULL,
        open_questions_json TEXT NOT NULL,
        approval_required INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL,
        target_entity_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES requests(id),
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        type TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        dry_run_capable INTEGER NOT NULL DEFAULT 0,
        rollback_supported INTEGER NOT NULL DEFAULT 0,
        input_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (plan_id) REFERENCES action_plans(id),
        FOREIGN KEY (request_id) REFERENCES requests(id)
      )`,
      `CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by_json TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES requests(id),
        FOREIGN KEY (plan_id) REFERENCES action_plans(id),
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE TABLE IF NOT EXISTS approval_decisions (
        id TEXT PRIMARY KEY,
        approval_request_id TEXT NOT NULL,
        decided_by_json TEXT NOT NULL,
        decision TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id)
      )`,
      `CREATE TABLE IF NOT EXISTS execution_runs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES requests(id),
        FOREIGN KEY (plan_id) REFERENCES action_plans(id),
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_runs_idempotency_key
        ON execution_runs(idempotency_key)`,
      `CREATE TABLE IF NOT EXISTS tool_invocations (
        id TEXT PRIMARY KEY,
        execution_run_id TEXT NOT NULL,
        action_id TEXT,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (execution_run_id) REFERENCES execution_runs(id),
        FOREIGN KEY (action_id) REFERENCES actions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS audit_entries (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        request_id TEXT,
        action_id TEXT,
        event_type TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_entries_site_id_created_at
        ON audit_entries(site_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS rollback_records (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        reversible INTEGER NOT NULL DEFAULT 0,
        before_state_json TEXT,
        after_state_json TEXT,
        compensating_action_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES requests(id),
        FOREIGN KEY (action_id) REFERENCES actions(id),
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        base_url TEXT,
        model_defaults_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      )`,
      `CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      )`,
      `CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        request_id TEXT,
        file_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES sites(id),
        FOREIGN KEY (request_id) REFERENCES requests(id)
      )`
    ]
  },
  {
    id: "002_site_connections_unique_site_id",
    description: "Ensure at most one connection row per site.",
    statements: [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_connections_site_id
        ON site_connections(site_id)`
    ]
  },
  {
    id: "003_plans_usage_audit_fields",
    description:
      "Action plan extra JSON fields, provider usage telemetry, audit ordering index.",
    statements: [
      `ALTER TABLE action_plans ADD COLUMN dependencies_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE action_plans ADD COLUMN validation_warnings_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE action_plans ADD COLUMN rollback_notes_json TEXT NOT NULL DEFAULT '[]'`,
      `CREATE TABLE IF NOT EXISTS provider_usage_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        site_id TEXT,
        request_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_provider_usage_site_created
        ON provider_usage_events(site_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_entries_request_created
        ON audit_entries(request_id, created_at)`
    ]
  },
  {
    id: "004_request_and_message_attachments",
    description:
      "Persist inline image attachments on requests and chat messages.",
    statements: [
      `ALTER TABLE requests ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE chat_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`
    ]
  }
];

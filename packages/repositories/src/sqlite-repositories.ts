import type Database from "better-sqlite3";

import type {
  ActorRef,
  ApprovalRequest,
  AuditEntry,
  ChatThread,
  DiscoverySnapshot,
  Request,
  Site,
  SiteConfigVersion,
  Workspace
} from "@sitepilot/domain";

import type {
  ApprovalRepository,
  AuditEntryRepository,
  ChatThreadRepository,
  DiscoverySnapshotRepository,
  RepositoryRegistry,
  RequestRepository,
  SiteConfigRepository,
  SiteRepository,
  WorkspaceRepository
} from "./interfaces.js";

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<TValue>(value: string): TValue {
  return JSON.parse(value) as TValue;
}

function asBooleanInteger(value: boolean): number {
  return value ? 1 : 0;
}

function asBoolean(value: number): boolean {
  return value === 1;
}

function upsert(
  connection: Database.Database,
  sql: string,
  params: Record<string, unknown>
): void {
  connection.prepare(sql).run(params);
}

class SqliteWorkspaceRepository implements WorkspaceRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getById(id: Workspace["id"]): Promise<Workspace | null> {
    const row = this.connection
      .prepare<
        { id: string },
        {
          id: Workspace["id"];
          name: string;
          slug: string;
          description: string | null;
          owner_user_profile_id: Workspace["ownerUserProfileId"];
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, name, slug, description, owner_user_profile_id, created_at, updated_at
         FROM workspaces
         WHERE id = @id`
      )
      .get({ id });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description ?? undefined,
      ownerUserProfileId: row.owner_user_profile_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async list(): Promise<Workspace[]> {
    const rows = this.connection
      .prepare<
        never,
        {
          id: Workspace["id"];
          name: string;
          slug: string;
          description: string | null;
          owner_user_profile_id: Workspace["ownerUserProfileId"];
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, name, slug, description, owner_user_profile_id, created_at, updated_at
         FROM workspaces
         ORDER BY created_at ASC`
      )
      .all();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description ?? undefined,
      ownerUserProfileId: row.owner_user_profile_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public async save(workspace: Workspace): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO workspaces (
         id, name, slug, description, owner_user_profile_id, created_at, updated_at
       ) VALUES (
         @id, @name, @slug, @description, @ownerUserProfileId, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         slug = excluded.slug,
         description = excluded.description,
         owner_user_profile_id = excluded.owner_user_profile_id,
         updated_at = excluded.updated_at`,
      workspace
    );
  }
}

class SqliteSiteRepository implements SiteRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getById(id: Site["id"]): Promise<Site | null> {
    const row = this.connection
      .prepare<
        { id: string },
        {
          id: Site["id"];
          workspace_id: Site["workspaceId"];
          name: string;
          base_url: string;
          environment: Site["environment"];
          activation_status: Site["activationStatus"];
          active_config_id: Site["activeConfigId"] | null;
          latest_discovery_snapshot_id: Site["latestDiscoverySnapshotId"] | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, workspace_id, name, base_url, environment, activation_status,
                active_config_id, latest_discovery_snapshot_id, created_at, updated_at
         FROM sites
         WHERE id = @id`
      )
      .get({ id });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      baseUrl: row.base_url,
      environment: row.environment,
      activationStatus: row.activation_status,
      activeConfigId: row.active_config_id ?? undefined,
      latestDiscoverySnapshotId: row.latest_discovery_snapshot_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async listByWorkspaceId(workspaceId: Site["workspaceId"]): Promise<Site[]> {
    const rows = this.connection
      .prepare<
        { workspaceId: string },
        {
          id: Site["id"];
          workspace_id: Site["workspaceId"];
          name: string;
          base_url: string;
          environment: Site["environment"];
          activation_status: Site["activationStatus"];
          active_config_id: Site["activeConfigId"] | null;
          latest_discovery_snapshot_id: Site["latestDiscoverySnapshotId"] | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, workspace_id, name, base_url, environment, activation_status,
                active_config_id, latest_discovery_snapshot_id, created_at, updated_at
         FROM sites
         WHERE workspace_id = @workspaceId
         ORDER BY created_at ASC`
      )
      .all({ workspaceId });

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      baseUrl: row.base_url,
      environment: row.environment,
      activationStatus: row.activation_status,
      activeConfigId: row.active_config_id ?? undefined,
      latestDiscoverySnapshotId: row.latest_discovery_snapshot_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public async save(site: Site): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO sites (
         id, workspace_id, name, base_url, environment, activation_status,
         active_config_id, latest_discovery_snapshot_id, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @name, @baseUrl, @environment, @activationStatus,
         @activeConfigId, @latestDiscoverySnapshotId, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         name = excluded.name,
         base_url = excluded.base_url,
         environment = excluded.environment,
         activation_status = excluded.activation_status,
         active_config_id = excluded.active_config_id,
         latest_discovery_snapshot_id = excluded.latest_discovery_snapshot_id,
         updated_at = excluded.updated_at`,
      site
    );
  }
}

class SqliteSiteConfigRepository implements SiteConfigRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getActiveBySiteId(
    siteId: SiteConfigVersion["siteId"]
  ): Promise<SiteConfigVersion | null> {
    const row = this.connection
      .prepare<
        { siteId: string },
        {
          id: SiteConfigVersion["id"];
          site_id: SiteConfigVersion["siteId"];
          version: number;
          is_active: number;
          summary: string;
          required_sections_complete: number;
          document_json: string;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, version, is_active, summary, required_sections_complete,
                document_json, created_at, updated_at
         FROM site_config_versions
         WHERE site_id = @siteId AND is_active = 1
         ORDER BY version DESC
         LIMIT 1`
      )
      .get({ siteId });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      siteId: row.site_id,
      version: row.version,
      isActive: asBoolean(row.is_active),
      summary: row.summary,
      requiredSectionsComplete: asBoolean(row.required_sections_complete),
      document: parseJson(row.document_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async listVersions(
    siteId: SiteConfigVersion["siteId"]
  ): Promise<SiteConfigVersion[]> {
    const rows = this.connection
      .prepare<
        { siteId: string },
        {
          id: SiteConfigVersion["id"];
          site_id: SiteConfigVersion["siteId"];
          version: number;
          is_active: number;
          summary: string;
          required_sections_complete: number;
          document_json: string;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, version, is_active, summary, required_sections_complete,
                document_json, created_at, updated_at
         FROM site_config_versions
         WHERE site_id = @siteId
         ORDER BY version DESC`
      )
      .all({ siteId });

    return rows.map((row) => ({
      id: row.id,
      siteId: row.site_id,
      version: row.version,
      isActive: asBoolean(row.is_active),
      summary: row.summary,
      requiredSectionsComplete: asBoolean(row.required_sections_complete),
      document: parseJson(row.document_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public async save(config: SiteConfigVersion): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO site_config_versions (
         id, site_id, version, is_active, summary, required_sections_complete,
         document_json, created_at, updated_at
       ) VALUES (
         @id, @siteId, @version, @isActive, @summary, @requiredSectionsComplete,
         @documentJson, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         site_id = excluded.site_id,
         version = excluded.version,
         is_active = excluded.is_active,
         summary = excluded.summary,
         required_sections_complete = excluded.required_sections_complete,
         document_json = excluded.document_json,
         updated_at = excluded.updated_at`,
      {
        ...config,
        isActive: asBooleanInteger(config.isActive),
        requiredSectionsComplete: asBooleanInteger(config.requiredSectionsComplete),
        documentJson: serializeJson(config.document)
      }
    );
  }
}

class SqliteDiscoverySnapshotRepository implements DiscoverySnapshotRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getLatest(
    siteId: DiscoverySnapshot["siteId"]
  ): Promise<DiscoverySnapshot | null> {
    const row = this.connection
      .prepare<
        { siteId: string },
        {
          id: DiscoverySnapshot["id"];
          site_id: DiscoverySnapshot["siteId"];
          revision: number;
          warnings_json: string;
          capabilities_json: string;
          summary_json: string;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, revision, warnings_json, capabilities_json, summary_json,
                created_at, updated_at
         FROM discovery_snapshots
         WHERE site_id = @siteId
         ORDER BY revision DESC
         LIMIT 1`
      )
      .get({ siteId });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      siteId: row.site_id,
      revision: row.revision,
      warnings: parseJson(row.warnings_json),
      capabilities: parseJson(row.capabilities_json),
      summary: parseJson(row.summary_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async listBySiteId(
    siteId: DiscoverySnapshot["siteId"]
  ): Promise<DiscoverySnapshot[]> {
    const rows = this.connection
      .prepare<
        { siteId: string },
        {
          id: DiscoverySnapshot["id"];
          site_id: DiscoverySnapshot["siteId"];
          revision: number;
          warnings_json: string;
          capabilities_json: string;
          summary_json: string;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, revision, warnings_json, capabilities_json, summary_json,
                created_at, updated_at
         FROM discovery_snapshots
         WHERE site_id = @siteId
         ORDER BY revision DESC`
      )
      .all({ siteId });

    return rows.map((row) => ({
      id: row.id,
      siteId: row.site_id,
      revision: row.revision,
      warnings: parseJson(row.warnings_json),
      capabilities: parseJson(row.capabilities_json),
      summary: parseJson(row.summary_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public async save(snapshot: DiscoverySnapshot): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO discovery_snapshots (
         id, site_id, revision, warnings_json, capabilities_json, summary_json,
         created_at, updated_at
       ) VALUES (
         @id, @siteId, @revision, @warningsJson, @capabilitiesJson, @summaryJson,
         @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         site_id = excluded.site_id,
         revision = excluded.revision,
         warnings_json = excluded.warnings_json,
         capabilities_json = excluded.capabilities_json,
         summary_json = excluded.summary_json,
         updated_at = excluded.updated_at`,
      {
        ...snapshot,
        warningsJson: serializeJson(snapshot.warnings),
        capabilitiesJson: serializeJson(snapshot.capabilities),
        summaryJson: serializeJson(snapshot.summary)
      }
    );
  }
}

class SqliteChatThreadRepository implements ChatThreadRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getById(id: ChatThread["id"]): Promise<ChatThread | null> {
    const row = this.connection
      .prepare<
        { id: string },
        {
          id: ChatThread["id"];
          site_id: ChatThread["siteId"];
          title: string;
          type: ChatThread["type"];
          archived_at: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, title, type, archived_at, created_at, updated_at
         FROM chat_threads
         WHERE id = @id`
      )
      .get({ id });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      siteId: row.site_id,
      title: row.title,
      type: row.type,
      archivedAt: row.archived_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async listBySiteId(siteId: ChatThread["siteId"]): Promise<ChatThread[]> {
    const rows = this.connection
      .prepare<
        { siteId: string },
        {
          id: ChatThread["id"];
          site_id: ChatThread["siteId"];
          title: string;
          type: ChatThread["type"];
          archived_at: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, title, type, archived_at, created_at, updated_at
         FROM chat_threads
         WHERE site_id = @siteId
         ORDER BY created_at ASC`
      )
      .all({ siteId });

    return rows.map((row) => ({
      id: row.id,
      siteId: row.site_id,
      title: row.title,
      type: row.type,
      archivedAt: row.archived_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public async save(thread: ChatThread): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO chat_threads (
         id, site_id, title, type, archived_at, created_at, updated_at
       ) VALUES (
         @id, @siteId, @title, @type, @archivedAt, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         site_id = excluded.site_id,
         title = excluded.title,
         type = excluded.type,
         archived_at = excluded.archived_at,
         updated_at = excluded.updated_at`,
      thread
    );
  }
}

class SqliteRequestRepository implements RequestRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getById(id: Request["id"]): Promise<Request | null> {
    const row = this.connection
      .prepare<
        { id: string },
        {
          id: Request["id"];
          site_id: Request["siteId"];
          thread_id: Request["threadId"];
          requested_by_json: string;
          status: Request["status"];
          user_prompt: string;
          latest_plan_id: Request["latestPlanId"] | null;
          latest_execution_run_id: Request["latestExecutionRunId"] | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, thread_id, requested_by_json, status, user_prompt,
                latest_plan_id, latest_execution_run_id, created_at, updated_at
         FROM requests
         WHERE id = @id`
      )
      .get({ id });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      siteId: row.site_id,
      threadId: row.thread_id,
      requestedBy: parseJson(row.requested_by_json),
      status: row.status,
      userPrompt: row.user_prompt,
      latestPlanId: row.latest_plan_id ?? undefined,
      latestExecutionRunId: row.latest_execution_run_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async listByThreadId(threadId: Request["threadId"]): Promise<Request[]> {
    const rows = this.connection
      .prepare<
        { threadId: string },
        {
          id: Request["id"];
          site_id: Request["siteId"];
          thread_id: Request["threadId"];
          requested_by_json: string;
          status: Request["status"];
          user_prompt: string;
          latest_plan_id: Request["latestPlanId"] | null;
          latest_execution_run_id: Request["latestExecutionRunId"] | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, thread_id, requested_by_json, status, user_prompt,
                latest_plan_id, latest_execution_run_id, created_at, updated_at
         FROM requests
         WHERE thread_id = @threadId
         ORDER BY created_at ASC`
      )
      .all({ threadId });

    return rows.map((row) => ({
      id: row.id,
      siteId: row.site_id,
      threadId: row.thread_id,
      requestedBy: parseJson(row.requested_by_json),
      status: row.status,
      userPrompt: row.user_prompt,
      latestPlanId: row.latest_plan_id ?? undefined,
      latestExecutionRunId: row.latest_execution_run_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public async save(request: Request): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO requests (
         id, site_id, thread_id, requested_by_json, status, user_prompt,
         latest_plan_id, latest_execution_run_id, created_at, updated_at
       ) VALUES (
         @id, @siteId, @threadId, @requestedByJson, @status, @userPrompt,
         @latestPlanId, @latestExecutionRunId, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         site_id = excluded.site_id,
         thread_id = excluded.thread_id,
         requested_by_json = excluded.requested_by_json,
         status = excluded.status,
         user_prompt = excluded.user_prompt,
         latest_plan_id = excluded.latest_plan_id,
         latest_execution_run_id = excluded.latest_execution_run_id,
         updated_at = excluded.updated_at`,
      {
        ...request,
        requestedByJson: serializeJson(request.requestedBy)
      }
    );
  }
}

class SqliteApprovalRepository implements ApprovalRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getById(id: ApprovalRequest["id"]): Promise<ApprovalRequest | null> {
    const row = this.connection
      .prepare<
        { id: string },
        {
          id: ApprovalRequest["id"];
          request_id: ApprovalRequest["requestId"];
          plan_id: ApprovalRequest["planId"];
          site_id: ApprovalRequest["siteId"];
          status: ApprovalRequest["status"];
          requested_by_json: string;
          expires_at: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, request_id, plan_id, site_id, status, requested_by_json,
                expires_at, created_at, updated_at
         FROM approval_requests
         WHERE id = @id`
      )
      .get({ id });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      requestId: row.request_id,
      planId: row.plan_id,
      siteId: row.site_id,
      status: row.status,
      requestedBy: parseJson(row.requested_by_json),
      expiresAt: row.expires_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async listPendingBySiteId(
    siteId: ApprovalRequest["siteId"]
  ): Promise<ApprovalRequest[]> {
    const rows = this.connection
      .prepare<
        { siteId: string },
        {
          id: ApprovalRequest["id"];
          request_id: ApprovalRequest["requestId"];
          plan_id: ApprovalRequest["planId"];
          site_id: ApprovalRequest["siteId"];
          status: ApprovalRequest["status"];
          requested_by_json: string;
          expires_at: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, request_id, plan_id, site_id, status, requested_by_json,
                expires_at, created_at, updated_at
         FROM approval_requests
         WHERE site_id = @siteId AND status = 'pending'
         ORDER BY created_at ASC`
      )
      .all({ siteId });

    return rows.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      planId: row.plan_id,
      siteId: row.site_id,
      status: row.status,
      requestedBy: parseJson(row.requested_by_json),
      expiresAt: row.expires_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public async save(approvalRequest: ApprovalRequest): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO approval_requests (
         id, request_id, plan_id, site_id, status, requested_by_json, expires_at,
         created_at, updated_at
       ) VALUES (
         @id, @requestId, @planId, @siteId, @status, @requestedByJson, @expiresAt,
         @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         request_id = excluded.request_id,
         plan_id = excluded.plan_id,
         site_id = excluded.site_id,
         status = excluded.status,
         requested_by_json = excluded.requested_by_json,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      {
        ...approvalRequest,
        requestedByJson: serializeJson(approvalRequest.requestedBy)
      }
    );
  }
}

class SqliteAuditEntryRepository implements AuditEntryRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async listByRequestId(
    requestId: AuditEntry["requestId"]
  ): Promise<AuditEntry[]> {
    if (!requestId) {
      return [];
    }

    const rows = this.connection
      .prepare<
        { requestId: string },
        {
          id: AuditEntry["id"];
          site_id: AuditEntry["siteId"];
          request_id: AuditEntry["requestId"] | null;
          action_id: AuditEntry["actionId"] | null;
          event_type: AuditEntry["eventType"];
          actor_json: string;
          metadata_json: string;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, request_id, action_id, event_type, actor_json, metadata_json,
                created_at, updated_at
         FROM audit_entries
         WHERE request_id = @requestId
         ORDER BY created_at ASC`
      )
      .all({ requestId });

    return rows.map((row) => this.mapAuditEntry(row));
  }

  public async listBySiteId(siteId: AuditEntry["siteId"]): Promise<AuditEntry[]> {
    const rows = this.connection
      .prepare<
        { siteId: string },
        {
          id: AuditEntry["id"];
          site_id: AuditEntry["siteId"];
          request_id: AuditEntry["requestId"] | null;
          action_id: AuditEntry["actionId"] | null;
          event_type: AuditEntry["eventType"];
          actor_json: string;
          metadata_json: string;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, request_id, action_id, event_type, actor_json, metadata_json,
                created_at, updated_at
         FROM audit_entries
         WHERE site_id = @siteId
         ORDER BY created_at ASC`
      )
      .all({ siteId });

    return rows.map((row) => this.mapAuditEntry(row));
  }

  public async append(entry: AuditEntry): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO audit_entries (
         id, site_id, request_id, action_id, event_type, actor_json, metadata_json,
         created_at, updated_at
       ) VALUES (
         @id, @siteId, @requestId, @actionId, @eventType, @actorJson, @metadataJson,
         @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         site_id = excluded.site_id,
         request_id = excluded.request_id,
         action_id = excluded.action_id,
         event_type = excluded.event_type,
         actor_json = excluded.actor_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      {
        ...entry,
        actorJson: serializeJson(entry.actor),
        metadataJson: serializeJson(entry.metadata)
      }
    );
  }

  private mapAuditEntry(row: {
    id: AuditEntry["id"];
    site_id: AuditEntry["siteId"];
    request_id: AuditEntry["requestId"] | null;
    action_id: AuditEntry["actionId"] | null;
    event_type: AuditEntry["eventType"];
    actor_json: string;
    metadata_json: string;
    created_at: string;
    updated_at: string;
  }): AuditEntry {
    return {
      id: row.id,
      siteId: row.site_id,
      requestId: row.request_id ?? undefined,
      actionId: row.action_id ?? undefined,
      eventType: row.event_type,
      actor: parseJson<ActorRef | { kind: "system" | "assistant" }>(row.actor_json),
      metadata: parseJson(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

export function createSqliteRepositoryRegistry(
  connection: Database.Database
): RepositoryRegistry {
  return {
    workspaces: new SqliteWorkspaceRepository(connection),
    sites: new SqliteSiteRepository(connection),
    siteConfigs: new SqliteSiteConfigRepository(connection),
    discoverySnapshots: new SqliteDiscoverySnapshotRepository(connection),
    chatThreads: new SqliteChatThreadRepository(connection),
    requests: new SqliteRequestRepository(connection),
    approvals: new SqliteApprovalRepository(connection),
    auditEntries: new SqliteAuditEntryRepository(connection)
  };
}


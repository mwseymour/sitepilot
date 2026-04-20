import type Database from "better-sqlite3";

import {
  actionPlanSchema,
  type Action as ContractAction,
  type ActionPlan as ContractActionPlan
} from "@sitepilot/contracts";
import type {
  ActorRef,
  ApprovalDecision,
  ApprovalRequest,
  AuditEntry,
  ChatMessage,
  ChatThread,
  ClarificationRound,
  DiscoverySnapshot,
  ExecutionRun,
  ProviderUsageEvent,
  Request,
  Site,
  SiteConfigVersion,
  SiteConnection,
  ToolInvocation,
  Workspace
} from "@sitepilot/domain";

import type {
  ActionPlanRepository,
  ApprovalRepository,
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
        [],
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
      {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        description: workspace.description ?? null,
        ownerUserProfileId: workspace.ownerUserProfileId,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt
      }
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
          latest_discovery_snapshot_id:
            | Site["latestDiscoverySnapshotId"]
            | null;
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

  public async listByWorkspaceId(
    workspaceId: Site["workspaceId"]
  ): Promise<Site[]> {
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
          latest_discovery_snapshot_id:
            | Site["latestDiscoverySnapshotId"]
            | null;
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
      {
        id: site.id,
        workspaceId: site.workspaceId,
        name: site.name,
        baseUrl: site.baseUrl,
        environment: site.environment,
        activationStatus: site.activationStatus,
        activeConfigId: site.activeConfigId ?? null,
        latestDiscoverySnapshotId: site.latestDiscoverySnapshotId ?? null,
        createdAt: site.createdAt,
        updatedAt: site.updatedAt
      }
    );
  }
}

class SqliteSiteConnectionRepository implements SiteConnectionRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getBySiteId(siteId: Site["id"]): Promise<SiteConnection | null> {
    const row = this.connection
      .prepare<
        { siteId: string },
        {
          id: SiteConnection["id"];
          site_id: SiteConnection["siteId"];
          status: SiteConnection["status"];
          protocol_version: string;
          plugin_version: string;
          client_identifier: string;
          trusted_app_origin: string;
          credential_fingerprint: string | null;
          rotated_at: string | null;
          revoked_at: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, site_id, status, protocol_version, plugin_version, client_identifier,
                trusted_app_origin, credential_fingerprint, rotated_at, revoked_at,
                created_at, updated_at
         FROM site_connections
         WHERE site_id = @siteId`
      )
      .get({ siteId });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      siteId: row.site_id,
      status: row.status,
      protocolVersion: row.protocol_version,
      pluginVersion: row.plugin_version,
      clientIdentifier: row.client_identifier,
      trustedAppOrigin: row.trusted_app_origin,
      credentialFingerprint: row.credential_fingerprint ?? undefined,
      rotatedAt: row.rotated_at ?? undefined,
      revokedAt: row.revoked_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async save(connection: SiteConnection): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO site_connections (
         id, site_id, status, protocol_version, plugin_version, client_identifier,
         trusted_app_origin, credential_fingerprint, rotated_at, revoked_at, created_at, updated_at
       ) VALUES (
         @id, @siteId, @status, @protocolVersion, @pluginVersion, @clientIdentifier,
         @trustedAppOrigin, @credentialFingerprint, @rotatedAt, @revokedAt, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         site_id = excluded.site_id,
         status = excluded.status,
         protocol_version = excluded.protocol_version,
         plugin_version = excluded.plugin_version,
         client_identifier = excluded.client_identifier,
         trusted_app_origin = excluded.trusted_app_origin,
         credential_fingerprint = excluded.credential_fingerprint,
         rotated_at = excluded.rotated_at,
         revoked_at = excluded.revoked_at,
         updated_at = excluded.updated_at`,
      {
        id: connection.id,
        siteId: connection.siteId,
        status: connection.status,
        protocolVersion: connection.protocolVersion,
        pluginVersion: connection.pluginVersion,
        clientIdentifier: connection.clientIdentifier,
        trustedAppOrigin: connection.trustedAppOrigin,
        credentialFingerprint: connection.credentialFingerprint ?? null,
        rotatedAt: connection.rotatedAt ?? null,
        revokedAt: connection.revokedAt ?? null,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt
      }
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
        requiredSectionsComplete: asBooleanInteger(
          config.requiredSectionsComplete
        ),
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

  public async listBySiteId(
    siteId: ChatThread["siteId"]
  ): Promise<ChatThread[]> {
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
         ORDER BY updated_at DESC`
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
      {
        id: thread.id,
        siteId: thread.siteId,
        title: thread.title,
        type: thread.type,
        archivedAt: thread.archivedAt ?? null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt
      }
    );
  }
}

class SqliteChatMessageRepository implements ChatMessageRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getById(id: ChatMessage["id"]): Promise<ChatMessage | null> {
    const row = this.connection
      .prepare<
        { id: string },
        {
          id: ChatMessage["id"];
          thread_id: ChatMessage["threadId"];
          site_id: ChatMessage["siteId"];
          author_json: string;
          body_json: string;
          request_id: ChatMessage["requestId"] | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, thread_id, site_id, author_json, body_json, request_id,
                created_at, updated_at
         FROM chat_messages
         WHERE id = @id`
      )
      .get({ id });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      threadId: row.thread_id,
      siteId: row.site_id,
      author: parseJson(row.author_json),
      body: parseJson(row.body_json),
      ...(row.request_id !== null ? { requestId: row.request_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async listByThreadId(
    threadId: ChatMessage["threadId"]
  ): Promise<ChatMessage[]> {
    const rows = this.connection
      .prepare<
        { threadId: string },
        {
          id: ChatMessage["id"];
          thread_id: ChatMessage["threadId"];
          site_id: ChatMessage["siteId"];
          author_json: string;
          body_json: string;
          request_id: ChatMessage["requestId"] | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, thread_id, site_id, author_json, body_json, request_id,
                created_at, updated_at
         FROM chat_messages
         WHERE thread_id = @threadId
         ORDER BY created_at ASC`
      )
      .all({ threadId });

    return rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      siteId: row.site_id,
      author: parseJson(row.author_json),
      body: parseJson(row.body_json),
      ...(row.request_id !== null ? { requestId: row.request_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public async save(message: ChatMessage): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO chat_messages (
         id, thread_id, site_id, author_json, body_json, request_id,
         created_at, updated_at
       ) VALUES (
         @id, @threadId, @siteId, @authorJson, @bodyJson, @requestId,
         @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         thread_id = excluded.thread_id,
         site_id = excluded.site_id,
         author_json = excluded.author_json,
         body_json = excluded.body_json,
         request_id = excluded.request_id,
         updated_at = excluded.updated_at`,
      {
        id: message.id,
        threadId: message.threadId,
        siteId: message.siteId,
        authorJson: serializeJson(message.author),
        bodyJson: serializeJson(message.body),
        requestId: message.requestId ?? null,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt
      }
    );
  }
}

class SqliteClarificationRoundRepository implements ClarificationRoundRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getById(
    id: ClarificationRound["id"]
  ): Promise<ClarificationRound | null> {
    const row = this.connection
      .prepare<
        { id: string },
        {
          id: ClarificationRound["id"];
          request_id: ClarificationRound["requestId"];
          site_id: ClarificationRound["siteId"];
          questions_json: string;
          answers_json: string;
          resolved_at: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, request_id, site_id, questions_json, answers_json, resolved_at,
                created_at, updated_at
         FROM clarification_rounds
         WHERE id = @id`
      )
      .get({ id });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      requestId: row.request_id,
      siteId: row.site_id,
      questions: parseJson<string[]>(row.questions_json),
      answers: parseJson<string[]>(row.answers_json),
      ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async listByRequestId(
    requestId: ClarificationRound["requestId"]
  ): Promise<ClarificationRound[]> {
    const rows = this.connection
      .prepare<
        { requestId: string },
        {
          id: ClarificationRound["id"];
          request_id: ClarificationRound["requestId"];
          site_id: ClarificationRound["siteId"];
          questions_json: string;
          answers_json: string;
          resolved_at: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, request_id, site_id, questions_json, answers_json, resolved_at,
                created_at, updated_at
         FROM clarification_rounds
         WHERE request_id = @requestId
         ORDER BY created_at ASC`
      )
      .all({ requestId });

    return rows.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      siteId: row.site_id,
      questions: parseJson<string[]>(row.questions_json),
      answers: parseJson<string[]>(row.answers_json),
      ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public async save(round: ClarificationRound): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO clarification_rounds (
         id, request_id, site_id, questions_json, answers_json, resolved_at,
         created_at, updated_at
       ) VALUES (
         @id, @requestId, @siteId, @questionsJson, @answersJson, @resolvedAt,
         @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         request_id = excluded.request_id,
         site_id = excluded.site_id,
         questions_json = excluded.questions_json,
         answers_json = excluded.answers_json,
         resolved_at = excluded.resolved_at,
         updated_at = excluded.updated_at`,
      {
        id: round.id,
        requestId: round.requestId,
        siteId: round.siteId,
        questionsJson: serializeJson(round.questions),
        answersJson: serializeJson(round.answers),
        resolvedAt: round.resolvedAt ?? null,
        createdAt: round.createdAt,
        updatedAt: round.updatedAt
      }
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

  public async listByThreadId(
    threadId: Request["threadId"]
  ): Promise<Request[]> {
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

  public async listBySiteId(siteId: Request["siteId"]): Promise<Request[]> {
    const rows = this.connection
      .prepare<
        { siteId: string },
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
         WHERE site_id = @siteId
         ORDER BY created_at DESC
         LIMIT 200`
      )
      .all({ siteId });

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
        id: request.id,
        siteId: request.siteId,
        threadId: request.threadId,
        requestedByJson: serializeJson(request.requestedBy),
        status: request.status,
        userPrompt: request.userPrompt,
        latestPlanId: request.latestPlanId ?? null,
        latestExecutionRunId: request.latestExecutionRunId ?? null,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt
      }
    );
  }
}

class SqliteActionPlanRepository implements ActionPlanRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async saveFromContract(plan: ContractActionPlan): Promise<void> {
    const run = this.connection.transaction(() => {
      upsert(
        this.connection,
        `INSERT INTO action_plans (
           id, request_id, site_id, summary, assumptions_json, open_questions_json,
           approval_required, risk_level, target_entity_refs_json,
           dependencies_json, validation_warnings_json, rollback_notes_json,
           created_at, updated_at
         ) VALUES (
           @id, @requestId, @siteId, @summary, @assumptionsJson, @openQuestionsJson,
           @approvalRequired, @riskLevel, @targetEntityRefsJson,
           @dependenciesJson, @validationWarningsJson, @rollbackNotesJson,
           @createdAt, @updatedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           request_id = excluded.request_id,
           site_id = excluded.site_id,
           summary = excluded.summary,
           assumptions_json = excluded.assumptions_json,
           open_questions_json = excluded.open_questions_json,
           approval_required = excluded.approval_required,
           risk_level = excluded.risk_level,
           target_entity_refs_json = excluded.target_entity_refs_json,
           dependencies_json = excluded.dependencies_json,
           validation_warnings_json = excluded.validation_warnings_json,
           rollback_notes_json = excluded.rollback_notes_json,
           updated_at = excluded.updated_at`,
        {
          id: plan.id,
          requestId: plan.requestId,
          siteId: plan.siteId,
          summary: plan.requestSummary,
          assumptionsJson: serializeJson(plan.assumptions),
          openQuestionsJson: serializeJson(plan.openQuestions),
          approvalRequired: asBooleanInteger(plan.approvalRequired),
          riskLevel: plan.riskLevel,
          targetEntityRefsJson: serializeJson(plan.targetEntities),
          dependenciesJson: serializeJson(plan.dependencies),
          validationWarningsJson: serializeJson(plan.validationWarnings),
          rollbackNotesJson: serializeJson(plan.rollbackNotes),
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt
        }
      );

      for (const action of plan.proposedActions) {
        const inputPayload = {
          ...action.input,
          _sitepilotMeta: {
            version: action.version,
            targetEntityRefs: action.targetEntityRefs,
            permissionRequirement: action.permissionRequirement
          }
        };
        upsert(
          this.connection,
          `INSERT INTO actions (
             id, plan_id, request_id, type, risk_level, dry_run_capable,
             rollback_supported, input_json, created_at, updated_at
           ) VALUES (
             @id, @planId, @requestId, @type, @riskLevel, @dryRunCapable,
             @rollbackSupported, @inputJson, @createdAt, @updatedAt
           )
           ON CONFLICT(id) DO UPDATE SET
             plan_id = excluded.plan_id,
             request_id = excluded.request_id,
             type = excluded.type,
             risk_level = excluded.risk_level,
             dry_run_capable = excluded.dry_run_capable,
             rollback_supported = excluded.rollback_supported,
             input_json = excluded.input_json,
             updated_at = excluded.updated_at`,
          {
            id: action.id,
            planId: plan.id,
            requestId: plan.requestId,
            type: action.type,
            riskLevel: action.riskLevel,
            dryRunCapable: asBooleanInteger(action.dryRunCapable),
            rollbackSupported: asBooleanInteger(action.rollbackSupported),
            inputJson: serializeJson(inputPayload),
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt
          }
        );
      }
    });

    run();
  }

  public async getById(
    planId: ContractActionPlan["id"]
  ): Promise<ContractActionPlan | null> {
    type PlanRow = {
      id: string;
      request_id: string;
      site_id: string;
      summary: string;
      assumptions_json: string;
      open_questions_json: string;
      approval_required: number;
      risk_level: string;
      target_entity_refs_json: string;
      dependencies_json: string;
      validation_warnings_json: string;
      rollback_notes_json: string;
      created_at: string;
      updated_at: string;
    };

    const row = this.connection
      .prepare<{ id: string }, PlanRow>(
        `SELECT id, request_id, site_id, summary, assumptions_json, open_questions_json,
                approval_required, risk_level, target_entity_refs_json,
                dependencies_json, validation_warnings_json, rollback_notes_json,
                created_at, updated_at
         FROM action_plans WHERE id = @id`
      )
      .get({ id: planId });

    if (!row) {
      return null;
    }

    type ActionRow = {
      id: string;
      plan_id: string;
      request_id: string;
      type: string;
      risk_level: string;
      dry_run_capable: number;
      rollback_supported: number;
      input_json: string;
      created_at: string;
      updated_at: string;
    };

    const actionRows = this.connection
      .prepare<{ planId: string }, ActionRow>(
        `SELECT id, plan_id, request_id, type, risk_level, dry_run_capable, rollback_supported,
                input_json, created_at, updated_at
         FROM actions WHERE plan_id = @planId
         ORDER BY created_at ASC`
      )
      .all({ planId });

    const proposedActions: ContractActionPlan["proposedActions"] =
      actionRows.map((ar) => {
        const raw = parseJson<Record<string, unknown>>(ar.input_json);
        const metaRaw = raw._sitepilotMeta;
        const input = { ...raw };
        delete input._sitepilotMeta;
        const meta =
          metaRaw !== null &&
          typeof metaRaw === "object" &&
          !Array.isArray(metaRaw)
            ? (metaRaw as Record<string, unknown>)
            : {};
        const version =
          typeof meta.version === "number" && Number.isFinite(meta.version)
            ? meta.version
            : 1;
        const targetEntityRefs = Array.isArray(meta.targetEntityRefs)
          ? (meta.targetEntityRefs as string[])
          : [];
        const permissionRequirement =
          typeof meta.permissionRequirement === "string"
            ? meta.permissionRequirement
            : "read_site";
        return {
          id: ar.id,
          type: ar.type,
          version,
          input: input as ContractAction["input"],
          targetEntityRefs,
          permissionRequirement,
          riskLevel: ar.risk_level as ContractAction["riskLevel"],
          dryRunCapable: asBoolean(ar.dry_run_capable),
          rollbackSupported: asBoolean(ar.rollback_supported)
        };
      });

    const draft = {
      id: row.id,
      requestId: row.request_id,
      siteId: row.site_id,
      requestSummary: row.summary,
      assumptions: parseJson(row.assumptions_json) as string[],
      openQuestions: parseJson(row.open_questions_json) as string[],
      targetEntities: parseJson(row.target_entity_refs_json) as string[],
      proposedActions,
      dependencies: parseJson(row.dependencies_json) as string[],
      approvalRequired: asBoolean(row.approval_required),
      riskLevel: row.risk_level,
      rollbackNotes: parseJson(row.rollback_notes_json) as string[],
      validationWarnings: parseJson(row.validation_warnings_json) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };

    return actionPlanSchema.parse(draft);
  }
}

class SqliteProviderUsageRepository implements ProviderUsageRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async append(event: ProviderUsageEvent): Promise<void> {
    this.connection
      .prepare(
        `INSERT INTO provider_usage_events (
           id, workspace_id, site_id, request_id, provider, model,
           input_tokens, output_tokens, estimated_cost_usd, created_at
         ) VALUES (
           @id, @workspaceId, @siteId, @requestId, @provider, @model,
           @inputTokens, @outputTokens, @estimatedCostUsd, @createdAt
         )`
      )
      .run({
        id: event.id,
        workspaceId: event.workspaceId ?? null,
        siteId: event.siteId ?? null,
        requestId: event.requestId ?? null,
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        estimatedCostUsd: event.estimatedCostUsd,
        createdAt: event.createdAt
      });
  }
}

class SqliteApprovalRepository implements ApprovalRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getById(
    id: ApprovalRequest["id"]
  ): Promise<ApprovalRequest | null> {
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

  public async listByRequestId(
    requestId: ApprovalRequest["requestId"]
  ): Promise<ApprovalRequest[]> {
    const rows = this.connection
      .prepare<
        { requestId: string },
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
         WHERE request_id = @requestId
         ORDER BY created_at DESC`
      )
      .all({ requestId });

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

  public async listPendingBySiteId(
    siteId: ApprovalRequest["siteId"]
  ): Promise<ApprovalRequest[]> {
    const now = new Date().toISOString();
    this.connection
      .prepare(
        `UPDATE approval_requests
         SET status = 'expired', updated_at = @now
         WHERE site_id = @siteId
           AND status = 'pending'
           AND expires_at IS NOT NULL
           AND expires_at < @now`
      )
      .run({ siteId, now });

    const rows = this.connection
      .prepare<
        { siteId: string; now: string },
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
         WHERE site_id = @siteId
           AND status = 'pending'
           AND (expires_at IS NULL OR expires_at >= @now)
         ORDER BY created_at ASC`
      )
      .all({ siteId, now });

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
        id: approvalRequest.id,
        requestId: approvalRequest.requestId,
        planId: approvalRequest.planId,
        siteId: approvalRequest.siteId,
        status: approvalRequest.status,
        requestedByJson: serializeJson(approvalRequest.requestedBy),
        expiresAt: approvalRequest.expiresAt ?? null,
        createdAt: approvalRequest.createdAt,
        updatedAt: approvalRequest.updatedAt
      }
    );
  }

  public async appendDecision(decision: ApprovalDecision): Promise<void> {
    this.connection
      .prepare(
        `INSERT INTO approval_decisions (
           id, approval_request_id, decided_by_json, decision, note,
           created_at, updated_at
         ) VALUES (
           @id, @approvalRequestId, @decidedByJson, @decision, @note,
           @createdAt, @updatedAt
         )`
      )
      .run({
        id: decision.id,
        approvalRequestId: decision.approvalRequestId,
        decidedByJson: serializeJson(decision.decidedBy),
        decision: decision.decision,
        note: decision.note ?? null,
        createdAt: decision.createdAt,
        updatedAt: decision.updatedAt
      });
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

  public async listBySiteId(
    siteId: AuditEntry["siteId"]
  ): Promise<AuditEntry[]> {
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
         ORDER BY created_at DESC`
      )
      .all({ siteId });

    return rows.map((row) => this.mapAuditEntry(row));
  }

  public async append(entry: AuditEntry): Promise<void> {
    this.connection
      .prepare(
        `INSERT INTO audit_entries (
           id, site_id, request_id, action_id, event_type, actor_json, metadata_json,
           created_at, updated_at
         ) VALUES (
           @id, @siteId, @requestId, @actionId, @eventType, @actorJson, @metadataJson,
           @createdAt, @updatedAt
         )`
      )
      .run({
        id: entry.id,
        siteId: entry.siteId,
        requestId: entry.requestId ?? null,
        actionId: entry.actionId ?? null,
        eventType: entry.eventType,
        actorJson: serializeJson(entry.actor),
        metadataJson: serializeJson(entry.metadata),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      });
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
    const base = {
      id: row.id,
      siteId: row.site_id,
      eventType: row.event_type,
      actor: parseJson<ActorRef | { kind: "system" | "assistant" }>(
        row.actor_json
      ),
      metadata: parseJson(row.metadata_json) as AuditEntry["metadata"],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    return {
      ...base,
      ...(row.request_id !== null ? { requestId: row.request_id } : {}),
      ...(row.action_id !== null ? { actionId: row.action_id } : {})
    };
  }
}

class SqliteExecutionRunRepository implements ExecutionRunRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async getById(id: ExecutionRun["id"]): Promise<ExecutionRun | null> {
    const row = this.connection
      .prepare<
        { id: string },
        {
          id: ExecutionRun["id"];
          request_id: ExecutionRun["requestId"];
          plan_id: ExecutionRun["planId"];
          site_id: ExecutionRun["siteId"];
          status: ExecutionRun["status"];
          idempotency_key: string;
          started_at: string | null;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, request_id, plan_id, site_id, status, idempotency_key,
                started_at, completed_at, created_at, updated_at
         FROM execution_runs WHERE id = @id`
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
      idempotencyKey: row.idempotency_key,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async getByIdempotencyKey(key: string): Promise<ExecutionRun | null> {
    const row = this.connection
      .prepare<
        { key: string },
        {
          id: ExecutionRun["id"];
          request_id: ExecutionRun["requestId"];
          plan_id: ExecutionRun["planId"];
          site_id: ExecutionRun["siteId"];
          status: ExecutionRun["status"];
          idempotency_key: string;
          started_at: string | null;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, request_id, plan_id, site_id, status, idempotency_key,
                started_at, completed_at, created_at, updated_at
         FROM execution_runs WHERE idempotency_key = @key`
      )
      .get({ key });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      requestId: row.request_id,
      planId: row.plan_id,
      siteId: row.site_id,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public async save(run: ExecutionRun): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO execution_runs (
         id, request_id, plan_id, site_id, status, idempotency_key,
         started_at, completed_at, created_at, updated_at
       ) VALUES (
         @id, @requestId, @planId, @siteId, @status, @idempotencyKey,
         @startedAt, @completedAt, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         request_id = excluded.request_id,
         plan_id = excluded.plan_id,
         site_id = excluded.site_id,
         status = excluded.status,
         idempotency_key = excluded.idempotency_key,
         started_at = excluded.started_at,
         completed_at = excluded.completed_at,
         updated_at = excluded.updated_at`,
      {
        id: run.id,
        requestId: run.requestId,
        planId: run.planId,
        siteId: run.siteId,
        status: run.status,
        idempotencyKey: run.idempotencyKey,
        startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
      }
    );
  }
}

class SqliteToolInvocationRepository implements ToolInvocationRepository {
  public constructor(private readonly connection: Database.Database) {}

  public async save(invocation: ToolInvocation): Promise<void> {
    upsert(
      this.connection,
      `INSERT INTO tool_invocations (
         id, execution_run_id, action_id, tool_name, status, input_json, output_json, error_code,
         created_at, updated_at
       ) VALUES (
         @id, @executionRunId, @actionId, @toolName, @status, @inputJson, @outputJson, @errorCode,
         @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         execution_run_id = excluded.execution_run_id,
         action_id = excluded.action_id,
         tool_name = excluded.tool_name,
         status = excluded.status,
         input_json = excluded.input_json,
         output_json = excluded.output_json,
         error_code = excluded.error_code,
         updated_at = excluded.updated_at`,
      {
        id: invocation.id,
        executionRunId: invocation.executionRunId,
        actionId: invocation.actionId ?? null,
        toolName: invocation.toolName,
        status: invocation.status,
        inputJson: serializeJson(invocation.input),
        outputJson:
          invocation.output !== undefined
            ? serializeJson(invocation.output)
            : null,
        errorCode: invocation.errorCode ?? null,
        createdAt: invocation.createdAt,
        updatedAt: invocation.updatedAt
      }
    );
  }

  public async listByExecutionRunId(
    runId: ToolInvocation["executionRunId"]
  ): Promise<ToolInvocation[]> {
    const rows = this.connection
      .prepare<
        { runId: string },
        {
          id: ToolInvocation["id"];
          execution_run_id: ToolInvocation["executionRunId"];
          action_id: ToolInvocation["actionId"] | null;
          tool_name: string;
          status: ToolInvocation["status"];
          input_json: string;
          output_json: string | null;
          error_code: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT id, execution_run_id, action_id, tool_name, status, input_json, output_json,
                error_code, created_at, updated_at
         FROM tool_invocations
         WHERE execution_run_id = @runId
         ORDER BY created_at ASC`
      )
      .all({ runId });

    return rows.map((row) => {
      const base = {
        id: row.id,
        executionRunId: row.execution_run_id,
        toolName: row.tool_name,
        status: row.status,
        input: parseJson(row.input_json) as ToolInvocation["input"],
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
      return {
        ...base,
        ...(row.action_id !== null ? { actionId: row.action_id } : {}),
        ...(row.output_json !== null
          ? { output: parseJson(row.output_json) as ToolInvocation["output"] }
          : {}),
        ...(row.error_code !== null ? { errorCode: row.error_code } : {})
      };
    });
  }
}

export function createSqliteRepositoryRegistry(
  connection: Database.Database
): RepositoryRegistry {
  return {
    workspaces: new SqliteWorkspaceRepository(connection),
    sites: new SqliteSiteRepository(connection),
    siteConnections: new SqliteSiteConnectionRepository(connection),
    siteConfigs: new SqliteSiteConfigRepository(connection),
    discoverySnapshots: new SqliteDiscoverySnapshotRepository(connection),
    chatThreads: new SqliteChatThreadRepository(connection),
    chatMessages: new SqliteChatMessageRepository(connection),
    requests: new SqliteRequestRepository(connection),
    clarificationRounds: new SqliteClarificationRoundRepository(connection),
    actionPlans: new SqliteActionPlanRepository(connection),
    providerUsage: new SqliteProviderUsageRepository(connection),
    approvals: new SqliteApprovalRepository(connection),
    auditEntries: new SqliteAuditEntryRepository(connection),
    executionRuns: new SqliteExecutionRunRepository(connection),
    toolInvocations: new SqliteToolInvocationRepository(connection)
  };
}

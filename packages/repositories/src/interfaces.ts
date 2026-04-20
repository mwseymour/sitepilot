import type {
  ApprovalRequest,
  AuditEntry,
  ChatMessage,
  ChatThread,
  ClarificationRound,
  DiscoverySnapshot,
  Request,
  Site,
  SiteConfigVersion,
  SiteConnection,
  Workspace
} from "@sitepilot/domain";

export interface WorkspaceRepository {
  getById(id: Workspace["id"]): Promise<Workspace | null>;
  list(): Promise<Workspace[]>;
  save(workspace: Workspace): Promise<void>;
}

export interface SiteRepository {
  getById(id: Site["id"]): Promise<Site | null>;
  listByWorkspaceId(workspaceId: Site["workspaceId"]): Promise<Site[]>;
  save(site: Site): Promise<void>;
}

export interface SiteConnectionRepository {
  getBySiteId(siteId: Site["id"]): Promise<SiteConnection | null>;
  save(connection: SiteConnection): Promise<void>;
}

export interface SiteConfigRepository {
  getActiveBySiteId(
    siteId: SiteConfigVersion["siteId"]
  ): Promise<SiteConfigVersion | null>;
  listVersions(
    siteId: SiteConfigVersion["siteId"]
  ): Promise<SiteConfigVersion[]>;
  save(config: SiteConfigVersion): Promise<void>;
}

export interface DiscoverySnapshotRepository {
  getLatest(
    siteId: DiscoverySnapshot["siteId"]
  ): Promise<DiscoverySnapshot | null>;
  listBySiteId(
    siteId: DiscoverySnapshot["siteId"]
  ): Promise<DiscoverySnapshot[]>;
  save(snapshot: DiscoverySnapshot): Promise<void>;
}

export interface ChatThreadRepository {
  getById(id: ChatThread["id"]): Promise<ChatThread | null>;
  listBySiteId(siteId: ChatThread["siteId"]): Promise<ChatThread[]>;
  save(thread: ChatThread): Promise<void>;
}

export interface RequestRepository {
  getById(id: Request["id"]): Promise<Request | null>;
  listByThreadId(threadId: Request["threadId"]): Promise<Request[]>;
  listBySiteId(siteId: Request["siteId"]): Promise<Request[]>;
  save(request: Request): Promise<void>;
}

export interface ChatMessageRepository {
  getById(id: ChatMessage["id"]): Promise<ChatMessage | null>;
  listByThreadId(threadId: ChatMessage["threadId"]): Promise<ChatMessage[]>;
  save(message: ChatMessage): Promise<void>;
}

export interface ClarificationRoundRepository {
  getById(id: ClarificationRound["id"]): Promise<ClarificationRound | null>;
  listByRequestId(
    requestId: ClarificationRound["requestId"]
  ): Promise<ClarificationRound[]>;
  save(round: ClarificationRound): Promise<void>;
}

export interface ApprovalRepository {
  getById(id: ApprovalRequest["id"]): Promise<ApprovalRequest | null>;
  listPendingBySiteId(
    siteId: ApprovalRequest["siteId"]
  ): Promise<ApprovalRequest[]>;
  save(approvalRequest: ApprovalRequest): Promise<void>;
}

export interface AuditEntryRepository {
  listByRequestId(requestId: AuditEntry["requestId"]): Promise<AuditEntry[]>;
  listBySiteId(siteId: AuditEntry["siteId"]): Promise<AuditEntry[]>;
  append(entry: AuditEntry): Promise<void>;
}

export interface RepositoryRegistry {
  workspaces: WorkspaceRepository;
  sites: SiteRepository;
  siteConnections: SiteConnectionRepository;
  siteConfigs: SiteConfigRepository;
  discoverySnapshots: DiscoverySnapshotRepository;
  chatThreads: ChatThreadRepository;
  chatMessages: ChatMessageRepository;
  requests: RequestRepository;
  clarificationRounds: ClarificationRoundRepository;
  approvals: ApprovalRepository;
  auditEntries: AuditEntryRepository;
}

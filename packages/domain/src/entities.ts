import type {
  ActionRiskLevel,
  AppRole,
  ApprovalState,
  AuditEventType,
  ExecutionStatus,
  NotificationChannel,
  ProviderKind,
  RequestStatus,
  SiteActivationStatus,
  SiteConnectionStatus,
  SiteEnvironment,
  ThreadType,
  ToolInvocationStatus
} from "./enums.js";
import type {
  ActionId,
  ActionPlanId,
  ApprovalDecisionId,
  ApprovalRequestId,
  AttachmentId,
  AuditEntryId,
  ChatMessageId,
  ChatThreadId,
  ClarificationRoundId,
  DiscoverySnapshotId,
  ExecutionRunId,
  NotificationId,
  ProviderProfileId,
  ProviderUsageEventId,
  RequestId,
  RequestVisualAnalysisId,
  RollbackRecordId,
  SiteConfigId,
  SiteConnectionId,
  SiteId,
  ToolInvocationId,
  UserProfileId,
  WorkspaceId
} from "./ids.js";
import type {
  ActionReference,
  ActorRef,
  EntityTimestamps,
  IsoTimestamp,
  JsonObject,
  LocalizedTextBlock,
  ModelReference,
  ProviderUsage,
  RequestReference,
  SiteReference,
  UrlString
} from "./value-objects.js";

export interface Workspace extends EntityTimestamps {
  id: WorkspaceId;
  name: string;
  slug: string;
  description?: string;
  ownerUserProfileId: UserProfileId;
}

export interface WorkspaceSummary {
  id: WorkspaceId;
  name: string;
  slug: string;
}

export interface UserProfile extends EntityTimestamps {
  id: UserProfileId;
  workspaceId: WorkspaceId;
  displayName: string;
  email?: string;
  appRole: AppRole;
}

export interface Site extends EntityTimestamps {
  id: SiteId;
  workspaceId: WorkspaceId;
  name: string;
  baseUrl: UrlString;
  environment: SiteEnvironment;
  activationStatus: SiteActivationStatus;
  activeConfigId?: SiteConfigId;
  latestDiscoverySnapshotId?: DiscoverySnapshotId;
}

export interface SiteConnection extends EntityTimestamps {
  id: SiteConnectionId;
  siteId: SiteId;
  status: SiteConnectionStatus;
  protocolVersion: string;
  pluginVersion: string;
  clientIdentifier: string;
  trustedAppOrigin: UrlString;
  credentialFingerprint?: string;
  rotatedAt?: IsoTimestamp;
  revokedAt?: IsoTimestamp;
}

export interface SiteConfigVersion extends EntityTimestamps {
  id: SiteConfigId;
  siteId: SiteId;
  version: number;
  isActive: boolean;
  summary: string;
  requiredSectionsComplete: boolean;
  document: JsonObject;
}

export interface DiscoverySnapshot extends EntityTimestamps {
  id: DiscoverySnapshotId;
  siteId: SiteId;
  revision: number;
  warnings: string[];
  capabilities: string[];
  summary: JsonObject;
}

export interface ChatThread extends EntityTimestamps {
  id: ChatThreadId;
  siteId: SiteId;
  title: string;
  type: ThreadType;
  archivedAt?: IsoTimestamp;
}

export interface ImageAttachment {
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface ChatMessage extends EntityTimestamps {
  id: ChatMessageId;
  threadId: ChatThreadId;
  siteId: SiteId;
  author: ActorRef | { kind: "system" | "assistant" };
  body: LocalizedTextBlock;
  attachments?: ImageAttachment[];
  requestId?: RequestId;
}

export interface Request extends EntityTimestamps {
  id: RequestId;
  siteId: SiteId;
  threadId: ChatThreadId;
  requestedBy: ActorRef;
  status: RequestStatus;
  userPrompt: string;
  attachments?: ImageAttachment[];
  latestPlanId?: ActionPlanId;
  latestExecutionRunId?: ExecutionRunId;
}

export interface RequestVisualAnalysisRegion {
  id: string;
  label: string;
  kind: string;
  layout: string;
  position: string;
  contentSummary: string;
  suggestedBlocks: string[];
  emphasis: string;
  confidence: number;
}

export interface RequestVisualAnalysis extends EntityTimestamps {
  id: RequestVisualAnalysisId;
  requestId: RequestId;
  siteId: SiteId;
  provider: ProviderKind;
  model: string;
  sourceImageCount: number;
  analyzedRequestUpdatedAt: IsoTimestamp;
  summary: string;
  pageType: string;
  layoutPattern: string;
  styleNotes: string[];
  responsiveNotes: string[];
  regions: RequestVisualAnalysisRegion[];
  mappingWarnings: string[];
  reviewedAt?: IsoTimestamp;
}

export interface ClarificationRound extends EntityTimestamps {
  id: ClarificationRoundId;
  requestId: RequestId;
  siteId: SiteId;
  questions: string[];
  answers: string[];
  resolvedAt?: IsoTimestamp;
}

export interface ActionPlan extends EntityTimestamps {
  id: ActionPlanId;
  requestId: RequestId;
  siteId: SiteId;
  summary: string;
  assumptions: string[];
  openQuestions: string[];
  approvalRequired: boolean;
  riskLevel: ActionRiskLevel;
  targetEntityRefs: string[];
}

export interface Action extends EntityTimestamps {
  id: ActionId;
  planId: ActionPlanId;
  requestId: RequestId;
  type: string;
  riskLevel: ActionRiskLevel;
  dryRunCapable: boolean;
  rollbackSupported: boolean;
  input: JsonObject;
}

export interface ApprovalRequest extends EntityTimestamps {
  id: ApprovalRequestId;
  requestId: RequestId;
  planId: ActionPlanId;
  siteId: SiteId;
  status: ApprovalState;
  requestedBy: ActorRef;
  expiresAt?: IsoTimestamp;
}

export interface ApprovalDecision extends EntityTimestamps {
  id: ApprovalDecisionId;
  approvalRequestId: ApprovalRequestId;
  decidedBy: ActorRef;
  decision: ApprovalState;
  note?: string;
}

export interface ExecutionRun extends EntityTimestamps {
  id: ExecutionRunId;
  requestId: RequestId;
  planId: ActionPlanId;
  siteId: SiteId;
  status: ExecutionStatus;
  idempotencyKey: string;
  startedAt?: IsoTimestamp;
  completedAt?: IsoTimestamp;
}

export interface ToolInvocation extends EntityTimestamps {
  id: ToolInvocationId;
  executionRunId: ExecutionRunId;
  actionId?: ActionId;
  toolName: string;
  status: ToolInvocationStatus;
  input: JsonObject;
  output?: JsonObject;
  errorCode?: string;
}

export interface AuditEntry extends EntityTimestamps {
  id: AuditEntryId;
  siteId: SiteId;
  requestId?: RequestId;
  actionId?: ActionId;
  eventType: AuditEventType;
  actor: ActorRef | { kind: "system" | "assistant" };
  metadata: JsonObject;
}

export interface RollbackRecord extends EntityTimestamps {
  id: RollbackRecordId;
  requestId: RequestId;
  actionId: ActionId;
  siteId: SiteId;
  reversible: boolean;
  beforeState?: JsonObject;
  afterState?: JsonObject;
  compensatingActionNote?: string;
}

export interface ProviderProfile extends EntityTimestamps {
  id: ProviderProfileId;
  workspaceId: WorkspaceId;
  kind: ProviderKind;
  label: string;
  baseUrl?: UrlString;
  modelDefaults: string[];
}

/** Append-only provider telemetry row (T23). */
export interface ProviderUsageEvent {
  id: ProviderUsageEventId;
  workspaceId?: WorkspaceId;
  siteId?: SiteId;
  requestId?: RequestId;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  createdAt: IsoTimestamp;
}

export interface Notification extends EntityTimestamps {
  id: NotificationId;
  workspaceId: WorkspaceId;
  channel: NotificationChannel;
  title: string;
  body: string;
  readAt?: IsoTimestamp;
}

export interface Attachment extends EntityTimestamps {
  id: AttachmentId;
  siteId: SiteId;
  requestId?: RequestId;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
}

export interface RequestAuditContext {
  request: RequestReference;
  site: SiteReference;
  relatedAction?: ActionReference;
  model?: ModelReference;
  usage?: ProviderUsage;
}

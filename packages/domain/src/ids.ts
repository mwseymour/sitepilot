export const DOMAIN_PACKAGE_NAME = "@sitepilot/domain";

export type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type EntityId = Brand<string, "EntityId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type UserProfileId = Brand<string, "UserProfileId">;
export type SiteId = Brand<string, "SiteId">;
export type SiteConnectionId = Brand<string, "SiteConnectionId">;
export type SiteConfigId = Brand<string, "SiteConfigId">;
export type DiscoverySnapshotId = Brand<string, "DiscoverySnapshotId">;
export type ChatThreadId = Brand<string, "ChatThreadId">;
export type ChatMessageId = Brand<string, "ChatMessageId">;
export type RequestId = Brand<string, "RequestId">;
export type ClarificationRoundId = Brand<string, "ClarificationRoundId">;
export type ActionPlanId = Brand<string, "ActionPlanId">;
export type ActionId = Brand<string, "ActionId">;
export type ApprovalRequestId = Brand<string, "ApprovalRequestId">;
export type ApprovalDecisionId = Brand<string, "ApprovalDecisionId">;
export type ExecutionRunId = Brand<string, "ExecutionRunId">;
export type ToolInvocationId = Brand<string, "ToolInvocationId">;
export type AuditEntryId = Brand<string, "AuditEntryId">;
export type RollbackRecordId = Brand<string, "RollbackRecordId">;
export type ProviderProfileId = Brand<string, "ProviderProfileId">;
export type NotificationId = Brand<string, "NotificationId">;
export type AttachmentId = Brand<string, "AttachmentId">;


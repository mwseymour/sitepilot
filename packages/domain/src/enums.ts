export const siteEnvironments = [
  "production",
  "staging",
  "development"
] as const;
export type SiteEnvironment = (typeof siteEnvironments)[number];

export const siteConnectionStatuses = [
  "unregistered",
  "pending_verification",
  "verified",
  "revoked",
  "rotated",
  "disabled"
] as const;
export type SiteConnectionStatus = (typeof siteConnectionStatuses)[number];

export const siteActivationStatuses = [
  "inactive",
  "config_required",
  "active"
] as const;
export type SiteActivationStatus = (typeof siteActivationStatuses)[number];

export const threadTypes = [
  "general_request",
  "content_creation",
  "content_update",
  "media_request",
  "seo_request",
  "taxonomy_request",
  "publish_request",
  "maintenance_diagnostic",
  "approval_discussion"
] as const;
export type ThreadType = (typeof threadTypes)[number];

export const requestStatuses = [
  "new",
  "clarifying",
  "drafted",
  "awaiting_approval",
  "approved",
  "executing",
  "completed",
  "partially_completed",
  "failed",
  "reverted",
  "archived"
] as const;
export type RequestStatus = (typeof requestStatuses)[number];

export const actionRiskLevels = ["low", "medium", "high", "critical"] as const;
export type ActionRiskLevel = (typeof actionRiskLevels)[number];

export const approvalStates = [
  "pending",
  "approved",
  "rejected",
  "revision_requested",
  "deferred",
  "expired"
] as const;
export type ApprovalState = (typeof approvalStates)[number];

export const executionStatuses = [
  "pending",
  "running",
  "completed",
  "partially_completed",
  "failed",
  "rolled_back"
] as const;
export type ExecutionStatus = (typeof executionStatuses)[number];

export const toolInvocationStatuses = [
  "pending",
  "succeeded",
  "failed"
] as const;
export type ToolInvocationStatus = (typeof toolInvocationStatuses)[number];

export const auditEventTypes = [
  "request_created",
  "clarification_requested",
  "clarification_answered",
  "plan_generated",
  "plan_validated",
  "approval_requested",
  "approval_decided",
  "execution_started",
  "tool_invoked",
  "execution_completed",
  "execution_failed",
  "rollback_recorded",
  "config_updated",
  "site_registered",
  "discovery_refreshed"
] as const;
export type AuditEventType = (typeof auditEventTypes)[number];

export const providerKinds = ["openai", "anthropic", "compatible"] as const;
export type ProviderKind = (typeof providerKinds)[number];

export const notificationChannels = ["in_app", "os", "email", "slack"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

export const appRoles = [
  "owner",
  "admin",
  "manager",
  "approver",
  "requester",
  "read_only_auditor"
] as const;
export type AppRole = (typeof appRoles)[number];

export const siteRoles = [
  "request",
  "edit_drafts",
  "approve",
  "publish",
  "manage_config",
  "manage_connection",
  "audit_only"
] as const;
export type SiteRole = (typeof siteRoles)[number];

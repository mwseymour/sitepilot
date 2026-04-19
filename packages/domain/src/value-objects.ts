import type { AppRole, SiteEnvironment, SiteRole } from "./enums.js";
import type {
  ActionId,
  AuditEntryId,
  ChatThreadId,
  RequestId,
  SiteId,
  UserProfileId
} from "./ids.js";

export type IsoTimestamp = string;
export type UrlString = string;
export type JsonObject = Record<string, unknown>;

export interface ActorRef {
  userProfileId: UserProfileId;
  appRole: AppRole;
  siteRoles: SiteRole[];
}

export interface EntityTimestamps {
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface SiteReference {
  siteId: SiteId;
  environment: SiteEnvironment;
}

export interface ThreadReference {
  siteId: SiteId;
  threadId: ChatThreadId;
}

export interface RequestReference {
  siteId: SiteId;
  requestId: RequestId;
}

export interface ActionReference {
  requestId: RequestId;
  actionId: ActionId;
}

export interface AuditReference {
  auditEntryId: AuditEntryId;
  requestId?: RequestId;
  actionId?: ActionId;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ModelReference {
  provider: string;
  model: string;
  promptVersion: string;
}

export interface LocalizedTextBlock {
  format: "plain_text" | "markdown" | "html";
  value: string;
}


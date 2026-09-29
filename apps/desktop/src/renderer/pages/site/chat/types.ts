import type {
  ChatMessagePayload,
  ChatThreadPayload,
  SitePilotDesktopApi
} from "@sitepilot/contracts";

export type ThreadRow = ChatThreadPayload;
export type MessageRow = ChatMessagePayload;

export type RequestBundleOk = Extract<
  Awaited<ReturnType<SitePilotDesktopApi["getRequestBundle"]>>,
  { ok: true }
>;
export type ExecutePlanActionOk = Extract<
  Awaited<ReturnType<SitePilotDesktopApi["executePlanAction"]>>,
  { ok: true }
>;

export type DryRunPreview = {
  actionId: string;
  actionType: string;
  toolName?: string;
  requestInput?: Record<string, unknown>;
  mcpResult: ExecutePlanActionOk["mcpResult"];
};

export type ChatMode = "request" | "conversation";
export type RequestWorkflow = "legacy" | "gutenberg_v2";

export type GutenbergV2Operation =
  | "create_draft"
  | "replace_content"
  | "apply_operations"
  | "publish"
  | "unpublish";

export type ThreadTypeMeta = {
  label: string;
  description: string;
};

export type MessageFilter = "all" | "non_system" | "system_only";

export const SHOW_DRY_RUN_UI = true;

// The v1 planner remains in the codebase but is no longer offered in the UI.
export const SHOW_V1_WORKFLOW = false;

export const THREAD_TITLE_PREVIEW_THRESHOLD = 72;
export const REQUEST_PROMPT_PREVIEW_THRESHOLD = 280;
